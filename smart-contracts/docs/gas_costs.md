# Gas Costs

Empirical CPU-instruction (CU) estimates for ai-net Soroban contracts. The
Agent Registry exposes these estimates on-chain through `estimate_gas`.

## Agent Registry Constants

| Constant | Value | Meaning |
|----------|------:|---------|
| `GAS_TX_OVERHEAD` | 40,000 | Shared base cost paid once per transaction |
| `GAS_REGISTER_AGENT` | 82,000 | Full cost of a single `register_agent` |
| `GAS_REGISTER_AGENT_MARGINAL` | 42,500 | Extra cost per additional agent in a batch |
| `GAS_RESOLVE_ERROR` | 42,000 | Full cost of resolving one error |
| `GAS_RESOLVE_ERROR_MARGINAL` | 22,000 | Extra cost per additional error in a batch |
| `GAS_CLEANUP_ERROR` | 16,000 | Full cost of checking/removing one expired error |
| `GAS_CLEANUP_ERROR_MARGINAL` | 8,000 | Extra cost per additional cleanup item |
| `GAS_SLASH_BOND` | 52,000 | Full cost of a single `slash_bond` |
| `GAS_DEREGISTER_WITH_BOND` | 68,000 | Full cost of `deregister_agent` with bond return |
| `GAS_LIST_AGENTS` | 65,000 | Base cost of `list_agents` (index read + overhead) |
| `GAS_LIST_AGENTS_PER_RESULT` | 2,200 | Marginal cost per agent record loaded in `list_agents` |

## Formulae

```rust
estimate(register_agents, n) =
    GAS_REGISTER_AGENT + (n - 1) * GAS_REGISTER_AGENT_MARGINAL

estimate(resolve_errors, n) =
    GAS_RESOLVE_ERROR + (n - 1) * GAS_RESOLVE_ERROR_MARGINAL

estimate(cleanup_expired_errors, n) =
    GAS_CLEANUP_ERROR + (n - 1) * GAS_CLEANUP_ERROR_MARGINAL

// list_agents: cost is O(page_size), NOT O(total_agents)
// index-first approach reads capability → agent IDs from Temporary storage,
// then loads only the page_size agent records from Persistent storage.
estimate(list_agents, page_size) =
    GAS_LIST_AGENTS + page_size * GAS_LIST_AGENTS_PER_RESULT
```

All formulae return `0` when `n == 0`.

## Benchmark Tables

### `register_agents`

| Batch size | Previous CU | Optimized CU | Reduction vs previous | Separate txs CU | Savings vs separate |
|-----------:|------------:|-------------:|----------------------:|----------------:|--------------------:|
| 1 | 100,000 | 82,000 | 18.0% | 82,000 | 0.0% |
| 2 | 155,556 | 124,500 | 20.0% | 164,000 | 24.1% |
| 5 | 322,224 | 252,000 | 21.8% | 410,000 | 38.5% |
| 10 | 600,004 | 464,500 | 22.6% | 820,000 | 43.4% |
| 20 | 1,155,564 | 889,500 | 23.0% | 1,640,000 | 45.8% |

### `resolve_errors`

| Batch size | Previous CU | Optimized CU | Reduction vs previous | Separate txs CU | Savings vs separate |
|-----------:|------------:|-------------:|----------------------:|----------------:|--------------------:|
| 1 | 50,000 | 42,000 | 16.0% | 42,000 | 0.0% |
| 2 | 80,000 | 64,000 | 20.0% | 84,000 | 23.8% |
| 5 | 170,000 | 130,000 | 23.5% | 210,000 | 38.1% |
| 10 | 320,000 | 240,000 | 25.0% | 420,000 | 42.9% |
| 20 | 620,000 | 460,000 | 25.8% | 840,000 | 45.2% |

### `cleanup_expired_errors`

| Batch size | Previous CU | Optimized CU | Reduction vs previous |
|-----------:|------------:|-------------:|----------------------:|
| 1 | 20,000 | 16,000 | 20.0% |
| 2 | 30,000 | 24,000 | 20.0% |
| 5 | 60,000 | 48,000 | 20.0% |
| 10 | 110,000 | 88,000 | 20.0% |
| 20 | 210,000 | 168,000 | 20.0% |

### `list_agents` (composite index — issue #256 + #339)

The old approach (`get_agents` with capability filter in Rust) loaded all
registered agents into memory and filtered linearly — O(total_agents).
The new `list_agents` reads the per-capability Temporary index first and only
loads up to `page_size` agent records from Persistent storage — O(page_size).

| Registry size | Page size | Previous CU (linear) | New CU (composite index) | Reduction |
|--------------:|----------:|---------------------:|-------------------------:|----------:|
| 50 agents | 20 | ~300,000 | ~109,000 | 63.7% |
| 100 agents | 20 | ~600,000 | ~109,000 | 81.8% |
| 150 agents | 20 | ~900,000 | ~109,000 | 87.9% |
| 1,000 agents | 20 | >6,000,000 (exceeds budget) | ~109,000 | >98.0% |

