/**
 * Idempotency store — prevents duplicate task creation on retried submissions.
 *
 * ### How it works
 *
 * 1. A client sends an `Idempotency-Key` header with `POST /api/tasks`.
 * 2. The store checks whether that key already exists:
 *    - If **not found**, the request proceeds normally.  After the handler
 *      writes its response, `storeResponse()` persists the status code, body,
 *      and a fixed TTL.
 *    - If **found**, the middleware replays the stored response immediately —
 *      the request handler is never invoked.
 * 3. A background cleanup sweep runs every `cleanupIntervalMs` (default 5 min)
 *      and deletes entries older than `ttlMs`.
 *
 * ### Storage
 *
 * SQLite-backed via `better-sqlite3`.  The DDL is applied inline so the store
 * can be instantiated without an external migration tool (tests, single-process
 * deploys).  Accepts an existing `Database.Database` instance or creates an
 * in-memory store when none is provided.
 *
 * ### Thread safety
 *
 * `better-sqlite3` is synchronous and serialised; concurrent access from
 * multiple Express handlers on the same Node.js thread is safe.
 */

import Database from 'better-sqlite3';
import { getTaskDb } from '../db/tasks';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape of a recorded idempotency entry. */
export interface IdempotencyEntry {
  /** The client-supplied idempotency key. */
  key: string;
  /** HTTP status code of the original response. */
  statusCode: number;
  /** Serialised response body (JSON string). */
  responseBody: string;
  /** ISO-8601 timestamp when the entry was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the entry expires. */
  expiresAt: string;
  /**
   * SHA-256 hash of the original request payload.  `null` for entries
   * persisted before request hashing existed (they replay unconditionally).
   */
  requestHash: string | null;
}

export interface IdempotencyStoreOptions {
  /** Time-to-live in milliseconds.  Default: 24 h. */
  ttlMs?: number;
  /** Background cleanup interval in ms.  Default: 24 h.  Set to 0 to disable. */
  cleanupIntervalMs?: number;
  /** Keep externally-owned database handles open when closing the store. */
  closeDatabase?: boolean;
}

