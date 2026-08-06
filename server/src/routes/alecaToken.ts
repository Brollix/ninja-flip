import { Router } from "express";
import { pool } from "../db.js";
import { requireWfmUser } from "../wfmAuth.js";

// Cada usuario pega su propio token público de AlecaFrame ("Create Public
// Link" en su tab de Stats) una sola vez — reemplaza el ALECA_PUBLIC_TOKEN
// único y global que vivía en .env.
export const alecaTokenRouter = Router();
alecaTokenRouter.use(requireWfmUser);

alecaTokenRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT aleca_public_token FROM user_aleca_tokens WHERE wfm_user_id = $1",
    [req.wfmUserId],
  );
  res.json({ token: rows[0]?.aleca_public_token ?? null });
});

alecaTokenRouter.post("/", async (req, res) => {
  const token = (req.body?.token ?? "").trim();
  if (!token) {
    res.status(400).json({ error: "missing token" });
    return;
  }
  await pool.query(
    `INSERT INTO user_aleca_tokens (wfm_user_id, aleca_public_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (wfm_user_id) DO UPDATE SET
       aleca_public_token = EXCLUDED.aleca_public_token, updated_at = now()`,
    [req.wfmUserId, token],
  );
  res.json({ ok: true });
});
