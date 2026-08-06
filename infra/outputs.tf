output "web_url" {
  description = "URL pública del sitio"
  value       = google_cloud_run_v2_service.web.uri
}

output "report_url" {
  description = "URL interna del servicio report (no pública)"
  value       = google_cloud_run_v2_service.report.uri
}

output "artifact_registry_repo" {
  description = "Repo de Docker — pushear acá: <region>-docker.pkg.dev/<project>/<repo>/<image>"
  value       = google_artifact_registry_repository.images.name
}

output "github_actions_workload_identity_provider" {
  description = "Pegar en el step google-github-actions/auth de .github/workflows/deploy.yml (workload_identity_provider)"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_actions_service_account" {
  description = "Pegar en el step google-github-actions/auth de .github/workflows/deploy.yml (service_account)"
  value       = google_service_account.github_deployer.email
}
