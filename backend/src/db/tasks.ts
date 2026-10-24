import Database from "better-sqlite3";
import path from "path";
import type { Task, TaskStatus } from "../types/task";
import type { QualityScoreRecord } from "../services/qualityScorer.types";
import { createLogger } from "../utils/logger";
import { migrateToLatest } from "./migrator";
import { createPool, type SqlitePool } from "./pool";
import { decodeCursor, encodeCursor, type CursorPage } from "./cursor";
import { poolSettings } from "./poolConfig";

const logger = createLogger({ component: "task-db" });
const MIGRATIONS_DIR = path.join(__dirname, "migrations", "tasks");

let _taskPool: SqlitePool | null = null;

/** Lazily open (or reopen) the pooled task database. */
export function getTaskPool(dbPath?: string): SqlitePool {
  if (!_taskPool || _taskPool.closed) {
    const filePath = dbPath ?? path.join(process.cwd(), "tasks.db");
    _taskPool = createPool({
      filePath,
      ...poolSettings(),
      onCreate: (db) => {
        try {
          (db as any).on("error", (err: Error) => {
            logger.error({ err }, "task database error");
          });
        } catch {
          // error events are emitted from node EventEmitter support in runtime
        }
        migrateToLatest(db, MIGRATIONS_DIR);
      },
    });
  }
  return _taskPool;
}

/**
 * The writer connection, for the synchronous `createTaskDb` API.
 *
 * Kept so existing callers work unchanged; new code should prefer
 * `getTaskPool().read(...)` so reads are spread across the pool.
 */
export function getTaskDb(dbPath?: string): Database.Database {
  return getTaskPool(dbPath).writer;
}

/** The task pool if one is open, else null. Used by the metrics endpoint. */
export function currentTaskPool(): SqlitePool | null {
  return _taskPool && !_taskPool.closed ? _taskPool : null;
}

export function closeTaskDb(): void {
  void _taskPool?.close();
  _taskPool = null;
}

export interface TaskEvent {
  type: string;
  taskId: string;
  nodeId?: string;
  payload?: unknown;
  timestamp: string;
}

export interface StoredTaskResult {
  result: string | null;
  resultFile: string | null;
  resultExpiresAt: string | null;
  resultEncoding: "identity" | "gzip";
  resultStatus: "inline" | "archived" | "expired";
  resultSummary: string | null;
  resultArchiveKey: string | null;
  resultArchiveAt: string | null;
}

export interface ExpiredTaskResult {
  id: string;
  resultFile: string | null;
  resultArchiveKey?: string | null;
}

export interface TaskListOptions {
  status?: string;
  q?: string;
  sort?: "createdAt:asc" | "createdAt:desc";
  /** ISO timestamp — only return tasks created after this point. */
  createdAfter?: string;
}

export interface TaskCursorOptions {
  /** Opaque cursor from a previous page's nextCursor field. */
  cursor?: string;
  /** Max items per page (1–100, default 20). */
  limit?: number;
  status?: string;
  q?: string;
  sort?: "createdAt:asc" | "createdAt:desc";
}

export interface TaskDb {
  insert(task: Task): void;
  findById(id: string): Task | undefined;
  list(
    walletPublicKey: string,
    page: number,
    pageSize: number,
    options?: TaskListOptions,
  ): { tasks: Task[]; total: number };
  /**
   * Cursor-based list — stable under concurrent writes.
   * Default keyset: (createdAt DESC, id DESC).
   */
  listCursor(
    walletPublicKey: string,
    options?: TaskCursorOptions,
  ): CursorPage<Task>;
  updateStatus(id: string, status: TaskStatus): void;
  updateDagJson(id: string, dagJson: string): void;
  saveResult(
    id: string,
    result: string,
    resultFile: string | null,
    expiresAt: string,
    options?: { encoding?: "identity" | "gzip"; summary?: string; archiveAt?: string },
  ): void;
  getResult(id: string): StoredTaskResult | undefined;
  listResultsToArchive(before: string): ExpiredTaskResult[];
  markResultArchived(id: string, archiveKey: string): void;
  listExpiredResults(before: string): ExpiredTaskResult[];
  clearResult(id: string): void;
  insertEvent(event: TaskEvent): void;
  getEventHistory(taskId: string): TaskEvent[];
  failRunningTasks(): void;
  insertQualityScore(record: QualityScoreRecord): void;
  listQualityScores(agentId?: string, limit?: number, since?: string): QualityScoreRecord[];
}

function taskFromRow(row: any): Task {
  delete row.result;
  delete row.resultFile;
  delete row.resultExpiresAt;
  delete row.resultEncoding;
  delete row.resultStatus;
  delete row.resultSummary;
  delete row.resultArchiveKey;
  delete row.resultArchiveAt;
  return { ...row, dag: JSON.parse(row.dagJson) };
}

