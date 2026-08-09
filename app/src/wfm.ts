import { wfmFetch, prettyItemName } from "./lib";

// Cliente autenticado de warframe.market (vía el proxy /wfm del dev server).
// El JWT vive en localStorage de TU navegador; las credenciales viajan
// directo del navegador a warframe.market, acá no se guardan nunca.

export interface WfmUser {
  ingame_name: string;
  slug?: string;
  id: string;
}

export interface WfmOrder {
  id: string;
  order_type: "buy" | "sell";
  platinum: number;
  quantity: number;
  visible: boolean;
  item?: { id: string };
}

const JWT_KEY = "wfm_jwt";
const USER_KEY = "wfm_user_info";
const BASIS_KEY = "cost_basis_v1";
const FLIPS_KEY = "flips_log_v1";

export const getJwt = (): string | null => localStorage.getItem(JWT_KEY);
export const getUser = (): WfmUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as WfmUser) : null;
};
export const isConnected = (): boolean => !!getJwt();

// Todo lo demás cacheado en localStorage (flips, cost basis, plat override,
// filtro de usuario de AlecaFrame, skip del token, compras ya vistas) es
// data de ESTA cuenta — si alguien más se loguea después en el mismo
// navegador (vos probando y después le pasás la compu a un amigo, por
// ejemplo), syncLedger() subiría tu historial como si fuera el suyo si no
// se limpia acá. Sin esto, cambiar de cuenta en el mismo browser mezclaba
// los datos financieros de dos personas distintas.
const PER_USER_KEYS = [
  BASIS_KEY, FLIPS_KEY, "wfm_user", "plat_override",
  "aleca_skip_v1", "purchases_dismissed_v1",
  // "orders_cache_v2" (ver OrdersView.tsx:CACHE_KEY) — sin esto, cambiar de
  // cuenta en el mismo browser pintaba por un instante el order book
  // cacheado de la cuenta ANTERIOR hasta el primer refresh real.
  "orders_cache_v2",
];

export function signOut(): void {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
  for (const k of PER_USER_KEYS) localStorage.removeItem(k);
  notify();
}

// pub/sub mínimo para que la UI reaccione a conectar/desconectar
const listeners = new Set<() => void>();
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach(fn => fn());

// ---------- premium / admin ----------
// Todavía no hay Patreon (ni ningún cobro real) conectado — mientras tanto,
// estas cuentas quedan "siempre premium" a mano (los primeros en probar
// esto, gratis de por vida). Por wfm_user_id (el ID interno, permanente),
// no por slug — el nombre de usuario se puede cambiar, el ID no. Reemplazar
// por un chequeo real de membresía cuando exista la integración con Patreon.
const ALWAYS_PREMIUM_IDS = new Set([
  "5b9bf77418d4f700ad180263", // Brollix
  "69b9a72a4a1f65002a9db15b", // Spazz_0000
]);
// Solo vos podés ver el toggle de "previsualizar como basic/premium" —
// nadie más ve ni puede tocar esto.
const ADMIN_IDS = new Set(["5b9bf77418d4f700ad180263"]); // Brollix

const PREVIEW_KEY = "admin_preview_mode"; // "basic" | "premium" | ausente

function currentUserId(): string | null {
  return getUser()?.id ?? null;
}

export function isAdmin(): boolean {
  const id = currentUserId();
  return id != null && ADMIN_IDS.has(id);
}

export function getPreviewMode(): "basic" | "premium" | null {
  if (!isAdmin()) return null; // el override solo aplica para el admin
  const v = localStorage.getItem(PREVIEW_KEY);
  return v === "basic" || v === "premium" ? v : null;
}

export function setPreviewMode(mode: "basic" | "premium" | null): void {
  if (mode) localStorage.setItem(PREVIEW_KEY, mode);
  else localStorage.removeItem(PREVIEW_KEY);
  notify(); // reusa el pub/sub de auth para que la UI se actualice sola
}

// Estado real de Patreon, traído del server (ver premium.ts) — cache en
// memoria llenado por syncPremiumStatus(), mismo patrón que
// detectedFlipsCache: se lee sincrónico acá, se llena async en otro lado
// (App.tsx, junto al resto del refresh de arranque).
let premiumServerCache: boolean | null = null;

