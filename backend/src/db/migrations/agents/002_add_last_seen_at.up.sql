ALTER TABLE agents ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
UPDATE agents
SET last_seen_at = CAST(strftime('%s', lastSeenAt) AS INTEGER)
WHERE last_seen_at = 0;