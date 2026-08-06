# Job "report-warmer": precalienta el cache de reportes (user_reports) de
# TODOS los usuarios con AlecaFrame conectado, cada 10 min — así nadie
# encuentra nunca un cache frío al entrar (antes: esperar ~6min on-demand,
# bajando datos de ~449 items, cada vez que el TTL de 15/25min vencía).
# Misma imagen que el servicio "report" (scripts/warm_reports.py ya vive en
# scripts/, que ya se copia entero en scripts/Dockerfile.report) — solo
# cambia el comando, no hace falta una imagen aparte.
resource "google_cloud_run_v2_job" "report_warmer" {
  depends_on          = [google_project_service.this]
  project             = var.project_id
  name                = "${var.app_name}-report-warmer"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.report.email
      # todos los usuarios, uno por uno — con pocos usuarios entra cómodo en
      # 10 min; si crece mucho, paralelizar warm_reports.py antes que subir esto.
      timeout     = "3600s"
      max_retries = 0

      containers {
        image   = var.report_image
        command = ["python", "warm_reports.py"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_job_iam_member" "report_warmer_invoker_scheduler" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.report_warmer.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
