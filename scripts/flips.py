"""Scanner de flips: oportunidades de comprar barato / vender caro en warframe.market.

Barre todos los sets Prime (los items más líquidos del juego) y calcula:
 - mejor orden de COMPRA activa (a lo que podés comprar rápido posteando 1p arriba)
 - venta más barata activa (a lo que podés revender 1p abajo)
 - spread = tu ganancia bruta por flip
 - volumen de ventas 48h (liquidez: cuán rápido rota)
 - arbitraje partes→set para los mejores (comprar partes sueltas, vender el set)

Uso:
    python scripts/flips.py             -> refresco rápido (~1 min): re-cotiza los
                                           mejores candidatos, el resto del cache
    python scripts/flips.py --full      -> escaneo completo (~4-7 min)
    python scripts/flips.py --parts N   -> además arbitraje partes→set de los top N

Corre como el Cloud Run Job "flip-scanner" (ver infra/), disparado por Cloud
Scheduler cada 10 min en modo refresco rápido. El cache de trabajo (buy/sell/
vol48/rank por item) vive en Postgres (tabla market_items, Neon) en vez de un
JSON local — un Job de Cloud Run es un container nuevo cada corrida, sin disco
persistente entre una y otra.
"""

import sys
import time
from datetime import datetime

import requests

from db import get_conn

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

RATE = 0.4
MIN_SPREAD = 15     # plat mínimo de ganancia bruta para listar
MIN_VOL48 = 10      # ventas mínimas en 48h (liquidez)

session = requests.Session()
session.headers["User-Agent"] = "flip-scanner/1.0"


def market_items():
    """Catálogo completo de warframe.market. Antes leía un JSON compartido con
    relic_analysis.py (cache/market_items.json) — en un Job de Cloud Run cada
    corrida es un container nuevo, así que lo pedimos fresco (1 sola request,
    no es la parte cara del escaneo)."""
    j = get_json("https://api.warframe.market/v2/items")
    return (j or {}).get("data") or []


def get_json(url: str, tries: int = 3):
    """GET tolerante: reintenta timeouts/errores de red y devuelve None si no va.

    Un escaneo de 8 minutos no puede morir por un request lento.
    """
    for attempt in range(tries):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 429:          # rate limit: esperar y reintentar
                time.sleep(2 + attempt * 2)
                continue
            if r.status_code != 200:
                return None
            return r.json()
        except requests.RequestException:
            time.sleep(1 + attempt * 2)
    return None


def top_orders(slug: str, rank: int = 0):
    """(mejor compra, mejor venta) del rango pedido, de usuarios en el juego.

    Con rango > 0 hay que leer el libro COMPLETO: /top devuelve solo las 5
    puntas globales y en arcanos/mods esas 5 son todas de rango 0, así que
    filtrar por rango máximo dejaba la lista vacía.
    """
    unit = lambda o: o["platinum"] / max(o.get("perTrade") or 1, 1)
    ingame = lambda o: o.get("user", {}).get("status") == "ingame"
    same_rank = lambda o: (o.get("rank") or 0) == rank

    if rank > 0:
        j = get_json(f"https://api.warframe.market/v2/orders/item/{slug}")
        if not j:
            return None, None
        orders = j.get("data") or []
        buys = [unit(o) for o in orders
                if o.get("type") == "buy" and ingame(o) and same_rank(o)]
        sells = [unit(o) for o in orders
                 if o.get("type") == "sell" and ingame(o) and same_rank(o)]
    else:
        j = get_json(f"https://api.warframe.market/v2/orders/item/{slug}/top")
        if not j:
            return None, None
        d = j["data"]
        buys = [unit(o) for o in d.get("buy", []) if ingame(o) and same_rank(o)]
        sells = [unit(o) for o in d.get("sell", []) if ingame(o) and same_rank(o)]
    return (max(buys) if buys else None), (min(sells) if sells else None)


def volume48(slug: str, rank: int = 0) -> int:
    """Unidades vendidas en 48 h en el rango que flipeamos (liquidez).

    Solo el conteo: los precios los tomamos del libro de órdenes real.
    """
    j = get_json(f"https://api.warframe.market/v1/items/{slug}/statistics")
    if not j:
        return 0
    hours = j.get("payload", {}).get("statistics_closed", {}).get("48hours", [])
    hours = [h for h in hours if (h.get("mod_rank") or 0) == rank]
    return sum(h.get("volume", 0) for h in hours)


