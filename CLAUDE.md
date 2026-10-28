# CLAUDE.md

Instructions for Claude Code working in this repo. See [README.md](README.md)
for what the app does and its architecture.

## Current status: leaving GCP for AWS (2026-10-28)

**GCP is being abandoned in favor of AWS.** The `ninjaflip` GCP project
described below was created and then deleted the same day (2026-10-28),
before anything was deployed. The `infra/` Terraform and `deploy.yml` are
still GCP-only, and they're kept only as a reference for the AWS port. Don't
apply them. Nothing is deployed right now, and the app runs locally via
`docker-compose.yml` (with a Cloudflare quick tunnel).

The old `warframe-plat-trader` GCP project was torn down (2026-09-14) and is
no longer used. Infra had been pointed at a fresh project, **`ninjaflip`**
(project number `179508033489`; the ID `ninja-flip` was taken). `infra/variables.tf`
defaults `project_id` to it, and `deploy.yml` points at its registry, WIF
provider and deployer service account. Resource names still use
`app_name = "warframe-plat-trader"`. The local Terraform state is empty, so
the next apply creates everything from scratch.

The DB is now **Supabase** (session pooler, IPv4), not Neon. The web
container (Node `pg`) needs `&uselibpqcompat=true` appended to the
`sslmode=require` URL. The Python services (psycopg) reject that param, so
they get the plain URL.

Bringing it up (needs billing linked to `ninjaflip` first):

1. `terraform apply -target=google_project_service.this
   -target=google_artifact_registry_repository.images` to get the APIs and
   the registry. The Cloud Run resources can't be created until their
   images exist in the new registry.
2. Build and push the three images (web, report, scanner) to
   `us-east1-docker.pkg.dev/ninjaflip/warframe-plat-trader`.
3. Full `terraform apply` with the `-var` image flags.
4. Add the secret values with `gcloud secrets versions add` (see the
   `infra/secrets.tf` header): `database-url` from Supabase, plus Patreon
   and AlecaFrame if used.
5. After that, pushes to `master` deploy normally.

Patreon's redirect URI is now the deterministic Cloud Run URL
`https://warframe-plat-trader-web-179508033489.us-east1.run.app/api/patreon/callback`.
It must also be registered in the Patreon Developer Portal.

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

- **Everything in this project is in English** — UI copy, code comments,
  commit messages, docs. The only exception is chat replies to the user,
  which are in Spanish. Older comments are still in Spanish; translate them
  when you're already touching that code, but don't do mass rewrites unasked.
- Comments explain **why**, not what. Don't add comments that restate the code.
- No new abstractions/backwards-compat shims unless asked — this repo
  favors direct, explicit code (see the general engineering guidance for
  this session, which still applies).
- `.gitignore` covers `node_modules/`, `dist/`, `*.tsbuildinfo`, and all
  Terraform state/cache/plan files — never force-add anything under those.
  This bit us once already (~160MB of build artifacts and a Terraform
  provider binary almost got committed).

## Git & Workflow Conventions

- Always stage (`git add`), commit (`git commit -m "..."`), and push (`git push`) your changes automatically once a task is completed or files are modified.

