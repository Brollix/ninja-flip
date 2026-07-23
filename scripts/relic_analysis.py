"""Análisis de reliquias: qué conviene abrir/farmear para platino.

Cruza tu inventario de reliquias (AlecaFrame) con:
 - tablas de drops oficiales (drops.warframestat.us)
 - precios, liquidez (ventas 48h) y ducados de warframe.market
 - estado vaulted + ubicaciones de farmeo (WFCD warframe-items)
 - tu historial de trades de AlecaFrame

Uso:
    python relic_analysis.py            -> reporte (usa cache de 12 h)
    python relic_analysis.py --refresh  -> fuerza re-descarga de precios

El primer run tarda varios minutos (3 requests por item a ~3 req/s).
"""

import base64
import json
import os
import struct
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
PUBLIC_TOKEN = os.getenv("ALECA_PUBLIC_TOKEN")

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

def get_relic_inventory() -> list:
    """Devuelve [{tier, name, refinement, count}] desde AlecaFrame."""
    r = session.get(
        "https://stats.alecaframe.com/api/stats/public/getRelicInventory",
        params={"publicToken": PUBLIC_TOKEN}, timeout=30)
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


def get_player_stats() -> dict:
    r = session.get("https://stats.alecaframe.com/api/stats/public",
                    params={"token": PUBLIC_TOKEN}, timeout=30)
    r.raise_for_status()
    return r.json()


# ---------- fuentes externas ----------

def cached_json(path: Path, url: str, max_age_h: float):
    if path.exists() and (time.time() - path.stat().st_mtime) < max_age_h * 3600:
        return json.loads(path.read_text(encoding="utf-8"))
    r = session.get(url, timeout=300)
    r.raise_for_status()
    path.write_text(r.text, encoding="utf-8")
    return r.json()


def load_drop_tables() -> dict:
    """{(tier, name, refinement): [{itemName, chance}]}"""
    data = cached_json(CACHE_DIR / "relic_drops.json",
                       "https://drops.warframestat.us/data/relics.json", 24 * 7)
    tables = {}
    for rel in data["relics"]:
        if not all(k in rel for k in ("tier", "relicName", "state", "rewards")):
            continue
        tables[(rel["tier"], rel["relicName"], rel["state"])] = rel["rewards"]
    return tables


def load_market_items():
    """(name_lower -> slug, gameRef -> name) de warframe.market."""
    data = cached_json(CACHE_DIR / "market_items.json",
                       "https://api.warframe.market/v2/items", 24 * 7)
    by_name, by_ref = {}, {}
    for it in data["data"]:
        name = it["i18n"]["en"]["name"]
        by_name[name.lower()] = it["slug"]
        if it.get("gameRef"):
            by_ref[it["gameRef"]] = name
    return by_name, by_ref


