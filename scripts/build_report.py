"""Genera report.html (dashboard) desde cache/report.json.

Uso:
    python build_report.py
    # o regenerar todo con precios frescos:
    python relic_analysis.py --refresh && python build_report.py
"""

import json
import math
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent.parent
report = json.loads((HERE / "cache" / "report.json").read_text(encoding="utf-8"))
rows = report["relics"]
sales = report.get("sales", [])
username = report.get("username") or "?"

flips_path = HERE / "cache" / "flips.json"
flips, flips_age = [], ""
if flips_path.exists():
    fdata = json.loads(flips_path.read_text(encoding="utf-8"))
    flips = fdata["flips"] if isinstance(fdata, dict) else fdata
    ts = fdata.get("ts") if isinstance(fdata, dict) else None
    if ts:
        flips_age = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")

# Consolidar duplicados (misma reliquia con distinto refinamiento en inventario)
merged = {}
for r in rows:
    m = merged.get(r["relic"])
    if not m:
        m = {**r, "count": 0, "refined_count": 0}
        merged[r["relic"]] = m
    m["count"] += r["count"]
    if r["refinement"] != "Intact":
        m["refined_count"] += r["count"]
relics = list(merged.values())

def n_for_95(p: float) -> int:
    """Aperturas para tener 95% de chance de al menos un drop."""
    return math.ceil(math.log(0.05) / math.log(1 - p))


for r in relics:
    r["gain"] = r["ev_radiant"] - r["ev_intact"]
    # Si la reliquia entera se vende por más de lo que rinde abierta radiante,
    # conviene venderla tal cual (típico en vaulteadas).
    if r.get("relic_price", 0) >= 10 and r["relic_price"] > r["ev_radiant"]:
        r["bucket"] = "sell"
    elif r["gain"] >= 2.5 and r["jackpot_price"] >= 25:
        r["bucket"] = "radiant"
    elif r["ev_intact"] >= 4:
        r["bucket"] = "intact"
    else:
        r["bucket"] = "junk"

    # --- caza del item más caro: probabilidades según tu stock ---
    jp = next((d for d in r["drops"] if d["item"] == r["jackpot"]), None)
    n = r["count"]
    if jp and r["jackpot_price"] > 0 and 0 < jp["chance_intact"] < 100:
        p_i = jp["chance_intact"] / 100
        p_r = jp["chance_radiant"] / 100
        p_rs = 1 - (1 - p_r) ** 4        # radshare: 4 tiradas por apertura
        r["hunt"] = {
            "p_int": p_i, "p_rad": p_r, "p_radshare": p_rs,
            "hit_int": 1 - (1 - p_i) ** n,
            "hit_radshare": 1 - (1 - p_rs) ** n,
            "n95_int": n_for_95(p_i),
            "n95_radshare": n_for_95(p_rs),
            # plat esperado de la cacería con tu stock (al menos una copia)
            "score_int": r["jackpot_price"] * (1 - (1 - p_i) ** n),
            "score_rad": r["jackpot_price"] * (1 - (1 - p_rs) ** n),
        }
        h = r["hunt"]
        if p_i >= 0.20:
            h["verdict"] = "Intacta ✓"
            h["vclass"] = "intact"
        elif n >= h["n95_radshare"]:
            h["verdict"] = "Radshare ✓"
            h["vclass"] = "radiant"
        else:
            h["verdict"] = f'Radshare, faltan ~{h["n95_radshare"] - n}'
            h["vclass"] = "short"
    else:
        r["hunt"] = None

data = {
    "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
    "total_relics": sum(r["count"] for r in relics),
    "total_types": len(relics),
    "ev_total_intact": sum(r["ev_intact"] * r["count"] for r in relics),
    "ev_total_radiant": sum(r["ev_radiant"] * r["count"] for r in relics),
    "vaulted_types": sum(1 for r in relics if r.get("vaulted")),
    "ducats_total": sum(r.get("ev_ducats", 0) * r["count"] for r in relics),
    "relics": relics,
    "sales": sales[:25],
    "flips": flips,
    "flips_age": flips_age,
}

