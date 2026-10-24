/**
 * events.db — SQLite store for indexed Soroban contract events.
 *
 * Follows the same pool/migration pattern as payments.db and agents.db.
 */

import Database from "better-sqlite3";
import path from "path";
import { createLogger } from "../utils/logger";
import { migrateToLatest } from "./migrator";
import { createPool, type SqlitePool } from "./pool";
import { poolSettings } from "./poolConfig";

const MIGRATIONS_DIR = path.join(__dirname, "migrations", "events");

export interface ContractEventRecord {
  /** Auto-increment primary key. */
  id?: number;
  /** Soroban contract ID (C…). */
  contractId: string;
  /** Standardised event type string, e.g. "agent_registered", "config_updated". */
  eventType: string;
  /** Schema version of the event payload. */
  version: number;
  /** JSON-serialised payload object. */
  payload: string;
  /** Stellar ledger sequence at which the event was emitted. */
  ledgerSeq: number;
  /** Transaction hash. */
  txHash: string;
  /** ISO-8601 close time from the Stellar ledger. */
  occurredAt: string;
  /** ISO-8601 time the indexer stored the row. */
  indexedAt: string;
}

export interface ContractEventFilter {
  contractId?: string;
  eventType?: string;
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
  limit?: number;
  offset?: number;
}

const logger = createLogger({ component: "events-db" });

let _pool: SqlitePool | null = null;

/** Return (and lazily open) the events database connection pool. */
export function getEventsPool(dbPath?: string): SqlitePool {
  if (!_pool || _pool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "events.db");
    _pool = createPool({
      filePath,
      ...poolSettings(),
      onCreate: (db) => {
        (db as unknown as { on: (event: string, fn: (error: Error) => void) => void }).on(
          "error",
          (error: Error) => {
            logger.error({ err: error }, "events database error");
          },
        );
        migrateToLatest(db, MIGRATIONS_DIR);
      },
    });
    logger.info({ dbPath: filePath }, "events database opened");
  }
  return _pool;
}

export function currentEventsPool(): SqlitePool | null {
  return _pool && !_pool.closed ? _pool : null;
}

/** Synchronous writer connection — for simple inserts from the indexer. */
export function getEventsDb(dbPath?: string): Database.Database {
  return getEventsPool(dbPath).writer;
}

export function closeEventsDb(): void {
  void _pool?.close();
  _pool = null;
}

export interface EventsDb {
  /** Persist a single contract event. Returns the new row id. */
  insert(record: Omit<ContractEventRecord, "id">): number;
  /** Query events with optional filters. */
  query(filter: ContractEventFilter): ContractEventRecord[];
  /** Count events matching a filter (without loading payloads). */
  count(filter: ContractEventFilter): number;
  /** Health-check: returns true if the DB is reachable. */
  healthCheck(): boolean;
}

export function createEventsDb(db: Database.Database): EventsDb {
  return {
    insert(record: Omit<ContractEventRecord, "id">): number {
      const result = db
        .prepare<Omit<ContractEventRecord, "id">>(`
          INSERT INTO contract_events
            (contract_id, event_type, version, payload, ledger_seq, tx_hash, occurred_at, indexed_at)
          VALUES
            (@contractId, @eventType, @version, @payload, @ledgerSeq, @txHash, @occurredAt, @indexedAt)
        `)
        .run(record);
      return result.lastInsertRowid as number;
    },

    query(filter: ContractEventFilter): ContractEventRecord[] {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter.contractId) {
        conditions.push("contract_id = @contractId");
        params.contractId = filter.contractId;
      }
      if (filter.eventType) {
        conditions.push("event_type = @eventType");
        params.eventType = filter.eventType;
      }
      if (filter.from) {
        conditions.push("occurred_at >= @from");
        params.from = filter.from;
      }
      if (filter.to) {
        conditions.push("occurred_at <= @to");
        params.to = filter.to;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;

      const rows = db
        .prepare(
          `SELECT id, contract_id, event_type, version, payload, ledger_seq, tx_hash, occurred_at, indexed_at
           FROM contract_events
           ${where}
           ORDER BY ledger_seq ASC, id ASC
           LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset }) as Array<Record<string, unknown>>;

      return rows.map(rowToRecord);
    },

    count(filter: ContractEventFilter): number {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter.contractId) {
        conditions.push("contract_id = @contractId");
        params.contractId = filter.contractId;
      }
      if (filter.eventType) {
        conditions.push("event_type = @eventType");
        params.eventType = filter.eventType;
      }
      if (filter.from) {
        conditions.push("occurred_at >= @from");
        params.from = filter.from;
      }
      if (filter.to) {
        conditions.push("occurred_at <= @to");
        params.to = filter.to;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = db
        .prepare(`SELECT COUNT(*) as cnt FROM contract_events ${where}`)
        .get(params) as { cnt: number };
      return row.cnt;
    },

    healthCheck(): boolean {
      try {
        db.prepare("SELECT 1").get();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function rowToRecord(row: Record<string, unknown>): ContractEventRecord {
  return {
    id: row.id as number,
    contractId: row.contract_id as string,
    eventType: row.event_type as string,
    version: row.version as number,
    payload: row.payload as string,
    ledgerSeq: row.ledger_seq as number,
    txHash: row.tx_hash as string,
    occurredAt: row.occurred_at as string,
    indexedAt: row.indexed_at as string,
  };
}
