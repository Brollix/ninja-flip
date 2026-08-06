import { useEffect, useState } from "react";
import { Check, HandCoins, KeyRound, Pencil, Plus, X } from "lucide-react";
import { fmtP, mySlug, resolveTradeInfo, wfmFetch } from "../lib";
import { createOrder, getUser, isConnected, loadItems, onAuthChange, setCostBasis, signIn, signOut, updateOrder } from "../wfm";
import { Plat, Tag } from "./ui";

export interface ComposerPrefill {
  itemId?: string;
  slug?: string;
  name?: string;
  type?: "buy" | "sell";
  price?: number;
  quantity?: number;
  orderId?: string; // presente => editar en vez de crear
  /** rango del item (0 = sin rankear; para arcanos/mods) */
  rank?: number;
  /** lo que pagaste por el item (para registrar el delta en la venta) */
  costBasis?: number;
  /** buy/sell que mostraba la tabla que abrió esto — puede haber cambiado
   *  desde el último escaneo; se muestra al lado del libro en vivo para
   *  que quede claro por qué pueden no coincidir. */
  refBuy?: number;
  refSell?: number;
}

export function openComposer(p: ComposerPrefill = {}) {
  window.dispatchEvent(new CustomEvent("composer:open", { detail: p }));
}

/** Detalle de "orders:changed": alcanza para que OrdersView actualice SOLO
 *  la orden que cambió (1 request para una nueva, 0 para un precio editado)
 *  en vez de re-chequear todas las órdenes contra la API cada vez. */
export type OrderChangeDetail =
  | { kind: "new"; id: string; itemId: string; slug: string; name: string;
      type: "buy" | "sell"; price: number; qty: number; rank?: number }
  | { kind: "edit"; id: string; price: number; qty?: number };

export function ordersChanged(detail?: OrderChangeDetail) {
  window.dispatchEvent(new CustomEvent("orders:changed", { detail }));
}

interface CatalogItem { id: string; slug: string; name: string }
interface Book { buys: number[]; sells: number[] }

const unit = (o: { platinum: number; perTrade?: number }) =>
  o.platinum / Math.max(o.perTrade ?? 1, 1);
const online = (rank: number, subtype?: string) =>
  (o: { rank?: number; subtype?: string; user?: { status?: string; slug?: string } }) => {
    const me = mySlug();
    return o.user?.status === "ingame" && (o.rank ?? 0) === rank &&
      (subtype == null || o.subtype === subtype) &&
      (me === null || o.user?.slug?.toLowerCase() !== me);
  };

// ---------- login ----------