HOURLY_ACTIVITY_SAMPLE = 150      # items para la muestra de "mejor momento"
HOURLY_ACTIVITY_REFRESH_H = 3     # no se rearma más seguido que esto


def hourly_activity_stale() -> bool:
    """True si nunca se armó, o si la última vez fue hace más de
    HOURLY_ACTIVITY_REFRESH_H — evita rearmar la curva en CADA corrida de
    10 min (eso saldría ~150 requests extra cada vez, no hace falta con esa
    frecuencia para algo que cambia de a poco)."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT MIN(updated_at) FROM hourly_activity")
        oldest = cur.fetchone()[0]
    if oldest is None:
        return True
    return (datetime.now(oldest.tzinfo) - oldest).total_seconds() > HOURLY_ACTIVITY_REFRESH_H * 3600


def refresh_hourly_activity() -> None:
    """Rearma la curva de actividad ENTERA desde cero, de una muestra amplia
    de items — a propósito NO depende del volume48() de arriba (ese solo
    corre para un puñado de items por corrida, según el TTL de precios de
    12h; pisar la tabla con esa muestra chiquita cada 10 min era media hora
    de ruido en vez de una foto real). Guarda franjas horarias reales
    (cronológicas, timestamp truncado a la hora) en vez de plegarlas por
    hora-del-día — es el techo real de granularidad que da la API (48h por
    item), así que se borra y reinserta toda la tabla en cada corrida en vez
    de hacer upsert, porque la ventana de 48h se desliza con el tiempo."""
    if not hourly_activity_stale():
        return
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT slug FROM market_items ORDER BY vol48 DESC LIMIT %s",
                    (HOURLY_ACTIVITY_SAMPLE,))
        slugs = [r[0] for r in cur.fetchall()]
    if not slugs:
        return
    print(f"Rearmando curva de actividad ({len(slugs)} items)...", flush=True)
    buckets: dict[str, int] = {}
    for i, slug in enumerate(slugs, 1):
        j = get_json(f"https://api.warframe.market/v1/items/{slug}/statistics")
        for h in (j or {}).get("payload", {}).get("statistics_closed", {}).get("48hours", []):
            dt = h.get("datetime") or ""
            if len(dt) >= 13 and dt[10] == "T":
                bucket = dt[:13] + ":00:00+00:00"  # trunca a la hora, UTC
                buckets[bucket] = buckets.get(bucket, 0) + (h.get("volume") or 0)
        time.sleep(RATE)
        if i % 30 == 0:
            print(f"  {i}/{len(slugs)}...", flush=True)
    if not buckets:
        return
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM hourly_activity")
        cur.executemany("""
            INSERT INTO hourly_activity (bucket_ts, volume, updated_at)
            VALUES (%s, %s, now())
        """, list(buckets.items()))


def item_detail(slug: str) -> dict:
    j = get_json(f"https://api.warframe.market/v2/item/{slug}")
    return (j or {}).get("data") or {}


def flip_rank(slug: str, kind: str, entry: dict) -> int:
    """Rango que se flipea: maxeado en arcanos y mods rankeables.

    Los mods de rango bajo (<=5, tipo augments) se flipean sin rankear:
    ahí el volumen está en rango 0. maxRank no cambia nunca — una vez resuelto
    para un slug (entry["rank_known"], persistido en market_items) no se
    vuelve a pedir.
    """
    if kind == "set":
        return 0
    if not entry.get("rank_known"):
        entry["rank"] = item_detail(slug).get("maxRank") or 0
        entry["rank_known"] = True
        time.sleep(RATE)
    mx = entry["rank"]
    if kind == "arcane":
        return mx                      # arcanos: siempre maxeados
    return mx if mx >= 6 else 0        # primed/rankeables altos: maxeados


def pick_targets():
    """Mercados con mejor rendimiento para flipear: sets Prime (liquidez),
    arcanos rango 0 (volumen enorme) y primed mods rango 0 (ticket alto)."""
    targets = []
    for it in market_items():
        tags = it.get("tags") or []
        name = it["i18n"]["en"]["name"]
        if it["slug"].endswith("_prime_set"):
            targets.append((it, "set"))
        elif "arcane_enhancement" in tags:
            targets.append((it, "arcane"))
        elif "mod" in tags and name.startswith("Primed "):
            targets.append((it, "mod"))
    return targets


# ---------------------------------------------------------------------------
# Cache de items: el volumen 48 h cambia lento (TTL 12 h) y los precios rápido.
# Un escaneo completo son ~780 requests (7 min); con esto el refresco normal
# solo re-cotiza los candidatos que valen la pena (~1 min).
# Vive en Postgres (market_items, Neon) — antes cache/item_cache.json: el Job
# de Cloud Run es un container nuevo cada corrida, sin disco entre una y otra.
# ---------------------------------------------------------------------------
VOL_TTL = 12 * 3600      # volumen: medio día
TOP_REFRESH = 120        # cuántos candidatos re-cotizar en modo rápido


def load_item_cache() -> dict:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT slug, name, kind, rank, rank_known, buy, sell, vol48, price_ts, vol_ts
            FROM market_items
        """)
        cols = [d.name for d in cur.description]
        return {row[0]: dict(zip(cols, row)) for row in cur.fetchall()}


