import type { Bucket, Flip, FlipsFile, Relic, RelicRaw, Report } from "./types";
import { getJwt } from "./wfm";

export const fmtP = (n: number): string =>
  n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);

export const pct = (x: number): string =>
  (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";

export const slugOf = (name: string): string =>
  name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const marketUrl = (nameOrSlug: string, isSlug = false): string =>
  `https://warframe.market/items/${isSlug ? nameOrSlug : slugOf(nameOrSlug)}`;

/** Un flip/compra de varios items en un solo trade viene como "X Prime Blueprint,
 *  X Prime Systems, X Prime Chassis, ..." — si todas las partes comparten el mismo
 *  nombre base "{X} Prime" (todas las partes de un mismo warframe/arma), se muestra
 *  como "X Prime Set" en vez de listar cada componente. */
export function prettyItemName(item: string): string {
  const parts = item.split(", ");
  if (parts.length < 2) return item;
  const wordLists = parts.map(p => p.split(" "));
  const minLen = Math.min(...wordLists.map(w => w.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const word = wordLists[0][i];
    if (wordLists.every(w => w[i] === word)) common.push(word);
    else break;
  }
  if (common.length >= 2 && common[common.length - 1] === "Prime") {
    return `${common.join(" ")} Set`;
  }
  return item;
}

const n95 = (p: number): number => Math.ceil(Math.log(0.05) / Math.log(1 - p));

/** Consolida refinamientos duplicados y calcula buckets + cacería. */
export function prepareRelics(raw: RelicRaw[]): Relic[] {
  const merged = new Map<string, Relic>();
  for (const r of raw) {
    let m = merged.get(r.relic);
    if (!m) {
      m = { ...r, count: 0, refinedCount: 0, radiantCount: 0, gain: 0, bucket: "junk", hunt: null };
      merged.set(r.relic, m);
    }
    m.count += r.count;
    if (r.refinement !== "Intact") m.refinedCount += r.count;
    if (r.refinement === "Radiant") m.radiantCount += r.count;
  }

  const relics = [...merged.values()];
  for (const r of relics) {
    r.gain = r.ev_radiant - r.ev_intact;
    if (r.relic_price >= 10 && r.relic_price > r.ev_radiant) r.bucket = "sell";
    else if (r.gain >= 2.5 && r.jackpot_price >= 25) r.bucket = "radiant";
    else if (r.ev_intact >= 4) r.bucket = "intact";
    else r.bucket = "junk";

    const jp = r.drops.find(d => d.item === r.jackpot);
    if (jp && r.jackpot_price > 0 && jp.chance_intact > 0 && jp.chance_intact < 100) {
      const pInt = jp.chance_intact / 100;
      const pRad = jp.chance_radiant / 100;
      const pRadshare = 1 - (1 - pRad) ** 4; // 4 tiradas por apertura
      const n = r.count;
      const n95Radshare = n95(pRadshare);
      r.hunt = {
        pInt,
        pRadshare,
        hitInt: 1 - (1 - pInt) ** n,
        hitRadshare: 1 - (1 - pRadshare) ** n,
        scoreInt: r.jackpot_price * (1 - (1 - pInt) ** n),
        scoreRad: r.jackpot_price * (1 - (1 - pRadshare) ** n),
        n95Radshare,
        missing: Math.max(0, n95Radshare - n),
      };
    }
  }
  return relics;
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  radiant: "Radiant",
  intact: "Intact",
  sell: "Sell whole",
  junk: "Ducats",
};

/** "not_signed_in": todavía no hay JWT de warframe.market (no hay identidad,
 *  no se puede pedir /api/report). "no_aleca_token": identidad OK pero el
 *  usuario nunca pegó su token de AlecaFrame — App.tsx muestra el input
 *  para cargarlo. Cualquier otro string: mensaje de error tal cual. */
export type ReportError = "not_signed_in" | "no_aleca_token" | string;

export async function loadData(opts: { refresh?: boolean } = {}): Promise<{
  report: Report | null;
  reportError: ReportError | null;
  flips: Flip[];
  flipsTs: number | null;
}> {
  // /api/flips (mercado, público) y /api/report (por usuario, puede tardar)
  // no dependen entre sí — pedirlos en paralelo en vez de uno tras otro deja
  // que Flips esté listo para pintar sin esperar a que Report termine.
  const jwt = getJwt();
  const flipPromise = fetch("/api/flips", { cache: "no-store" }).catch(() => null);
  // el reporte se cachea 15 min server-side (report_server.py) para no
  // pegarle a AlecaFrame en cada visita — refresh=1 lo saltea, para cuando
  // acabás de cerrar un trade y no querés esperar
  const repPromise = jwt
    ? fetch(`/api/report${opts.refresh ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${jwt}` },
        cache: "no-store",
      })
    : null;

  const flipRes = await flipPromise;
  let flips: Flip[] = [];
  let flipsTs: number | null = null;
  if (flipRes?.ok) {
    const f = (await flipRes.json()) as FlipsFile;
    flips = f.flips;
    flipsTs = f.ts;
  }

  if (!jwt || !repPromise) {
    return { report: null, reportError: "not_signed_in", flips, flipsTs };
  }
  const repRes = await repPromise;
  if (!repRes.ok) {
    const body = await repRes.json().catch(() => ({}) as { error?: string });
    const reportError = body.error === "no_aleca_token" ? "no_aleca_token" : `${body.error ?? repRes.status}`;
    return { report: null, reportError, flips, flipsTs };
  }
  const report = (await repRes.json()) as Report;
  return { report, reportError: null, flips, flipsTs };
}

