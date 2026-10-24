# Task Store Contract — Lifecycle Events

This document defines the Soroban event schema for the high-level task lifecycle
API exposed by `task_store`.

## Event Topics

Every lifecycle event is emitted under the first topic `task_store`. The second
topic identifies the transition:

- `task_created`
- `task_assigned`
- `task_completed`
- `task_failed`

## Versioning & Compatibility

Every payload includes a `version: u32` field. The event schema is append-only:

- New fields may be added without bumping the version.
- Renaming, removing, or changing the meaning of an existing field requires a
  version bump.
- The topic pair for each lifecycle stage is stable.

## Lifecycle invariant

Each successful state transition emits exactly one event, and rejected calls emit
no event at all.

---

### 1. Task Created

Emitted once when `create_task` succeeds.

- **Topic 1**: `Symbol::new(env, "task_store")`
- **Topic 2**: `Symbol::new(env, "task_created")`
- **Data (Structure)**: `TaskStoreCreatedEvent`

```rust
pub struct TaskStoreCreatedEvent {
    pub version: u32,
    pub task_id: u64,
    pub submitter: Address,
    pub description_hash: BytesN<32>,
    pub budget_xlm: i128,
    pub created_at: u64,
}
```

### 2. Task Assigned

Emitted when `assign_task` succeeds.

- **Topic 1**: `Symbol::new(env, "task_store")`
- **Topic 2**: `Symbol::new(env, "task_assigned")`
- **Data (Structure)**: `TaskStoreAssignedEvent`

```rust
pub struct TaskStoreAssignedEvent {
    pub version: u32,
    pub task_id: u64,
    pub agent_id: Address,
    pub assigned_at: u64,
}
```

### 3. Task Completed

Emitted when `complete_task` succeeds.

- **Topic 1**: `Symbol::new(env, "task_store")`
- **Topic 2**: `Symbol::new(env, "task_completed")`
- **Data (Structure)**: `TaskStoreCompletedEvent`

```rust
pub struct TaskStoreCompletedEvent {
    pub version: u32,
    pub task_id: u64,
    pub agent_id: Address,
    pub result_hash: BytesN<32>,
    pub completed_at: u64,
}
```

### 4. Task Failed

Emitted when `fail_task` succeeds.

- **Topic 1**: `Symbol::new(env, "task_store")`
- **Topic 2**: `Symbol::new(env, "task_failed")`
- **Data (Structure)**: `TaskStoreFailedEvent`

```rust
pub struct TaskStoreFailedEvent {
    pub version: u32,
    pub task_id: u64,
    pub actor: Address,
    pub reason: String,
    pub failed_at: u64,
}
```

## Status transition → event map

| Transition | Event |
|---|---|
| `Created` → `Assigned` | `task_assigned` |
| `Assigned` → `Completed` | `task_completed` |
| `Assigned` → `Failed` | `task_failed` |
| `Created` → `Failed` | `task_failed` |
| Any invalid transition | *(no event)* |

## Reading events with the JS/TS SDK

Consumers should filter by the topic pair before decoding a payload:

```ts
if (topics[0] === "task_store" && topics[1] === "task_completed") {
  const event = scValToNative(data) as TaskStoreCompletedEvent;
  // event.version, event.task_id, event.result_hash, ...
}
```

---

## Consumer Integration Examples

The rest of this document provides runnable examples for subscribing to
`task_store` lifecycle events from off-chain indexers, real-time
dashboards, and analytics pipelines.

All examples target the **Stellar testnet** by default. Adjust
`HORIZON_URL` / `SOROBAN_RPC_URL` when running against futurenet or
mainnet.

### Prerequisites

| Dependency | Purpose |
|---|---|
| `@stellar/stellar-sdk` >= 12 | XDR decoding, Horizon SSE client |
| Node.js >= 20 | TypeScript runtime |
| `stellar-sdk` (Python) >= 11 | Python consumer example |

---

### TypeScript Type Definitions

The XDR event payload deserialises to plain JS objects via
`scValToNative`. The following type definitions match the on-chain Rust
structs and should be used in all TypeScript consumers for compile-time
safety.

