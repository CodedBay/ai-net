variable "environment"    { type = string }
variable "aws_region"     { type = string }
variable "account_id"     { type = string }
variable "s3_bucket_arns" { type = list(string) }
variable "secrets_arns"   { type = list(string) }
