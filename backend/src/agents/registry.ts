/**
 * Agent startup and registration manager.
 *
 * Instantiates all agents and handles their self-registration on startup.
 * This class is distinct from the {@link AgentRegistry} interface in
 * `types/agent.ts`, which is the look-up interface used by the coordinator
 * to resolve agents by type.
 */

import { ResearchAgent } from './research/research';
import { RiskAgent } from './risk';
import { CodingAgent } from './coding';
import { DesignAgent } from './design';
import { ReportAgent } from './report';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'agent-registry' });

export interface AgentRegistryConfig {
  apiBaseUrl?: string;
  autoRegister?: boolean;

}

/**
 * Agent startup and registration manager.
 *
 * Instantiates all built-in agents (Research, Risk, Coding, Design, Report)
 * and handles their self-registration and heartbeat lifecycle on startup.
 *
 * This class is distinct from the {@link AgentRegistry} interface in
 * `types/agent.ts`, which is the look-up interface used by the coordinator
 * to resolve agents by type.
 */
export class AgentStartupRegistry {
  private readonly agents: Array<{
    instance: any;
    capability: string;
  }> = [];

  constructor(private config: AgentRegistryConfig = {}) {}

  /**
   * Instantiates all built-in agents and optionally registers each one with
   * the backend API and starts their heartbeat loops.
   *
   * When `config.autoRegister` is `true` (the default), every agent calls its
   * own `register()` and `startHeartbeat()` methods. Registration failures for
   * individual agents are logged but do not abort the overall startup.
   *
   * @returns A promise that resolves once all registration attempts have
   *   settled (regardless of individual outcomes).
   */
  async initialize(): Promise<void> {
    const apiBaseUrl = this.config.apiBaseUrl ?? 'http://127.0.0.1:3001';
    const autoRegister = this.config.autoRegister ?? true;

    // Instantiate all agents
    const researchAgent = new ResearchAgent({ apiBaseUrl });
    const riskAgent = new RiskAgent({ apiBaseUrl });
    const codingAgent = new CodingAgent({ apiBaseUrl });
    const designAgent = new DesignAgent({ apiBaseUrl });
    const reportAgent = new ReportAgent({ apiBaseUrl });

    this.agents.push(
      { instance: researchAgent, capability: 'research' },
      { instance: riskAgent, capability: 'risk' },
      { instance: codingAgent, capability: 'coding' },
      { instance: designAgent, capability: 'design' },
      { instance: reportAgent, capability: 'report' }
    );

    if (autoRegister) {
      logger.info({ agentCount: this.agents.length }, 'registering agents');
      
      const registrations = this.agents.map(async ({ instance, capability }) => {
        try {
          await instance.register();
          instance.startHeartbeat();
        } catch (error) {
          logger.error({ capability, err: error }, 'failed to register agent');
        }
      });

      await Promise.all(registrations);
      logger.info({ agentCount: this.agents.length }, 'agent registration complete');
    }
  }

  /**
   * Stops the heartbeat loop for every registered agent.
   *
   * Errors thrown by individual agents' `stopHeartbeat()` methods are
   * silently swallowed to ensure all agents receive the shutdown signal.
   *
   * @returns A promise that resolves once all stop-heartbeat calls have
   *   settled.
   */
  async shutdown(): Promise<void> {
    for (const { instance } of this.agents) {
      try {
        instance.stopHeartbeat();
      } catch {
        // ignore shutdown errors
      }
    }
  }

  /**
   * Returns a snapshot of all agents currently managed by this registry.
   *
   * @returns Array of objects containing each agent's `capability` string,
   *   its resolved `agentId`, and the underlying `instance`.
   */
  getAgents() {
    return this.agents.map(({ instance, capability }) => ({
      capability,
      agentId: instance.agentId || `${capability}-agent-1`,
      instance,
    }));
  }

  /**
   * Looks up the agent instance that handles a specific capability.
   *
   * @param capability - Capability string to search for (e.g. `"research"`, `"coding"`).
   * @returns The matching agent instance, or `undefined` if no agent with
   *   that capability has been registered.
   */
  getAgentByCapability(capability: string) {
    const agent = this.agents.find(a => a.capability === capability);
    return agent?.instance;
  }

  /**
   * Performs a health check against every registered agent.
   *
   * If an agent exposes a `healthCheck()` method, it is awaited and its
   * boolean result is recorded. Agents without a health-check method are
   * assumed healthy (`true`). Exceptions are caught and recorded as `false`.
   *
   * @returns A promise resolving to a map of `capability → healthy` booleans.
   */
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const { instance, capability } of this.agents) {
      try {
        if (typeof instance.healthCheck === 'function') {
          results[capability] = await instance.healthCheck();
        } else {
          results[capability] = true; // Assume healthy if no health check method
        }
      } catch (error) {
        logger.error({ capability, err: error }, 'agent health check failed');
        results[capability] = false;
      }
    }

    return results;
  }
}

// Default singleton instance for easy usage
export const globalAgentRegistry = new AgentStartupRegistry();

/**
 * Convenience function to initialise all agents at application startup.
 *
 * If a custom `config` is supplied, a fresh {@link AgentStartupRegistry} is
 * created for it; otherwise the module-level singleton
 * (`globalAgentRegistry`) is used.
 *
 * @param config - Optional configuration overrides for the registry.
 * @returns A promise that resolves once agent initialisation is complete.
 */
export async function initializeAgents(config?: AgentRegistryConfig): Promise<void> {
  const registry = config ? new AgentStartupRegistry(config) : globalAgentRegistry;
  await registry.initialize();
}
