# ai-net Infrastructure (Terraform)

This directory contains all Terraform code for deploying ai-net to AWS.
Two workspaces are used — **staging** and **production** — with separate
variable files and a shared module tree.

---

## Directory Layout

```
infra/
├── bootstrap/          # One-time setup: S3 state bucket + DynamoDB lock table
├── modules/
│   ├── networking/     # VPC, subnets, NAT, security groups
│   ├── ecs/            # ECS Fargate cluster + ALB + task definition + service
│   ├── rds/            # PostgreSQL (RDS)
│   ├── s3/             # Task results, Redis backups, frontend static assets
│   ├── cloudfront/     # CloudFront CDN for frontend
│   ├── route53/        # DNS records (optional)
│   ├── iam/            # Least-privilege roles for ECS tasks and GitHub Actions
│   ├── secrets/        # AWS Secrets Manager secret definitions
│   └── logging/        # CloudWatch log groups, metric filters, alarms
├── main.tf             # Root module — wires all modules together
├── variables.tf        # Input variable declarations
├── outputs.tf          # Exported values (ALB DNS, S3 buckets, etc.)
├── staging.tfvars      # Staging workspace overrides
└── production.tfvars   # Production workspace overrides
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| [Terraform](https://developer.hashicorp.com/terraform/install) | ≥ 1.6 |
| [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | ≥ 2.x |
| AWS credentials | `AdministratorAccess` for initial apply, least-privilege after |

---

## Step 1 — Bootstrap remote state (one-time)

The S3 bucket and DynamoDB lock table must exist before the main workspace
can use the remote backend.

```bash
cd infra/bootstrap
terraform init
terraform apply
# Note the outputs: state_bucket and lock_table_name
```

---

## Step 2 — Configure the backend

The `main.tf` backend block is already configured:

```hcl
backend "s3" {
  bucket         = "ai-net-tfstate"
  key            = "ai-net/terraform.tfstate"
  region         = "us-east-1"
  encrypt        = true
  dynamodb_table = "ai-net-tfstate-lock"
}
```

If your bucket name differs, update it before running `terraform init`.

---

## Step 3 — Populate secrets

Before applying, set the real secret values in AWS Secrets Manager.
Terraform creates placeholder versions; overwrite them:

```bash
# Replace each secret with the real value:
aws secretsmanager put-secret-value \
  --secret-id "ai-net/staging/venice_api_key" \
  --secret-string "sk-..."

aws secretsmanager put-secret-value \
  --secret-id "ai-net/staging/stellar_coordinator_secret" \
  --secret-string "SBXXX..."

aws secretsmanager put-secret-value \
  --secret-id "ai-net/staging/admin_api_key" \
  --secret-string "your-admin-key"

aws secretsmanager put-secret-value \
  --secret-id "ai-net/staging/redis_url" \
  --secret-string "redis://user:password@host:6379"
```

---

## Step 4 — Initialise and select workspace

```bash
cd infra
terraform init

# Staging
terraform workspace new staging   # first time only
terraform workspace select staging

# Production
terraform workspace new production  # first time only
terraform workspace select production
```

---

## Step 5 — Plan

```bash
# Staging
terraform workspace select staging
terraform plan -var-file=staging.tfvars \
  -var="backend_image=<ECR_IMAGE_URI>"

# Production
terraform workspace select production
terraform plan -var-file=production.tfvars \
  -var="backend_image=<ECR_IMAGE_URI>"
```

The plan output must show **no unexpected destroys** before applying.

---

## Step 6 — Apply

```bash
# Staging
terraform workspace select staging
terraform apply -var-file=staging.tfvars \
  -var="backend_image=<ECR_IMAGE_URI>"

# Production
terraform workspace select production
terraform apply -var-file=production.tfvars \
  -var="backend_image=<ECR_IMAGE_URI>"
```

---

## Required Variables

| Variable | Description | Required |
|---|---|---|
| `environment` | `staging` or `production` | ✅ |
| `backend_image` | Docker image URI (ECR) | ✅ |
| `aws_region` | AWS region | default `us-east-1` |
| `vpc_cidr` | VPC CIDR block | default `10.0.0.0/16` |
| `domain_name` | Custom domain (e.g. `ai-net.example.com`) | optional |
| `hosted_zone_id` | Route53 hosted zone ID | optional |
| `acm_certificate_arn` | ACM certificate ARN (us-east-1) for HTTPS | optional |
| `db_instance_class` | RDS instance class | default `db.t3.micro` |
| `desired_count` | Number of backend ECS tasks | default `1` |

Variables without defaults **must** be supplied via a `.tfvars` file or
`TF_VAR_*` environment variables.

---

## Passing Sensitive Vars via Environment Variables

Never commit real values to `.tfvars` files. Use environment variables:

```bash
export TF_VAR_backend_image="123456789012.dkr.ecr.us-east-1.amazonaws.com/ai-net-backend:v1.2.3"
export TF_VAR_domain_name="ai-net.example.com"
export TF_VAR_hosted_zone_id="Z1234567890ABC"
export TF_VAR_acm_certificate_arn="arn:aws:acm:us-east-1:..."
```

---

## Remote State

State is stored in S3 with DynamoDB locking. Multiple engineers can apply
simultaneously without conflicts:

```
s3://ai-net-tfstate/ai-net/terraform.tfstate   (workspace: staging)
s3://ai-net-tfstate/ai-net/terraform.tfstate   (workspace: production)
```

Workspace-isolated state keys are managed by Terraform automatically when
you switch workspaces.

---

## CI/CD Deployment

GitHub Actions uses OIDC to assume the `ai-net-{env}-github-actions-deploy`
IAM role (created by the `iam` module). No long-lived AWS credentials are
stored in GitHub Secrets. See `.github/workflows/release.yml` for the
deployment workflow.

---

## Destroy

```bash
# Staging only — confirm at the interactive prompt
terraform workspace select staging
terraform destroy -var-file=staging.tfvars -var="backend_image=placeholder"
```

⚠️ **Never run `terraform destroy` on production without a full team review.**
