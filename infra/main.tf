terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Remote state in S3 with DynamoDB locking.
  # Bucket and table are created by infra/bootstrap/ before first apply.
  backend "s3" {
    bucket         = "ai-net-tfstate"
    key            = "ai-net/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "ai-net-tfstate-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ai-net"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ── Modules ──────────────────────────────────────────────────────────────────

module "networking" {
  source      = "./modules/networking"
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  aws_region  = var.aws_region
}

module "ecs" {
  source             = "./modules/ecs"
  environment        = var.environment
  aws_region         = var.aws_region
  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids
  public_subnet_ids  = module.networking.public_subnet_ids
  backend_sg_id      = module.networking.backend_sg_id
  alb_sg_id          = module.networking.alb_sg_id
  backend_image      = var.backend_image
  backend_cpu        = var.backend_cpu
  backend_memory     = var.backend_memory
  desired_count      = var.desired_count
  task_role_arn      = module.iam.ecs_task_role_arn
  execution_role_arn = module.iam.ecs_execution_role_arn
  secrets_arns       = module.secrets.secret_arns
  log_group_name     = module.logging.backend_log_group_name
}

module "rds" {
  source             = "./modules/rds"
  environment        = var.environment
  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids
  db_sg_id           = module.networking.db_sg_id
  db_instance_class  = var.db_instance_class
  db_name            = var.db_name
  db_username        = var.db_username
}

module "s3" {
  source      = "./modules/s3"
  environment = var.environment
  aws_region  = var.aws_region
}

module "cloudfront" {
  source               = "./modules/cloudfront"
  environment          = var.environment
  frontend_bucket_name = module.s3.frontend_bucket_name
  frontend_bucket_arn  = module.s3.frontend_bucket_arn
  frontend_bucket_domain = module.s3.frontend_bucket_domain
  acm_certificate_arn  = var.acm_certificate_arn
  domain_name          = var.domain_name
}

module "route53" {
  source              = "./modules/route53"
  environment         = var.environment
  domain_name         = var.domain_name
  hosted_zone_id      = var.hosted_zone_id
  alb_dns_name        = module.ecs.alb_dns_name
  alb_zone_id         = module.ecs.alb_zone_id
  cloudfront_domain   = module.cloudfront.distribution_domain_name
  cloudfront_zone_id  = module.cloudfront.distribution_hosted_zone_id
}

module "iam" {
  source      = "./modules/iam"
  environment = var.environment
  aws_region  = var.aws_region
  account_id  = data.aws_caller_identity.current.account_id
  s3_bucket_arns = [
    module.s3.task_results_bucket_arn,
    module.s3.redis_backups_bucket_arn,
    module.s3.database_backups_bucket_arn,
  ]
  secrets_arns = module.secrets.secret_arns
}

module "secrets" {
  source      = "./modules/secrets"
  environment = var.environment
}

module "logging" {
  source             = "./modules/logging"
  environment        = var.environment
  archive_bucket_name = module.s3.log_archive_bucket_name
  archive_bucket_arn  = module.s3.log_archive_bucket_arn
}

# ── Data sources ──────────────────────────────────────────────────────────────

data "aws_caller_identity" "current" {}
