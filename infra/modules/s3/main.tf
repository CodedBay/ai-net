# ── Task Results Bucket ───────────────────────────────────────────────────────

resource "aws_s3_bucket" "task_results" {
  bucket = "ai-net-${var.environment}-task-results-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "ai-net-${var.environment}-task-results" }
}

resource "aws_s3_bucket_versioning" "task_results" {
  bucket = aws_s3_bucket.task_results.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "task_results" {
  bucket = aws_s3_bucket.task_results.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "task_results" {
  bucket                  = aws_s3_bucket.task_results.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "task_results" {
  bucket = aws_s3_bucket.task_results.id

  rule {
    id     = "expire-old-results"
    status = "Enabled"
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# ── Redis Backups Bucket ──────────────────────────────────────────────────────

resource "aws_s3_bucket" "redis_backups" {
  bucket = "ai-net-${var.environment}-redis-backups-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "ai-net-${var.environment}-redis-backups" }
}

resource "aws_s3_bucket_versioning" "redis_backups" {
  bucket = aws_s3_bucket.redis_backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "redis_backups" {
  bucket = aws_s3_bucket.redis_backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "redis_backups" {
  bucket                  = aws_s3_bucket.redis_backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "redis_backups" {
  bucket = aws_s3_bucket.redis_backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    expiration { days = 30 }
  }
}

# ── SQLite Database Backups ───────────────────────────────────────────────────

resource "aws_s3_bucket" "database_backups" {
  bucket = "ai-net-${var.environment}-database-backups-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "ai-net-${var.environment}-database-backups" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "database_backups" {
  bucket = aws_s3_bucket.database_backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "database_backups" {
  bucket                  = aws_s3_bucket.database_backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "database_backups" {
  bucket = aws_s3_bucket.database_backups.id

  rule {
    id     = "expire-verified-database-backups"
    status = "Enabled"
    expiration { days = 90 }
  }
}

resource "aws_s3_bucket" "backup_verification" {
  bucket = "ai-net-${var.environment}-backup-verification-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "ai-net-${var.environment}-backup-verification" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup_verification" {
  bucket = aws_s3_bucket.backup_verification.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backup_verification" {
  bucket                  = aws_s3_bucket.backup_verification.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backup_verification" {
  bucket = aws_s3_bucket.backup_verification.id

  rule {
    id     = "expire-verification-fixtures"
    status = "Enabled"
    expiration { days = 90 }
  }
}

# ── Frontend Static Assets Bucket ────────────────────────────────────────────

resource "aws_s3_bucket" "frontend" {
  bucket = "ai-net-${var.environment}-frontend-${data.aws_caller_identity.current.account_id}"

  tags = { Name = "ai-net-${var.environment}-frontend" }
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_caller_identity" "current" {}
