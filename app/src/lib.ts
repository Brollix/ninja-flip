import type { Bucket, Flip, FlipsFile, Relic, RelicRaw, Report } from "./types";

export const fmtP = (n: number): string =>
  n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);

export const pct = (x: number): string =>
  (x * 100).toFixed(x >= 0.1 ? 0 : 1) + "%";

export const slugOf = (name: string): string =>
  name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const marketUrl = (nameOrSlug: string, isSlug = false): string =>
  `https://warframe.market/items/${isSlug ? nameOrSlug : slugOf(nameOrSlug)}`;

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

export async function loadData(): Promise<{
  report: Report;
  flips: Flip[];
  flipsTs: number | null;
}> {
  const [repRes, flipRes] = await Promise.all([
    fetch("data/report.json"),
    fetch("data/flips.json"),
  ]);
  if (!repRes.ok) throw new Error("Couldn't load data/report.json — run: python scripts/relic_analysis.py");
  const report = (await repRes.json()) as Report;
  let flips: Flip[] = [];
  let flipsTs: number | null = null;
  if (flipRes.ok) {
    const f = (await flipRes.json()) as FlipsFile | Flip[];
    flips = Array.isArray(f) ? f : f.flips;
    flipsTs = Array.isArray(f) ? null : f.ts;
  }
  return { report, flips, flipsTs };
}

/** Mi slug de warframe.market (para excluir mis propias órdenes del libro). */
export function mySlug(): string | null {
  try {
    const u = JSON.parse(localStorage.getItem("wfm_user_info") ?? "null") as { slug?: string } | null;
    if (u?.slug) return u.slug.toLowerCase();
  } catch { /* sin sesión */ }
  return localStorage.getItem("wfm_user")?.toLowerCase() ?? null;
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** Órdenes en vivo vía el proxy /wfm del dev server (la API no manda CORS). */
export async function fetchLiveOrders(slug: string): Promise<{ buy: number; sell: number } | null> {
  const res = await wfmFetch(`/wfm/v2/orders/item/${slug}/top`);
  if (!res.ok) return null;
  const d = (await res.json()).data as {
    buy?: { platinum: number; perTrade?: number; user?: { status?: string; slug?: string } }[];
    sell?: { platinum: number; perTrade?: number; user?: { status?: string; slug?: string } }[];
  };
  const unit = (o: { platinum: number; perTrade?: number }) =>
    o.platinum / Math.max(o.perTrade ?? 1, 1);
  // solo gente EN EL JUEGO: son los únicos con los que podés tradear ya
  const me = mySlug();
  const usable = (o: { user?: { status?: string; slug?: string } }) =>
    o.user?.status === "ingame" && (me === null || o.user?.slug?.toLowerCase() !== me);
  const buys = (d.buy ?? []).filter(usable).map(unit);
  const sells = (d.sell ?? []).filter(usable).map(unit);
  if (!buys.length || !sells.length) return null;
  return { buy: Math.max(...buys), sell: Math.min(...sells) };
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
