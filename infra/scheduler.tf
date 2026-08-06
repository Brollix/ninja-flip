# Dispara el Job flip-scanner cada 10 min pegándole a la Cloud Run Admin API
# (POST .../jobs/{job}:run), autenticado con un access token OAuth2 de la
# cuenta de servicio "scheduler" — es el patrón documentado de GCP para
# correr Cloud Run Jobs con Cloud Scheduler (la Admin API espera un Bearer
# OAuth normal, no un ID token OIDC como los servicios).
resource "google_cloud_scheduler_job" "flip_scanner_trigger" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  region     = var.region
  name       = "${var.app_name}-flip-scanner-trigger"
  schedule   = "*/10 * * * *"
  time_zone  = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.flip_scanner.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

# Precalienta el cache de reportes cada 10 min (ver cloud_run_report_warmer.tf)
# — mismo patrón que el trigger de arriba, apuntando al Job "report-warmer".
resource "google_cloud_scheduler_job" "report_warmer_trigger" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  region     = var.region
  name       = "${var.app_name}-report-warmer-trigger"
  schedule   = "*/10 * * * *"
  time_zone  = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.report_warmer.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}
