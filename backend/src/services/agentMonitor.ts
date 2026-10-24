/**
 * AgentMonitorService — polls registered agents' /health endpoints and
 * marks agents online/offline based on consecutive failure counts.
 *
 * ## Memory-leak fix (issue #31)
 *
 * The previous implementation created a new AbortController *and* a new
 * clearTimeout handle on every individual poll call but in certain code
 * paths the timeout handle was not cleared if the fetch threw synchronously,
 * leaving dangling timer references.  More critically, each invocation of
 * `pingAgent` also captured a fresh closure over the fetch signal, which –
 * when combined with environments that attach internal "abort" listeners to
 * the signal object – led to accumulated listener references that were never
 * GC-collected (the signal was kept alive by the timer closure even after the
 * request resolved).
 *
 * The fix:
 * 1. Guarantee `clearTimeout` is always called via `try/finally`.
 * 2. Explicitly `abort()` the controller after the request settles so the
 *    signal's internal listener list is eagerly released.
 * 3. Expose `getActiveControllers()` for test-time verification that no
 *    controllers are leaked between poll cycles.
 */
import { eventBus } from '../coordinator/eventBus';
import type { AgentRegistration, AgentRegistry } from '../types/agent';
import { createLogger } from '../utils/logger';
import { metricsService } from './metrics';
import type pino from 'pino';

export interface AgentMonitorOptions {
  agentRegistry: AgentRegistry;
  intervalMs?: number;
  failureThreshold?: number;
  eventBus?: typeof eventBus;
  logger?: pino.Logger;
  fetchImpl?: typeof fetch;
}

export class AgentMonitorService {
  private readonly registry: AgentRegistry;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly bus: typeof eventBus;
  private readonly log: pino.Logger;
  private readonly fetchImpl: typeof fetch;

  private timer: NodeJS.Timeout | null = null;
  private readonly failureCounts: Map<string, number> = new Map();
  private stopped = true;

  /**
   * Track in-flight AbortControllers so we can verify they are released after
   * each poll cycle (used in tests; negligible overhead in production).
   */
  private readonly activeControllers: Set<AbortController> = new Set();

  constructor(options: AgentMonitorOptions) {
    this.registry = options.agentRegistry;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.bus = options.eventBus ?? eventBus;
    this.log = options.logger ?? createLogger({ component: 'agent-monitor' });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      this.checkAllAgents().catch((err) => {
        this.log.error({ err }, 'Error checking agent health');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopped = true;

    // Abort any in-flight requests so their controllers are released
    // immediately on shutdown rather than waiting for timeout expiry.
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    this.activeControllers.clear();
  }

  async checkAllAgents(): Promise<void> {
    let agents: AgentRegistration[] = [];
    try {
      const res = await this.registry.getAgents();
      agents = Array.isArray(res) ? res : [];
    } catch (err) {
      this.log.error({ err }, 'Failed to fetch registered agents from registry');
      return;
    }

    for (const agent of agents) {
      await this.checkAgentHealth(agent);
    }
  }

  async checkAgentHealth(agent: AgentRegistration): Promise<boolean> {
    const isHealthy = await this.pingAgent(agent);
    const agentId = agent.id;
    const currentFailures = this.failureCounts.get(agentId) ?? 0;

    if (isHealthy) {
      this.failureCounts.set(agentId, 0);
      // Update agent_health_status Prometheus gauge
      metricsService.setAgentHealthStatus(agentId, true);
      if (agent.status === 'offline') {
        agent.status = 'online';
        if (typeof this.registry.markOnline === 'function') {
          await this.registry.markOnline(agentId);
        } else if (typeof this.registry.registerAgent === 'function') {
          await this.registry.registerAgent(agent);
        }
        const timestamp = new Date().toISOString();
        this.bus.emit('system', {
          type: 'AgentRecovered',
          taskId: 'system',
          timestamp,
          payload: { agentId, status: 'online' },
        });
        this.log.info({ agentId }, 'Agent recovered and marked online');
      }
      return true;
    } else {
      const newFailures = currentFailures + 1;
      this.failureCounts.set(agentId, newFailures);

      this.log.warn({ agentId, consecutiveFailures: newFailures }, 'Agent failed health check');

      if (newFailures >= this.failureThreshold && agent.status !== 'offline') {
        agent.status = 'offline';
        // Update agent_health_status Prometheus gauge
        metricsService.setAgentHealthStatus(agentId, false);
        if (typeof this.registry.markOffline === 'function') {
          await this.registry.markOffline(agentId);
        } else if (typeof this.registry.registerAgent === 'function') {
          await this.registry.registerAgent(agent);
        }
        const timestamp = new Date().toISOString();
        const correlationId = `failover-${agentId}-${Date.now()}`;
        this.bus.emit('system', {
          type: 'AgentMarkedOffline',
          taskId: 'system',
          timestamp,
          payload: { agentId, consecutiveFailures: newFailures, status: 'offline', correlationId },
        });
        this.log.warn({ agentId, correlationId, consecutiveFailures: newFailures }, 'Agent marked offline after 3 consecutive failed health checks');
      }
      return false;
    }
  }

  /**
   * Ping a single agent's /health endpoint with a 5-second timeout.
   *
   * Guarantees that:
   * - The timeout handle is **always** cleared (via `finally`).
   * - The AbortController is **always** aborted after the request settles,
   *   which eagerly releases any internal "abort" event listeners attached
   *   by the fetch implementation — preventing accumulation across cycles.
   * - The controller is removed from `activeControllers` in `finally`.
   */
  private async pingAgent(agent: AgentRegistration): Promise<boolean> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const timeout = setTimeout(() => {
      controller.abort();
    }, 5_000);

    try {
      const url = `${agent.endpoint.replace(/\/$/, '')}/health`;
      const response = await this.fetchImpl(url, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Always clear the timer — prevents dangling timer handles even when
      // the abort fires before the fetch resolves.
      clearTimeout(timeout);

      // Abort the controller to release internal signal listeners eagerly.
      // This is safe to call even if the controller has already been aborted
      // (e.g. by the timeout above).
      controller.abort();

      // Remove from active set so it can be GC-collected.
      this.activeControllers.delete(controller);
    }
  }

  getFailureCount(agentId: string): number {
    return this.failureCounts.get(agentId) ?? 0;
  }

  /**
   * Returns the number of AbortControllers currently in-flight.
   * Should be 0 between poll cycles. Exposed for testing.
   */
  getActiveControllerCount(): number {
    return this.activeControllers.size;
  }
}
