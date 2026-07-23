import { useEffect, useMemo, useRef, useState } from "react";
import type { Flip, HistoryPoint, Relic, Sale } from "../types";
import { BUCKET_LABEL, fetchLiveOrders, fmtP, pct, slugOf } from "../lib";
import { CopyBtn, DataTable, MarketLink, Tag, Tile, VolBadge } from "./ui";
import type { Col } from "./ui";
import { HistoryChart } from "./HistoryChart";
import { openComposer } from "./Composer";

const Vault = ({ r }: { r: { vaulted: boolean } }) =>
  r.vaulted ? <Tag kind="vaulted" title="Vaulted: no longer drops in missions">V</Tag> : null;

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
        <Tile value={`~${fmtP(evInt)}p`} label="expected value, all intact" />
        <Tile value={`~${fmtP(evRad)}p`} label="expected value, all radiant" />
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
              <div className="bar i" style={{ width: `${(r.ev_intact / maxEV) * 100}%` }} />
              <div className="bar r" style={{ width: `${(r.ev_radiant / maxEV) * 100}%` }} />
              <span className="bar-val" style={{ left: `calc(${(r.ev_radiant / maxEV) * 100}% + 6px)` }}>
                {fmtP(r.ev_radiant)}p
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
                <td className="num">{s.plat}p</td>
                <td className={`num ${diff >= 0 ? "gain-pos" : "loss"}`}>
                  {diff >= 0 ? "+" : ""}{fmtP(diff)}p vs today
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

