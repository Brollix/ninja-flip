resource "google_cloud_run_v2_service" "web" {
  depends_on          = [google_project_service.this]
  project             = var.project_id
  name                = "${var.app_name}-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # es el sitio público
  deletion_protection = false

  template {
    service_account = google_service_account.web.email
    # "report" (server-to-server, ver cloud_run_report.tf) puede tardar
    # hasta 540s en un usuario nuevo sin nada cacheado — sin esto, "web"
    # corta la request a los 300s (default de Cloud Run) ANTES de que
    # "report" termine, y el usuario nuevo ve un timeout en su primer
    # /api/report aunque el trabajo de fondo hubiera terminado bien.
    timeout = "600s"

    # Scale to zero: an always-on instance costs ~$7-10/month even idle, and
    # the Node server starts in about a second (with the startup CPU boost
    # below), so the occasional cold start is cheaper than paying 24/7.
    # The max caps the bill if someone hammers the public URL.
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.web_image
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "REPORT_SERVICE_URL"
        value = google_cloud_run_v2_service.report.uri
      }
      # Patreon premium (see server/src/routes/premium.ts) — real per-user
      # OAuth ("Connect with Patreon"): PATREON_REDIRECT_URI must be EXACTLY
      # the URL registered as the Client's "Redirect URIs" in the Patreon
      # Developer Portal. Hardcoded on purpose: referencing
      # google_cloud_run_v2_service.web.uri from inside this same resource
      # would be a circular dependency. Uses Cloud Run's deterministic URL
      # (<service>-<project number>.<region>.run.app), so it's known before
      # the service exists. Not secret (anyone sees it in the address bar),
      # hence a plain env and not Secret Manager. If the domain changes
      # (e.g. buying ninjaflip.com), update it here AND in Patreon.
      env {
        name  = "PATREON_REDIRECT_URI"
        value = "https://warframe-plat-trader-web-179508033489.us-east1.run.app/api/patreon/callback"
      }
      # Cloud Run refuses a revision that references a secret with no
      # version, so these are only wired once the Patreon values exist
      # (var.patreon_enabled). Without them /api/patreon answers "not
      # configured" and the rest of the site works.
      dynamic "env" {
        for_each = var.patreon_enabled ? {
          PATREON_CLIENT_ID             = google_secret_manager_secret.patreon_client_id.secret_id
          PATREON_CLIENT_SECRET         = google_secret_manager_secret.patreon_client_secret.secret_id
          PATREON_CREATOR_ACCESS_TOKEN  = google_secret_manager_secret.patreon_creator_access_token.secret_id
          PATREON_CREATOR_REFRESH_TOKEN = google_secret_manager_secret.patreon_creator_refresh_token.secret_id
        } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
        # Request-based billing: CPU is only charged while serving a request.
        # Nothing here runs in the background (no websockets, no work outside
        # a request), so "CPU always allocated" would be pure extra cost.
        cpu_idle          = true
        startup_cpu_boost = true
      }
    }
  }
}

# El sitio es público — cualquiera con el link entra (la identidad/scoping
# de datos la hace requireWfmUser adentro, no esto).
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