TEMPLATE = r"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reliquias — análisis de platino</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #008300; --s7: #4a3aa7; --s8: #e34948; --good: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #008300; --s7: #9085e9; --s8: #e66767; --good: #0ca30c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--ink-2); margin-bottom: 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; margin-bottom: 24px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile .v { font-size: 26px; font-weight: 650; }
.tile .l { color: var(--ink-2); font-size: 12.5px; margin-top: 2px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 24px; }
.card h2 { font-size: 15px; margin: 0 0 4px; }
.card .hint { color: var(--ink-2); font-size: 12.5px; margin: 0 0 12px; }
.legend { display: flex; gap: 16px; font-size: 12.5px; color: var(--ink-2); margin-bottom: 10px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
.legend .li::before { background: var(--s1); }
.legend .lr::before { background: var(--s2); }
.controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.controls input, .controls select {
  background: var(--surface); color: var(--ink); border: 1px solid var(--axis);
  border-radius: 8px; padding: 7px 10px; font: inherit;
}
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--axis); cursor: pointer; user-select: none; white-space: nowrap; }
th.num, td.num { text-align: right; }
td { padding: 7px 8px; border-bottom: 1px solid var(--grid); }
tr.main { cursor: pointer; }
tr.main:hover td { background: color-mix(in srgb, var(--ink) 4%, transparent); }
.tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--ink-2); }
.tag.radiant { border-color: var(--s2); color: var(--s2); font-weight: 600; }
.tag.intact { border-color: var(--s1); color: var(--s1); font-weight: 600; }
.tag { white-space: nowrap; }
.tag.short { border-color: var(--muted); color: var(--ink-2); }
.tag.sell { border-color: var(--s7); color: var(--s7); font-weight: 600; }
.tag.vaulted { border-color: var(--s8); color: var(--s8); padding: 0 6px; }
.lowvol { color: var(--muted); }
.loss { color: var(--s8); font-weight: 600; }
.wrap-cell { white-space: normal; min-width: 180px; }
.detail-info { margin-bottom: 8px; font-size: 12.5px; color: var(--ink-2); }
html { scroll-behavior: smooth; }
.card, h2.sec { scroll-margin-top: 64px; }
.nav {
  position: sticky; top: 0; z-index: 5; display: flex; gap: 4px; flex-wrap: wrap;
  background: color-mix(in srgb, var(--page) 88%, transparent);
  backdrop-filter: blur(6px); padding: 10px 0; margin: 0 0 16px;
  border-bottom: 1px solid var(--grid);
}
.nav a {
  color: var(--ink-2); text-decoration: none; font-size: 13px;
  padding: 5px 12px; border-radius: 999px; border: 1px solid transparent;
}
.nav a:hover { color: var(--ink); border-color: var(--axis); background: var(--surface); }
.btn {
  display: inline-block; font-size: 11.5px; padding: 3px 9px; border-radius: 7px;
  border: 1px solid var(--axis); background: transparent; color: var(--ink-2);
  cursor: pointer; text-decoration: none; font-family: inherit; line-height: 1.4;
  white-space: nowrap;
}
.btn:hover { color: var(--ink); border-color: var(--ink-2); background: color-mix(in srgb, var(--ink) 5%, transparent); }
.btn.ok { color: var(--good); border-color: var(--good); }
.chk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-2); }
.parts-pos { color: var(--good); font-weight: 600; }
td .item-link { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); }
td .item-link:hover { color: var(--s1); border-color: var(--s1); }
h2.sec { font-size: 16px; margin: 0 0 4px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 950px) { .two-col { grid-template-columns: 1fr; } }
.hunt td, .hunt th { white-space: nowrap; }
.need { color: var(--muted); font-size: 11px; }
.hunt th.sorted { color: var(--ink); }
.scroll-x { overflow-x: auto; }
.gain-pos { color: var(--good); font-weight: 600; }
.detail td { background: color-mix(in srgb, var(--ink) 3%, transparent); padding: 10px 8px 12px; }
.detail table { font-size: 12.5px; }
.detail th { cursor: default; }
.rare { font-weight: 600; }
.bar-row { display: grid; grid-template-columns: 90px 1fr; gap: 10px; align-items: center; margin: 3px 0; }
.bar-label { font-size: 12.5px; color: var(--ink-2); text-align: right; white-space: nowrap; }
.bar-track { position: relative; height: 30px; }
.bar { position: absolute; left: 0; height: 12px; border-radius: 0 4px 4px 0; }
.bar.i { top: 2px; background: var(--s1); }
.bar.r { top: 16px; background: var(--s2); }
.bar-val { position: absolute; font-size: 11px; color: var(--ink-2); transform: translateY(-1px); }
#tooltip {
  position: fixed; pointer-events: none; z-index: 10; display: none;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; font-size: 12.5px; box-shadow: 0 4px 14px rgba(0,0,0,.18); max-width: 280px;
}
.foot { color: var(--muted); font-size: 12px; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Análisis de reliquias — farmeo de platino</h1>
  <div class="sub">Cuenta __USERNAME__ · datos AlecaFrame + warframe.market + WFCD · generado __GENERATED__</div>

  <nav class="nav">
    <a href="#trading">💱 Flips</a>
    <a href="#caceria">🎯 Cacería</a>
    <a href="#ev">📊 EV reliquias</a>
    <a href="#baro">🪙 Ducados</a>
    <a href="#ventas">🧾 Tus ventas</a>
    <a href="#todas">📦 Todas</a>
  </nav>

  <div class="tiles">
    <div class="tile"><div class="v">__TOTAL_RELICS__</div><div class="l">reliquias (__TOTAL_TYPES__ tipos)</div></div>
    <div class="tile"><div class="v">~__EV_INT__p</div><div class="l">valor esperado abriendo todo intacto</div></div>
    <div class="tile"><div class="v">~__EV_RAD__p</div><div class="l">valor esperado si todo fuera radiante</div></div>
    <div class="tile"><div class="v" id="tile-rad-count">–</div><div class="l">reliquias que conviene refinar</div></div>
    <div class="tile"><div class="v">__VAULTED__</div><div class="l">tipos vaulteados (ya no dropean)</div></div>
    <div class="tile"><div class="v">~__DUCATS__</div><div class="l">ducados esperados abriendo todo</div></div>
  </div>

  <div class="card" id="trading">
    <h2>💱 Flips del día — sets Prime</h2>
    <p class="hint">Comprá barato, vendé caro: <b>Spread</b> = postear orden de compra 1p arriba de "Compra" y revender 1p abajo de "Venta" (más margen, requiere esperar el fill). <b>Partes→set</b> = comprar las piezas sueltas ya listadas y vender el set armado (ganancia inmediata). Escaneado: __FLIPS_AGE__ — refrescá con <code>python flips.py --parts 12 && python build_report.py</code>.</p>
    <div class="controls">
      <input id="fq" type="search" placeholder="Buscar set...">
      <label class="chk"><input type="checkbox" id="fliq" checked> solo líquidos (≥30 ventas/48h)</label>
    </div>
    <div class="scroll-x">
    <table class="hunt" id="flips">
      <thead><tr>
        <th data-k="name">Set</th>
        <th data-k="buy" class="num">Compra</th>
        <th data-k="sell" class="num">Venta</th>
        <th data-k="spread" class="num">Spread ▾</th>
        <th data-k="margin" class="num">Margen</th>
        <th data-k="vol48" class="num">Ventas 48h</th>
        <th data-k="med48" class="num">Med 48h</th>
        <th data-k="parts_profit" class="num" title="Comprar partes sueltas y vender el set">Partes→set</th>
        <th>Acciones</th>
      </tr></thead>
      <tbody></tbody>
    </table>
    </div>
  </div>

  <div class="card" id="ev">
    <h2>📊 Top 15 por valor esperado radiante</h2>
    <p class="hint">EV = suma de (chance × precio de venta) por apertura. Refinar cuesta 25 void traces.</p>
    <div class="legend"><span class="li">EV intacta</span><span class="lr">EV radiante</span></div>
    <div id="chart"></div>
  </div>

  <h2 class="sec" id="caceria">🎯 Cacería del item más caro — según tu stock</h2>
  <p class="sub" style="margin-bottom:12px">Nada garantiza que la rara salga a la primera: probabilidad real de sacar el item más caro de cada reliquia <b>con la cantidad que tenés</b>. "Plat esp." = precio × P(sacarla); cada tabla ya está ordenada por eso — agarrá lo de arriba. Para ~asegurar (95%) una rara: ~149 aperturas intactas u ~8 en radshare (allí cada apertura son 4 tiradas).</p>
  <div class="two-col">
    <div class="card">
      <h2>Si abrís INTACTAS (sin gastar traces)</h2>
      <div class="scroll-x">
      <table class="hunt" id="hunt-int">
        <thead><tr>
          <th data-k="relic">Reliquia</th>
          <th data-k="count" class="num">Tenés</th>
          <th data-k="jackpot">Item más caro</th>
          <th data-k="jackpot_price" class="num">Precio</th>
          <th data-k="vol48" class="num" title="Unidades vendidas en warframe.market en las últimas 48 h">Ventas 48h</th>
          <th data-k="hit_int" class="num">P(sacarla)</th>
          <th data-k="score_int" class="num">Plat esp. ▾</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      </div>
    </div>
    <div class="card">
      <h2>Si hacés RADSHARES (radiantes de a 4)</h2>
      <div class="scroll-x">
      <table class="hunt" id="hunt-rad">
        <thead><tr>
          <th data-k="relic">Reliquia</th>
          <th data-k="count" class="num">Tenés</th>
          <th data-k="jackpot">Item más caro</th>
          <th data-k="jackpot_price" class="num">Precio</th>
          <th data-k="vol48" class="num" title="Unidades vendidas en warframe.market en las últimas 48 h">Ventas 48h</th>
          <th data-k="hit_radshare" class="num">P(sacarla)</th>
          <th data-k="score_rad" class="num">Plat esp. ▾</th>
          <th data-k="missing" class="num">Faltan p/ 95%</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      </div>
    </div>
  </div>

  <div class="two-col">
    <div class="card" id="baro">
      <h2>🪙 Ducados para Baro</h2>
      <p class="hint">Cuando el objetivo es Baro y no plat: ducados esperados por apertura intacta. Las de recomendación "Ducados" son las que no valen plat — abrilas para esto.</p>
      <div class="scroll-x">
      <table class="hunt" id="ducats">
        <thead><tr>
          <th data-k="relic">Reliquia</th>
          <th data-k="count" class="num">Tenés</th>
          <th data-k="ev_ducats" class="num">Duc / apertura ▾</th>
          <th data-k="ducats_total" class="num">Duc esp. total</th>
          <th data-k="bucket">Recom.</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      </div>
    </div>
    <div class="card" id="ventas">
      <h2>🧾 Tus ventas vs mercado actual</h2>
      <p class="hint">Últimas ventas por plat de tu historial de trades, comparadas contra el precio de venta <b>de hoy</b> (no el del día del trade). Rojo = hoy se vende por bastante más de lo que cobraste.</p>
      <div class="scroll-x">
      <table class="hunt" id="sales">
        <thead><tr>
          <th>Fecha</th><th>Vendiste</th>
          <th class="num">Cobraste</th><th class="num">Hoy vale</th><th class="num">Dif.</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      </div>
    </div>
  </div>

  <div class="card" id="todas">
    <h2>📦 Todas tus reliquias</h2>
    <p class="hint">Click en una fila para ver los drops con precios, liquidez y dónde farmear la reliquia. Recomendación: <b>Radiante</b> = refinala y abrila en radshare · <b>Intacta</b> = abrila sin gastar traces · <b>Vender entera</b> = la reliquia vale más cerrada que abierta · <b>Ducados</b> = relleno para Baro.</p>
    <div class="controls">
      <input id="q" type="search" placeholder="Buscar reliquia o item...">
      <select id="ftier"><option value="">Todas las eras</option><option>Lith</option><option>Meso</option><option>Neo</option><option>Axi</option></select>
      <select id="fbucket"><option value="">Todas las recomendaciones</option><option value="radiant">Refinar a radiante</option><option value="intact">Abrir intacta</option><option value="sell">Vender entera</option><option value="junk">Ducados / relleno</option></select>
      <select id="fvault"><option value="">Vaulted y activas</option><option value="1">Solo vaulteadas</option><option value="0">Solo activas</option></select>
    </div>
    <table id="tbl">
      <thead><tr>
        <th data-k="relic">Reliquia</th>
        <th data-k="count" class="num">Tenés</th>
        <th data-k="ev_intact" class="num">EV intacta</th>
        <th data-k="ev_radiant" class="num">EV radiante</th>
        <th data-k="gain" class="num">Ganancia refinar</th>
        <th data-k="jackpot_price" class="num">Rara (precio)</th>
        <th data-k="bucket">Recomendación</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="foot">
    Los drop chance boosters no afectan reliquias. Chances rara: 2% intacta → 10% radiante (34.4% de que salga en un radshare de 4).
    Precios = promedio de las 3 sell orders más baratas (usuarios conectados). Regenerá con
    <code>python relic_analysis.py --refresh && python build_report.py</code>.
  </div>
</div>
<div id="tooltip"></div>
<script src="report_data.js?v=__STAMP__"></script>
</body>
</html>
"""

APP_JS = r"""(() => {
// IIFE: sin declaraciones globales — `const top` a nivel global choca con window.top
const relics = DATA.relics;
const fmtP = n => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);
const BUCKET = { radiant: ["Radiante", "radiant"], intact: ["Intacta", "intact"],
                 sell: ["Vender entera", "sell"], junk: ["Ducados", ""] };
const vaultTag = r => r.vaulted
  ? ' <span class="tag vaulted" title="Vaulteada: ya no dropea en misiones">V</span>' : "";
const volCell = v => `<td class="num ${v < 5 ? "lowvol" : ""}" ${v < 5 ? 'title="Poca demanda: puede tardar en venderse"' : ""}>${v}${v < 5 ? " ⚠" : ""}</td>`;
const slugOf = name => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const mlink = (name, slug) =>
  `<a class="item-link" href="https://warframe.market/items/${slug || slugOf(name)}" target="_blank" title="Ver en warframe.market">${name}</a>`;

window.copyMsg = (btn, text) => {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "✓ copiado";
    btn.classList.add("ok");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 1400);
  });
};

