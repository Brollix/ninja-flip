"""Scanner de flips: oportunidades de comprar barato / vender caro en warframe.market.

Barre todos los sets Prime (los items más líquidos del juego) y calcula:
 - mejor orden de COMPRA activa (a lo que podés comprar rápido posteando 1p arriba)
 - venta más barata activa (a lo que podés revender 1p abajo)
 - spread = tu ganancia bruta por flip
 - volumen de ventas 48h (liquidez: cuán rápido rota)
 - arbitraje partes→set para los mejores (comprar partes sueltas, vender el set)

Uso:
    python flips.py              -> top flips (sets con spread y liquidez)
    python flips.py --parts N    -> además analiza partes→set para los top N (lento)
"""

import json
import sys
import time
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "cache"
RATE = 0.4
MIN_SPREAD = 4      # plat mínimo de ganancia bruta para listar
MIN_VOL48 = 10      # ventas mínimas en 48h (liquidez)

session = requests.Session()
session.headers["User-Agent"] = "flip-scanner/1.0"


def market_items():
    data = json.loads((CACHE_DIR / "market_items.json").read_text(encoding="utf-8"))
    return data["data"]


def top_orders(slug: str):
    """(mejor compra, mejor venta) de usuarios conectados."""
    r = session.get(f"https://api.warframe.market/v2/orders/item/{slug}/top",
                    timeout=20)
    if r.status_code != 200:
        return None, None
    d = r.json()["data"]
    unit = lambda o: o["platinum"] / max(o.get("perTrade") or 1, 1)
    buys = [unit(o) for o in d.get("buy", [])
            if o.get("user", {}).get("status") == "ingame"]
    sells = [unit(o) for o in d.get("sell", [])
             if o.get("user", {}).get("status") == "ingame"]
    return (max(buys) if buys else None), (min(sells) if sells else None)


def stats48(slug: str):
    r = session.get(f"https://api.warframe.market/v1/items/{slug}/statistics",
                    timeout=20)
    if r.status_code != 200:
        return 0, 0.0
    hours = r.json().get("payload", {}).get("statistics_closed", {}).get("48hours", [])
    vol = sum(h.get("volume", 0) for h in hours)
    med = (sum(h.get("median", 0) * h.get("volume", 0) for h in hours) / vol
           if vol else 0.0)
    return vol, round(med, 1)


def item_detail(slug: str) -> dict:
    r = session.get(f"https://api.warframe.market/v2/item/{slug}", timeout=20)
    return r.json()["data"] if r.status_code == 200 else {}


def scan_sets():
    sets = [it for it in market_items() if it["slug"].endswith("_prime_set")]
    print(f"Escaneando {len(sets)} sets Prime (~{len(sets) * RATE * 2 / 60:.0f} min)...\n")
    rows = []
    for i, it in enumerate(sets, 1):
        slug = it["slug"]
        buy, sell = top_orders(slug)
        time.sleep(RATE)
        vol, med = stats48(slug)
        time.sleep(RATE)
        if buy and sell and sell > buy:
            rows.append({
                "name": it["i18n"]["en"]["name"], "slug": slug,
                "buy": buy, "sell": sell, "spread": sell - buy,
                "margin": (sell - buy) / sell * 100, "vol48": vol, "med48": med,
            })
        if i % 25 == 0:
            print(f"  {i}/{len(sets)}...")
    return rows


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
    n_parts = 0
    if "--parts" in sys.argv:
        idx = sys.argv.index("--parts")
        n_parts = int(sys.argv[idx + 1]) if len(sys.argv) > idx + 1 else 8

    rows = scan_sets()
    good = sorted((r for r in rows
                   if r["spread"] >= MIN_SPREAD and r["vol48"] >= MIN_VOL48),
                  key=lambda r: r["spread"] * min(r["vol48"], 60),
                  reverse=True)

    print("=" * 92)
    print("FLIPS DE SETS PRIME — postear compra 1p arriba de 'Compra', revender 1p abajo de 'Venta'")
    print(f"(filtro: spread ≥ {MIN_SPREAD}p y ≥ {MIN_VOL48} ventas/48h; orden: spread × liquidez)")
    print("=" * 92)
    print(f'{"Set":<28}{"Compra":>8}{"Venta":>8}{"Spread":>8}{"Margen":>8}{"Vtas48h":>9}{"Med48h":>8}')
    print("-" * 92)
    for r in good[:20]:
        print(f'{r["name"]:<28}{r["buy"]:>7.0f}p{r["sell"]:>7.0f}p{r["spread"]:>7.0f}p'
              f'{r["margin"]:>7.0f}%{r["vol48"]:>9}{r["med48"]:>7.0f}p')

    if n_parts and good:
        print(f"\nArbitraje partes→set para los top {n_parts} (comprar partes, vender set):")
        id_to_slug = {it["id"]: it["slug"] for it in market_items()}
        for r in good[:n_parts]:
            total, txt = parts_arbitrage(r, id_to_slug)
            if total is None:
                continue
            r["parts_total"] = round(total, 1)
            r["parts_profit"] = round(r["sell"] - total, 1)
            r["parts_detail"] = txt
            mark = " ★" if r["parts_profit"] > r["spread"] else ""
            print(f'  {r["name"]:<28} partes {total:>5.0f}p → set {r["sell"]:.0f}p '
                  f'= {r["parts_profit"]:+.0f}p{mark}   [{txt}]')

    payload = json.dumps({"ts": time.time(), "flips": good}, indent=1,
                         ensure_ascii=False)
    (CACHE_DIR / "flips.json").write_text(payload, encoding="utf-8")
    dash = ROOT / "app" / "public" / "data"
    if dash.exists():
        (dash / "flips.json").write_text(payload, encoding="utf-8")
    print(f"\n{len(good)} oportunidades guardadas en cache/flips.json")


if __name__ == "__main__":
    main()
