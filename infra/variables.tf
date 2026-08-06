variable "project_id" {
  description = "GCP project ID (el técnico, no el nombre lindo — 'gcloud projects list')"
  type        = string
}

variable "region" {
  description = "Región de GCP para todo (Cloud Run, Scheduler, Artifact Registry)"
  type        = string
  default     = "us-east1"
}

variable "app_name" {
  description = "Prefijo para nombrar los recursos"
  type        = string
  default     = "warframe-plat-trader"
}

# Imágenes: se completan después del primer build+push a Artifact Registry
# (docker build + docker push, ver README de infra/). Con default vacío,
# el primer "terraform apply" crea todo lo demás y falla lindo en el Cloud
# Run si no se las pasás — subís las imágenes y corrés apply de nuevo.
variable "web_image" {
  description = "Imagen completa (Artifact Registry) del servicio web (server/Dockerfile)"
  type        = string
}

variable "report_image" {
  description = "Imagen completa del servicio report (scripts/Dockerfile.report)"
  type        = string
}

variable "scanner_image" {
  description = "Imagen completa del Job flip-scanner (scripts/Dockerfile.scanner)"
  type        = string
}

variable "report_ttl_seconds" {
  description = "TTL del cache de reporte por usuario (user_reports)"
  type        = number
  default     = 900
}
