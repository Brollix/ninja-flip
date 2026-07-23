import { useEffect, useMemo, useState } from "react";
import type { Flip, HistoryPoint, Relic, Report } from "./types";
import { loadData, prepareRelics } from "./lib";
import { syncLedger } from "./wfm";
import { DucatsView, FlipsView, HuntView, RelicsView, SalesView, SummaryView } from "./components/views";
import { OrdersView } from "./components/OrdersView";
import { Composer, openComposer } from "./components/Composer";

const TABS = [
  { id: "resumen", label: "📊 Overview" },
  { id: "flips", label: "💱 Flips" },
  { id: "ordenes", label: "🗂 My Orders" },
  { id: "caceria", label: "🎯 Relic Hunt" },
  { id: "reliquias", label: "📦 Relics" },
  { id: "ducados", label: "🪙 Ducats" },
  { id: "ventas", label: "🧾 Sales" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Plat del header: snapshot de AlecaFrame, corregible a mano (click)
 *  hasta que llegue un snapshot más nuevo que lo pise. */
function PlatBadge({ last }: { last: HistoryPoint }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(0);
  const [, force] = useState(0);

  useEffect(() => {
    const handler = () => force(x => x + 1);
    window.addEventListener("plat:changed", handler);
    window.addEventListener("orders:changed", handler);
    return () => {
      window.removeEventListener("plat:changed", handler);
      window.removeEventListener("orders:changed", handler);
    };
  }, []);

  const snapTs = new Date(last.ts).getTime();
  let override: { value: number; ts: number } | null = null;
  try { override = JSON.parse(localStorage.getItem("plat_override") ?? "null"); } catch { /* noop */ }
  const shown = override && override.ts > snapTs ? override.value : last.plat;

  const save = () => {
    if (val >= 0) {
      localStorage.setItem("plat_override", JSON.stringify({ value: Math.round(val), ts: Date.now() }));
      window.dispatchEvent(new CustomEvent("plat:changed"));
      force(x => x + 1);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input type="number" min={0} autoFocus className="basis-input" value={val || ""}
             onChange={e => setVal(+e.target.value || 0)}
             onBlur={save}
             onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
    );
  }
  return (
    <button className="linkish plat" title="Click to correct — auto-resets on the next AlecaFrame snapshot"
            onClick={() => { setVal(shown); setEditing(true); }}>
      <b>{shown}p</b>{override && override.ts > snapTs ? " ✎" : ""}
    </button>
  );
}

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [flips, setFlips] = useState<Flip[]>([]);
  const [flipsTs, setFlipsTs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(
    (location.hash.slice(1) as TabId) || "resumen");

  useEffect(() => {
    syncLedger()
      .then(() => loadData())
      .then(d => { setReport(d.report); setFlips(d.flips); setFlipsTs(d.flipsTs); })
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => { location.hash = tab; }, [tab]);

  const relics: Relic[] = useMemo(
    () => (report ? prepareRelics(report.relics) : []), [report]);

  if (error) return <div className="wrap"><div className="card error">{error}</div></div>;
  if (!report) {
    return (
      <div className="wrap">
        <div className="skeleton title" />
        <div className="tiles">{[...Array(6)].map((_, i) => <div key={i} className="skeleton tile-sk" />)}</div>
        <div className="skeleton block" />
      </div>
    );
  }
  const last = report.history?.length ? report.history[report.history.length - 1] : null;

  return (
    <div className="wrap">
      <header className="header">
        <div>
          <h1>Warframe · Platinum Trader</h1>
          <div className="sub">
            {report.username ?? "?"}
            {last && <> · <PlatBadge last={last} /> · MR {last.mr} · {(last.credits / 1e6).toFixed(1)}M credits · {last.ducats} ducats</>}
            {" "}· data from {new Date(report.generated_ts * 1000).toLocaleString()}
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(t => (
            <button key={t.id}
                    className={`tab ${tab === t.id ? "active" : ""}`}
                    onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <button className="tab publish" onClick={() => openComposer()}>➕ Post Order</button>
        </nav>
      </header>
      <Composer />

      {tab === "resumen" && <SummaryView relics={relics} sales={report.sales} history={report.history ?? []} />}
      {tab === "flips" && <FlipsView flips={flips} flipsTs={flipsTs} startPlat={last?.plat ?? 95} />}
      {tab === "ordenes" && <OrdersView defaultUser={report.username ?? ""} basePlat={last?.plat ?? 0} />}
      {tab === "caceria" && <HuntView relics={relics} />}
      {tab === "reliquias" && <RelicsView relics={relics} />}
      {tab === "ducados" && <DucatsView relics={relics} />}
      {tab === "ventas" && <SalesView sales={report.sales} />}

      <footer className="foot">
        Rare drop: 2% intact → 10% radiant (34.4% in a 4-man radshare) · prices = avg of 3 cheapest online sells ·
        refresh data: <code>python scripts/relic_analysis.py --refresh && python scripts/flips.py --parts 12</code>
      </footer>
    </div>
  );
}
