CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  response_body  TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  request_hash   TEXT,
  PRIMARY KEY (key, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
  ON idempotency_keys (expires_at);