```ts
// task-store-event-types.ts

/** Shared discriminator — every task lifecycle event carries this. */
export type TaskLifecycleStage = "created" | "updated" | "finalized";

/** Stellar TaskStatus enum (mirrors the on-chain Rust enum). */
export type TaskStatus = "Pending" | "Running" | "Completed" | "Failed";

/** 32-byte hex-encoded identifier. */
export type Bytes32Hex = string;

/** Versioned envelope shared by all task lifecycle events. */
export interface TaskLifecycleEventBase {
  version: number;
  task_id: Bytes32Hex;
}

/** Emitted when `store_task_metadata` succeeds. */
export interface TaskCreatedEvent extends TaskLifecycleEventBase {
  prompt_hash: Bytes32Hex;
  assigned_agents: string[]; // Stellar G... addresses
  created_at: number;        // u64 ledger close time (unix seconds)
  expires_at: number;         // u64 ledger close time
}

/** Emitted when `update_task_status` succeeds with a non-terminal transition. */
export interface TaskUpdatedEvent extends TaskLifecycleEventBase {
  agent: string;       // Stellar G... address
  old_status: TaskStatus;
  new_status: TaskStatus;
  updated_at: number; // u64 ledger close time
}

/** Emitted when `update_task_status` succeeds with a terminal transition. */
export interface TaskFinalizedEvent extends TaskLifecycleEventBase {
  agent: string;
  old_status: TaskStatus;
  final_status: TaskStatus; // always "Completed" or "Failed"
  finalized_at: number;     // u64 ledger close time
}

/** Discriminated union for type-narrowed event handling. */
export type TaskStoreEvent =
  | ({ stage: "created" } & TaskCreatedEvent)
  | ({ stage: "updated" } & TaskUpdatedEvent)
  | ({ stage: "finalized" } & TaskFinalizedEvent);
```

---

### TypeScript Consumer: Real-Time Task Status Tracker

This example subscribes to a Soroban contract's events via the Horizon
Server-Sent Events endpoint, filters by the `task_meta` topic, and
maintains a live in-memory map of task statuses. It is runnable against
testnet.

```ts
// examples/task-status-tracker.ts
//
// Usage:
//   npx ts-node examples/task-status-tracker.ts \
//     --contract-id <CONTRACT_ID> \
//     --horizon-url https://horizon-testnet.stellar.org
//
// Requires: npm install @stellar/stellar-sdk

import { Horizon, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readFileSync } from "fs";

// ── Types (from task-store-event-types.ts) ────────────────────────────────────
type TaskStatus = "Pending" | "Running" | "Completed" | "Failed";

interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  agent?: string;
  createdAt?: number;
  updatedAt?: number;
  finalizedAt?: number;
}

// ── Config ──────────────────────────────────────────────────────────────────
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.error("CONTRACT_ID environment variable is required.");
  process.exit(1);
}

// ── Live state ──────────────────────────────────────────────────────────────
const taskStore = new Map<string, TaskRecord>();

/** Decode a Soroban contract event into a typed payload. */
function decodeTaskStoreEvent(event: xdr.ContractEvent): TaskRecord | null {
  const topics = event.body().v0().topics().map((t) => scValToNative(t));
  // Filter: topic[0] must be "task_meta"
  if (topics[0] !== "task_meta") return null;

  const stage = topics[1] as "created" | "updated" | "finalized";
  const data = scValToNative(event.body().v0().data());

  return {
    taskId: data.task_id,
    status:
      stage === "created" ? "Pending" :
      stage === "updated" ? data.new_status :
      data.final_status,
    agent: data.agent,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    finalizedAt: data.finalized_at,
  };
}

/** Start streaming events from the given ledger cursor (or latest). */
async function startTracking(startLedger?: number): Promise<void> {
  const server = new rpc.Server(RPC_URL);

  // Resolve starting ledger if not provided (defaults to latest)
  let cursor = startLedger;
  if (!cursor) {
    const latest = await server.getLatestLedger();
    cursor = latest.sequence;
    console.log(`Starting from latest ledger ${cursor}`);
  }

  console.log(`Subscribing to task_store events on contract ${CONTRACT_ID}…`);
  console.log(`Horizon: ${HORIZON_URL}`);
  console.log(`RPC: ${RPC_URL}\n`);

  // Poll for events every 5 seconds (see Rate Limit Guidance below).
  const POLL_INTERVAL_MS = 5_000;
  let currentLedger = cursor;

  setInterval(async () => {
    try {
      const response = await server.getEvents({
        startLedger: currentLedger,
        endLedger: currentLedger + 100,
        filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      });

      for (const event of response.events) {
        try {
          const decoded = decodeTaskStoreEvent(event as unknown as xdr.ContractEvent);
          if (!decoded) continue;

          taskStore.set(decoded.taskId, decoded);
          console.log(
            `[ledger ${event.ledger}] Task ${decoded.taskId} → ${decoded.status}`,
          );
        } catch {
          // Non-task_meta event or decode failure — skip
        }
      }

      // Advance cursor past the consumed ledgers
      if (response.events.length > 0) {
        const maxLedger = Math.max(...response.events.map((e) => e.ledger));
        currentLedger = maxLedger + 1;
      }
    } catch (err) {
      console.error("Error fetching events:", err);
    }
  }, POLL_INTERVAL_MS);
}

// ── Entry point ─────────────────────────────────────────────────────────────
const checkpointFile = process.env.CHECKPOINT_FILE;

if (checkpointFile) {
  try {
    const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8"));
    startTracking(checkpoint.lastLedger);
  } catch {
    console.warn("Checkpoint file invalid — starting from latest ledger.");
    startTracking();
  }
} else {
  startTracking();
}
```

