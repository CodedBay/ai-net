import { AgentDb, createAgentDb, getAgentDb } from "../db/agents";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "heartbeat" });

export interface HeartbeatServiceOptions {
  /** Background interval in ms (default: 30 seconds) */
  intervalMs?: number;
  /** Seconds without a heartbeat before an agent is marked offline (default: 90) */
  staleThresholdSeconds?: number;
  /** Custom AgentDb instance for testing */
  db?: AgentDb;
}

export interface HeartbeatService {
  start: () => void;
  stop: () => void;
}

export function createHeartbeatService(options: HeartbeatServiceOptions = {}): HeartbeatService {
  const intervalMs = options.intervalMs ?? Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000);
  const staleThresholdSeconds = options.staleThresholdSeconds ?? Math.floor(
    Number(process.env.HEARTBEAT_GRACE_PERIOD_MS ?? 90_000) / 1000,
  );
  let timer: NodeJS.Timeout | null = null;

  const getDb = () => options.db ?? createAgentDb(getAgentDb());

  function runCleanup() {
    try {
      const db = getDb();
      const markedOffline = db.markStaleAgents(staleThresholdSeconds);

      if (markedOffline > 0) {
        logger.info(`Heartbeat cleanup: ${markedOffline} marked offline`);
      }
    } catch (err) {
      logger.error({ error: err }, "Heartbeat cleanup failed");
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(runCleanup, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

let defaultService: HeartbeatService | null = null;

export function startHeartbeatService(options: HeartbeatServiceOptions = {}): HeartbeatService {
  if (!defaultService) {
    defaultService = createHeartbeatService(options);
  }
  defaultService.start();
  return defaultService;
}

export function stopHeartbeatService(): void {
  if (defaultService) {
    defaultService.stop();
    defaultService = null;
  }
}
