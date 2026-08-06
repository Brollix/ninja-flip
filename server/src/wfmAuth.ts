import type { NextFunction, Request, Response } from "express";

/** No hay signup propio: la identidad ES la cuenta de warframe.market.
 *  El browser ya tiene el JWT (localStorage, wfm.ts signIn()) para postear
 *  órdenes — se lo mandamos también acá como Bearer y lo verificamos contra
 *  la propia API de warframe.market (GET /v2/me). Ningún id que mande el
 *  cliente se confía directo: si el JWT no valida ahí, no hay wfmUserId. */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      wfmUserId?: string;
    }
  }
}

interface WfmMeResponse {
  data?: { id?: string; slug?: string } | null;
  error?: unknown;
}

// Una sola carga de página dispara 2-3 requests autenticados en paralelo
// (/api/report, /ledger/all, ...) — cada uno verificaba el MISMO jwt contra
// warframe.market por separado. Cache en memoria de "este jwt ya validó,
// es este wfm_user_id" por unos minutos: evita pegarle 2-3 veces seguidas
// a una API externa por algo que no cambia en ese lapso. TTL corto a
// propósito — si el usuario se desloguea de verdad en warframe.market, como
// mucho tarda ese margen en dejar de servir.
const ME_CACHE_TTL_MS = 4 * 60 * 1000;
const meCache = new Map<string, { userId: string; expiresAt: number }>();

export async function requireWfmUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    res.status(401).json({ error: "missing Authorization: Bearer <wfm jwt>" });
    return;
  }
  const cached = meCache.get(jwt);
  if (cached && cached.expiresAt > Date.now()) {
    req.wfmUserId = cached.userId;
    next();
    return;
  }
  try {
    const r = await fetch("https://api.warframe.market/v2/me", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = (await r.json().catch(() => ({}))) as WfmMeResponse;
    const wfmUserId = body.data?.id ?? body.data?.slug;
    if (!r.ok || !wfmUserId) {
      res.status(401).json({ error: "invalid warframe.market session — sign in again" });
      return;
    }
    if (meCache.size > 500) { // limpieza perezosa, evita crecer sin límite
      const now = Date.now();
      for (const [k, v] of meCache) if (v.expiresAt <= now) meCache.delete(k);
    }
    meCache.set(jwt, { userId: wfmUserId, expiresAt: Date.now() + ME_CACHE_TTL_MS });
    req.wfmUserId = wfmUserId;
    next();
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
