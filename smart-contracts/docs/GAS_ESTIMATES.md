# Gas Cost Estimates — ai-net Soroban Contracts

Empirical CPU-instruction (CU) estimates for all ai-net Soroban contracts.
Measurements are taken in the Soroban testutils environment using
`env.budget().cpu_instruction_count()` with an unlimited budget so the call is
never aborted before the measurement is taken.

---

## Performance Budget

| Limit | Value | Notes |
|---|---|---|
| **Hard ceiling** | 10,000,000 CU | Stellar network per-transaction limit |
| **Regression guard** | +20% of baseline | CI fails if any benchmark exceeds baseline × 1.2 |

Any function that exceeds 10 M CU cannot be included in a single transaction
and must be redesigned.  A CI regression guard rejects pull requests where a
function's measured cost grows more than 20 % above its documented baseline.

---

## How to Run Benchmarks

```bash
# From the workspace root
cd smart-contracts

# Run all benchmark tests (prints cpu_instruction_count for each)
cargo test --features benchmarks -- benchmark --nocapture

# Run a single benchmark by name
cargo test --features benchmarks -- benchmark_register_agent --nocapture
```

Benchmarks live in
`contracts/agent_registry/src/benchmarks.rs` and are compiled only when the
`benchmarks` Cargo feature is enabled.

---

## CI Regression Guard

The `.github/workflows/gas-benchmarks.yml` workflow runs on every push or pull
request that touches `smart-contracts/contracts/**/*.rs`.  It executes:

```bash
cargo test --features benchmarks -- benchmark --nocapture
```

Each benchmark asserts two thresholds:

1. **Hard ceiling** — `cpu < 10_000_000` — guards against accidentally landing
   code that would exceed the Stellar network limit.
2. **Regression guard** — `cpu < baseline × 1.20` — prevents silent performance
   regressions from merging without review.

If either assertion fires, the CI job fails and the PR cannot be merged.

---

## Flagging an Intentional Cost Increase

If a feature legitimately raises the cost of a function beyond its 20 % guard:

1. Update the baseline constant in `benchmarks.rs` with the new measured value.
2. Update the corresponding row in this document.
3. Add a comment in the PR description explaining the trade-off.
4. Request a review from a maintainer before merging.

---

## agent_registry

Gas constants are exported from `contracts/agent_registry/src/lib.rs` and
available on-chain via `estimate_gas`.

| Function | Baseline CU | 20% Guard (CI fails if >) | Notes |
|---|---:|---:|---|
| `register_agent` | 82,000 | 98,400 | Single agent, includes tx overhead |
| `register_agents(10)` | 464,500 | 557,400 | Batch of 10 agents |
| `deregister_agent` | 68,000 | 81,600 | Includes bond-cooldown write |
| `list_agents / get_agents` | 15,000 | 18,000 | Empty registry, cursor = 0 |
| `get_agent / get_agent_health` | 12,000 | 14,400 | Single agent lookup |
| `slash_bond` | 52,000 | 62,400 | Admin operation |
| `cleanup_expired_errors(10)` | 88,000 | 105,600 | Batch cleanup of 10 errors |

### Agent-ID pagination (#401)

`list_agents(cursor, limit)` resolves an agent-ID cursor to its registration
sequence and reads at most the configured page size (hard-capped at 50). For a
100-agent active registry with the default page size of 20, the existing
`GAS_LIST_AGENTS` estimate gives approximately 109,000 CU per page, versus
285,000 CU for an unpaginated 100-record listing. That is an estimated 61.8%
reduction per page; it assumes the registration index has no long run of
deregistered entries. This is a formula-based estimate, not a measured
Soroban CPU benchmark, and should be confirmed by the benchmark CI job.

### Batch-registration scaling

