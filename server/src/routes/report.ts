import { Router } from "express";
import { pool } from "../db.js";
import { requireWfmUser } from "../wfmAuth.js";
import { fetchIdToken } from "../gcpAuth.js";
import { isPremiumServer } from "../premium.js";

// El análisis de reliquias (parseo binario, cruce con drop tables, EV) sigue
// en Python (scripts/report_server.py) — es tan intrincado como flips.py y
// reescribirlo en TS ahora era puro riesgo. Este endpoint solo: resuelve el
// wfm_user_id (vía requireWfmUser), busca el token de AlecaFrame del usuario,
// y reenvía al servicio de Cloud Run interno que hace el trabajo real.
export const reportRouter = Router();
reportRouter.use(requireWfmUser);

const REPORT_SERVICE_URL = process.env.REPORT_SERVICE_URL;

reportRouter.get("/", async (req, res) => {
  const userId = req.wfmUserId!;
  const { rows } = await pool.query(
    "SELECT aleca_public_token FROM user_aleca_tokens WHERE wfm_user_id = $1",
    [userId],
  );
  const token = rows[0]?.aleca_public_token;
  if (!token) {
    res.status(404).json({ error: "no_aleca_token" });
    return;
  }
  if (!REPORT_SERVICE_URL) {
    res.status(500).json({ error: "REPORT_SERVICE_URL not configured" });
    return;
  }
  try {
    // Saltar el cache de 15min (TTL en report_server.py) pega directo a
    // AlecaFrame + recomputa relic_analysis.py — sin este chequeo cualquier
    // usuario, gratis o no, podía spammear refresh=1 sin límite. Premium
    // gana refresh on-demand; el resto siempre sirve del cache.
    const refresh = req.query.refresh === "1" && await isPremiumServer(userId);
    // "report" es privado (solo invocable por la cuenta de servicio de
    // "web", ver infra/) — necesita un ID token de Google como Bearer, la
    // membresía IAM sola no autentica nada por sí misma.
    const idToken = await fetchIdToken(REPORT_SERVICE_URL);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    const upstream = await fetch(`${REPORT_SERVICE_URL}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({ wfm_user_id: userId, aleca_token: token, refresh }),
      // El fetch nativo de Node corta la conexión a los ~300s por default
      // (undici) — bien por debajo de los 540s que "report" tiene permitido
      // en su propio timeout de Cloud Run (ver cloud_run_report.tf). Sin
      // esto, un usuario con cache frío (~6min bajando ~449 items de wfm)
      // siempre terminaba en 502 aunque "report" hubiera terminado bien.
      signal: AbortSignal.timeout(550_000),
    });
    const body = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(body);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
