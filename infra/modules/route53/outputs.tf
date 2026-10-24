output "api_fqdn"      { value = length(aws_route53_record.api) > 0 ? aws_route53_record.api[0].fqdn : "" }
output "frontend_fqdn" { value = length(aws_route53_record.frontend) > 0 ? aws_route53_record.frontend[0].fqdn : "" }
