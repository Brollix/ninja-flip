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
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/api/version", (_req, res) => res.json({ version: BUILD_VERSION }));

// /ledger y /wfm quedan en la misma ruta que usaba el plugin de Vite en dev
// (ledgerPlugin, proxy /wfm) — así el frontend no necesita tocar un montón
// de call sites, solo sumar el header Authorization donde hace falta.
app.use("/ledger", ledgerRouter);
app.use("/wfm", wfmProxyRouter);
app.use("/api/aleca-token", alecaTokenRouter);
app.use("/api/flips", flipsRouter);
app.use("/api/peak-time", peakTimeRouter);
app.use("/api/report", reportRouter);
app.use("/api/items", itemsRouter);
app.use("/api/premium", premiumRouter);
app.use("/api/patreon", patreonCallbackRouter);

app.use(express.static(STATIC_DIR));
app.get("*", (_req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));

const port = Number(process.env.PORT) || 8080; // Cloud Run inyecta PORT
app.listen(port, () => console.log(`web listening on :${port}`));