export function createTaskDb(db: Database.Database): TaskDb {
  return {
    insert(task: Task): void {
      db.prepare(
        `
        INSERT INTO tasks (id, prompt, walletPublicKey, status, dagJson, createdAt, updatedAt)
        VALUES (@id, @prompt, @walletPublicKey, @status, @dagJson, @createdAt, @updatedAt)
      `,
      ).run({
        ...task,
        dagJson: JSON.stringify(task.dag),
      });
    },

    findById(id: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return taskFromRow(row);
    },

    list(
      walletPublicKey: string,
      page: number,
      pageSize: number,
      options: TaskListOptions = {},
    ) {
      const offset = (page - 1) * pageSize;
      const conditions: string[] = ["walletPublicKey = ?"];
      const params: unknown[] = [walletPublicKey];

      if (options.status) {
        conditions.push("status = ?");
        params.push(options.status);
      }
      if (options.q) {
        conditions.push("prompt LIKE ?");
        params.push(`%${options.q}%`);
      }
      if (options.createdAfter) {
        conditions.push("createdAt > ?");
        params.push(options.createdAfter);
      }

      const whereClause = conditions.join(" AND ");
      const sortOrder = options.sort === "createdAt:asc" ? "ASC" : "DESC";

      const rows = db
        .prepare(
          `SELECT * FROM tasks WHERE ${whereClause} ORDER BY createdAt ${sortOrder} LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset) as any[];

      const tasks: Task[] = rows.map(taskFromRow);

      const { total } = db
        .prepare(`SELECT COUNT(*) as total FROM tasks WHERE ${whereClause}`)
        .get(...params) as { total: number };

      return { tasks, total };
    },

    listCursor(
      walletPublicKey: string,
      options: TaskCursorOptions = {},
    ): CursorPage<Task> {
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
      const sortOrder = options.sort === "createdAt:asc" ? "ASC" : "DESC";
      // Keyset comparator flips based on sort direction
      const keyOp = sortOrder === "DESC" ? "<" : ">";

      const conditions: string[] = ["walletPublicKey = ?"];
      const params: unknown[] = [walletPublicKey];

      if (options.status) {
        conditions.push("status = ?");
        params.push(options.status);
      }
      if (options.q) {
        conditions.push("prompt LIKE ?");
        params.push(`%${options.q}%`);
      }

      let cursorCondition = "";
      const cursorParams: unknown[] = [];

      if (options.cursor) {
        const payload = decodeCursor(options.cursor);
        if (payload?.createdAt && payload?.id) {
          // Compound keyset prevents instability when timestamps collide
          cursorCondition = `AND (createdAt ${keyOp} ? OR (createdAt = ? AND id ${keyOp} ?))`;
          cursorParams.push(payload.createdAt, payload.createdAt, payload.id);
        }
      }

      const whereClause = conditions.join(" AND ");
      // Fetch limit+1 to detect a next page without a COUNT query
      const rows = db
        .prepare(
          `SELECT * FROM tasks
           WHERE ${whereClause} ${cursorCondition}
           ORDER BY createdAt ${sortOrder}, id ${sortOrder}
           LIMIT ?`,
        )
        .all(...params, ...cursorParams, limit + 1) as any[];

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const tasks: Task[] = pageRows.map(taskFromRow);

      const result: CursorPage<Task> = { items: tasks };
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        result.nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
      }
      return result;
    },

    updateStatus(id: string, status: TaskStatus): void {
      db.prepare("UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?").run(
        status,
        new Date().toISOString(),
        id,
      );
    },

    updateDagJson(id: string, dagJson: string): void {
      db.prepare(
        "UPDATE tasks SET dagJson = ?, updatedAt = ? WHERE id = ?",
      ).run(dagJson, new Date().toISOString(), id);
    },

    saveResult(id: string, result: string, resultFile: string | null, expiresAt: string, options = {}): void {
      db.prepare(
        `UPDATE tasks
         SET result = ?, resultFile = ?, resultExpiresAt = ?, resultEncoding = ?,
             resultStatus = 'inline', resultSummary = ?, resultArchiveKey = NULL,
             resultArchiveAt = ?, updatedAt = ? WHERE id = ?`,
      ).run(
        result,
        resultFile,
        expiresAt,
        options.encoding ?? "identity",
        options.summary ?? null,
        options.archiveAt ?? null,
        new Date().toISOString(),
        id,
      );
    },

    getResult(id: string): StoredTaskResult | undefined {
      return db.prepare(
        `SELECT result, resultFile, resultExpiresAt, resultEncoding, resultStatus,
                resultSummary, resultArchiveKey, resultArchiveAt
         FROM tasks WHERE id = ?`,
      ).get(id) as StoredTaskResult | undefined;
    },

    listResultsToArchive(before: string): ExpiredTaskResult[] {
      return db.prepare(
        `SELECT id, resultFile, resultArchiveKey FROM tasks
         WHERE result IS NOT NULL AND resultStatus = 'inline' AND resultArchiveAt <= ?`,
      ).all(before) as ExpiredTaskResult[];
    },

    markResultArchived(id: string, archiveKey: string): void {
      db.prepare(
        `UPDATE tasks SET result = NULL, resultFile = NULL, resultStatus = 'archived',
                resultArchiveKey = ?, updatedAt = ? WHERE id = ?`,
      ).run(archiveKey, new Date().toISOString(), id);
    },

    listExpiredResults(before: string): ExpiredTaskResult[] {
      return db.prepare(
        `SELECT id, resultFile, resultArchiveKey FROM tasks
         WHERE resultStatus != 'expired' AND resultExpiresAt <= ?`,
      ).all(before) as ExpiredTaskResult[];
    },

    clearResult(id: string): void {
      db.prepare(
        `UPDATE tasks SET result = NULL, resultFile = NULL, resultStatus = 'expired',
          resultSummary = NULL, resultArchiveKey = NULL, updatedAt = ? WHERE id = ?`,
      ).run(new Date().toISOString(), id);
    },

    insertEvent(event: TaskEvent): void {
      db.prepare(
        `
        INSERT INTO task_events (taskId, type, nodeId, payload, timestamp)
        VALUES (@taskId, @type, @nodeId, @payload, @timestamp)
      `,
      ).run({
        taskId: event.taskId,
        type: event.type,
        nodeId: event.nodeId ?? null,
        payload:
          event.payload !== undefined ? JSON.stringify(event.payload) : null,
        timestamp: event.timestamp,
      });
    },

    getEventHistory(taskId: string): TaskEvent[] {
      const rows = db
        .prepare("SELECT * FROM task_events WHERE taskId = ? ORDER BY id ASC")
        .all(taskId) as Array<{
        taskId: string;
        type: string;
        nodeId: string | null;
        payload: string | null;
        timestamp: string;
      }>;
      return rows.map((r) => ({
        taskId: r.taskId,
        type: r.type,
        nodeId: r.nodeId ?? undefined,
        payload: r.payload ? JSON.parse(r.payload) : undefined,
        timestamp: r.timestamp,
      }));
    },

    failRunningTasks(): void {
      const now = new Date().toISOString();
      const runningTasks = db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as any[];
      for (const task of runningTasks) {
        let dag: any[] = [];
        try {
          dag = JSON.parse(task.dagJson);
          for (const node of dag) {
            if (node.status === 'running' || node.status === 'pending') {
              node.status = 'failed';
              node.error = 'Server shutdown';
            }
          }
        } catch (e) {
          // ignore parse error
        }
        db.prepare("UPDATE tasks SET status = 'failed', dagJson = ?, updatedAt = ? WHERE id = ?").run(
          JSON.stringify(dag),
          now,
          task.id
        );
      }
    },

    insertQualityScore(record: QualityScoreRecord): void {
      db.prepare(
        `
        INSERT INTO quality_scores (taskId, nodeId, agentId, agentType, score, completeness, relevance, format, needsReview, responseTimeMs, timestamp)
        VALUES (@taskId, @nodeId, @agentId, @agentType, @score, @completeness, @relevance, @format, @needsReview, @responseTimeMs, @timestamp)
      `,
      ).run({
        taskId: record.taskId,
        nodeId: record.nodeId,
        agentId: record.agentId ?? null,
        agentType: record.agentType,
        score: record.score,
        completeness: record.completeness,
        relevance: record.relevance,
        format: record.format,
        needsReview: record.needsReview ? 1 : 0,
        responseTimeMs: record.responseTimeMs ?? null,
        timestamp: record.timestamp,
      });
    },

    listQualityScores(agentId?: string, limit: number = 500, since?: string): QualityScoreRecord[] {
      const filters: string[] = [];
      const params: Array<string | number> = [];
      if (agentId) {
        filters.push("agentId = ?");
        params.push(agentId);
      }
      if (since) {
        filters.push("timestamp >= ?");
        params.push(since);
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM quality_scores ${where} ORDER BY timestamp ASC, id ASC LIMIT ?`,
      ).all(...params, limit) as Array<{
        taskId: string;
        nodeId: string;
        agentId: string | null;
        agentType: string;
        score: number;
        completeness: number;
        relevance: number;
        format: number;
        needsReview: number;
        responseTimeMs: number | null;
        timestamp: string;
      }>;

      return rows.map((r) => ({
        taskId: r.taskId,
        nodeId: r.nodeId,
        agentId: r.agentId ?? undefined,
        agentType: r.agentType,
        score: r.score,
        completeness: r.completeness,
        relevance: r.relevance,
        format: r.format,
        needsReview: r.needsReview === 1,
        responseTimeMs: r.responseTimeMs == null ? undefined : Number(r.responseTimeMs),
        timestamp: r.timestamp,
      }));
    },
  };
}