export interface IdempotencyStore {
  /** Look up a stored entry by key.  Returns `undefined` when absent or expired. */
  get(key: string, walletAddress?: string): IdempotencyEntry | undefined;
  /**
   * Persist a response for a given key.  No-op if the key already exists.
   *
   * @param requestHash Optional SHA-256 hash of the original request payload,
   *                    stored for later payload-mismatch detection.
   */
  storeResponse(
    key: string,
    statusCode: number,
    body: unknown,
    walletAddress?: string,
    requestHash?: string | null,
  ): void;
  /** Delete a single entry. */
  delete(key: string, walletAddress?: string): void;
  /** Remove all expired entries.  Returns the count of deleted rows. */
  cleanup(): number;
  /** Start the background cleanup interval.  Idempotent. */
  startCleanup(): void;
  /** Stop the background cleanup interval.  Idempotent. */
  stopCleanup(): void;
  /** Release the underlying database handle. */
  close(): void;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL = `
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
`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CLEANUP_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createIdempotencyStore(
  db?: Database.Database | string,
  options: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_MS;

  const database =
    typeof db === 'string'
      ? new Database(db)
      : db ?? new Database(':memory:');
  const closeDatabase = options.closeDatabase ?? true;

  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  const columns = database
    .prepare('PRAGMA table_info(idempotency_keys)')
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (columns.length > 0 && (!columnNames.has('wallet_address') || !columnNames.has('response_body'))) {
    const legacyBodyColumn = columnNames.has('response_body') ? 'response_body' : 'body';
    const migrateLegacySchema = database.transaction(() => {
      database.exec('DROP INDEX IF EXISTS idx_idempotency_expires_at');
      database.exec('ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy');
      database.exec(DDL);
      database.exec(`
        INSERT OR IGNORE INTO idempotency_keys
          (key, wallet_address, response_body, status_code, created_at, expires_at)
        SELECT key, 'anonymous', ${legacyBodyColumn}, status_code, created_at, expires_at
        FROM idempotency_keys_legacy
      `);
      database.exec('DROP TABLE idempotency_keys_legacy');
    });
    migrateLegacySchema();
  } else {
    database.exec(DDL);
    // CREATE TABLE IF NOT EXISTS does not alter an existing table — add the
    // request_hash column when upgrading a pre-006 database.
    if (columns.length > 0 && !columnNames.has('request_hash')) {
      database.exec('ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT');
    }
  }

  const log = createLogger({ component: 'idempotency' });

  // ── Prepared statements ──────────────────────────────────────────────────

  const selectStmt = database.prepare(`
    SELECT key, status_code, response_body, created_at, expires_at, request_hash
    FROM idempotency_keys
    WHERE key = ? AND wallet_address = ? AND expires_at > ?
  `);

  const upsertStmt = database.prepare(`
    INSERT OR IGNORE INTO idempotency_keys
      (key, wallet_address, response_body, status_code, created_at, expires_at, request_hash)
    VALUES (@key, @walletAddress, @responseBody, @statusCode, @createdAt, @expiresAt, @requestHash)
  `);

  const deleteStmt = database.prepare(`
    DELETE FROM idempotency_keys WHERE key = ? AND wallet_address = ?
  `);

  const cleanupStmt = database.prepare(`
    DELETE FROM idempotency_keys WHERE expires_at <= ?
  `);

  // ── Cleanup interval ─────────────────────────────────────────────────────

  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // ── Public API ───────────────────────────────────────────────────────────

  const store: IdempotencyStore = {
    get(key: string, walletAddress = 'anonymous'): IdempotencyEntry | undefined {
      const now = new Date().toISOString();
      const row = selectStmt.get(key, walletAddress, now) as
        | {
            key: string;
            status_code: number;
            response_body: string;
            created_at: string;
            expires_at: string;
            request_hash: string | null;
          }
        | undefined;

      if (!row) return undefined;

      return {
        key: row.key,
        statusCode: row.status_code,
        responseBody: row.response_body,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        requestHash: row.request_hash,
      };
    },

    storeResponse(
      key: string,
      statusCode: number,
      body: unknown,
      walletAddress = 'anonymous',
      requestHash: string | null = null,
    ): void {
      const now = new Date();
      const expires = new Date(now.getTime() + ttlMs);
      upsertStmt.run({
        key,
        statusCode,
        walletAddress,
        responseBody: JSON.stringify(body),
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        requestHash,
      });
    },

    delete(key: string, walletAddress = 'anonymous'): void {
      deleteStmt.run(key, walletAddress);
    },

    cleanup(): number {
      const now = new Date().toISOString();
      const result = cleanupStmt.run(now);
      const deleted = result.changes;
      if (deleted > 0) {
        log.info({ deleted }, 'expired idempotency entries cleaned up');
      }
      return deleted;
    },

    startCleanup(): void {
      if (cleanupTimer !== null) return;
      if (cleanupIntervalMs <= 0) return;

      // Run an initial cleanup on start.
      store.cleanup();

      cleanupTimer = setInterval(() => {
        try {
          store.cleanup();
        } catch (err) {
          log.error({ err }, 'idempotency cleanup failed');
        }
      }, cleanupIntervalMs);

      // Unref so the timer does not keep the process alive.
      if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
        (cleanupTimer as NodeJS.Timeout).unref();
      }
    },

    stopCleanup(): void {
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },

    close(): void {
      store.stopCleanup();
      if (closeDatabase) database.close();
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Singleton (used by the application unless overridden in tests)
// ---------------------------------------------------------------------------

let _defaultStore: IdempotencyStore | null = null;

/**
 * Get or create the default singleton idempotency store.
 * The store is lazily initialised on first call.
 */
export function getDefaultIdempotencyStore(): IdempotencyStore {
  if (!_defaultStore) {
    _defaultStore = createIdempotencyStore(getTaskDb(), {
      ttlMs: Number(process.env.IDEMPOTENCY_TTL_MS) || DEFAULT_TTL_MS,
      cleanupIntervalMs: Number(process.env.IDEMPOTENCY_CLEANUP_MS) || DEFAULT_CLEANUP_MS,
      closeDatabase: false,
    });
  }
  return _defaultStore;
}

/** Reset the singleton — only for test teardown. */
export function resetDefaultIdempotencyStore(): void {
  if (_defaultStore) {
    _defaultStore.stopCleanup();
    _defaultStore = null;
  }
}
