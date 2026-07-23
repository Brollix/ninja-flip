import { useEffect, useMemo, useRef, useState } from "react";
import { fmtP, mySlug, wfmFetch } from "../lib";
import { createOrder, getUser, isConnected, loadItems, onAuthChange, setCostBasis, signIn, signOut, updateOrder } from "../wfm";

export interface ComposerPrefill {
  itemId?: string;
  slug?: string;
  name?: string;
  type?: "buy" | "sell";
  price?: number;
  quantity?: number;
  orderId?: string; // presente => editar en vez de crear
  /** lo que pagaste por el item (para registrar el delta en la venta) */
  costBasis?: number;
}

export function openComposer(p: ComposerPrefill = {}) {
  window.dispatchEvent(new CustomEvent("composer:open", { detail: p }));
}
export function ordersChanged(detail?: { slug?: string; type?: "buy" | "sell" }) {
  window.dispatchEvent(new CustomEvent("orders:changed", { detail }));
}

interface CatalogItem { id: string; slug: string; name: string }
interface Book { buys: number[]; sells: number[] }

const unit = (o: { platinum: number; perTrade?: number }) =>
  o.platinum / Math.max(o.perTrade ?? 1, 1);
const online = (o: { user?: { status?: string; slug?: string } }) => {
  const me = mySlug();
  return o.user?.status === "ingame" && (me === null || o.user?.slug?.toLowerCase() !== me);
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
      <div className="login-title">🔐 Connect your warframe.market account</div>
      <p className="hint">
        Credentials go <b>straight from your browser to warframe.market</b>; the session token stays in this browser only.
      </p>
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
      <span className="auth-name">🟢 {u?.ingame_name ?? "connected"}</span>
      <button className="btn" onClick={signOut} title="Sign out of warframe.market in this browser">sign out</button>
    </span>
  );
}

// ---------- composer ----------

export function Composer() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposerPrefill>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [term, setTerm] = useState("");
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
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => onAuthChange(() => setConnected(isConnected())), []);

  useEffect(() => {
    const onOpen = async (e: Event) => {
      const p = (e as CustomEvent<ComposerPrefill>).detail ?? {};
      setPrefill(p);
      setErr(""); setDone(false); setBook(null); setItem(null); setTerm("");
      setType(p.type ?? "buy");
      setPrice(p.price ?? 0);
      setQty(p.quantity ?? 1);
      setOpen(true);
      const items = await loadItems();
      const list = Object.entries(items).map(([id, [slug, name]]) => ({ id, slug, name }));
      setCatalog(list);
      const found = p.itemId ? list.find(i => i.id === p.itemId)
        : p.slug ? list.find(i => i.slug === p.slug) : null;
      if (found) selectItem(found, p.price == null);
      else setTimeout(() => searchRef.current?.focus(), 50);
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

  const matches = useMemo(() => {
    if (!term || term.length < 2) return [];
    const t = term.toLowerCase();
    return catalog
      .filter(i => i.name.toLowerCase().includes(t))
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, 8);
  }, [term, catalog]);

  async function selectItem(it: CatalogItem, autoPrice: boolean) {
    setItem(it); setTerm(""); setBook(null); setBookLoading(true);
    try {
      const res = await wfmFetch(`/wfm/v2/orders/item/${it.slug}/top`);
      if (res.ok) {
        const d = (await res.json()).data as {
          buy?: { platinum: number; perTrade?: number; user?: { status?: string; slug?: string } }[];
          sell?: { platinum: number; perTrade?: number; user?: { status?: string; slug?: string } }[];
        };
        const buys = (d.buy ?? []).filter(online).map(unit).sort((a, b) => b - a);
        const sells = (d.sell ?? []).filter(online).map(unit).sort((a, b) => a - b);
        setBook({ buys, sells });
        if (autoPrice) {
          setPrice(suggested({ buys, sells }, type));
        }
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
      } else {
        const order = await createOrder({ itemId: item.id, type, platinum: price, quantity: qty });
        if (type === "sell" && prefill.costBasis != null && order?.id) {
          setCostBasis(order.id, prefill.costBasis, item.name);
        }
      }
      setDone(true);
      ordersChanged(!prefill.orderId && item ? { slug: item.slug, type } : undefined);
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
          <h2>{editing ? `✏️ Edit order — ${prefill.name ?? item?.name ?? ""}` : "➕ Post order"}</h2>
          <button className="linkish close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>

        {!connected ? <LoginForm compact /> : (
          <>
            {!editing && !item && (
              <div className="composer-search">
                <input ref={searchRef} placeholder="Search item… (e.g. afuris prime set)"
                       value={term} onChange={e => setTerm(e.target.value)} />
                {matches.length > 0 && (
                  <div className="autocomplete">
                    {matches.map(m => (
                      <button key={m.id} className="ac-row" onClick={() => selectItem(m, true)}>{m.name}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {item && (
              <>
                <div className="composer-item">
                  <b>{item.name}</b>
                  {!editing && <button className="linkish muted" onClick={() => { setItem(null); setBook(null); }}> · change</button>}
                </div>

                <div className="book">
                  {bookLoading && <span className="muted">loading order book…</span>}
                  {book && (
                    <>
                      <div className="book-col">
                        <div className="book-title">Buyers pay</div>
                        {book.buys.slice(0, 3).map((p, i) => <div key={i} className="book-price buy">{fmtP(p)}p</div>)}
                        {!book.buys.length && <div className="muted">none</div>}
                      </div>
                      <div className="book-col">
                        <div className="book-title">Sellers ask</div>
                        {book.sells.slice(0, 3).map((p, i) => <div key={i} className="book-price sell">{fmtP(p)}p</div>)}
                        {!book.sells.length && <div className="muted">none</div>}
                      </div>
                    </>
                  )}
                </div>

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
                    💰 You paid <b>{fmtP(prefill.costBasis)}p</b> → profit at this price:{" "}
                    <b className={price - prefill.costBasis >= 0 ? "gain-pos" : "loss"}>
                      {price - prefill.costBasis >= 0 ? "+" : ""}{fmtP(price - prefill.costBasis)}p
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
                    ? <span className="gain-pos">✓ {editing ? "order updated" : "order posted"}</span>
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
