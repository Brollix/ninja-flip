"""Análisis de reliquias: qué conviene abrir/farmear para platino.

Cruza tu inventario de reliquias (AlecaFrame) con:
 - tablas de drops oficiales (drops.warframestat.us)
 - precios, liquidez (ventas 48h) y ducados de warframe.market
 - estado vaulted + ubicaciones de farmeo (WFCD warframe-items)
 - tu historial de trades de AlecaFrame

Uso CLI local (un solo usuario, token de .env, cache en archivos):
    python relic_analysis.py            -> reporte (usa cache de 12 h)
    python relic_analysis.py --refresh  -> fuerza re-descarga de precios

En producción esto lo llama scripts/report_server.py (Cloud Run service
"report") por cada usuario, con SU token de AlecaFrame — ver build_report().
Los precios de items/reliquias son compartidos entre usuarios y viven en
Postgres (item_price_cache/relic_price_cache, Neon) en vez de cache/*.json.

El primer run tarda varios minutos (3 requests por item a ~3 req/s).
"""

import base64
import json
import os
import struct
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

from db import get_conn

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Solo para el modo CLI local (main() de abajo) — el server usa el token
# por-usuario que le manda server/src/routes/report.ts.
CLI_PUBLIC_TOKEN = os.getenv("ALECA_PUBLIC_TOKEN")

CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(exist_ok=True)
PRICE_CACHE_HOURS = 12
RATE = 0.35  # rate limit warframe.market

RELIC_TIERS = {0: "Lith", 1: "Meso", 2: "Neo", 3: "Axi", 4: "Requiem"}
# El backend usa 0-6; 1-3 y 4-6 son ambos Exceptional/Flawless/Radiant
REFINEMENTS = {0: "Intact", 1: "Exceptional", 2: "Flawless", 3: "Radiant",
               4: "Exceptional", 5: "Flawless", 6: "Radiant"}
PLAT_ITEM = "/AF_Special/Platinum"

session = requests.Session()
session.headers["User-Agent"] = "relic-analyzer/1.0"


# ---------- AlecaFrame ----------

def get_relic_inventory(public_token: str) -> list:
    """Devuelve [{tier, name, refinement, count}] desde AlecaFrame."""
    try:
        r = session.get(
            "https://stats.alecaframe.com/api/stats/public/getRelicInventory",
            params={"publicToken": public_token}, timeout=30)
        r.raise_for_status()
        raw = base64.b64decode(r.json())
        # El header declara la cantidad, pero a veces no coincide con el buffer:
        # parseamos registros de 9 bytes hasta agotarlo.
        relics, off = [], 4
        while off + 9 <= len(raw):
            tier, ref = struct.unpack_from("<BB", raw, off)
            name = raw[off + 2:off + 5].decode("ascii").strip()
            (count,) = struct.unpack_from("<I", raw, off + 5)
            relics.append({
                "tier": RELIC_TIERS.get(tier, f"?{tier}"),
                "name": name,
                "refinement": REFINEMENTS.get(ref, f"?{ref}"),
                "count": count,
            })
            off += 9
        return relics
    except requests.RequestException as e:
        # NO relanzar tal cual: el __str__ de un HTTPError de requests
        # incluye la URL completa pedida, con el publicToken en la query
        # string — eso se propagaba sin filtrar hasta el JSON de error que
        # ve el cliente en /api/report (report_server.py captura Exception
        # y hace str(e) directo).
        status = getattr(e.response, "status_code", "?")
        raise RuntimeError(f"AlecaFrame getRelicInventory falló (HTTP {status})") from e
    except (ValueError, UnicodeDecodeError, struct.error) as e:
        # payload corrupto/inesperado (base64 inválido, bytes no-ASCII en el
        # nombre, buffer mal alineado) — antes esto no tenía ningún fallback,
        # a diferencia de get_player_stats (manejado en build_report).
        raise RuntimeError(f"AlecaFrame getRelicInventory devolvió un payload inválido: {e}") from e


