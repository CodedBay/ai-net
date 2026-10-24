/**
 * ai-net backend server entry point.
 *
 * Initializes all agents and starts the HTTP/WebSocket server.
 */

import { createApp } from "./api/app";
import { initializeAgents, globalAgentRegistry } from "./agents";
import { startAgentSync, stopAgentSync } from "./registry/sync";
import { loadConfig } from "./config";
import { AgentCleanupService } from "./services/agentCleanup";
import { createAgentDb, getAgentDb, closeAgentDb } from "./db/agents";
import { closeDb } from "./db/index";
import { closeAuthDb } from "./db/auth";
import { closeJobDb } from "./queue";
import { eventBus } from "./coordinator/eventBus";
import { createDefaultReconciliationService } from "./services/reconciliation";
import { createLogger } from "./utils/logger";
import { redactedConfigSnapshot } from "./config";
import { createTaskDb, getTaskDb, closeTaskDb } from "./db/tasks";
import { TaskResultStorageService } from "./services/taskResultStorage";

async function main() {
  const logger = createLogger({ module: "server" });

  try {
    // ── Validate env config at startup ──────────────────────────────────────────
    const config = loadConfig();
    logger.info({ config: redactedConfigSnapshot(config) }, "starting server");

    // Start agent sync
    startAgentSync();

    // Initialize all agents and register them
    logger.info("initializing agents");
    await initializeAgents();

    // Start agent cleanup service
    const cleanupService = new AgentCleanupService();
    cleanupService.start();

    const taskResultStorage = new TaskResultStorageService(createTaskDb(getTaskDb()));
    taskResultStorage.startCleanup();

    // Start daily payment reconciliation
    const reconciliationService = createDefaultReconciliationService();
    reconciliationService.startDaily(config.RECONCILIATION_INTERVAL_MS);

    // Create and start the server
    const { httpServer, close } = createApp({
      jobWorkerStopTimeoutMs: config.GRACEFUL_SHUTDOWN_TIMEOUT * 1000,
    });

    const port = config.PORT;

    httpServer.listen(port, () => {
      logger.info({ port, env: config.NODE_ENV }, "server listening");
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    setupGracefulShutdown(httpServer, close, config, {
      cleanupService,
      reconciliationService,
      globalAgentRegistry,
    });

  } catch (error) {
    logger.error({ err: error }, "failed to start server");
    process.exit(1);
  }
}

export interface GracefulShutdownExtras {
  cleanupService?: { stop(): void };
  reconciliationService?: { stop(): void };
  globalAgentRegistry?: { shutdown(): void };
}

/**
 * SIGTERM/SIGINT handler: stop accepting new work, drain in-flight jobs and
 * the WebSocket stream, flush the event store, close every database
 * connection, then exit 0 — or force-exit 1 if any of that takes longer
 * than `SHUTDOWN_TIMEOUT_MS` (env) or `config.GRACEFUL_SHUTDOWN_TIMEOUT` seconds.
 *
 * In-flight tasks are drained (via `closeApp`, which awaits the job
 * worker's stop()) rather than force-failed: anything still running when
 * the drain window elapses stays "active" in the job store and is resumed
 * by the next `JobWorker.start()` (`recoverIncompleteJobs()` resets it to
 * "pending" for retry) — see `docs/e2e-testing.md` and
 * `tests/shutdown.test.ts` for the restart-mid-stream scenario.
 *
 * Shutdown order:
 *  1. closeApp()            — stop HTTP/WS, drain job worker
 *  2. stopAgentSync()       — stop background registry sync
 *  3. extras (cleanup, reconciliation, globalAgentRegistry)
 *  4. markAllOffline()      — mark agents offline in the DB
 *  5. eventBus.store.close() — flush event store
 *  6. closeDb / closeAgentDb / closeTaskDb / closeJobDb — close all databases
 *  7. process.exit(0)
 */
export function setupGracefulShutdown(
  httpServer: any,
  closeApp: (callback?: () => void) => void,
  config: { GRACEFUL_SHUTDOWN_TIMEOUT?: number },
  extras: GracefulShutdownExtras = {},
) {
  const logger = createLogger({ module: "shutdown" });
  let isShuttingDown = false;

  // Support SHUTDOWN_TIMEOUT_MS env var as override (in milliseconds)
  const timeoutMs =
    process.env.SHUTDOWN_TIMEOUT_MS !== undefined
      ? parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10)
      : (config.GRACEFUL_SHUTDOWN_TIMEOUT ?? 30) * 1000;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, "starting graceful shutdown sequence");

    const forcedTimeout = setTimeout(() => {
      logger.error({ signal, timeoutMs }, "force-killing timed out shutdown");
      process.exit(1);
    }, timeoutMs);

    try {
      // Phase 1: close HTTP/WS server and drain in-flight job worker
      logger.info("closing http/ws server");
      await new Promise<void>((resolve) => {
        closeApp(() => {
          logger.info("http/ws server closed");
          resolve();
        });
      });

      // Phase 2: stop background services
      logger.info("stopping agent sync and background services");
      stopAgentSync();
      extras.cleanupService?.stop();
      extras.reconciliationService?.stop();
      extras.globalAgentRegistry?.shutdown();

      // Phase 3: mark online agents offline so stale capacity is not advertised
      logger.info("marking online agents offline");
      try {
        const agentDb = createAgentDb(getAgentDb());
        agentDb.markAllOffline();
      } catch (err) {
        logger.error({ err }, "failed to mark agents offline during shutdown");
      }

      // Phase 4: flush event store
      logger.info("flushing event store");
      try {
        eventBus.store.close();
      } catch (err) {
        logger.error({ err }, "failed to close event store during shutdown");
      }

      // Phase 5: close all database connections
      logger.info("closing database connections");
      closeDb();
      closeAgentDb();
      closeTaskDb();
      closeJobDb();
      closeAuthDb();

      logger.info({ signal }, "graceful shutdown complete");
      clearTimeout(forcedTimeout);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during graceful shutdown");
      clearTimeout(forcedTimeout);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return shutdown;
}

if (require.main === module) {
  main();
}
