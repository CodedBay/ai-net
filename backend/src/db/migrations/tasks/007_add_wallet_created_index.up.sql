CREATE INDEX IF NOT EXISTS idx_tasks_wallet_created
  ON tasks (walletPublicKey, "createdAt");