document.getElementById("tile-rad-count").textContent =
  relics.filter(r => r.bucket === "radiant").reduce((a, r) => a + r.count, 0);

// ---- chart: top 15 por EV radiante, barras horizontales agrupadas ----
const topRelics = [...relics].sort((a, b) => b.ev_radiant - a.ev_radiant).slice(0, 15);
const maxEV = Math.max(...topRelics.map(r => r.ev_radiant));
const chart = document.getElementById("chart");
const tip = document.getElementById("tooltip");
for (const r of topRelics) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const wi = (r.ev_intact / maxEV * 100).toFixed(1), wr = (r.ev_radiant / maxEV * 100).toFixed(1);
  row.innerHTML = `<div class="bar-label">${r.relic} ×${r.count}</div>
    <div class="bar-track">
      <div class="bar i" style="width:${wi}%"></div>
      <div class="bar r" style="width:${wr}%"></div>
      <div class="bar-val" style="left:calc(${wr}% + 6px); top:14px">${fmtP(r.ev_radiant)}p</div>
    </div>`;
  row.addEventListener("mousemove", e => {
    tip.style.display = "block";
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 300) + "px";
    tip.style.top = (e.clientY + 14) + "px";
    tip.innerHTML = `<b>${r.relic}</b> (tenés ${r.count})<br>
      EV intacta ${fmtP(r.ev_intact)}p · radiante ${fmtP(r.ev_radiant)}p (+${fmtP(r.gain)})<br>
      Rara: ${r.jackpot} — ${fmtP(r.jackpot_price)}p`;
  });
  row.addEventListener("mouseleave", () => tip.style.display = "none");
  chart.appendChild(row);
}

