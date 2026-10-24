# Database Performance & Concurrency

This document covers the SQLite performance baseline for issue #32: WAL mode,
supporting indexes, slow-query logging, and reproducible benchmarks.

## 1. WAL mode

All three databases (`tasks`, `agents`, `payments`) run in write-ahead-log mode.
`createPool()` applies the following pragmas to every writer and reader in
`backend/src/db/pool.ts`:

| Pragma | Writer | Reader | Why |
|---|---|---|---|
| `journal_mode = WAL` | ✅ | ✅ (inherited) | Readers never block the writer during task execution |
| `busy_timeout = 5000` | ✅ | ✅ | Avoids `SQLITE_BUSY` under short write contention |
| `synchronous = NORMAL` | ✅ | ✅ | Safe with WAL; avoids fsync on every commit |
| `foreign_keys = ON` | ✅ | ✅ | Referential integrity |
| `journal_mode` query | — | ✅ | Verifies the shared WAL file |

WAL creates `<database>.db-wal` and `<database>.db-shm` sidecar files. Backup
and restore procedures must include them or checkpoint first; see
[DATABASE_BACKUP_DR.md](./DATABASE_BACKUP_DR.md).

## 2. Indexes

Added by migrations and safe to re-run (`IF NOT EXISTS`):

| Migration | Index | Columns | Serves |
|---|---|---|---|
| `migrations/tasks/007_add_wallet_created_index` | `idx_tasks_wallet_created` | `walletPublicKey, "createdAt"` | Wallet task history, date-filtered admin/pagination queries |
| `migrations/payments/003_add_task_status_index` | `idx_payments_task_status` | `taskId, status` | Payment lookup by task and state (`locked`, `released`, `refunded`) |
| `migrations/agents/004_add_performance_indexes` | `idx_agents_status_capabilities` | `status, capabilities` | Online/offline agent selection; full-capability equality |

Rollback migrations drop the same indexes. Apply with:

```bash
npm run db:migrate
```

### Capability note

`agents.capabilities` is stored as a JSON array. The composite index filters on
`status` and can serve exact `capabilities` equality. Membership checks such as
`EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)` still scan the
rows selected by `status`; if capability filtering becomes a hot path, normalize
capabilities into a join table (follow-up optimization).

## 3. Slow-query logging

`createPool()` instruments `prepare().get/all/run/iterate` and logs any
statement at or above the threshold:

```
SLOW_QUERY_LOG_THRESHOLD_MS=100
```

- Default: `100` ms.
- `0`: log every statement (debugging only).
- Negative: disable instrumentation.
- Only the SQL text (truncated to 1000 chars) and duration are logged. Bound
  parameters are never logged, since they may contain credentials.
- Tests can pass `slowQueryThresholdMs` and `onSlowQuery` through `PoolOptions`
  instead of parsing logs.

Slow-query logs use level `warn`, so they appear when `LOG_LEVEL=info` or
`warn`. They also flow into the structured log pipeline alongside
`requestId`/`traceId` when emitted inside a request context.

## 4. Benchmarks

Run:

```bash
cd backend
npm run benchmark:indexes
```

The script seeds throwaway databases (50,000 tasks, 30,000 payments, 10,000
agents), measures each representative query with and without the index, and
prints the `EXPLAIN QUERY PLAN` plus a markdown table. Results are relative;
absolute timings vary by machine and disk. Representative run (Node 24, macOS,
local SSD):

| Index | Query | Before avg (ms) | After avg (ms) | Speedup |
|---|---|---:|---:|---:|
| `idx_tasks_wallet_created` | Wallet history, `createdAt >= ?`, newest first, limit 20 | 3.84 | 0.04 | **95.9×** |
| `idx_payments_task_status` | `taskId = ? AND status = ?` | 2.60 | 1.53 | **1.7×** |
| `idx_agents_status_capabilities` | `status = ?` + JSON capability match | 1.07 | 0.87 | **1.2×** |

Query plans confirm `SEARCH ... USING INDEX` for tasks and payments. Agents
uses the composite index for `status` and scans only the JSON capability arrays
of matching rows.

### Interpreting the numbers

- Wallet history is the dominant workload and benefits most; the previous
  query scanned the whole `tasks` table and sorted.
- Payments already have a primary key beginning with `taskId`, so the composite
  index is a smaller win and mainly avoids filtering large per-task result sets.
- Agent status alone is not selective (most agents are online); the index pays
  off when combined with capability checks or offline-admin views.

Re-run the benchmark after schema or query changes and update this table. CI
does not enforce timing thresholds, to avoid flaky results on shared runners.
