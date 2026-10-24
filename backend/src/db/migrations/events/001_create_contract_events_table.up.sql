-- events table: stores indexed on-chain events from all Soroban contracts
CREATE TABLE IF NOT EXISTS contract_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id   TEXT    NOT NULL,
  event_type    TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  payload       TEXT    NOT NULL,  -- JSON-serialised event payload
  ledger_seq    INTEGER NOT NULL,  -- Stellar ledger sequence number
  tx_hash       TEXT    NOT NULL,  -- Transaction hash
  occurred_at   TEXT    NOT NULL,  -- ISO-8601 timestamp from ledger close time
  indexed_at    TEXT    NOT NULL   -- ISO-8601 timestamp when the indexer stored the row
);

CREATE INDEX IF NOT EXISTS idx_contract_events_contract_id
  ON contract_events (contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_events_event_type
  ON contract_events (event_type);

CREATE INDEX IF NOT EXISTS idx_contract_events_occurred_at
  ON contract_events (occurred_at);

CREATE INDEX IF NOT EXISTS idx_contract_events_ledger_seq
  ON contract_events (ledger_seq);
