import Database from "better-sqlite3";
import path from "path";
import { migrateToLatest } from "./migrator";
import type { ReputationBreakdown } from "../services/qualityScorer.types";
import { createPool, type SqlitePool } from "./pool";
import { decodeCursor, encodeCursor, type CursorPage } from "./cursor";
import { createErrorRegistryStore, getErrorDb } from "./errorRegistry";
import { poolSettings } from "./poolConfig";

const MIGRATIONS_DIR = path.join(__dirname, "migrations", "agents");

export interface AgentRecord {
  id: string;
  capabilities: string[];
  pricingXLM: number;
  endpoint: string;
  stellarPublicKey: string;
  reputationScore: number;
  lastSeenAt: string;
  status: 'online' | 'offline';
  bondAmountXLM?: number;
  tasksCompleted?: number;
  tasksFailed?: number;
  lastActiveAt?: string;
  reputation?: ReputationBreakdown;
  /** ISO timestamp set by an admin ban. Banned agents never receive tasks. */
  bannedAt?: string | null;
}

export interface AgentReputationHistoryRecord {
  taskId: string;
  nodeId: string;
  score: number;
  timestamp: string;
}

export interface AgentCursorOptions {
  /** Opaque cursor from a previous page's nextCursor field. */
  cursor?: string;
  /** Max items per page (1–100, default 20). */
  limit?: number;
  capability?: string;
  minReputation?: number;
  maxPriceXLM?: number;
  status?: string;
}

