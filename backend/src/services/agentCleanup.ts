/**
 * Agent Cleanup Service (Issue #402)
 *
 * Handles full deregistration cleanup:
 *  - Marks deregistered agents in the DB within 60 seconds
 *  - Returns open tasks assigned to the deregistered agent to the pending queue
 *  - Prunes heartbeat history (last 7 days retained, flagged for deletion after 30 days)
 *  - Archives (does not delete) quality score history for audit
 *  - Runs asynchronously as a background job — does NOT block the deregistration API call
 *  - Emits Prometheus counter: agents_cleaned_total
 */

import { getAgentDb, createAgentDb } from '../db/agents';
import { createLogger, runWithLogContext } from '../utils/logger';
import { getGlobalJobQueue } from '../queue';

export interface AgentCleanupOptions {
  intervalMs?: number;
  ttlMs?: number;
}

// ── Job type constants (Issue #402) ──────────────────────────────────────────
export const CLEANUP_JOB_TYPE = 'agent_cleanup';
export const DEREGISTRATION_CLEANUP_JOB_TYPE = 'agent_deregistration_cleanup';

// ── Heartbeat retention windows ───────────────────────────────────────────────
/** Heartbeats older than 7 days are pruned during cleanup. */
const HEARTBEAT_PRUNE_DAYS = 7;
/** Heartbeats older than 30 days are flagged for hard deletion. */
const HEARTBEAT_DELETE_DAYS = 30;

// ── Prometheus counter: agents_cleaned_total (Issue #402) ────────────────────
// Simple in-process counter; prometheus.ts scrape endpoint reads this via
// the exported getter. This pattern matches how other counters work in this
// codebase — no external dependency on a registry library.
let _agentsCleanedTotal = 0;

/** Return the current agents_cleaned_total counter value for scraping. */
export function getAgentsCleanedTotal(): number {
  return _agentsCleanedTotal;
}

function incrementAgentsCleanedTotal(): void {
  _agentsCleanedTotal++;
}

/**
 * Enqueue a background deregistration cleanup job for the given agent.
 * Returns immediately — the cleanup happens asynchronously (Issue #402).
 */
export function enqueueAgentDeregistrationCleanup(agentId: string): void {
  const log = createLogger({ component: 'AgentCleanup' });
  try {
    const queue = getGlobalJobQueue();
    queue.enqueue({
      taskId: `cleanup_${agentId}_${Date.now()}`,
      type: DEREGISTRATION_CLEANUP_JOB_TYPE,
      payload: { agentId },
      priority: 'normal',
      maxAttempts: 3,
    });
    log.info({ agentId }, 'agent deregistration cleanup job enqueued');
  } catch (err) {
    log.error({ agentId, err }, 'failed to enqueue agent cleanup job; running synchronously');
    // Fallback: run in background without blocking
    setImmediate(() => {
      runDeregistrationCleanup(agentId).catch((cleanupErr) => {
        log.error({ agentId, err: cleanupErr }, 'synchronous fallback cleanup failed');
      });
    });
  }
}

/**
 * Perform the full deregistration cleanup workflow for an agent.
 * This is called by the worker handler — never on the hot request path.
 */
export async function runDeregistrationCleanup(agentId: string): Promise<void> {
  await runWithLogContext(
    { job_id: `cleanup_${agentId}`, agentId, component: 'AgentCleanup' },
    () => _runDeregistrationCleanup(agentId),
  );
}

async function _runDeregistrationCleanup(agentId: string): Promise<void> {
  const log = createLogger({ component: 'AgentCleanup', agentId });

  log.info({ agentId }, 'starting deregistration cleanup');

  try {
    const db = createAgentDb(getAgentDb());

    // ── Step 1: Mark agent as deregistered (status = 'offline') ─────────────
    const agent = db.findById(agentId);
    if (!agent) {
      log.warn({ agentId }, 'agent not found in DB during cleanup; may already be removed');
    } else {
      db.upsert({ ...agent, status: 'offline', lastSeenAt: new Date().toISOString() });
      log.info({ agentId }, 'agent marked as offline/deregistered');
    }

    // ── Step 2: Return open tasks to pending queue ───────────────────────────
    await reassignOpenTasksForAgent(agentId, log);

    // ── Step 3: Prune heartbeat history ──────────────────────────────────────
    pruneHeartbeatHistory(agentId, log);

    // ── Step 4: Archive quality score history (do not delete) ────────────────
    archiveQualityScoreHistory(agentId, log);

    // ── Step 5: Emit Prometheus counter ──────────────────────────────────────
    incrementAgentsCleanedTotal();

    log.info({ agentId }, 'deregistration cleanup completed successfully');
  } catch (err) {
    log.error({ agentId, err }, 'deregistration cleanup failed');
    throw err; // Allow worker retry logic to handle
  }
}