Formula: `GAS_LIST_AGENTS + page_size × GAS_LIST_AGENTS_PER_RESULT`
= `65,000 + 20 × 2,200` = **109,000 CU** regardless of registry size.

The 1 M-CU Soroban budget is satisfied for all registry sizes at the default
page size of 20.

## Average Reduction

The CI benchmark guard compares the optimized estimates against the previous
baseline for:

| Operation | Previous CU | Optimized CU | Reduction |
|----------|------------:|-------------:|----------:|
| `register_agent(1)` | 100,000 | 82,000 | 18.0% |
| `register_agents(10)` | 600,004 | 464,500 | 22.6% |
| `resolve_error(1)` | 50,000 | 42,000 | 16.0% |
| `resolve_errors(10)` | 320,000 | 240,000 | 25.0% |
| `cleanup_expired_errors(10)` | 110,000 | 88,000 | 20.0% |
| `list_agents(100 agents, page=20)` | 600,000 | 109,000 | 81.8% |

Average reduction: **30.6%**, exceeding the 15% acceptance threshold.

## Storage Optimizations

1. Single `register_agent` now reads `TotalAgents` once and reuses the loaded
   capability index for both limit checking and commit.
2. `register_agents` caches per-capability counts during validation and writes
   each touched capability index once during commit.
3. `resolve_errors` reuses validation-loaded `ErrorEntry` records during commit
   instead of loading each error twice.
4. TTL extension uses a direct helper after known writes, avoiding redundant
   `has()` reads before every rent bump.
5. Lookup/list paths extend TTL directly when a previous `get()` already proved
   the key exists.
6. `list_agents` uses a per-capability **Temporary** storage index
   (`TempCapabilityIndex`) to apply the capability filter before loading any
   agent records from Persistent storage.  Only the requested page of records
   is loaded — the scan is O(page_size), not O(total_agents).  The Temporary
   index is maintained on every `register_agent`, `register_agents`, and
   `deregister_agent` mutation, and transparently regenerated from the
   canonical Persistent index if its TTL expires.

## Contract Snapshot

| Contract | Hot path profiled | Current status |
|----------|-------------------|----------------|
| `agent_registry` | Registration, batch registration, error resolution, cleanup, bond updates, **composite-index `list_agents`** | Optimized and CI-guarded |
| `agent_bidding` | Auction create, bid submit/reveal, award/refund | Bounded maps/vectors; no unbounded storage iteration in this change |
| `agent_marketplace` | Listing and purchase flows | Singleton config and per-listing records; no gas model exported yet |
| `dispute_resolution` | Dispute create/vote/resolve | Bounded case records; no hot-path regression in this change |
| `error-registry` | Error submit, indexed lookup, bounded cleanup | Already uses cursor/batch cleanup; no extra reads introduced |
| `error-resolver` | Error count record/clear/query | Minimal per-agent counters; no extra reads introduced |
| `task_store` | Task create/update/query | Per-task records; no unbounded collection mutation in this change |
| `upgrade-manager` | Migration planning/execution | Existing estimator retained; no data migration in this change |
| `payment_escrow` | Escrow create/release/dispute/expire | Per-escrow temporary records; bounded single-record operations |

The unit tests in `contracts/agent_registry/src/test.rs` assert the benchmark
tables and the >=15% average reduction guard.

## On-chain Reputation (issue #191)

New operations added to `agent_registry`:

| Operation | Estimated CU | Notes |
|-----------|-------------:|-------|
| `update_reputation` (first call) | ~48,000 | Persistent write + TTL extend + event emit |
| `update_reputation` (subsequent) | ~52,000 | Read + write + TTL extend + event emit |
| `get_reputation` (cold) | ~18,000 | Persistent read + TTL extend |
| `get_reputation` (warm) | ~12,000 | Persistent read (key in footprint) |
| `set_task_store` | ~22,000 | Instance write + audit record |

Storage overhead per agent: one `ReputationScore` record in Persistent storage
(~80 bytes: two `u32`, one `u32` score, one `i128` payout). TTL extended to
`TTL_EXTEND_TO = 241,920` ledgers (~14 days) on every update and read.

## Payment Escrow (issue #192)

New contract `payment_escrow`:

| Operation | Estimated CU | Notes |
|-----------|-------------:|-------|
| `create_escrow` | ~55,000 | Temporary write + TTL set + event emit |
| `release_escrow` | ~42,000 | Temporary read + write + event emit |
| `dispute_escrow` | ~44,000 | Temporary read + write + event emit |
| `expire_escrow` | ~38,000 | Temporary read + write + event emit |
| `get_escrow` | ~14,000 | Temporary read |

Storage: one `EscrowRecord` per task in Temporary storage. TTL set to
`timeout_ledger` on creation; Soroban auto-expires the entry if neither
release nor dispute is called in time. Dispute hold window: 48 ledgers (~4 min
at 5 s/ledger).
