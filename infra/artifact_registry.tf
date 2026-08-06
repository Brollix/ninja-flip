resource "google_artifact_registry_repository" "images" {
  depends_on    = [google_project_service.this]
  project       = var.project_id
  location      = var.region
  repository_id = var.app_name
  format        = "DOCKER"
  description   = "Imágenes de ${var.app_name}: web, report, flip-scanner"
}
