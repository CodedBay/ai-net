CREATE INDEX IF NOT EXISTS idx_agents_status_capabilities
  ON agents (status, capabilities);
