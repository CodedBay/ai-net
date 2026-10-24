/**
 * Admin Stats Service (#406)
 *
 * Aggregates platform health metrics for the admin dashboard:
 *   - active_agents, tasks_today, tasks_this_week, xlm_transacted_24h,
 *     error_rate_1h, top_5_agents_by_tasks
 *
 * Revenue endpoint: daily XLM volume for last 30 days.
 * Errors endpoint: error breakdown by error code for last 24 h.
 *
 * All results are cached for 5 minutes (300 s) using the shared LRU cache.
 */

import Database from 'better-sqlite3';
import { LRUCacheClient } from '../cache';
import { createLogger } from '../utils/logger';

const logger = createLogger({ module: 'adminStats' });

/** 5-minute cache TTL in seconds. */
const CACHE_TTL_SECONDS = 300;

const STROOP_FACTOR = 1e7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminStatsSnapshot {
  active_agents: number;
  tasks_today: number;
  tasks_this_week: number;
  xlm_transacted_24h: number;
  error_rate_1h: number;
  top_5_agents_by_tasks: Array<{ agent_id: string; tasks_completed: number }>;
  computed_at: string;
}

export interface RevenuePoint {
  date: string;
  xlm_volume: number;
}

export interface ErrorBreakdownItem {
  error_code: number;
  count: number;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function stroopsToXlm(stroops: number): number {
  return Math.round((stroops / STROOP_FACTOR) * STROOP_FACTOR) / STROOP_FACTOR;
}

/** Count agents with status = 'online'. Falls back gracefully if column missing. */
function queryActiveAgents(agentDb: Database.Database): number {
  try {
    const row = agentDb
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE status = 'online'")
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    const row = agentDb
      .prepare('SELECT COUNT(*) AS count FROM agents')
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

/** Count tasks created today (UTC). */
function queryTasksToday(taskDb: Database.Database, now: Date): number {
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = taskDb
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE "createdAt" >= ?')
    .get(todayStart) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** Count tasks created in the last 7 days. */
function queryTasksThisWeek(taskDb: Database.Database, now: Date): number {
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const row = taskDb
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE "createdAt" >= ?')
    .get(weekStart) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/** Total XLM released in the last 24 hours. */
function queryXlm24h(paymentDb: Database.Database, now: Date): number {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const row = paymentDb
    .prepare(
      "SELECT COALESCE(SUM(CAST(amountStroops AS REAL)), 0) AS total FROM payments WHERE status = 'released' AND \"createdAt\" >= ?",
    )
    .get(since) as { total: number } | undefined;
  return stroopsToXlm(Number(row?.total ?? 0));
}

/**
 * Error rate over the last hour: (errors in last 1 h) / (tasks in last 1 h),
 * expressed as a percentage. Returns 0 when there are no tasks.
 */
function queryErrorRate1h(
  taskDb: Database.Database,
  errorDb: Database.Database,
  now: Date,
): number {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const taskRow = taskDb
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE "createdAt" >= ?')
    .get(since) as { count: number } | undefined;
  const taskCount = Number(taskRow?.count ?? 0);
  if (taskCount === 0) return 0;

  let errorCount = 0;
  try {
    const errorRow = errorDb
      .prepare(
        "SELECT COUNT(*) AS count FROM errors WHERE createdAt >= ? AND status = 'active'",
      )
      .get(since) as { count: number } | undefined;
    errorCount = Number(errorRow?.count ?? 0);
  } catch {
    // errors.db may not be present in all environments
  }

  return Math.round((errorCount / taskCount) * 10000) / 100; // 2 decimal places
}

/** Top 5 agents by tasksCompleted. */
function queryTop5Agents(
  agentDb: Database.Database,
): Array<{ agent_id: string; tasks_completed: number }> {
  try {
    const rows = agentDb
      .prepare(
        'SELECT id, COALESCE(tasksCompleted, 0) AS tasks_completed FROM agents ORDER BY tasks_completed DESC LIMIT 5',
      )
      .all() as Array<{ id: string; tasks_completed: number }>;
    return rows.map((r) => ({ agent_id: r.id, tasks_completed: Number(r.tasks_completed) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Revenue (30-day daily XLM volume)
// ---------------------------------------------------------------------------

/**
 * Returns daily XLM volume for the last 30 days.
 * Each entry has `date` (ISO date string) and `xlm_volume`.
 */
export function computeRevenueLast30Days(
  paymentDb: Database.Database,
  now: Date = new Date(),
): RevenuePoint[] {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let rows: Array<{ day: string; total: number }> = [];
  try {
    rows = paymentDb
      .prepare(
        `SELECT strftime('%Y-%m-%d', "createdAt") AS day,
                COALESCE(SUM(CAST(amountStroops AS REAL)), 0) AS total
         FROM payments
         WHERE status = 'released' AND "createdAt" >= ?
         GROUP BY day
         ORDER BY day`,
      )
      .all(since) as Array<{ day: string; total: number }>;
  } catch {
    logger.warn('revenue query failed — payments.db may be missing createdAt column');
  }

  // Build a full 30-day series filling in 0 for missing days.
  const dayMap = new Map(rows.map((r) => [r.day, stroopsToXlm(Number(r.total))]));
  const result: RevenuePoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    result.push({ date: key, xlm_volume: dayMap.get(key) ?? 0 });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Error breakdown (24 h by error code)
// ---------------------------------------------------------------------------

/**
 * Returns a count of active errors grouped by `errorCode` for the last 24 h.
 */
export function computeErrorBreakdown24h(
  errorDb: Database.Database,
  now: Date = new Date(),
): ErrorBreakdownItem[] {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = errorDb
      .prepare(
        `SELECT errorCode AS error_code, COUNT(*) AS count
         FROM errors
         WHERE createdAt >= ? AND status = 'active'
         GROUP BY errorCode
         ORDER BY count DESC`,
      )
      .all(since) as Array<{ error_code: number; count: number }>;
    return rows.map((r) => ({ error_code: Number(r.error_code), count: Number(r.count) }));
  } catch {
    logger.warn('error breakdown query failed — errors.db may be unavailable');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Primary snapshot (with 5-min cache)
// ---------------------------------------------------------------------------

/** Shared per-process LRU cache (300 s TTL). */
const _cache = new LRUCacheClient(50, CACHE_TTL_SECONDS * 1000);

const STATS_CACHE_KEY = 'admin:stats:snapshot';

/**
 * Compute or return cached admin stats snapshot.
 *
 * @param agentDb   - agents.db connection
 * @param taskDb    - tasks.db connection
 * @param paymentDb - payments.db connection
 * @param errorDb   - errors.db connection (optional, may be null)
 * @param now       - injectable "current time" for testing
 */
export async function getAdminStats(
  agentDb: Database.Database,
  taskDb: Database.Database,
  paymentDb: Database.Database,
  errorDb: Database.Database | null,
  now: Date = new Date(),
): Promise<AdminStatsSnapshot> {
  // Check cache first.
  const cached = await _cache.get(STATS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as AdminStatsSnapshot;
    } catch {
      // fall through to recompute
    }
  }

  const snapshot: AdminStatsSnapshot = {
    active_agents: queryActiveAgents(agentDb),
    tasks_today: queryTasksToday(taskDb, now),
    tasks_this_week: queryTasksThisWeek(taskDb, now),
    xlm_transacted_24h: queryXlm24h(paymentDb, now),
    error_rate_1h: errorDb ? queryErrorRate1h(taskDb, errorDb, now) : 0,
    top_5_agents_by_tasks: queryTop5Agents(agentDb),
    computed_at: now.toISOString(),
  };

  await _cache.set(STATS_CACHE_KEY, JSON.stringify(snapshot), CACHE_TTL_SECONDS);
  return snapshot;
}

// ---------------------------------------------------------------------------
// CSV serialisation helpers
// ---------------------------------------------------------------------------

/** Convert AdminStatsSnapshot to a flat CSV string. */
export function adminStatsToCsv(snapshot: AdminStatsSnapshot): string {
  const header = [
    'active_agents',
    'tasks_today',
    'tasks_this_week',
    'xlm_transacted_24h',
    'error_rate_1h',
    'computed_at',
  ].join(',');
  const row = [
    snapshot.active_agents,
    snapshot.tasks_today,
    snapshot.tasks_this_week,
    snapshot.xlm_transacted_24h,
    snapshot.error_rate_1h,
    snapshot.computed_at,
  ].join(',');
  return `${header}\n${row}\n`;
}

/** Convert revenue points to CSV. */
export function revenueToCsv(points: RevenuePoint[]): string {
  const header = 'date,xlm_volume';
  const rows = points.map((p) => `${p.date},${p.xlm_volume}`).join('\n');
  return `${header}\n${rows}\n`;
}

/** Convert error breakdown to CSV. */
export function errorBreakdownToCsv(items: ErrorBreakdownItem[]): string {
  const header = 'error_code,count';
  const rows = items.map((i) => `${i.error_code},${i.count}`).join('\n');
  return `${header}\n${rows}\n`;
}
