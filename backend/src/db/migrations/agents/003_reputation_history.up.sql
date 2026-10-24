CREATE TABLE IF NOT EXISTS reputation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  taskId TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  score REAL NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reputation_history_agent_timestamp
  ON reputation_history (agentId, timestamp);