def get_player_stats(public_token: str) -> dict:
    try:
        r = session.get("https://stats.alecaframe.com/api/stats/public",
                        params={"token": public_token}, timeout=30)
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "?")
        raise RuntimeError(f"AlecaFrame stats falló (HTTP {status})") from e


# ---------- fuentes externas ----------

def cached_json_pg(cache_key: str, url: str, max_age_h: float):
    """Igual contrato que el viejo cached_json() (clave -> blob JSON, TTL en
    horas), pero cacheado en Postgres (external_data_cache) en vez de un
    archivo local — necesario porque los Cloud Run Jobs (warm_reports.py)
    son efímeros y no tienen disco persistente entre ejecuciones, a
    diferencia del service "report" (min_instance_count=1)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT payload FROM external_data_cache
            WHERE cache_key = %s AND updated_at > now() - (%s || ' hours')::interval
        """, (cache_key, max_age_h))
        row = cur.fetchone()
        if row:
            return row[0]

        r = session.get(url, timeout=300)
        r.raise_for_status()
        data = r.json()
        cur.execute("""
            INSERT INTO external_data_cache (cache_key, payload, updated_at)
            VALUES (%s, %s, now())
            ON CONFLICT (cache_key) DO UPDATE SET
              payload = EXCLUDED.payload, updated_at = now()
        """, (cache_key, json.dumps(data)))
        return data


def load_drop_tables() -> dict:
    """{(tier, name, refinement): [{itemName, chance}]}"""
    data = cached_json_pg("relic_drops",
                          "https://drops.warframestat.us/data/relics.json", 24 * 7)
    tables = {}
    for rel in data["relics"]:
        if not all(k in rel for k in ("tier", "relicName", "state", "rewards")):
            continue
        tables[(rel["tier"], rel["relicName"], rel["state"])] = rel["rewards"]
    return tables


def load_market_items():
    """(name_lower -> slug, gameRef -> name) de warframe.market."""
    data = cached_json_pg("market_items",
                          "https://api.warframe.market/v2/items", 24 * 7)
    by_name, by_ref = {}, {}
    for it in data["data"]:
        name = it["i18n"]["en"]["name"]
        by_name[name.lower()] = it["slug"]
        if it.get("gameRef"):
            by_ref[it["gameRef"]] = name
    return by_name, by_ref


def resolve_ref(raw_ref: str, by_ref: dict) -> str | None:
    """gameRef -> nombre de mercado, con fallback para las partes de Prime:
    AlecaFrame loguea las blueprints de parte como "...Component"
    (CalibanPrimeChassisComponent) pero el gameRef real de warframe.market
    termina en "...Blueprint" (CalibanPrimeChassisBlueprint) — mismo item,
    sufijo distinto. Sin este fallback, cualquier trade que incluyera una
    de estas partes no resolvía y se descartaba entero (¡las ventas de sets
    armados a partir de partes compradas sueltas desaparecían del todo!)."""
    name = by_ref.get(raw_ref)
    if name:
        return name
    if raw_ref.endswith("Component"):
        return by_ref.get(raw_ref[:-len("Component")] + "Blueprint")
    return None


def load_wfcd_relics() -> dict:
    """{'Meso D3': {vaulted, farm, farm_chance}} desde WFCD warframe-items."""
    data = cached_json_pg(
        "wfcd_relics",
        "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Relics.json",
        24 * 7)
    out = {}
    for r in data:
        name = r.get("name", "")
        if not name.endswith(" Intact"):
            continue
        base = name[:-len(" Intact")]
        best = max(r.get("drops") or [], key=lambda d: d.get("chance", 0),
                   default=None)
        out[base] = {
            "vaulted": bool(r.get("vaulted", False)),
            "farm": best["location"] if best else None,
            "farm_chance": round(best["chance"], 2) if best else None,
        }
    return out


