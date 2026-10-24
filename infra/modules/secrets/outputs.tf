output "secret_arns" {
  value       = [for s in aws_secretsmanager_secret.app : s.arn]
  description = "ARNs of all application secrets"
}

output "rotation_lambda_arn" {
  value       = aws_lambda_function.rotation.arn
  description = "ARN of the secret rotation Lambda"
}

output "cloudtrail_arn" {
  value       = aws_cloudtrail.secrets_audit.arn
  description = "ARN of the CloudTrail audit trail for secret rotation"
}