export interface AgentRegistrationDraft {
  draftId: string;
  agentId: string;
  stellarPublicKey: string;
  capabilities?: string[];
  pricingXLM?: number;
  endpoint?: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface AgentRegistrationDraftStore {
  create(draft: AgentRegistrationDraft): void;
  find(draftId: string, now?: string): AgentRegistrationDraft | undefined;
  update(draft: AgentRegistrationDraft): void;
  delete(draftId: string): void;
  deleteExpired(now?: string): number;
}

let _agentPool: SqlitePool | null = null;

export function ensureAgentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 2.5,
      lastSeenAt       TEXT NOT NULL,
      last_seen_at     INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'online',
      bondAmountXLM    REAL NOT NULL DEFAULT 0,
      tasksCompleted   INTEGER NOT NULL DEFAULT 0,
      tasksFailed      INTEGER NOT NULL DEFAULT 0,
      lastActiveAt     TEXT,
      bannedAt         TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reputation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      nodeId TEXT NOT NULL,
      score REAL NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reputation_history_agent_timestamp
    ON reputation_history (agentId, timestamp)
  `);
  const migrations = [
    "ALTER TABLE agents ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'offline'",
    "ALTER TABLE agents ADD COLUMN bondAmountXLM REAL NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN tasksCompleted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN tasksFailed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN lastActiveAt TEXT",
    "ALTER TABLE agents ADD COLUMN bannedAt TEXT",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Ignored if column already exists
    }
  }
  db.exec("UPDATE agents SET last_seen_at = CAST(strftime('%s', lastSeenAt) AS INTEGER) WHERE last_seen_at = 0");
}

export function createAgentRegistrationDraftStore(
  db: Database.Database,
): AgentRegistrationDraftStore {
  db.exec(`
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
    )
  `);

  const read = (row: any): AgentRegistrationDraft | undefined => row && ({
    ...row,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : undefined,
  });

  return {
    create(draft): void {
      db.prepare(`
        INSERT INTO agent_registration_drafts
          (draftId, agentId, stellarPublicKey, createdAt, lastActivityAt, expiresAt)
        VALUES (@draftId, @agentId, @stellarPublicKey, @createdAt, @lastActivityAt, @expiresAt)
      `).run(draft);
    },

    find(draftId, now = new Date().toISOString()): AgentRegistrationDraft | undefined {
      db.prepare("DELETE FROM agent_registration_drafts WHERE expiresAt <= ?").run(now);
      const row = db.prepare(
        "SELECT * FROM agent_registration_drafts WHERE draftId = ?",
      ).get(draftId);
      return read(row);
    },

    update(draft): void {
      db.prepare(`
        UPDATE agent_registration_drafts
        SET capabilities = @capabilities, pricingXLM = @pricingXLM,
            endpoint = @endpoint, lastActivityAt = @lastActivityAt, expiresAt = @expiresAt
        WHERE draftId = @draftId
      `).run({
        ...draft,
        capabilities: draft.capabilities ? JSON.stringify(draft.capabilities) : null,
      });
    },

    delete(draftId): void {
      db.prepare("DELETE FROM agent_registration_drafts WHERE draftId = ?").run(draftId);
    },

    deleteExpired(now = new Date().toISOString()): number {
      return db.prepare("DELETE FROM agent_registration_drafts WHERE expiresAt <= ?").run(now).changes;
    },
  };
}

/** Lazily open (or reopen) the pooled agent database. */
export function getAgentPool(dbPath?: string): SqlitePool {
  if (!_agentPool || _agentPool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "agents.db");
    _agentPool = createPool({
      filePath,
      ...poolSettings(),
      onCreate: (db) => {
        migrateToLatest(db, MIGRATIONS_DIR);
      },
    });
  }
  return _agentPool;
}

/**
 * The writer connection, for the synchronous `createAgentDb` API.
 *
 * New code should prefer `getAgentPool().read(...)`.
 */
export function getAgentDb(dbPath?: string): Database.Database {
  return getAgentPool(dbPath).writer;
}

/** The agent pool if one is open, else null. Used by the metrics endpoint. */
export function currentAgentPool(): SqlitePool | null {
  return _agentPool && !_agentPool.closed ? _agentPool : null;
}

export function closeAgentDb(): void {
  void _agentPool?.close();
  _agentPool = null;
}

export interface AgentDb {
  upsert(agent: AgentRecord): void;
  findById(id: string): AgentRecord | undefined;
  list(filters?: { capability?: string; minReputation?: number; maxPriceXLM?: number; status?: string }): AgentRecord[];
  /**
   * Cursor-based list — stable under concurrent writes.
   * Keyset: (lastSeenAt DESC, id DESC).
   */
  listCursor(options?: AgentCursorOptions): CursorPage<AgentRecord>;
  delete(id: string): void;
  updateReputation(
    id: string,
    delta: number,
    event?: { taskId: string; nodeId: string; timestamp: string },
  ): void;
  listReputationHistory?(id: string, since: string): AgentReputationHistoryRecord[];
  updateReputationWithStats(id: string, delta: number, outcome?: 'success' | 'failure'): void;
  countByStellarKey(stellarPublicKey: string): number;
  markAllOffline(): void;
  updateLastSeen(agentId: string): void;
  /** IDs of agents banned by an administrator. */
  listBannedAgentIds(): string[];
  markStaleAgents(staleThresholdSeconds?: number): number;
  deleteOfflineAgents(offlineThresholdHours?: number): number;
  // Optional on-chain event handlers used by registry/sync.ts. Not every
  // AgentDb implementation mirrors contract state, so call sites use `?.`.
  remove?(id: string): void;
  setFrozen?(agentId: string, frozen: boolean): void;
  updatePricing?(agentId: string, pricingXLM: number): void;
  upsertError?(error: {
    id: string;
    reporter: string;
    resolved: boolean;
    resolution: string | null;
    reportedAt: string;
  }): void;
  resolveError?(errorId: string, resolution: string): void;
}

export function createAgentDb(db: Database.Database): AgentDb {
  ensureAgentTable(db);
  return {
    upsert(agent: AgentRecord): void {
      const rep = agent.reputationScore !== undefined ? Math.max(0.0, Math.min(5.0, agent.reputationScore)) : 2.5;
      db.prepare(`
        INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, reputationScore, lastSeenAt, last_seen_at, status, bondAmountXLM, tasksCompleted, tasksFailed, lastActiveAt, bannedAt)
        VALUES (@id, @capabilities, @pricingXLM, @endpoint, @stellarPublicKey, @reputationScore, @lastSeenAt, @last_seen_at, @status, @bondAmountXLM, @tasksCompleted, @tasksFailed, @lastActiveAt, @bannedAt)
        ON CONFLICT(id) DO UPDATE SET
          capabilities = excluded.capabilities,
          pricingXLM = excluded.pricingXLM,
          endpoint = excluded.endpoint,
          stellarPublicKey = excluded.stellarPublicKey,
          lastSeenAt = excluded.lastSeenAt,
          last_seen_at = excluded.last_seen_at,
          status = excluded.status,
          bondAmountXLM = excluded.bondAmountXLM,
          tasksCompleted = excluded.tasksCompleted,
          tasksFailed = excluded.tasksFailed,
          lastActiveAt = excluded.lastActiveAt,
          bannedAt = excluded.bannedAt
      `).run({
        ...agent,
        capabilities: JSON.stringify(agent.capabilities),
        last_seen_at: Math.floor(Date.parse(agent.lastSeenAt) / 1000),
        status: agent.status ?? 'offline',
        reputationScore: rep,
        bondAmountXLM: agent.bondAmountXLM ?? 0,
        tasksCompleted: agent.tasksCompleted ?? 0,
        tasksFailed: agent.tasksFailed ?? 0,
        lastActiveAt: agent.lastActiveAt ?? agent.lastSeenAt ?? new Date().toISOString(),
        bannedAt: agent.bannedAt ?? null,
      });
    },

    findById(id: string): AgentRecord | undefined {
      const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return {
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
        bannedAt: row.bannedAt ?? null,
      };
    },

    list(filters?: { capability?: string; minReputation?: number; maxPriceXLM?: number; status?: string }): AgentRecord[] {
      let query = "SELECT * FROM agents WHERE 1=1";
      const params: any[] = [];
      
      if (filters?.minReputation !== undefined) {
        query += " AND reputationScore >= ?";
        params.push(filters.minReputation);
      }
      if (filters?.maxPriceXLM !== undefined) {
        query += " AND pricingXLM <= ?";
        params.push(filters.maxPriceXLM);
      }
      if (filters?.capability !== undefined) {
        query += " AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)";
        params.push(filters.capability);
      }
      if (filters?.status !== undefined) {
        query += " AND status = ?";
        params.push(filters.status);
      }

      const rows = db.prepare(query).all(...params) as any[];
      return rows.map(row => ({
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
        reputationScore: Number(row.reputationScore ?? 2.5),
        bondAmountXLM: Number(row.bondAmountXLM ?? 0),
        tasksCompleted: Number(row.tasksCompleted ?? 0),
        tasksFailed: Number(row.tasksFailed ?? 0),
        lastActiveAt: row.lastActiveAt ?? row.lastSeenAt,
        bannedAt: row.bannedAt ?? null,
      }));
    },

    listCursor(options: AgentCursorOptions = {}): CursorPage<AgentRecord> {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

      const conditions: string[] = ["1=1"];
      const params: unknown[] = [];

      if (options.minReputation !== undefined) {
        conditions.push("reputationScore >= ?");
        params.push(options.minReputation);
      }
      if (options.maxPriceXLM !== undefined) {
        conditions.push("pricingXLM <= ?");
        params.push(options.maxPriceXLM);
      }
      if (options.capability !== undefined) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)");
        params.push(options.capability);
      }
      if (options.status !== undefined) {
        conditions.push("status = ?");
        params.push(options.status);
      }

      let cursorCondition = "";
      const cursorParams: unknown[] = [];

      if (options.cursor) {
        const payload = decodeCursor(options.cursor);
        if (payload?.lastSeenAt && payload?.id) {
          // Compound keyset: rows that come after (lastSeenAt DESC, id DESC)
          cursorCondition = "AND (lastSeenAt < ? OR (lastSeenAt = ? AND id < ?))";
          cursorParams.push(payload.lastSeenAt, payload.lastSeenAt, payload.id);
        }
      }

      const whereClause = conditions.join(" AND ");
      // Fetch limit+1 to detect whether a next page exists without a COUNT query
      const rows = db
        .prepare(
          `SELECT * FROM agents
           WHERE ${whereClause} ${cursorCondition}
           ORDER BY lastSeenAt DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1) as any[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const agents: AgentRecord[] = pageRows.map((row) => ({
        ...row,
        capabilities: JSON.parse(row.capabilities),
        status: row.status ?? 'offline',
      }));

      const result: CursorPage<AgentRecord> = { items: agents };
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        result.nextCursor = encodeCursor({ lastSeenAt: last.lastSeenAt, id: last.id });
      }
      return result;
    },

    delete(id: string): void {
      db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    },

    updateReputation(
      id: string,
      delta: number,
      event?: { taskId: string; nodeId: string; timestamp: string },
    ): void {
      db.transaction(() => {
        const result = db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?))
          WHERE id = ?
        `).run(delta, id);
        if (result.changes === 0 || !event) return;

        const agent = db.prepare("SELECT reputationScore FROM agents WHERE id = ?").get(id) as
          | { reputationScore: number }
          | undefined;
        if (!agent) return;
        db.prepare(`
          INSERT INTO reputation_history (agentId, taskId, nodeId, score, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, event.taskId, event.nodeId, agent.reputationScore, event.timestamp);
      })();
    },

    listReputationHistory(id: string, since: string): AgentReputationHistoryRecord[] {
      return db.prepare(`
        SELECT taskId, nodeId, score, timestamp
        FROM reputation_history
        WHERE agentId = ? AND timestamp >= ?
        ORDER BY timestamp ASC, id ASC
      `).all(id, since) as AgentReputationHistoryRecord[];
    },

    updateReputationWithStats(id: string, delta: number, outcome?: 'success' | 'failure'): void {
      const now = new Date().toISOString();
      if (outcome === 'success') {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              tasksCompleted = tasksCompleted + 1,
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      } else if (outcome === 'failure') {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              tasksFailed = tasksFailed + 1,
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      } else {
        db.prepare(`
          UPDATE agents
          SET reputationScore = MAX(0.0, MIN(5.0, reputationScore + ?)),
              lastActiveAt = ?,
              lastSeenAt = ?
          WHERE id = ?
        `).run(delta, now, now, id);
      }
    },

    countByStellarKey(stellarPublicKey: string): number {
      const row = db.prepare("SELECT COUNT(*) as count FROM agents WHERE stellarPublicKey = ?").get(stellarPublicKey) as { count: number } | undefined;
      return row ? Number(row.count) : 0;
    },

    markAllOffline(): void {
      db.prepare("UPDATE agents SET status = 'offline' WHERE status = 'online'").run();
    },

    updateLastSeen(agentId: string): void {
      const now = new Date();
      db.prepare(`
        UPDATE agents
        SET lastSeenAt = ?,
            last_seen_at = ?,
            status = 'online'
        WHERE id = ?
      `).run(now.toISOString(), Math.floor(now.getTime() / 1000), agentId);
    },

    listBannedAgentIds(): string[] {
      const rows = db
        .prepare("SELECT id FROM agents WHERE bannedAt IS NOT NULL")
        .all() as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },

    markStaleAgents(staleThresholdSeconds: number = 90): number {
      // Staleness can be recorded in either representation: the epoch column
      // (last_seen_at, written by upsert) or the ISO timestamp (lastSeenAt).
      // Check both so raw-SQL fixtures that backdate only one of them are
      // still detected. datetime() normalises ISO-8601 ("T"/"Z") for comparison.
      const result = db.prepare(`
        UPDATE agents
        SET status = 'offline'
        WHERE status = 'online'
          AND (
            (last_seen_at > 0 AND last_seen_at < ?)
            OR datetime(lastSeenAt) < datetime('now', '-' || ? || ' seconds')
          )
      `).run(Math.floor(Date.now() / 1000) - staleThresholdSeconds, staleThresholdSeconds);
      return result.changes;
    },

    deleteOfflineAgents(offlineThresholdHours: number = 24): number {
      const result = db.prepare(`
        DELETE FROM agents
        WHERE status = 'offline'
          AND datetime(lastSeenAt, '+' || ? || ' hours') < datetime('now')
      `).run(offlineThresholdHours);
      return result.changes;
    },

    upsertError(error: {
      id: string;
      reporter: string;
      resolved: boolean;
      resolution: string | null;
      reportedAt: string;
    }): void {
      const errorsDb = getErrorDb();
      errorsDb.prepare(
        `INSERT OR IGNORE INTO errors
          (id, errorCode, message, agentId, reporter, status, resolution, rentStroops, maintenanceAccount, createdAt, expiresAt, resolvedAt)
         VALUES
          (?, 0, '', '', ?, 'active', NULL, '0', '', ?, '', NULL)`,
      ).run(error.id, error.reporter ?? "", error.reportedAt ?? new Date().toISOString());
    },

    resolveError(errorId: string, resolution: string): void {
      const store = createErrorRegistryStore(getErrorDb());
      store.resolve(errorId, resolution);
    }
  };
}