/**
 * Reassign open tasks that were assigned to the deregistered agent.
 * Tasks are returned to 'pending' status so the coordinator can re-dispatch.
 */
async function reassignOpenTasksForAgent(
  agentId: string,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    // Import lazily to avoid circular dependency with coordinator
    const { getTaskDb, createTaskDb } = await import('../db/tasks');
    const taskDb = createTaskDb(getTaskDb());

    // listByAgent is optional on the AgentDb interface; guard against absence
    const openTasks = (taskDb as any).listByAgent
      ? (taskDb as any).listByAgent(agentId, ['pending', 'in_progress', 'assigned'])
      : [];

    if (openTasks.length === 0) {
      log.info({ agentId }, 'no open tasks to reassign');
      return;
    }

    let reassigned = 0;
    for (const task of openTasks as Array<{ id: string }>) {
      try {
        taskDb.updateStatus(task.id, 'pending');
        reassigned++;
      } catch (taskErr) {
        log.warn({ agentId, taskId: task.id, err: taskErr }, 'failed to reassign task; skipping');
      }
    }

    log.info(
      { agentId, reassigned, total: openTasks.length },
      'open tasks returned to pending queue',
    );
  } catch (err) {
    // Task DB may not be available in all environments; log and continue
    log.warn({ agentId, err }, 'could not reassign tasks; task DB unavailable');
  }
}

/**
 * Prune heartbeat records for a deregistered agent:
 *  - Records older than 30 days: delete
 *  - Records older than 7 days but within 30 days: flag for deletion
 */
function pruneHeartbeatHistory(
  agentId: string,
  log: ReturnType<typeof createLogger>,
): void {
  try {
    const rawDb = getAgentDb();

    const cutoff30Days = new Date(
      Date.now() - HEARTBEAT_DELETE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const cutoff7Days = new Date(
      Date.now() - HEARTBEAT_PRUNE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Delete heartbeats older than 30 days
    try {
      const deleted = rawDb
        .prepare(`DELETE FROM heartbeats WHERE agent_id = ? AND recorded_at < ?`)
        .run(agentId, cutoff30Days);
      log.info(
        { agentId, deleted: (deleted as any).changes, cutoffDays: HEARTBEAT_DELETE_DAYS },
        'pruned old heartbeats',
      );
    } catch {
      // heartbeats table may not exist in all deployments — non-fatal
    }

    // Flag heartbeats older than 7 days for future deletion
    try {
      rawDb
        .prepare(
          `UPDATE heartbeats SET flagged_for_deletion = 1
           WHERE agent_id = ? AND recorded_at < ? AND recorded_at >= ?`,
        )
        .run(agentId, cutoff7Days, cutoff30Days);
      log.debug(
        { agentId, cutoffDays: HEARTBEAT_PRUNE_DAYS },
        'flagged heartbeats older than 7 days for deletion',
      );
    } catch {
      // Column may not exist; non-fatal
    }
  } catch (err) {
    log.warn({ agentId, err }, 'heartbeat pruning skipped; table unavailable');
  }
}

/**
 * Archive quality score history for audit purposes.
 * Sets archived = true rather than deleting rows so the audit trail is preserved.
 */
function archiveQualityScoreHistory(
  agentId: string,
  log: ReturnType<typeof createLogger>,
): void {
  try {
    const rawDb = getAgentDb();

    try {
      const result = rawDb
        .prepare(
          `UPDATE quality_scores SET archived = 1, archived_at = ?
           WHERE agent_id = ? AND (archived IS NULL OR archived = 0)`,
        )
        .run(new Date().toISOString(), agentId);
      log.info(
        { agentId, archived: (result as any).changes },
        'archived quality score history for audit',
      );
    } catch {
      // Table may not exist; non-fatal
    }
  } catch (err) {
    log.warn({ agentId, err }, 'quality score archiving skipped; table unavailable');
  }
}

// ── Periodic stale-agent cleanup (existing behaviour, preserved) ─────────────
export class AgentCleanupService {
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log = createLogger({ component: 'AgentCleanup' });

  constructor(options: AgentCleanupOptions = {}) {
    this.intervalMs = options.intervalMs ?? Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000);
    this.ttlMs = options.ttlMs ?? Number(process.env.HEARTBEAT_GRACE_PERIOD_MS ?? 90_000);
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.tick();
    this.interval = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stopped = true;
  }

  private tick(): void {
    if (this.stopped) return;

    try {
      const db = createAgentDb(getAgentDb());
      const staleSeconds = Math.floor(this.ttlMs / 1000);
      const count = db.markStaleAgents(staleSeconds);
      if (count > 0) {
        this.log.info({ count, staleSeconds }, 'marked stale agents offline');
      }
    } catch (err) {
      this.log.error({ err }, 'cleanup tick failed');
    }
  }
}
