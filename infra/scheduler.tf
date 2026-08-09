# Dispara el Job flip-scanner cada 15 min pegándole a la Cloud Run Admin API
# (POST .../jobs/{job}:run), autenticado con un access token OAuth2 de la
# cuenta de servicio "scheduler" — es el patrón documentado de GCP para
# correr Cloud Run Jobs con Cloud Scheduler (la Admin API espera un Bearer
# OAuth normal, no un ID token OIDC como los servicios).
# Antes cada 10 min — para un puñado de usuarios, spreads/liquidez no
# necesitan frescura de menos de 15 min, y esto corta ~1/3 los requests
# contra warframe.market. */15 sigue cayendo en :00/:30 (compatible con
# PARTS_INTERVAL_MIN=30 en flips.py).
resource "google_cloud_scheduler_job" "flip_scanner_trigger" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  region     = var.region
  name       = "${var.app_name}-flip-scanner-trigger"
  schedule   = "*/15 * * * *"
  time_zone  = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.flip_scanner.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

# Precalienta el cache de reportes cada 20 min (ver cloud_run_report_warmer.tf)
# — mismo patrón que el trigger de arriba, apuntando al Job "report-warmer".
# Antes cada 10 min: para un puñado de usuarios re-bajar el historial de
# AlecaFrame de TODOS los conectados 6 veces por hora era de más — 3 veces
# por hora sigue dejando el cache fresco de sobra para datos de trading.
resource "google_cloud_scheduler_job" "report_warmer_trigger" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  region     = var.region
  name       = "${var.app_name}-report-warmer-trigger"
  schedule   = "*/20 * * * *"
  time_zone  = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.report_warmer.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}
