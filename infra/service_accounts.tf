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

# CI (GitHub Actions, push a master): build+push de las 3 imágenes y deploy
# a los servicios/Jobs ya existentes. Ver github_actions.tf para los permisos
# concretos — nada de esto puede crear/borrar infra (eso sigue siendo
# terraform apply a mano), solo actualizar la imagen de lo que ya está creado.
resource "google_service_account" "github_deployer" {
  # account_id tiene un tope de 30 caracteres — "${var.app_name}-github-deployer"
  # (37) se pasa, por eso el nombre corto acá en vez de seguir el patrón
  # "${var.app_name}-<rol>" del resto de este archivo.
  account_id   = "${var.app_name}-deployer"
  display_name = "${var.app_name} — GitHub Actions, deploy en push a master"
}