---

### Python Consumer: Batch Event Indexer

This example uses the Python `stellar-sdk` library to poll for Soroban
contract events in batches, decode the XDR payloads, and write them to a
SQLite database for offline analytics. It is runnable against testnet.

```python
#!/usr/bin/env python3
# examples/batch_event_indexer.py
#
# Usage:
#   pip install stellar-sdk
#   python examples/batch_event_indexer.py \
#     --contract-id <CONTRACT_ID> \
#     --rpc-url https://soroban-testnet.stellar.org
#
# Polls Soroban contract events in batches and writes decoded task_store
# lifecycle events to a local SQLite database for offline analysis.

import argparse
import json
import sqlite3
import time
import sys
from typing import Any, Dict, List, Optional

from stellar_sdk import SorobanServer
from stellar_sdk import xdr as stellar_xdr


# ── Schema ──────────────────────────────────────────────────────────────────

def init_database(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS task_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ledger      INTEGER NOT NULL,
            tx_hash     TEXT,
            stage       TEXT NOT NULL,
            task_id     TEXT NOT NULL,
            version     INTEGER,
            agent       TEXT,
            old_status  TEXT,
            new_status  TEXT,
            final_status TEXT,
            created_at  INTEGER,
            updated_at  INTEGER,
            finalized_at INTEGER,
            prompt_hash TEXT,
            expires_at  INTEGER,
            raw_payload TEXT NOT NULL,
            indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_task_events_task_id
        ON task_events(task_id)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_task_events_ledger
        ON task_events(ledger)
    """)
    conn.commit()
    return conn


# ── Event decoding ──────────────────────────────────────────────────────────

def decode_scval(scval: stellar_xdr.ScVal) -> Any:
    """Decode a Soroban ScVal into a native Python value."""
    if scval.type == stellar_xdr.ScValType.SCV_SYMBOL:
        return scval.sym.scstr.decode("utf-8")
    elif scval.type == stellar_xdr.ScValType.SCV_U32:
        return scval.u32.uint32
    elif scval.type == stellar_xdr.ScValType.SCV_U64:
        return scval.u64.uint64
    elif scval.type == stellar_xdr.ScValType.SCV_STRING:
        return scval.str.scstr.decode("utf-8")
    elif scval.type == stellar_xdr.ScValType.SCV_VEC:
        return [decode_scval(item) for item in scval.vec.vec]
    elif scval.type == stellar_xdr.ScValType.SCV_MAP:
        result = {}
        for entry in scval.map.map:
            key = decode_scval(entry.key)
            result[key] = decode_scval(entry.val)
        return result
    elif scval.type == stellar_xdr.ScValType.SCV_BYTES:
        return scval.bytes.scbytes.hex()
    return None


def decode_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Decode a raw Soroban event into a typed task_store event dict."""
    topics = event.get("topics", [])
    if len(topics) < 2:
        return None

    if topics[0] != "task_meta":
        return None

    stage = topics[1]  # "created", "updated", or "finalized"
    data = event.get("data", {})

    return {
        "stage": stage,
        "task_id": data.get("task_id"),
        "version": data.get("version"),
        "agent": data.get("agent"),
        "old_status": data.get("old_status"),
        "new_status": data.get("new_status"),
        "final_status": data.get("final_status"),
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "finalized_at": data.get("finalized_at"),
        "prompt_hash": data.get("prompt_hash"),
        "expires_at": data.get("expires_at"),
        "ledger": event.get("ledger"),
        "tx_hash": event.get("tx_hash"),
        "raw_payload": json.dumps(event),
    }


# ── Batch polling loop ──────────────────────────────────────────────────────

def poll_loop(
    server: SorobanServer,
    contract_id: str,
    conn: sqlite3.Connection,
    start_ledger: int,
    batch_size: int = 200,
    poll_interval: float = 5.0,
) -> None:
    current_ledger = start_ledger
    print(f"Starting batch indexer from ledger {current_ledger}")

    while True:
        try:
            response = server.get_events(
                start_ledger=current_ledger,
                end_ledger=current_ledger + batch_size,
                contract_ids=[contract_id],
            )

            events = response.get("events", [])
            for raw_event in events:
                decoded = decode_event(raw_event)
                if decoded is None:
                    continue

                conn.execute("""
                    INSERT INTO task_events
                        (ledger, tx_hash, stage, task_id, version, agent,
                         old_status, new_status, final_status,
                         created_at, updated_at, finalized_at,
                         prompt_hash, expires_at, raw_payload)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    decoded["ledger"],
                    decoded["tx_hash"],
                    decoded["stage"],
                    decoded["task_id"],
                    decoded["version"],
                    decoded["agent"],
                    decoded["old_status"],
                    decoded["new_status"],
                    decoded["final_status"],
                    decoded["created_at"],
                    decoded["updated_at"],
                    decoded["finalized_at"],
                    decoded["prompt_hash"],
                    decoded["expires_at"],
                    decoded["raw_payload"],
                ))
            conn.commit()

            if events:
                max_ledger = max(e["ledger"] for e in events)
                current_ledger = max_ledger + 1
                print(f"Indexed {len(events)} events up to ledger {max_ledger}")
            else:
                # No events in this range — advance by the batch size
                current_ledger += batch_size

            time.sleep(poll_interval)

        except KeyboardInterrupt:
            print("\nStopping indexer…")
            break
        except Exception as exc:
            print(f"Error fetching events: {exc}. Retrying in {poll_interval}s…")
            time.sleep(poll_interval)


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Batch task_store event indexer")
    parser.add_argument("--contract-id", required=True, help="Soroban contract ID")
    parser.add_argument(
        "--rpc-url",
        default="https://soroban-testnet.stellar.org",
        help="Soroban RPC URL",
    )
    parser.add_argument(
        "--db-path",
        default="task_events.db",
        help="SQLite database path",
    )
    parser.add_argument(
        "--start-ledger",
        type=int,
        default=None,
        help="Starting ledger (defaults to latest)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=200,
        help="Maximum ledgers to poll per batch",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=5.0,
        help="Seconds between poll requests",
    )
    args = parser.parse_args()

    server = SorobanServer(args.rpc_url)
    conn = init_database(args.db_path)

    start_ledger = args.start_ledger
    if start_ledger is None:
        latest = server.get_latest_ledger()
        start_ledger = latest.sequence
        print(f"No start ledger specified — starting from latest ({start_ledger})")

    poll_loop(
        server=server,
        contract_id=args.contract_id,
        conn=conn,
        start_ledger=start_ledger,
        batch_size=args.batch_size,
        poll_interval=args.poll_interval,
    )

    conn.close()


if __name__ == "__main__":
    main()
```

