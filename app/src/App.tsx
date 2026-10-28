import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Flip, HistoryPoint, Relic, Report } from "./types";
import { currentPlat, loadData, prepareRelics, type ReportError } from "./lib";
import { getJwt, getPreviewMode, getUser, isAdmin, onAuthChange, setPlatOverride, setPreviewMode, syncLedger, syncPremiumStatus } from "./wfm";
import { useGameRunning, useGameStatusReminder } from "./live";
import { DucatsView, FlipsView, HuntView, RelicsView, SummaryView } from "./components/views";
import { OrdersView } from "./components/OrdersView";
import { AuthStatus, Composer } from "./components/Composer";
import { Landing } from "./components/Landing";
import { TierModal } from "./components/TierModal";
import { ErrorBoundary, Plat } from "./components/ui";
import {
  CircleOff, ClipboardList, Coins, Eye, Gamepad2, LayoutDashboard, Link2, Lock, Package,
  RefreshCw, Repeat, Target, X,
} from "lucide-react";

const ALECA_BANNER_KEY = "aleca_banner_dismissed_v1";

const TABS = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "flips", label: "Flips", Icon: Repeat },
  { id: "orders", label: "My Orders", Icon: ClipboardList },
  { id: "hunt", label: "Relic Hunt", Icon: Target },
  { id: "relics", label: "Relics", Icon: Package },
  { id: "ducats", label: "Ducats", Icon: Coins },
] as const;

type TabId = (typeof TABS)[number]["id"];

// Tabs that need the AlecaFrame report. Without a token they still show
// (locked) so people know they exist — the connect prompt lives inside the
// tab, at the moment someone actually wants that feature, instead of a
// blocking screen right after login.
const ALECA_TABS: ReadonlySet<TabId> = new Set(["overview", "hunt", "relics", "ducats"]);

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

/** Shown inside a locked tab when /api/report finds no saved token for this
 *  wfm_user_id — each user stores their own (there's no global
 *  ALECA_PUBLIC_TOKEN in .env anymore). Flips/My Orders don't need it, so
 *  this never blocks the whole app. */
function AlecaConnect({ onSaved }: { onSaved: () => void }) {
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
    <div className="aleca-connect">
      <div className="aleca-connect-icon"><Lock size={28} /></div>
      <h2>Connect AlecaFrame</h2>
      <p>
        This tab works with your in-game items and trade history, synced from AlecaFrame,
        to show you what they're worth and what to do with them.
      </p>
      <ol className="aleca-connect-steps">
        <li>Open AlecaFrame and go to the <b>Stats</b> tab</li>
        <li>Click <b>Create Public Link</b></li>
        <li>Paste the token below</li>
      </ol>
      <div className="aleca-connect-form">
        <input type="text" placeholder="AlecaFrame public token" value={token}
               onChange={e => setToken(e.target.value)}
               onKeyDown={e => e.key === "Enter" && !busy && token.trim() && save()} />
        <button className="btn primary" disabled={busy || !token.trim()} onClick={save}>
          {busy ? "saving…" : "Connect"}
        </button>
      </div>
      {err && <p className="loss">{err}</p>}
      <p className="hint">Optional — Flips and My Orders work without it. Saved once, just for your account.</p>
    </div>
  );
}

/** One-time, dismissible heads-up that AlecaFrame exists — once closed it
 *  never comes back; the locked tabs stay for anyone who looks later. */
