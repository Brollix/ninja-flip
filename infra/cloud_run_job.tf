resource "google_cloud_run_v2_job" "flip_scanner" {
  depends_on          = [google_project_service.this]
  project             = var.project_id
  name                = "${var.app_name}-flip-scanner"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.scanner.email
      timeout         = "600s" # refresco rápido (~1-2 min) + margen; --full no corre acá
      max_retries     = 1

      containers {
        image   = var.scanner_image
        command = ["python", "flips.py"]
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

# Solo la cuenta de Scheduler puede arrancar este Job.
resource "google_cloud_run_v2_job_iam_member" "scanner_invoker_scheduler" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.flip_scanner.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
