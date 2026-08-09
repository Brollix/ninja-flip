-- Warframe Platinum Trader — esquema Postgres (Neon).
-- Reemplaza ledger.db (SQLite, un solo usuario) + los JSON estáticos que
-- generaban scripts/relic_analysis.py y scripts/flips.py.
--
-- Identidad: no hay tabla de "users" con contraseña — el id de warframe.market
-- (verificado server-side contra /v2/me con el JWT del navegador, ver
-- server/wfmAuth.ts) es la clave de scoping en todas las tablas per-user.
--
-- Aplicar una vez: psql "$DATABASE_URL" -f db/schema.sql

-- ---------------------------------------------------------------------------
-- Datos de mercado: iguales para TODOS los usuarios. Los escribe únicamente
-- el Cloud Run Job flip-scanner (scripts/flips.py adaptado); todos los
-- usuarios solo leen esta tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_items (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- 'set' | 'arcane' | 'mod'
  rank        INTEGER NOT NULL DEFAULT 0,
  rank_known  BOOLEAN NOT NULL DEFAULT false, -- maxRank ya resuelto (no cambia nunca, evita re-pedirlo)
  buy         REAL NOT NULL DEFAULT 0,
  sell        REAL NOT NULL DEFAULT 0,
  vol48       INTEGER NOT NULL DEFAULT 0,
  score       REAL NOT NULL DEFAULT 0,     -- flip_score() — ver scripts/flips.py
  price_ts    DOUBLE PRECISION,            -- epoch seconds (time.time() de Python), no TIMESTAMPTZ
  vol_ts      DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Arbitraje partes→set (comprar las partes sueltas, vender el set armado).
  -- Solo aplica a kind='set'; NULL en arcanos/mods y en sets sin datos de
  -- partes todavía. ADD COLUMN IF NOT EXISTS: este archivo se reaplica sobre
  -- la tabla ya existente, CREATE TABLE IF NOT EXISTS de arriba no alcanza
  -- para sumar columnas nuevas a una tabla que ya existe.
  parts_total   REAL,
  parts_profit  REAL,
  parts_detail  TEXT
);
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS parts_total REAL;
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS parts_profit REAL;
ALTER TABLE market_items ADD COLUMN IF NOT EXISTS parts_detail TEXT;
-- flipsRouter (server/src/routes/flips.ts) y flips.py hacen exactamente este
-- filtro+orden en cada request/corrida ("WHERE vol48 >= X ORDER BY score
-- DESC") — sin índice, full scan + sort completo de la tabla cada vez.
CREATE INDEX IF NOT EXISTS idx_market_items_vol48_score ON market_items (vol48, score DESC);

-- ---------------------------------------------------------------------------
-- Ledger de flips cerrados (🛒 bought → 💰 sold), por usuario.
-- Antes: tabla "flips" en ledger.db, sin scoping (un solo usuario).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_ledger_flips (
  id          BIGSERIAL PRIMARY KEY,
  wfm_user_id TEXT NOT NULL,
  item        TEXT NOT NULL,
  buy         REAL NOT NULL,
  sell        REAL NOT NULL,
  ts          BIGINT NOT NULL,
  UNIQUE (wfm_user_id, item, ts)
);
CREATE INDEX IF NOT EXISTS idx_user_ledger_flips_user ON user_ledger_flips (wfm_user_id);
-- ledger.ts hace "WHERE wfm_user_id = $1 ORDER BY ts" — compuesto para que
-- el ORDER BY también salga del índice, no de un sort en memoria aparte.
CREATE INDEX IF NOT EXISTS idx_user_ledger_flips_user_ts ON user_ledger_flips (wfm_user_id, ts);

-- ---------------------------------------------------------------------------
-- Flips detectados automáticamente cruzando compras y ventas del historial
-- de trades de AlecaFrame (report_server.py, detect_flips()) — separado a
-- propósito de user_ledger_flips (esos son solo los que confirmás a mano
-- con 🛒 bought / 💰 sold en la app). El Flip History de la UI muestra la
-- unión de las dos tablas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_detected_flips (
  id          BIGSERIAL PRIMARY KEY,
  wfm_user_id TEXT NOT NULL,
  item        TEXT NOT NULL,
  buy         REAL NOT NULL,
  sell        REAL NOT NULL,
  ts          BIGINT NOT NULL,
  -- cuánto vale HOY lo mismo que flipeaste (suma del sell price actual de
  -- cada parte) — para comparar contra el buy/sell de cuando lo hiciste.
  -- NULL en filas viejas insertadas antes de que existiera esta columna.
  market_now  REAL,
  UNIQUE (wfm_user_id, item, ts)
);
CREATE INDEX IF NOT EXISTS idx_user_detected_flips_user ON user_detected_flips (wfm_user_id);
CREATE INDEX IF NOT EXISTS idx_user_detected_flips_user_ts ON user_detected_flips (wfm_user_id, ts);

-- ---------------------------------------------------------------------------
-- Cost basis de órdenes de venta abiertas (lo que pagaste, para calcular el
-- delta al vender). Antes: tabla "cost_basis" en ledger.db.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_cost_basis (
  order_id    TEXT PRIMARY KEY,
  wfm_user_id TEXT NOT NULL,
  item        TEXT NOT NULL,
  cost        REAL NOT NULL,
  ts          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_cost_basis_user ON user_cost_basis (wfm_user_id);

-- ---------------------------------------------------------------------------
-- Token público de AlecaFrame de cada usuario (antes: ALECA_PUBLIC_TOKEN
-- global en .env, un solo valor para toda la app). Cada usuario pega el suyo
-- una vez en la UI de settings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_aleca_tokens (
  wfm_user_id      TEXT PRIMARY KEY,
  aleca_public_token TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Estado premium por usuario. active=true si (a) está en la lista hardcodeada
-- de "siempre gratis" (ver ALWAYS_PREMIUM_IDS en wfm.ts, esto no pasa por acá)
-- o (b) el usuario hizo login con SU cuenta de Patreon (OAuth "Connect with
-- Patreon", ver server/src/routes/premium.ts) y esa cuenta es un patron activo
-- de la campaña — chequeado con el token propio del usuario, no con el del
-- creador. patreon_user_id/access_token/refresh_token quedan guardados para
-- poder re-chequear el estado más adelante sin pedirle que se loguee de nuevo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_premium (
  wfm_user_id       TEXT PRIMARY KEY,
  patreon_user_id   TEXT,
  patreon_email     TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,
  active            BOOLEAN NOT NULL DEFAULT false,
  last_checked      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Estado efímero del handshake OAuth de Patreon: el navegador navega FUERA
-- de la SPA (a patreon.com) y vuelve a /api/patreon/callback sin el header
-- Authorization que normalmente probaría quién es (ese header solo lo manda
-- fetch() de JS, no una navegación de browser). "state" es la forma de atar
-- el callback de vuelta al wfm_user_id que lo pidió. Fila de un solo uso —
-- se borra apenas se usa, y cualquier sobrante de más de 10 min (login
-- abandonado a mitad de camino) se limpia en cada intento nuevo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patreon_oauth_state (
  state       TEXT PRIMARY KEY,
  wfm_user_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- cleanupOldStates() (server/src/routes/premium.ts) filtra por created_at en
-- cada intento de login con Patreon — la tabla se mantiene chica sola gracias
-- a ese mismo cleanup, pero de todos modos el índice sale gratis.
CREATE INDEX IF NOT EXISTS idx_patreon_oauth_state_created_at ON patreon_oauth_state (created_at);

-- ---------------------------------------------------------------------------
-- Snapshot cacheado del reporte de reliquias/historial/ventas por usuario
-- (antes: app/public/data/report.json, generado a mano por un solo usuario).
-- report_json guarda el mismo shape que espera app/src/types.ts:Report.
-- Se regenera bajo demanda cuando generated_at supera el TTL (ver
-- scripts/report_server.py) en vez de pegarle a AlecaFrame en cada visita.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_reports (
  wfm_user_id  TEXT PRIMARY KEY,
  report_json  JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Precios de PARTES/items individuales que salen de reliquias (no son los
-- mismos ~391 items que escanea flips.py — ahí son sets/arcanos/mods enteros,
-- acá son partes sueltas de drop tables). Compartido entre todos los
-- usuarios, con TTL de 12h (antes: cache/item_data.json + item_meta.json,
-- local a un solo usuario). Los ducados no cambian, no tienen TTL real.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_price_cache (
  name        TEXT PRIMARY KEY,      -- nombre tal cual lo usa AlecaFrame/drop tables
  sell        REAL NOT NULL DEFAULT 0,
  med48       REAL NOT NULL DEFAULT 0,
  vol48       INTEGER NOT NULL DEFAULT 0,
  -- NULL, no 0: ducats se cachea "para siempre" (nunca vencen), así que un 0
  -- forzado por un fetch fallido quedaba mal de por vida — NULL es la señal
  -- de "reintentar la próxima vez" (ver fetch_ducats/get_item_data en
  -- relic_analysis.py). ALTER en vez de solo la definición de CREATE TABLE
  -- porque este archivo se reaplica sobre la tabla ya existente.
  ducats      INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE item_price_cache ALTER COLUMN ducats DROP NOT NULL;
ALTER TABLE item_price_cache ALTER COLUMN ducats DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Precio de venta de la reliquia ENTERA ("Meso D3 Relic"), compartido,
-- TTL 12h (antes: cache/relic_prices.json).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relic_price_cache (
  relic_full  TEXT PRIMARY KEY,
  price       REAL NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Cache genérico de datos externos que NO son precios (drop tables, lista de
-- items de warframe.market, vaulted/farm de WFCD) — compartido entre todos
-- los usuarios y entre containers efímeros. Antes vivía en cache/*.json en
-- disco local: funciona para el service "report" (min_instance_count=1, el
-- disco persiste mientras la instancia siga viva) pero NO para Jobs como
-- report-warmer (cada ejecución es un container nuevo sin disco previo) —
-- re-descargaba estos 3 archivos en CADA corrida aunque cambien ~1 vez por
-- semana. Una sola tabla genérica (no una por archivo): el contrato es
-- idéntico en los 3 casos (clave -> blob JSON -> TTL en horas).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_data_cache (
  cache_key   TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Actividad global de trading por franja horaria real (cronológica, no
-- plegada por hora del día) — para "mejor momento para tradear". No pega a
-- ninguna API de más: reusa el volumen por hora que
-- /v1/items/{slug}/statistics ya devuelve para su ventana de 48h (el techo
-- real de granularidad horaria que da la API; no hay forma de pedir más).
-- Se reescribe entera cada refresh (DELETE + INSERT) porque la ventana de
-- 48h se desliza con el tiempo — no es un conteo exacto acumulado, es una
-- foto aproximada de qué franjas tienden a tener más movimiento.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hourly_activity (
  bucket_ts   TIMESTAMPTZ PRIMARY KEY,  -- hora truncada, UTC
  volume      BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
