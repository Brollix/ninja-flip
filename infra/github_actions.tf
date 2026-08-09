# Permisos del service account de CI (github_deployer, ver service_accounts.tf)
# — mínimo necesario para que .github/workflows/deploy.yml pueda: build+push
# de las 3 imágenes a Artifact Registry, y actualizar la imagen de los 2
# Cloud Run services y los 2 Cloud Run Jobs que ya provisionó este mismo
# Terraform. Todo scoped al recurso puntual, nunca a nivel proyecto — este
# service account no puede crear/borrar nada, ni tocar otros servicios.
#
# Los "name"/"repository" de abajo son los nombres literales (mismo patrón
# "${var.app_name}-<algo>" que ya usan cloud_run_*.tf), NO una referencia al
# recurso de Terraform correspondiente — referenciarlo (ej.
# google_cloud_run_v2_service.web.name) encadenaría cualquier cambio/drift
# pendiente de ESE recurso a este apply, y este archivo solo debe tocar IAM.

# roles/run.developer alcanza de sobra, pero de más: también deja crear/
# borrar services/Jobs, cambiar domain mappings, tocar IAM del propio
# recurso (getIamPolicy/setIamPolicy). Este rol custom se queda solo con lo
# que .github/workflows/deploy.yml efectivamente necesita — actualizar la
# imagen de algo que YA existe.
resource "google_project_iam_custom_role" "run_image_deployer" {
  project     = var.project_id
  role_id     = "runImageDeployer"
  title       = "Cloud Run image deployer (CI)"
  description = "Actualiza la imagen de Cloud Run services/Jobs ya existentes — sin crear/borrar recursos ni tocar su IAM."
  permissions = [
    "run.services.get",
    "run.services.update",
    "run.jobs.get",
    "run.jobs.update",
    "run.revisions.get",
    "run.revisions.list",
    "run.operations.get",
    "run.operations.list",
  ]
}

resource "google_artifact_registry_repository_iam_member" "github_deployer_pushes_images" {
  project    = var.project_id
  location   = var.region
  repository = var.app_name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "github_deployer_updates_web" {
  project  = var.project_id
  location = var.region
  name     = "${var.app_name}-web"
  role     = google_project_iam_custom_role.run_image_deployer.id
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "github_deployer_updates_report" {
  project  = var.project_id
  location = var.region
  name     = "${var.app_name}-report"
  role     = google_project_iam_custom_role.run_image_deployer.id
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_job_iam_member" "github_deployer_updates_flip_scanner" {
  project  = var.project_id
  location = var.region
  name     = "${var.app_name}-flip-scanner"
  role     = google_project_iam_custom_role.run_image_deployer.id
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_job_iam_member" "github_deployer_updates_report_warmer" {
  project  = var.project_id
  location = var.region
  name     = "${var.app_name}-report-warmer"
  role     = google_project_iam_custom_role.run_image_deployer.id
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

# run.developer alcanza para actualizar la revisión, pero Cloud Run también
# exige que quien hace el deploy pueda "actuar como" la identidad de runtime
# que va a correr esa revisión (iam.serviceaccounts.actAs) — sin esto el
# deploy tira PERMISSION_DENIED aunque el rol de arriba esté bien. Un binding
# por cada SA de runtime que este deployer efectivamente usa: "web" (service
# web), "report" (services report + report-warmer, comparten SA), "scanner"
# (Job flip-scanner). Nombres literales, no resource — mismo motivo que el
# resto de este archivo.
resource "google_service_account_iam_member" "github_deployer_actas_web" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.app_name}-web@${var.project_id}.iam.gserviceaccount.com"
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_service_account_iam_member" "github_deployer_actas_report" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.app_name}-report@${var.project_id}.iam.gserviceaccount.com"
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_service_account_iam_member" "github_deployer_actas_scanner" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.app_name}-scanner@${var.project_id}.iam.gserviceaccount.com"
  role                = "roles/iam.serviceAccountUser"
  member              = "serviceAccount:${google_service_account.github_deployer.email}"
}

# ---------------------------------------------------------------------------
# Workload Identity Federation: GitHub Actions se autentica sin ninguna key
# de larga duración (bloqueadas por policy de organización,
# constraints/iam.disableServiceAccountKeyCreation) — cambia un token OIDC
# de corta duración que firma GitHub por un token de acceso de
# github_deployer, solo para runs que salgan de var.github_repo. El
# attribute_condition ata el token a ESE repo Y a la rama master
# específicamente (no cualquier rama/PR de fork puede pedir este token).
# ---------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "Deploys de ${var.github_repo} a Cloud Run en push a master"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id         = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Sin esto, CUALQUIER repo público de GitHub podría pedir un token para
  # impersonar a github_deployer — esta condición es lo que realmente limita
  # el acceso, no el filename del workflow (eso lo puede cambiar cualquiera
  # con push access).
  attribute_condition = "assertion.repository == \"${var.github_repo}\" && assertion.ref == \"refs/heads/master\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deployer_wif_binding" {
  service_account_id = google_service_account.github_deployer.name
  role                = "roles/iam.workloadIdentityUser"
  member              = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