export async function syncPremiumStatus(): Promise<void> {
  try {
    const p = ledgerFetch("/api/premium");
    if (!p) return; // sin sesión de wfm: no hay a quién chequear
    const res = await p;
    if (!res.ok) return;
    const body = (await res.json()) as { premium?: boolean };
    const next = !!body.premium;
    // Notificar solo si CAMBIÓ: App.tsx suscribe refresh() a onAuthChange, y
    // refresh() llama syncPremiumStatus() — notificar siempre creaba un loop
    // infinito (refresh -> syncPremiumStatus -> notify -> refresh -> ...),
    // atado solo a la latencia de red. Esto fue lo que vació la cuota de
    // transferencia de datos de Neon en producción (~1.8GB/hora).
    if (next !== premiumServerCache) {
      premiumServerCache = next;
      notify();
    }
  } catch { /* sin red: se queda con lo que ya tenía */ }
}

/** Manda al browser a loguearse con SU cuenta de Patreon ("Connect with
 *  Patreon" real, no un email tipeado a mano) — navegación de página entera,
 *  no fetch, porque Patreon tiene que mostrar su propia pantalla de login.
 *  Vuelve a esta misma app en /api/patreon/callback -> redirect a "/". */
export async function startPatreonConnect(): Promise<void> {
  const jwt = getJwt();
  if (!jwt) throw new Error("Not connected to warframe.market");
  const res = await fetch("/api/premium/authorize", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? `http ${res.status}`);
  window.location.href = body.url;
}

export function isPremium(): boolean {
  const preview = getPreviewMode();
  if (preview) return preview === "premium";
  const id = currentUserId();
  if (id != null && ALWAYS_PREMIUM_IDS.has(id)) return true;
  return premiumServerCache === true;
}

