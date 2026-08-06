import { pool } from "./db.js";

// Mismas dos cuentas "gratis de por vida" que ALWAYS_PREMIUM_IDS en
// app/src/wfm.ts (los primeros testers, antes de que existiera Patreon) —
// el front las trata como premium para la UI, pero eso no protegía nada
// server-side. Esta es la fuente de verdad que sí importa para costos.
const ALWAYS_PREMIUM_IDS = new Set([
  "5b9bf77418d4f700ad180263", // Brollix
  "69b9a72a4a1f65002a9db15b", // Spazz_0000
]);

export async function isPremiumServer(wfmUserId: string): Promise<boolean> {
  if (ALWAYS_PREMIUM_IDS.has(wfmUserId)) return true;
  const { rows } = await pool.query(
    "SELECT active FROM user_premium WHERE wfm_user_id = $1",
    [wfmUserId],
  );
  return rows[0]?.active === true;
}