// ---- cacería del item más caro: dos tablas (intactas / radshare) ----
const pct = x => (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";
const hunts = relics.filter(r => r.hunt && r.jackpot_price >= 10)
  .map(r => ({
    relic: r.relic, count: r.count, jackpot: r.jackpot,
    jackpot_price: r.jackpot_price, vol48: r.jackpot_vol48 || 0,
    vaulted: r.vaulted, farm: r.farm,
    hit_int: r.hunt.hit_int, score_int: r.hunt.score_int,
    hit_radshare: r.hunt.hit_radshare, score_rad: r.hunt.score_rad,
    n95_int: r.hunt.n95_int, n95_radshare: r.hunt.n95_radshare,
    missing: Math.max(0, r.hunt.n95_radshare - r.count),
  }));

function huntTable(tableId, data, defaultKey, rowHtml) {
  const table = document.getElementById(tableId);
  const tbody = table.querySelector("tbody");
  let key = defaultKey, dir = -1;
  const draw = () => {
    const list = [...data].sort((a, b) => {
      const va = a[key], vb = b[key];
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
    });
    table.querySelectorAll("th").forEach(th =>
      th.classList.toggle("sorted", th.dataset.k === key));
    tbody.innerHTML = "";
    for (const r of list.slice(0, 15)) {
      const tr = document.createElement("tr");
      tr.innerHTML = rowHtml(r);
      tbody.appendChild(tr);
    }
  };
  table.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (key === k) dir *= -1;
    else { key = k; dir = (k === "relic" || k === "jackpot" || k === "missing") ? 1 : -1; }
    draw();
  }));
  draw();
}

