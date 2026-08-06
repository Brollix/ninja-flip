# Identidades separadas por principio de mínimo privilegio: "report" no
# necesita ser invocable públicamente (solo "web" le pega, server-to-server),
# y "scheduler" solo necesita permiso para arrancar el Job, nada más.

resource "google_service_account" "web" {
  account_id   = "${var.app_name}-web"
  display_name = "${var.app_name} — Cloud Run service web (frontend + API)"
}

resource "google_service_account" "report" {
  account_id   = "${var.app_name}-report"
  display_name = "${var.app_name} — Cloud Run service report (relic_analysis.py)"
}

resource "google_service_account" "scanner" {
  account_id   = "${var.app_name}-scanner"
  display_name = "${var.app_name} — Cloud Run Job flip-scanner (flips.py)"
}

resource "google_service_account" "scheduler" {
  account_id   = "${var.app_name}-scheduler"
  display_name = "${var.app_name} — Cloud Scheduler, dispara el Job flip-scanner"
}
