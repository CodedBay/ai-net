terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    archive = {
      source = "hashicorp/archive"
    }
  }
}

# ── Secrets Manager ───────────────────────────────────────────────────────────
# Placeholders – values are set via the AWS Console or rotation lambdas.
# Do NOT store real values in Terraform code or state.

locals {
  secrets = {
    venice_api_key              = "Venice AI API key for LLM inference"
    jwt_secret                  = "JWT signing secret; rotated automatically every 90 days"
    stellar_coordinator_secret  = "Stellar coordinator hot-wallet secret key"
    admin_api_key               = "Admin API key for protected backend endpoints"
    redis_url                   = "Redis connection URL including credentials"
    db_password                 = "RDS master password (managed separately; stored here for app reference)"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.secrets

  name        = "ai-net/${var.environment}/${each.key}"
  description = each.value

  # Real values are populated through AWS or the secret rotation workflow.
  recovery_window_in_days = var.environment == "production" ? 30 : 7

  tags = { Name = "ai-net-${var.environment}-${each.key}" }
}

# Placeholder versions – real values must be populated before deploying ECS tasks.
# Use: aws secretsmanager put-secret-value --secret-id <arn> --secret-string '<value>'
resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.secrets

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = "PLACEHOLDER_REPLACE_BEFORE_DEPLOY"

  lifecycle {
    # Prevent Terraform from overwriting values set externally (e.g., via rotation).
    ignore_changes = [secret_string]
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_secretsmanager_secret" "slack_webhook" {
  name                    = "ai-net/${var.environment}/slack_webhook_url"
  description             = "Slack incoming webhook for secret rotation notifications"
  recovery_window_in_days = 7
}

data "archive_file" "rotation_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.root}/.terraform/ai-net-secrets-rotation.zip"
}

resource "aws_iam_role" "rotation_lambda" {
  name = "ai-net-${var.environment}-secrets-rotation"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "rotation_lambda" {
  role = aws_iam_role.rotation_lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecretVersionStage",
        ]
        Resource = [aws_secretsmanager_secret.app["jwt_secret"].arn]
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.slack_webhook.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = ["arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/ai-net-${var.environment}/ai-net-${var.environment}-backend"]
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
      },
    ]
  })
}

resource "aws_lambda_function" "rotation" {
  function_name    = "ai-net-${var.environment}-secrets-rotation"
  role             = aws_iam_role.rotation_lambda.arn
  filename         = data.archive_file.rotation_lambda.output_path
  source_code_hash = data.archive_file.rotation_lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 900

  environment {
    variables = {
      ECS_CLUSTER_NAME         = "ai-net-${var.environment}"
      ECS_SERVICE_NAME         = "ai-net-${var.environment}-backend"
      SLACK_WEBHOOK_SECRET_ARN = aws_secretsmanager_secret.slack_webhook.arn
      ENVIRONMENT              = var.environment
    }
  }
}

resource "aws_cloudwatch_log_group" "rotation_lambda" {
  name              = "/aws/lambda/${aws_lambda_function.rotation.function_name}"
  retention_in_days = 90
}

resource "aws_lambda_permission" "allow_secrets_manager_jwt" {
  statement_id  = "AllowSecretsManagerJwtRotation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rotation.function_name
  principal     = "secretsmanager.amazonaws.com"
  source_arn    = aws_secretsmanager_secret.app["jwt_secret"].arn
}

resource "aws_secretsmanager_secret_rotation" "jwt_secret" {
  secret_id           = aws_secretsmanager_secret.app["jwt_secret"].id
  rotation_lambda_arn = aws_lambda_function.rotation.arn

  rotation_rules {
    schedule_expression = "rate(90 days)"
  }

  depends_on = [aws_lambda_permission.allow_secrets_manager_jwt]
}

resource "aws_cloudwatch_event_rule" "venice_rotation_reminder" {
  name                = "ai-net-${var.environment}-venice-rotation-reminder"
  description         = "Quarterly reminder to rotate the Venice API key manually"
  schedule_expression = "rate(90 days)"
}

resource "aws_cloudwatch_event_target" "venice_rotation_reminder" {
  rule      = aws_cloudwatch_event_rule.venice_rotation_reminder.name
  target_id = "venice-rotation-reminder"
  arn       = aws_lambda_function.rotation.arn
  input     = jsonencode({ action = "manual_rotation_reminder" })
}

resource "aws_lambda_permission" "allow_venice_reminder" {
  statement_id  = "AllowVeniceRotationReminder"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rotation.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.venice_rotation_reminder.arn
}

resource "aws_s3_bucket" "secrets_audit" {
  bucket        = "ai-net-${var.environment}-secrets-audit-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "secrets_audit" {
  bucket                  = aws_s3_bucket.secrets_audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "secrets_audit" {
  bucket = aws_s3_bucket.secrets_audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "secrets_audit_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.secrets_audit.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.secrets_audit.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "secrets_audit" {
  bucket = aws_s3_bucket.secrets_audit.id
  policy = data.aws_iam_policy_document.secrets_audit_bucket.json
}

resource "aws_cloudtrail" "secrets_audit" {
  name                          = "ai-net-${var.environment}-secrets-audit"
  s3_bucket_name                = aws_s3_bucket.secrets_audit.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.secrets_audit]
}