export function FlipsView({ flips: flipsProp, flipsTs, startPlat }: { flips: Flip[]; flipsTs: number | null; startPlat: number }) {
  const [term, setTerm] = useState("");
  const [liquidOnly, setLiquidOnly] = useState(true);
  const [flips, setFlips] = useState(flipsProp);
  const [live, setLive] = useState<"idle" | "running" | "done">("idle");
  const [liveProgress, setLiveProgress] = useState("");
  const [mine, setMine] = useState(myOrdersBySlug);

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
    (!term || f.name.toLowerCase().includes(term.toLowerCase())) &&
    (!liquidOnly || f.vol48 >= 30)), [flips, term, liquidOnly]);

  // qué sets ya tienen precio en vivo (para no re-pedirlos al cambiar filtros)
  const refreshedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);

  async function refreshLive(force = false) {
    if (busyRef.current) return; // ya hay una corrida en curso
    const targets = [...rows]
      .sort((a, b) => b.spread - a.spread)
      .filter(f => force || !refreshedRef.current.has(f.slug))
      .slice(0, 25);
    if (!targets.length) { setLive("done"); return; }
    busyRef.current = true;
    setLive("running");
    try {
      for (let i = 0; i < targets.length; i++) {
        setLiveProgress(`${i + 1}/${targets.length}`);
        try {
          const o = await fetchLiveOrders(targets[i].slug);
          if (o) {
            setFlips(prev => prev.map(f => f.slug === targets[i].slug
              ? { ...f, buy: o.buy, sell: o.sell, spread: o.sell - o.buy,
                  margin: o.sell > 0 ? ((o.sell - o.buy) / o.sell) * 100 : 0,
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
    }
  }

  // al abrir la pestaña y al cambiar el filtro de liquidez, refrescar
  // los visibles que todavía no tienen precio en vivo
  useEffect(() => {
    if (flipsProp.length) refreshLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liquidOnly]);

  // al buscar, refrescar lo que matchea (debounce para no pedir por tecla)
  useEffect(() => {
    if (!term) return;
    const t = setTimeout(() => refreshLive(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const cols: Col<Flip>[] = [
    {
      key: "name", label: "Set", sortVal: f => f.name,
      render: f => (
        <>
          <MarketLink slug={f.slug}>{f.name}</MarketLink>
          {mine[f.slug]?.buy && <> <Tag kind="wtb" title="You already have a buy order for this set">WTB ✓</Tag></>}
          {mine[f.slug]?.sell && <> <Tag kind="wts" title="You already have a sell order for this set">WTS ✓</Tag></>}
        </>
      ),
    },
    {
      key: "buy", label: "Buyers pay (WTB)", num: true,
      title: "Highest in-game buy order", sortVal: f => f.buy,
      render: f => f.fresh ? `${fmtP(f.buy)}p`
        : <span className="stale" title="Stale scan value — refreshing…">{fmtP(f.buy)}p ⏳</span>,
    },
    {
      key: "sell", label: "Sellers ask (WTS)", num: true,
      title: "Cheapest in-game sell", sortVal: f => f.sell,
      render: f => f.fresh ? `${fmtP(f.sell)}p`
        : <span className="stale" title="Stale scan value — refreshing…">{fmtP(f.sell)}p ⏳</span>,
    },
    { key: "spread", label: "Spread", num: true, sortVal: f => f.spread, render: f => <b>{fmtP(f.spread)}p</b> },
    { key: "margin", label: "Margin", num: true, sortVal: f => f.margin, render: f => `${f.margin.toFixed(0)}%` },
    { key: "vol48", label: "Sales 48h", num: true, sortVal: f => f.vol48, render: f => <VolBadge vol={f.vol48} /> },
    { key: "med48", label: "Med 48h", num: true, sortVal: f => f.med48, render: f => `${fmtP(f.med48)}p` },
    {
      key: "parts", label: "Parts→set", num: true, title: "Buy the listed parts, sell the set",
      sortVal: f => f.parts_profit ?? -999,
      render: f => f.parts_profit != null
        ? <span className={f.parts_profit > 0 ? "gain-pos" : ""} title={f.parts_detail}>
            {f.parts_profit > 0 ? "+" : ""}{fmtP(f.parts_profit)}p
          </span>
        : <span className="muted">—</span>,
    },
    {
      key: "actions", label: "Actions",
      render: f => (
        <span className="actions">
          <button className="btn primary" title="Post a buy order from here"
                  onClick={() => openComposer({ slug: f.slug, name: f.name, type: "buy", price: Math.round(f.buy + 1) })}>
            ⚡ WTB
          </button>
          <button className="btn primary" title="Post a sell order from here"
                  onClick={() => openComposer({ slug: f.slug, name: f.name, type: "sell", price: Math.round(f.sell - 1) })}>
            ⚡ WTS
          </button>
          <CopyBtn label="📋" text={`WTB [${f.name}] ${Math.round(f.buy + 1)}p`} />
          <a className="btn" target="_blank" rel="noreferrer" href={`https://warframe.market/items/${f.slug}`}>↗</a>
        </span>
      ),
    },
  ];

  const liquid = flips.filter(f => f.vol48 >= 30);
  const bestParts = [...liquid].filter(f => (f.parts_profit ?? 0) > 0)
    .sort((a, b) => (b.parts_profit ?? 0) - (a.parts_profit ?? 0))[0];
  const bestSpread = [...liquid].sort((a, b) => b.spread - a.spread)[0];

  return (
    <>
    <div className="card">
      <h2>Daily flips — Prime sets</h2>
      <p className="hint">
        <b>Spread</b>: post a buy order 1p above buyers, resell 1p under sellers (bigger margin, needs a fill).{" "}
        <b>Parts→set</b>: buy the listed parts, sell the set (instant profit — hover for breakdown).
        {flipsTs && <> · Scanned {new Date(flipsTs * 1000).toLocaleString()}</>}
      </p>
      <div className="controls">
        <button className="btn" disabled={live === "running"} onClick={() => refreshLive(true)}>
          {live === "running" ? `🔄 updating ${liveProgress}…`
            : live === "done" ? "✓ live prices — refresh again"
            : "🔄 refresh live prices (top 25)"}
        </button>
        {live === "done" && <span className="hint" style={{ margin: 0 }}>buy/sell/spread are live; volume & median still from the scan</span>}
      </div>
      {(bestParts || bestSpread) && (
        <div className="picks">
          {bestParts && (
            <div className="pick">
              <div className="pick-k">⚡ Instant profit</div>
              <div className="pick-v"><MarketLink slug={bestParts.slug}>{bestParts.name}</MarketLink></div>
              <div className="pick-d">
                buy parts for {fmtP(bestParts.parts_total!)}p, sell the set at {fmtP(bestParts.sell)}p{" "}
                → <b className="gain-pos">+{fmtP(bestParts.parts_profit!)}p</b>
              </div>
              <div className="pick-d muted" title={bestParts.parts_detail}>{bestParts.parts_detail}</div>
            </div>
          )}
          {bestSpread && (
            <div className="pick">
              <div className="pick-k">🎣 Best spread (patient)</div>
              <div className="pick-v"><MarketLink slug={bestSpread.slug}>{bestSpread.name}</MarketLink></div>
              <div className="pick-d">
                buy order at {Math.round(bestSpread.buy + 1)}p, resell at {Math.round(bestSpread.sell - 1)}p{" "}
                → <b className="gain-pos">+{fmtP(bestSpread.spread - 2)}p</b> · {bestSpread.vol48} sales/48h
              </div>
              <div className="pick-d">
                <CopyBtn label="📋 copy WTB" text={`WTB [${bestSpread.name}] ${Math.round(bestSpread.buy + 1)}p`} />
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
      </div>
      <DataTable cols={cols} rows={rows} defaultSort="spread" maxRows={20} />
    </div>
    <SuggesterCard flips={flips} mine={mine} startPlat={startPlat} />
    <SimulatorCard flips={flips} startPlat={startPlat} />
    </>
  );
}

// ---------- Sugeridor de posiciones ----------

function SuggesterCard({ flips, mine, startPlat }: {
  flips: Flip[];
  mine: Record<string, { buy?: boolean; sell?: boolean }>;
  startPlat: number;
}) {
  const committed = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("orders_cache_v2") ?? "null") as
        { orders?: { type: string; price: number; qty: number }[] } | null;
      return (raw?.orders ?? []).filter(o => o.type === "buy")
        .reduce((a, o) => a + o.price * (o.qty || 1), 0);
    } catch { return 0; }
  }, [mine]);

  const [capital, setCapital] = useState(() => Math.max(0, Math.round(startPlat - committed)));
  const [tradesLeft, setTradesLeft] = useState(14);

  const plan = useMemo(() => {
    const slots = Math.max(0, Math.floor(tradesLeft / 2));
    const cands = flips
      .filter(f => f.fresh && f.vol48 >= 30 && f.spread >= 6 &&
                   !mine[f.slug]?.buy && !mine[f.slug]?.sell)
      .sort((a, b) => b.spread * Math.min(b.vol48, 60) - a.spread * Math.min(a.vol48, 60));
    const picks: { f: Flip; cost: number; resell: number; profit: number }[] = [];
    let cap = capital;
    for (const f of cands) {
      if (picks.length >= slots) break;
      const cost = Math.round(f.buy + 1);
      const resell = Math.max(1, Math.round(f.sell - 1));
      if (cost > cap || resell - cost < 5) continue;
      picks.push({ f, cost, resell, profit: resell - cost });
      cap -= cost;
    }
    return { picks, capLeft: cap };
  }, [flips, mine, capital, tradesLeft]);

  const totProfit = plan.picks.reduce((a, p) => a + p.profit, 0);
  const totCost = plan.picks.reduce((a, p) => a + p.cost, 0);

  return (
    <div className="card">
      <h2>🎯 Suggested positions</h2>
      <p className="hint">
        Live flips you have no order on, ranked by spread × liquidity, greedily fit to your free
        capital and remaining trades (2 per flip). Skips profits under 5p. Posting one updates the plan.
      </p>
      <div className="controls">
        <label className="sim-field">Free capital
          <input type="number" min={0} value={capital} onChange={e => setCapital(+e.target.value || 0)} /> p
        </label>
        <label className="sim-field" title="Each flip uses 2 of your daily trades (MR = trades/day)">
          Trades left
          <input type="number" min={0} max={40} value={tradesLeft} onChange={e => setTradesLeft(+e.target.value || 0)} />
        </label>
        <span className="hint" style={{ margin: 0 }}>
          committed in buys: {fmtP(committed)}p{plan.picks.length > 0 && <> · plan uses {fmtP(totCost)}p, leaves {fmtP(plan.capLeft)}p free</>}
        </span>
      </div>
      {plan.picks.length ? (
        <>
          <table>
            <tbody>
              {plan.picks.map(({ f, cost, resell, profit }) => (
                <tr key={f.slug}>
                  <td><MarketLink slug={f.slug}>{f.name}</MarketLink></td>
                  <td className="num">post WTB <b>{cost}p</b></td>
                  <td className="num">resell ~{resell}p</td>
                  <td className="num gain-pos">+{profit}p</td>
                  <td className="num">{f.vol48} sales/48h</td>
                  <td>
                    <button className="btn primary"
                            onClick={() => openComposer({ slug: f.slug, name: f.name, type: "buy", price: cost })}>
                      ⚡ post
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>
            Full plan: {plan.picks.length} position{plan.picks.length > 1 ? "s" : ""} · {fmtP(totCost)}p in ·
            expected <b className="gain-pos">+{fmtP(totProfit)}p</b> when they cycle.
          </p>
        </>
      ) : (
        <p className="muted">Nothing to suggest — either no free capital/trades, or live prices are still loading (⏳).</p>
      )}
    </div>
  );
}

// ---------- Simulador ----------

interface SimDay {
  day: number;
  capital: number;
  profit: number;
  positions: { name: string; cost: number; eff: number }[];
}

function simulateDays(flips: Flip[], startCapital: number, tighten: number,
                      rotations: number, mr: number, days: number): SimDay[] {
  const usable = flips
    .filter(f => f.vol48 >= 30)
    .map(f => ({ name: f.name, cost: Math.round(f.buy + tighten * 0.4), eff: f.spread - tighten }))
    .filter(f => f.eff >= 3)
    .sort((a, b) => b.eff - a.eff);
  const maxCycles = Math.floor(mr / 2) * rotations;

  const out: SimDay[] = [];
  let capital = startCapital;
  for (let day = 1; day <= days; day++) {
    let cap = capital;
    const positions: SimDay["positions"] = [];
    const perSet = new Map<string, number>();
    // greedy: mejor margen primero, máx 2 unidades por set por día
    while (positions.length < maxCycles) {
      const pick = usable.find(f => f.cost <= cap && (perSet.get(f.name) ?? 0) < 2);
      if (!pick) break;
      positions.push(pick);
      perSet.set(pick.name, (perSet.get(pick.name) ?? 0) + 1);
      cap -= pick.cost; // el capital queda invertido hasta que rota
    }
    const profit = positions.reduce((a, p) => a + p.eff, 0) * rotations;
    out.push({ day, capital, profit, positions });
    capital += profit;
  }
  return out;
}

function SimulatorCard({ flips, startPlat }: { flips: Flip[]; startPlat: number }) {
  const [capital, setCapital] = useState(startPlat || 95);
  const [tighten, setTighten] = useState(8);
  const [rotations, setRotations] = useState(1);
  const [mr, setMr] = useState(22);

  const sim = useMemo(
    () => simulateDays(flips, capital, tighten, rotations, mr, 7),
    [flips, capital, tighten, rotations, mr]);

  const d1 = sim[0];
  if (!d1) return null;
  const avgMargin = d1.positions.length ? d1.profit / rotations / d1.positions.length : 0;
  const avgSale = d1.positions.length
    ? d1.positions.reduce((a, p) => a + p.cost + p.eff, 0) / d1.positions.length : 0;

  return (
    <div className="card">
      <h2>🧮 Simulator: end-of-day plat</h2>
      <p className="hint">
        Builds a greedy portfolio from the liquid flips your capital affords (max 2 per set),
        trading margin for speed. Assumes every order fills within the day
        — reasonable at 1 cycle/day, optimistic at 2. Credit tax and price wars not included.
      </p>
      <div className="controls">
        <label className="sim-field">Starting capital
          <input type="number" min={10} value={capital} onChange={e => setCapital(+e.target.value || 0)} /> p
        </label>
        <label className="sim-field" title="Spread you give up to be top bidder and cheapest seller (e.g. buy +3, sell -5)">
          Margin given up
          <input type="number" min={0} max={20} value={tighten} onChange={e => setTighten(+e.target.value || 0)} /> p
        </label>
        <label className="sim-field" title="How many times each position cycles per day">Cycles/day
          <select value={rotations} onChange={e => setRotations(+e.target.value)}>
            <option value={1}>1 (realistic)</option>
            <option value={2}>2 (optimistic)</option>
          </select>
        </label>
        <label className="sim-field" title="Daily trade limit = your Mastery Rank">MR
          <input type="number" min={2} max={40} value={mr} onChange={e => setMr(+e.target.value || 2)} />
        </label>
      </div>

      <div className="tiles">
        <Tile value={<span className="gain-pos">{Math.round(d1.capital + d1.profit)}p</span>}
              label={`end of day 1 (starting with ${capital}p)`} />
        <Tile value={`+${Math.round(d1.profit)}p`} label="day-1 profit" />
        <Tile value={`${avgMargin.toFixed(1)}p`} label="avg margin per flip" />
        <Tile value={`${avgSale.toFixed(0)}p`} label="avg sale price" />
        <Tile value={`${d1.positions.length * rotations} de ${Math.floor(mr / 2) * rotations}`} label="flips run / possible" />
      </div>

      <div className="two-col">
        <div>
          <h3 className="sim-h3">Day-1 portfolio</h3>
          <table>
            <tbody>
              {d1.positions.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td className="num">buy ~{p.cost}p</td>
                  <td className="num">sell ~{p.cost + p.eff}p</td>
                  <td className="num gain-pos">+{p.eff.toFixed(0)}p</td>
                </tr>
              ))}
              {!d1.positions.length && (
                <tr><td className="muted">Not enough capital for any liquid flip — lower the margin given up or save more plat.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="sim-h3">Week, reinvesting everything</h3>
          <table>
            <tbody>
              {sim.map(d => (
                <tr key={d.day}>
                  <td>Day {d.day}</td>
                  <td className="num">{Math.round(d.capital)}p</td>
                  <td className="num gain-pos">+{Math.round(d.profit)}p</td>
                  <td className="num"><b>{Math.round(d.capital + d.profit)}p</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------- Cacería ----------

export function HuntView({ relics }: { relics: Relic[] }) {
  const hunts = relics.filter(r => r.hunt && r.jackpot_price >= 10);

  const base: Col<Relic>[] = [
    { key: "relic", label: "Relic", sortVal: r => r.relic, render: r => <>{r.relic} <Vault r={r} /></> },
    { key: "count", label: "Owned", num: true, sortVal: r => r.count, render: r => r.count },
    { key: "jackpot", label: "Top item", sortVal: r => r.jackpot, render: r => <MarketLink name={r.jackpot} /> },
    { key: "price", label: "Price", num: true, sortVal: r => r.jackpot_price, render: r => `${fmtP(r.jackpot_price)}p` },
    { key: "vol", label: "Sales 48h", num: true, sortVal: r => r.jackpot_vol48, render: r => <VolBadge vol={r.jackpot_vol48} /> },
  ];

  const intCols: Col<Relic>[] = [...base,
    { key: "hit", label: "P(hit)", num: true, sortVal: r => r.hunt!.hitInt, render: r => pct(r.hunt!.hitInt) },
    { key: "score", label: "Exp. plat", num: true, sortVal: r => r.hunt!.scoreInt, render: r => <b>{fmtP(r.hunt!.scoreInt)}p</b> },
  ];

  const radCols: Col<Relic>[] = [...base,
    { key: "hit", label: "P(hit)", num: true, sortVal: r => r.hunt!.hitRadshare, render: r => pct(r.hunt!.hitRadshare) },
    { key: "score", label: "Exp. plat", num: true, sortVal: r => r.hunt!.scoreRad, render: r => <b>{fmtP(r.hunt!.scoreRad)}p</b> },
    {
      key: "missing", label: "Need for 95%", num: true, sortVal: r => r.hunt!.missing,
      render: r => r.hunt!.missing === 0 ? "✓ enough"
        : r.vaulted ? <span title="Vaulted, no more drops">~{r.hunt!.missing} ⛔</span>
        : <span title={r.farm ?? ""}>~{r.hunt!.missing} 🌱</span>,
    },
  ];

  return (
    <>
      <p className="hint standalone">
        Real odds of pulling the priciest item <b>with your stock</b>. "Exp. plat" = price × P(hit).
        To ~guarantee (95%) a rare: ~149 intact or ~8 radshares (each radshare crack = 4 rolls).
      </p>
      <div className="two-col">
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
    { key: "price", label: "Price", num: true, sortVal: r => r.jackpot_price, render: r => `${fmtP(r.jackpot_price)}p` },
    { key: "vol", label: "Sales 48h", num: true, sortVal: r => r.jackpot_vol48, render: r => <VolBadge vol={r.jackpot_vol48} /> },
    {
      key: "hit", label: "P(hit) in radshare", num: true,
      title: "Odds of at least one drop cracking YOUR radiants in radshare (4 rolls per crack)",
      sortVal: r => r.hitRad, render: r => pct(r.hitRad),
    },
    {
      key: "score", label: "Exp. plat ▾", num: true,
      title: "Rare price × odds with your radiants",
      sortVal: r => r.scoreRad, render: r => <b>{fmtP(r.scoreRad)}p</b>,
    },
  ];

  return (
    <div className="card">
      <h2>🔆 Radiants ready to crack
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
    { key: "evi", label: "Intact EV", num: true, sortVal: r => r.ev_intact, render: r => fmtP(r.ev_intact) },
    { key: "evr", label: "Radiant EV", num: true, sortVal: r => r.ev_radiant, render: r => fmtP(r.ev_radiant) },
    {
      key: "gain", label: "Refine gain", num: true, sortVal: r => r.gain,
      render: r => <span className={r.gain >= 2.5 ? "gain-pos" : ""}>+{fmtP(r.gain)}</span>,
    },
    { key: "jp", label: "Top item", num: true, sortVal: r => r.jackpot_price, render: r => `${fmtP(r.jackpot_price)}p` },
    {
      key: "bucket", label: "Recommendation", sortVal: r => r.bucket,
      render: r => (
        <Tag kind={r.bucket === "junk" ? "" : r.bucket}>
          {BUCKET_LABEL[r.bucket]}{r.bucket === "sell" ? ` ~${fmtP(r.relic_price)}p` : ""}
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
          ? <>⛔ vaulted, no longer drops</>
          : <>🌱 farm: {r.farm ?? "?"} ({r.farm_chance ?? "?"}%)</>}
        {r.relic_price > 0 && (
          <> · 💰 whole relic lists at ~{fmtP(r.relic_price)}p —{" "}
            <MarketLink slug={slugOf(`${r.relic} relic`)}>see buyers ↗</MarketLink></>
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
              <td className="num">{d.price ? `${fmtP(d.price)}p` : "—"}</td>
              <td className="num">{d.med48 ? `${fmtP(d.med48)}p` : "—"}</td>
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

// ---------- Ventas ----------

export function SalesView({ sales }: { sales: Sale[] }) {
  const cols: Col<Sale>[] = [
    { key: "ts", label: "Date", sortVal: s => s.ts ?? "", render: s => s.ts?.slice(0, 10) },
    { key: "items", label: "Sold", render: s => <span className="wrap-cell">{s.items}{s.partial ? " *" : ""}</span> },
    { key: "plat", label: "You got", num: true, sortVal: s => s.plat, render: s => `${s.plat}p` },
    { key: "now", label: "Worth today", num: true, sortVal: s => s.market_now, render: s => `${fmtP(s.market_now)}p` },
    {
      key: "diff", label: "Diff", num: true, sortVal: s => s.plat - s.market_now,
      render: s => {
        const d = s.plat - s.market_now;
        return <span className={d >= 0 ? "gain-pos" : "loss"}>{d >= 0 ? "+" : ""}{fmtP(d)}p</span>;
      },
    },
  ];
  return (
    <div className="card">
      <h2>Your sales vs current market</h2>
      <p className="hint">Plat sales from your history vs <b>today’s</b> price (not the trade-day price). Red = worth much more today than you got.</p>
      <DataTable cols={cols} rows={sales} defaultSort="ts" maxRows={25} />
    </div>
  );
}
