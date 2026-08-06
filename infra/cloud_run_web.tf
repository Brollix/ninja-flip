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

    # minScale=0 (default) apaga el container entero cuando nadie lo usa —
    # la próxima visita paga un cold start completo antes de responder algo.
    # Con pocos usuarios (vos + amigos) eso es "tarda como 5-10s en cargar
    # de la nada" bastante seguido. 1 instancia siempre viva lo evita.
    scaling {
      min_instance_count = 1
      max_instance_count = 20
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
      # Premium por Patreon (ver server/src/routes/premium.ts) — OAuth real por
      # usuario ("Connect with Patreon"): PATREON_REDIRECT_URI tiene que ser
      # EXACTAMENTE la misma URL registrada en el Developer Portal de Patreon
      # como "Redirect URIs" del Client (hardcodeada a propósito: referenciar
      # google_cloud_run_v2_service.web.uri desde adentro de este mismo
      # recurso sería una dependencia circular). No es secreta (es pública,
      # la ve cualquiera en la barra de direcciones), por eso va como env
      # plano y no como Secret Manager. Si el dominio cambia (ver el punto
      # pendiente de comprar ninjaflip.com), actualizar acá Y en el Redirect
      # URI del Client en Patreon.
      env {
        name  = "PATREON_REDIRECT_URI"
        value = "https://warframe-plat-trader-web-qptpzf6lka-ue.a.run.app/api/patreon/callback"
      }
      env {
        name = "PATREON_CLIENT_ID"
        value_source {
          secret_key_ref { secret = google_secret_manager_secret.patreon_client_id.secret_id, version = "latest" }
        }
      }
      env {
        name = "PATREON_CLIENT_SECRET"
        value_source {
          secret_key_ref { secret = google_secret_manager_secret.patreon_client_secret.secret_id, version = "latest" }
        }
      }
      env {
        name = "PATREON_CREATOR_ACCESS_TOKEN"
        value_source {
          secret_key_ref { secret = google_secret_manager_secret.patreon_creator_access_token.secret_id, version = "latest" }
        }
      }
      env {
        name = "PATREON_CREATOR_REFRESH_TOKEN"
        value_source {
          secret_key_ref { secret = google_secret_manager_secret.patreon_creator_refresh_token.secret_id, version = "latest" }
        }
      }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        # cpu_idle=true (default) = la CPU solo se cobra mientras atiende un
        # request, no las 24hs que la instancia queda viva por min_instance_count.
        # Sin esto (cpu_idle=false, "CPU siempre asignada") el costo idle de
        # esta única instancia salía ~$60-65/mes de más sin ningún beneficio
        # real — no corremos nada en background (sin websockets, sin threads
        # fuera de un request) que lo justifique.
        cpu_idle = true
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
