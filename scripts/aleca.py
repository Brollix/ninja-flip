"""Cliente simple para la API de stats de AlecaFrame.

Uso:
    python aleca.py            -> resumen de la cuenta
    python aleca.py trades     -> últimos trades
    python aleca.py raw       -> JSON completo por stdout
"""

import json
import os
import sys

import requests
from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = "https://stats.alecaframe.com/api"
PLAT_ITEM = "/AF_Special/Platinum"

from pathlib import Path
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
PUBLIC_TOKEN = os.getenv("ALECA_PUBLIC_TOKEN")


def get_stats() -> dict:
    if not PUBLIC_TOKEN:
        sys.exit("Falta ALECA_PUBLIC_TOKEN en el .env")
    resp = requests.get(
        f"{BASE_URL}/stats/public",
        params={"token": PUBLIC_TOKEN},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def item_label(item: dict) -> str:
    if item.get("name") == PLAT_ITEM:
        return f"{item.get('cnt', 0)}p"
    name = item.get("displayName") or (item.get("name") or "?").split("/")[-1]
    cnt = item.get("cnt", 1)
    return f"{cnt}x {name}" if cnt > 1 else name


def plat_amount(items: list) -> int:
    return sum(i.get("cnt", 0) for i in items or [] if i.get("name") == PLAT_ITEM)


def print_summary(data: dict) -> None:
    points = data.get("generalDataPoints") or []
    trades = data.get("trades") or []
    name = data.get("usernameWhenPublic") or "(sin nombre)"

    print(f"Cuenta: {name}")
    print(f"Última actualización: {data.get('lastUpdate')}")
    print(f"Snapshots históricos: {len(points)}")
    print(f"Trades registrados: {len(trades)}")

    if points:
        last = points[-1]
        print("\nÚltimo snapshot:")
        print(f"  Fecha:       {last.get('ts')}")
        print(f"  MR:          {last.get('mr')}")
        print(f"  Platino:     {last.get('plat')}")
        print(f"  Créditos:    {last.get('credits'):,}")
        print(f"  Endo:        {last.get('endo'):,}")
        print(f"  Ducados:     {last.get('ducats')}")
        print(f"  Aya:         {last.get('aya')}")
        print(f"  Completado:  {last.get('percentageCompletion')}%")

    if trades:
        plat_in = sum(plat_amount(t.get("rx")) for t in trades)
        plat_out = sum(plat_amount(t.get("tx")) for t in trades)
        print(f"\nPlatino recibido en trades: {plat_in:,}")
        print(f"Platino gastado en trades:  {plat_out:,}")
        print(f"Balance:                    {plat_in - plat_out:+,}")


def print_trades(data: dict, n: int = 20) -> None:
    trades = data.get("trades") or []
    if not trades:
        print("No hay trades en el token público (fijate que 'trades' esté habilitado al crear el link).")
        return
    print(f"Últimos {min(n, len(trades))} de {len(trades)} trades:\n")
    for t in trades[-n:]:
        ts = (t.get("ts") or "")[:16].replace("T", " ")
        gave = ", ".join(item_label(i) for i in t.get("tx") or []) or "-"
        got = ", ".join(item_label(i) for i in t.get("rx") or []) or "-"
        print(f"[{ts}] con {t.get('user')}: di {gave}  |  recibí {got}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "summary"
    stats = get_stats()
    if cmd == "raw":
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    elif cmd == "trades":
        print_trades(stats)
    else:
        print_summary(stats)
