# Warframe · Platinum Trader

Multi-user trading assistant for warframe.market: flip scanner with live
prices, order management (post / adjust / close with one click, plus premium
automation — auto-undercut, auto-pause, auto-fill capital), relic-cracking
analysis fed by AlecaFrame data, and a profit ledger. Runs entirely on GCP —
no local scripts or per-user setup needed to use it.

## Architecture

Three services on Cloud Run, one shared Postgres database (Neon), deployed
from a single repo/Docker build context:

```
              ┌──────────────┐        ┌──────────────┐
  browser ──► │  web (Node)  │ ─────► │ report (Py)  │  server-to-server only
              │  server/     │        │ scripts/     │  (not public)
              └──────┬───────┘        └──────┬───────┘
                      │                        │
                      └──────────┬─────────────┘
                                 ▼
                          Postgres (Neon)
                                 ▲
                      ┌──────────┴──────────┐
                      │  flip-scanner (Job) │  Cloud Run Job, cron every 10min
                      │  scripts/flips.py   │  (writes market_items)
                      └─────────────────────┘
                      ┌─────────────────────┐
                      │ report-warmer (Job) │  Cloud Run Job, cron every 10min
                      │ scripts/warm_...py  │  (pre-warms per-user report cache)
                      └─────────────────────┘
```

- **web** (`server/`, Express + TypeScript) — the public entrypoint. Serves
  the built frontend, proxies `/wfm/*` to api.warframe.market (no CORS
  there), verifies the warframe.market JWT (`server/src/wfmAuth.ts`) that
  scopes every per-user table, handles the Patreon OAuth flow for premium
  (`server/src/routes/premium.ts`), and calls the `report` service
  internally for relic/history data.
- **report** (`scripts/report_server.py`, Flask, internal-only —
  `infra/cloud_run_report.tf` restricts invocation to the `web` service
  account) — runs `relic_analysis.build_report()` per user and caches the
  result in `user_reports` (Postgres) with a TTL, so AlecaFrame isn't hit on
  every page load.
- **flip-scanner** (`scripts/flips.py`, Cloud Run Job) — the prime-set flip
  scanner (spreads, liquidity, parts→set arbitrage), triggered by Cloud
  Scheduler every 10 min, writes to `market_items` (shared across all users).
- **report-warmer** (`scripts/warm_reports.py`, Cloud Run Job, same image as
  `report`) — proactively refreshes `user_reports` for users whose cache is
  about to expire, so nobody hits a cold cache on page load.

## Structure

```
app/          React + TypeScript + Vite frontend (built and served by web/)
server/       Express/TS — the "web" Cloud Run service
scripts/      Python — relic_analysis.py / flips.py / report_server.py /
              warm_reports.py, plus the two Dockerfiles (report, scanner)
db/schema.sql Postgres schema (Neon) — apply once: psql "$DATABASE_URL" -f db/schema.sql
infra/        Terraform: Cloud Run services/jobs, Artifact Registry, service
              accounts, Secret Manager containers, Cloud Scheduler
cloudbuild.*.yaml   Cloud Build configs (docker build + push), one per image
.env          local-only secrets (ALECA_*, DATABASE_URL) — never commit
```

## Identity & data model

No password table — the warframe.market account (verified server-side
against `/v2/me` with the browser's JWT) is the identity, and every per-user
table is scoped by `wfm_user_id`. AlecaFrame is used read-only via each
user's own public stats token (`user_aleca_tokens`, pasted once in the app).
Premium is unlocked either by a hardcoded allowlist or by connecting a
Patreon account that's an active patron (`user_premium`, OAuth in
`server/src/routes/premium.ts`).

## Local development

```bash
npm install --prefix app
npm run dev --prefix app     # http://localhost:5173
```

The Vite dev server proxies `/wfm/*` the same way `web` does in prod, and
runs a local SQLite-backed `/ledger/*` middleware
(`app/vite.config.ts:ledgerPlugin`) so the frontend works standalone without
the Express server or Postgres. `/api/*` (report, premium, items, …) needs
the real `server/` + Postgres to respond — either run `server/` locally
against a Postgres instance, or just develop against the deployed API.

To run `web` + `report` for real locally you need `DATABASE_URL` pointing at
a Postgres instance with `db/schema.sql` applied, plus the Patreon/AlecaFrame
secrets in `.env` — see the `env` blocks in `infra/cloud_run_web.tf` and
`infra/cloud_run_report.tf` for the full list.

## Deploy

```bash
gcloud builds submit --config cloudbuild.web.yaml       # web (Express + frontend)
gcloud builds submit --config cloudbuild.report.yaml    # report + report-warmer image
gcloud builds submit --config cloudbuild.scanner.yaml   # flip-scanner image

cd infra && terraform apply
```

Terraform provisions the Cloud Run services/jobs, Secret Manager containers,
and the Cloud Scheduler triggers — secret *values* (DB connection string,
Patreon credentials) are added out-of-band via `gcloud secrets versions add`
(see the comments in `infra/secrets.tf`), never through Terraform state.