def normalize(name: str) -> str:
    # Los drops dicen "Blueprint" para partes que el market lista igual;
    # el caso especial conocido es el collar de Kavasa.
    return (name.replace("Kavasa Prime Kubrow Collar Blueprint",
                         "Kavasa Prime Collar Blueprint")
                .replace("2X ", ""))


# ---------- warframe.market por item ----------

def get_json_retry(url: str, tries: int = 3):
    """GET tolerante: reintenta 429/timeouts antes de rendirse, devuelve None
    si no hay caso — mismo patrón que flips.py:get_json. Sin esto, un solo
    429 pasajero se guardaba como un CERO real en el cache compartido de 12h
    (o, para ducados, para siempre — ver fetch_ducats)."""
    for attempt in range(tries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            if r.status_code != 200:
                return None
            return r.json()
        except requests.RequestException:
            time.sleep(1 + attempt * 2)
    return None


def fetch_sell_price(slug: str) -> float | None:
    """Promedio de las 3 sell orders más baratas de usuarios conectados.
    None = no se pudo confirmar (fallo de red/rate-limit), no "vale 0".

    'platinum' es el total de la tanda cuando perTrade > 1: se divide
    para obtener el precio unitario real.
    """
    body = get_json_retry(f"https://api.warframe.market/v2/orders/item/{slug}/top")
    if body is None:
        return None
    sells = sorted(o["platinum"] / max(o.get("perTrade") or 1, 1)
                   for o in body["data"].get("sell", [])
                   if o.get("user", {}).get("status") == "ingame")
    return sum(sells[:3]) / len(sells[:3]) if sells else 0.0


def fetch_closed_stats(slug: str):
    """(mediana ponderada, volumen) de ventas cerradas en 48 h.
    (None, None) = no se pudo confirmar, distinto de (0.0, 0) = sin ventas."""
    body = get_json_retry(f"https://api.warframe.market/v1/items/{slug}/statistics")
    if body is None:
        return None, None
    hours = body.get("payload", {}).get("statistics_closed", {}).get("48hours", [])
    vol = sum(h.get("volume", 0) for h in hours)
    if not vol:
        return 0.0, 0
    med = sum(h.get("median", 0) * h.get("volume", 0) for h in hours) / vol
    return round(med, 1), vol


def fetch_ducats(slug: str) -> int | None:
    """None = no se pudo confirmar — a diferencia de sell/med48/vol48 (TTL de
    12h, se corrige solo), los ducados se guardan "para siempre" (no cambian)
    y solo se re-piden si siguen en NULL — un 0 guardado a la fuerza acá
    quedaba mal permanentemente."""
    body = get_json_retry(f"https://api.warframe.market/v2/item/{slug}")
    if body is None:
        return None
    return body["data"].get("ducats") or 0


def get_item_data(item_names: set, by_name: dict, refresh: bool) -> dict:
    """{name: {sell, med48, vol48, ducats}} — cache compartido en Postgres
    (item_price_cache, TTL 12h vía updated_at), no un JSON local: estos
    precios son iguales para cualquier usuario que pida un reporte, no tiene
    sentido re-pedirlos por cada uno.
    """
    cache: dict = {}
    with get_conn() as conn, conn.cursor() as cur:
        if not refresh:
            cur.execute("""
                SELECT name, sell, med48, vol48, ducats FROM item_price_cache
                WHERE name = ANY(%s) AND updated_at > now() - (%s || ' hours')::interval
            """, (list(item_names), PRICE_CACHE_HOURS))
            for name, sell, med48, vol48, ducats in cur.fetchall():
                cache[name] = {"sell": sell, "med48": med48, "vol48": vol48, "ducats": ducats}

        missing = [n for n in sorted(item_names) if n not in cache]
        if missing:
            mins = len(missing) * RATE * 2.2 / 60
            print(f"Bajando datos de {len(missing)} items de warframe.market "
                  f"(~{mins:.0f} min)...")

        # ducados: se cachean para siempre (no cambian) — leemos lo que haya
        # aunque esté vencido el resto del TTL, para no re-pedirlos de más.
        # "AND ducats IS NOT NULL": un NULL significa "el último intento
        # falló" (ver fetch_ducats) — sin este filtro, ese NULL se trataba
        # como un valor real ya conocido y nunca se reintentaba.
        cur.execute("SELECT name, ducats FROM item_price_cache WHERE name = ANY(%s) AND ducats IS NOT NULL",
                    (missing,))
        known_ducats = dict(cur.fetchall())

        def save(name: str, entry: dict):
            cur.execute("""
                INSERT INTO item_price_cache (name, sell, med48, vol48, ducats, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (name) DO UPDATE SET
                  sell = EXCLUDED.sell, med48 = EXCLUDED.med48, vol48 = EXCLUDED.vol48,
                  ducats = EXCLUDED.ducats, updated_at = now()
            """, (name, entry["sell"], entry["med48"], entry["vol48"], entry["ducats"]))

        for i, name in enumerate(missing, 1):
            slug = by_name.get(normalize(name).lower())
            if not slug or "forma" in name.lower():
                cache[name] = {"sell": 0.0, "med48": 0.0, "vol48": 0, "ducats": 0}
                save(name, cache[name])
                continue
            sell = fetch_sell_price(slug)
            time.sleep(RATE)
            med48, vol48 = fetch_closed_stats(slug)
            time.sleep(RATE)
            ducats = known_ducats.get(name)
            if ducats is None:
                ducats = fetch_ducats(slug)
                time.sleep(RATE)
            # sell/med48/vol48 SÍ pueden guardarse en 0 en un fallo — tienen
            # TTL de 12h, se autocorrigen solos en el próximo refresh. ducats
            # se guarda tal cual (puede ser None -> NULL en la DB) porque ESE
            # sí se trata como "para siempre" — ver el filtro de arriba.
            cache[name] = {
                "sell": sell if sell is not None else 0.0,
                "med48": med48 if med48 is not None else 0.0,
                "vol48": vol48 if vol48 is not None else 0,
                "ducats": ducats,
            }
            save(name, cache[name])
            if i % 20 == 0:
                print(f"  {i}/{len(missing)}...")
    return cache


def get_relic_prices(relic_names: list, by_name: dict, refresh: bool) -> dict:
    """Precio de venta de la reliquia entera ("Meso D3 Relic") — cache
    compartido en Postgres (relic_price_cache, TTL 12h), antes cache/relic_prices.json."""
    cache: dict = {}
    with get_conn() as conn, conn.cursor() as cur:
        if not refresh:
            cur.execute("""
                SELECT relic_full, price FROM relic_price_cache
                WHERE relic_full = ANY(%s) AND updated_at > now() - (%s || ' hours')::interval
            """, (relic_names, PRICE_CACHE_HOURS))
            cache = dict(cur.fetchall())

        missing = [n for n in relic_names if n not in cache]
        if missing:
            print(f"Bajando precios de {len(missing)} reliquias enteras "
                  f"(~{len(missing) * RATE / 60:.0f} min)...")
        for i, full in enumerate(missing, 1):
            slug = by_name.get(f"{full.lower()} relic")
            price = fetch_sell_price(slug) if slug else 0.0
            cache[full] = price
            cur.execute("""
                INSERT INTO relic_price_cache (relic_full, price, updated_at)
                VALUES (%s, %s, now())
                ON CONFLICT (relic_full) DO UPDATE SET price = EXCLUDED.price, updated_at = now()
            """, (full, price))
            time.sleep(RATE)
            if i % 30 == 0:
                print(f"  {i}/{len(missing)}...")
    return cache


# ---------- análisis ----------

def sell_of(items: dict, name: str) -> float:
    return items.get(name, {}).get("sell", 0.0)


def analyze_trades(stats: dict, by_ref: dict, items: dict, exclude_ts: set) -> list:
    """Ventas por plat que NO son un flip (ver detect_flips) — cosas que
    farmeaste (o de las que ya no tenés registro de compra) y vendiste,
    comparado contra el precio de mercado de HOY. Antes esta función escaneaba
    TODAS las ventas sin cruzar con detect_flips, así que un flip aparecía acá
    de nuevo con un número distinto (plat recibido vs precio de HOY, no vs lo
    que pagaste) — confuso, la misma trade con dos marcos incompatibles en dos
    pestañas. exclude_ts son los timestamps de venta que detect_flips YA
    contó como flip (con su costo real) — quedan afuera de acá a propósito.
    """
    sales = []
    for t in stats.get("trades") or []:
        ts = t.get("ts")
        if ts in exclude_ts:
            continue
        rx, tx = t.get("rx") or [], t.get("tx") or []
        plat = sum(i.get("cnt", 0) for i in rx if i.get("name") == PLAT_ITEM)
        if plat <= 0 or not tx:
            continue
        names, market_now, unknown = [], 0.0, False
        for it in tx:
            mname = resolve_ref(it.get("name", ""), by_ref)
            if not mname:
                unknown = True
                continue
            names.append(f'{it.get("cnt", 1)}x {mname}' if it.get("cnt", 1) > 1
                         else mname)
            market_now += sell_of(items, mname) * it.get("cnt", 1)
        if not names:
            continue
        sales.append({
            "ts": ts, "user": t.get("user"),
            "items": ", ".join(names), "plat": plat,
            "market_now": round(market_now, 1),
            "partial": unknown,
        })
    sales.sort(key=lambda s: s["ts"] or "", reverse=True)
    return sales


def _trade_item_names(side: list, by_ref: dict) -> list | None:
    """None si CUALQUIER item del trade no resuelve contra warframe.market
    (by_ref) — antes se descartaba silenciosamente el item sin resolver y
    se trataba el trade como si solo hubiera tenido los demás, lo que le
    asignaba el precio total de una venta de varias partes a una sola
    (Caliban: 3 de 4 componentes no resolvían, y la venta de las 4 juntas
    por 35p parecía "el Blueprint solo por 35p"). Mejor no armar el flip
    que armarlo con el precio mal repartido."""
    names = []
    for it in side:
        name = resolve_ref(it.get("name", ""), by_ref)
        if not name:
            return None
        names.append(name)
    return names


MAX_FLIP_DAYS = 14  # comprar y vender el mismo item meses después es dueño
# normal del item, no un flip — sin este tope, cualquier compra vieja sin
# relación (ej: una parte comprada hace tiempo para armarte tu propio
# Warframe) podía "adoptarse" como el lado de compra de una venta de algo
# que en realidad farmeaste después y no tiene nada que ver (caso real:
# Mesa Prime vendido 100% farmeado, sin ninguna compra involucrada).


def _within_flip_window(buy_ts: str | None, sell_ts: str | None) -> bool:
    if not buy_ts or not sell_ts:
        return False
    try:
        b = datetime.fromisoformat(buy_ts.replace("Z", "+00:00"))
        s = datetime.fromisoformat(sell_ts.replace("Z", "+00:00"))
    except ValueError:
        return False
    return b <= s <= b + timedelta(days=MAX_FLIP_DAYS)


def detect_flips(stats: dict, by_ref: dict, items: dict) -> tuple:
    """Empareja TRADES completos de compra con TRADES completos de venta —
    no items sueltos. Antes emparejaba por nombre de item individual, y
    cuando una venta juntaba varios items en un solo trade (vendiste el set
    entero de una), le asignaba el precio TOTAL de esa venta a CADA item por
    separado — inflaba el profit. Y las compras que llegaron como bundle
    (compraste el set entero de una, no parte por parte) quedaban afuera
    del todo porque no se podía repartir el costo por item.

    Dos patrones, en ese orden:
      1. Mismo conjunto EXACTO de items comprado y vendido en un solo trade
         cada vez (compraste el set entero, lo vendiste entero — o un item
         suelto comprado y vendido de a uno).
      2. Partes sueltas compradas por separado (un item por trade) y
         vendidas juntas como set en un solo trade — se suma lo que costó
         cada parte.
    Lo que no calza limpio en ninguno de los dos se deja afuera: mejor no
    mostrar un flip que inventar uno con el precio mal repartido.

    Devuelve (flips, unsold_purchases, flip_sale_ts) — este último es el set
    de timestamps de venta que SÍ se armaron como flip, para que Sales
    (analyze_trades) no los vuelva a mostrar con otro marco (vs precio de
    hoy en vez de vs lo que pagaste).
    """
    buy_trades, sell_trades = [], []
    for t in stats.get("trades") or []:
        tx, rx = t.get("tx") or [], t.get("rx") or []
        plat_rx = sum(i.get("cnt", 0) for i in rx if i.get("name") == PLAT_ITEM)
        plat_tx = sum(i.get("cnt", 0) for i in tx if i.get("name") == PLAT_ITEM)
        if plat_tx > 0 and not plat_rx:
            names = _trade_item_names(rx, by_ref)
            if names:
                buy_trades.append({"ts": t.get("ts"), "names": names, "plat": plat_tx, "_used": False})
        elif plat_rx > 0 and not plat_tx:
            names = _trade_item_names(tx, by_ref)
            if names:
                sell_trades.append({"ts": t.get("ts"), "names": names, "plat": plat_rx, "_used": False})
    sell_trades.sort(key=lambda s: s["ts"] or "")

    flips = []
    # patrón 1: mismo conjunto exacto en un solo trade de cada lado
    for s in sell_trades:
        s_key = sorted(s["names"])
        match = next((b for b in buy_trades if not b["_used"] and sorted(b["names"]) == s_key
                      and _within_flip_window(b["ts"], s["ts"])), None)
        if match:
            match["_used"] = True
            s["_used"] = True
            flips.append({
                "item": ", ".join(s["names"]), "buy": match["plat"], "sell": s["plat"], "ts": s["ts"],
                # cuánto vale HOY lo mismo que flipeaste — mismo cálculo que
                # unsold_purchases, para ver si el spread que exprimiste sigue
                # ahí o ya se achicó (a veces por tu propio flipping seguido).
                "market_now": round(sum(sell_of(items, n) for n in s["names"]), 1),
            })

    # patrón 2: partes sueltas (un item por trade) compradas por separado,
    # vendidas juntas. No exige que TODAS las partes tengan compra — a veces
    # una parte la conseguiste farmeando (gratis) y el resto sí lo compraste
    # (el caso real: Caliban Systems farmeado, Blueprint/Chassis/Neuroptics
    # comprados, las 4 vendidas juntas) — el costo es lo que SÍ pagaste,
    # exigir el 100% de las partes compradas dejaba el flip afuera entero.
    # Pero exige MAYORÍA compradas, no solo "al menos una": comprar 1 parte
    # sueltas y farmear las otras 3 (caso real: Mesa Prime, Chassis comprado
    # por 7p, Neuroptics/Systems/Blueprint farmeados) es vender algo que
    # básicamente farmeaste, no un flip — la parte comprada es incidental.
    for s in sell_trades:
        if s["_used"]:
            continue
        parts = []
        for name in s["names"]:
            pick = next((b for b in buy_trades if not b["_used"] and b["names"] == [name]
                         and _within_flip_window(b["ts"], s["ts"])), None)
            if pick:
                parts.append(pick)
        if len(parts) * 2 > len(s["names"]):  # mayoría de partes compradas
            for b in parts:
                b["_used"] = True
            s["_used"] = True
            flips.append({
                "item": ", ".join(s["names"]), "buy": sum(b["plat"] for b in parts),
                "sell": s["plat"], "ts": s["ts"],
                "market_now": round(sum(sell_of(items, n) for n in s["names"]), 1),
            })

    unsold_purchases = [{
        "ts": b["ts"], "user": None,
        "item": ", ".join(b["names"]), "qty": len(b["names"]),
        # bundle de varios items: no se puede repartir el costo por uno,
        # se manda sin costo y se completa a mano al postear
        "plat_paid": b["plat"] if len(b["names"]) == 1 else None,
        "market_now": round(sum(sell_of(items, n) for n in b["names"]), 1),
    } for b in buy_trades if not b["_used"]]
    unsold_purchases.sort(key=lambda p: p["ts"] or "", reverse=True)

    # timestamps de las ventas que quedaron adentro de un flip — analyze_trades
    # los excluye de Sales para no mostrar la misma trade dos veces con dos
    # marcos distintos (acá: profit real vs lo que pagaste; ahí: vs precio de hoy).
    flip_sale_ts = {s["ts"] for s in sell_trades if s["_used"]}
    return flips, unsold_purchases[:20], flip_sale_ts


def build_report(public_token: str, refresh: bool = False) -> dict:
    """Arma el reporte completo (reliquias/historial/ventas) para UN usuario,
    identificado por su token público de AlecaFrame. Sin efectos de archivo —
    scripts/report_server.py es el que decide si cachear el resultado
    (user_reports, Postgres) y por cuánto tiempo (TTL)."""
    print("Leyendo datos de AlecaFrame...")
    inventory = get_relic_inventory(public_token)
    try:
        stats = get_player_stats(public_token)
    except Exception as e:
        # el inventario de reliquias (arriba) es la única parte de AlecaFrame
        # de la que dependemos de verdad; si este otro endpoint falla o
        # AlecaFrame está caído, seguimos igual con plat/credits/sales vacíos
        # en vez de tirar todo el reporte.
        print(f"  aviso: no se pudo leer player stats de AlecaFrame ({e}); "
              f"sigo sin history/sales.\n")
        stats = {}
    total_relics = sum(r["count"] for r in inventory)
    print(f"  {len(inventory)} tipos de reliquia, {total_relics} en total, "
          f"{len(stats.get('trades') or [])} trades.\n")

    drops = load_drop_tables()
    by_name, by_ref = load_market_items()
    wfcd = load_wfcd_relics()

    # Items que pueden salir de tus reliquias + items que vendiste en trades
    needed = set()
    for r in inventory:
        for state in ("Intact", "Radiant"):
            for rw in drops.get((r["tier"], r["name"], state), []):
                needed.add(rw["itemName"])
    for t in stats.get("trades") or []:
        for it in t.get("tx") or []:
            mname = resolve_ref(it.get("name", ""), by_ref)
            if mname:
                needed.add(mname)

    items = get_item_data(needed, by_name, refresh)

    relic_fulls = sorted({f'{r["tier"]} {r["name"]}' for r in inventory
                          if r["tier"] != "Requiem"})
    relic_prices = get_relic_prices(relic_fulls, by_name, refresh)

    rows = []
    for r in inventory:
        full = f'{r["tier"]} {r["name"]}'
        intact = drops.get((r["tier"], r["name"], "Intact"))
        radiant = drops.get((r["tier"], r["name"], "Radiant"))
        if not intact:
            continue  # sin tabla (Requiem, etc.)
        ev_i = sum(rw["chance"] / 100 * sell_of(items, rw["itemName"])
                   for rw in intact)
        ev_r = (sum(rw["chance"] / 100 * sell_of(items, rw["itemName"])
                    for rw in radiant) if radiant else ev_i)
        # "or 0", no ".get(..., 0)": ducats puede estar presente y ser None
        # (fetch pendiente de reintentar, ver fetch_ducats) — .get con default
        # solo cubre la CLAVE ausente, no un valor None ya guardado.
        ev_ducats = sum(rw["chance"] / 100 *
                        (items.get(rw["itemName"], {}).get("ducats") or 0)
                        for rw in intact)
        jackpot = max(intact, key=lambda rw: sell_of(items, rw["itemName"]))
        jname = jackpot["itemName"]
        jdata = items.get(jname, {})
        rad_chance = {rw["itemName"]: rw["chance"] for rw in radiant or []}
        drop_detail = [{
            "item": rw["itemName"],
            "rarity": rw["rarity"],
            "chance_intact": rw["chance"],
            "chance_radiant": rad_chance.get(rw["itemName"], rw["chance"]),
            "price": sell_of(items, rw["itemName"]),
            "med48": items.get(rw["itemName"], {}).get("med48", 0),
            "vol48": items.get(rw["itemName"], {}).get("vol48", 0),
            "ducats": items.get(rw["itemName"], {}).get("ducats") or 0,
        } for rw in intact]
        info = wfcd.get(full, {})
        rows.append({
            "relic": full, "tier": r["tier"], "count": r["count"],
            "refinement": r["refinement"],
            "ev_intact": ev_i, "ev_radiant": ev_r, "ev_ducats": ev_ducats,
            "jackpot": jname,
            "jackpot_price": jdata.get("sell", 0),
            "jackpot_med48": jdata.get("med48", 0),
            "jackpot_vol48": jdata.get("vol48", 0),
            "relic_price": relic_prices.get(full, 0),
            "vaulted": info.get("vaulted", False),
            "farm": info.get("farm"),
            "farm_chance": info.get("farm_chance"),
            "drops": drop_detail,
        })

    # detect_flips primero: Sales necesita saber qué ventas ya se contaron
    # como flip para no repetirlas con otro marco (ver analyze_trades).
    detected_flips, unsold_purchases, flip_sale_ts = detect_flips(stats, by_ref, items)
    sales = analyze_trades(stats, by_ref, items, exclude_ts=flip_sale_ts)

    return {
        "generated_ts": time.time(),
        "username": stats.get("usernameWhenPublic"),
        "relics": rows,
        "sales": sales,
        "unsold_purchases": unsold_purchases,
        # no va en el report.json que ve el frontend — report_server.py lo
        # guarda aparte en user_detected_flips (Postgres), separado del
        # ledger de flips manuales (user_ledger_flips)
        "_detected_flips": detected_flips,
        "history": stats.get("generalDataPoints") or [],
    }


def main():
    """Uso CLI local: un solo usuario (token de .env), escribe cache/report.json
    y app/public/data/report.json — el flujo viejo, para seguir pudiendo
    correr el análisis a mano sin levantar el server."""
    refresh = "--refresh" in sys.argv
    if not CLI_PUBLIC_TOKEN:
        sys.exit("Falta ALECA_PUBLIC_TOKEN en .env")
    report = build_report(CLI_PUBLIC_TOKEN, refresh)
    rows = report["relics"]
    detected_flips = report.pop("_detected_flips", [])
    print(f"Flips detectados en tu historial (compra→venta emparejadas): {len(detected_flips)}")

    payload = json.dumps(report, indent=1, ensure_ascii=False)
    (CACHE_DIR / "report.json").write_text(payload, encoding="utf-8")
    dash = ROOT / "app" / "public" / "data"
    if dash.exists():
        (dash / "report.json").write_text(payload, encoding="utf-8")

    # resumen por consola
    rows.sort(key=lambda x: x["ev_radiant"], reverse=True)
    vaulted_n = sum(1 for x in rows if x["vaulted"])
    print(f"Reliquias vaulteadas: {vaulted_n} de {len(rows)} tipos")
    print(f"Ventas con plat en tu historial: {len(report['sales'])}")
    print("\nTop 10 por EV radiante:")
    for row in rows[:10]:
        v = " [VAULTED]" if row["vaulted"] else ""
        print(f'  {row["relic"]:<10} x{row["count"]:<4} EV rad '
              f'{row["ev_radiant"]:>5.1f}p  {row["jackpot"]} '
              f'({row["jackpot_price"]:.0f}p, {row["jackpot_vol48"]} ventas/48h){v}')
    print("\nReporte guardado en cache/report.json")


if __name__ == "__main__":
    main()
