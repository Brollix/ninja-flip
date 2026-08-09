import type { NextFunction, Request, Response } from "express";

/** Limitador en memoria, por IP — sin Redis ni dependencias nuevas. "web"
 *  corre con min_instance_count=1 la mayoría del tiempo (infra/cloud_run_web.tf)
 *  y hasta max_instance_count=20 en picos; con más de una instancia esto
 *  limita por instancia, no es un tope global exacto — pero alcanza para que
 *  /wfm (proxy abierto, sin auth, ver wfmProxy.ts) no sea un relay anónimo
 *  ilimitado hacia warframe.market. Ventana fija simple, no sliding window:
 *  de sobra para este caso. */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.status(429).json({ error: "too many requests, slow down" });
      return;
    }
    if (hits.size > 5000) { // limpieza perezosa, evita crecer sin límite
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    next();
  };
}
