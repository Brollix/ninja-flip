import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, Copy, Flag, HandCoins, Lock, Pause, Pencil, Play, RefreshCw, ShoppingCart,
  SquarePen, Trash2, TrendingUp, X, Zap,
} from "lucide-react";
import { fmtP, prettyItemName, resolveTradeInfo, wfmFetch } from "../lib";
import type { Flip, Purchase } from "../types";
import { CopyBtn, MarketLink, Plat, Tag, Tile } from "./ui";
import { LoginForm, openComposer, type OrderChangeDetail } from "./Composer";
import { usePeakTime } from "./PeakTime";
import { bulkQty, perTradeProfit } from "./views";
import { adjustPlat, closeOrder, createOrder, deleteOrder, fetchMyOrders, getAllFlips, getCostBasis, isConnected, isPremium, loadItems, logFlip, onAuthChange, removeCostBasis, resolveItemByName, setCostBasis, setOrderVisible, updateOrder, type FlipRecord } from "../wfm";

interface RawOrder {
  id: string;
  type: "buy" | "sell";
  platinum: number;
  quantity: number;
  perTrade?: number;
  visible: boolean;
  updatedAt: string;
  itemId: string;
  rank?: number;
  subtype?: string;
}

interface TopOrder {
  type?: "buy" | "sell";
  platinum: number;
  perTrade?: number;
  rank?: number;
  subtype?: string;
  user?: { status?: string; slug?: string };
}

interface CheckedOrder {
  id: string;
  type: "buy" | "sell";
  price: number;
  qty: number;
  slug: string;
  name: string;
  itemId: string;
  bestOtherBuy: number | null;
  bestOtherSell: number | null;
  /** mejores órdenes de usuarios offline (visibles en el sitio) si superan a las online */
  offlineBuy: number | null;
  offlineSell: number | null;
  ok: boolean;
  advice: string;
  copyMsg: string | null;
  fixPrice: number | null;
  /** para WTB: a cuánto revender (1p abajo del vendedor más barato) */
  resellAt: number | null;
  hidden: boolean;
  /** para WTS armadas desde una compra: lo que pagaste */
  costBasis: number | null;
}

const unit = (o: TopOrder) => o.platinum / Math.max(o.perTrade ?? 1, 1);
// solo "online in game": los únicos tradeables al instante
const online = (o: TopOrder) =>
  o.user?.status === "ingame";

// cache local: la pestaña abre al instante con el último chequeo conocido
const CACHE_KEY = "orders_cache_v2";
// Si el cache tiene menos de esto, el montaje inicial NO vuelve a pegarle a
// warframe.market (1 request por orden, ver checkOneOrder) — solo pinta lo
// que ya había. Sin esto, cada recarga de la pestaña (probar un fix, F5 de
// más, etc.) repetía el sweep completo aunque el anterior tuviera segundos.
// El timer de auto-refresh (autoMin) sigue corriendo normal después.
const MOUNT_SKIP_IF_FRESHER_THAN_MS = 45_000;

function readCache(): { ts: number; orders: CheckedOrder[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(orders: CheckedOrder[]): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), orders }));
}

/** Chequea UNA orden contra el libro completo del item (1 sola llamada a la
 *  API). Separado de checkOrders() para poder chequear solo la orden que
 *  acabás de postear/editar, en vez de re-escanear todas cada vez. */
async function checkOneOrder(o: RawOrder, slug: string, name: string,
                             userSlug: string): Promise<CheckedOrder | null> {
  // el endpoint /top solo trae usuarios online: usamos el libro COMPLETO
  // para no perder órdenes de gente offline (visibles en el sitio)
  const res2 = await wfmFetch(`/wfm/v2/orders/item/${slug}`);
  if (!res2.ok) return null;
  const all = ((await res2.json()).data as TopOrder[])
    .filter(x => x.user?.slug !== userSlug);
  const myRank = o.rank ?? 0;
  const pick = (type: "buy" | "sell", onlyOnline: boolean) =>
    all.filter(x => x.type === type && (x.rank ?? 0) === myRank &&
                    x.subtype === o.subtype &&
                    (!onlyOnline || online(x))).map(unit);
  const buys = pick("buy", true), sells = pick("sell", true);
  const allBuys = pick("buy", false), allSells = pick("sell", false);
  const bestOtherBuy = buys.length ? Math.max(...buys) : null;
  const bestOtherSell = sells.length ? Math.min(...sells) : null;
  const bestAnyBuy = allBuys.length ? Math.max(...allBuys) : null;
  const bestAnySell = allSells.length ? Math.min(...allSells) : null;
  // solo interesa la offline si mejora a la mejor online
  const offlineBuy = bestAnyBuy !== null && (bestOtherBuy === null || bestAnyBuy > bestOtherBuy)
    ? bestAnyBuy : null;
  const offlineSell = bestAnySell !== null && (bestOtherSell === null || bestAnySell < bestOtherSell)
    ? bestAnySell : null;
  const price = o.platinum / Math.max(o.perTrade ?? 1, 1);

  return buildChecked(o, slug, name, price, bestOtherBuy, bestOtherSell, offlineBuy, offlineSell);
}

/** Arma el CheckedOrder (ok/advice/copyMsg/fixPrice/resellAt) a partir del
 *  precio y de las puntas rivales — sin pegarle a la API. Se reusa tanto
 *  para un chequeo fresco (checkOneOrder) como para recalcular localmente
 *  cuando solo cambió TU precio (editar una orden no cambia a los rivales). */
function buildChecked(o: RawOrder, slug: string, name: string, price: number,
                      bestOtherBuy: number | null, bestOtherSell: number | null,
                      offlineBuy: number | null, offlineSell: number | null): CheckedOrder {
  let ok: boolean, advice: string, copyMsg: string | null = null,
      fixPrice: number | null = null;
  if (o.type === "buy") {
    ok = bestOtherBuy === null || price >= bestOtherBuy;
    const target = bestOtherBuy !== null ? Math.round(bestOtherBuy + 1) : null;
    advice = ok
      ? `first in line ✓${bestOtherBuy != null ? ` · next online buyer pays ${fmtP(bestOtherBuy)}p` : " · no online rivals"}`
      : `outbid (they pay ${fmtP(bestOtherBuy!)}p) — raise to ${target}p`;
    if (!ok && target !== null) {
      copyMsg = `WTB [${name}] ${target}p (via NinjaFlip)`;
      fixPrice = target;
    }
  } else {
    ok = bestOtherSell === null || price <= bestOtherSell;
    const target = bestOtherSell !== null ? Math.round(bestOtherSell - 1) : null;
    advice = ok
      ? `cheapest ✓${bestOtherSell != null ? ` · next online seller asks ${fmtP(bestOtherSell)}p` : " · no online rivals"}`
      : `undercut (${fmtP(bestOtherSell!)}p ask) — lower to ${target}p`;
    if (!ok && target !== null) {
      copyMsg = `WTS [${name}] ${target}p (via NinjaFlip)`;
      fixPrice = target;
    }
  }
  return {
    id: o.id, type: o.type, price, qty: o.quantity, slug, name,
    itemId: o.itemId, bestOtherBuy, bestOtherSell, offlineBuy, offlineSell,
    ok, advice, copyMsg, fixPrice,
    resellAt: o.type === "buy" && bestOtherSell !== null
      ? Math.max(1, Math.round(bestOtherSell - 1)) : null,
    hidden: !o.visible,
    costBasis: o.type === "sell" ? (getCostBasis(o.id)?.cost ?? null) : null,
  };
}

