resource "google_artifact_registry_repository" "images" {
  depends_on    = [google_project_service.this]
  project       = var.project_id
  location      = var.region
  repository_id = var.app_name
  format        = "DOCKER"
  description   = "${var.app_name} images: web, report, flip-scanner"

  # Every push to master adds a new image per changed service. Only 0.5 GB
  # of storage is free, so keep the last few versions (enough to roll back)
  # and let the rest be deleted.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 3
    }
  }
  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    condition {
      older_than = "604800s"
    }
  }
}
