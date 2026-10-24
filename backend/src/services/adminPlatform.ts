import { Keypair } from "@stellar/stellar-sdk";

import { getConfig } from "../config";
import { getDb as getPaymentDb } from "../db";
import { createAgentDb, getAgentDb, type AgentRecord } from "../db/agents";
import { createTaskDb, getTaskDb } from "../db/tasks";
import { getGlobalJobQueue, type JobQueue } from "../queue";
import { PaymentService } from "../payment/payment";
import type { Task, TaskStatus } from "../types/task";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "admin-platform" });

const STROOPS_PER_XLM = 1e7;
/** Task statuses that cannot be cancelled. */
const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

export interface AgentStats {
  total: number;
  online: number;
  offline: number;
  banned: number;
}

export interface TaskStats {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  last24h: number;
}

export interface XlmStats {
  released: number;
  locked: number;
  total: number;
}

export interface AdminPlatformStats {
  generatedAt: string;
  agents: AgentStats;
  tasks: TaskStats;
  xlm: XlmStats;
}

function numberFrom(row: Record<string, unknown> | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

/** Platform-wide aggregates for `GET /api/admin/stats`. */
export function getAdminPlatformStats(now: Date = new Date()): AdminPlatformStats {
  const agentRow = getAgentDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END), 0) AS online,
        COALESCE(SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END), 0) AS offline,
        COALESCE(SUM(CASE WHEN bannedAt IS NOT NULL THEN 1 ELSE 0 END), 0) AS banned
      FROM agents
    `,
    )
    .get() as Record<string, unknown> | undefined;

  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const taskRow = getTaskDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(CASE WHEN "createdAt" >= ? THEN 1 ELSE 0 END), 0) AS last24h
      FROM tasks
    `,
    )
    .get(dayAgo) as Record<string, unknown> | undefined;

  let releasedStroops = 0;
  let lockedStroops = 0;
  try {
    const paymentRow = getPaymentDb()
      .prepare(
        `
        SELECT
          COALESCE(SUM(CASE WHEN status = 'released' THEN CAST(amountStroops AS REAL) ELSE 0 END), 0) AS released,
          COALESCE(SUM(CASE WHEN status = 'locked' THEN CAST(amountStroops AS REAL) ELSE 0 END), 0) AS locked
        FROM payments
      `,
      )
      .get() as Record<string, unknown> | undefined;
    releasedStroops = numberFrom(paymentRow, "released");
    lockedStroops = numberFrom(paymentRow, "locked");
  } catch (error) {
    logger.warn({ err: error }, "could not aggregate payment throughput");
  }

  const round = (value: number): number => Math.round(value * 1e7) / 1e7;

  return {
    generatedAt: now.toISOString(),
    agents: {
      total: numberFrom(agentRow, "total"),
      online: numberFrom(agentRow, "online"),
      offline: numberFrom(agentRow, "offline"),
      banned: numberFrom(agentRow, "banned"),
    },
    tasks: {
      total: numberFrom(taskRow, "total"),
      queued: numberFrom(taskRow, "queued"),
      running: numberFrom(taskRow, "running"),
      completed: numberFrom(taskRow, "completed"),
      failed: numberFrom(taskRow, "failed"),
      cancelled: numberFrom(taskRow, "cancelled"),
      last24h: numberFrom(taskRow, "last24h"),
    },
    xlm: {
      released: round(releasedStroops / STROOPS_PER_XLM),
      locked: round(lockedStroops / STROOPS_PER_XLM),
      total: round((releasedStroops + lockedStroops) / STROOPS_PER_XLM),
    },
  };
}

export interface AdminTaskFilters {
  status?: string;
  wallet?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AdminTaskSummary {
  id: string;
  prompt: string;
  walletPublicKey: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Paginated, filterable task list for `GET /api/admin/tasks`. */
export function listAdminTasks(filters: AdminTaskFilters = {}): {
  tasks: AdminTaskSummary[];
  total: number;
  limit: number;
  offset: number;
} {
  const limit = Math.max(1, Math.min(Math.trunc(filters.limit ?? 20), 100));
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));