export async function signIn(email: string, password: string): Promise<WfmUser> {
  const res = await wfmFetch("/wfm/v1/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "JWT" },
    body: JSON.stringify({ email, password, auth_type: "header" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = JSON.stringify(body.error ?? body);
    if (err.includes("password_invalid") || err.includes("email_invalid")) {
      throw new Error("Wrong email or password");
    }
    throw new Error(`Sign-in failed: ${err}`);
  }
  const auth = res.headers.get("authorization") ?? res.headers.get("Authorization");
  if (!auth) throw new Error("warframe.market didn't return a session token");
  localStorage.setItem(JWT_KEY, auth.replace(/^JWT\s*/i, ""));
  const u = body?.payload?.user ?? {};
  const user: WfmUser = {
    ingame_name: u.ingame_name ?? "?",
    slug: u.slug ?? undefined,
    id: u.id ?? "",
  };
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  notify();
  return user;
}

// Las órdenes se manejan con la API v2 (los endpoints v1 de órdenes ya no
// existen). v2 autentica con "Authorization: Bearer <jwt>" — el mismo JWT
// que devuelve el signin v1.
async function authed(path: string, init: RequestInit = {}): Promise<unknown> {
  const jwt = getJwt();
  if (!jwt) throw new Error("Not connected to warframe.market");
  const res = await wfmFetch(`/wfm${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  const errStr = JSON.stringify((body as { error?: unknown }).error ?? "");
  if (res.status === 401 || errStr.includes("jwt.invalid") || errStr.includes("jwt.expired")) {
    signOut();
    throw new Error("Session expired — reconnect");
  }
  if (!res.ok) {
    // Traduce los códigos de error de wfm que sabemos que vamos a pisar
    // seguido (el usuario ya se topó con este en producción) — el resto
    // se muestra crudo, no inventamos traducciones de códigos que no
    // confirmamos que existan.
    if (errStr.includes("exceededOrderLimitSamePrice")) {
      throw new Error("You already have an order for this item at that exact price — pick a different price.");
    }
    throw new Error(`Market error: ${errStr || res.status}`);
  }
  return body;
}

interface OrderPayload { data?: WfmOrder }

export async function createOrder(params: {
  itemId: string; type: "buy" | "sell"; platinum: number; quantity: number;
  rank?: number;
  /** items con variantes de subtipo (ej. Primed Target Cracker: "regular" vs
   *  "atragraph") lo exigen en la orden — sin esto la API rechaza el POST
   *  con "subtype: app.field.required". */
  subtype?: string;
  /** solo los items "bulkTradable" (arcanos) aceptan perTrade — a los demás
   *  (sets, primed mods) la API se lo rechaza si se lo mandás. */
  bulkTradable?: boolean;
}): Promise<WfmOrder | undefined> {
  const body = (await authed("/v2/order", {
    method: "POST",
    body: JSON.stringify({
      itemId: params.itemId,
      type: params.type,
      platinum: Math.round(params.platinum),
      quantity: Math.max(1, Math.round(params.quantity)),
      visible: true,
      ...(params.rank != null ? { rank: params.rank } : {}),
      ...(params.subtype ? { subtype: params.subtype } : {}),
      ...(params.bulkTradable ? { perTrade: 1 } : {}),
    }),
  })) as OrderPayload;
  return body.data;
}

export async function updateOrder(orderId: string, params: {
  platinum: number; quantity?: number; visible?: boolean;
}): Promise<WfmOrder | undefined> {
  const body = (await authed(`/v2/order/${orderId}`, {
    method: "PATCH",
    body: JSON.stringify({
      platinum: Math.round(params.platinum),
      ...(params.quantity ? { quantity: Math.round(params.quantity) } : {}),
      visible: params.visible ?? true,
    }),
  })) as OrderPayload;
  return body.data;
}

/** Solo cambia visible, sin tocar precio/cantidad — usado por la pausa
 *  manual/automática (ver OrdersView). No existe un PATCH "solo visible" en
 *  la v2 de wfm, así que hay que mandar platinum igual: el mismo que ya
 *  tenía la orden, para no pisarlo de paso. */
export async function setOrderVisible(orderId: string, platinum: number, visible: boolean): Promise<WfmOrder | undefined> {
  return updateOrder(orderId, { platinum, visible });
}

export async function deleteOrder(orderId: string): Promise<void> {
  await authed(`/v2/order/${orderId}`, { method: "DELETE" });
}

const isGone = (e: unknown) =>
  e instanceof Error && /not.?found|404|order.*missing/i.test(e.message);

/** Marca la orden como concretada. Si el precio real difiere del publicado,
 *  primero lo corrige para que el market registre la transacción exacta.
 *  Si la orden ya no existe (p. ej. AlecaFrame la borró al detectar el
 *  trade), lo tratamos como cerrada y seguimos. */
export async function closeOrder(orderId: string, executedPrice?: number,
                                 publishedPrice?: number, quantity = 1): Promise<void> {
  try {
    if (executedPrice != null && publishedPrice != null &&
        Math.round(executedPrice) !== Math.round(publishedPrice)) {
      await updateOrder(orderId, { platinum: executedPrice });
    }
    await authed(`/v2/order/${orderId}/close`, {
      method: "POST",
      body: JSON.stringify({ quantity: Math.max(1, Math.round(quantity)) }),
    });
  } catch (e) {
    if (!isGone(e)) throw e;
  }
}

/** Todas mis órdenes (incluye ocultas) — requiere sesión.
 *  Devuelve null si el market no expone un endpoint propio (fallback al público). */
export async function fetchMyOrders(): Promise<unknown[] | null> {
  for (const path of ["/v2/me/orders", "/v2/orders/my", "/v2/orders/me"]) {
    try {
      const body = (await authed(path)) as { data?: unknown };
      const d = body.data;
      if (Array.isArray(d)) return d;
      if (d && typeof d === "object") {
        const o = d as { buy?: unknown[]; sell?: unknown[] };
        return [...(o.buy ?? []), ...(o.sell ?? [])];
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("Session expired")) throw e;
      // 404 u otro error de ruta: probamos la siguiente
    }
  }
  return null;
}

// ---------- cost basis: lo que pagaste, para calcular el delta al vender ----------

interface BasisEntry { cost: number; item: string; ts: number }
export interface FlipRecord {
  item: string; buy: number; sell: number; ts: number;
  /** cuánto vale HOY lo mismo que flipeaste — solo en flips auto-detectados
   *  (AlecaFrame), no en los que confirmás a mano con 🛒/💰. */
  market_now?: number;
}

function basisMap(): Record<string, BasisEntry> {
  try { return JSON.parse(localStorage.getItem(BASIS_KEY) ?? "{}"); }
  catch { return {}; }
}

/** El ledger ahora vive en Postgres, por usuario — identificado por el JWT
 *  de warframe.market (mismo que ya usás para todo lo demás, sin login
 *  aparte). Sin sesión no hay a quién scopear estas filas, así que no pega
 *  a la red — localStorage sigue mandando en ese caso, igual que antes
 *  cuando no había server de ledger corriendo. */
function ledgerFetch(path: string, init: RequestInit = {}): Promise<Response> | null {
  const jwt = getJwt();
  if (!jwt) return null;
  return fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${jwt}` },
  });
}

