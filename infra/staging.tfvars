# Staging workspace variable overrides.
# Apply with: terraform workspace select staging && terraform apply -var-file=staging.tfvars

environment     = "staging"
aws_region      = "us-east-1"
vpc_cidr        = "10.1.0.0/16"
backend_cpu     = 256
backend_memory  = 512
desired_count   = 1
db_instance_class = "db.t3.micro"
db_name         = "ainet_staging"
db_username     = "ainet_staging"

# Override these with real values or pass via TF_VAR_* env vars:
# backend_image       = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ai-net-backend:latest"
# domain_name         = "staging.ai-net.example.com"
# hosted_zone_id      = "Z1234567890"
# acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/..."