---

### Checkpoint / Catch-Up Mechanism

When a consumer restarts (deploy, crash, or manual stop), it must resume
from the last-processed ledger rather than re-scanning from genesis. The
recommended approach is to persist a **checkpoint ledger** after every
batch and load it on startup.

```ts
// checkpoint.ts — TypeScript checkpoint store

import { readFileSync, writeFileSync, existsSync } from "fs";

export interface Checkpoint {
  contractId: string;
  lastLedger: number;
  lastUpdated: string; // ISO timestamp
}

const CHECKPOINT_PATH = process.env.CHECKPOINT_FILE ?? ".event-checkpoint.json";

/** Load the last-processed ledger from disk. Returns null if no checkpoint exists. */
export function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
    console.log(`Loaded checkpoint: ledger ${data.lastLedger} (updated ${data.lastUpdated})`);
    return data;
  } catch {
    console.warn("Checkpoint file corrupt — starting fresh.");
    return null;
  }
}

/** Persist the current cursor to disk after processing a batch. */
export function saveCheckpoint(lastLedger: number, contractId: string): void {
  const checkpoint: Checkpoint = {
    contractId,
    lastLedger,
    lastUpdated: new Date().toISOString(),
  };
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
}

// Usage in a poll loop:
//
//   let currentLedger = loadCheckpoint()?.lastLedger ?? await getLatestLedger();
//   while (true) {
//     const events = await server.getEvents({ startLedger: currentLedger, ... });
//     for (const event of events) { /* decode + process */ }
//     if (events.length > 0) {
//       currentLedger = Math.max(...events.map(e => e.ledger)) + 1;
//       saveCheckpoint(currentLedger, CONTRACT_ID);
//     }
//     await sleep(POLL_INTERVAL_MS);
//   }
```

