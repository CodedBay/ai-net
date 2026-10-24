/**
 * Test data factories for ai-net backend domain models.
 *
 * Each factory function accepts a `Partial<T>` override bag so callers can
 * customise only the fields they care about while receiving valid defaults for
 * the rest. A shared counter ensures every call produces a unique ID, avoiding
 * collisions when multiple objects are created in the same test suite.
 *
 * IMPORTANT: All values produced here are synthetic placeholders.
 * No real Stellar keys, credentials, or API tokens are ever used.
 *
 * @module factories
 */

import type { AgentRecord } from "../../src/db/agents";
import type { PaymentRecord, PaymentStatus } from "../../src/db/index";
import type { AgentTask } from "../../src/agents/base/BaseAgent";
import type { TaskEvent } from "../../src/db/tasks";
import type { AdminAuditEntry } from "../../src/services/adminControl";
import { KNOWN_FLAGS, getAllFlags, type FeatureFlag } from "../../src/services/featureFlags";
import type { QualityScore } from "../../src/services/qualityScorer.types";
import type { Task, DAGNode, TaskStatus, NodeStatus } from "../../src/types/task";

// ─────────────────────────────────────────────────────────────────────────────
//  Internal counter — monotonically increasing, reset between test files if
//  you need isolated sequences (call `resetFactoryCounter()`).
// ─────────────────────────────────────────────────────────────────────────────

let _counter = 0;

/** Returns the next unique counter value. */
function nextId(): number {
  return ++_counter;
}

/**
 * Resets the internal factory counter to zero.
 *
 * Call this in a `beforeEach` / `beforeAll` hook when you need predictable,
 * repeatable IDs within a test suite.
 */