huntTable("hunt-int", hunts, "score_int", r => `
  <td>${r.relic}${vaultTag(r)}</td><td class="num">${r.count}</td>
  <td>${mlink(r.jackpot)}</td><td class="num">${fmtP(r.jackpot_price)}p</td>
  ${volCell(r.vol48)}
  <td class="num">${pct(r.hit_int)}</td>
  <td class="num"><b>${fmtP(r.score_int)}p</b></td>`);

huntTable("hunt-rad", hunts, "score_rad", r => `
  <td>${r.relic}${vaultTag(r)}</td><td class="num">${r.count}</td>
  <td>${mlink(r.jackpot)}</td><td class="num">${fmtP(r.jackpot_price)}p</td>
  ${volCell(r.vol48)}
  <td class="num">${pct(r.hit_radshare)}</td>
  <td class="num"><b>${fmtP(r.score_rad)}p</b></td>
  <td class="num">${r.missing === 0 ? "✓ tenés"
    : r.vaulted ? `~${r.missing} ⛔ vaulted`
    : `<span title="${(r.farm || "").replace(/"/g, "&quot;")}">~${r.missing} 🌱</span>`}</td>`);

// ---- flips del día ----
const fq = document.getElementById("fq"), fliq = document.getElementById("fliq");
let flipSortK = "spread", flipSortDir = -1;
const ftbody = document.querySelector("#flips tbody");

