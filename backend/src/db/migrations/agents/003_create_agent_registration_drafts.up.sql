CREATE TABLE IF NOT EXISTS agent_registration_drafts (
  draftId TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  stellarPublicKey TEXT NOT NULL,
  capabilities TEXT,
  pricingXLM REAL,
  endpoint TEXT,
  createdAt TEXT NOT NULL,
  lastActivityAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_registration_drafts_expires_at
  ON agent_registration_drafts(expiresAt);