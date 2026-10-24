# ── CloudWatch Log Groups ──────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ai-net/${var.environment}/backend"
  retention_in_days = 30  # INFO-level retention per issue #116 spec

  tags = { Name = "ai-net-${var.environment}-backend-logs" }
}

resource "aws_cloudwatch_log_group" "backend_errors" {
  name              = "/ai-net/${var.environment}/backend/errors"
  retention_in_days = 30

  tags = { Name = "ai-net-${var.environment}-backend-error-logs" }
}

resource "aws_cloudwatch_log_group" "ecs_agent" {
  name              = "/ai-net/${var.environment}/ecs-agent"
  retention_in_days = 30

  tags = { Name = "ai-net-${var.environment}-ecs-agent-logs" }
}

# ── Metric Filter: ERROR log lines ────────────────────────────────────────────

resource "aws_cloudwatch_log_metric_filter" "backend_errors" {
  name           = "ai-net-${var.environment}-backend-error-count"
  pattern        = "{ $.level = \"error\" }"
  log_group_name = aws_cloudwatch_log_group.backend.name

  metric_transformation {
    name      = "BackendErrorCount"
    namespace = "ai-net/${var.environment}"
    value     = "1"
  }
}

# ── CloudWatch Alarm: high error rate ────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "backend_error_rate" {
  alarm_name          = "ai-net-${var.environment}-backend-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "BackendErrorCount"
  namespace           = "ai-net/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Backend error rate exceeded 10 errors per 5-minute window"
  treat_missing_data  = "notBreaching"

  tags = { Name = "ai-net-${var.environment}-backend-error-alarm" }
}

# ── Monthly CloudWatch export ────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "archive_lambda" {
  name              = "/aws/lambda/ai-net-${var.environment}-daily-log-archive"
  retention_in_days = 30
}

data "archive_file" "archive_logs" {
  type        = "zip"
  source_file = "${path.module}/archive_logs.py"
  output_path = "/tmp/ai-net-${var.environment}-archive-logs.zip"
}

resource "aws_iam_role" "archive_lambda" {
  name = "ai-net-${var.environment}-log-archive-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "archive_lambda" {
  name = "ai-net-${var.environment}-log-archive"
  role = aws_iam_role.archive_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateExportTask", "logs:DescribeExportTasks"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${var.archive_bucket_arn}/cloudwatch/${var.environment}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.archive_lambda.arn}:*"
      }
    ]
  })
}

resource "aws_lambda_function" "archive_logs" {
  function_name    = "ai-net-${var.environment}-daily-log-archive"
  role             = aws_iam_role.archive_lambda.arn
  runtime          = "python3.12"
  handler          = "archive_logs.handler"
  filename         = data.archive_file.archive_logs.output_path
  source_code_hash = data.archive_file.archive_logs.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      ARCHIVE_BUCKET      = var.archive_bucket_name
      LOG_GROUP_PREFIX    = "/ai-net/${var.environment}/"
      ARCHIVE_ENVIRONMENT = var.environment
    }
  }

  depends_on = [aws_cloudwatch_log_group.archive_lambda]
}

resource "aws_cloudwatch_event_rule" "daily_log_archive" {
  name                = "ai-net-${var.environment}-daily-log-archive"
  description         = "Export the previous UTC day of CloudWatch logs before 30-day retention expires."
  schedule_expression = "cron(0 2 * * ? *)"
}

resource "aws_cloudwatch_event_target" "daily_log_archive" {
  rule      = aws_cloudwatch_event_rule.daily_log_archive.name
  target_id = "daily-log-archive"
  arn       = aws_lambda_function.archive_logs.arn
}

resource "aws_lambda_permission" "daily_log_archive" {
  statement_id  = "AllowDailyEventBridgeInvocation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.archive_logs.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily_log_archive.arn
}