def load_wfcd_relics() -> dict:
    """{'Meso D3': {vaulted, farm, farm_chance}} desde WFCD warframe-items."""
    data = cached_json(
        CACHE_DIR / "wfcd_relics.json",
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

def fetch_sell_price(slug: str) -> float:
    """Promedio de las 3 sell orders más baratas de usuarios conectados.

    'platinum' es el total de la tanda cuando perTrade > 1: se divide
    para obtener el precio unitario real.
    """
    r = session.get(f"https://api.warframe.market/v2/orders/item/{slug}/top",
                    timeout=30)
    if r.status_code != 200:
        return 0.0
    sells = sorted(o["platinum"] / max(o.get("perTrade") or 1, 1)
                   for o in r.json()["data"].get("sell", [])
                   if o.get("user", {}).get("status") == "ingame")
    return sum(sells[:3]) / len(sells[:3]) if sells else 0.0


def fetch_closed_stats(slug: str):
    """(mediana ponderada, volumen) de ventas cerradas en 48 h."""
    r = session.get(
        f"https://api.warframe.market/v1/items/{slug}/statistics", timeout=30)
    if r.status_code != 200:
        return 0.0, 0
    hours = r.json().get("payload", {}).get("statistics_closed", {}).get("48hours", [])
    vol = sum(h.get("volume", 0) for h in hours)
    if not vol:
        return 0.0, 0
    med = sum(h.get("median", 0) * h.get("volume", 0) for h in hours) / vol
    return round(med, 1), vol


def fetch_ducats(slug: str) -> int:
    r = session.get(f"https://api.warframe.market/v2/item/{slug}", timeout=30)
    if r.status_code != 200:
        return 0
    return r.json()["data"].get("ducats") or 0


def get_item_data(item_names: set, by_name: dict, refresh: bool) -> dict:
    """{name: {sell, med48, vol48, ducats}} con cache.

    Ducados se cachean para siempre (no cambian); precios/volumen 12 h.
    """
    cache_path = CACHE_DIR / "item_data.json"
    meta_path = CACHE_DIR / "item_meta.json"
    cache, meta = {}, {}
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if not refresh and cache_path.exists():
        stored = json.loads(cache_path.read_text(encoding="utf-8"))
        if time.time() - stored.get("ts", 0) < PRICE_CACHE_HOURS * 3600:
            cache = stored.get("items", {})

    missing = [n for n in sorted(item_names) if n not in cache]
    if missing:
        mins = len(missing) * RATE * 2.2 / 60
        print(f"Bajando datos de {len(missing)} items de warframe.market "
              f"(~{mins:.0f} min)...")

    def save():
        cache_path.write_text(json.dumps({"ts": time.time(), "items": cache}),
                              encoding="utf-8")
        meta_path.write_text(json.dumps(meta), encoding="utf-8")

    for i, name in enumerate(missing, 1):
        slug = by_name.get(normalize(name).lower())
        if not slug or "forma" in name.lower():
            cache[name] = {"sell": 0.0, "med48": 0.0, "vol48": 0, "ducats": 0}
            continue
        sell = fetch_sell_price(slug)
        time.sleep(RATE)
        med48, vol48 = fetch_closed_stats(slug)
        time.sleep(RATE)
        if name not in meta:
            meta[name] = {"ducats": fetch_ducats(slug)}
            time.sleep(RATE)
        cache[name] = {"sell": sell, "med48": med48, "vol48": vol48,
                       "ducats": meta[name]["ducats"]}
        if i % 20 == 0:
            print(f"  {i}/{len(missing)}...")
            save()
    save()
    return cache


def get_relic_prices(relic_names: list, by_name: dict, refresh: bool) -> dict:
    """Precio de venta de la reliquia entera ('Meso D3 Relic') con cache."""
    cache_path = CACHE_DIR / "relic_prices.json"
    cache = {}
    if not refresh and cache_path.exists():
        stored = json.loads(cache_path.read_text(encoding="utf-8"))
        if time.time() - stored.get("ts", 0) < PRICE_CACHE_HOURS * 3600:
            cache = stored.get("prices", {})
    missing = [n for n in relic_names if n not in cache]
    if missing:
        print(f"Bajando precios de {len(missing)} reliquias enteras "
              f"(~{len(missing) * RATE / 60:.0f} min)...")
    for i, full in enumerate(missing, 1):
        slug = by_name.get(f"{full.lower()} relic")
        cache[full] = fetch_sell_price(slug) if slug else 0.0
        time.sleep(RATE)
        if i % 30 == 0:
            print(f"  {i}/{len(missing)}...")
            cache_path.write_text(
                json.dumps({"ts": time.time(), "prices": cache}), encoding="utf-8")
    cache_path.write_text(json.dumps({"ts": time.time(), "prices": cache}),
                          encoding="utf-8")
    return cache


# ---------- análisis ----------

def sell_of(items: dict, name: str) -> float:
    return items.get(name, {}).get("sell", 0.0)


def analyze_trades(stats: dict, by_ref: dict, items: dict) -> list:
    """Ventas por plat: qué recibiste vs precio de mercado actual."""
    sales = []
    for t in stats.get("trades") or []:
        rx, tx = t.get("rx") or [], t.get("tx") or []
        plat = sum(i.get("cnt", 0) for i in rx if i.get("name") == PLAT_ITEM)
        if plat <= 0 or not tx:
            continue
        names, market_now, unknown = [], 0.0, False
        for it in tx:
            mname = by_ref.get(it.get("name", ""))
            if not mname:
                unknown = True
                continue
            names.append(f'{it.get("cnt", 1)}x {mname}' if it.get("cnt", 1) > 1
                         else mname)
            market_now += sell_of(items, mname) * it.get("cnt", 1)
        if not names:
            continue
        sales.append({
            "ts": t.get("ts"), "user": t.get("user"),
            "items": ", ".join(names), "plat": plat,
            "market_now": round(market_now, 1),
            "partial": unknown,
        })
    sales.sort(key=lambda s: s["ts"] or "", reverse=True)
    return sales


def main():
    refresh = "--refresh" in sys.argv
    print("Leyendo datos de AlecaFrame...")
    inventory = get_relic_inventory()
    stats = get_player_stats()
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
            mname = by_ref.get(it.get("name", ""))
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
        ev_ducats = sum(rw["chance"] / 100 *
                        items.get(rw["itemName"], {}).get("ducats", 0)
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
            "ducats": items.get(rw["itemName"], {}).get("ducats", 0),
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

    sales = analyze_trades(stats, by_ref, items)

    report = {
        "generated_ts": time.time(),
        "username": stats.get("usernameWhenPublic"),
        "relics": rows,
        "sales": sales,
        "history": stats.get("generalDataPoints") or [],
    }
    payload = json.dumps(report, indent=1, ensure_ascii=False)
    (CACHE_DIR / "report.json").write_text(payload, encoding="utf-8")
    dash = ROOT / "app" / "public" / "data"
    if dash.exists():
        (dash / "report.json").write_text(payload, encoding="utf-8")
        # mapa liviano itemId -> (slug, nombre) para la sección "Mis órdenes"
        raw = json.loads((CACHE_DIR / "market_items.json").read_text(encoding="utf-8"))
        slim = {it["id"]: [it["slug"], it["i18n"]["en"]["name"]] for it in raw["data"]}
        (dash / "items.json").write_text(json.dumps(slim, ensure_ascii=False),
                                         encoding="utf-8")

    # resumen por consola
    rows.sort(key=lambda x: x["ev_radiant"], reverse=True)
    vaulted_n = sum(1 for x in rows if x["vaulted"])
    print(f"Reliquias vaulteadas: {vaulted_n} de {len(rows)} tipos")
    print(f"Ventas con plat en tu historial: {len(sales)}")
    print("\nTop 10 por EV radiante:")
    for row in rows[:10]:
        v = " [VAULTED]" if row["vaulted"] else ""
        print(f'  {row["relic"]:<10} x{row["count"]:<4} EV rad '
              f'{row["ev_radiant"]:>5.1f}p  {row["jackpot"]} '
              f'({row["jackpot_price"]:.0f}p, {row["jackpot_vol48"]} ventas/48h){v}')
    print("\nReporte guardado en cache/report.json — generá el dashboard con: "
          "python build_report.py")


if __name__ == "__main__":
    main()