export function resetFactoryCounter(): void {
  _counter = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Wallet factory
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic Stellar-style wallet pair used exclusively in tests. */
export interface WalletPair {
  /** 56-character test placeholder that starts with 'G' (never a real key). */
  publicKey: string;
  /** 56-character test placeholder that starts with 'S' (never a real key). */
  secretKey: string;
}

/**
 * Produces a synthetic Stellar-style wallet key pair for test purposes.
 *
 * The keys are deterministic placeholders that start with 'G' and 'S'
 * respectively and are exactly 56 alphanumeric characters long, matching the
 * visual shape of real Stellar keys without ever being valid on-chain.
 *
 * @param n - optional numeric suffix; defaults to the next factory counter value.
 * @returns A `WalletPair` with `publicKey` and `secretKey`.
 *
 * @example
 * const wallet = makeWallet();
 * // { publicKey: 'GTESTWALLETKEY000000000000000000000000000000000000000001',
 * //   secretKey: 'STESTWALLETKEY000000000000000000000000000000000000000001' }
 */
export function makeWallet(n?: number): WalletPair {
  const seq = n ?? nextId();
  // Pad with zeros so the result is always exactly 56 chars.
  const suffix = String(seq).padStart(42, "0");
  return {
    publicKey: `GTESTWALLETKEY${suffix}`,
    secretKey: `STESTWALLETKEY${suffix}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  AgentRecord factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a valid {@link AgentRecord} populated with sensible defaults.
 *
 * Every call increments the internal counter so that `id` and
 * `stellarPublicKey` are unique across the test run.
 *
 * @param overrides - Any subset of `AgentRecord` fields to override.
 * @returns A complete `AgentRecord` ready for use in tests.
 *
 * @example
 * const agent = makeAgentRecord({ status: 'offline', pricingXLM: 5 });
 */
export function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const seq = nextId();
  const wallet = makeWallet(seq);
  const now = new Date().toISOString();

  return {
    id: `agent-${seq}`,
    capabilities: ["research"],
    pricingXLM: 1.0,
    endpoint: `http://localhost:${3000 + seq}/health`,
    stellarPublicKey: wallet.publicKey,
    reputationScore: 2.5,
    lastSeenAt: now,
    status: "online",
    bondAmountXLM: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    lastActiveAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PaymentRecord factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a valid {@link PaymentRecord} populated with sensible defaults.
 *
 * @param overrides - Any subset of `PaymentRecord` fields to override.
 * @returns A complete `PaymentRecord` ready for use in tests.
 *
 * @example
 * const payment = makePaymentRecord({ status: 'released', amountStroops: 5_000_000n });
 */
export function makePaymentRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const seq = nextId();

  return {
    taskId: `task-${seq}`,
    nodeId: `node-${seq}`,
    balanceId: `balance-${seq}`,
    status: "locked" as PaymentStatus,
    amountStroops: BigInt(1_000_000),
    txHash: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  DAGNode factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a valid {@link DAGNode} with sensible defaults.
 *
 * @param overrides - Any subset of `DAGNode` fields to override.
 * @returns A complete `DAGNode` ready for use in tests.
 *
 * @example
 * const node = makeDAGNode({ type: 'research', status: 'completed' });
 */
export function makeDAGNode(overrides: Partial<DAGNode> = {}): DAGNode {
  const seq = nextId();

  return {
    nodeId: `node-${seq}`,
    type: "research",
    dependencies: [],
    status: "pending" as NodeStatus,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Task factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a valid {@link Task} populated with sensible defaults.
 *
 * @param overrides - Any subset of `Task` fields to override.
 * @returns A complete `Task` ready for use in tests.
 *
 * @example
 * const task = makeTask({ status: 'running', prompt: 'Analyse solar market.' });
 */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const seq = nextId();
  const wallet = makeWallet(seq);
  const now = new Date().toISOString();

  return {
    id: `task-${seq}`,
    prompt: `Test task prompt ${seq}`,
    walletPublicKey: wallet.publicKey,
    status: "queued" as TaskStatus,
    dag: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pipeline DAG factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a sequential pipeline DAG with `n` nodes where each node depends on
 * the previous one. The result can be used as the `dag` field of a `Task`.
 *
 * ```
 * node-1 ──► node-2 ──► node-3 ──► … ──► node-n
 * ```
 *
 * @param n - Number of nodes (must be >= 1).
 * @param nodeOverrides - Optional partial overrides applied to every node.
 * @returns An array of `DAGNode` objects with sequential dependencies.
 *
 * @example
 * const dag = makePipelineDAG(3);
 * // dag[0].dependencies === []
 * // dag[1].dependencies === [dag[0].nodeId]
 * // dag[2].dependencies === [dag[1].nodeId]
 *
 * const task = makeTask({ dag: makePipelineDAG(4) });
 */
export function makePipelineDAG(n: number, nodeOverrides: Partial<DAGNode> = {}): DAGNode[] {
  if (n < 1) {
    throw new RangeError(`makePipelineDAG: n must be >= 1, got ${n}`);
  }

  const nodes: DAGNode[] = [];
  const nodeTypes = ["research", "risk", "coding", "design", "report"];

  for (let i = 0; i < n; i++) {
    const seq = nextId();
    const type = nodeTypes[i % nodeTypes.length];
    const dependencies = i === 0 ? [] : [nodes[i - 1].nodeId];

    nodes.push({
      nodeId: `pipeline-node-${seq}`,
      type,
      dependencies,
      status: "pending" as NodeStatus,
      prompt: `Step ${i + 1} of ${n}: ${type}`,
      description: `Pipeline step ${i + 1}`,
      ...nodeOverrides,
    });
  }

  return nodes;
}

/**
 * Creates a {@link Task} whose `dag` is a sequential pipeline of `n` nodes.
 *
 * Shorthand for `makeTask({ dag: makePipelineDAG(n) })`.
 *
 * @param n - Number of DAG nodes.
 * @param taskOverrides - Optional partial overrides for the wrapping `Task`.
 * @returns A complete `Task` with a sequential DAG.
 *
 * @example
 * const task = makePipelineTask(3, { status: 'running' });
 */
export function makePipelineTask(n: number, taskOverrides: Partial<Task> = {}): Task {
  const dag = makePipelineDAG(n);
  return makeTask({ dag, ...taskOverrides });
}
type Factory<T> = {
  /** Return a fresh default value with optional top-level overrides. */
  create(overrides?: Partial<T>): T;
};

function defineFactory<T>(defaults: () => T): Factory<T> {
  return {
    create(overrides = {}) {
      return { ...defaults(), ...overrides };
    },
  };
}

/** Factory for registered backend agents. */
export const agentFactory = defineFactory<AgentRecord>(() => ({
  id: "agent_test_1",
  capabilities: ["research"],
  pricingXLM: 0.25,
  endpoint: "http://127.0.0.1:4000",
  stellarPublicKey: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
  reputationScore: 4.5,
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  status: "online",
}));

/** Factory for persisted task records, including a valid empty DAG by default. */
export const taskFactory = defineFactory<Task>(() => ({
  id: "task_test_1",
  prompt: "Research renewable energy market trends",
  walletPublicKey: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
  status: "queued",
  dag: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

/** Factory for the per-agent task payload consumed by backend agents. */
export const subTaskFactory = defineFactory<AgentTask>(() => ({
  taskId: "task_test_1",
  nodeId: "node_test_1",
  prompt: "Research renewable energy market trends",
  context: "Test context",
  upstreamResults: [],
}));

/** Factory for payment database records. */
export const paymentFactory = defineFactory<PaymentRecord>(() => ({
  taskId: "task_test_1",
  nodeId: "node_test_1",
  balanceId: "balance_test_1",
  status: "locked",
  amountStroops: 2_500_000n,
  txHash: null,
}));

/** Factory for administrative audit log entries. */
export const auditLogEntryFactory = defineFactory<AdminAuditEntry>(() => ({
  at: "2026-01-01T00:00:00.000Z",
  actor: "test-admin",
  action: "test.action",
  target: "task_test_1",
  statusCode: 200,
  requestId: "request_test_1",
  details: { source: "test" },
}));

/** Test-only shape for outbound webhook delivery data; the backend has no persisted delivery model. */
export interface WebhookDelivery {
  id: string;
  url: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
}

/** Factory for webhook delivery fixtures used by tests. */
export const webhookDeliveryFactory = defineFactory<WebhookDelivery>(() => ({
  id: "webhook_delivery_test_1",
  url: "https://example.test/webhooks/events",
  event: "task.completed",
  payload: { taskId: "task_test_1" },
  status: "pending",
  attempts: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  deliveredAt: null,
}));

/** Factory for scored agent outputs. */
export const qualityScoreFactory = defineFactory<QualityScore>(() => ({
  score: 85,
  completeness: { score: 90, reason: "All required sections are present." },
  relevance: { score: 85, reason: "The output addresses the task prompt." },
  format: { score: 80, reason: "The output follows the requested format." },
  needsReview: false,
  reviewed: false,
  timestamp: "2026-01-01T00:00:00.000Z",
}));

/** A snapshot entry returned by the feature-flag service. */
export type FeatureFlagState = ReturnType<typeof getAllFlags>[FeatureFlag];

/** Factory for feature-flag state snapshots returned by the backend service. */
export const featureFlagFactory = {
  create(
    overrides: Partial<FeatureFlagState> & { flag?: FeatureFlag } = {},
  ): FeatureFlagState {
    const { flag = KNOWN_FLAGS[0], ...stateOverrides } = overrides;
    return {
      ...getAllFlags()[flag],
      ...stateOverrides,
    };
  },
};

/** Factory for task event rows stored by the backend task database. */
export const eventRecordFactory = defineFactory<TaskEvent>(() => ({
  type: "node_completed",
  taskId: "task_test_1",
  nodeId: "node_test_1",
  payload: { result: "completed" },
  timestamp: "2026-01-01T00:00:00.000Z",
}));

export interface PipelineFixture {
  coordinator: AgentRecord;
  agents: AgentRecord[];
  tasks: Task[];
}

/** Build a coordinator, the requested worker agents, and one assigned task per worker. */
export function createPipeline(agentCount = 5): PipelineFixture {
  if (!Number.isInteger(agentCount) || agentCount < 0) {
    throw new RangeError("agentCount must be a non-negative integer");
  }

  const coordinator = agentFactory.create({
    id: "coordinator_test_1",
    capabilities: ["coordination"],
  });
  const agents = Array.from({ length: agentCount }, (_, index) =>
    agentFactory.create({
      id: `agent_test_${index + 1}`,
      capabilities: [index % 2 === 0 ? "research" : "coding"],
    }),
  );
  const tasks = agents.map((agent, index) => {
    const node: DAGNode = {
      nodeId: `node_test_${index + 1}`,
      type: agent.capabilities[0],
      dependencies: [],
      status: "pending",
    };
    return taskFactory.create({
      id: `task_test_${index + 1}`,
      dag: [node],
    });
  });

  return { coordinator, agents, tasks };
}

export type TaskStoreEventStatus = "Pending" | "Running" | "Completed" | "Failed";

export interface OnChainTaskCreatedEvent {
  version: 1;
  task_id: string;
  prompt_hash: string;
  assigned_agents: string[];
  created_at: number;
  expires_at: number;
}

export interface OnChainTaskUpdatedEvent {
  version: 1;
  task_id: string;
  agent: string;
  old_status: TaskStoreEventStatus;
  new_status: TaskStoreEventStatus;
  updated_at: number;
}

export interface OnChainTaskFinalizedEvent {
  version: 1;
  task_id: string;
  agent: string;
  old_status: TaskStoreEventStatus;
  final_status: "Completed" | "Failed";
  finalized_at: number;
}

export interface OnChainOracleManagerSetEvent {
  topics: ["task_str", "ora_set"];
  data: string | null;
}

export interface OnChainTaskStoreUpgradedEvent {
  topics: ["task_str", "upgraded"];
  data: [oldVersion: string, newVersion: string, wasmHash: string, admin: string, ledgerSequence: number];
}

export type OnChainTaskStoreEvent =
  | { topics: ["task_meta", "created"]; data: OnChainTaskCreatedEvent }
  | { topics: ["task_meta", "updated"]; data: OnChainTaskUpdatedEvent }
  | { topics: ["task_meta", "finalized"]; data: OnChainTaskFinalizedEvent }
  | OnChainOracleManagerSetEvent
  | OnChainTaskStoreUpgradedEvent;

/** Create a task_store `created` contract event fixture. */
export function createTaskCreatedEvent(
  overrides: Partial<OnChainTaskCreatedEvent> = {},
): Extract<OnChainTaskStoreEvent, { topics: ["task_meta", "created"] }> {
  return {
    topics: ["task_meta", "created"],
    data: {
      version: 1,
      task_id: "a".repeat(64),
      prompt_hash: "b".repeat(64),
      assigned_agents: ["GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN"],
      created_at: 1_735_689_600,
      expires_at: 1_736_899_200,
      ...overrides,
    },
  };
}

/** Create a task_store `updated` contract event fixture. */
export function createTaskUpdatedEvent(
  overrides: Partial<OnChainTaskUpdatedEvent> = {},
): Extract<OnChainTaskStoreEvent, { topics: ["task_meta", "updated"] }> {
  return {
    topics: ["task_meta", "updated"],
    data: {
      version: 1,
      task_id: "a".repeat(64),
      agent: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
      old_status: "Pending",
      new_status: "Running",
      updated_at: 1_735_689_600,
      ...overrides,
    },
  };
}

/** Create a task_store `finalized` contract event fixture. */
export function createTaskFinalizedEvent(
  overrides: Partial<OnChainTaskFinalizedEvent> = {},
): Extract<OnChainTaskStoreEvent, { topics: ["task_meta", "finalized"] }> {
  return {
    topics: ["task_meta", "finalized"],
    data: {
      version: 1,
      task_id: "a".repeat(64),
      agent: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
      old_status: "Running",
      final_status: "Completed",
      finalized_at: 1_735_689_600,
      ...overrides,
    },
  };
}

/** Create a task_store oracle-manager configuration event fixture. */
export function createOracleManagerSetEvent(
  address: string | null = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
): OnChainOracleManagerSetEvent {
  return { topics: ["task_str", "ora_set"], data: address };
}

/** Create a task_store contract-upgrade event fixture. */
export function createTaskStoreUpgradedEvent(
  data: OnChainTaskStoreUpgradedEvent["data"] = [
    "1.0.0",
    "1.1.0",
    "c".repeat(64),
    "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGDG6NXGPTVMLHK4HZ7HHNN",
    1,
  ],
): OnChainTaskStoreUpgradedEvent {
  return { topics: ["task_str", "upgraded"], data };
}
