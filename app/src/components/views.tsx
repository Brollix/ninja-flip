import { useEffect, useMemo, useRef, useState } from "react";
import type { Flip, HistoryPoint, Relic, Sale } from "../types";
import { BUCKET_LABEL, fetchLiveOrders, fmtP, pct, slugOf } from "../lib";
import { CopyBtn, DataTable, MarketLink, Plat, PremiumLock, Tag, Tile, VolBadge } from "./ui";
import type { Col } from "./ui";
import { HistoryChart } from "./HistoryChart";
import { PeakTimeChart } from "./PeakTime";
import { openComposer } from "./Composer";
import { isPremium, onAuthChange } from "../wfm";
import {
  Ban, Copy, ExternalLink, Fish, Flame, HandCoins, RefreshCw, Sprout, Target, Zap,
} from "lucide-react";

const Vault = ({ r }: { r: { vaulted: boolean } }) =>
  r.vaulted ? <Tag kind="vaulted" title="Vaulted: no longer drops in missions">V</Tag> : null;

// deja margen fijo a la derecha del track para la etiqueta de valor (ver
// "Top by radiant expected value" más abajo) — si la barra más larga llega
// a 100% la etiqueta queda posicionada afuera del contenedor.
const BAR_MAX_PCT = 82;

// ---------- Resumen ----------

export function SummaryView({ relics, sales, history }: { relics: Relic[]; sales: Sale[]; history: HistoryPoint[] }) {
  const totRelics = relics.reduce((a, r) => a + r.count, 0);
  const evInt = relics.reduce((a, r) => a + r.ev_intact * r.count, 0);
  const evRad = relics.reduce((a, r) => a + r.ev_radiant * r.count, 0);
  const ducats = relics.reduce((a, r) => a + r.ev_ducats * r.count, 0);
  const toRefine = relics.filter(r => r.bucket === "radiant").reduce((a, r) => a + r.count, 0);
  const vaulted = relics.filter(r => r.vaulted).length;

  const top = [...relics].sort((a, b) => b.ev_radiant - a.ev_radiant).slice(0, 12);
  const maxEV = Math.max(...top.map(r => r.ev_radiant));

  return (
    <>
      <div className="tiles">
        <Tile value={totRelics.toLocaleString()} label={`relics (${relics.length} types)`} />
        <Tile value={<>~<Plat value={evInt} /></>} label="expected value, all intact" />
        <Tile value={<>~<Plat value={evRad} /></>} label="expected value, all radiant" />
        <Tile value={toRefine} label="relics worth refining" />
        <Tile value={vaulted} label="vaulted types" />
        <Tile value={`~${Math.round(ducats).toLocaleString()}`} label="expected ducats" />
      </div>
      <HistoryChart history={history} />
      <div className="card">
        <h2>Top by radiant expected value</h2>
        <p className="hint">EV = drop chance × price, summed per crack. Refining costs 25 void traces.</p>
        <div className="legend"><span className="li">Intact EV</span><span className="lr">Radiant EV</span></div>
        {top.map(r => (
          <div className="bar-row" key={r.relic}
               title={`${r.relic}: intact ${fmtP(r.ev_intact)}p · radiant ${fmtP(r.ev_radiant)}p — rare: ${r.jackpot} (${fmtP(r.jackpot_price)}p)`}>
            <div className="bar-label">{r.relic} ×{r.count}</div>
            <div className="bar-track">
              {/* la barra más larga llega solo a BAR_MAX_PCT, no a 100% — deja
                  margen fijo a la derecha para la etiqueta de valor, que si no
                  queda posicionada afuera del contenedor (calc(100% + 6px))
                  y se corta contra el borde de la tarjeta. */}
              <div className="bar i" style={{ width: `${(r.ev_intact / maxEV) * BAR_MAX_PCT}%` }} />
              <div className="bar r" style={{ width: `${(r.ev_radiant / maxEV) * BAR_MAX_PCT}%` }} />
              <span className="bar-val" style={{ left: `calc(${(r.ev_radiant / maxEV) * BAR_MAX_PCT}% + 6px)` }}>
                <Plat value={r.ev_radiant} />
              </span>
            </div>
          </div>
        ))}
      </div>
      <QuickSales sales={sales} />
    </>
  );
}