def save_item_cache(cache: dict) -> None:
    if not cache:
        return
    rows = []
    for slug, e in cache.items():
        buy, sell, vol48 = e.get("buy") or 0, e.get("sell") or 0, e.get("vol48") or 0
        margin = (sell - buy) / sell * 100 if sell > buy > 0 or (sell > 0 and buy == 0) else 0
        score = flip_score(margin, vol48, max(sell - buy, 0)) if sell > 0 else 0
        rows.append((
            slug, e.get("name") or slug, e.get("kind") or "set", e.get("rank") or 0,
            bool(e.get("rank_known")), buy, sell, vol48, score,
            e.get("price_ts"), e.get("vol_ts"),
        ))
    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany("""
            INSERT INTO market_items (slug, name, kind, rank, rank_known, buy, sell, vol48, score, price_ts, vol_ts, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (slug) DO UPDATE SET
              name = EXCLUDED.name, kind = EXCLUDED.kind, rank = EXCLUDED.rank,
              rank_known = EXCLUDED.rank_known, buy = EXCLUDED.buy, sell = EXCLUDED.sell,
              vol48 = EXCLUDED.vol48, score = EXCLUDED.score,
              price_ts = EXCLUDED.price_ts, vol_ts = EXCLUDED.vol_ts,
              updated_at = now()
        """, rows)


VOL48_FULL_CONF = 100   # ventas/48h a partir de las cuales ya está "líquido de sobra"
MARGIN_FULL_CONF = 20   # % de margen a partir del cual ya es "sano de sobra"
LIQUIDITY_WEIGHT = 1.6  # >1: castiga más fuerte la poca liquidez (ver flip_score)
SPREAD_WEIGHT = 1.4     # >1: un spread bajo pesa menos que proporcional, uno alto pesa más


def flip_score(margin_pct: float, vol48: int, spread: float) -> float:
    """Coeficiente único para rankear flips: cuánto plat REAL esperás sacar,
    descontado por cuán confiable es conseguirlo.

    El spread ya no es lineal: va a la SPREAD_WEIGHT (>1), así que no solo
    "más plata es mejor" sino que un flip de poca plata pierde puntaje más
    que proporcional (15p → 15**1.4≈54; 65p → 65**1.4≈327 — la razón entre
    ambos pasa de 4.3x a 6.1x). Si el profit es bajo, el score tiene que
    quedar bajo de verdad, no solo un poco más bajo.

    Margen y liquidez siguen actuando como descuentos de confianza de 0 a 1:
      - liquidez (ventas/48h, con techo en 100): cuánta gente lo compra de
        verdad ahora. Se eleva a LIQUIDITY_WEIGHT (>1) para que la cantidad
        de trades pese más — un item con la mitad de liquidez no pierde la
        mitad de confianza, pierde bastante más (0.5 → 0.5**1.6 ≈ 0.33). Un
        spread enorme en un item que casi nadie compra (los arcanos caros)
        se descuenta fuerte acá.
      - margen % (con techo en 20%): penaliza apenas los flips carísimos
        para lo poco que dejan proporcionalmente, sin por eso preferir un
        flip de 15p con 60% de margen por sobre uno de 70p con 30%.
    """
    spread_term = max(spread, 0) ** SPREAD_WEIGHT
    liquidity_conf = (min(max(vol48, 0), VOL48_FULL_CONF) / VOL48_FULL_CONF) ** LIQUIDITY_WEIGHT
    margin_conf = min(max(margin_pct, 0), MARGIN_FULL_CONF) / MARGIN_FULL_CONF
    return spread_term * liquidity_conf * margin_conf