export function setCostBasis(orderId: string, cost: number, item: string): void {
  const m = basisMap();
  const entry = { cost, item, ts: Date.now() };
  m[orderId] = entry;
  localStorage.setItem(BASIS_KEY, JSON.stringify(m));
  // espejo al ledger en disco (fire-and-forget)
  ledgerFetch("/ledger/basis", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, ...entry }),
  })?.catch(() => {});
}

export function getCostBasis(orderId: string): BasisEntry | null {
  return basisMap()[orderId] ?? null;
}

export function removeCostBasis(orderId: string): void {
  const m = basisMap();
  if (orderId in m) {
    delete m[orderId];
    localStorage.setItem(BASIS_KEY, JSON.stringify(m));
  }
  ledgerFetch(`/ledger/basis/${encodeURIComponent(orderId)}`, { method: "DELETE" })?.catch(() => {});
}

export function logFlip(f: FlipRecord): void {
  try {
    const list = JSON.parse(localStorage.getItem(FLIPS_KEY) ?? "[]") as FlipRecord[];
    list.push(f);
    localStorage.setItem(FLIPS_KEY, JSON.stringify(list));
  } catch { /* localStorage lleno o corrupto: el flip igual se cerró */ }
  ledgerFetch("/ledger/flip", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(f),
  })?.catch(() => {});
}

// Flips detectados automáticamente del historial de trades de AlecaFrame
// (tabla separada, user_detected_flips — ver report_server.py). Nunca se
// crean del lado del cliente, solo se leen: alcanza con un cache en memoria
// llenado en cada syncLedger().
let detectedFlipsCache: FlipRecord[] = [];
export function getDetectedFlips(): FlipRecord[] {
  return detectedFlipsCache;
}

/** Manuales (🛒/💰 en la app) + detectados del historial de AlecaFrame, en un
 *  solo Flip History. El MISMO trade real puede quedar en las dos tablas (lo
 *  confirmaste a mano Y AlecaFrame lo vio en tu historial) — se descarta el
 *  detectado si ya hay uno manual del mismo item a un precio de venta
 *  parecido (±1p). Un solo lugar para esta regla — OrdersView y cualquier
 *  otra vista que agrupe flips (ver views.tsx) parten de acá. */
export function getAllFlips(): FlipRecord[] {
  const flips = getFlips();
  const detected = getDetectedFlips().filter(d =>
    !flips.some(f => prettyItemName(f.item) === prettyItemName(d.item) && Math.abs(f.sell - d.sell) <= 1));
  return [...flips, ...detected];
}

/** Sincroniza el ledger en disco con localStorage (dos vías) al arrancar:
 *  restaura lo que falte localmente y sube lo que falte en la base. */
export async function syncLedger(): Promise<void> {
  try {
    const res = await ledgerFetch("/ledger/all");
    if (!res || !res.ok) return;
    const server = (await res.json()) as {
      flips: FlipRecord[];
      basis: Record<string, BasisEntry>;
      detectedFlips?: FlipRecord[];
    };
    detectedFlipsCache = server.detectedFlips ?? [];
    // flips: unión por (item, ts)
    const local = getFlips();
    const key = (f: FlipRecord) => `${f.item}|${f.ts}`;
    const localKeys = new Set(local.map(key));
    const serverKeys = new Set(server.flips.map(key));
    const merged = [...local, ...server.flips.filter(f => !localKeys.has(key(f)))]
      .sort((a, b) => a.ts - b.ts);
    localStorage.setItem(FLIPS_KEY, JSON.stringify(merged));
    for (const f of local.filter(f => !serverKeys.has(key(f)))) {
      await ledgerFetch("/ledger/flip", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      })?.catch(() => {});
    }
    // basis: unión por orderId
    const localBasis = basisMap();
    const mergedBasis = { ...server.basis, ...localBasis };
    localStorage.setItem(BASIS_KEY, JSON.stringify(mergedBasis));
    for (const [id, b] of Object.entries(localBasis)) {
      if (!(id in server.basis)) {
        await ledgerFetch("/ledger/basis", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: id, ...b }),
        })?.catch(() => {});
      }
    }
  } catch { /* sin server de ledger (build estático): localStorage sigue mandando */ }
}

export function getFlips(): FlipRecord[] {
  try { return JSON.parse(localStorage.getItem(FLIPS_KEY) ?? "[]"); }
  catch { return []; }
}

// ---------- catálogo compartido (id -> [slug, nombre]) ----------

