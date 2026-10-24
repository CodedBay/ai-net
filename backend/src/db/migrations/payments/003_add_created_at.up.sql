ALTER TABLE payments ADD COLUMN "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE INDEX IF NOT EXISTS idx_payments_createdAt ON payments ("createdAt");
