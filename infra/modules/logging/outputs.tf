output "backend_log_group_name"        { value = aws_cloudwatch_log_group.backend.name }
output "backend_errors_log_group_name" { value = aws_cloudwatch_log_group.backend_errors.name }