| Batch size | Estimated CU | Formula |
|---:|---:|---|
| 1 | 82,000 | `GAS_REGISTER_AGENT` |
| 2 | 124,500 | `82,000 + 42,500` |
| 5 | 252,000 | `82,000 + 4 × 42,500` |
| 10 | 464,500 | `82,000 + 9 × 42,500` |
| 20 | 889,500 | `82,000 + 19 × 42,500` |

**Formula:**
```
estimate(register_agents, n) = GAS_REGISTER_AGENT + (n − 1) × GAS_REGISTER_AGENT_MARGINAL
                              = 82,000 + (n − 1) × 42,500
```

### Cleanup-error scaling

| Batch size | Estimated CU |
|---:|---:|
| 1 | 16,000 |
| 5 | 48,000 |
| 10 | 88,000 |
| 20 | 168,000 |

**Formula:**
```
estimate(cleanup_expired_errors, n) = GAS_CLEANUP_ERROR + (n − 1) × GAS_CLEANUP_ERROR_MARGINAL
                                    = 16,000 + (n − 1) × 8,000
```

---

## task_store

> Measurements are indicative; CI-guarded benchmarks will be added in a
> follow-up once `task_store` exposes testutils-compatible client bindings.

| Function | Estimated CU | Notes |
|---|---:|---|
| `create_task` | ~45,000 | Single task creation including storage write |
| `assign_task` | ~30,000 | State transition: pending → assigned |
| `update_task` | ~28,000 | Metadata update on existing task |
| `complete_task` | ~32,000 | State transition: assigned → completed |
| `get_task` | ~10,000 | Read-only lookup |

---

## dispute_resolution

| Function | Estimated CU | Notes |
|---|---:|---|
| `file_dispute` | ~55,000 | Creates dispute record and emits event |
| `submit_evidence` | ~35,000 | Appends evidence to existing dispute |
| `cast_vote` | ~25,000 | Records arbiter vote |
| `resolve_dispute` | ~40,000 | Tallies votes and writes resolution |
| `appeal_dispute` | ~20,000 | Opens appeal window on resolved dispute |

---

## upgrade-manager

> `execute_upgrade` is intentionally expensive — it runs Wasm migration logic.
> The 10 M CU hard ceiling still applies; if migration logic approaches the
> limit it must be chunked across multiple transactions.

| Function | Estimated CU | Notes |
|---|---:|---|
| `propose_upgrade` | ~60,000 | Stores upgrade proposal |
| `execute_upgrade` | ~800,000 | Runs migration hooks — highest cost |
| `rollback_upgrade` | ~200,000 | Restores previous contract state |

---

## agent_bidding

| Function | Estimated CU | Notes |
|---|---:|---|
| `create_auction` | ~50,000 | Creates sealed-bid auction |
| `submit_bid` | ~35,000 | Records encrypted bid commitment |
| `reveal_bid` | ~30,000 | Opens commitment, validates reveal |
| `award_auction` | ~45,000 | Selects winner and emits result |

---

## agent_governance

| Function | Estimated CU | Notes |
|---|---:|---|
| `propose` | ~55,000 | Creates governance proposal |
| `vote` | ~25,000 | Records voter ballot |
| `execute_proposal` | ~90,000 | Executes approved proposal on-chain |

---

## Storage Optimization Notes

These principles keep costs low across all contracts:

1. **Read-once, reuse** — validation-loaded records are reused during commit
   to avoid double-loading from persistent storage.
2. **Batch capability-index writes** — `register_agents` caches per-capability
   counts during validation and writes each index exactly once.
3. **Lazy TTL extension** — TTL bumps are deferred until after a confirmed
   `get()`, avoiding redundant `has()` reads before every rent bump.
4. **Bounded collections** — all stored vectors enforce a maximum length;
   there are no unbounded storage iterations in hot paths.
5. **Single auth per unique owner** — batch operations collect unique owners
   and call `require_auth()` exactly once per owner.

---

*Last updated: 2026-09-29. Baselines measured against soroban-sdk 22.0.11.*
