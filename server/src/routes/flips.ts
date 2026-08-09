import { Router } from "express";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";

// Datos de mercado: iguales para todos los usuarios, sin auth — los escribe
// el Cloud Run Job flip-scanner (scripts/flips.py). Mismo shape que antes
// devolvía app/public/data/flips.json (FlipsFile: {ts, flips}).
export const flipsRouter = Router();

const MIN_VOL48 = 10;

// market_items lo reescribe el Job flip-scanner cada 15 min (ver
// infra/scheduler.tf) — sin cache, cada cliente con auto-refresh abierto le
// pegaba a Postgres por el mismo resultado idéntico. TTL corto a propósito,
// muy por debajo de esos 15 min, así nadie ve datos más viejos de lo que ya
// eran antes de esto.
const CACHE_TTL_MS = 90_000;
let cache: { ts: number; flips: unknown } | null = null;

flipsRouter.get("/", asyncHandler(async (_req, res) => {
  if (!cache || Date.now() - cache.ts > CACHE_TTL_MS) {
    const { rows } = await pool.query(
      `SELECT slug, name, kind, rank, buy, sell, vol48, score, price_ts,
              parts_total, parts_profit, parts_detail
       FROM market_items
       WHERE sell > buy AND vol48 >= $1
       ORDER BY score DESC`,
      [MIN_VOL48],
    );
    const flips = rows.map((r) => ({
      name: r.name,
      slug: r.slug,
      kind: r.kind,
      rank: r.rank || undefined,
      buy: Number(r.buy),
      sell: Number(r.sell),
      spread: Number(r.sell) - Number(r.buy),
      margin: ((Number(r.sell) - Number(r.buy)) / Number(r.sell)) * 100,
      vol48: r.vol48,
      score: Number(r.score),
      parts_total: r.parts_total != null ? Number(r.parts_total) : undefined,
      parts_profit: r.parts_profit != null ? Number(r.parts_profit) : undefined,
      parts_detail: r.parts_detail ?? undefined,
    }));
    cache = { ts: Date.now(), flips };
  }
  res.json({ ts: cache.ts / 1000, flips: cache.flips });
}));
