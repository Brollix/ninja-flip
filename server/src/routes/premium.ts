import crypto from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { requireWfmUser } from "../wfmAuth.js";
import { asyncHandler } from "../asyncHandler.js";

// Premium por Patreon — "Connect with Patreon" real (OAuth por usuario), como
// recomienda Patreon incluso para herramientas de un solo creador: el usuario
// se loguea con SU cuenta, nosotros chequeamos SU membership contra la
// campaña. Evita el problema de la versión anterior (cruzar un email tipeado
// a mano contra la lista de patrons del creador): acá no hay forma de mentir
// el email de otro, y Patreon nos dice si ese email está verificado.
export const premiumRouter = Router();

// Router separado (sin requireWfmUser): Patreon redirige el BROWSER acá
// después del login, una navegación normal de página — no lleva el header
// Authorization que manda fetch(), así que esta ruta no puede depender de
// wfmAuth. La identidad viaja en el parámetro "state" (ver authorize abajo).
export const patreonCallbackRouter = Router();

const CAMPAIGN_ID = "16491957";

const clientId = process.env.PATREON_CLIENT_ID ?? "";
const clientSecret = process.env.PATREON_CLIENT_SECRET ?? "";
const redirectUri = process.env.PATREON_REDIRECT_URI ?? "";

const OAUTH_SCOPE = "identity identity.memberships";

async function cleanupOldStates(): Promise<void> {
  await pool.query("DELETE FROM patreon_oauth_state WHERE created_at < now() - interval '10 minutes'");
}

premiumRouter.use(requireWfmUser);

premiumRouter.get("/", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT active FROM user_premium WHERE wfm_user_id = $1",
    [req.wfmUserId],
  );
  res.json({ premium: rows[0]?.active === true });
}));

/** Arranca el login: genera un "state" de un solo uso atado a este
 *  wfm_user_id y devuelve la URL de Patreon a la que el FRONTEND tiene que
 *  navegar (window.location.href = url, no fetch — tiene que ser una
 *  navegación real de browser para que Patreon pueda mostrar su propia
 *  pantalla de login/consentimiento). */
premiumRouter.get("/authorize", asyncHandler(async (req, res) => {
  if (!clientId || !redirectUri) {
    res.status(500).json({ error: "Patreon OAuth no configurado (falta PATREON_CLIENT_ID/PATREON_REDIRECT_URI)" });
    return;
  }
  await cleanupOldStates();
  const state = crypto.randomBytes(24).toString("hex");
  await pool.query(
    "INSERT INTO patreon_oauth_state (state, wfm_user_id) VALUES ($1, $2)",
    [state, req.wfmUserId],
  );
  const url = new URL("https://www.patreon.com/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", state);
  res.json({ url: url.toString() });
}));

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const res = await fetch("https://www.patreon.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Patreon token exchange failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

interface PatreonIdentity {
  data: {
    id: string;
    attributes?: { email?: string; is_email_verified?: boolean };
    relationships?: { memberships?: { data?: { id: string }[] } };
  };
  included?: Array<{
    id: string;
    type: string;
    attributes?: { patron_status?: string | null };
    relationships?: { campaign?: { data?: { id: string } | null } };
  }>;
}

const IDENTITY_URL =
  "https://www.patreon.com/api/oauth2/v2/identity" +
  "?include=memberships,memberships.campaign" +
  "&fields[user]=email,is_email_verified" +
  "&fields[member]=patron_status";

/** Con el access_token PROPIO del usuario (no el del creador), le pregunta a
 *  Patreon quién es y si su membership de ESTA campaña está activa. */
async function fetchOwnPatronStatus(
  accessToken: string,
): Promise<{ patreonUserId: string; email: string | null; active: boolean }> {
  const res = await fetch(IDENTITY_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Patreon identity fetch failed: ${res.status}`);
  const body = (await res.json()) as PatreonIdentity;
  const email = body.data.attributes?.email ?? null;
  const memberIds = new Set((body.data.relationships?.memberships?.data ?? []).map(m => m.id));
  const active = (body.included ?? []).some(inc =>
    inc.type === "member" &&
    memberIds.has(inc.id) &&
    inc.relationships?.campaign?.data?.id === CAMPAIGN_ID &&
    inc.attributes?.patron_status === "active_patron",
  );
  return { patreonUserId: body.data.id, email, active };
}

/** Vuelta de Patreon tras el login. Público (ver patreonCallbackRouter arriba) —
 *  la identidad sale del "state", no de un header. Termina redirigiendo al
 *  browser de vuelta a la SPA (misma origin: "web" sirve front y API juntos). */
patreonCallbackRouter.get("/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code || !state) {
    res.redirect("/?patreon=error");
    return;
  }
  try {
    const { rows } = await pool.query(
      "DELETE FROM patreon_oauth_state WHERE state = $1 RETURNING wfm_user_id",
      [state],
    );
    const wfmUserId = rows[0]?.wfm_user_id as string | undefined;
    if (!wfmUserId) {
      res.redirect("/?patreon=error"); // state vencido, reusado, o inválido
      return;
    }
    const token = await exchangeCodeForToken(code);
    const { patreonUserId, email, active } = await fetchOwnPatronStatus(token.access_token);
    await pool.query(
      `INSERT INTO user_premium
         (wfm_user_id, patreon_user_id, patreon_email, access_token, refresh_token, token_expires_at, active, last_checked)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval, $7, now())
       ON CONFLICT (wfm_user_id) DO UPDATE SET
         patreon_user_id = EXCLUDED.patreon_user_id, patreon_email = EXCLUDED.patreon_email,
         access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at, active = EXCLUDED.active, last_checked = now()`,
      [wfmUserId, patreonUserId, email, token.access_token, token.refresh_token, token.expires_in, active],
    );
    res.redirect(active ? "/?patreon=connected" : "/?patreon=not_a_patron");
  } catch {
    res.redirect("/?patreon=error");
  }
});
