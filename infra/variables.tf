variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (staging | production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "backend_image" {
  description = "Docker image URI for the backend service (ECR or Docker Hub)"
  type        = string
}

variable "backend_cpu" {
  description = "CPU units for the backend ECS task (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "Memory (MiB) for the backend ECS task"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired number of ECS backend tasks"
  type        = number
  default     = 1
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_name" {
  description = "Name of the PostgreSQL database"
  type        = string
  default     = "ainet"
}

variable "db_username" {
  description = "Master username for the RDS instance"
  type        = string
  default     = "ainet_admin"
}

variable "domain_name" {
  description = "Primary domain name (e.g. ai-net.example.com)"
  type        = string
  default     = ""
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for domain_name"
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (us-east-1) for CloudFront HTTPS"
  type        = string
  default     = ""
}