function renderFlips() {
  const term = fq.value.toLowerCase();
  let list = DATA.flips.filter(f =>
    (!term || f.name.toLowerCase().includes(term)) &&
    (!fliq.checked || f.vol48 >= 30));
  list.sort((a, b) => {
    const va = a[flipSortK] ?? -1, vb = b[flipSortK] ?? -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * flipSortDir;
  });
  document.querySelectorAll("#flips th[data-k]").forEach(th =>
    th.classList.toggle("sorted", th.dataset.k === flipSortK));
  ftbody.innerHTML = "";
  for (const f of list.slice(0, 30)) {
    const wtb = `WTB [${f.name}] ${Math.round(f.buy + 1)}p`;
    const wts = `WTS [${f.name}] ${Math.round(f.sell - 1)}p`;
    const parts = f.parts_profit != null
      ? `<span class="${f.parts_profit > 0 ? "parts-pos" : ""}" title="${(f.parts_detail || "").replace(/"/g, "&quot;")}">${f.parts_profit > 0 ? "+" : ""}${fmtP(f.parts_profit)}p</span>`
      : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${mlink(f.name, f.slug)}</td>
      <td class="num">${fmtP(f.buy)}p</td>
      <td class="num">${fmtP(f.sell)}p</td>
      <td class="num"><b>${fmtP(f.spread)}p</b></td>
      <td class="num">${f.margin.toFixed(0)}%</td>
      ${volCell(f.vol48)}
      <td class="num">${fmtP(f.med48)}p</td>
      <td class="num">${parts}</td>
      <td>
        <button class="btn" onclick="copyMsg(this, '${wtb.replace(/'/g, "\\'")}')">📋 WTB</button>
        <button class="btn" onclick="copyMsg(this, '${wts.replace(/'/g, "\\'")}')">📋 WTS</button>
        <a class="btn" href="https://warframe.market/items/${f.slug}" target="_blank">market ↗</a>
      </td>`;
    ftbody.appendChild(tr);
  }
  if (!list.length) ftbody.innerHTML = '<tr><td colspan="9" style="color:var(--muted)">Sin datos — corré <code>python flips.py --parts 12</code></td></tr>';
}
document.querySelectorAll("#flips th[data-k]").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (flipSortK === k) flipSortDir *= -1;
  else { flipSortK = k; flipSortDir = k === "name" ? 1 : -1; }
  renderFlips();
}));
[fq, fliq].forEach(el => el.addEventListener("input", renderFlips));
renderFlips();

// ---- ducados para Baro ----
const ducs = relics.filter(r => r.ev_ducats > 0).map(r => ({
  relic: r.relic, count: r.count, ev_ducats: r.ev_ducats,
  ducats_total: r.ev_ducats * r.count, bucket: r.bucket, vaulted: r.vaulted,
}));
huntTable("ducats", ducs, "ev_ducats", r => `
  <td>${r.relic}${vaultTag(r)}</td><td class="num">${r.count}</td>
  <td class="num"><b>${r.ev_ducats.toFixed(0)}</b></td>
  <td class="num">${Math.round(r.ducats_total).toLocaleString()}</td>
  <td><span class="tag ${BUCKET[r.bucket][1]}">${BUCKET[r.bucket][0]}</span></td>`);

// ---- tus ventas vs mercado ----
const stbody = document.querySelector("#sales tbody");
for (const s of DATA.sales) {
  const diff = s.plat - s.market_now;
  const cls = diff >= 0 ? "gain-pos" : "loss";
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${(s.ts || "").slice(0, 10)}</td>
    <td class="wrap-cell">${s.items}${s.partial ? " *" : ""}</td>
    <td class="num">${s.plat}p</td>
    <td class="num">${fmtP(s.market_now)}p</td>
    <td class="num ${cls}">${diff >= 0 ? "+" : ""}${fmtP(diff)}p</td>`;
  stbody.appendChild(tr);
}

