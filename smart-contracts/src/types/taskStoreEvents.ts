/**
 * TypeScript type definitions for on-chain task_store contract events.
 *
 * These types mirror the Soroban `#[contracttype]` structs defined in
 * `contracts/task_store/src/types.rs` and documented in
 * `docs/TASK_STORE_EVENTS.md`.
 *
 * Every event payload includes a `version` field as its first member so
 * off-chain consumers can detect schema changes and decode accordingly.
 *
 * Version history:
 *  - v1: Initial schema (current).
 *  - v2+: Future additive or breaking changes — see migration path in
 *    TASK_STORE_EVENTS.md.
 *
 * @see smart-contracts/docs/TASK_STORE_EVENTS.md
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** 32-byte hash as a hex string (e.g. SHA-256 output). */
export type BytesN32 = string;

/** On-chain Address in Stellar strkey format (e.g. "G..."). */
export type StellarAddress = string;

/** Task status enum — mirrors `TaskStatus` in the Rust contract. */
export enum TaskStatus {
  Pending = 0,
  Running = 1,
  Completed = 2,
  Failed = 3,
}

// ---------------------------------------------------------------------------
// Schema version constants
// ---------------------------------------------------------------------------

/** Current lifecycle event schema version. */
export const TASK_LIFECYCLE_EVENT_VERSION = 1 as const;

/** Current configuration event schema version. */
export const TASK_CONFIG_EVENT_VERSION = 1 as const;

/** Minimum supported event version (inclusive). */
export const MIN_SUPPORTED_EVENT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Event topic identifiers
// ---------------------------------------------------------------------------

/** Topic 1 for lifecycle events. */
export const LIFECYCLE_TOPIC = 'task_meta' as const;

/** Topic 1 for configuration events. */
export const CONFIG_TOPIC = 'task_str' as const;

/** Topic 2 values for lifecycle events. */
export const LIFECYCLE_TOPICS = {
  created: 'created' as const,
  updated: 'updated' as const,
  finalized: 'finalized' as const,
};

/** Topic 2 values for configuration events. */
export const CONFIG_TOPICS = {
  coordSet: 'coord_set' as const,
  oraSet: 'ora_set' as const,
  upgraded: 'upgraded' as const,
};

// ---------------------------------------------------------------------------
// v1 Lifecycle event schemas
// ---------------------------------------------------------------------------

/**
 * Emitted once when `store_task_metadata` succeeds.
 * Topics: `(task_meta, created)`
 */
export interface TaskCreatedEvent {
  readonly version: number;
  readonly task_id: BytesN32;
  readonly prompt_hash: BytesN32;
  readonly assigned_agents: StellarAddress[];
  readonly created_at: number;
  readonly expires_at: number;
  /** Oracle-quoted price in stroops; `null` if no oracle configured. */
  readonly quoted_price_stroops: number | null;
}

/**
 * Emitted for a successful non-terminal status transition
 * (currently only `Pending → Running`).
 * Topics: `(task_meta, updated)`
 */
export interface TaskUpdatedEvent {
  readonly version: number;
  readonly task_id: BytesN32;
  readonly agent: StellarAddress;
  readonly old_status: TaskStatus;
  readonly new_status: TaskStatus;
  readonly updated_at: number;
}

/**
 * Emitted for a successful transition into a terminal status
 * (`Completed` or `Failed`).
 * Topics: `(task_meta, finalized)`
 */
export interface TaskFinalizedEvent {
  readonly version: number;
  readonly task_id: BytesN32;
  readonly agent: StellarAddress;
  readonly old_status: TaskStatus;
  readonly final_status: TaskStatus;
  readonly finalized_at: number;
}

// ---------------------------------------------------------------------------
// v1 Configuration event schemas
// ---------------------------------------------------------------------------

/**
 * Emitted when the admin sets or rotates the coordinator address.
 * Topics: `(task_str, coord_set)`
 */
export interface CoordinatorSetEvent {
  readonly version: number;
  readonly coordinator: StellarAddress;
}

/**
 * Emitted when the admin sets or clears the OracleManager address.
 * Topics: `(task_str, ora_set)`
 */
export interface OracleManagerSetEvent {
  readonly version: number;
  readonly oracle_manager: StellarAddress | null;
}

/**
 * Emitted when the contract is upgraded via `upgrade()`.
 * Topics: `(task_str, upgraded)`
 */
export interface ContractUpgradedEvent {
  readonly version: number;
  readonly old_version: string;
  readonly new_version: string;
  readonly new_wasm_hash: BytesN32;
  readonly admin: StellarAddress;
  readonly ledger_sequence: number;
}

