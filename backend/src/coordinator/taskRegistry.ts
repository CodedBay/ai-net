/**
 * TaskRegistry — in-memory map of active task pipelines.
 *
 * Tracks every in-flight task promise so the graceful shutdown handler can
 * await them before closing databases.  The coordinator registers a task
 * when it starts executing and deregisters it when it completes (success or
 * failure).
 *
 * Usage:
 *   const registry = new TaskRegistry();
 *   registry.register(taskId, myPromise);
 *   await registry.drainAll(timeoutMs);
 */

import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "task-registry" });

export class TaskRegistry {
  /** Map of taskId → completion promise */
  private readonly tasks = new Map<string, Promise<unknown>>();

  /**
   * Register an in-flight task.  The promise should resolve or reject when
   * the pipeline finishes (success or error — both are acceptable exits).
   */
  register(taskId: string, promise: Promise<unknown>): void {
    this.tasks.set(taskId, promise);
    promise.finally(() => {
      this.tasks.delete(taskId);
    });
  }

  /**
   * Deregister a task (called on completion if you hold a reference).
   * Safe to call even if the task was never registered.
   */
  deregister(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /**
   * How many tasks are currently in flight.
   */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * Returns the IDs of all currently-tracked tasks.
   */
  get activeIds(): string[] {
    return Array.from(this.tasks.keys());
  }

  /**
   * Await all in-flight tasks up to `timeoutMs`.
   *
   * If tasks complete within the timeout, returns true.
   * If the timeout fires first, returns false — the caller is expected to
   * proceed with forced shutdown.
   */
  async drainAll(timeoutMs: number): Promise<boolean> {
    if (this.tasks.size === 0) return true;

    logger.info({ count: this.tasks.size, taskIds: this.activeIds }, "draining in-flight tasks");

    const allDone = Promise.all(
      Array.from(this.tasks.values()).map((p) => p.catch(() => undefined)),
    );

    const timedOut = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );

    const result = await Promise.race([allDone, timedOut]);
    if (result === "timeout") {
      logger.warn(
        { remaining: this.tasks.size, taskIds: this.activeIds },
        "drain timeout — some tasks are still running",
      );
      return false;
    }

    logger.info("all in-flight tasks drained");
    return true;
  }

  /**
   * Mark all still-running tasks as interrupted in the database.
   * Called after `drainAll` times out.
   *
   * @param reason — human-readable reason stored in the task record
   * @param markInterrupted — callback that writes the interrupted reason to the DB
   */
  async markAllInterrupted(
    reason: string,
    markInterrupted: (taskId: string, reason: string) => void,
  ): Promise<void> {
    for (const taskId of this.tasks.keys()) {
      try {
        markInterrupted(taskId, reason);
        logger.info({ taskId, reason }, "marked task as interrupted");
      } catch (err) {
        logger.error({ err, taskId }, "failed to mark task as interrupted");
      }
    }
  }
}

/** Singleton shared across the process. */
export const taskRegistry = new TaskRegistry();
