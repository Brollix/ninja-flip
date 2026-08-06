import pg from "pg";

// Cloud Run service = container de larga vida (a diferencia del Job de
// flips.py, que es un container nuevo cada corrida) — un Pool normal de
// node-postgres tiene sentido acá, no hace falta el driver HTTP de
// @neondatabase/serverless (pensado para runtimes tipo edge/una request).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("Falta DATABASE_URL (Secret Manager en prod, .env en local)");
}

export const pool = new pg.Pool({ connectionString, max: 5 });
