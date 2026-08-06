# El contenedor del secret se crea acá — el VALOR (la connection string de
# Neon) se agrega a mano, fuera de Terraform, para que la contraseña nunca
# quede en el state:
#
#   echo -n "postgresql://...neon..." | gcloud secrets versions add \
#     database-url --project=$PROJECT_ID --data-file=-
#
resource "google_secret_manager_secret" "database_url" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  secret_id  = "database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "web_reads_db_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}

resource "google_secret_manager_secret_iam_member" "report_reads_db_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.report.email}"
}

resource "google_secret_manager_secret_iam_member" "scanner_reads_db_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scanner.email}"
}

# ---------------------------------------------------------------------------
# Patreon (premium) — mismo patrón que database_url: el contenedor se crea
# acá, el VALOR se agrega a mano fuera de Terraform:
#
#   printf '%s' "<valor>" | gcloud secrets versions add patreon-client-id \
#     --project=$PROJECT_ID --data-file=-
#
# (repetir para patreon-client-secret, patreon-creator-access-token,
# patreon-creator-refresh-token). Solo "web" los necesita.
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret" "patreon_client_id" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  secret_id  = "patreon-client-id"
  replication { auto {} }
}
resource "google_secret_manager_secret" "patreon_client_secret" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  secret_id  = "patreon-client-secret"
  replication { auto {} }
}
resource "google_secret_manager_secret" "patreon_creator_access_token" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  secret_id  = "patreon-creator-access-token"
  replication { auto {} }
}
resource "google_secret_manager_secret" "patreon_creator_refresh_token" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  secret_id  = "patreon-creator-refresh-token"
  replication { auto {} }
}

resource "google_secret_manager_secret_iam_member" "web_reads_patreon_client_id" {
  secret_id = google_secret_manager_secret.patreon_client_id.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}
resource "google_secret_manager_secret_iam_member" "web_reads_patreon_client_secret" {
  secret_id = google_secret_manager_secret.patreon_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}
resource "google_secret_manager_secret_iam_member" "web_reads_patreon_creator_access_token" {
  secret_id = google_secret_manager_secret.patreon_creator_access_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}
resource "google_secret_manager_secret_iam_member" "web_reads_patreon_creator_refresh_token" {
  secret_id = google_secret_manager_secret.patreon_creator_refresh_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web.email}"
}
