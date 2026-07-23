import { useCallback, useEffect, useRef, useState } from "react";
import { fmtP, wfmFetch } from "../lib";
import { CopyBtn, MarketLink, Tag, Tile } from "./ui";
import { AuthStatus, LoginForm, openComposer } from "./Composer";
import { adjustPlat, closeOrder, deleteOrder, fetchMyOrders, getCostBasis, getFlips, isConnected, loadItems, logFlip, onAuthChange, removeCostBasis, setCostBasis, updateOrder } from "../wfm";

interface RawOrder {
  id: string;
  type: "buy" | "sell";
  platinum: number;
  quantity: number;
  perTrade?: number;
  visible: boolean;
  updatedAt: string;
  itemId: string;
}

interface TopOrder {
  type?: "buy" | "sell";
  platinum: number;
  perTrade?: number;
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

function readCache(): { ts: number; orders: CheckedOrder[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache(orders: CheckedOrder[]): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), orders }));
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
    // el endpoint /top solo trae usuarios online: usamos el libro COMPLETO
    // para no perder órdenes de gente offline (visibles en el sitio)
    const res2 = await wfmFetch(`/wfm/v2/orders/item/${slug}`);
    if (!res2.ok) continue;
    const all = ((await res2.json()).data as TopOrder[])
      .filter(x => x.user?.slug !== userSlug);
    const pick = (type: "buy" | "sell", onlyOnline: boolean) =>
      all.filter(x => x.type === type && (!onlyOnline || online(x))).map(unit);
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

    let ok: boolean, advice: string, copyMsg: string | null = null,
        fixPrice: number | null = null;
    if (o.type === "buy") {
      ok = bestOtherBuy === null || price >= bestOtherBuy;
      const target = bestOtherBuy !== null ? Math.round(bestOtherBuy + 1) : null;
      advice = ok
        ? `first in line ✓${bestOtherBuy != null ? ` · next online buyer pays ${fmtP(bestOtherBuy)}p` : " · no online rivals"}`
        : `outbid (they pay ${fmtP(bestOtherBuy!)}p) — raise to ${target}p`;
      if (!ok && target !== null) {
        copyMsg = `WTB [${name}] ${target}p`;
        fixPrice = target;
      }
    } else {
      ok = bestOtherSell === null || price <= bestOtherSell;
      const target = bestOtherSell !== null ? Math.round(bestOtherSell - 1) : null;
      advice = ok
        ? `cheapest ✓${bestOtherSell != null ? ` · next online seller asks ${fmtP(bestOtherSell)}p` : " · no online rivals"}`
        : `undercut (${fmtP(bestOtherSell!)}p ask) — lower to ${target}p`;
      if (!ok && target !== null) {
        copyMsg = `WTS [${name}] ${target}p`;
        fixPrice = target;
      }
    }
    out.push({
      id: o.id, type: o.type, price, qty: o.quantity, slug, name,
      itemId: o.itemId, bestOtherBuy, bestOtherSell, offlineBuy, offlineSell,
      ok, advice, copyMsg, fixPrice,
      resellAt: o.type === "buy" && bestOtherSell !== null
        ? Math.max(1, Math.round(bestOtherSell - 1)) : null,
      hidden: !o.visible,
      costBasis: o.type === "sell" ? (getCostBasis(o.id)?.cost ?? null) : null,
    });
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
              <h2>{isBuy ? "🛒 Order filled?" : "💰 Did it sell?"} — {order.name}</h2>
              <button className="linkish close" onClick={onCancel} aria-label="Close">✕</button>
            </div>
            <p className="hint">
              Your {isBuy ? "buy" : "sell"} order was <b>{fmtP(order.price)}p</b>. If you negotiated a different price, correct it so the market records the real transaction.
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
                {busy ? "closing…" : `✓ ${isBuy ? "Bought" : "Sold"} at ${execPrice}p`}
              </button>
            </div>
          </>
        ) : step === "flip-closed" ? (
          <>
            <div className="modal-head">
              <h2>🏁 Flip completed — {order.name}</h2>
              <button className="linkish close" onClick={onDone} aria-label="Close">✕</button>
            </div>
            <p className="hint" style={{ fontSize: 14 }}>
              Bought at <b>{fmtP(order.costBasis!)}p</b> → sold at <b>{fmtP(execPrice)}p</b> ={" "}
              <b className={execPrice - order.costBasis! >= 0 ? "gain-pos" : "loss"}>
                {execPrice - order.costBasis! >= 0 ? "+" : ""}{fmtP(execPrice - order.costBasis!)}p
              </b>
            </p>
            <div className="composer-footer">
              <button className="btn primary big" onClick={onDone}>Nice ✓</button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-head">
              <h2>✓ Buy recorded — resell it?</h2>
              <button className="linkish close" onClick={onDone} aria-label="Close">✕</button>
            </div>
            <p className="hint">
              You bought <b>{order.name}</b> at {fmtP(execPrice)}p. Cheapest seller asks{" "}
              {order.bestOtherSell != null ? `${fmtP(order.bestOtherSell)}p` : "—"} → suggested{" "}
              <b>{order.resellAt}p</b> (profit ~<b className="gain-pos">+{fmtP((order.resellAt ?? 0) - execPrice)}p</b>). You can edit the price before posting.
            </p>
            <div className="composer-footer">
              <button className="linkish muted" onClick={onDone}>no, done</button>
              <button className="btn primary big" onClick={publishResell}>
                📝 Post sell order at {order.resellAt}p
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function OrdersView({ defaultUser, basePlat }: { defaultUser: string, basePlat: number }) {
  const [user, setUser] = useState(
    () => localStorage.getItem("wfm_user") ?? defaultUser.toLowerCase());
  const cached = readCache();
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
  const [basisEdit, setBasisEdit] = useState<{ id: string; value: number } | null>(null);
  const [autoFix, setAutoFix] = useState(() => localStorage.getItem("wfm_autofix") === "true");

  useEffect(() => {
    localStorage.setItem("wfm_autofix", String(autoFix));
  }, [autoFix]);

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

      if (isConnected() && localStorage.getItem("wfm_autofix") === "true") {
        let changes = false;
        const toAction = checked.filter(o => !o.ok && o.fixPrice != null);
        if (toAction.length > 0) {
          for (let i = 0; i < toAction.length; i++) {
            const o = toAction[i];
            let profit: number | null = null;
            if (o.type === "buy") {
              if (o.resellAt != null && o.fixPrice != null) {
                profit = o.resellAt - o.fixPrice;
              }
            } else {
              if (o.costBasis != null && o.fixPrice != null) {
                profit = o.fixPrice - o.costBasis;
              }
            }
            const shouldDelete = profit !== null && profit < 15;
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
              await new Promise(resolve => setTimeout(resolve, 250));
            } catch (e) {
              console.error(e);
            }
          }
          if (changes) {
            checked = await checkOrders(user, itemsRef.current!, setProgress);
          }
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
  }, [user, autoMin, autoFix]);

  // primera carga + refetch cuando el composer publica/edita algo
  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    window.addEventListener("orders:changed", onChanged);
    return () => window.removeEventListener("orders:changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyFix(o: CheckedOrder) {
    setRowBusy(o.id);
    try {
      await updateOrder(o.id, { platinum: o.fixPrice! });
      await refresh();
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

  async function remove(o: CheckedOrder) {
    if (!confirm(`Delete the ${o.type === "buy" ? "WTB" : "WTS"} order for ${o.name} at ${o.price}p?`)) return;
    setRowBusy(o.id);
    try {
      await deleteOrder(o.id);
      removeCostBasis(o.id);
      await refresh();
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
            {o.type === "buy" ? "🛒 bought" : "💰 sold"}
          </button>
          {!o.ok && o.fixPrice != null && (
            <button className="btn primary" disabled={rowBusy === o.id}
                    title={`Update the market price to ${o.fixPrice}p`}
                    onClick={() => applyFix(o)}>
              {rowBusy === o.id ? "…" : `⚡ ${o.fixPrice}p`}
            </button>
          )}
          <button className="btn" disabled={rowBusy === o.id}
                  onClick={() => openComposer({
                    orderId: o.id, itemId: o.itemId, slug: o.slug,
                    name: o.name, type: o.type, price: o.price, quantity: o.qty,
                  })}>✏️</button>
          <button className="btn" disabled={rowBusy === o.id}
                  onClick={() => remove(o)} title="Delete order">🗑</button>
        </>
      ) : (
        o.copyMsg && <CopyBtn label="📋 copy fix" text={o.copyMsg} />
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
  const flips = getFlips();
  const realized = flips.reduce((a, f) => a + (f.sell - f.buy), 0);

  const sortedFlips = [...flips].sort((a, b) => b.ts - a.ts);

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
        <div className="card-head-actions">
          <AuthStatus />
          {connected && orders && bad > 0 && (
            <button className="btn primary ok" disabled={state === "loading"} onClick={fixAll}>
              ⚡ Fix all ({bad})
            </button>
          )}
          <button className="btn primary" onClick={() => openComposer()}>➕ Post order</button>
        </div>
      </div>
      <p className="hint">
        Each order vs the best competing price (online users, excluding you). Red = out of position{connected ? " — one click on ⚡ fixes it" : ""}.
      </p>
      {!connected && <LoginForm compact />}
      <div className="controls">
        <label className="sim-field">User
          <input value={user} onChange={e => setUser(e.target.value)}
                 onKeyDown={e => e.key === "Enter" && refresh()} />
        </label>
        <button className="btn" disabled={state === "loading"} onClick={refresh}>
          {state === "loading" ? `🔄 checking ${progress}…` : "🔄 check now"}
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
        {connected && (
          <label className="chk">
            <input type="checkbox" checked={autoFix} onChange={e => setAutoFix(e.target.checked)} />
            ⚡ Auto-undercut (min 15p profit or delete)
          </label>
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
          <Tile value={`${fmtP(buys.reduce((a, o) => a + o.price * o.qty, 0))}p`} label="plat committed in buys" />
          <Tile value={<span className="gain-pos">+{fmtP(buyProfit + sellProfit)}p</span>} label="potential profit" />
          <Tile value={bad ? <span className="loss">{bad}</span> : "0"} label="out of position" />
          <Tile value={<span className={realized >= 0 ? "gain-pos" : "loss"}>{realized >= 0 ? "+" : ""}{fmtP(realized)}p</span>}
                label={`realized profit (${flips.length} flip${flips.length === 1 ? "" : "s"})`} />
        </div>
      )}
    </div>

    {orders && orders.length > 0 && (
      <div className="two-col">
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
                  <td className="num">{fmtP(buys.reduce((a, o) => a + o.price, 0))}p</td>
                  <td className="num">{fmtP(buys.reduce((a, o) => a + (o.resellAt ?? 0), 0))}p</td>
                  <td className="num gain-pos">+{fmtP(buyProfit)}p</td>
                  <td />
                </tr>
                {buys.map(o => (
                  <tr key={o.id} className={o.ok ? "" : "row-bad"} title={o.advice}>
                    {itemCell(o)}
                    <td className="num"><b>{fmtP(o.price)}p</b></td>
                    <td className="num">{o.resellAt != null ? <b>{o.resellAt}p</b> : "—"}</td>
                    <td className="num">
                      {o.resellAt != null
                        ? <span className="gain-pos">+{fmtP(o.resellAt - o.price)}p</span> : "—"}
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
                  <td className="num">{fmtP(sells.reduce((a, o) => a + o.price, 0))}p</td>
                  <td className="num">{fmtP(sells.reduce((a, o) => a + (o.costBasis ?? 0), 0))}p</td>
                  <td className="num gain-pos">+{fmtP(sellProfit)}p</td>
                  <td />
                </tr>
                {sells.map(o => (
                  <tr key={o.id} className={o.ok ? "" : "row-bad"} title={o.advice}>
                    {itemCell(o)}
                    <td className="num"><b>{fmtP(o.price)}p</b></td>
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
                          {o.costBasis != null ? <>{fmtP(o.costBasis)}p <span className="muted">✎</span></> : <span className="muted">+ add</span>}
                        </button>
                      )}
                    </td>
                    <td className="num">
                      {o.costBasis != null
                        ? <span className={o.price - o.costBasis >= 0 ? "gain-pos" : "loss"}>
                            {o.price - o.costBasis >= 0 ? "+" : ""}{fmtP(o.price - o.costBasis)}p
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

    </div>

    <aside className="orders-side">
      <div className="card history-card">
        <h2>🏁 Flip history</h2>
        {flips.length > 0 ? (
          <>
            <div className="history-total">
              <span className={realized >= 0 ? "gain-pos" : "loss"}>
                {realized >= 0 ? "+" : ""}{fmtP(realized)}p
              </span>
              <span className="muted"> · {flips.length} flip{flips.length === 1 ? "" : "s"}</span>
            </div>
            <div className="feed">
              {sortedFlips.map((f, i) => (
                <div className="feed-row" key={i}>
                  <div className="feed-main">
                    <MarketLink name={f.item} />
                    <div className="muted feed-date">
                      {new Date(f.ts).toLocaleDateString()} · {new Date(f.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div className="feed-nums">
                    <div className="muted">{fmtP(f.buy)}p → {fmtP(f.sell)}p</div>
                    <b className={f.sell - f.buy >= 0 ? "gain-pos" : "loss"}>
                      {f.sell - f.buy >= 0 ? "+" : ""}{fmtP(f.sell - f.buy)}p
                    </b>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="hint">Completed flips land here — close the loop with 🛒 bought → 💰 sold and each one gets logged with its real profit.</p>
        )}
      </div>
    </aside>
    </div>

    {soldOrder && (
      <SoldDialog order={soldOrder}
                  basePlat={basePlat}
                  onDone={() => { setSoldOrder(null); refresh(); }}
                  onCancel={() => setSoldOrder(null)} />
    )}
    </>
  );
}