async function checkOrders(userSlug: string,
                           items: Record<string, [string, string]>,
                           onProgress: (s: string) => void): Promise<CheckedOrder[]> {
  let mine: RawOrder[] | null = null;
  if (isConnected()) {
    // intenta el endpoint autenticado (traería también las ocultas)
    mine = (await fetchMyOrders()) as RawOrder[] | null;
  }
  if (mine === null) {
    const res = await wfmFetch(`/wfm/v2/orders/user/${encodeURIComponent(userSlug)}`);
    if (!res.ok) throw new Error(`User "${userSlug}" not found on warframe.market`);
    mine = (await res.json()).data as RawOrder[];
  }

  const out: CheckedOrder[] = [];
  for (let i = 0; i < mine.length; i++) {
    const o = mine[i];
    const [slug, name] = items[o.itemId] ?? [null, null];
    if (!slug || !name) continue;
    onProgress(`${i + 1}/${mine.length}`);
    const checked = await checkOneOrder(o, slug, name, userSlug);
    if (checked) out.push(checked);
  }
  // primero las que necesitan acción
  return out.sort((a, b) => Number(a.ok) - Number(b.ok));
}

// ---------- diálogo "sold": cerrar la orden y encadenar la reventa ----------

function SoldDialog({ order, onDone, onCancel, basePlat }: {
  order: CheckedOrder;
  onDone: () => void;
  onCancel: () => void;
  basePlat: number;
}) {
  const [step, setStep] = useState<"price" | "resell" | "flip-closed">("price");
  const [execPrice, setExecPrice] = useState(Math.round(order.price));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isBuy = order.type === "buy";

  async function confirmSold() {
    setBusy(true); setErr("");
    try {
      await closeOrder(order.id, execPrice, order.price, order.qty);
      adjustPlat(isBuy ? -execPrice * order.qty : execPrice * order.qty, basePlat);
      if (isBuy && order.resellAt != null) {
        setStep("resell");
      } else if (!isBuy && order.costBasis != null) {
        // flip completo: registrar el resultado real
        logFlip({ item: order.name, buy: order.costBasis, sell: execPrice, ts: Date.now() });
        removeCostBasis(order.id);
        setStep("flip-closed");
      } else {
        onDone();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function publishResell() {
    openComposer({
      itemId: order.itemId, slug: order.slug, name: order.name,
      type: "sell", price: order.resellAt ?? undefined, quantity: 1,
      costBasis: execPrice,
    });
    onDone();
  }

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal narrow" role="dialog" aria-modal="true">
        {step === "price" ? (
          <>
            <div className="modal-head">
              <h2>{isBuy ? <><ShoppingCart size={15} /> Order filled?</> : <><HandCoins size={15} /> Did it sell?</>} — {order.name}</h2>
              <button className="linkish close" onClick={onCancel} aria-label="Close"><X size={16} /></button>
            </div>
            <p className="hint">
              Your {isBuy ? "buy" : "sell"} order was <b><Plat value={order.price} /></b>. If you negotiated a different price, correct it so the market records the real transaction.
            </p>
            <div className="composer-fields">
              <label className="sim-field">{isBuy ? "Paid" : "Got"}
                <input type="number" min={1} autoFocus value={execPrice}
                       onChange={e => setExecPrice(+e.target.value || 0)}
                       onKeyDown={e => e.key === "Enter" && !busy && execPrice > 0 && confirmSold()} /> p
              </label>
            </div>
            {err && <p className="loss">{err}</p>}
            <div className="composer-footer">
              <button className="linkish muted" onClick={onCancel}>cancel</button>
              <button className="btn primary big" disabled={busy || execPrice < 1} onClick={confirmSold}>
                {busy ? "closing…" : <><Check size={13} className="inline-icon" /> {isBuy ? "Bought" : "Sold"} at {execPrice}p</>}
              </button>
            </div>
          </>
        ) : step === "flip-closed" ? (
          <>
            <div className="modal-head">
              <h2><Flag size={15} /> Flip completed — {order.name}</h2>
              <button className="linkish close" onClick={onDone} aria-label="Close"><X size={16} /></button>
            </div>
            <p className="hint" style={{ fontSize: 14 }}>
              Bought at <b><Plat value={order.costBasis!} /></b> → sold at <b><Plat value={execPrice} /></b> ={" "}
              <b className={execPrice - order.costBasis! >= 0 ? "gain-pos" : "loss"}>
                <Plat value={execPrice - order.costBasis!} sign />
              </b>
            </p>
            <div className="composer-footer">
              <button className="btn primary big" onClick={onDone}>Nice <Check size={14} className="inline-icon" /></button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-head">
              <h2><Check size={15} /> Buy recorded — resell it?</h2>
              <button className="linkish close" onClick={onDone} aria-label="Close"><X size={16} /></button>
            </div>
            <p className="hint">
              You bought <b>{order.name}</b> at <Plat value={execPrice} />. Cheapest seller asks{" "}
              {order.bestOtherSell != null ? <Plat value={order.bestOtherSell} /> : "—"} → suggested{" "}
              <b><Plat value={order.resellAt ?? 0} /></b> (profit ~<b className="gain-pos"><Plat value={(order.resellAt ?? 0) - execPrice} sign /></b>). You can edit the price before posting.
            </p>
            <div className="composer-footer">
              <button className="linkish muted" onClick={onDone}>no, done</button>
              <button className="btn primary big" onClick={publishResell}>
                <SquarePen size={14} className="inline-icon" /> Post sell order at {order.resellAt}p
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Agrupa tus flips por item (colapsando sets Prime a un solo grupo, igual
 *  que en Flip History) y muestra solo los items que flipeaste 2+ veces —
 *  la idea es ver si el spread de algo que flipeás seguido se te va
 *  achicando con el tiempo (a veces por tu propia presión de compra sobre
 *  un libro de órdenes finito). Basado 100% en TU historial de trades — no
 *  hay precio de mercado histórico guardado, así que no aparece nada hasta
 *  que repetís el mismo item por segunda vez. */
function ItemTrendCard({ flips }: { flips: FlipRecord[] }) {
  const groups = useMemo(() => {
    const byItem = new Map<string, FlipRecord[]>();
    for (const f of flips) {
      const key = prettyItemName(f.item);
      const list = byItem.get(key);
      if (list) list.push(f);
      else byItem.set(key, [f]);
    }
    return [...byItem.entries()]
      .filter(([, list]) => list.length >= 2)
      .map(([name, list]) => ({ name, list: [...list].sort((a, b) => a.ts - b.ts) }))
      .sort((a, b) => b.list.length - a.list.length);
  }, [flips]);

  if (!groups.length) return null;

  return (
    <div className="card">
      <h2><TrendingUp size={16} /> Items you've flipped more than once</h2>
      <p className="hint">
        Same item, several flips over time — see if the spread is holding up or shrinking as you keep trading it.
      </p>
      {groups.map(g => (
        <div className="trend-group" key={g.name}>
          <div className="trend-item">{g.name} <span className="muted">· {g.list.length} flips</span></div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Date</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Profit</th><th className="num">Now</th></tr>
              </thead>
              <tbody>
                {g.list.map((f, i) => (
                  <tr key={i}>
                    <td className="muted">{new Date(f.ts).toLocaleDateString()}</td>
                    <td className="num"><Plat value={f.buy} /></td>
                    <td className="num"><Plat value={f.sell} /></td>
                    <td className="num gain-pos"><Plat value={f.sell - f.buy} sign /></td>
                    <td className="num">{f.market_now != null ? <Plat value={f.market_now} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Compras reales detectadas en tu historial de trades de AlecaFrame que
 *  todavía no aparecen emparejadas con una venta (detect_flips(), server) —
 *  justo el caso "posteé un WTB, se cerró, y ahora tengo que acordarme de
 *  revenderlo" sin depender de que vos mismo marques "🛒 bought" a mano. */
function RecentPurchasesCard({ purchases }: { purchases: Purchase[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("purchases_dismissed_v1") ?? "[]")); }
    catch { return new Set(); }
  });
  const key = (p: Purchase) => `${p.item}|${p.ts}`;
  const dismiss = (p: Purchase) => {
    const next = new Set(dismissed); next.add(key(p));
    setDismissed(next);
    localStorage.setItem("purchases_dismissed_v1", JSON.stringify([...next]));
  };
  const visible = purchases.filter(p => !dismissed.has(key(p)));

  // Lo que AlecaFrame reportó como pagado no siempre es correcto para VOS
  // (ej. lo conseguiste farmeando y el trade se cruzó con otra cosa en su
  // historial) — dejá editarlo antes de postear la venta, así el profit
  // registrado no arrastra un costo que nunca pagaste.
  const [paidOverride, setPaidOverride] = useState<Record<string, number>>({});
  const paidFor = (p: Purchase) => paidOverride[key(p)] ?? p.plat_paid ?? 0;
  // inline en vez de alert() — consistente con cómo esta vista muestra
  // cualquier otro error (ver errMsg más abajo en OrdersView), y no bloquea
  // el hilo esperando que cierres un modal nativo del navegador.
  const [postErrors, setPostErrors] = useState<Record<string, string>>({});

  if (!visible.length) return null;

  async function postSell(p: Purchase) {
    const name = prettyItemName(p.item);
    setPostErrors(e => ({ ...e, [key(p)]: "" }));
    const found = await resolveItemByName(name);
    if (!found) {
      setPostErrors(e => ({ ...e, [key(p)]: `Couldn't find "${name}" in the market catalog — post it manually.` }));
      return;
    }
    openComposer({
      itemId: found.id, slug: found.slug, name, type: "sell",
      costBasis: paidFor(p),
    });
    dismiss(p);
  }

  return (
    <div className="card history-card">
      <h2><ShoppingCart size={16} /> Recent purchases</h2>
      <p className="hint">From your AlecaFrame trade history — not yet matched to a sale.</p>
      <div className="feed">
        {visible.slice(0, 10).map((p, i) => (
          <div className="feed-row" key={i}>
            <div className="feed-main">
              <MarketLink name={prettyItemName(p.item)} />
              {p.qty > 1 && <span className="muted"> ×{p.qty}</span>}
              <div className="muted feed-date">
                paid{" "}
                <input type="number" min={0} value={paidFor(p)}
                       title="Not accurate? Farmed it instead of buying it? Edit the cost here before posting the sell."
                       onChange={e => setPaidOverride(o => ({ ...o, [key(p)]: Math.max(0, +e.target.value || 0) }))}
                       style={{ width: 56 }} />p
                {p.plat_paid == null && <span className="muted"> (mixed trade, guessed 0)</span>}
                {p.market_now > 0 && <> · market now <Plat value={p.market_now} /></>}
              </div>
              {postErrors[key(p)] && <p className="loss" style={{ margin: "4px 0 0", fontSize: "var(--text-xs)" }}>{postErrors[key(p)]}</p>}
            </div>
            <span className="actions">
              <button className="btn primary" onClick={() => postSell(p)}><SquarePen size={12} className="inline-icon" /> Post sell</button>
              <button className="btn" onClick={() => dismiss(p)} title="Already handled / not selling this"><X size={13} /></button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrdersView({ defaultUser, basePlat, unsoldPurchases, flips }: {
  defaultUser: string; basePlat: number; unsoldPurchases: Purchase[]; flips: Flip[];
}) {
  const [user, setUser] = useState(
    () => localStorage.getItem("wfm_user") ?? defaultUser.toLowerCase());
  // useState perezoso, no una llamada directa — readCache() hace un
  // localStorage.getItem + JSON.parse; llamarlo en el cuerpo del componente
  // lo repetía en CADA render (este componente re-renderiza cada segundo por
  // el countdown de auto-refresh) aunque el resultado solo se use al montar.
  const [cached] = useState(() => readCache());
  const [orders, setOrders] = useState<CheckedOrder[] | null>(cached?.orders ?? null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [lastCheck, setLastCheck] = useState<Date | null>(
    cached ? new Date(cached.ts) : null);
  const [autoMin, setAutoMin] = useState(3);
  const [countdown, setCountdown] = useState(0);
  const [connected, setConnected] = useState(isConnected());
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [soldOrder, setSoldOrder] = useState<CheckedOrder | null>(null);
  const automationRef = useRef<HTMLDetailsElement>(null);
  const [basisEdit, setBasisEdit] = useState<{ id: string; value: number } | null>(null);
  // Separados a pedido: antes un solo toggle prendía/apagaba el undercut
  // para compras Y ventas a la vez — ahora cada lado se controla solo. Si
  // ya tenías el viejo "wfm_autofix" en true, arranca con ambos prendidos
  // (no perdés la config anterior), después quedan independientes.
  const legacyAutoFix = localStorage.getItem("wfm_autofix") === "true";
  const [autoFixBuy, setAutoFixBuy] = useState(
    () => localStorage.getItem("wfm_autofix_buy") === "true" ||
          (localStorage.getItem("wfm_autofix_buy") == null && legacyAutoFix));
  const [autoFixSell, setAutoFixSell] = useState(
    () => localStorage.getItem("wfm_autofix_sell") === "true" ||
          (localStorage.getItem("wfm_autofix_sell") == null && legacyAutoFix));
  // El loop de auto-undercut en refresh() borra/ajusta órdenes de a una con
  // 500ms de pausa entre cada una — mismo problema que ya se arregló en
  // runAutoFill: si destildás un lado (o los dos) A MITAD de esa tanda, sin
  // esto seguía terminando de borrar/ajustar con el estado viejo. Refs
  // siempre al día, chequeadas de nuevo dentro del loop antes de cada acción.
  const autoFixBuyRef = useRef(autoFixBuy);
  useEffect(() => { autoFixBuyRef.current = autoFixBuy; }, [autoFixBuy]);
  const autoFixSellRef = useRef(autoFixSell);
  useEffect(() => { autoFixSellRef.current = autoFixSell; }, [autoFixSell]);
  const [autoFixMinProfit, setAutoFixMinProfit] = useState(
    () => Number(localStorage.getItem("wfm_autofix_min_profit")) || 15);
  const [autoPause, setAutoPause] = useState(() => localStorage.getItem("wfm_autopause") === "true");
  const [pauseBusy, setPauseBusy] = useState(false);
  const pauseBusyRef = useRef(false);
  const peak = usePeakTime();
  const [autoFill, setAutoFill] = useState(() => localStorage.getItem("wfm_autofill") === "true");
  const [autoFillScope, setAutoFillScope] = useState<"top" | "liquid">(
    () => (localStorage.getItem("wfm_autofill_scope") as "top" | "liquid") || "top");
  // Qué tipos de item puede postear el auto-fill — todos prendidos por
  // default (mismo comportamiento que antes de que existiera este filtro).
  // Pensado para cuando te falta capital para algo en particular (ej. plata
  // corta para primed mods/arcanos, ticket alto) sin tener que apagar todo
  // auto-fill: destildás ese tipo y el resto sigue solo.
  const [autoFillKinds, setAutoFillKinds] = useState<Set<"set" | "arcane" | "mod">>(() => {
    try {
      const raw = localStorage.getItem("wfm_autofill_kinds");
      if (raw) return new Set(JSON.parse(raw));
    } catch { /* noop */ }
    return new Set(["set", "arcane", "mod"]);
  });
  const toggleAutoFillKind = (k: "set" | "arcane" | "mod") => {
    setAutoFillKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  // runAutoFill posta de a una con pausas de 500ms entre cada createOrder —
  // si destildás un kind (o apagás auto-fill entero) A MITAD de una tanda ya
  // en curso, el `cands` que arma esa tanda quedó calculado con el filtro
  // viejo. Estas refs siempre tienen el valor MÁS actual — se chequean de
  // nuevo dentro del loop, justo antes de cada posteo, así una tanda en
  // vuelo para cuando cambiás algo en vez de terminar de postear con el
  // filtro que ya no vale.
  const autoFillRef = useRef(autoFill);
  useEffect(() => { autoFillRef.current = autoFill; }, [autoFill]);
  const autoFillKindsRef = useRef(autoFillKinds);
  useEffect(() => { autoFillKindsRef.current = autoFillKinds; }, [autoFillKinds]);
  const [autoFillBusy, setAutoFillBusy] = useState(false);
  const autoFillBusyRef = useRef(false);
  // Items que fallaron al postear en esta sesión (límite de órdenes de la
  // cuenta, error de validación, lo que sea) — se descartan para siempre en
  // vez de reintentarse en cada corrida, que era exactamente lo que podía
  // terminar mandando el mismo request fallido decenas de veces seguidas.
  const autoFillFailedRef = useRef<Set<string>>(new Set());
  const AUTO_FILL_MAX_PER_RUN = 5;

  useEffect(() => {
    localStorage.setItem("wfm_autofix_buy", String(autoFixBuy));
  }, [autoFixBuy]);
  useEffect(() => {
    localStorage.setItem("wfm_autofix_sell", String(autoFixSell));
  }, [autoFixSell]);
  useEffect(() => {
    localStorage.setItem("wfm_autofix_min_profit", String(autoFixMinProfit));
  }, [autoFixMinProfit]);
  useEffect(() => {
    localStorage.setItem("wfm_autopause", String(autoPause));
  }, [autoPause]);
  useEffect(() => {
    localStorage.setItem("wfm_autofill", String(autoFill));
  }, [autoFill]);
  useEffect(() => {
    localStorage.setItem("wfm_autofill_scope", autoFillScope);
  }, [autoFillScope]);
  useEffect(() => {
    localStorage.setItem("wfm_autofill_kinds", JSON.stringify([...autoFillKinds]));
  }, [autoFillKinds]);

  // Pausar = poner visible:false en todas tus órdenes activas (nadie puede
  // encontrarlas para contactarte) — NO es lo mismo que ponerte "invisible"
  // como cuenta (eso no se puede automatizar, ver live.ts). Mismo límite que
  // Auto-undercut: esto es client-side, solo corre con la pestaña abierta.
  const allPaused = orders != null && orders.length > 0 && orders.every(o => o.hidden);
  const setAllVisible = useCallback(async (visible: boolean) => {
    if (!orders?.length || pauseBusyRef.current) return;
    pauseBusyRef.current = true;
    setPauseBusy(true);
    try {
      for (const o of orders) {
        if (o.hidden === !visible) continue; // ya está en el estado pedido
        try {
          await setOrderVisible(o.id, o.price, visible);
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.error(e); }
      }
      await refresh();
    } finally {
      pauseBusyRef.current = false;
      setPauseBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);

  // Auto-pausa (premium): cada vez que cambia el estado del pico, decide si
  // tus órdenes deberían estar visibles ahora — reactiva 1h antes del pico
  // (para no perderte la ventana esperando a que llegue exacto) y pausa el
  // resto del tiempo.
  useEffect(() => {
    if (!autoPause || !isPremium() || !connected || !orders?.length || pauseBusyRef.current) return;
    const shouldBeVisible = !peak || peak.isPeakNow || peak.minsUntil <= 60;
    if (shouldBeVisible === !allPaused) return;
    setAllVisible(shouldBeVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPause, connected, peak?.isPeakNow, peak?.minsUntil, allPaused, orders?.length]);

  // Auto-fill capital (premium): postea WTBs solas sobre el capital libre
  // (plat menos lo ya comprometido en compras activas), rankeadas por score,
  // hasta agotarlo — mismo criterio y filtros que "Suggested positions", acá
  // en piloto automático en vez de un click por fila. "top" = mismo filtro
  // ajustado que Suggested positions (margen y ganancia mínimos más
  // estrictos); "liquid" = cualquier flip líquido con spread positivo, red
  // más ancha. Nunca duplica: una vez posteado, el slug entra a `orders` y
  // sale de los candidatos en la próxima corrida. Tope duro de
  // AUTO_FILL_MAX_PER_RUN órdenes por corrida y los que fallan al postear se
  // descartan para siempre en esta sesión (autoFillFailedRef) — sin esto,
  // un candidato que falla (límite de órdenes de la cuenta, lo que sea) se
  // reintentaba en cada refresh de `orders`/`flips`, machacando la API con
  // el mismo request fallido una y otra vez.
  const runAutoFill = useCallback(async () => {
    if (autoFillBusyRef.current || !orders) return;
    const committed = orders.filter(o => o.type === "buy").reduce((a, o) => a + o.price * o.qty, 0);
    const freeCapital = Math.max(0, Math.round(basePlat - committed));
    const mine = new Set(orders.map(o => o.slug));
    const cands = flips
      .filter(f => f.buy > 0 && f.vol48 >= 30 && f.sell > f.buy && !mine.has(f.slug) &&
                   !autoFillFailedRef.current.has(f.slug) &&
                   (!f.kind || autoFillKinds.has(f.kind)) &&
                   (autoFillScope === "liquid" || (f.margin >= 12 && perTradeProfit(f) >= 15)))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, AUTO_FILL_MAX_PER_RUN);
    if (!cands.length) return;
    autoFillBusyRef.current = true;
    setAutoFillBusy(true);
    try {
      const items = await loadItems();
      const idBySlug = new Map<string, string>();
      for (const [id, [slug]] of Object.entries(items)) idBySlug.set(slug, id);

      let cap = freeCapital;
      let posted = 0;
      for (const f of cands) {
        if (!autoFillRef.current) break; // se apagó auto-fill mientras esta tanda posteaba
        if (f.kind && !autoFillKindsRef.current.has(f.kind)) continue; // se destildó ese kind mientras posteaba
        const itemId = idBySlug.get(f.slug);
        if (!itemId) continue;
        const cost = Math.round(f.buy + 1);
        if (cost > cap) continue;
        const qty = Math.max(1, Math.min(bulkQty(f), Math.floor(cap / cost)));
        if ((Math.round(f.sell - 1) - cost) * qty < 5) continue; // no vale gastar el trade
        try {
          const { rank, subtype, bulkTradable } = await resolveTradeInfo(f.slug, f.name);
          await createOrder({
            itemId, type: "buy", platinum: cost, quantity: qty,
            rank: rank || undefined, subtype, bulkTradable,
          });
          cap -= cost * qty;
          posted++;
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error(e);
          autoFillFailedRef.current.add(f.slug); // no reintentar esto de nuevo
        }
      }
      if (posted > 0) await refresh();
    } finally {
      autoFillBusyRef.current = false;
      setAutoFillBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, basePlat, flips, autoFillScope, autoFillKinds]);

  useEffect(() => {
    if (!autoFill || !isPremium() || !connected || autoFillBusyRef.current) return;
    runAutoFill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFill, connected, orders, flips, autoFillScope, autoFillKinds]);

  function saveBasis(o: CheckedOrder) {
    if (!basisEdit || basisEdit.id !== o.id) return;
    const v = Math.round(basisEdit.value);
    if (v >= 1) {
      setCostBasis(o.id, v, o.name);
      setOrders(prev => {
        const next = prev?.map(x => x.id === o.id ? { ...x, costBasis: v } : x) ?? null;
        if (next) writeCache(next);
        return next;
      });
    }
    setBasisEdit(null);
  }
  const itemsRef = useRef<Record<string, [string, string]> | null>(null);
  const busyRef = useRef(false);
  // el listener de "orders:changed" se registra una sola vez (ver abajo) —
  // esta ref le da el user actual sin tener que re-atar el evento en cada
  // tecla que escribís en el campo de usuario
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  useEffect(() => onAuthChange(() => setConnected(isConnected())), []);

  const refresh = useCallback(async () => {
    if (busyRef.current || !user) return;
    busyRef.current = true;
    setState("loading");
    try {
      if (!itemsRef.current) {
        itemsRef.current = await loadItems();
      }
      localStorage.setItem("wfm_user", user);
      let checked = await checkOrders(user, itemsRef.current!, setProgress);

      // isPremium() acá también, no solo en el checkbox de la UI — si ya
      // tenías "wfm_autofix_buy"/"wfm_autofix_sell" en true en localStorage
      // de antes de que esto fuera premium, el loop igual corría solo con
      // esconder el checkbox. Compra y venta se controlan por separado.
      const fixBuy = localStorage.getItem("wfm_autofix_buy") === "true";
      const fixSell = localStorage.getItem("wfm_autofix_sell") === "true";
      if (isConnected() && isPremium() && (fixBuy || fixSell)) {
        const minProfit = Number(localStorage.getItem("wfm_autofix_min_profit")) || 15;
        let changes = false;
        const autoFixErrors: string[] = [];
        // dos motivos para tocar una orden:
        //  1. fuera de posición (!ok) — hay que subir/bajar el precio, o
        //     directamente borrarla si ni ajustada deja el piso de plat.
        //  2. YA en posición, pero el margen actual (con SU precio de
        //     verdad, no el fixPrice — acá no hay nada que "arreglar") está
        //     por debajo del piso configurado. Antes esto no se tocaba
        //     nunca: una orden podía estar perfectamente competitiva y
        //     seguir viva aunque dejara menos plat de la que pediste.
        const outOfPosition = (o: CheckedOrder) => !o.ok && o.fixPrice != null;
        const currentProfit = (o: CheckedOrder): number | null =>
          o.type === "buy"
            ? (o.resellAt != null ? o.resellAt - o.price : null)
            : (o.costBasis != null ? o.price - o.costBasis : null);
        const toAction = checked.filter(o =>
          (o.type === "buy" ? fixBuy : fixSell) &&
          (outOfPosition(o) || (currentProfit(o) ?? Infinity) < minProfit));
        if (toAction.length > 0) {
          for (let i = 0; i < toAction.length; i++) {
            const o = toAction[i];
            // se destildó auto-undercut para ESTE lado (buy/sell) mientras
            // esta tanda ya estaba corriendo — no seguir tocando órdenes de
            // ese lado con un permiso que ya no está.
            if (o.type === "buy" ? !autoFixBuyRef.current : !autoFixSellRef.current) continue;
            const outOfPos = outOfPosition(o);
            let shouldDelete: boolean;
            if (outOfPos) {
              const fixedProfit = o.type === "buy"
                ? (o.resellAt != null && o.fixPrice != null ? o.resellAt - o.fixPrice : null)
                : (o.costBasis != null && o.fixPrice != null ? o.fixPrice - o.costBasis : null);
              shouldDelete = fixedProfit !== null && fixedProfit < minProfit;
            } else {
              // ya en posición: no hay precio "roto" que ajustar, el único
              // motivo por el que llegó acá es que su margen actual ya está
              // bajo el piso — no queda otra que borrarla.
              shouldDelete = true;
            }
            try {
              if (shouldDelete) {
                setProgress(`deleting ${i + 1}/${toAction.length}`);
                await deleteOrder(o.id);
                removeCostBasis(o.id);
              } else {
                setProgress(`fixing ${i + 1}/${toAction.length}`);
                await updateOrder(o.id, { platinum: o.fixPrice! });
              }
              changes = true;
              // 250ms entre requests seguidos a warframe.market le pegaba
              // cerca del límite de rate real de la API — un fallo ahí antes
              // quedaba en un console.error que nadie ve, y la orden se
              // quedaba mal puesta sin que se note ("el auto-undercut no
              // hace nada"). Más margen + el error visible en pantalla.
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(e);
              autoFixErrors.push(`${o.name}: ${msg}`);
            }
          }
          if (changes) {
            checked = await checkOrders(user, itemsRef.current!, setProgress);
          }
        }
        if (autoFixErrors.length) {
          setErrMsg(`Auto-undercut couldn't fix ${autoFixErrors.length} order(s): ${autoFixErrors.join("; ")}`);
        }
      }

      setOrders(checked);
      writeCache(checked);
      setLastCheck(new Date());
      setState("idle");
    } catch (e) {
      setErrMsg(String(e));
      setState("error");
    } finally {
      busyRef.current = false;
      setCountdown(autoMin * 60);
      setProgress("");
    }
  }, [user, autoMin, autoFixBuy, autoFixSell]);

  // orden nueva: 1 sola llamada (el libro de ESE item) — no hay que
  // re-chequear las demás órdenes, no cambiaron.
  async function checkNewOrder(d: Extract<OrderChangeDetail, { kind: "new" }>) {
    const raw: RawOrder = {
      id: d.id, type: d.type, platinum: d.price, quantity: d.qty,
      visible: true, updatedAt: "", itemId: d.itemId, rank: d.rank, subtype: d.subtype,
    };
    const checked = await checkOneOrder(raw, d.slug, d.name, userRef.current);
    if (!checked) return;
    setOrders(prev => {
      const next = [checked, ...(prev ?? []).filter(x => x.id !== checked.id)]
        .sort((a, b) => Number(a.ok) - Number(b.ok));
      writeCache(next);
      return next;
    });
  }

  // precio editado: los rivales no cambiaron por editar TU precio — se
  // recalcula ok/advice con los datos que ya teníamos, 0 llamadas a la API.
  function patchEditedOrder(d: Extract<OrderChangeDetail, { kind: "edit" }>) {
    setOrders(prev => {
      if (!prev) return prev;
      const next = prev.map(o => {
        if (o.id !== d.id) return o;
        const raw: RawOrder = {
          id: o.id, type: o.type, platinum: d.price, quantity: d.qty ?? o.qty,
          visible: !o.hidden, updatedAt: "", itemId: o.itemId,
        };
        return buildChecked(raw, o.slug, o.name, d.price,
                             o.bestOtherBuy, o.bestOtherSell, o.offlineBuy, o.offlineSell);
      }).sort((a, b) => Number(a.ok) - Number(b.ok));
      writeCache(next);
      return next;
    });
  }

  // primera carga + actualización dirigida cuando el composer publica/edita algo
  useEffect(() => {
    const fresh = cached && Date.now() - cached.ts < MOUNT_SKIP_IF_FRESHER_THAN_MS;
    if (!fresh) refresh();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<OrderChangeDetail | undefined>).detail;
      if (detail?.kind === "new") void checkNewOrder(detail);
      else if (detail?.kind === "edit") patchEditedOrder(detail);
      else refresh(); // sin detalle (llamada vieja/desconocida): fallback seguro
    };
    window.addEventListener("orders:changed", onChanged);
    return () => window.removeEventListener("orders:changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyFix(o: CheckedOrder) {
    setRowBusy(o.id);
    try {
      await updateOrder(o.id, { platinum: o.fixPrice! });
      // igual que editar a mano desde el Composer: TU precio cambió, los
      // rivales no — recalcula local, 0 requests extra a warframe.market
      // (antes esto disparaba un refresh() completo, un request por CADA
      // orden que tuvieras, solo para arreglar una).
      patchEditedOrder({ kind: "edit", id: o.id, price: o.fixPrice! });
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setState("error");
    } finally {
      setRowBusy(null);
    }
  }

  async function fixAll() {
    if (!orders) return;
    const toFix = orders.filter(o => !o.ok && o.fixPrice != null);
    if (!toFix.length) return;
    setState("loading");
    try {
      for (let i = 0; i < toFix.length; i++) {
        const o = toFix[i];
        setProgress(`fixing ${i + 1}/${toFix.length}`);
        await updateOrder(o.id, { platinum: o.fixPrice! });
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await refresh();
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setState("error");
    } finally {
      setProgress("");
    }
  }

  // solo sacamos esta fila — un refresh() completo vuelve a chequear el
  // libro de CADA orden contra la API, no hace falta para borrar/cerrar una
  function removeOrderFromState(id: string) {
    setOrders(prev => {
      const next = prev?.filter(x => x.id !== id) ?? null;
      if (next) writeCache(next);
      return next;
    });
  }

  async function remove(o: CheckedOrder) {
    setRowBusy(o.id);
    try {
      await deleteOrder(o.id);
      removeCostBasis(o.id);
      removeOrderFromState(o.id);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setState("error");
    } finally {
      setRowBusy(null);
    }
  }

  // auto-refresh con cuenta regresiva
  useEffect(() => {
    if (!autoMin) return;
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { refresh(); return autoMin * 60; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [autoMin, refresh]);

  const bad = orders?.filter(o => !o.ok).length ?? 0;
  const buys = orders?.filter(o => o.type === "buy") ?? [];
  const sells = orders?.filter(o => o.type === "sell") ?? [];

  const rowActions = (o: CheckedOrder) => (
    <span className="actions">
      {connected ? (
        <>
          <button className="btn sold" disabled={rowBusy === o.id}
                  title={o.type === "buy"
                    ? "Buy filled: record it and chain the resale"
                    : "Sale done: record it on the market"}
                  onClick={() => setSoldOrder(o)}>
            {o.type === "buy" ? <ShoppingCart size={12} /> : <HandCoins size={12} />}
          </button>
          {!o.ok && o.fixPrice != null && isPremium() && (
            <button className="btn primary" disabled={rowBusy === o.id}
                    title={`Update the market price to ${o.fixPrice}p`}
                    onClick={() => applyFix(o)}>
              {rowBusy === o.id ? "…" : <><Zap size={12} className="inline-icon" /> {o.fixPrice}p</>}
            </button>
          )}
          <button className="btn" disabled={rowBusy === o.id}
                  onClick={() => openComposer({
                    orderId: o.id, itemId: o.itemId, slug: o.slug,
                    name: o.name, type: o.type, price: o.price, quantity: o.qty,
                  })}><Pencil size={12} /></button>
          <button className="btn" disabled={rowBusy === o.id}
                  onClick={() => remove(o)} title="Delete order"><Trash2 size={12} /></button>
        </>
      ) : (
        o.copyMsg && <CopyBtn label={<><Copy size={12} className="inline-icon" /> copy fix</>} text={o.copyMsg} />
      )}
    </span>
  );

  const itemCell = (o: CheckedOrder) => (
    <td>
      <MarketLink slug={o.slug}>{o.name}</MarketLink>
      {o.qty > 1 ? ` ×${o.qty}` : ""}
      {o.hidden && <> <Tag title="Invisible on the market">hidden</Tag></>}
    </td>
  );

  const buyProfit = buys.reduce((a, o) => a + (o.resellAt != null ? o.resellAt - o.price : 0), 0);
  const sellProfit = sells.reduce((a, o) => a + (o.costBasis != null ? o.price - o.costBasis : 0), 0);
  // memoizado por `orders`, no recalculado en cada render — este componente
  // re-renderiza cada segundo por el countdown del auto-refresh, y
  // getAllFlips() hace un filter+dedupe sobre TODO el historial (wfm.ts)
  // cada vez que se llama. `orders` cambia justo cuando puede haber un flip
  // nuevo logueado (SoldDialog) o alguno restaurado por refresh().
  const allFlips = useMemo(() => getAllFlips(), [orders]);
  const realized = allFlips.reduce((a, f) => a + (f.sell - f.buy), 0);
  const avgFlipProfit = allFlips.length ? realized / allFlips.length : 0;

  const sortedFlips = [...allFlips].sort((a, b) => b.ts - a.ts);

  return (
    <>
    <div className="orders-layout">
    <div className="orders-main">
    <div className="card">
      <div className="card-head">
        <h2>My orders on warframe.market{" "}
          {orders && (bad
            ? <Tag kind="vaulted">{bad} out of position</Tag>
            : <Tag kind="radiant">all in position ✓</Tag>)}
        </h2>
        {connected && orders && bad > 0 && isPremium() && (
          <div className="card-head-actions">
            <button className="btn primary ok" disabled={state === "loading"} onClick={fixAll}>
              <Zap size={13} className="inline-icon" /> Fix all ({bad})
            </button>
          </div>
        )}
      </div>
      <p className="hint">
        Each order vs the best competing price (online users, excluding you). Red = out of position
        {connected && isPremium() ? " — one click on ⚡ fixes it" : ""}
        {connected && !isPremium() ? " — fixing it yourself is a premium feature" : ""}.
      </p>
      {!connected && <LoginForm compact />}
      <div className="controls">
        <label className="sim-field">User
          <input value={user} onChange={e => setUser(e.target.value)}
                 onKeyDown={e => e.key === "Enter" && refresh()} />
        </label>
        <button className="btn" disabled={state === "loading"} onClick={refresh}>
          <RefreshCw size={12} className={`inline-icon ${state === "loading" ? "spin" : ""}`} />{" "}
          {state === "loading" ? `checking ${progress}…` : "check now"}
        </button>
        <label className="sim-field">Auto
          <select value={autoMin} onChange={e => setAutoMin(+e.target.value)}>
            <option value={0}>off</option>
            <option value={2}>every 2 min</option>
            <option value={3}>every 3 min</option>
            <option value={5}>every 5 min</option>
            <option value={10}>every 10 min</option>
          </select>
        </label>
        {connected && orders && orders.length > 0 && (
          <button className="btn" disabled={pauseBusy} onClick={() => setAllVisible(!!allPaused)}
                  title={allPaused ? "Make all your orders visible again" : "Hide all your orders — nobody can find them to contact you until you resume"}>
            {pauseBusy
              ? "…"
              : allPaused
                ? <><Play size={12} className="inline-icon" /> Resume all</>
                : <><Pause size={12} className="inline-icon" /> Pause all</>}
          </button>
        )}
        {connected && isPremium() ? (
          <details className="automation-panel" ref={automationRef}>
            <summary className={`btn ${autoFixBuy || autoFixSell || autoPause || autoFill ? "ok" : ""}`}>
              <Zap size={12} className="inline-icon" /> Automation
              {(autoFixBuy || autoFixSell || autoPause || autoFill) && " · on"}
            </summary>
            <div className="automation-panel-body">
              <label className="chk">
                <input type="checkbox" checked={autoFixBuy} onChange={e => setAutoFixBuy(e.target.checked)} />
                Auto-undercut buys
              </label>
              <label className="chk">
                <input type="checkbox" checked={autoFixSell} onChange={e => setAutoFixSell(e.target.checked)} />
                Auto-undercut sells
              </label>
              <label className="sim-field" title="Profit floor: below this, the order gets deleted instead of undercut. Only used once Auto-undercut buys/sells is on, but you can set it ahead of time.">
                min profit
                <input type="number" min={1} value={autoFixMinProfit}
                       onChange={e => setAutoFixMinProfit(Math.max(1, +e.target.value || 1))}
                       style={{ width: 56 }} /> p
              </label>
              <label className="chk" title="Hides your orders outside the busiest trading hour, shows them again 1h before it">
                <input type="checkbox" checked={autoPause} onChange={e => setAutoPause(e.target.checked)} />
                Auto-pause outside peak hours
              </label>
              <label className="chk" title="Posts WTB orders on scanner picks using your free capital (plat minus what's already tied up in buys), until it runs out">
                <input type="checkbox" checked={autoFill} onChange={e => setAutoFill(e.target.checked)} />
                Auto-fill capital{autoFillBusy && "…"}
              </label>
              {autoFill && (
                <>
                  <select value={autoFillScope} onChange={e => setAutoFillScope(e.target.value as "top" | "liquid")}
                          title="Which candidates to draw from">
                    <option value="top">top picks only</option>
                    <option value="liquid">any liquid flip</option>
                  </select>
                  <span className="hint" style={{ margin: 0 }}>on:</span>
                  <label className="chk" title="Prime sets (parts→set arbitrage included)">
                    <input type="checkbox" checked={autoFillKinds.has("set")}
                           onChange={() => toggleAutoFillKind("set")} /> sets
                  </label>
                  <label className="chk" title="Uncheck if you're short on the credits/plat these need right now">
                    <input type="checkbox" checked={autoFillKinds.has("mod")}
                           onChange={() => toggleAutoFillKind("mod")} /> primed mods
                  </label>
                  <label className="chk" title="Uncheck if you're short on the credits/plat these need right now">
                    <input type="checkbox" checked={autoFillKinds.has("arcane")}
                           onChange={() => toggleAutoFillKind("arcane")} /> arcanes
                  </label>
                </>
              )}
              <div className="automation-panel-footer">
                <button className="btn primary" onClick={() => { if (automationRef.current) automationRef.current.open = false; }}>
                  <Check size={12} className="inline-icon" /> Accept
                </button>
              </div>
            </div>
          </details>
        ) : connected && (
          <span className="hint" style={{ margin: 0 }}
                title="Auto-undercut, auto-pause and auto-fill capital are premium features">
            <Lock size={12} className="inline-icon" /> Automation (premium)
          </span>
        )}
        {lastCheck && state !== "loading" && (
          <span className="hint" style={{ margin: 0 }}>
            last check {lastCheck.toLocaleTimeString()}
            {autoMin > 0 && ` · next in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`}
          </span>
        )}
      </div>

      {state === "error" && <p className="loss">{errMsg}</p>}
      {orders && !orders.length && <p className="muted">No orders.</p>}
      {orders && orders.length > 0 && (
        <div className="tiles">
          <Tile value={`${orders.length}`} label={`active orders (${buys.length} buy · ${sells.length} sell)`} />
          <Tile value={<Plat value={buys.reduce((a, o) => a + o.price * o.qty, 0)} />} label="plat committed in buys" />
          <Tile value={<span className="gain-pos"><Plat value={buyProfit + sellProfit} sign /></span>} label="potential profit" />
          <Tile value={bad ? <span className="loss">{bad}</span> : "0"} label="out of position" />
          <Tile value={<span className={realized >= 0 ? "gain-pos" : "loss"}><Plat value={realized} sign /></span>}
                label={`realized profit (${allFlips.length} flip${allFlips.length === 1 ? "" : "s"})`} />
          {allFlips.length > 0 && (
            <Tile value={<span className={avgFlipProfit >= 0 ? "gain-pos" : "loss"}><Plat value={avgFlipProfit} sign /></span>}
                  label="avg profit per flip" />
          )}
        </div>
      )}
    </div>

    {orders && orders.length > 0 && (
      <div className="orders-cols">
        <div className="card">
          <h2><Tag kind="wtb">WTB</Tag> Buy orders</h2>
          {buys.length ? (
            <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Your price</th>
                  <th className="num" title="1p under the cheapest seller">Sell at</th>
                  <th className="num" title="Sell-at minus your price">Profit</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr className="total-row">
                  <td className="muted">Σ {buys.length}</td>
                  <td className="num"><Plat value={buys.reduce((a, o) => a + o.price, 0)} /></td>
                  <td className="num"><Plat value={buys.reduce((a, o) => a + (o.resellAt ?? 0), 0)} /></td>
                  <td className="num gain-pos"><Plat value={buyProfit} sign /></td>
                  <td />
                </tr>
                {buys.map(o => (
                  <tr key={o.id} className={o.ok ? "" : "row-bad"} title={o.advice}>
                    {itemCell(o)}
                    <td className="num"><b><Plat value={o.price} /></b></td>
                    <td className="num">{o.resellAt != null ? <b><Plat value={o.resellAt} /></b> : "—"}</td>
                    <td className="num">
                      {o.resellAt != null
                        ? <span className="gain-pos"><Plat value={o.resellAt - o.price} sign /></span> : "—"}
                    </td>
                    <td>{rowActions(o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : <p className="muted">No buy orders.</p>}
        </div>

        <div className="card">
          <h2><Tag kind="wts">WTS</Tag> Sell orders</h2>
          {sells.length ? (
            <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Your price</th>
                  <th className="num" title="What you paid (tracked from your buy)">Paid</th>
                  <th className="num" title="Your price minus what you paid">Profit</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr className="total-row">
                  <td className="muted">Σ {sells.length}</td>
                  <td className="num"><Plat value={sells.reduce((a, o) => a + o.price, 0)} /></td>
                  <td className="num"><Plat value={sells.reduce((a, o) => a + (o.costBasis ?? 0), 0)} /></td>
                  <td className="num gain-pos"><Plat value={sellProfit} sign /></td>
                  <td />
                </tr>
                {sells.map(o => (
                  <tr key={o.id} className={o.ok ? "" : "row-bad"} title={o.advice}>
                    {itemCell(o)}
                    <td className="num"><b><Plat value={o.price} /></b></td>
                    <td className="num">
                      {basisEdit?.id === o.id ? (
                        <input type="number" min={1} autoFocus className="basis-input"
                               value={basisEdit.value || ""}
                               onChange={e => setBasisEdit({ id: o.id, value: +e.target.value || 0 })}
                               onBlur={() => saveBasis(o)}
                               onKeyDown={e => {
                                 if (e.key === "Enter") saveBasis(o);
                                 if (e.key === "Escape") setBasisEdit(null);
                               }} />
                      ) : (
                        <button className="linkish" title="Set what you paid for it"
                                onClick={() => setBasisEdit({ id: o.id, value: o.costBasis ?? 0 })}>
                          {o.costBasis != null ? <><Plat value={o.costBasis} /> <Pencil size={10} className="muted inline-icon" /></> : <span className="muted">+ add</span>}
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {o.costBasis != null
                        ? <span className={o.price - o.costBasis >= 0 ? "gain-pos" : "loss"}>
                            <Plat value={o.price - o.costBasis} sign />
                          </span>
                        : "—"}
                    </td>
                    <td>{rowActions(o)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : <p className="muted">No sell orders.</p>}
        </div>
      </div>
    )}

    <ItemTrendCard flips={allFlips} />
    </div>

    <aside className="orders-side">
      <RecentPurchasesCard purchases={unsoldPurchases} />
      <div className="card history-card">
        <h2><Flag size={16} /> Flip history</h2>
        {allFlips.length > 0 ? (
          <>
            <div className="history-total">
              <span className={realized >= 0 ? "gain-pos" : "loss"}>
                <Plat value={realized} sign />
              </span>
              <span className="muted"> · {allFlips.length} flip{allFlips.length === 1 ? "" : "s"}</span>
            </div>
            <div className="feed">
              {sortedFlips.map((f, i) => (
                <div className="feed-row" key={i}>
                  <div className="feed-main">
                    <MarketLink name={prettyItemName(f.item)} />
                    <div className="muted feed-date">
                      {new Date(f.ts).toLocaleDateString()} · {new Date(f.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div className="feed-nums">
                    <div className="muted"><Plat value={f.buy} /> → <Plat value={f.sell} /></div>
                    <b className={f.sell - f.buy >= 0 ? "gain-pos" : "loss"}>
                      <Plat value={f.sell - f.buy} sign />
                    </b>
                    {f.market_now != null && (
                      <div className="muted feed-now" title="What the same thing sells for today">
                        now: <Plat value={f.market_now} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="hint">
            Completed flips land here — close the loop with <ShoppingCart size={11} className="inline-icon" /> bought
            → <HandCoins size={11} className="inline-icon" /> sold and each one gets logged with its real profit.
          </p>
        )}
      </div>
    </aside>
    </div>

    {soldOrder && (
      <SoldDialog order={soldOrder}
                  basePlat={basePlat}
                  // el pedido a warframe.market que cierra la orden ya pasó
                  // adentro de SoldDialog (closeOrder) — acá solo hace falta
                  // sacarla de la lista local. Antes esto hacía un refresh()
                  // completo (1 request por CADA orden que tuvieras) cada vez
                  // que confirmabas un bought/sold, incluso si solo decías
                  // "no, done" sin repostear nada.
                  onDone={() => { removeOrderFromState(soldOrder.id); setSoldOrder(null); }}
                  onCancel={() => setSoldOrder(null)} />
    )}
    </>
  );
}
