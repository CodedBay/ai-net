# ── ECS Cluster ───────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "ai-net-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "ai-net-${var.environment}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ── ALB ───────────────────────────────────────────────────────────────────────

resource "aws_lb" "backend" {
  name               = "ai-net-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.environment == "production"

  tags = { Name = "ai-net-${var.environment}-alb" }
}

resource "aws_lb_target_group" "backend" {
  name        = "ai-net-${var.environment}-backend"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "ai-net-${var.environment}-backend-tg" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.backend.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.backend.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ── ECS Task Definition ───────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "backend" {
  family                   = "ai-net-${var.environment}-backend"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  task_role_arn            = var.task_role_arn
  execution_role_arn       = var.execution_role_arn

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image
    essential = true

    portMappings = [{
      containerPort = 3001
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment == "production" ? "production" : "staging" },
      { name = "PORT", value = "3001" },
    ]

    secrets = [for arn in var.secrets_arns : {
      name = split("/", arn)[length(split("/", arn)) - 1] == "jwt_secret" ? "AUTH_JWT_SECRET" : (
        split("/", arn)[length(split("/", arn)) - 1] == "venice_api_key" ? "VENICE_API_KEY" :
        split("/", arn)[length(split("/", arn)) - 1]
      )
      valueFrom = arn
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.log_group_name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "backend"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])

  tags = { Name = "ai-net-${var.environment}-backend-task" }
}

# ── ECS Service ───────────────────────────────────────────────────────────────

resource "aws_ecs_service" "backend" {
  name                               = "ai-net-${var.environment}-backend"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.backend.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  health_check_grace_period_seconds  = 60

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.backend_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 3001
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_controller {
    type = "ECS"
  }

  tags = { Name = "ai-net-${var.environment}-backend-service" }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