// ---------------------------------------------------------------------------
// Discriminated union of all task_store events
// ---------------------------------------------------------------------------

export type TaskStoreEvent =
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | TaskFinalizedEvent
  | CoordinatorSetEvent
  | OracleManagerSetEvent
  | ContractUpgradedEvent;

// ---------------------------------------------------------------------------
// Topic-pair discriminators for narrowing decoded events
// ---------------------------------------------------------------------------

export interface TaskStoreEventTopic {
  readonly topic0: string;
  readonly topic1: string;
}

export const TASK_CREATED_TOPIC: TaskStoreEventTopic = {
  topic0: LIFECYCLE_TOPIC,
  topic1: LIFECYCLE_TOPICS.created,
};

export const TASK_UPDATED_TOPIC: TaskStoreEventTopic = {
  topic0: LIFECYCLE_TOPIC,
  topic1: LIFECYCLE_TOPICS.updated,
};

export const TASK_FINALIZED_TOPIC: TaskStoreEventTopic = {
  topic0: LIFECYCLE_TOPIC,
  topic1: LIFECYCLE_TOPICS.finalized,
};

export const COORDINATOR_SET_TOPIC: TaskStoreEventTopic = {
  topic0: CONFIG_TOPIC,
  topic1: CONFIG_TOPICS.coordSet,
};

export const ORACLE_MANAGER_SET_TOPIC: TaskStoreEventTopic = {
  topic0: CONFIG_TOPIC,
  topic1: CONFIG_TOPICS.oraSet,
};

export const CONTRACT_UPGRADED_TOPIC: TaskStoreEventTopic = {
  topic0: CONFIG_TOPIC,
  topic1: CONFIG_TOPICS.upgraded,
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Check whether a decoded event matches the given topic pair. */
export function matchesTopic(
  event: { topic0: string; topic1: string },
  expected: TaskStoreEventTopic,
): boolean {
  return event.topic0 === expected.topic0 && event.topic1 === expected.topic1;
}

export function isTaskCreatedEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof TASK_CREATED_TOPIC {
  return matchesTopic(topics, TASK_CREATED_TOPIC);
}

export function isTaskUpdatedEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof TASK_UPDATED_TOPIC {
  return matchesTopic(topics, TASK_UPDATED_TOPIC);
}

export function isTaskFinalizedEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof TASK_FINALIZED_TOPIC {
  return matchesTopic(topics, TASK_FINALIZED_TOPIC);
}

export function isCoordinatorSetEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof COORDINATOR_SET_TOPIC {
  return matchesTopic(topics, COORDINATOR_SET_TOPIC);
}

export function isOracleManagerSetEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof ORACLE_MANAGER_SET_TOPIC {
  return matchesTopic(topics, ORACLE_MANAGER_SET_TOPIC);
}

export function isContractUpgradedEvent(
  topics: TaskStoreEventTopic,
  _data: unknown,
): topics is typeof CONTRACT_UPGRADED_TOPIC {
  return matchesTopic(topics, CONTRACT_UPGRADED_TOPIC);
}

// ---------------------------------------------------------------------------
// Version-aware decoder helper
// ---------------------------------------------------------------------------

/**
 * Decode a task_store event payload, branching on the version field if
 * multiple versions are supported.
 *
 * @param topics - The two-topic pair from the Soroban event.
 * @param data   - The raw decoded payload (from `scValToNative`).
 * @returns      - A typed `TaskStoreEvent` or `null` if the topic pair is
 *                not recognised.
 */
export function decodeTaskStoreEvent(
  topics: TaskStoreEventTopic,
  data: Record<string, unknown>,
): TaskStoreEvent | null {
  if (matchesTopic(topics, TASK_CREATED_TOPIC)) {
    return data as unknown as TaskCreatedEvent;
  }
  if (matchesTopic(topics, TASK_UPDATED_TOPIC)) {
    return data as unknown as TaskUpdatedEvent;
  }
  if (matchesTopic(topics, TASK_FINALIZED_TOPIC)) {
    return data as unknown as TaskFinalizedEvent;
  }
  if (matchesTopic(topics, COORDINATOR_SET_TOPIC)) {
    return data as unknown as CoordinatorSetEvent;
  }
  if (matchesTopic(topics, ORACLE_MANAGER_SET_TOPIC)) {
    return data as unknown as OracleManagerSetEvent;
  }
  if (matchesTopic(topics, CONTRACT_UPGRADED_TOPIC)) {
    return data as unknown as ContractUpgradedEvent;
  }
  return null;
}
