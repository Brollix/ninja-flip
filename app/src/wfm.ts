import { wfmFetch } from "./lib";

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

export const getJwt = (): string | null => localStorage.getItem(JWT_KEY);
export const getUser = (): WfmUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as WfmUser) : null;
};
export const isConnected = (): boolean => !!getJwt();

export function signOut(): void {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
  notify();
}

// pub/sub mínimo para que la UI reaccione a conectar/desconectar
const listeners = new Set<() => void>();
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach(fn => fn());

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
    throw new Error(`Market error: ${errStr || res.status}`);
  }
  return body;
}

interface OrderPayload { data?: WfmOrder }

export async function createOrder(params: {
  itemId: string; type: "buy" | "sell"; platinum: number; quantity: number;
}): Promise<WfmOrder | undefined> {
  const body = (await authed("/v2/order", {
    method: "POST",
    body: JSON.stringify({
      itemId: params.itemId,
      type: params.type,
      platinum: Math.round(params.platinum),
      quantity: Math.max(1, Math.round(params.quantity)),
      visible: true,
    }),
  })) as OrderPayload;
  return body.data;
}

export async function updateOrder(orderId: string, params: {
  platinum: number; quantity?: number;
}): Promise<WfmOrder | undefined> {
  const body = (await authed(`/v2/order/${orderId}`, {
    method: "PATCH",
    body: JSON.stringify({
      platinum: Math.round(params.platinum),
      ...(params.quantity ? { quantity: Math.round(params.quantity) } : {}),
      visible: true,
    }),
  })) as OrderPayload;
  return body.data;
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

const BASIS_KEY = "cost_basis_v1";
const FLIPS_KEY = "flips_log_v1";

interface BasisEntry { cost: number; item: string; ts: number }
export interface FlipRecord { item: string; buy: number; sell: number; ts: number }

function basisMap(): Record<string, BasisEntry> {
  try { return JSON.parse(localStorage.getItem(BASIS_KEY) ?? "{}"); }
  catch { return {}; }
}

export function setCostBasis(orderId: string, cost: number, item: string): void {
  const m = basisMap();
  const entry = { cost, item, ts: Date.now() };
  m[orderId] = entry;
  localStorage.setItem(BASIS_KEY, JSON.stringify(m));
  // espejo al ledger en disco (fire-and-forget)
  fetch("/ledger/basis", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, ...entry }),
  }).catch(() => {});
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
  fetch(`/ledger/basis/${encodeURIComponent(orderId)}`, { method: "DELETE" }).catch(() => {});
}

export function logFlip(f: FlipRecord): void {
  try {
    const list = JSON.parse(localStorage.getItem(FLIPS_KEY) ?? "[]") as FlipRecord[];
    list.push(f);
    localStorage.setItem(FLIPS_KEY, JSON.stringify(list));
  } catch { /* localStorage lleno o corrupto: el flip igual se cerró */ }
  fetch("/ledger/flip", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(f),
  }).catch(() => {});
}

/** Sincroniza el ledger en disco con localStorage (dos vías) al arrancar:
 *  restaura lo que falte localmente y sube lo que falte en la base. */
export async function syncLedger(): Promise<void> {
  try {
    const res = await fetch("/ledger/all");
    if (!res.ok) return;
    const server = (await res.json()) as {
      flips: FlipRecord[];
      basis: Record<string, BasisEntry>;
    };
    // flips: unión por (item, ts)
    const local = getFlips();
    const key = (f: FlipRecord) => `${f.item}|${f.ts}`;
    const localKeys = new Set(local.map(key));
    const serverKeys = new Set(server.flips.map(key));
    const merged = [...local, ...server.flips.filter(f => !localKeys.has(key(f)))]
      .sort((a, b) => a.ts - b.ts);
    localStorage.setItem(FLIPS_KEY, JSON.stringify(merged));
    for (const f of local.filter(f => !serverKeys.has(key(f)))) {
      await fetch("/ledger/flip", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      }).catch(() => {});
    }
    // basis: unión por orderId
    const localBasis = basisMap();
    const mergedBasis = { ...server.basis, ...localBasis };
    localStorage.setItem(BASIS_KEY, JSON.stringify(mergedBasis));
    for (const [id, b] of Object.entries(localBasis)) {
      if (!(id in server.basis)) {
        await fetch("/ledger/basis", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: id, ...b }),
        }).catch(() => {});
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
    itemsCache = await (await fetch("data/items.json")).json();
  }
  return itemsCache!;
}

export function adjustPlat(amount: number, basePlat: number): void {
  let override: { value: number; ts: number } | null = null;
  try {
    override = JSON.parse(localStorage.getItem("plat_override") ?? "null");
  } catch {}
  const current = override ? override.value : basePlat;
  localStorage.setItem("plat_override", JSON.stringify({
    value: current + amount,
    ts: Date.now()
  }));
  window.dispatchEvent(new CustomEvent("plat:changed"));
}
