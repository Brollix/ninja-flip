# NinjaFlip · Warframe Platinum Trader

**👉 [warframe-plat-trader-web-qptpzf6lka-ue.a.run.app](https://warframe-plat-trader-web-qptpzf6lka-ue.a.run.app)**

A trading companion for [warframe.market](https://warframe.market) — not a
replacement, an add-on for people who flip regularly. Runs in the cloud,
nothing to install: open the link, sign in with your warframe.market account,
and go.

## What it does

- **Flip scanner** — scores prime sets, arcanes and mods by spread and
  liquidity (buy low, resell with confidence, not guesswork), including
  parts→set arbitrage.
- **My Orders** — see every one of your live buy/sell orders against the
  best competing price, one click to fix an out-of-position order, one click
  to record a sale and chain the resell.
- **Relic analysis** — crosses your relic inventory (via AlecaFrame) with
  drop tables and ducat prices to tell you what's worth cracking.
- **Profit ledger** — tracks your closed flips over time so you know if
  you're actually netting plat.
- **Peak trading time** — when the market's busiest right now, so your
  orders sit where buyers/sellers actually are.

### Premium (via Patreon)

Connecting your [Patreon](https://www.patreon.com/c/ninjaflip) account (if
you're an active patron) unlocks automation on top of the above:

- **Auto-undercut** — keeps your orders first-in-line automatically.
- **Auto-pause** — hides your orders outside peak trading hours, shows them
  again before the next one.
- **Auto-fill capital** — posts buy orders on scanner picks with your free
  plat until it runs out.

## Getting started

1. Open the app and sign in with your warframe.market credentials — that's
   your account, no separate password to create.
2. Optionally paste your AlecaFrame public link token (Stats tab → "Create
   Public Link") to unlock relic inventory, history and the profit ledger.
   Skip it and you still get the flip scanner and My Orders.
3. Trade. Orders you post from the app show up on warframe.market like any
   other order.

Not affiliated with Digital Extremes or warframe.market.

---

## Architecture

Three services on Cloud Run + one shared Postgres (Neon), auto-deployed on
push to `master` via GitHub Actions:

```
              ┌──────────────┐        ┌──────────────┐
  browser ──► │  web (Node)  │ ─────► │ report (Py)  │  internal-only
              │  server/     │        │ scripts/     │  (server-to-server)
              └──────┬───────┘        └──────┬───────┘
                      │                        │
                      └──────────┬─────────────┘
                                 ▼
                          Postgres (Neon)
                                 ▲
             ┌───────────────────┴───────────────────┐
             │ flip-scanner (Job)   report-warmer (Job) │  Cloud Scheduler,
             │ scripts/flips.py     scripts/warm_...py  │  every 10 min
             └───────────────────────────────────────┘
```

- **web** (`server/`) — public entrypoint: serves the frontend, proxies
  `/wfm/*` to api.warframe.market, verifies the warframe.market JWT that
  scopes every per-user table, and handles Patreon OAuth for premium.
- **report** (`scripts/report_server.py`, internal-only) — builds the
  relic/history report per user, caches it in Postgres with a TTL.
- **flip-scanner** (`scripts/flips.py`, Cloud Run Job) — the market-wide
  scanner, cron every 10 min.
- **report-warmer** (`scripts/warm_reports.py`, Cloud Run Job, same image as
  `report`) — pre-refreshes caches about to expire so nobody hits a cold one.

No password table — identity is the warframe.market account
(`server/src/wfmAuth.ts`), scoped by `wfm_user_id` in every table. AlecaFrame
is read-only via each user's own token, pasted once.

### Repo layout

```
app/          React + TypeScript + Vite frontend (built and served by web/)
server/       Express/TS — the "web" Cloud Run service
scripts/      Python — relic_analysis.py / flips.py / report_server.py / warm_reports.py
db/schema.sql Postgres schema (Neon) — apply once: psql "$DATABASE_URL" -f db/schema.sql
infra/        Terraform: Cloud Run services/jobs, Artifact Registry, service
              accounts, Secret Manager containers, Cloud Scheduler, CI's WIF pool
.github/workflows/deploy.yml   builds+deploys on push to master (per changed path)
.env          local-only secrets (ALECA_*, DATABASE_URL) — never commit
```

### Local development

```bash
npm install --prefix app
npm run dev --prefix app     # http://localhost:5173
```

The Vite dev server proxies `/wfm/*` and runs a local SQLite `/ledger/*`
middleware, so the frontend works standalone. `/api/*` (report, premium,
items…) needs the real `server/` + a Postgres instance with `db/schema.sql`
applied — see the `env` blocks in `infra/cloud_run_web.tf` /
`cloud_run_report.tf` for the full secret list.

### Deploy

Push to `master` and GitHub Actions (`.github/workflows/deploy.yml`) builds
and redeploys whatever changed — no manual step. It authenticates to GCP via
Workload Identity Federation (no long-lived keys, scoped to this repo on
`master` only — see `infra/github_actions.tf`).

Provisioning infra itself (new resources, IAM, secrets) stays manual:

```bash
cd infra && terraform apply
```

Secret *values* (DB connection string, Patreon credentials) are added
out-of-band via `gcloud secrets versions add` (see `infra/secrets.tf`), never
through Terraform state.
