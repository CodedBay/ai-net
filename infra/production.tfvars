# Production workspace variable overrides.
# Apply with: terraform workspace select production && terraform apply -var-file=production.tfvars

environment     = "production"
aws_region      = "us-east-1"
vpc_cidr        = "10.2.0.0/16"
backend_cpu     = 1024
backend_memory  = 2048
desired_count   = 2
db_instance_class = "db.t3.small"
db_name         = "ainet_production"
db_username     = "ainet_prod"

# Override these with real values or pass via TF_VAR_* env vars:
# backend_image       = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ai-net-backend:latest"
# domain_name         = "ai-net.example.com"
# hosted_zone_id      = "Z1234567890"
# acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/..."
