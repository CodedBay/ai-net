import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'agent-heartbeat' });

export interface HeartbeatClientOptions {
  apiBaseUrl: string;
  agentId: string;
  intervalMs?: number;
  failureThreshold?: number;
  onFailureThresholdReached?: (consecutiveFailures: number) => void;
}

export class HeartbeatClient {
  private readonly apiBaseUrl: string;
  private readonly agentId: string;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly onFailureThresholdReached?: (consecutiveFailures: number) => void;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(options: HeartbeatClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.agentId = options.agentId;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.onFailureThresholdReached = options.onFailureThresholdReached;
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.send();
    this.interval = setInterval(() => {
      this.send();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.stopped = true;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  private async send(): Promise<void> {
    if (this.stopped) return;

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/agents/${encodeURIComponent(this.agentId)}/heartbeat`, {
        method: 'POST',
      });
      if (!response.ok) {
        this.consecutiveFailures += 1;
        logger.warn(
          { agentId: this.agentId, status: response.status, failureCount: this.consecutiveFailures },
          'agent heartbeat failed',
        );
        if (this.consecutiveFailures >= this.failureThreshold && this.onFailureThresholdReached) {
          this.onFailureThresholdReached(this.consecutiveFailures);
        }
      } else {
        this.consecutiveFailures = 0;
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      logger.warn(
        { agentId: this.agentId, failureCount: this.consecutiveFailures, err },
        'agent heartbeat request failed',
      );
      if (this.consecutiveFailures >= this.failureThreshold && this.onFailureThresholdReached) {
        this.onFailureThresholdReached(this.consecutiveFailures);
      }
    }
  }
}

