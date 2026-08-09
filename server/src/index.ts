import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import "dotenv/config";

import { ledgerRouter } from "./routes/ledger.js";
import { alecaTokenRouter } from "./routes/alecaToken.js";
import { flipsRouter } from "./routes/flips.js";
import { reportRouter } from "./routes/report.js";
import { wfmProxyRouter } from "./routes/wfmProxy.js";
import { itemsRouter } from "./routes/items.js";
import { patreonCallbackRouter, premiumRouter } from "./routes/premium.js";
import { peakTimeRouter } from "./routes/peakTime.js";
import { rateLimit } from "./rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "public"); // build del frontend, ver Dockerfile

// Hash del index.html servido por ESTE container — cambia en cada build real
// (los nombres de archivo de los assets van adentro, hasheados por Vite) sin
// tener que llevar un número de versión a mano. El frontend lo compara
// contra el que tenía al cargar para avisar "hay una versión nueva, recargá".
const BUILD_VERSION = crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(STATIC_DIR, "index.html")))
  .digest("hex")
  .slice(0, 12);

const app = express();
// Cloud Run está detrás del load balancer de Google — sin esto, req.ip
// siempre da la IP del balanceador (misma para TODOS los usuarios), lo que
// haría que el rate limiter de abajo trate a todo el tráfico como un solo
// cliente en vez de por IP real (X-Forwarded-For).
app.set("trust proxy", true);
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/version", (_req, res) => res.json({ version: BUILD_VERSION }));

// /ledger y /wfm quedan en la misma ruta que usaba el plugin de Vite en dev
// (ledgerPlugin, proxy /wfm) — así el frontend no necesita tocar un montón
// de call sites, solo sumar el header Authorization donde hace falta.
// /wfm en particular no tiene auth (ver wfmProxyRouter) — es un relay directo
// a warframe.market, así que le sumamos un límite más estricto que al resto.
app.use("/ledger", ledgerRouter);
app.use("/wfm", rateLimit({ windowMs: 60_000, max: 180 }), wfmProxyRouter);
// Resto de /api — nada acá pega tan seguido a warframe.market como el proxy
// de arriba, pero igual sin límite alguno un cliente podía martillar /api/report
// o /api/items en loop; generoso a propósito para no chocar con auto-refresh
// legítimo (My Orders default: cada 3 min, varios endpoints en paralelo).
app.use("/api", rateLimit({ windowMs: 60_000, max: 300 }));
app.use("/api/aleca-token", alecaTokenRouter);
app.use("/api/flips", flipsRouter);
app.use("/api/peak-time", peakTimeRouter);
app.use("/api/report", reportRouter);
app.use("/api/items", itemsRouter);
app.use("/api/premium", premiumRouter);
app.use("/api/patreon", patreonCallbackRouter);

app.use(express.static(STATIC_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));

// Error handler global: cualquier error que llegue vía next(err) (todas las
// rutas async están envueltas en asyncHandler.ts) cae acá en vez de tirar un
// unhandledRejection que mataría el proceso. El detalle real se loguea del
// lado del server — nunca se lo devolvemos al cliente tal cual (podía filtrar
// hostnames internos, stack traces, etc.).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("unhandled route error:", err);
  if (res.headersSent) return;
  res.status(502).json({ error: "internal error" });
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

const port = Number(process.env.PORT) || 8080; // Cloud Run inyecta PORT
app.listen(port, () => console.log(`web listening on :${port}`));