```python
# checkpoint.py — Python checkpoint store

import json
import os
import datetime
from typing import Optional

CHECKPOINT_PATH = os.environ.get("CHECKPOINT_FILE", ".event-checkpoint.json")


def load_checkpoint() -> Optional[int]:
    """Load the last-processed ledger. Returns None if no checkpoint exists."""
    if not os.path.exists(CHECKPOINT_PATH):
        return None
    try:
        with open(CHECKPOINT_PATH, "r") as f:
            data = json.load(f)
        return data.get("last_ledger")
    except (json.JSONDecodeError, OSError):
        return None


def save_checkpoint(last_ledger: int) -> None:
    """Persist the current cursor to disk."""
    with open(CHECKPOINT_PATH, "w") as f:
        json.dump(
            {
                "last_ledger": last_ledger,
                "updated_at": datetime.datetime.now().isoformat(),
            },
            f,
            indent=2,
        )
```

#### Handling ledger gaps

If the consumer has been offline for a long time, the gap between the
checkpoint ledger and the latest ledger may exceed the RPC's maximum
event-retention window (typically 7 days / ~300,000 ledgers on testnet).
In that case, `getEvents` will return an error for the oldest ledgers.

The recommended recovery strategy:

1. Catch up in **forward-bounded batches** (e.g. 200 ledgers at a time).
2. If `getEvents` returns a "ledger range too old" error, advance the
   checkpoint to the earliest ledger the RPC still retains — this is a
   **gap event** and should be logged and alerted on.
3. Never silently skip the gap; record it so downstream analytics can
   account for missing events.

```ts
// Gap recovery inside the poll loop
try {
  const response = await server.getEvents({ startLedger: currentLedger, ... });
  // ... process events ...
} catch (err: any) {
  if (err.message?.includes("ledger range too old")) {
    console.warn(`Ledger ${currentLedger} is beyond retention — jumping to earliest available.`);
    const latest = await server.getLatestLedger();
    currentLedger = latest.sequence - 100_000; // earliest likely retained
    saveCheckpoint(currentLedger, CONTRACT_ID);
    // Log the gap so downstream consumers are aware
    console.error(`GAP: events between checkpoint and ledger ${currentLedger} are lost.`);
  } else {
    throw err;
  }
}
```

---

### Rate Limit Guidance and Best Practices

Horizon and the Soroban RPC enforce rate limits. The following guidance
is verified against the [Horizon rate-limit documentation](https://developers.stellar.org/docs/data/horizon/reference/rate-limiting)
and the Soroban RPC API reference.

#### Horizon rate limits

| Tier | Requests per minute |
|---|---|
| Anonymous (no API key) | 100 req/min (3,600/hr) |
| Authenticated (API key in `X-API-Key` header) | 3,000 req/min |

When the limit is exceeded, Horizon returns HTTP **429** with a
`Retry-After` header indicating when to retry.

#### Recommended polling intervals

| Use case | Poll interval | Batch size |
|---|---|---|
| Real-time dashboard (low latency) | 3-5 seconds | 1-10 ledgers |
| Batch indexer (throughput) | 5-10 seconds | 100-200 ledgers |
| Historical backfill | 1-2 seconds | 200 ledgers (max) |

#### Best practices

1. **Use cursor-based pagination**: Always track `lastLedger` and request
   `startLedger = lastLedger + 1`. Never re-scan from the beginning.

2. **Respect 429 with exponential backoff**: On HTTP 429, read the
   `Retry-After` header (seconds) and wait before the next request.
   Fall back to exponential backoff (2s -> 4s -> 8s -> 16s) if the header
   is absent.

3. **Batch events, don't poll individually**: Use `getEvents` with a
   ledger range rather than per-transaction queries. The Soroban RPC
   `getEvents` endpoint supports `startLedger` / `endLedger` ranges and
   contract ID filters.

4. **Decode once, process asynchronously**: Decode the XDR in the poll
   loop, then push decoded payloads to a queue (Redis, SQS, or an
   in-process channel) so the poll loop is never blocked by slow
   downstream processing.

5. **Handle the 7-day retention window**: Soroban RPC on testnet
   retains event history for approximately 7 days (~300,000 ledgers at
   ~5s per ledger). For longer retention, index events to your own
   database in real time — you cannot backfill beyond the retention
   window.

6. **Filter by contract ID at the RPC level**: Always pass the
   `contractIds` filter to `getEvents` to avoid downloading unrelated
   contract events.

7. **Idempotent writes**: If writing decoded events to a database,
   use a unique constraint on `(ledger, tx_hash, event_index)` or
   `(task_id, stage, ledger)` so re-delivery from a poll overlap does
   not create duplicate rows.
