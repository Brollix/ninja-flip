import { Router } from "express";
import { pool } from "../db.js";
import { asyncHandler } from "../asyncHandler.js";

// "Mejor momento para tradear": iguales para todos los usuarios, sin auth —
// mismo patrón que flipsRouter. Lo escribe flips.py (hourly_activity),
// reusando el volumen por hora que /v1/items/.../statistics ya devuelve.
// bucket_ts es cronológico real (no plegado por hora del día) — cubre la
// ventana de 48h que da la API, techo real de esa granularidad.
export const peakTimeRouter = Router();

peakTimeRouter.get("/", asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT bucket_ts, volume FROM hourly_activity ORDER BY bucket_ts",
  );
  const buckets = rows.map((r) => ({ ts: r.bucket_ts, volume: Number(r.volume) }));
  res.json({ buckets });
}));