// ---- tabla ----
let sortK = "ev_radiant", sortDir = -1;
const tbody = document.querySelector("#tbl tbody");
const q = document.getElementById("q"), ftier = document.getElementById("ftier"),
      fbucket = document.getElementById("fbucket"), fvault = document.getElementById("fvault");

function dropRows(r) {
  const rows = [...r.drops].sort((a, b) => b.price - a.price).map(d => `
    <tr class="${d.rarity === "Rare" ? "rare" : ""}">
      <td>${d.item}</td><td>${d.rarity}</td>
      <td class="num">${d.chance_intact}%</td><td class="num">${d.chance_radiant}%</td>
      <td class="num">${d.price ? fmtP(d.price) + "p" : "—"}</td>
      <td class="num">${d.med48 ? fmtP(d.med48) + "p" : "—"}</td>
      <td class="num">${d.vol48 || 0}</td>
      <td class="num">${d.ducats || "—"}</td>
    </tr>`).join("");
  const info = [];
  info.push(r.vaulted
    ? "⛔ <b>Vaulteada</b> — ya no dropea en misiones"
    : `🌱 Farmeo: ${r.farm || "?"} (${r.farm_chance ?? "?"}%)`);
  if (r.relic_price) info.push(`💰 La reliquia entera se lista a ~${fmtP(r.relic_price)}p — <a class="item-link" href="https://warframe.market/items/${slugOf(r.relic + " relic")}" target="_blank">ver compradores reales ↗</a>`);
  return `<div class="detail-info">${info.join(" &nbsp;·&nbsp; ")}</div>
    <table><thead><tr><th>Item</th><th>Rareza</th><th class="num">Intacta</th><th class="num">Radiante</th><th class="num">Precio</th><th class="num">Med 48h</th><th class="num">Ventas 48h</th><th class="num">Ducados</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function render() {
  const term = q.value.toLowerCase();
  let list = relics.filter(r =>
    (!ftier.value || r.tier === ftier.value) &&
    (!fbucket.value || r.bucket === fbucket.value) &&
    (fvault.value === "" || String(r.vaulted ? 1 : 0) === fvault.value) &&
    (!term || r.relic.toLowerCase().includes(term) ||
      r.drops.some(d => d.item.toLowerCase().includes(term))));
  list.sort((a, b) => {
    const va = a[sortK], vb = b[sortK];
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sortDir;
  });
  tbody.innerHTML = "";
  for (const r of list) {
    let [label, cls] = BUCKET[r.bucket];
    if (r.bucket === "sell") label += ` ${fmtP(r.relic_price)}p`;
    const tr = document.createElement("tr");
    tr.className = "main";
    tr.innerHTML = `<td>${r.relic}${vaultTag(r)}${r.refined_count ? ` <span class="tag">${r.refined_count} refinadas</span>` : ""}</td>
      <td class="num">${r.count}</td>
      <td class="num">${fmtP(r.ev_intact)}</td>
      <td class="num">${fmtP(r.ev_radiant)}</td>
      <td class="num ${r.gain >= 2.5 ? "gain-pos" : ""}">+${fmtP(r.gain)}</td>
      <td class="num">${fmtP(r.jackpot_price)}p</td>
      <td><span class="tag ${cls}">${label}</span></td>`;
    const detail = document.createElement("tr");
    detail.className = "detail";
    detail.style.display = "none";
    detail.innerHTML = `<td colspan="7"><div class="scroll-x">${dropRows(r)}</div></td>`;
    tr.addEventListener("click", () => {
      detail.style.display = detail.style.display === "none" ? "" : "none";
    });
    tbody.append(tr, detail);
  }
}
document.querySelectorAll("#tbl th").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (sortK === k) sortDir *= -1; else { sortK = k; sortDir = k === "relic" || k === "bucket" ? 1 : -1; }
  render();
}));
[q, ftier, fbucket, fvault].forEach(el => el.addEventListener("input", render));
render();
})();
"""

html = (TEMPLATE
        .replace("__STAMP__", datetime.now().strftime("%Y%m%d%H%M%S"))
        .replace("__GENERATED__", data["generated"])
        .replace("__USERNAME__", username)
        .replace("__TOTAL_RELICS__", f'{data["total_relics"]:,}')
        .replace("__TOTAL_TYPES__", str(data["total_types"]))
        .replace("__EV_INT__", f'{data["ev_total_intact"]:,.0f}')
        .replace("__EV_RAD__", f'{data["ev_total_radiant"]:,.0f}')
        .replace("__VAULTED__", str(data["vaulted_types"]))
        .replace("__DUCATS__", f'{data["ducats_total"]:,.0f}')
        .replace("__FLIPS_AGE__", flips_age or "todavía no corriste el scanner"))

out = HERE / "report.html"
out.write_text(html, encoding="utf-8")
(HERE / "report_data.js").write_text(
    "const DATA = " + json.dumps(data, ensure_ascii=False) + ";\n" + APP_JS,
    encoding="utf-8")
print(f"Dashboard generado: {out}")
