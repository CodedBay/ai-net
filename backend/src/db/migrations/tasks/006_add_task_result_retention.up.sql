ALTER TABLE tasks ADD COLUMN resultEncoding TEXT NOT NULL DEFAULT 'identity';
ALTER TABLE tasks ADD COLUMN resultStatus TEXT NOT NULL DEFAULT 'inline';
ALTER TABLE tasks ADD COLUMN resultSummary TEXT;
ALTER TABLE tasks ADD COLUMN resultArchiveKey TEXT;
ALTER TABLE tasks ADD COLUMN resultArchiveAt TEXT;

UPDATE tasks
SET resultArchiveAt = strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt, '+30 days')
WHERE result IS NOT NULL;