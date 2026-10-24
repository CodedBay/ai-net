terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31"
    }
  }
  # Bootstrap uses local state — this is intentional.
  # After running `terraform apply` here, the main infra/ workspace
  # switches to the remote backend created by this configuration.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "ai-net"
      ManagedBy = "terraform"
      Purpose   = "terraform-state-backend"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

# ── S3 Bucket for Terraform State ─────────────────────────────────────────────

resource "aws_s3_bucket" "tfstate" {
  bucket = "ai-net-tfstate"

  # Prevent accidental destruction of state bucket
  lifecycle { prevent_destroy = true }

  tags = { Name = "ai-net-tfstate" }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ── DynamoDB Table for State Locking ─────────────────────────────────────────

resource "aws_dynamodb_table" "tfstate_lock" {
  name         = "ai-net-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Prevent accidental deletion
  lifecycle { prevent_destroy = true }

  tags = { Name = "ai-net-tfstate-lock" }
}

output "state_bucket"     { value = aws_s3_bucket.tfstate.bucket }
output "lock_table_name"  { value = aws_dynamodb_table.tfstate_lock.name }