def interest(entry: dict) -> float:
    """Prioridad para re-cotizar en un escaneo incremental: mismo flip_score
    que el ranking final, no una fórmula aparte — si no, el scanner podía
    priorizar refrescar precios de items que el ranking real ni valora."""
    buy, sell = entry.get("buy") or 0, entry.get("sell") or 0
    if sell <= 0:
        return 0.0
    margin_pct = max(sell - buy, 0) / sell * 100
    return flip_score(margin_pct, entry.get("vol48") or 0, sell - buy)


STALE_AGE = 3 * 3600  # ningún item cacheado debería superar esto sin recotizarse


def scan_sets(full: bool = False):
    targets = pick_targets()
    cache = load_item_cache()
    now = time.time()

    # a quién le pedimos precio fresco esta vuelta
    if full:
        queue = [(it, kind) for it, kind in targets]
    else:
        never = [(it, k) for it, k in targets if it["slug"] not in cache]
        known = [(it, k) for it, k in targets if it["slug"] in cache]
        # Sin esto, un item cuyo spread se cruza (comprador se desconecta,
        # score cae a 0) deja de rankear entre los TOP_REFRESH por interés y
        # nunca más se vuelve a cotizar en modo rápido (producción no corre
        # --full) — queda con precios viejos para siempre aunque el mercado
        # real haya cambiado. "stale" fuerza su recotización sin importar el
        # score, sea cual sea.
        stale = [(it, k) for it, k in known
                 if now - (cache[it["slug"]].get("price_ts") or 0) > STALE_AGE]
        stale_slugs = {it["slug"] for it, _ in stale}
        rest = [(it, k) for it, k in known if it["slug"] not in stale_slugs]
        rest.sort(key=lambda t: interest(cache[t[0]["slug"]]), reverse=True)
        queue = never + stale + rest[:TOP_REFRESH]

    print(f"{'Escaneo completo' if full else 'Refresco rápido'}: "
          f"{len(queue)} de {len(targets)} items "
          f"(~{len(queue) * RATE * 1.6 / 60:.0f} min). "
          f"El resto sale del cache.\n", flush=True)

    todo = {it["slug"] for it, _ in queue}
    for i, (it, kind) in enumerate(queue, 1):
        slug = it["slug"]
        entry = cache.setdefault(slug, {})
        rank = flip_rank(slug, kind, entry)
        buy, sell = top_orders(slug, rank)
        time.sleep(RATE)
        # el volumen solo si venció el TTL: ahorra la mitad de los requests
        if now - (entry.get("vol_ts") or 0) > VOL_TTL:
            entry["vol48"] = volume48(slug, rank)
            entry["vol_ts"] = now
            time.sleep(RATE)
        entry.update({
            "name": it["i18n"]["en"]["name"], "kind": kind, "rank": rank,
            "buy": buy or 0, "sell": sell or 0, "price_ts": now,
        })
        if i % 25 == 0:
            print(f"  {i}/{len(queue)}...", flush=True)
            save_item_cache(cache)

    save_item_cache(cache)

    # armamos las filas con todo el cache (fresco + lo que no se re-cotizó)
    rows = []
    for it, kind in targets:
        e = cache.get(it["slug"])
        if not e or not e.get("sell"):
            continue
        buy, sell = e.get("buy") or 0, e["sell"]
        if sell <= buy:
            continue
        margin = (sell - buy) / sell * 100
        vol48 = e.get("vol48") or 0
        rows.append({
            "name": e.get("name") or it["i18n"]["en"]["name"], "slug": it["slug"],
            "kind": e.get("kind") or kind, "rank": e.get("rank") or 0,
            "buy": buy, "sell": sell, "spread": sell - buy,
            "margin": margin,
            "vol48": vol48,
            "score": flip_score(margin, vol48, sell - buy),
            # edad del precio en minutos: la app marca lo viejo
            "age_min": round((time.time() - (e.get("price_ts") or 0)) / 60),
            "stale": it["slug"] not in todo,
        })
    return rows


