# CLAUDE.md

Instructions for Claude Code working in this repo. See [README.md](README.md)
for what the app does and its architecture.

## Current status: GCP infra torn down (2026-08-24)

All GCP resources for `warframe-plat-trader` were destroyed via
`terraform destroy` to stop billing while the project is on hold — nothing
is running. `infra/` still fully describes it, so bringing it back is:

1. `terraform apply` in `infra/` with `-var` flags for `project_id`,
   `web_image`, `report_image`, `scanner_image` (any existing image tag
   works to bootstrap — `deploy.yml` overwrites it on the next push anyway).
2. Re-add the `database_url` secret value — the Secret Manager *container*
   gets recreated by `terraform apply`, but its value was deleted with the
   old container. Pull the connection string from the Neon dashboard and
   run `gcloud secrets versions add database-url --data-file=-` (see
   `infra/secrets.tf` header comments for the other secrets — Patreon,
   AlecaFrame — which follow the same pattern).
3. Push to `master` (or re-run the last deploy workflow) to get real images
   onto the freshly-created services/jobs.
4. Cloud Scheduler jobs are created **enabled** by `terraform apply` — no
   extra step needed there.

Neon itself was left alone (Terraform never managed it) — it auto-suspends
compute on inactivity, so no action was needed to stop its billing beyond
not querying it.

## Deploy

- **Push to `master` deploys automatically** via `.github/workflows/deploy.yml`
  — it builds and redeploys only the Cloud Run service/job whose code
  actually changed (path-filtered). Don't run `gcloud builds submit` or
  `gcloud run deploy` by hand for a routine code change; that workflow is it.
- `terraform apply` (in `infra/`) is for **provisioning infra only** — new
  resources, IAM, secret containers. It is never triggered by CI and should
  stay that way; don't wire it into the GitHub Actions workflow.
- The repo's default branch is `master`, not `main` — don't assume otherwise.
- Never generate a GCP service account **key**. This project has
  `constraints/iam.disableServiceAccountKeyCreation` enforced from the org —
  key creation will fail outright. Any GitHub Actions ↔ GCP auth goes through
  the Workload Identity Federation pool in `infra/github_actions.tf`
  (`google_iam_workload_identity_pool_provider.github`).
- Secret *values* (DB connection string, Patreon credentials, AlecaFrame
  tokens) are never committed and never go through Terraform state — they're
  added out-of-band with `gcloud secrets versions add` (see the comments at
  the top of `infra/secrets.tf`). Terraform only creates the empty secret
  *containers*.

## Terraform conventions

- IAM bindings are always scoped to the specific resource
  (`google_cloud_run_v2_service_iam_member`, `..._job_iam_member`,
  `..._repository_iam_member`, etc.) — never a project-wide role grant.
  Follow that pattern for anything new.
- Resource/service-account names follow `"${var.app_name}-<role>"`
  (e.g. `warframe-plat-trader-web`, `warframe-plat-trader-scheduler`).
  `google_service_account.account_id` has a **30-char limit** — check before
  picking a name (`warframe-plat-trader-` alone is already 21 chars).
- When referencing an existing resource from a *new* file/resource, prefer
  the literal name string (`"${var.app_name}-web"`) over the Terraform
  resource attribute (`google_cloud_run_v2_service.web.name`) if you don't
  want to touch that resource — referencing the attribute pulls its entire
  pending diff into any `-target` plan/apply you run, even unrelated drift.
- This repo has **existing unapplied drift** (the Patreon secret resources in
  `secrets.tf`/`cloud_run_web.tf` were never actually applied against real
  infra). Don't run a plain `terraform apply` assuming a clean tree — run
  `terraform plan` first, and if you're only adding something scoped, use
  `-target` for the exact new resources rather than applying everything
  `plan` shows.
- `terraform plan`/`apply` need `-var` flags (`project_id`, `web_image`,
  `report_image`, `scanner_image` — no `.tfvars` file exists). Pull current
  image tags from the live services instead of guessing:
  `gcloud run services describe <name> --region us-east1 --format="value(spec.template.spec.containers[0].image)"`.

## Data model / architecture notes not obvious from a quick read

- `report` and `report-warmer` are **two Cloud Run resources sharing one
  Docker image** (`scripts/Dockerfile.report`) — only the `command` differs
  (HTTP server vs. one-shot warm job). Any image/dependency change to that
  Dockerfile needs both redeployed with the same tag.
- `market_items` (flip scanner data) is the only table **shared across all
  users**. Every other per-user table is scoped by `wfm_user_id` — there's no
  password table; identity is the warframe.market JWT, verified server-side
  against `/v2/me` (`server/src/wfmAuth.ts`).
- AlecaFrame integration is read-only, per-user token (`user_aleca_tokens`),
  not a global `.env` value anymore — don't reintroduce a shared token.

## Code style already established here

- Comments explain **why**, not what — mostly in Spanish, matching the
  existing style. Don't add comments that restate the code, and don't switch
  the existing comments' language.
- No new abstractions/backwards-compat shims unless asked — this repo
  favors direct, explicit code (see the general engineering guidance for
  this session, which still applies).
- `.gitignore` covers `node_modules/`, `dist/`, `*.tsbuildinfo`, and all
  Terraform state/cache/plan files — never force-add anything under those.
  This bit us once already (~160MB of build artifacts and a Terraform
  provider binary almost got committed).
