# Oracle Feeder Authorization Guide

This document describes how authorized oracle feeders are managed in ai-net and how the `oracle_manager` contract aggregates multi-feeder price submissions.

---

## Overview

The `oracle_manager` contract accepts XLM/USD price submissions from a set of **authorized feeders**. When `resolve_price` is called by the `agent_marketplace` or other consumers, the contract:

1. Tries the registered on-chain `price_oracle` contract (if configured).
2. Falls back to the **median** of all fresh feeder submissions (within 300 s).
3. Falls back to the admin-set static fallback price.
4. Returns `Error::NoPriceAvailable` if none of the above are available.

Stale prices (older than 300 seconds) are **never** silently returned.

---

## Minimum Feeder Requirements

| Environment | Minimum Feeders |
|---|---|
| Testnet | 1 |
| Mainnet | 3 (recommended 5) |

The minimum is enforced by social convention; on-chain the `resolve_price` function returns the median of whatever fresh submissions are available. Operators should monitor feeder liveness and alert if the active feeder count drops below the minimum.

---

## Adding an Authorized Feeder

Only the contract admin can add feeders:

```bash
soroban contract invoke \
  --id $ORACLE_MANAGER_CONTRACT_ID \
  --source $ADMIN_SECRET_KEY \
  --network testnet \
  -- add_feeder \
  --feeder $FEEDER_ADDRESS
```

Adding a feeder that is already authorized is a no-op (idempotent).

---

## Removing an Authorized Feeder

```bash
soroban contract invoke \
  --id $ORACLE_MANAGER_CONTRACT_ID \
  --source $ADMIN_SECRET_KEY \
  --network testnet \
  -- remove_feeder \
  --feeder $FEEDER_ADDRESS
```

Removing a feeder also deletes their last stored price submission from Persistent storage.

---

## Submitting a Price (Feeder Operation)

Authorized feeders submit prices by calling `submit_price`:

```bash
soroban contract invoke \
  --id $ORACLE_MANAGER_CONTRACT_ID \
  --source $FEEDER_SECRET_KEY \
  --network testnet \
  -- submit_price \
  --feeder $FEEDER_ADDRESS \
  --price 1234567 \
  --timestamp $(date +%s)
```

| Parameter | Description |
|---|---|
| `feeder` | The feeder's Stellar address (must match the signing keypair) |
| `price` | XLM/USD price in stroops (8-decimal fixed point; e.g. `1_234_567` = $0.1234567) |
| `timestamp` | Unix seconds of the off-chain observation (must be ≤ current ledger timestamp) |

Submissions older than 300 seconds are ignored by `resolve_price`.

---

## Median Aggregation

When `resolve_price` is called and no live oracle is available, the contract:

1. Loads all authorized feeder addresses from Instance storage.
2. For each feeder, loads their latest `FeederSubmission` from Persistent storage.
3. Filters out submissions where `now - timestamp > 300`.
4. Sorts the remaining prices ascending.
5. Returns the **lower-median** (index `(n-1)/2` for `n` fresh submissions).

**Example — 3 feeders:**

| Feeder | Price (stroops) | Age |
|---|---|---|
| F1 | 1_100_000 | 10 s |
| F2 | 1_050_000 | 45 s |
| F3 | 1_200_000 | 120 s |

Sorted: `[1_050_000, 1_100_000, 1_200_000]` → median = `1_100_000`

---

## Checking Feeder Count

```bash
soroban contract invoke \
  --id $ORACLE_MANAGER_CONTRACT_ID \
  --network testnet \
  -- get_feeder_count
```

---

## Events

| Event topic | Data struct | Description |
|---|---|---|
| `(mgr, fdr_add)` | `FeederAddedEvent` | New feeder authorized |
| `(mgr, fdr_rem)` | `FeederRemovedEvent` | Feeder removed |
| `(mgr, fdr_sub)` | `FeederPriceSubmittedEvent` | Feeder submitted a price |
| `(mgr, resolved)` | `PriceResolvedEvent` | Price resolved (source: Oracle/Feeder/Fallback) |

---

## Related

- [cross-chain.md](cross-chain.md) — Oracle design decisions and cross-contract call patterns
- [price_oracle contract](../contracts/price_oracle/src/lib.rs) — On-chain oracle feed contract
- [oracle_manager contract](../contracts/oracle_manager/src/lib.rs) — Multi-feeder aggregation contract
