import { useEffect, useMemo, useRef, useState } from "react";
import type { Flip, HistoryPoint, Relic, Report } from "./types";
import { currentPlat, loadData, prepareRelics, type ReportError } from "./lib";
import { getJwt, getPreviewMode, getUser, isAdmin, onAuthChange, setPlatOverride, setPreviewMode, syncLedger, syncPremiumStatus } from "./wfm";
import { useGameRunning, useGameStatusReminder } from "./live";
import { DucatsView, FlipsView, HuntView, RelicsView, SummaryView } from "./components/views";
import { OrdersView } from "./components/OrdersView";
import { AuthStatus, Composer } from "./components/Composer";
import { Landing } from "./components/Landing";
import { PeakTimeBadge } from "./components/PeakTime";
import { TierModal } from "./components/TierModal";
import { Plat } from "./components/ui";
import {
  Check, CircleOff, ClipboardList, Coins, Eye, Gamepad2, LayoutDashboard, Link2, Package,
  RefreshCw, Repeat, Target,
} from "lucide-react";

const ALECA_SKIP_KEY = "aleca_skip_v1";
// Pausa temporal: no se ofrece conectar AlecaFrame por ahora (nadie nuevo ve
// el prompt ni el link de "connect AlecaFrame"). Nada del backend cambia —
// /api/report sigue andando igual para quien YA tenga un token guardado
// (vos, tu amigo), esto solo apaga la puerta de entrada para gente nueva.
// Para reactivar: volver esto a true.
const ALECAFRAME_ENABLED = false;

const TABS = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "flips", label: "Flips", Icon: Repeat },
  { id: "orders", label: "My Orders", Icon: ClipboardList },
  { id: "hunt", label: "Relic Hunt", Icon: Target },
  { id: "relics", label: "Relics", Icon: Package },
  { id: "ducats", label: "Ducats", Icon: Coins },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Solo visible para el admin (ver ALWAYS_PREMIUM_SLUGS/ADMIN_SLUGS en wfm.ts)
 *  — no hay Patreon conectado todavía, así que esto deja previsualizar cómo
 *  se ve la app en basic vs premium sin tener que armar una cuenta de prueba. */
function AdminPreviewToggle() {
  const [, force] = useState(0);
  useEffect(() => onAuthChange(() => force(x => x + 1)), []);
  if (!isAdmin()) return null;
  const mode = getPreviewMode();
  const pick = (m: "basic" | "premium" | null) => setPreviewMode(m);
  return (
    <div className="admin-preview">
      <div className="admin-preview-label"><Eye size={12} /> Admin preview</div>
      <div className="admin-preview-btns">
        <button className={`chip ${mode === null ? "active" : ""}`} onClick={() => pick(null)}>Real</button>
        <button className={`chip ${mode === "basic" ? "active" : ""}`} onClick={() => pick("basic")}>Basic</button>
        <button className={`chip ${mode === "premium" ? "active" : ""}`} onClick={() => pick("premium")}>Premium</button>
      </div>
    </div>
  );
}

/** Plat del header: no depende de AlecaFrame para nada — arranca de un valor
 *  que vos cargás una vez a mano (click) y desde ahí se mantiene solo:
 *  cada 🛒 bought / 💰 sold en "My Orders" lo ajusta automáticamente
 *  (adjustPlat, en wfm.ts). Si hay un snapshot viejo de report.json y todavía
 *  no cargaste nada a mano, lo usa como punto de partida nada más. */
