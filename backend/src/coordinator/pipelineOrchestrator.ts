/**
 * PipelineOrchestrator — DAG-based multi-agent task execution engine.
 *
 * Responsibilities:
 *  - Execute a DAG of PipelineNodes with parallel execution of independent nodes.
 *  - Track per-node status and timing.
 *  - Propagate failures to dependent nodes (mark them 'skipped').
 *  - Emit typed progress events for WebSocket broadcasting.
 *  - Detect DAG cycles before execution begins.
 *
 * Design rationale: intentionally kept separate from the `Coordinator` class,
 * which handles higher-level concerns (agent discovery, payments, retries).
 * `PipelineOrchestrator` is a pure execution engine that can be composed
 * independently and tested in isolation.
 */

import { EventEmitter } from "events";
import { createLogger } from "../utils/logger";
import type pino from "pino";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentType = "research" | "risk" | "coding" | "design" | "report" | string;

export type PipelineNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PipelineNode {
  /** Unique identifier for this node within the pipeline. */
  id: string;
  /** The type of agent that should execute this node. */
  agentType: AgentType;
  /**
   * Input values for the node. Values may be literal strings or references to
   * prior node outputs using the syntax `$<nodeId>.<field>` (resolved at
   * runtime).
   */
  inputs: Record<string, string>;
  /** IDs of nodes that must complete before this node can start. */
  dependsOn: string[];
}

export type PipelineEventType =
  | "node_started"
  | "node_completed"
  | "node_failed"
  | "node_skipped"
  | "pipeline_started"
  | "pipeline_completed"
  | "pipeline_failed";

export interface PipelineEvent {
  type: PipelineEventType;
  pipelineId: string;
  nodeId?: string;
  timestamp: string;
  durationMs?: number;
  payload?: unknown;
  error?: string;
}

export interface NodeResult {
  nodeId: string;
  status: PipelineNodeStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: unknown;
  error?: string;
}

export interface PipelineResult {
  pipelineId: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  nodes: NodeResult[];
}

/**
 * Function signature for executing a single pipeline node.
 * Implementations should return the node's output or throw on failure.
 */
export type NodeExecutorFn = (
  node: PipelineNode,
  resolvedInputs: Record<string, string>,
  pipelineId: string,
) => Promise<unknown>;

export interface PipelineOrchestratorOptions {
  /** Logger instance (optional, defaults to module logger). */
  logger?: pino.Logger;
  /**
   * Maximum number of nodes running concurrently. Defaults to unbounded
   * (all ready nodes start immediately).
   */
  concurrency?: number;
  /**
   * Timeout in milliseconds per node. Defaults to 60 000 ms.
   * Set to 0 to disable.
   */
  nodeTimeoutMs?: number;
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Detects cycles in the DAG using DFS with a three-colour mark.
 * @throws {Error} if a cycle is detected, with the cycle path in the message.
 */
export function detectCycles(nodes: PipelineNode[]): void {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // white = unvisited, gray = in current path, black = done
  const color = new Map<string, "white" | "gray" | "black">();
  for (const n of nodes) color.set(n.id, "white");

  const path: string[] = [];

  function dfs(id: string): void {
    if (!nodeById.has(id)) {
      // Unknown dependency — not our concern here (validates in orchestrator)
      return;
    }
    const c = color.get(id)!;
    if (c === "black") return;
    if (c === "gray") {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id];
      throw new Error(`DAG cycle detected: ${cycle.join(" → ")}`);
    }
    color.set(id, "gray");
    path.push(id);
    for (const dep of nodeById.get(id)!.dependsOn) {
      dfs(dep);
    }
    path.pop();
    color.set(id, "black");
  }

  for (const n of nodes) {
    if (color.get(n.id) === "white") dfs(n.id);
  }
}

// ─── Reference resolver ────────────────────────────────────────────────────────

/**
 * Resolves `$<nodeId>.<field>` references in input values using completed
 * node outputs. Falls back to the original literal if no match found.
 */