function AlecaBanner({ onOpen }: { onOpen: () => void }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(ALECA_BANNER_KEY) === "1");
  if (dismissed) return null;
  const dismiss = () => { localStorage.setItem(ALECA_BANNER_KEY, "1"); setDismissed(true); };
  return (
    <div className="patreon-banner aleca-banner">
      <span>
        <Link2 size={14} className="inline-icon" /> Tip: connect AlecaFrame to unlock relic analysis and your profit history.{" "}
        <button className="linkish" onClick={() => { dismiss(); onOpen(); }}>Connect →</button>
      </span>
      <button className="linkish" onClick={dismiss} title="Dismiss" aria-label="Dismiss"><X size={14} /></button>
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
  const [reportError, setReportError] = useState<ReportError | null>(
    () => (getJwt() ? null : "not_signed_in")
  );
  const [flips, setFlips] = useState<Flip[]>([]);
  const [flipsTs, setFlipsTs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>(() => {
    const fromPath = location.pathname.slice(1) as TabId;
    // Flips, not Overview: it works without AlecaFrame, so nobody lands on a locked tab.
    return TABS.some(t => t.id === fromPath) ? fromPath : "flips";
  });

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
    // reintenta solo al conectar/desconectar wfm; al conectar, Flips es lo
    // primero útil (no necesita AlecaFrame) — no el tab por default. Solo en
    // la transición sin sesión -> con sesión: el mismo pub/sub también avisa
    // cambios de premium/preview, y eso no te tiene que sacar del tab.
    let wasSignedIn = !!getJwt();
    return onAuthChange(() => {
      const signedIn = !!getJwt();
      if (signedIn && !wasSignedIn) setTab("flips");
      // Sign out: al landing ya, sin esperar a que refresh() vuelva de
      // /api/flips — si no, el dashboard queda visible un rato sin sesión.
      if (!signedIn && wasSignedIn) { setReport(null); setReportError("not_signed_in"); }
      wasSignedIn = signedIn;
      refresh();
    });
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
  // returns de abajo (error/not_signed_in/loading).
  const dashboardVisible = !error
    && reportError !== "not_signed_in"
    && !(reportError && reportError !== "no_aleca_token")
    && !(!report && !reportError);
  // Y al revés: si entrás a /orders sin sesión (link viejo, o te
  // desconectaste parado ahí), el landing no puede quedar con esa ruta. Se
  // limpia solo fuera del loading, para no pisar el deep link mientras carga
  // — el tab ya quedó leído del path al montar.
  const loading = !report && !reportError && !error;
  useEffect(() => {
    if (dashboardVisible) history.replaceState(null, "", "/" + tab);
    else if (!loading && location.pathname !== "/") history.replaceState(null, "", "/");
  }, [tab, dashboardVisible, loading]);

  const gameRunning = useGameRunning();
  const gameReminder = useGameStatusReminder(gameRunning);

  const relics: Relic[] = useMemo(
    () => (report ? prepareRelics(report.relics) : []), [report]);

  if (error) return <div className="wrap"><div className="card error">{error}</div></div>;
  if (reportError === "not_signed_in") {
    return <Landing />;
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

  // Without AlecaFrame only Flips/My Orders work — the other tabs need
  // relics/history we don't have and show AlecaConnect instead. plat starts
  // at 0 and can be set by hand (PlatBadge already handles report=null).
  const last = report?.history?.length ? report.history[report.history.length - 1] : null;
  const plat = currentPlat(last?.plat ?? 0);
  const activeTab = tab;
  const locked = !report && ALECA_TABS.has(activeTab);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">NinjaFlip</div>
        <nav className="sidebar-nav">
          {TABS.map(t => {
            const tabLocked = !report && ALECA_TABS.has(t.id);
            return (
              <button key={t.id}
                      className={`sidebar-tab ${activeTab === t.id ? "active" : ""} ${tabLocked ? "locked" : ""}`}
                      title={tabLocked ? "Requires AlecaFrame (optional)" : undefined}
                      onClick={() => setTab(t.id)}>
                <t.Icon size={15} strokeWidth={2} /> {t.label}
                {tabLocked && <Lock size={12} className="sidebar-tab-lock" />}
              </button>
            );
          })}
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
              {[
                last && <>MR {last.mr} · {(last.credits / 1e6).toFixed(1)}M credits · {last.ducats} ducats</>,
                gameRunning != null && (gameRunning
                  ? <><Gamepad2 size={13} className="inline-icon" /> game running</>
                  : <><CircleOff size={13} className="inline-icon" /> game closed</>),
                gameReminder,
                report && <>data from {new Date(report.generated_ts * 1000).toLocaleString()}</>,
                report && (
                  <button className="linkish" disabled={refreshing} onClick={() => refresh({ refresh: true })}
                          title="Just closed a trade? This skips the 15-min cache and re-checks AlecaFrame now">
                    <RefreshCw size={12} className={`inline-icon ${refreshing ? "spin" : ""}`} /> {refreshing ? "refreshing…" : "refresh"}
                  </button>
                ),
              ].filter(Boolean).map((part, i) => <Fragment key={i}>{i > 0 && " · "}{part}</Fragment>)}
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
        {!report && <AlecaBanner onOpen={() => setTab("overview")} />}
        <Composer />

        <main className="main-content">
          {locked && <AlecaConnect onSaved={refresh} />}
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
          {" "}· <span title="Click to copy Discord username" onClick={() => { navigator.clipboard.writeText("brollix"); alert("Discord username 'brollix' copied to clipboard!"); }} style={{ cursor: "pointer", textDecoration: "underline" }}>Discord (brollix)</span>
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
    <ErrorBoundary>
      <UpdateBanner />
      <AppInner />
    </ErrorBoundary>
  );
}
