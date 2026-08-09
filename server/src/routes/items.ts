import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";

// Catálogo completo de warframe.market (id -> [slug, nombre]) — antes
// app/public/data/items.json, generado a mano junto al report. No es
// user-specific ni cambia seguido: se cachea en memoria mientras el
// container de Cloud Run esté vivo.
export const itemsRouter = Router();

let cache: Record<string, [string, string]> | null = null;
let cacheAt = 0;
const TTL_MS = 24 * 3600 * 1000;

itemsRouter.get("/", asyncHandler(async (_req, res) => {
  if (!cache || Date.now() - cacheAt > TTL_MS) {
    const r = await fetch("https://api.warframe.market/v2/items");
    if (!r.ok) {
      res.status(502).json({ error: `warframe.market items ${r.status}` });
      return;
    }
    const body = (await r.json()) as { data: { id: string; slug: string; i18n: { en: { name: string } } }[] };
    cache = Object.fromEntries(body.data.map((it) => [it.id, [it.slug, it.i18n.en.name] as [string, string]]));
    cacheAt = Date.now();
  }
  res.json(cache);
}));