function resolveInputs(
  inputs: Record<string, string>,
  outputs: Map<string, unknown>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const match = /^\$([^.]+)\.(.+)$/.exec(value);
    if (match) {
      const [, nodeId, field] = match;
      const nodeOutput = outputs.get(nodeId);
      if (nodeOutput && typeof nodeOutput === "object" && nodeOutput !== null) {
        const fieldValue = (nodeOutput as Record<string, unknown>)[field];
        resolved[key] = fieldValue !== undefined ? String(fieldValue) : value;
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

class ConcurrencyLimiter {
  private readonly queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        work()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };

      if (this.active < this.limit) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }
}

// ─── PipelineOrchestrator ─────────────────────────────────────────────────────

/**
 * Executes a DAG of {@link PipelineNode}s using the provided executor function.
 *
 * Usage:
 * ```ts
 * const orchestrator = new PipelineOrchestrator(myExecutor, { concurrency: 3 });
 * const result = await orchestrator.run("pipeline-1", nodes);
 * orchestrator.on("event", (e) => broadcastOverWebSocket(e));
 * ```
 */
export class PipelineOrchestrator extends EventEmitter {
  private readonly executor: NodeExecutorFn;
  private readonly log: pino.Logger;
  private readonly limiter: ConcurrencyLimiter | null;
  private readonly nodeTimeoutMs: number;

  constructor(executor: NodeExecutorFn, options: PipelineOrchestratorOptions = {}) {
    super();
    this.executor = executor;
    this.log = options.logger ?? createLogger({ component: "PipelineOrchestrator" });
    this.limiter =
      options.concurrency !== undefined && options.concurrency > 0
        ? new ConcurrencyLimiter(options.concurrency)
        : null;
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 60_000;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Executes the pipeline described by `nodes`.
   *
   * @param pipelineId  Opaque identifier for this pipeline run (used in events).
   * @param nodes       The DAG nodes to execute.
   * @returns           A {@link PipelineResult} summarising the run.
   * @throws            If a DAG cycle is detected before execution starts.
   */
  async run(pipelineId: string, nodes: PipelineNode[]): Promise<PipelineResult> {
    // Validate DAG — throws if cycle detected
    detectCycles(nodes);

    // Validate dependency references
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) {
          throw new Error(
            `Node "${node.id}" depends on unknown node "${dep}"`,
          );
        }
      }
    }

    const startedAt = new Date().toISOString();
    const pipelineStart = Date.now();

    this.emit("event", {
      type: "pipeline_started",
      pipelineId,
      timestamp: startedAt,
      payload: { nodeCount: nodes.length },
    } satisfies PipelineEvent);

    this.log.info({ pipelineId, nodeCount: nodes.length }, "pipeline started");

    // Mutable runtime state
    const nodeResults = new Map<string, NodeResult>(
      nodes.map((n) => [n.id, { nodeId: n.id, status: "pending" }]),
    );
    const outputs = new Map<string, unknown>();
    const completed = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();
    const scheduled = new Set<string>();
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        if (completed.size + failed.size + skipped.size < nodes.length) return;
        settled = true;
        resolve();
      };

      /**
       * Marks all nodes whose dependencies include a failed/skipped node as
       * 'skipped', then checks whether we're done.
       */
      const propagateFailures = (): void => {
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of nodes) {
            if (nodeResults.get(node.id)!.status !== "pending") continue;
            const blockedByFailed = node.dependsOn.some(
              (dep) => failed.has(dep) || skipped.has(dep),
            );
            if (blockedByFailed) {
              const result = nodeResults.get(node.id)!;
              result.status = "skipped";
              skipped.add(node.id);
              changed = true;

              const ev: PipelineEvent = {
                type: "node_skipped",
                pipelineId,
                nodeId: node.id,
                timestamp: new Date().toISOString(),
                payload: { reason: "upstream_failed" },
              };
              this.emit("event", ev);
              this.log.warn(
                { pipelineId, nodeId: node.id },
                "node skipped due to upstream failure",
              );
            }
          }
        }
        finish();
      };

      /** Starts all nodes whose dependencies are satisfied and not yet scheduled. */
      const scheduleReady = (): void => {
        for (const node of nodes) {
          if (scheduled.has(node.id)) continue;
          if (nodeResults.get(node.id)!.status !== "pending") continue;
          const depsOk = node.dependsOn.every((dep) => completed.has(dep));
          if (!depsOk) continue;

          scheduled.add(node.id);

          const runNode = async (): Promise<void> => {
            const nodeStart = Date.now();
            const startTs = new Date().toISOString();
            const result = nodeResults.get(node.id)!;
            result.status = "running";
            result.startedAt = startTs;

            const startEv: PipelineEvent = {
              type: "node_started",
              pipelineId,
              nodeId: node.id,
              timestamp: startTs,
            };
            this.emit("event", startEv);
            this.log.info(
              { pipelineId, nodeId: node.id, agentType: node.agentType },
              "node started",
            );

            try {
              const resolvedInputs = resolveInputs(node.inputs, outputs);

              let execution: Promise<unknown> = this.executor(
                node,
                resolvedInputs,
                pipelineId,
              );

              if (this.nodeTimeoutMs > 0) {
                execution = Promise.race([
                  execution,
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`Node "${node.id}" timed out after ${this.nodeTimeoutMs}ms`)),
                      this.nodeTimeoutMs,
                    ),
                  ),
                ]);
              }

              const output = await execution;

              const durationMs = Date.now() - nodeStart;
              result.status = "completed";
              result.completedAt = new Date().toISOString();
              result.durationMs = durationMs;
              result.output = output;
              outputs.set(node.id, output);
              completed.add(node.id);

              const completeEv: PipelineEvent = {
                type: "node_completed",
                pipelineId,
                nodeId: node.id,
                timestamp: result.completedAt,
                durationMs,
                payload: output,
              };
              this.emit("event", completeEv);
              this.log.info(
                { pipelineId, nodeId: node.id, durationMs },
                "node completed",
              );

              scheduleReady();
              finish();
            } catch (err) {
              const durationMs = Date.now() - nodeStart;
              const errorMsg = err instanceof Error ? err.message : String(err);
              result.status = "failed";
              result.completedAt = new Date().toISOString();
              result.durationMs = durationMs;
              result.error = errorMsg;
              failed.add(node.id);

              const failEv: PipelineEvent = {
                type: "node_failed",
                pipelineId,
                nodeId: node.id,
                timestamp: result.completedAt,
                durationMs,
                error: errorMsg,
              };
              this.emit("event", failEv);
              this.log.error(
                { pipelineId, nodeId: node.id, err },
                "node failed",
              );

              propagateFailures();
            }
          };

          // Apply concurrency limit if configured
          if (this.limiter) {
            this.limiter.run(runNode).catch((err) => {
              this.log.error({ pipelineId, nodeId: node.id, err }, "runNode threw unexpectedly");
            });
          } else {
            runNode().catch((err) => {
              this.log.error({ pipelineId, nodeId: node.id, err }, "runNode threw unexpectedly");
            });
          }
        }

        // If nothing was scheduled and nothing is running, check for deadlock
        const allSettled = [...nodeResults.values()].every(
          (r) => r.status !== "pending" && r.status !== "running",
        );
        if (allSettled) finish();
      };

      // Kick off the first wave
      scheduleReady();

      // Edge case: empty DAG
      if (nodes.length === 0) resolve();
    });

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - pipelineStart;
    const anyFailed = failed.size > 0 || skipped.size > 0;
    const pipelineStatus: PipelineResult["status"] = anyFailed ? "failed" : "completed";

    const pipelineResult: PipelineResult = {
      pipelineId,
      status: pipelineStatus,
      startedAt,
      completedAt,
      durationMs,
      nodes: [...nodeResults.values()],
    };

    const finishEv: PipelineEvent = {
      type: anyFailed ? "pipeline_failed" : "pipeline_completed",
      pipelineId,
      timestamp: completedAt,
      durationMs,
      payload: {
        completed: completed.size,
        failed: failed.size,
        skipped: skipped.size,
      },
    };
    this.emit("event", finishEv);

    this.log.info(
      { pipelineId, status: pipelineStatus, durationMs, completed: completed.size, failed: failed.size, skipped: skipped.size },
      "pipeline finished",
    );

    return pipelineResult;
  }

  /**
   * Typed event emitter overloads for IDE support.
   */
  override on(event: "event", listener: (e: PipelineEvent) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: "event", payload: PipelineEvent): boolean;
  override emit(event: string, ...args: unknown[]): boolean;
  override emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