export function LoginForm({ compact }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function go() {
    setBusy(true); setErr("");
    try {
      await signIn(email.trim(), pass);
      setPass("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`login ${compact ? "compact" : ""}`}>
      <div className="login-title"><KeyRound size={14} className="inline-icon" /> Connect warframe.market</div>
      <div className="login-fields">
        <input type="email" placeholder="email" autoComplete="username"
               value={email} onChange={e => setEmail(e.target.value)} />
        <input type="password" placeholder="password" autoComplete="current-password"
               value={pass} onChange={e => setPass(e.target.value)}
               onKeyDown={e => e.key === "Enter" && go()} />
        <button className="btn primary" disabled={busy || !email || !pass} onClick={go}>
          {busy ? "connecting…" : "Connect"}
        </button>
      </div>
      {err && <p className="loss">{err}</p>}
    </div>
  );
}

export function AuthStatus() {
  const [, force] = useState(0);
  useEffect(() => onAuthChange(() => force(x => x + 1)), []);
  if (!isConnected()) return null;
  const u = getUser();
  return (
    <span className="auth-status">
      <span className="auth-name"><span className="status-dot online" /> {u?.ingame_name ?? "connected"}</span>
      <button className="btn" onClick={signOut} title="Sign out of warframe.market in this browser">sign out</button>
    </span>
  );
}

// ---------- composer ----------

export function Composer() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposerPrefill>({});
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [bookLoading, setBookLoading] = useState(false);
  const [type, setType] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState<number>(0);
  const [qty, setQty] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [connected, setConnected] = useState(isConnected());
  const [rank, setRank] = useState(0);
  const [subtype, setSubtype] = useState<string | undefined>(undefined);
  const [bulkTradable, setBulkTradable] = useState(false);
  const [rankLoading, setRankLoading] = useState(false);

  useEffect(() => onAuthChange(() => setConnected(isConnected())), []);

  useEffect(() => {
    const onOpen = async (e: Event) => {
      const p = (e as CustomEvent<ComposerPrefill>).detail ?? {};
      setPrefill(p);
      setErr(""); setDone(false); setBook(null); setItem(null);
      setRank(0); setSubtype(undefined); setBulkTradable(false);
      setType(p.type ?? "buy");
      setPrice(p.price ?? 0);
      setQty(p.quantity ?? 1);
      setOpen(true);
      // siempre llega con slug o itemId (WTB/WTS de Flips/Sniper, "post sell"
      // de una compra detectada, editar una orden existente) — no hay un
      // "post order en blanco" que busque el item a mano.
      const items = await loadItems();
      const list = Object.entries(items).map(([id, [slug, name]]) => ({ id, slug, name }));
      const found = p.itemId ? list.find(i => i.id === p.itemId)
        : p.slug ? list.find(i => i.slug === p.slug) : null;
      if (found) selectItem(found, p.price == null);
    };
    window.addEventListener("composer:open", onOpen);
    return () => window.removeEventListener("composer:open", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function selectItem(it: CatalogItem, autoPrice: boolean) {
    setItem(it); setBook(null); setBookLoading(true);
    // Rango en el que se flipea (arcanos y primed mods grandes: siempre
    // maxeados) y si el item acepta "perTrade" al publicar (arcanos sí,
    // sets y primed mods no) — cacheado por slug, así que en re-aperturas
    // del mismo item es instantáneo.
    setRankLoading(true);
    const { rank, bulkTradable, subtype } = await resolveTradeInfo(it.slug, it.name);
    setRankLoading(false);
    setRank(rank);
    setSubtype(subtype);
    setBulkTradable(bulkTradable);
    try {
      type RawOrder = {
        type?: "buy" | "sell"; platinum: number; perTrade?: number; rank?: number; subtype?: string;
        user?: { status?: string; slug?: string };
      };
      const isOk = online(rank, subtype);
      let buys: number[], sells: number[];
      if (rank > 0) {
        // /top solo trae las 5 puntas globales (rango 0 en arcanos/mods):
        // con rango > 0 hay que leer el libro completo y filtrar por rango.
        const res = await wfmFetch(`/wfm/v2/orders/item/${it.slug}`);
        if (!res.ok) { setBook({ buys: [], sells: [] }); return; }
        const all = (await res.json()).data as RawOrder[];
        buys = all.filter(o => o.type === "buy" && isOk(o)).map(unit).sort((a, b) => b - a);
        sells = all.filter(o => o.type === "sell" && isOk(o)).map(unit).sort((a, b) => a - b);
      } else {
        const res = await wfmFetch(`/wfm/v2/orders/item/${it.slug}/top`);
        if (!res.ok) { setBook({ buys: [], sells: [] }); return; }
        const d = (await res.json()).data as { buy?: RawOrder[]; sell?: RawOrder[] };
        buys = (d.buy ?? []).filter(isOk).map(unit).sort((a, b) => b - a);
        sells = (d.sell ?? []).filter(isOk).map(unit).sort((a, b) => a - b);
      }
      setBook({ buys, sells });
      if (autoPrice) {
        setPrice(suggested({ buys, sells }, type));
      }
    } finally {
      setBookLoading(false);
    }
  }

  function suggested(b: Book, t: "buy" | "sell"): number {
    if (t === "buy") return b.buys.length ? Math.round(b.buys[0] + 1) : (b.sells[0] ? Math.round(b.sells[0] * 0.7) : 10);
    return b.sells.length ? Math.max(1, Math.round(b.sells[0] - 1)) : (b.buys[0] ? Math.round(b.buys[0] * 1.3) : 10);
  }

  function switchType(t: "buy" | "sell") {
    setType(t);
    if (book) setPrice(suggested(book, t));
  }

  async function publish() {
    if (!item || price < 1) return;
    setBusy(true); setErr("");
    try {
      if (prefill.orderId) {
        await updateOrder(prefill.orderId, { platinum: price, quantity: qty });
        ordersChanged({ kind: "edit", id: prefill.orderId, price, qty });
      } else {
        const order = await createOrder({
          itemId: item.id, type, platinum: price, quantity: qty,
          rank: rank || undefined, subtype, bulkTradable,
        });
        if (type === "sell" && prefill.costBasis != null && order?.id) {
          setCostBasis(order.id, prefill.costBasis, item.name);
        }
        if (order?.id) {
          ordersChanged({ kind: "new", id: order.id, itemId: item.id, slug: item.slug,
                          name: item.name, type, price, qty, rank: rank || undefined });
        }
      }
      setDone(true);
      setTimeout(() => setOpen(false), 1300);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const editing = !!prefill.orderId;

  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Post order">
        <div className="modal-head">
          <h2>{editing
            ? <><Pencil size={15} /> Edit order — {prefill.name ?? item?.name ?? ""}</>
            : <><Plus size={15} /> Post order</>}</h2>
          <button className="linkish close" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
        </div>

        {!connected ? <LoginForm compact /> : (
          <>
            {item && (
              <>
                <div className="composer-item">
                  <b>{item.name}</b>
                  {rankLoading && <span className="muted"> · checking rank…</span>}
                  {!rankLoading && rank > 0 && <Tag title="Arcanes and primed mods trade maxed">rank {rank}</Tag>}
                </div>

                <div className="book">
                  {(bookLoading || rankLoading) && <span className="muted">loading order book…</span>}
                  {book && (
                    <>
                      <div className="book-col">
                        <div className="book-title">Buyers pay</div>
                        {book.buys.slice(0, 3).map((p, i) => <div key={i} className="book-price buy"><Plat value={p} /></div>)}
                        {!book.buys.length && <div className="muted">none</div>}
                      </div>
                      <div className="book-col">
                        <div className="book-title">Sellers ask</div>
                        {book.sells.slice(0, 3).map((p, i) => <div key={i} className="book-price sell"><Plat value={p} /></div>)}
                        {!book.sells.length && <div className="muted">none</div>}
                      </div>
                    </>
                  )}
                </div>
                {book && (prefill.refBuy != null || prefill.refSell != null) && (
                  (prefill.refBuy !== book.buys[0] || prefill.refSell !== book.sells[0]) && (
                    <p className="composer-note ref-note">
                      Table showed {prefill.refBuy != null ? <Plat value={prefill.refBuy} /> : "—"} /{" "}
                      {prefill.refSell != null ? <Plat value={prefill.refSell} /> : "—"} — prices moved since that scan,
                      the book above is live right now.
                    </p>
                  )
                )}

                {!editing && (
                  <div className="seg">
                    <button className={`seg-btn ${type === "buy" ? "active buy" : ""}`} onClick={() => switchType("buy")}>
                      WTB · buy
                    </button>
                    <button className={`seg-btn ${type === "sell" ? "active sell" : ""}`} onClick={() => switchType("sell")}>
                      WTS · sell
                    </button>
                  </div>
                )}

                <div className="composer-fields">
                  <label className="sim-field">Price
                    <input type="number" min={1} value={price || ""} onChange={e => setPrice(+e.target.value || 0)} /> p
                  </label>
                  <label className="sim-field">Quantity
                    <input type="number" min={1} value={qty} onChange={e => setQty(Math.max(1, +e.target.value || 1))} />
                  </label>
                  {book && (
                    <span className="chips">
                      {type === "buy" && book.buys.length > 0 && (
                        <button className="chip" onClick={() => setPrice(Math.round(book.buys[0] + 1))}>
                          top bidder ({Math.round(book.buys[0] + 1)}p)
                        </button>
                      )}
                      {type === "sell" && book.sells.length > 0 && (
                        <button className="chip" onClick={() => setPrice(Math.max(1, Math.round(book.sells[0] - 1)))}>
                          cheapest ({Math.max(1, Math.round(book.sells[0] - 1))}p)
                        </button>
                      )}
                    </span>
                  )}
                </div>

                {type === "sell" && prefill.costBasis != null && price > 0 && (
                  <p className="composer-note">
                    <HandCoins size={13} className="inline-icon" /> You paid <b><Plat value={prefill.costBasis} /></b> → profit at this price:{" "}
                    <b className={price - prefill.costBasis >= 0 ? "gain-pos" : "loss"}>
                      <Plat value={price - prefill.costBasis} sign />
                    </b>
                  </p>
                )}
                {price > 0 && book && (
                  <p className="composer-note">
                    {type === "buy"
                      ? (book.buys[0] != null && price > book.buys[0]
                          ? `You'll be the top bidder (above the current ${fmtP(book.buys[0])}p).`
                          : book.sells[0] != null && price >= book.sells[0]
                            ? `⚠ You're offering ${fmtP(price)}p but sellers already ask ${fmtP(book.sells[0])}p — just buy it, don't post.`
                            : `You'll wait in line (top bidder pays ${book.buys[0] != null ? fmtP(book.buys[0]) : "—"}p).`)
                      : (book.sells[0] != null && price < book.sells[0]
                          ? `You'll be the cheapest (under ${fmtP(book.sells[0])}p).`
                          : book.buys[0] != null && price <= book.buys[0]
                            ? `⚠ You ask ${fmtP(price)}p but buyers already pay ${fmtP(book.buys[0])}p — sell to them directly.`
                            : `You'll wait in line (cheapest asks ${book.sells[0] != null ? fmtP(book.sells[0]) : "—"}p).`)}
                  </p>
                )}

                <div className="composer-footer">
                  {err && <span className="loss">{err}</span>}
                  {done
                    ? <span className="gain-pos"><Check size={14} className="inline-icon" /> {editing ? "order updated" : "order posted"}</span>
                    : <button className="btn primary big" disabled={busy || price < 1} onClick={publish}>
                        {busy ? "posting…"
                          : editing ? `Save changes (${price}p × ${qty})`
                          : `Post ${type === "buy" ? "BUY" : "SELL"} at ${price}p × ${qty}`}
                      </button>}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
