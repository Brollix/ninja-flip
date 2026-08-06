import { Router } from "express";
import { pool } from "../db.js";
import { requireWfmUser } from "../wfmAuth.js";
import { isPremiumServer } from "../premium.js";

// Reemplaza /ledger/* del plugin de Vite (ledger.db, SQLite, sin scoping) —
// mismas rutas/shape, ahora Postgres + wfm_user_id por fila.
export const ledgerRouter = Router();
ledgerRouter.use(requireWfmUser);

ledgerRouter.get("/all", async (req, res) => {
  const userId = req.wfmUserId!;
  const flipsQ = pool.query(
    "SELECT item, buy, sell, ts FROM user_ledger_flips WHERE wfm_user_id = $1 ORDER BY ts",
    [userId],
  );
  const basisQ = pool.query(
    "SELECT order_id, item, cost, ts FROM user_cost_basis WHERE wfm_user_id = $1",
    [userId],
  );
  // tabla separada a propósito (user_detected_flips) — estos salen del
  // historial de trades de AlecaFrame (report_server.py), no de que
  // confirmes 🛒/💰 en la app. El frontend los une para mostrar un solo
  // Flip History.
  const detectedQ = pool.query(
    "SELECT item, buy, sell, ts, market_now FROM user_detected_flips WHERE wfm_user_id = $1 ORDER BY ts",
    [userId],
  );
  const [flips, basisRows, detected, premium] = await Promise.all([
    flipsQ, basisQ, detectedQ, isPremiumServer(userId),
  ]);
  const basis: Record<string, { cost: number; item: string; ts: number }> = {};
  for (const b of basisRows.rows) {
    basis[b.order_id] = { cost: Number(b.cost), item: b.item, ts: Number(b.ts) };
  }
  // pg devuelve BIGINT (ts) como string, no number — sin esto, new Date(ts)
  // en el frontend lo lee como fecha-string en vez de epoch y tira "Invalid Date"
  const toNum = <T extends { buy: unknown; sell: unknown; ts: unknown; market_now?: unknown }>(row: T) =>
    ({
      ...row, buy: Number(row.buy), sell: Number(row.sell), ts: Number(row.ts),
      ...(row.market_now != null ? { market_now: Number(row.market_now) } : {}),
    });
  res.json({
    flips: flips.rows.map(toNum),
    basis,
    // Detected flips (auto-detectados vía historial de AlecaFrame) son
    // premium — se siguen guardando para todos (report_server.py no sabe de
    // tiers), pero solo se devuelven si el usuario paga. Así, si se suscribe
    // después, ya tiene el historial acumulado esperándolo.
    detectedFlips: premium ? detected.rows.map(toNum) : [],
  });
});

ledgerRouter.post("/flip", async (req, res) => {
  const userId = req.wfmUserId!;
  const { item, buy, sell, ts } = req.body ?? {};
  if (!item || buy == null || sell == null || !ts) {
    res.status(400).json({ error: "bad flip" });
    return;
  }
  await pool.query(
    `INSERT INTO user_ledger_flips (wfm_user_id, item, buy, sell, ts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wfm_user_id, item, ts) DO NOTHING`,
    [userId, item, buy, sell, ts],
  );
  res.json({ ok: true });
});

ledgerRouter.post("/basis", async (req, res) => {
  const userId = req.wfmUserId!;
  const { orderId, cost, item, ts } = req.body ?? {};
  if (!orderId || cost == null) {
    res.status(400).json({ error: "bad basis" });
    return;
  }
  await pool.query(
    `INSERT INTO user_cost_basis (order_id, wfm_user_id, item, cost, ts)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO UPDATE SET
       wfm_user_id = EXCLUDED.wfm_user_id, item = EXCLUDED.item,
       cost = EXCLUDED.cost, ts = EXCLUDED.ts`,
    [orderId, userId, item ?? "", cost, ts ?? Date.now()],
  );
  res.json({ ok: true });
});

ledgerRouter.delete("/basis/:orderId", async (req, res) => {
  const userId = req.wfmUserId!;
  await pool.query(
    "DELETE FROM user_cost_basis WHERE order_id = $1 AND wfm_user_id = $2",
    [req.params.orderId, userId],
  );
  res.json({ ok: true });
});