function QuickSales({ sales }: { sales: Sale[] }) {
  const recent = sales.slice(0, 5);
  if (!recent.length) return null;
  return (
    <div className="card">
      <h2>Recent sales</h2>
      <table>
        <tbody>
          {recent.map((s, i) => {
            const diff = s.plat - s.market_now;
            return (
              <tr key={i}>
                <td className="muted">{s.ts?.slice(0, 10)}</td>
                <td>{s.items}</td>
                <td className="num"><Plat value={s.plat} /></td>
                <td className={`num ${diff >= 0 ? "gain-pos" : "loss"}`}>
                  <Plat value={diff} sign /> vs today
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Flips ----------

/** Unidades por ventana de trade: los rankeados (arcanos/primed maxeados) y los
 *  sets se mueven de a 1; solo los items sueltos de rango 0 valen en lote. */
export const bulkQty = (f: { spread: number; rank?: number; kind?: string }): number => {
  if ((f.rank ?? 0) > 0 || f.kind === "set" || f.spread <= 0) return 1;
  return Math.min(6, Math.max(1, Math.ceil(15 / f.spread)));
};
/** Ganancia por par de trades (compra + venta). */
export const perTradeProfit = (f: { spread: number; rank?: number; kind?: string }): number =>
  f.spread * bulkQty(f);

/** slug -> ordenes activas mias, desde el cache de My Orders */
function myOrdersBySlug(): Record<string, { buy?: boolean; sell?: boolean }> {
  try {
    const raw = JSON.parse(localStorage.getItem("orders_cache_v2") ?? "null") as
      { orders?: { slug: string; type: "buy" | "sell" }[] } | null;
    const map: Record<string, { buy?: boolean; sell?: boolean }> = {};
    for (const o of raw?.orders ?? []) {
      (map[o.slug] ??= {})[o.type] = true;
    }
    return map;
  } catch { return {}; }
}

export function FlipsView({ flips: flipsProp, flipsTs, startPlat, preview }: {
  flips: Flip[]; flipsTs: number | null; startPlat: number;
  /** Vista pública sin cuenta conectada (landing): sin botones de postear
   *  órdenes (necesitan login para hacer algo) y sin Suggested Positions
   *  (premium, no tiene sentido venderlo antes de mostrar el resto). */
  preview?: boolean;
}) {
  const [term, setTerm] = useState("");
  const [liquidOnly, setLiquidOnly] = useState(true);
  const [kind, setKind] = useState<"" | "set" | "arcane" | "mod">("");
  const [minSpread, setMinSpread] = useState(15);
  const [flips, setFlips] = useState(flipsProp);
  const [live, setLive] = useState<"idle" | "running" | "done">("idle");
  const [liveProgress, setLiveProgress] = useState("");
  const [lastLive, setLastLive] = useState<Date | null>(null);
  const [mine, setMine] = useState(myOrdersBySlug);
  const [, forcePremium] = useState(0);
  useEffect(() => onAuthChange(() => forcePremium(x => x + 1)), []);

  // marcar al instante cuando publicas desde el composer, y re-leer el cache
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ slug?: string; type?: "buy" | "sell" }>).detail;
      if (d?.slug && d.type) {
        const { slug, type } = d;
        setMine(prev => ({ ...prev, [slug]: { ...prev[slug], [type]: true } }));
      } else {
        setMine(myOrdersBySlug());
      }
    };
    window.addEventListener("orders:changed", onChanged);
    return () => window.removeEventListener("orders:changed", onChanged);
  }, []);

  const rows = useMemo(() => flips.filter(f =>
    // sin las dos puntas reales no hay flip: eso es trabajo del sniper
    f.buy > 0 && f.sell > 0 &&
    (!term || f.name.toLowerCase().includes(term.toLowerCase())) &&
    (!liquidOnly || f.vol48 >= 30) &&
    perTradeProfit(f) >= minSpread &&
    (!kind || (f.kind ?? "set") === kind)), [flips, term, liquidOnly, kind, minSpread]);

  // qué sets ya tienen precio en vivo (para no re-pedirlos al cambiar filtros)
  const refreshedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  // el intervalo lee esto en vez de `rows` directo: así siempre usa los
  // filtros vigentes al momento del tick, no los de cuando arrancó el timer
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  async function refreshLive(force = false) {
    if (busyRef.current) return; // ya hay una corrida en curso
    // top 25 por score, no por spread crudo — así el refresco en vivo
    // mantiene fresco lo que de verdad conviene flipear, no lo que da la
    // casualidad de tener el spread más grande (que puede ser ilíquido)
    const targets = [...rowsRef.current]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .filter(f => force || !refreshedRef.current.has(f.slug))
      .slice(0, 25);
    if (!targets.length) { setLive("done"); return; }
    busyRef.current = true;
    setLive("running");
    try {
      for (let i = 0; i < targets.length; i++) {
        setLiveProgress(`${i + 1}/${targets.length}`);
        try {
          const o = await fetchLiveOrders(targets[i].slug, targets[i].rank ?? 0);
          // Solo pisamos el dato si el refresco trajo las DOS puntas reales
          // Y siguen cruzadas bien (sell > buy) — si no, dejamos el valor
          // del último escaneo tal cual. Sin el chequeo de sell > buy, el
          // mercado moviéndose podía dejar una fila con precios cruzados
          // (comprador pagando más que el vendedor pide en ese instante) y
          // encima con el "score" viejo todavía alto, aparecía como "top
          // pick" mostrando un spread negativo.
          if (o && o.buy > 0 && o.sell > 0 && o.sell > o.buy) {
            setFlips(prev => prev.map(f => f.slug === targets[i].slug
              ? { ...f, buy: o.buy, sell: o.sell, spread: o.sell - o.buy,
                  margin: ((o.sell - o.buy) / o.sell) * 100,
                  parts_profit: f.parts_total != null ? o.sell - f.parts_total : f.parts_profit,
                  fresh: true }
              : f));
          }
          refreshedRef.current.add(targets[i].slug);
        } catch { /* red caída: seguimos con el resto */ }
      }
    } finally {
      busyRef.current = false;
      setLive("done");
      setLastLive(new Date());
    }
  }

  // Auto-refresco liviano: al montar y cada 90s, re-cotiza en vivo el top 25
  // por spread (unos 20 requests, ~8s a nuestro rate limit). Como el refresco
  // ahora es no-destructivo (nunca pisa un dato bueno con 0), no hay riesgo
  // de que una fila desaparezca — solo se pone más al día sola.
  useEffect(() => {
    if (!flipsProp.length) return;
    refreshLive();
    const id = setInterval(() => refreshLive(true), 90_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipsProp.length]);

  const cols: Col<Flip>[] = [
    {
      key: "name", label: "Set", sortVal: f => f.name,
      render: f => (
        <>
          <MarketLink slug={f.slug}>{f.name}</MarketLink>
          {f.kind === "arcane" && <> <Tag title={`Arcane — trading rank ${f.rank ?? 0}`}>arcane{f.rank ? ` r${f.rank}` : ""}</Tag></>}
          {f.kind === "mod" && <> <Tag title={`Mod — trading rank ${f.rank ?? 0}`}>{f.rank ? `r${f.rank}` : "unranked"}</Tag></>}
          {mine[f.slug]?.buy && <> <Tag kind="wtb" title="You already have a buy order for this item">WTB ✓</Tag></>}
          {mine[f.slug]?.sell && <> <Tag kind="wts" title="You already have a sell order for this item">WTS ✓</Tag></>}
        </>
      ),
    },
    {
      key: "buy", label: "Buyers pay (WTB)", num: true,
      title: "Highest in-game buy order", sortVal: f => f.buy,
      render: f => <Plat value={f.buy} />,
    },
    {
      key: "sell", label: "Sellers ask (WTS)", num: true,
      title: "Cheapest in-game sell at this item's trading rank", sortVal: f => f.sell,
      render: f => <Plat value={f.sell} />,
    },
    {
      key: "perTrade", label: "Profit", num: true,
      title: "What you make per flip (× units when a cheap item is worth moving in bulk)",
      sortVal: f => perTradeProfit(f),
      render: f => {
        const q = bulkQty(f);
        return <><b className="gain-pos"><Plat value={perTradeProfit(f)} /></b>{q > 1 && <span className="muted"> ×{q}</span>}</>;
      },
    },
    { key: "margin", label: "Margin", num: true, sortVal: f => f.margin, render: f => `${f.margin.toFixed(0)}%` },
    { key: "vol48", label: "Sales 48h", num: true, sortVal: f => f.vol48, render: f => <VolBadge vol={f.vol48} /> },
    {
      key: "score", label: "Score", num: true,
      title: "spread^1.4 × liquidity confidence^1.6 × margin confidence — low profit and low recent sales both get punished harder than proportionally, not just discounted a bit",
      sortVal: f => f.score ?? 0, render: f => <b>{(f.score ?? 0).toFixed(1)}</b>,
    },
    {
      key: "parts", label: "Separate parts", num: true,
      title: "Buy the listed parts (at asking price, no waiting), sell the assembled set — usually worse than the Profit column, which assumes both your own buy and sell orders get filled",
      sortVal: f => f.parts_profit ?? -999,
      render: f => f.parts_profit != null
        ? <span className={f.parts_profit >= perTradeProfit(f) ? "gain-pos" : "loss"} title={f.parts_detail}>
            <Plat value={f.parts_profit} />
          </span>
        : <span className="muted">—</span>,
    },
    ...(preview ? [] : [{
      key: "actions", label: "Actions",
      render: (f: Flip) => (
        <span className="actions">
          <button className="btn primary" title="Post a buy order from here"
                  onClick={() => openComposer({ slug: f.slug, name: f.name, type: "buy", price: Math.round(f.buy + 1), rank: f.rank || undefined, refBuy: f.buy, refSell: f.sell })}>
            <Zap size={12} className="inline-icon" /> WTB
          </button>
          <button className="btn primary" title="Post a sell order from here"
                  onClick={() => openComposer({ slug: f.slug, name: f.name, type: "sell", price: Math.round(f.sell - 1), rank: f.rank || undefined, refBuy: f.buy, refSell: f.sell })}>
            <Zap size={12} className="inline-icon" /> WTS
          </button>
        </span>
      ),
    } satisfies Col<Flip>]),
  ];

  // los picks salen de filas con las DOS puntas reales Y spread positivo:
  // sin comprador in-game el "spread" contra 0 daba números absurdos (buy
  // 1p → resell 129p), y el mercado moviéndose entre escaneos puede cruzar
  // los precios (comprador pagando más de lo que pide el vendedor en ese
  // instante) — sin el chequeo de sell > buy, el "top pick" podía mostrar
  // un spread negativo.
  const liquid = flips.filter(f => f.vol48 >= 30 && f.buy > 0 && f.sell > f.buy);
  const bestParts = [...liquid].filter(f => (f.parts_profit ?? 0) > 0)
    .sort((a, b) => (b.parts_profit ?? 0) - (a.parts_profit ?? 0))[0];
  // por score, no por spread crudo — si no, un arcano caro y poco líquido
  // le ganaba a algo con menos plata por flip pero de verdad ejecutable
  const bestSpread = [...liquid].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

  return (
    <>
    <div className="card">
      <h2>Daily flips — Prime sets, arcanes & primed mods</h2>
      <PeakTimeChart />
      <p className="hint">
        <b>Spread</b>: post a buy order 1p above buyers, resell 1p under sellers (bigger margin, needs a fill).{" "}
        <b>Parts→set</b>: buy the listed parts, sell the set (instant profit — hover for breakdown).
        {flipsTs && <> · Scanned {new Date(flipsTs * 1000).toLocaleString()}</>}
      </p>
      <div className="controls">
        <button className="btn" disabled={live === "running"} onClick={() => refreshLive(true)}>
          <RefreshCw size={12} className={`inline-icon ${live === "running" ? "spin" : ""}`} />{" "}
          {live === "running" ? `updating ${liveProgress}…`
            : live === "done" ? "live prices — refresh again"
            : "refresh live prices (top 25)"}
        </button>
        {live === "done" && lastLive && (
          <span className="hint" style={{ margin: 0 }}>
            top 25 live as of {lastLive.toLocaleTimeString()} · auto-refreshes every 90s
          </span>
        )}
      </div>
      {(bestParts || bestSpread) && (
        <div className="picks">
          {bestParts && (
            <div className="pick">
              <div className="pick-k"><Zap size={12} className="inline-icon" /> Instant profit</div>
              <div className="pick-v"><MarketLink slug={bestParts.slug}>{bestParts.name}</MarketLink></div>
              <div className="pick-d">
                buy parts for <Plat value={bestParts.parts_total!} />, sell the set at <Plat value={bestParts.sell} />{" "}
                → <b className="gain-pos"><Plat value={bestParts.parts_profit!} sign /></b>
              </div>
              <div className="pick-d muted" title={bestParts.parts_detail}>{bestParts.parts_detail}</div>
            </div>
          )}
          {bestSpread && (
            <div className="pick">
              <div className="pick-k"><Fish size={12} className="inline-icon" /> Top pick (patient)</div>
              <div className="pick-v"><MarketLink slug={bestSpread.slug}>{bestSpread.name}</MarketLink></div>
              <div className="pick-d">
                buy order at <Plat value={bestSpread.buy + 1} />, resell at <Plat value={bestSpread.sell - 1} />{" "}
                → <b className="gain-pos"><Plat value={bestSpread.spread - 2} sign /></b> · {bestSpread.vol48} sales/48h
              </div>
              <div className="pick-d">
                <CopyBtn label={<><Copy size={12} className="inline-icon" /> copy WTB</>} text={`WTB [${bestSpread.name}] ${Math.round(bestSpread.buy + 1)}p (via NinjaFlip)`} />
              </div>
            </div>
          )}
        </div>
      )}
      <div className="controls">
        <input type="search" placeholder="Search set..." value={term} onChange={e => setTerm(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={liquidOnly} onChange={e => setLiquidOnly(e.target.checked)} />
          liquid only (≥30 sales/48h)
        </label>
        <label className="sim-field" title="Minimum profit per pair of trades (spread × bulk units)">min profit/trade
          <input type="number" min={0} value={minSpread}
                 onChange={e => setMinSpread(+e.target.value || 0)} /> p
        </label>
        <span className="chips">
          {([["", "All"], ["set", "Prime sets"], ["arcane", "Arcanes"], ["mod", "Primed mods"]] as const).map(([k, label]) => (
            <button key={k} className={`chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>{label}</button>
          ))}
        </span>
      </div>
      <DataTable cols={cols} rows={rows} defaultSort="score" maxRows={20} />
    </div>
    {!preview && (isPremium()
      ? <SuggesterCard flips={flips} mine={mine} startPlat={startPlat} kind={kind} />
      : <div className="card"><PremiumLock feature="Suggested Positions" /></div>)}
    </>
  );
}

// ---------- Sugeridor de posiciones ----------

function SuggesterCard({ flips, mine, startPlat, kind }: {
  flips: Flip[];
  mine: Record<string, { buy?: boolean; sell?: boolean }>;
  startPlat: number;
  /** mismo filtro de tipo que los chips de la tabla de arriba (All/Prime
   *  sets/Arcanes/Primed mods) — antes este card lo ignoraba del todo:
   *  filtrabas la tabla a "Prime sets" y "Suggested positions" seguía
   *  sugiriendo (y dejando postear) arcanos/primed mods igual. */
  kind: "" | "set" | "arcane" | "mod";
}) {
  const committed = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("orders_cache_v2") ?? "null") as
        { orders?: { type: string; price: number; qty: number }[] } | null;
      return (raw?.orders ?? []).filter(o => o.type === "buy")
        .reduce((a, o) => a + o.price * (o.qty || 1), 0);
    } catch { return 0; }
  }, [mine]);

  // capital libre = lo que tenés ahora mismo menos lo ya comprometido en
  // compras activas. Sigue el valor en vivo (se resetea si vendés/comprás
  // algo o el plat cambia) — editable a mano mientras tanto para ese caso.
  const autoCapital = Math.max(0, Math.round(startPlat - committed));
  const [capital, setCapital] = useState(autoCapital);
  useEffect(() => { setCapital(autoCapital); }, [autoCapital]);
  const [tradesLeft, setTradesLeft] = useState(14);

  const plan = useMemo(() => {
    const slots = Math.max(0, Math.floor(tradesLeft / 2));
    // mismo "score" que la columna de la tabla y el CLI de flips.py (spread ×
    // confianza(liquidez) × confianza(margen)) — una sola fórmula, no una copia local
    const cands = flips
      .filter(f => f.buy > 0 && f.vol48 >= 30 && f.margin >= 12 && perTradeProfit(f) >= 15 &&
                   (!kind || (f.kind ?? "set") === kind) &&
                   !mine[f.slug]?.buy && !mine[f.slug]?.sell)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const picks: { f: Flip; cost: number; resell: number; qty: number; profit: number }[] = [];
    let cap = capital;
    for (const f of cands) {
      if (picks.length >= slots) break;
      const cost = Math.round(f.buy + 1);
      const resell = Math.max(1, Math.round(f.sell - 1));
      const unit = resell - cost;
      if (unit < 1 || cost > cap) continue;
      // rankeados y sets: de a 1; sueltos de rango 0: lote hasta 6
      const want = bulkQty(f);
      const qty = Math.max(1, Math.min(want, Math.floor(cap / cost)));
      if (unit * qty < 5) continue; // no vale gastar 2 trades
      picks.push({ f, cost, resell, qty, profit: unit * qty });
      cap -= cost * qty;
    }
    return { picks, capLeft: cap };
  }, [flips, mine, capital, tradesLeft, kind]);

  const totProfit = plan.picks.reduce((a, p) => a + p.profit, 0);
  const totCost = plan.picks.reduce((a, p) => a + p.cost, 0);

  return (
    <div className="card">
      <h2><Target size={16} /> Suggested positions</h2>
      <p className="hint">
        Live flips you have no order on, ranked by score (spread, discounted by how sure you can buy and resell it), greedily fit to your free
        capital and remaining trades (2 per flip). Skips profits under 5p. Posting one updates the plan.
        {kind && <> Filtered to <b>{kind === "set" ? "prime sets" : kind === "arcane" ? "arcanes" : "primed mods"}</b>, same as the table above.</>}
      </p>
      <div className="controls">
        <label className="sim-field" title="Your current plat minus what's already tied up in active buy orders — edit to override">
          Free capital
          <input type="number" min={0} value={capital} onChange={e => setCapital(+e.target.value || 0)} /> p
        </label>
        <label className="sim-field" title="Each flip uses 2 of your daily trades (MR = trades/day)">
          Trades left
          <input type="number" min={0} max={40} value={tradesLeft} onChange={e => setTradesLeft(+e.target.value || 0)} />
        </label>
        <span className="hint" style={{ margin: 0 }}>
          committed in buys: <Plat value={committed} />
          {plan.picks.length > 0 && <> · plan uses <Plat value={totCost} />, leaves <Plat value={plan.capLeft} /> free</>}
        </span>
      </div>
      {plan.picks.length ? (
        <>
          <table>
            <tbody>
              {plan.picks.map(({ f, cost, resell, qty, profit }) => (
                <tr key={f.slug}>
                  <td>
                    <MarketLink slug={f.slug}>{f.name}</MarketLink>
                    {f.kind === "arcane" && <> <Tag>arcane</Tag></>}
                    {f.kind === "mod" && <> <Tag>primed</Tag></>}
                  </td>
                  <td className="num">post WTB <b><Plat value={cost} /></b>{qty > 1 && <> ×{qty}</>}</td>
                  <td className="num">resell ~<Plat value={resell} /></td>
                  <td className="num gain-pos"><Plat value={profit} sign /></td>
                  <td className="num">{f.vol48} sales/48h</td>
                  <td>
                    <button className="btn primary"
                            onClick={() => openComposer({ slug: f.slug, name: f.name, type: "buy", price: cost, quantity: qty, rank: f.rank || undefined, refBuy: f.buy, refSell: f.sell })}>
                      <Zap size={12} className="inline-icon" /> post
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>
            Full plan: {plan.picks.length} position{plan.picks.length > 1 ? "s" : ""} · <Plat value={totCost} /> in ·
            expected <b className="gain-pos"><Plat value={totProfit} sign /></b> when they cycle.
          </p>
        </>
      ) : (
        <p className="muted">Nothing to suggest with the current capital/trades — try lowering them, or rescan with <code>python scripts/flips.py</code>.</p>
      )}
    </div>
  );
}

// ---------- Cacería ----------

export function HuntView({ relics }: { relics: Relic[] }) {
  const hunts = relics.filter(r => r.hunt && r.jackpot_price >= 10);

  const base: Col<Relic>[] = [
    { key: "relic", label: "Relic", sortVal: r => r.relic, render: r => <>{r.relic} <Vault r={r} /></> },
    { key: "count", label: "Owned", num: true, sortVal: r => r.count, render: r => r.count },
    { key: "jackpot", label: "Top item", sortVal: r => r.jackpot, render: r => <span className="nowrap-cell"><MarketLink name={r.jackpot} /></span> },
    { key: "price", label: "Price", num: true, sortVal: r => r.jackpot_price, render: r => <Plat value={r.jackpot_price} /> },
    { key: "vol", label: "Sales 48h", num: true, sortVal: r => r.jackpot_vol48, render: r => <VolBadge vol={r.jackpot_vol48} /> },
  ];

  const intCols: Col<Relic>[] = [...base,
    { key: "hit", label: "P(hit)", num: true, sortVal: r => r.hunt!.hitInt, render: r => pct(r.hunt!.hitInt) },
    { key: "score", label: "Exp. plat", num: true, sortVal: r => r.hunt!.scoreInt, render: r => <b><Plat value={r.hunt!.scoreInt} /></b> },
  ];

  const radCols: Col<Relic>[] = [...base,
    { key: "hit", label: "P(hit)", num: true, sortVal: r => r.hunt!.hitRadshare, render: r => pct(r.hunt!.hitRadshare) },
    { key: "score", label: "Exp. plat", num: true, sortVal: r => r.hunt!.scoreRad, render: r => <b><Plat value={r.hunt!.scoreRad} /></b> },
    {
      key: "missing", label: "Need for 95%", num: true, sortVal: r => r.hunt!.missing,
      render: r => r.hunt!.missing === 0 ? "✓ enough"
        : r.vaulted ? <span title="Vaulted, no more drops">~{r.hunt!.missing} <Ban size={11} className="inline-icon" /></span>
        : <span title={r.farm ?? ""}>~{r.hunt!.missing} <Sprout size={11} className="inline-icon" /></span>,
    },
  ];

  return (
    <>
      <p className="hint standalone">
        Real odds of pulling the priciest item <b>with your stock</b>. "Exp. plat" = price × P(hit).
        To ~guarantee (95%) a rare: ~149 intact or ~8 radshares (each radshare crack = 4 rolls).
      </p>
      <div className="two-col hunt-cols">
        <div className="card">
          <h2>Opening INTACT</h2>
          <DataTable cols={intCols} rows={hunts} defaultSort="score" maxRows={15} />
        </div>
        <div className="card">
          <h2>Running RADSHARES</h2>
          <DataTable cols={radCols} rows={hunts} defaultSort="score" maxRows={15} />
        </div>
      </div>
    </>
  );
}

// ---------- Radiantes listas para abrir ----------

function RadiantReadyCard({ relics }: { relics: Relic[] }) {
  const ready = relics
    .filter(r => r.radiantCount > 0 && r.hunt)
    .map(r => {
      const h = r.hunt!;
      const hit = 1 - (1 - h.pRadshare) ** r.radiantCount;
      return { ...r, hitRad: hit, scoreRad: r.jackpot_price * hit };
    });
  if (!ready.length) return null;

  const cols: Col<(typeof ready)[number]>[] = [
    { key: "relic", label: "Relic", sortVal: r => r.relic, render: r => <>{r.relic} <Vault r={r} /></> },
    {
      key: "rads", label: "Radiants", num: true, sortVal: r => r.radiantCount,
      render: r => <b>{r.radiantCount}</b>,
    },
    { key: "jackpot", label: "Priciest rare", sortVal: r => r.jackpot, render: r => <MarketLink name={r.jackpot} /> },
    { key: "price", label: "Price", num: true, sortVal: r => r.jackpot_price, render: r => <Plat value={r.jackpot_price} /> },
    { key: "vol", label: "Sales 48h", num: true, sortVal: r => r.jackpot_vol48, render: r => <VolBadge vol={r.jackpot_vol48} /> },
    {
      key: "hit", label: "P(hit) in radshare", num: true,
      title: "Odds of at least one drop cracking YOUR radiants in radshare (4 rolls per crack)",
      sortVal: r => r.hitRad, render: r => pct(r.hitRad),
    },
    {
      key: "score", label: "Exp. plat ▾", num: true,
      title: "Rare price × odds with your radiants",
      sortVal: r => r.scoreRad, render: r => <b><Plat value={r.scoreRad} /></b>,
    },
  ];

  return (
    <div className="card">
      <h2><Flame size={16} /> Radiants ready to crack
        <Tag kind="radiant">{ready.reduce((a, r) => a + r.radiantCount, 0)} radiants across {ready.length} types</Tag>
      </h2>
      <p className="hint">
        Traces already spent — the order says what to crack first: rare price
        weighted by the real odds with <b>the radiants you own</b> of each.
        Crack them in radshares so they count.
      </p>
      <DataTable cols={cols} rows={ready} defaultSort="score" maxRows={12} />
    </div>
  );
}

// ---------- Todas las reliquias ----------

export function RelicsView({ relics }: { relics: Relic[] }) {
  const [term, setTerm] = useState("");
  const [tier, setTier] = useState("");
  const [bucket, setBucket] = useState("");
  const [vault, setVault] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => relics.filter(r =>
    (!tier || r.tier === tier) &&
    (!bucket || r.bucket === bucket) &&
    (vault === "" || String(r.vaulted ? 1 : 0) === vault) &&
    (!term || r.relic.toLowerCase().includes(term.toLowerCase()) ||
      r.drops.some(d => d.item.toLowerCase().includes(term.toLowerCase())))),
    [relics, term, tier, bucket, vault]);

  const cols: Col<Relic>[] = [
    {
      key: "relic", label: "Relic", sortVal: r => r.relic,
      render: r => (
        <>
          <button className="linkish" onClick={() => setOpen(o => o === r.relic ? null : r.relic)}>
            {open === r.relic ? "▾" : "▸"} {r.relic}
          </button>{" "}
          <Vault r={r} />
          {r.refinedCount > 0 && <Tag>{r.refinedCount} refined</Tag>}
        </>
      ),
    },
    { key: "count", label: "Owned", num: true, sortVal: r => r.count, render: r => r.count },
    { key: "evi", label: "Intact EV", num: true, sortVal: r => r.ev_intact, render: r => <Plat value={r.ev_intact} /> },
    { key: "evr", label: "Radiant EV", num: true, sortVal: r => r.ev_radiant, render: r => <Plat value={r.ev_radiant} /> },
    {
      key: "gain", label: "Refine gain", num: true, sortVal: r => r.gain,
      render: r => <span className={r.gain >= 2.5 ? "gain-pos" : ""}><Plat value={r.gain} sign /></span>,
    },
    { key: "jp", label: "Top item", num: true, sortVal: r => r.jackpot_price, render: r => <Plat value={r.jackpot_price} /> },
    {
      key: "bucket", label: "Recommendation", sortVal: r => r.bucket,
      render: r => (
        <Tag kind={r.bucket === "junk" ? "" : r.bucket}>
          {BUCKET_LABEL[r.bucket]}{r.bucket === "sell" && <> ~<Plat value={r.relic_price} /></>}
        </Tag>
      ),
    },
  ];

  const openRelic = rows.find(r => r.relic === open);

  return (
    <>
    <RadiantReadyCard relics={relics} />
    <div className="card">
      <h2>All your relics</h2>
      <p className="hint">
        Click ▸ for drop details. <b>Radiant</b> = radshare it · <b>Intact</b> = crack as-is ·{" "}
        <b>Sell whole</b> = worth more unopened (check buyers!) · <b>Ducats</b> = Baro fodder.
      </p>
      <div className="controls">
        <input type="search" placeholder="Search relic or item..." value={term} onChange={e => setTerm(e.target.value)} />
        <select value={tier} onChange={e => setTier(e.target.value)}>
          <option value="">All eras</option>
          <option>Lith</option><option>Meso</option><option>Neo</option><option>Axi</option>
        </select>
        <select value={bucket} onChange={e => setBucket(e.target.value)}>
          <option value="">All recommendations</option>
          <option value="radiant">Refine to radiant</option>
          <option value="intact">Crack intact</option>
          <option value="sell">Sell whole</option>
          <option value="junk">Ducats / filler</option>
        </select>
        <select value={vault} onChange={e => setVault(e.target.value)}>
          <option value="">Vaulted & active</option>
          <option value="1">Vaulted only</option>
          <option value="0">Active only</option>
        </select>
      </div>
      {openRelic && <RelicDetail r={openRelic} />}
      <DataTable cols={cols} rows={rows} defaultSort="evr" maxRows={25} />
    </div>
    </>
  );
}

function RelicDetail({ r }: { r: Relic }) {
  return (
    <div className="detail-card">
      <div className="detail-info">
        <b>{r.relic}</b>{" — "}
        {r.vaulted
          ? <><Ban size={13} className="inline-icon" /> vaulted, no longer drops</>
          : <><Sprout size={13} className="inline-icon" /> farm: {r.farm ?? "?"} ({r.farm_chance ?? "?"}%)</>}
        {r.relic_price > 0 && (
          <> · <HandCoins size={13} className="inline-icon" /> whole relic lists at ~<Plat value={r.relic_price} /> —{" "}
            <MarketLink slug={slugOf(`${r.relic} relic`)}>see buyers <ExternalLink size={11} className="inline-icon" /></MarketLink></>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Item</th><th>Rarity</th>
            <th className="num">Intact</th><th className="num">Radiant</th>
            <th className="num">Price</th><th className="num">Med 48h</th>
            <th className="num">Sales 48h</th><th className="num">Ducats</th>
          </tr>
        </thead>
        <tbody>
          {[...r.drops].sort((a, b) => b.price - a.price).map(d => (
            <tr key={d.item} className={d.rarity === "Rare" ? "rare" : ""}>
              <td><MarketLink name={d.item} /></td>
              <td>{d.rarity}</td>
              <td className="num">{d.chance_intact}%</td>
              <td className="num">{d.chance_radiant}%</td>
              <td className="num">{d.price ? <Plat value={d.price} /> : "—"}</td>
              <td className="num">{d.med48 ? <Plat value={d.med48} /> : "—"}</td>
              <td className="num">{d.vol48}</td>
              <td className="num">{d.ducats || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Ducados ----------

export function DucatsView({ relics }: { relics: Relic[] }) {
  const rows = relics.filter(r => r.ev_ducats > 0);
  const cols: Col<Relic>[] = [
    { key: "relic", label: "Relic", sortVal: r => r.relic, render: r => <>{r.relic} <Vault r={r} /></> },
    { key: "count", label: "Owned", num: true, sortVal: r => r.count, render: r => r.count },
    { key: "duc", label: "Ducats / crack", num: true, sortVal: r => r.ev_ducats, render: r => <b>{r.ev_ducats.toFixed(0)}</b> },
    { key: "tot", label: "Expected total", num: true, sortVal: r => r.ev_ducats * r.count, render: r => Math.round(r.ev_ducats * r.count).toLocaleString() },
    { key: "bucket", label: "Rec.", sortVal: r => r.bucket, render: r => <Tag kind={r.bucket === "junk" ? "" : r.bucket}>{BUCKET_LABEL[r.bucket]}</Tag> },
  ];
  return (
    <div className="card">
      <h2>Ducats for Baro</h2>
      <p className="hint">Expected ducats per intact crack. "Ducats" relics are plat-worthless — crack them for this.</p>
      <DataTable cols={cols} rows={rows} defaultSort="duc" maxRows={20} />
    </div>
  );
}

