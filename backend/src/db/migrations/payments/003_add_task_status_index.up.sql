CREATE INDEX IF NOT EXISTS idx_payments_task_status
  ON payments (taskId, status);