/** Mi slug de warframe.market (para excluir mis propias órdenes del libro). */
export function mySlug(): string | null {
  try {
    const u = JSON.parse(localStorage.getItem("wfm_user_info") ?? "null") as { slug?: string } | null;
    if (u?.slug) return u.slug.toLowerCase();
  } catch { /* sin sesión */ }
  return localStorage.getItem("wfm_user")?.toLowerCase() ?? null;
}

/** Tu plat actual: la corrección manual (que adjustPlat mantiene al día con
 *  cada 🛒 bought / 💰 sold) si existe, si no el último snapshot de
 *  AlecaFrame nada más como arranque. Única fuente de verdad — la usan tanto
 *  el header (PlatBadge) como el capital por default del Suggester. */
export function currentPlat(lastSnapshotPlat: number): number {
  try {
    const override = JSON.parse(localStorage.getItem("plat_override") ?? "null") as
      { value: number; ts: number } | null;
    if (override) return override.value;
  } catch { /* noop */ }
  return lastSnapshotPlat;
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

type RawOrder = {
  type?: "buy" | "sell"; platinum: number; perTrade?: number; rank?: number;
  user?: { status?: string; slug?: string };
};

/** Órdenes en vivo vía el proxy /wfm del dev server (la API no manda CORS).
 *
 * Con rango > 0 (arcanos/primed maxeados) hay que pedir el libro COMPLETO:
 * /top solo devuelve las 5 puntas globales, que en esos items son siempre
 * de rango 0 — filtrar por rango > 0 ahí adentro nunca encuentra nada y la
 * fila queda pegada en un valor viejo para siempre (el bug que reportaste
 * con Arcane Reaper: nunca veía al vendedor de 384p). */
export async function fetchLiveOrders(slug: string, rank = 0): Promise<{ buy: number; sell: number } | null> {
  const me = mySlug();
  const usable = (o: RawOrder) =>
    o.user?.status === "ingame" && (o.rank ?? 0) === rank &&
    (me === null || o.user?.slug?.toLowerCase() !== me);
  const unit = (o: RawOrder) => o.platinum / Math.max(o.perTrade ?? 1, 1);

  let buys: number[], sells: number[];
  if (rank > 0) {
    const res = await wfmFetch(`/wfm/v2/orders/item/${slug}`);
    if (!res.ok) return null;
    const all = (await res.json()).data as RawOrder[];
    buys = all.filter(o => o.type === "buy" && usable(o)).map(unit);
    sells = all.filter(o => o.type === "sell" && usable(o)).map(unit);
  } else {
    const res = await wfmFetch(`/wfm/v2/orders/item/${slug}/top`);
    if (!res.ok) return null;
    const d = (await res.json()).data as { buy?: RawOrder[]; sell?: RawOrder[] };
    buys = (d.buy ?? []).filter(usable).map(unit);
    sells = (d.sell ?? []).filter(usable).map(unit);
  }
  if (!buys.length && !sells.length) return null;
  return {
    buy: buys.length ? Math.max(...buys) : 0,
    sell: sells.length ? Math.min(...sells) : 0,
  };
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rate limiter GLOBAL para warframe.market: el limite documentado es 3 req/s
// por IP (lo aplica Cloudflare con 429 y bloqueos temporales a reincidentes).
// Todas las llamadas de la app pasan por aca: los inicios se espacian 350 ms
// (~2.8 req/s) aunque se solapen flujos (flips + orders + composer).
// ---------------------------------------------------------------------------
const WFM_MIN_INTERVAL = 350;
let wfmQueue: Promise<void> = Promise.resolve();
let wfmLast = 0;

export function wfmFetch(input: string, init?: RequestInit): Promise<Response> {
  const slot = wfmQueue.then(async () => {
    const wait = wfmLast + WFM_MIN_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    wfmLast = Date.now();
  });
  wfmQueue = slot.catch(() => {});
  return slot.then(async () => {
    let res = await fetch(input, init);
    if (res.status === 429) {
      // Cloudflare nos freno: esperar lo que pida (o 2 s) y reintentar una vez
      const retry = Number(res.headers.get("retry-after")) || 2;
      await sleep(retry * 1000);
      wfmLast = Date.now();
      res = await fetch(input, init);
    }
    return res;
  });
}

// ---------------------------------------------------------------------------
// Info de trading de un item: rango en el que se flipea + si acepta "perTrade"
// (bulkTradable). Los arcanos son bulkTradable=true y la API EXIGE perTrade
// en la orden; sets y primed mods son bulkTradable=false/ausente y la API
// lo RECHAZA si lo mandás — probamos ambos casos y confirmamos contra la API
// real, no es un supuesto. Rango: arcanos y primed mods "grandes" se flipean
// SIEMPRE maxeados (mismo criterio que scripts/flips.py → flip_rank),
// calculado acá para que el composer acierte sin importar cómo se abrió
// (búsqueda manual incluida, no solo desde una fila de Flips/Sniper).
// ---------------------------------------------------------------------------
export interface TradeInfo { rank: number; bulkTradable: boolean; subtype?: string }
const tradeInfoCache = new Map<string, TradeInfo>();

export async function resolveTradeInfo(slug: string, name: string): Promise<TradeInfo> {
  if (tradeInfoCache.has(slug)) return tradeInfoCache.get(slug)!;
  let info: TradeInfo = { rank: 0, bulkTradable: false };
  try {
    const res = await wfmFetch(`/wfm/v2/item/${slug}`);
    if (res.ok) {
      const d = (await res.json()).data as
        { tags?: string[]; maxRank?: number; bulkTradable?: boolean; subtypes?: string[] };
      const tags = d.tags ?? [];
      const maxRank = d.maxRank ?? 0;
      let rank = 0;
      if (tags.includes("arcane_enhancement")) {
        rank = maxRank;                                   // arcanos: siempre maxeados
      } else if (tags.includes("mod") && name.startsWith("Primed ") && maxRank >= 6) {
        rank = maxRank;                                   // primed "grandes": maxeados
      }
      // Algunos mods/items exigen "subtype" en la orden (ej. Primed Target
      // Cracker: subtypes ["regular","atragraph"]) — sin esto la API
      // rechaza el POST con "subtype: app.field.required". Default a
      // "regular" (la variante normal) cuando el item lo pide.
      const subtypes = d.subtypes ?? [];
      const subtype = subtypes.length
        ? (subtypes.includes("regular") ? "regular" : subtypes[0])
        : undefined;
      info = { rank, bulkTradable: d.bulkTradable === true, subtype };
    }
  } catch { /* si falla, asumimos rango 0 / sin bulk (sets y el resto) */ }
  tradeInfoCache.set(slug, info);
  return info;
}
