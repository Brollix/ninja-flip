resource "google_cloud_run_v2_service" "report" {
  depends_on = [google_project_service.this]
  project    = var.project_id
  name       = "${var.app_name}-report"
  location   = var.region
  # INTERNAL_ONLY rebota con 404 a nivel de red las llamadas de "web" (van
  # por la URL pública .run.app, no por la red interna de verdad) — la
  # protección real es el IAM invoker de abajo, no el ingress. Patrón
  # documentado por Google para server-to-server en Cloud Run.
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.report.email
    # relic_analysis.py hace varios requests secuenciales por item (rate
    # limit propio) — puede tardar más que el timeout default de 5min en un
    # usuario nuevo sin nada cacheado todavía.
    timeout = "540s"

    # Only "web" calls this service, so it scales to zero like web does; an
    # always-on instance used to cost ~$10-13/month for no real benefit.
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.report_image
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
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }
}

# Nadie público, ni siquiera con el link — solo la cuenta de servicio de "web"
# puede invocar este servicio (llamada interna server-to-server).
resource "google_cloud_run_v2_service_iam_member" "report_invoker_web" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.report.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.web.email}"
}
