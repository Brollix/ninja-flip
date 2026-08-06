/** Token de identidad de Google firmado para llamar a OTRO servicio privado
 *  de Cloud Run (el "report") server-to-server. Solo existe corriendo
 *  adentro de GCP — el servidor de metadata de la instancia lo firma con la
 *  cuenta de servicio del container ("web"), pidiendo como audience la URL
 *  del servicio destino. Sin esto, el invoker de IAM que le dimos a "web"
 *  sobre "report" nunca se usa: la llamada sale sin credenciales. */

// Estos ID tokens duran ~1h (traen su propio "exp") — pedir uno nuevo al
// metadata server en CADA /api/report sumaba una ida y vuelta de red de
// más a cada request, incluso cuando "report" solo iba a devolver el
// cache de Postgres. Se cachea por audience hasta poco antes de vencer.
const idTokenCache = new Map<string, { token: string; expiresAt: number }>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function fetchIdToken(audience: string): Promise<string | null> {
  const cached = idTokenCache.get(audience);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  try {
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const r = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) return null;
    const token = await r.text();
    const exp = jwtExpiryMs(token);
    idTokenCache.set(audience, { token, expiresAt: (exp ?? Date.now() + 30 * 60 * 1000) - REFRESH_MARGIN_MS });
    return token;
  } catch {
    return null; // no corriendo en GCP (dev local) — el caller decide qué hacer
  }
}
