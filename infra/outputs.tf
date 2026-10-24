output "vpc_id" {
  description = "VPC ID"
  value       = module.networking.vpc_id
}

output "alb_dns_name" {
  description = "ALB DNS name for the backend API"
  value       = module.ecs.alb_dns_name
}

output "frontend_url" {
  description = "CloudFront URL for the frontend"
  value       = "https://${module.cloudfront.distribution_domain_name}"
}

output "task_results_bucket" {
  description = "S3 bucket name for task result files"
  value       = module.s3.task_results_bucket_name
}

output "redis_backups_bucket" {
  description = "S3 bucket name for Redis backups"
  value       = module.s3.redis_backups_bucket_name
}

output "database_backups_bucket" {
  description = "S3 bucket name for SQLite database backups (90-day retention)"
  value       = module.s3.database_backups_bucket_name
}

output "backup_verification_bucket" {
  description = "Isolated S3 bucket for weekly synthetic backup verification artifacts"
  value       = module.s3.backup_verification_bucket_name
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = module.rds.db_endpoint
  sensitive   = true
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs.cluster_name
}