  const conditions: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.wallet) {
    conditions.push("walletPublicKey = ?");
    params.push(filters.wallet);
  }
  if (filters.from) {
    conditions.push('"createdAt" >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('"createdAt" <= ?');
    params.push(filters.to);
  }

  const where = conditions.join(" AND ");
  const db = getTaskDb();
  const rows = db
    .prepare(
      `SELECT id, prompt, walletPublicKey, status, "createdAt" AS createdAt, "updatedAt" AS updatedAt
       FROM tasks WHERE ${where}
       ORDER BY "createdAt" DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as AdminTaskSummary[];
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM tasks WHERE ${where}`)
    .get(...params) as { total: number };

  return { tasks: rows, total: Number(total ?? 0), limit, offset };
}

export type AdminCancelResult =
  | { ok: true; task: Task; refundTxHashes: string[] }
  | { ok: false; statusCode: 404 | 409; error: string; currentStatus?: string };

export interface AdminCancelOptions {
  queue?: JobQueue;
  paymentService?: PaymentService;
}

/** Force-cancel any task, regardless of wallet ownership. */
export async function cancelTaskAsAdmin(
  taskId: string,
  options: AdminCancelOptions = {},
): Promise<AdminCancelResult> {
  const taskDb = createTaskDb(getTaskDb());
  const task = taskDb.findById(taskId);
  if (!task) {
    return { ok: false, statusCode: 404, error: "Task not found" };
  }
  if (TERMINAL_STATUSES.has(task.status)) {
    return {
      ok: false,
      statusCode: 409,
      error: `Task cannot be cancelled in '${task.status}' status`,
      currentStatus: task.status,
    };
  }

  taskDb.updateStatus(taskId, "cancelled");

  try {
    const jobQueue = options.queue ?? getGlobalJobQueue();
    const job = jobQueue.getJobByTaskId(taskId);
    if (job) {
      jobQueue
        .getStore()
        .updateStatus(job.id, "failed", { lastError: "Cancelled by admin request" });
    }
  } catch (error) {
    logger.warn({ taskId, err: error }, "could not cancel admin task job");
  }

  const refundTxHashes: string[] = [];
  try {
    const secret = getConfig().STELLAR_COORDINATOR_SECRET;
    if (secret) {
      const coordinatorKeypair = Keypair.fromSecret(secret);
      const svc = options.paymentService ?? new PaymentService(getPaymentDb() as never);
      const locked = svc
        .listLocalRecords()
        .filter((record) => record.taskId === taskId && record.status === "locked");
      for (const record of locked) {
        try {
          const hash = await svc.refund(taskId, record.nodeId, coordinatorKeypair);
          refundTxHashes.push(hash);
        } catch (error) {
          logger.error(
            { taskId, nodeId: record.nodeId, err: error },
            "admin refund failed",
          );
        }
      }
    }
  } catch (error) {
    logger.error({ taskId, err: error }, "admin refund step failed");
  }

  const updated = taskDb.findById(taskId) ?? { ...task, status: "cancelled" as TaskStatus };
  return { ok: true, task: updated, refundTxHashes };
}

/** Ban an agent so it can no longer be assigned tasks. */
export function banAgent(agentId: string, reason?: string): AgentRecord | undefined {
  const db = createAgentDb(getAgentDb());
  const agent = db.findById(agentId);
  if (!agent) return undefined;

  const banned = {
    ...agent,
    status: "offline" as const,
    lastSeenAt: new Date().toISOString(),
    bannedAt: agent.bannedAt ?? new Date().toISOString(),
  };
  db.upsert(banned);
  logger.warn({ agentId, reason }, "agent banned by admin");
  return db.findById(agentId);
}

/** Lift a ban (idempotent). The agent stays offline until its next heartbeat. */
export function unbanAgent(agentId: string): AgentRecord | undefined {
  const db = createAgentDb(getAgentDb());
  const agent = db.findById(agentId);
  if (!agent) return undefined;

  const updated = {
    ...agent,
    bannedAt: null,
    status: "offline" as const,
    lastSeenAt: new Date().toISOString(),
  };
  db.upsert(updated);
  return db.findById(agentId);
}

/**
 * Drop admin-banned agents from a dispatch candidate list (#33).
 *
 * Reads the ban ledger from agents.db; on failure it returns the list
 * unchanged so a transient DB error does not take the network offline.
 */
export function excludeBannedAgents<T extends { id: string }>(agents: T[]): T[] {
  try {
    const banned = new Set(createAgentDb(getAgentDb()).listBannedAgentIds());
    return agents.filter((agent) => !banned.has(agent.id));
  } catch (error) {
    logger.warn({ err: error }, "could not load banned agents");
    return agents;
  }
}