function PlatBadge({ last }: { last: HistoryPoint | null }) {
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

  let override: { value: number; ts: number } | null = null;
  try { override = JSON.parse(localStorage.getItem("plat_override") ?? "null"); } catch { /* noop */ }
  const shown = currentPlat(last?.plat ?? 0);

  const save = () => {
    if (val >= 0) {
      setPlatOverride(val);
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
    <button className="linkish plat"
            title={override ? "Click to correct — auto-updates on every bought/sold you confirm" : "Click to set your current platinum"}
            onClick={() => { setVal(shown); setEditing(true); }}>
      <b><Plat value={shown} /></b>{!override && last && " (from last AlecaFrame scan — click to set exactly)"}
    </button>
  );
}

/** Se pega cuando /api/report todavía no encuentra un token guardado para
 *  este wfm_user_id — reemplaza el ALECA_PUBLIC_TOKEN único y global que
 *  antes vivía en .env: ahora cada usuario carga el suyo. Se puede saltear
 *  y cargar después — no bloquea Flips/My Orders, que no necesitan AlecaFrame
 *  para nada. AuthStatus arriba confirma que la conexión a warframe.market
 *  sí funcionó (si no hubiese funcionado, ni se habría llegado a esta
 *  pantalla — /api/report exige sesión de wfm antes que nada). */
function AlecaTokenPrompt({ onSaved, onSkip }: { onSaved: () => void; onSkip: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const jwt = getJwt();
    if (!jwt || !token.trim()) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/aleca-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="card-head">
          <h2><Link2 size={16} /> Connect your AlecaFrame account</h2>
          <AuthStatus />
        </div>
        <p className="hint">
          <Check size={13} className="inline-icon" /> Your warframe.market login worked — that's what got you here. Now paste your{" "}
          <b>public link token</b> from AlecaFrame's Stats tab ("Create Public Link") to power your
          relic inventory, history and sales. Saved once, just for your account.
        </p>
        <div className="composer-fields">
          <input type="text" placeholder="public token" value={token}
                 onChange={e => setToken(e.target.value)}
                 onKeyDown={e => e.key === "Enter" && !busy && token.trim() && save()}
                 style={{ minWidth: 420 }} />
          <button className="btn primary" disabled={busy || !token.trim()} onClick={save}>
            {busy ? "saving…" : "Save"}
          </button>
        </div>
        {err && <p className="loss">{err}</p>}
        <p className="hint" style={{ marginTop: 8 }}>
          Don't have it handy? <button className="linkish" onClick={onSkip}>Skip for now</button> —
          you can still trade (Flips, My Orders) and connect AlecaFrame later.
        </p>
      </div>
    </div>
  );
}

const VERSION_POLL_MS = 3 * 60 * 1000; // cada 3 min alcanza — no es algo urgente

/** El server calcula un hash del index.html que sirve (server/src/index.ts) —
 *  cambia solo cuando hay un deploy de verdad nuevo. Comparamos contra el
 *  que teníamos al cargar la página; si difiere, alguien pisó esta versión
 *  mientras la tenías abierta — nada de alert(), un banner que se queda
 *  hasta que recargues (no auto-recarga sola: te puede cortar algo a mitad). */
function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const initialVersion = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    const check = () => {
      fetch("/api/version", { cache: "no-store" })
        .then(r => r.json())
        .then((d: { version?: string }) => {
          if (stop || !d.version) return;
          if (initialVersion.current === null) initialVersion.current = d.version;
          else if (d.version !== initialVersion.current) setAvailable(true);
        })
        .catch(() => { /* sin red / server caído: no molestamos con esto */ });
    };
    check();
    const id = setInterval(check, VERSION_POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, []);

  if (!available) return null;
  return (
    <div className="update-banner">
      <RefreshCw size={14} className="inline-icon" /> A new version of this page is available.{" "}
      <button className="btn primary" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

function AppInner() {
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<ReportError | null>(null);
  const [flips, setFlips] = useState<Flip[]>([]);
  const [flipsTs, setFlipsTs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(() => {
    const fromPath = location.pathname.slice(1) as TabId;
    return TABS.some(t => t.id === fromPath) ? fromPath : "overview";
  });
  const [alecaSkipped, setAlecaSkipped] = useState(
    () => !ALECAFRAME_ENABLED || localStorage.getItem(ALECA_SKIP_KEY) === "1");

  // Vuelta del login con Patreon (ver premium.ts callback -> redirect a
  // "/?patreon=..."): leemos el resultado una vez y limpiamos el query string
  // para que no quede pegado si recargás o compartís el link.
  const [patreonStatus] = useState<"connected" | "not_a_patron" | "error" | null>(
    () => new URLSearchParams(location.search).get("patreon") as never);
  const [patreonMsg, setPatreonMsg] = useState<string | null>(() => {
    if (patreonStatus === "connected") return "✓ Patreon connected — premium unlocked.";
    if (patreonStatus === "not_a_patron") return "That Patreon account isn't an active patron of this campaign yet.";
    if (patreonStatus === "error") return "Patreon connection failed — try again.";
    return null;
  });
  const [showTiers, setShowTiers] = useState(false);
  useEffect(() => {
    if (!patreonMsg) return;
    history.replaceState(null, "", location.pathname);
    // "not_a_patron" se queda puesto — es clickeable (abre los tiers) y no
    // tiene sentido que desaparezca solo antes de que alguien lo note.
    if (patreonStatus === "not_a_patron") return;
    const t = setTimeout(() => setPatreonMsg(null), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = (opts: { refresh?: boolean } = {}) => {
    if (opts.refresh) setRefreshing(true);
    // loadData() PRIMERO: /api/report es quien hace que report_server.py
    // recalcule y guarde user_detected_flips — si syncLedger() (que trae
    // esos detected flips vía /ledger/all) corre antes, siempre lee la
    // foto vieja de esa tabla, un paso atrás del refresh que acabás de pedir.
    loadData(opts)
      .then(d => {
        setReport(d.report); setReportError(d.reportError);
        setFlips(d.flips); setFlipsTs(d.flipsTs);
        return Promise.all([syncLedger(), syncPremiumStatus()]);
      })
      .catch(e => setError(String(e)))
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    refresh();
    return onAuthChange(refresh); // reintenta solo al conectar/desconectar wfm
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ruta limpia (/ordenes, /flips) en vez de #hash — el server ya sirve el
  // SPA para cualquier path (ver server/src/index.ts), así que esto
  // funciona sin nada más. replaceState, no pushState: cambiar de tab no
  // debería llenarte el botón "atrás" del navegador de pasos.
  // Ojo: esto NO tiene que correr mientras se muestra el Landing/loading/
  // error — si no, la URL queda en "/overview" (el tab por default) para
  // cualquiera que entra sin cuenta conectada, aunque lo que ve sea el
  // landing. dashboardVisible espeja las mismas condiciones de los early
  // returns de abajo (error/not_signed_in/no_aleca_token/loading).
  const dashboardVisible = !error
    && reportError !== "not_signed_in"
    && !(reportError === "no_aleca_token" && !alecaSkipped)
    && !(reportError && reportError !== "no_aleca_token")
    && !(!report && !reportError);
  useEffect(() => {
    if (dashboardVisible) history.replaceState(null, "", "/" + tab);
  }, [tab, dashboardVisible]);

  const gameRunning = useGameRunning();
  const gameReminder = useGameStatusReminder(gameRunning);

  const relics: Relic[] = useMemo(
    () => (report ? prepareRelics(report.relics) : []), [report]);

  if (error) return <div className="wrap"><div className="card error">{error}</div></div>;
  if (reportError === "not_signed_in") {
    return <Landing />;
  }
  if (reportError === "no_aleca_token" && !alecaSkipped) {
    return (
      <AlecaTokenPrompt
        onSaved={refresh}
        onSkip={() => { localStorage.setItem(ALECA_SKIP_KEY, "1"); setAlecaSkipped(true); }}
      />
    );
  }
  if (reportError && reportError !== "no_aleca_token") {
    return <div className="wrap"><div className="card error">{reportError}</div></div>;
  }
  if (!report && !reportError) {
    return (
      <div className="wrap">
        <div className="skeleton title" />
        <div className="tiles">{[...Array(6)].map((_, i) => <div key={i} className="skeleton tile-sk" />)}</div>
        <div className="skeleton block" />
      </div>
    );
  }

  // Sin AlecaFrame (saltaste el paso) solo Flips/My Orders funcionan — el
  // resto necesita reliquias/historial que no tenemos. plat arranca en 0 y
  // te dejo cargarlo a mano (PlatBadge ya soporta report=null).
  const last = report?.history?.length ? report.history[report.history.length - 1] : null;
  const plat = currentPlat(last?.plat ?? 0);
  const availableTabs = report ? TABS : TABS.filter(t => t.id === "flips" || t.id === "orders");
  const activeTab = availableTabs.some(t => t.id === tab) ? tab : "flips";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">NinjaFlip</div>
        <nav className="sidebar-nav">
          {availableTabs.map(t => (
            <button key={t.id}
                    className={`sidebar-tab ${activeTab === t.id ? "active" : ""}`}
                    onClick={() => setTab(t.id)}>
              <t.Icon size={15} strokeWidth={2} /> {t.label}
            </button>
          ))}
        </nav>
        <AdminPreviewToggle />
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="topbar-left">
              <AuthStatus />
              <span className="topbar-plat">· <PlatBadge last={last} /></span>
            </div>
            <div className="topbar-right sub">
              <PeakTimeBadge />
              {last && <> · MR {last.mr} · {(last.credits / 1e6).toFixed(1)}M credits · {last.ducats} ducats</>}
              {gameRunning != null && (
                <> · {gameRunning
                  ? <><Gamepad2 size={13} className="inline-icon" /> game running</>
                  : <><CircleOff size={13} className="inline-icon" /> game closed</>}</>
              )}
              {gameReminder && <> · {gameReminder}</>}
              {report && (
                <>
                  {" "}· data from {new Date(report.generated_ts * 1000).toLocaleString()}
                  {" "}· <button className="linkish" disabled={refreshing} onClick={() => refresh({ refresh: true })}
                                  title="Just closed a trade? This skips the 15-min cache and re-checks AlecaFrame now">
                    <RefreshCw size={12} className={`inline-icon ${refreshing ? "spin" : ""}`} /> {refreshing ? "refreshing…" : "refresh"}
                  </button>
                </>
              )}
              {!report && ALECAFRAME_ENABLED && (
                <> · <button className="linkish" onClick={() => {
                  localStorage.removeItem(ALECA_SKIP_KEY); setAlecaSkipped(false);
                }}><Link2 size={12} className="inline-icon" /> connect AlecaFrame</button></>
              )}
            </div>
          </div>
        </header>
        {patreonMsg && (
          patreonStatus === "not_a_patron" ? (
            <button className="patreon-banner clickable" onClick={() => setShowTiers(true)}>
              {patreonMsg} <span className="patreon-banner-cta">See what Premium unlocks →</span>
            </button>
          ) : (
            <div className="patreon-banner">{patreonMsg}</div>
          )
        )}
        {showTiers && <TierModal onClose={() => setShowTiers(false)} />}
        <Composer />

        <main className="main-content">
          {activeTab === "overview" && report && <SummaryView relics={relics} sales={report.sales} history={report.history ?? []} />}
          {activeTab === "flips" && <FlipsView flips={flips} flipsTs={flipsTs} startPlat={plat} />}
          {activeTab === "orders" && <OrdersView defaultUser={report?.username ?? getUser()?.ingame_name ?? ""} basePlat={plat} unsoldPurchases={report?.unsold_purchases ?? []} flips={flips} />}
          {activeTab === "hunt" && report && <HuntView relics={relics} />}
          {activeTab === "relics" && report && <RelicsView relics={relics} />}
          {activeTab === "ducats" && report && <DucatsView relics={relics} />}
        </main>
        <footer className="app-footer">
          made by <a href="https://warframe.market/profile/brollix" target="_blank" rel="noreferrer">Brollix</a>
          {" "}· <a href="https://www.patreon.com/c/ninjaflip" target="_blank" rel="noreferrer">Patreon</a>
        </footer>
      </div>
    </div>
  );
}

// UpdateBanner vive afuera de AppInner (que corta temprano en varios estados
// — sin conectar, sin token de AlecaFrame, cargando, error) para que avise
// de una versión nueva SIEMPRE, no solo cuando llegaste a la pantalla final.
export default function App() {
  return (
    <>
      <UpdateBanner />
      <AppInner />
    </>
  );
}