def save_parts(rows: list) -> None:
    """UPDATE puntual (no upsert de toda la fila): estas rows son un subset
    (top N sets), así que un INSERT con ON CONFLICT DO UPDATE pisaría a NULL
    el parts_profit ya calculado de los sets que esta vuelta no se
    re-procesaron. Cada set solo se toca si de verdad se recalculó."""
    rows = [r for r in rows if r.get("parts_profit") is not None]
    if not rows:
        return
    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany("""
            UPDATE market_items SET parts_total = %s, parts_profit = %s, parts_detail = %s
            WHERE slug = %s
        """, [(r["parts_total"], r["parts_profit"], r["parts_detail"], r["slug"]) for r in rows])


def parts_arbitrage(row, id_to_slug):
    """Suma del precio de las partes sueltas vs precio del set."""
    detail = item_detail(row["slug"])
    time.sleep(RATE)
    total, detail_txt = 0.0, []
    for pid in detail.get("setParts", []):
        pslug = id_to_slug.get(pid)
        if not pslug or pslug == row["slug"]:
            continue
        pdetail = item_detail(pslug)
        time.sleep(RATE)
        qty = pdetail.get("quantityInSet", 1) or 1
        _, psell = top_orders(pslug)
        time.sleep(RATE)
        if psell is None:
            return None, None
        total += psell * qty
        detail_txt.append(f'{qty}x {pslug.replace("_", " ").replace(" prime", "")}'
                          f' {psell}p')
    return total, "; ".join(detail_txt)


def main():
    # 20 por corrida (~7 requests c/u = ~140, a RATE=0.4s ≈ 1min extra) — entra
    # cómodo en el timeout de 600s del Job y se recalcula solo cada 10 min.
    # --parts N lo pisa para pruebas manuales; --parts 0 lo apaga del todo.
    n_parts = 20
    if "--parts" in sys.argv:
        idx = sys.argv.index("--parts")
        n_parts = int(sys.argv[idx + 1]) if len(sys.argv) > idx + 1 else 8

    rows = scan_sets(full="--full" in sys.argv)
    # el JSON guarda todo lo líquido (el sniper usa filas sin comprador in-game);
    # el ranking de abajo solo cuenta flips con comprador Y vendedor reales.
    # Orden por "score" (margen % × liquidez × log(spread)), no por spread
    # crudo — así un arcano caro con poco volumen no le gana a un set más
    # chico que en realidad se vende.
    good = sorted((r for r in rows if r["vol48"] >= MIN_VOL48),
                  key=lambda r: r["score"],
                  reverse=True)
    two_sided = [r for r in good if r["buy"] > 0 and r["spread"] >= MIN_SPREAD]

    print("=" * 100)
    print("FLIPS DE SETS PRIME — postear compra 1p arriba de 'Compra', revender 1p abajo de 'Venta'")
    print(f"(filtro: spread ≥ {MIN_SPREAD}p y ≥ {MIN_VOL48} ventas/48h; orden: score = spread^{SPREAD_WEIGHT} × confianza(liquidez)^{LIQUIDITY_WEIGHT} × confianza(margen))")
    print("=" * 100)
    print(f'{"Item":<27}{"Tipo":<7}{"Compra":>8}{"Venta":>8}{"Spread":>8}{"Margen":>8}{"Vtas48h":>9}{"Score":>8}')
    print("-" * 100)
    for r in two_sided[:25]:
        print(f'{r["name"][:26]:<27}{r["kind"]:<7}{r["buy"]:>7.0f}p{r["sell"]:>7.0f}p{r["spread"]:>7.0f}p'
              f'{r["margin"]:>7.0f}%{r["vol48"]:>9}{r["score"]:>8.1f}')

    parts_rows = [x for x in two_sided if x["kind"] == "set"][:n_parts]
    if parts_rows:
        print(f"\nArbitraje partes→set para los top {n_parts} (comprar partes, vender set):")
        id_to_slug = {it["id"]: it["slug"] for it in market_items()}
        for r in parts_rows:
            total, txt = parts_arbitrage(r, id_to_slug)
            if total is None:
                continue
            r["parts_total"] = round(total, 1)
            r["parts_profit"] = round(r["sell"] - total, 1)
            r["parts_detail"] = txt
            mark = " ★" if r["parts_profit"] > r["spread"] else ""
            print(f'  {r["name"]:<28} partes {total:>5.0f}p → set {r["sell"]:.0f}p '
                  f'= {r["parts_profit"]:+.0f}p{mark}   [{txt}]')
        save_parts(parts_rows)

    refresh_hourly_activity()
    print(f"\n{len(good)} oportunidades guardadas en market_items (Postgres/Neon)")


if __name__ == "__main__":
    main()