let itemsCache: Record<string, [string, string]> | null = null;
export async function loadItems(): Promise<Record<string, [string, string]>> {
  if (!itemsCache) {
    itemsCache = await (await fetch("/api/items", { cache: "no-store" })).json();
  }
  return itemsCache!;
}

/** Nombre de AlecaFrame ("Arcane Hot Shot") -> {id, slug} del catálogo, para
 *  abrir el composer desde una compra detectada (solo tenemos el nombre,
 *  no el slug — a diferencia de Flips/Sniper que ya vienen con slug). */
export async function resolveItemByName(name: string): Promise<{ id: string; slug: string } | null> {
  const items = await loadItems();
  const target = name.trim().toLowerCase();
  for (const [id, [slug, itemName]] of Object.entries(items)) {
    if (itemName.trim().toLowerCase() === target) return { id, slug };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshots de plat propios: cada compra/venta confirmada en la app (o
// corrección manual) queda registrada acá con su timestamp real — a
// diferencia del historial de AlecaFrame (un punto por día, cuando corre su
// propio sync), esto se mueve por ACCIÓN además de por tiempo. Es una
// ESTIMACIÓN acumulada (arranca del último valor conocido y suma/resta lo
// que vas confirmando en la app) hasta que un snapshot nuevo de AlecaFrame
// la confirma — si no coincide exacto, la diferencia se asume gastada/
// ganada por fuera de la app (trade manual, plat comprada con plata real,
// etc.), no un error nuestro.
// ---------------------------------------------------------------------------
export interface PlatSnapshot { ts: number; plat: number }
export interface PlatReconciliation { ts: number; delta: number }

const PLAT_SNAPSHOTS_KEY = "plat_snapshots_v1";
const PLAT_RECON_KEY = "plat_reconciliations_v1";
const MAX_PLAT_SNAPSHOTS = 300;
const MAX_PLAT_RECONCILIATIONS = 50;

export function getPlatSnapshots(): PlatSnapshot[] {
  try { return JSON.parse(localStorage.getItem(PLAT_SNAPSHOTS_KEY) ?? "[]"); }
  catch { return []; }
}

function logPlatSnapshot(plat: number): void {
  const snaps = getPlatSnapshots();
  snaps.push({ ts: Date.now(), plat: Math.round(plat) });
  localStorage.setItem(PLAT_SNAPSHOTS_KEY, JSON.stringify(snaps.slice(-MAX_PLAT_SNAPSHOTS)));
}

export function getPlatReconciliations(): PlatReconciliation[] {
  try { return JSON.parse(localStorage.getItem(PLAT_RECON_KEY) ?? "[]"); }
  catch { return []; }
}

/** Se llama con el snapshot MÁS NUEVO de AlecaFrame — si había estimaciones
 *  nuestras de antes de esa fecha, compara la última contra el valor real
 *  que confirmó Aleca y, si no coincide, guarda la diferencia como un
 *  ajuste (plat movida por fuera de la app). Después descarta esas
 *  estimaciones viejas: ya quedaron cubiertas por el dato real. */
export function reconcilePlatSnapshots(officialTs: number, officialPlat: number): void {
  const snaps = getPlatSnapshots();
  const before = snaps.filter(s => s.ts <= officialTs);
  if (before.length) {
    const delta = Math.round(officialPlat - before[before.length - 1].plat);
    if (delta !== 0) {
      const recon = getPlatReconciliations();
      recon.push({ ts: officialTs, delta });
      localStorage.setItem(PLAT_RECON_KEY, JSON.stringify(recon.slice(-MAX_PLAT_RECONCILIATIONS)));
    }
  }
  const after = snaps.filter(s => s.ts > officialTs);
  localStorage.setItem(PLAT_SNAPSHOTS_KEY, JSON.stringify(after));
}

/** Fija tu plat "actual" (compra/venta confirmada o corrección manual) y
 *  deja un snapshot con timestamp real — único punto de escritura de
 *  plat_override, así ningún caller se olvida de loguear el snapshot. */
export function setPlatOverride(value: number): void {
  const v = Math.max(0, Math.round(value));
  localStorage.setItem("plat_override", JSON.stringify({ value: v, ts: Date.now() }));
  logPlatSnapshot(v);
  window.dispatchEvent(new CustomEvent("plat:changed"));
}

export function adjustPlat(amount: number, basePlat: number): void {
  let override: { value: number; ts: number } | null = null;
  try {
    override = JSON.parse(localStorage.getItem("plat_override") ?? "null");
  } catch {}
  const current = override ? override.value : basePlat;
  setPlatOverride(current + amount);
}
