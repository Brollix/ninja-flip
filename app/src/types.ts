export interface Drop {
  item: string;
  rarity: "Common" | "Uncommon" | "Rare" | string;
  chance_intact: number;
  chance_radiant: number;
  price: number;
  med48: number;
  vol48: number;
  ducats: number;
}

export interface RelicRaw {
  relic: string;
  tier: string;
  count: number;
  refinement: string;
  ev_intact: number;
  ev_radiant: number;
  ev_ducats: number;
  jackpot: string;
  jackpot_price: number;
  jackpot_med48: number;
  jackpot_vol48: number;
  relic_price: number;
  vaulted: boolean;
  farm: string | null;
  farm_chance: number | null;
  drops: Drop[];
}

export type Bucket = "radiant" | "intact" | "sell" | "junk";

export interface Hunt {
  pInt: number;
  pRadshare: number;
  hitInt: number;
  hitRadshare: number;
  scoreInt: number;
  scoreRad: number;
  n95Radshare: number;
  missing: number;
}

export interface Relic extends RelicRaw {
  refinedCount: number;
  radiantCount: number;
  gain: number;
  bucket: Bucket;
  hunt: Hunt | null;
}

export interface Sale {
  ts: string;
  user: string;
  items: string;
  plat: number;
  market_now: number;
  partial: boolean;
}

export interface HistoryPoint {
  ts: string;
  plat: number;
  credits: number;
  endo: number;
  ducats: number;
  aya: number;
  relicOpened: number;
  trades: number;
  mr: number;
  percentageCompletion: number;
}

export interface Report {
  generated_ts: number;
  username: string | null;
  relics: RelicRaw[];
  sales: Sale[];
  history: HistoryPoint[];
}

export interface Flip {
  name: string;
  slug: string;
  buy: number;
  sell: number;
  spread: number;
  margin: number;
  vol48: number;
  med48: number;
  parts_total?: number;
  parts_profit?: number;
  parts_detail?: string;
  /** true cuando la fila tiene precios en vivo (no del escaneo) */
  fresh?: boolean;
}

export interface FlipsFile {
  ts: number;
  flips: Flip[];
}
