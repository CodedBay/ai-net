# ── DB Subnet Group ───────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "main" {
  name       = "ai-net-${var.environment}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = { Name = "ai-net-${var.environment}-db-subnet-group" }
}

# ── RDS PostgreSQL ────────────────────────────────────────────────────────────
# Production equivalent of the SQLite-backed local dev setup.
# Credentials are managed via AWS Secrets Manager (see modules/secrets).

resource "aws_db_instance" "main" {
  identifier     = "ai-net-${var.environment}-postgres"
  engine         = "postgres"
  engine_version = "16.3"
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_username

  # Password injected at create time via manage_master_user_password.
  # AWS Secrets Manager stores it; no plaintext in Terraform state.
  manage_master_user_password = true

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  vpc_security_group_ids = [var.db_sg_id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  multi_az               = var.environment == "production"
  publicly_accessible    = false
  deletion_protection    = var.environment == "production"
  skip_final_snapshot    = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "ai-net-${var.environment}-final-snapshot" : null

  backup_retention_period = var.environment == "production" ? 7 : 1
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  performance_insights_enabled          = var.environment == "production"
  performance_insights_retention_period = var.environment == "production" ? 7 : null

  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  tags = { Name = "ai-net-${var.environment}-postgres" }
}
