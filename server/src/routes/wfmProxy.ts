import { Router } from "express";

// Reemplaza el proxy /wfm del dev server de Vite: api.warframe.market no
// manda CORS, así que el browser no puede pegarle directo ni en local ni
// deployado — todo pasa por acá, mismo origen que el resto de la app.
// Reenvía tal cual (método, headers relevantes, body) — el JWT del usuario
// para llamadas autenticadas (postear/cerrar órdenes) ya viaja en el
// Authorization que manda el cliente, este proxy no lo toca ni lo valida.
export const wfmProxyRouter = Router();

const FORWARD_REQUEST_HEADERS = ["authorization", "content-type"];

wfmProxyRouter.all("*", async (req, res) => {
  const target = `https://api.warframe.market${req.path}`;
  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.header(h);
    if (v) headers[h] = v;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method) && req.body && Object.keys(req.body).length > 0;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
    const text = await upstream.text();
    const authHeader = upstream.headers.get("authorization");
    if (authHeader) res.setHeader("authorization", authHeader); // signIn devuelve el JWT en el header
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
