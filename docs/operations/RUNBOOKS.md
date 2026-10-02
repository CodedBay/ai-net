# 📋 Node Operator Runbooks

Operational runbooks for common failure scenarios encountered by ai-net node operators. Each runbook follows the format: **Symptom → Diagnosis → Fix → Prevention**.

> All commands in this guide are validated against the Docker Compose stack (`docker compose up -d`). Adjust paths for bare-metal systemd deployments (`/opt/ai-net/`).

---

## Table of Contents

1. [Runbook 1: Disk Full](#runbook-1-disk-full)
2. [Runbook 2: Stuck Task](#runbook-2-stuck-task)
3. [Runbook 3: Missed Contract Upgrade](#runbook-3-missed-contract-upgrade)
4. [Runbook 4: Circuit Breaker Open](#runbook-4-circuit-breaker-open)
5. [Runbook 5: Agent Heartbeat Failures](#runbook-5-agent-heartbeat-failures)

---

## Runbook 1: Disk Full

**Severity:** High — the node stops writing state changes and may corrupt in-flight tasks.

### Symptom

- Backend logs show `SQLITE_FULL` or `SQLITE_IOERR_WRITE` errors.
- `docker compose logs ainet-node` contains messages like:
  ```
  Error: SQLITE_FULL: database or disk is full
  ```
- `GET /health/ready` returns `500`.
- New task submissions return `503 Service Unavailable`.

### Diagnosis

**1. Check overall disk usage:**
```bash
df -h /
# Look for a filesystem at 95%+ usage
```

**2. Identify which SQLite database is consuming the most space:**
```bash
# Docker Compose — inspect the container volume
docker compose exec ainet-node du -sh /app/data/*.db 2>/dev/null || \
  ls -lah backend/*.db backend/data/*.db 2>/dev/null

# Bare-metal — locate all three databases
find /opt/ai-net -name "*.db" -exec du -sh {} \;
```

The three databases and their expected growth patterns:

| Database | File | Expected Growth | Notes |
|----------|------|-----------------|-------|
| `tasks.db` | Tasks and DAG execution history | High | Grows with every task submission |
| `agents.db` | Agent registry and heartbeat records | Low | Bounded by registered agent count |
| `payments.db` | Payment ledger and escrow records | Medium | Grows with on-chain settlements |

**3. Check WAL (Write-Ahead Log) files — these can be unexpectedly large:**
```bash
ls -lah backend/*.db-wal backend/*.db-shm 2>/dev/null
# A .db-wal file larger than 100 MB indicates a checkpoint backlog
```

**4. Identify log files consuming space:**
```bash
du -sh /var/log/ainet* /opt/ai-net/logs/ 2>/dev/null
docker compose logs --no-color ainet-node | wc -c
```

### Fix

**Step 1: Free immediate disk space by clearing old logs**
```bash
# Docker: truncate compose log (does not affect application state)
truncate -s 0 "$(docker inspect --format='{{.LogPath}}' $(docker compose ps -q ainet-node))"

# systemd: rotate and vacuum journal logs
sudo journalctl --vacuum-time=3d
sudo journalctl --vacuum-size=500M
```

**Step 2: Force a WAL checkpoint to reclaim space in SQLite**

A WAL checkpoint writes pending WAL frames back to the main database file and resets the WAL file to near-zero size. This is safe to run while the node is **stopped**.

```bash
# Stop the node gracefully first
docker compose stop ainet-node
# or: sudo systemctl stop ainet-node

# Run WAL checkpoint on each database
for db in backend/tasks.db backend/agents.db backend/payments.db; do
  if [ -f "$db" ]; then
    echo "Checkpointing $db ..."
    sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);"
    echo "Done. New size: $(du -sh $db)"
  fi
done

# Restart the node
docker compose start ainet-node
# or: sudo systemctl start ainet-node
```

**Step 3: Prune completed tasks older than 30 days** (optional, data-destructive — confirm before running)
```bash
# Dry-run: count rows that would be deleted
sqlite3 backend/tasks.db \
  "SELECT count(*) FROM tasks WHERE status IN ('completed','failed','cancelled') AND created_at < datetime('now','-30 days');"

# Execute pruning
sqlite3 backend/tasks.db \
  "DELETE FROM tasks WHERE status IN ('completed','failed','cancelled') AND created_at < datetime('now','-30 days');"

sqlite3 backend/tasks.db "VACUUM;"
```

**Step 4: Expand disk if space is structurally insufficient**
- Resize the EBS/block volume and extend the filesystem.
- For Docker volumes: migrate to a host volume on a larger mount point.

### Prevention

- Set up a disk usage alert at **80%** (e.g., Prometheus `node_filesystem_avail_bytes` threshold).
- Enable SQLite WAL auto-checkpoint via `PRAGMA wal_autocheckpoint=1000` in your database initialization (already set in `backend/src/db/`).
- Schedule weekly `VACUUM` jobs on each database during low-traffic windows.
- Configure log rotation for Docker and systemd: cap at 500 MB, retain 7 days.
- Review disk sizing guidelines in [Hardware & Network Requirements](../NODE_OPERATORS_GUIDE.md#2-hardware--network-requirements) — production nodes need **80 GB+ NVMe SSD**.

---

## Runbook 2: Stuck Task

**Severity:** Medium — tasks consume coordinator resources and escrow funds remain locked.

### Symptom

- A task remains in `running` or `queued` status for more than 2 hours.
- The `GET /api/v1/tasks/:id` response shows no `completedAt` or `failedAt` field.
- Escrow funds associated with the task are locked on-chain.
- Backend logs show no recent activity for that `taskId`.

### Diagnosis

**1. Query for tasks in non-terminal states older than 2 hours:**
```bash
sqlite3 backend/tasks.db \
  "SELECT id, status, wallet_public_key, created_at, updated_at
   FROM tasks
   WHERE status NOT IN ('completed','failed','cancelled')
     AND updated_at < datetime('now','-2 hours')
   ORDER BY created_at ASC;"
```

**2. Check the task's event history:**
```bash
sqlite3 backend/tasks.db \
  "SELECT event_type, occurred_at, payload
   FROM task_events
   WHERE task_id = 'task_YOUR_TASK_ID'
   ORDER BY occurred_at ASC;"
```

**3. Look for agent dispatch errors in the backend logs:**
```bash
# Docker
docker compose logs ainet-node | grep "task_YOUR_TASK_ID"

# systemd
journalctl -u ainet-node --since "2 hours ago" | grep "task_YOUR_TASK_ID"
```

**4. Check the job queue for stalled jobs:**
```bash
curl -s http://localhost:3001/api/v1/admin/queue/status \
  -H "Authorization: Bearer <admin_token>" | jq .
```

### Fix

**Step 1: Force-expire the stuck task via the API**

The admin endpoint sets a task's status to `failed` and records the reason:
```bash
curl -s -X POST http://localhost:3001/api/v1/admin/tasks/task_YOUR_TASK_ID/expire \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Manual expiry: task exceeded 2-hour SLA"}'
```

If the admin expire endpoint is unavailable, use SQLite directly (node must be stopped):
```bash
docker compose stop ainet-node

sqlite3 backend/tasks.db \
  "UPDATE tasks SET status='failed', updated_at=datetime('now'),
   error='Manual expiry: task exceeded 2-hour SLA'
   WHERE id='task_YOUR_TASK_ID' AND status NOT IN ('completed','failed','cancelled');"

docker compose start ainet-node
```

**Step 2: Trigger manual escrow return for locked funds**

If the task had an associated on-chain escrow lock, the payment escrow contract can be instructed to return funds after the timeout:
```bash
# Check escrow status for the task
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $PAYMENT_ESCROW_CONTRACT_ID \
  -- get_escrow_status \
  --task_id "task_YOUR_TASK_ID"

# If the escrow timeout has passed, trigger return
stellar contract invoke \
  --network testnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $PAYMENT_ESCROW_CONTRACT_ID \
  -- expire_and_return \
  --task_id "task_YOUR_TASK_ID"
```

**Step 3: Verify the fix**
```bash
curl -s http://localhost:3001/api/v1/tasks/task_YOUR_TASK_ID | jq '.status'
# Expected: "failed" or "cancelled"
```

### Prevention

- Configure `TASK_SLA_TIMEOUT_MINUTES=120` in `backend/.env` to enable automatic task expiry via the background cleanup worker.
- Set `ESCROW_TIMEOUT_LEDGERS` in the payment escrow contract to match your SLA (2 hours ≈ 1440 ledgers on Stellar at ~5 s/ledger).
- Monitor `ainet_tasks_stuck_total` Prometheus metric; alert when it exceeds `0` for more than 15 minutes.
- Enable the task reaper cron job: `TASK_REAPER_ENABLED=true` in `backend/.env`.

---

## Runbook 3: Missed Contract Upgrade

**Severity:** High — running outdated contract code may cause transaction failures or incompatibility with peers on upgraded networks.

### Symptom

- Backend logs contain `WasmVmError`, `ContractExecutionError`, or `function_not_found` from Soroban RPC calls.
- The upgrade script exited early with a non-zero status code during a maintenance window.
- Another node operator reports that your node is failing to interact with recently upgraded contracts.
- `GET /health/deep` shows `stellarRpc: "degraded"`.

### Diagnosis

**1. Check the currently deployed contract version on-chain:**
```bash
export NETWORK="testnet"
export UPGRADE_MANAGER_ID="<your UPGRADE_MANAGER_CONTRACT_ID from smart-contracts/deployments/testnet.json>"

stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- get_current_version
```
Note the returned `version` string.

**2. Check the latest version in the repository:**
```bash
# In smart-contracts/deployments/testnet.json
cat smart-contracts/deployments/testnet.json | jq '.version'

# Or from the Cargo.toml
grep -E '^version' smart-contracts/contracts/agent_registry/Cargo.toml
```

**3. Verify the WASM hash matches what is on-chain:**
```bash
# Build fresh artifacts
cd smart-contracts
cargo build --locked --target wasm32v1-none --release -p agent-registry

EXPECTED_HASH=$(sha256sum target/wasm32v1-none/release/agent_registry.wasm | awk '{print $1}')
echo "Expected WASM hash: $EXPECTED_HASH"

# Compare with on-chain hash
stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- get_current_wasm_hash
```

If the hashes differ, the upgrade was not applied.

### Fix

**Step 1: Verify the admin key is available and funded**
```bash
stellar keys address admin-testnet
stellar keys fund admin-testnet --network testnet  # testnet only
curl "https://horizon-testnet.stellar.org/accounts/$(stellar keys address admin-testnet)" | jq '.balances'
```

**Step 2: Re-run the upgrade script safely (idempotent)**

The upgrade manager checks if the proposed version is already active and exits cleanly if so — re-running is safe:
```bash
cd smart-contracts
export NETWORK="testnet"
export STELLAR_SECRET_KEY="<admin-key-secret>"

# Dry run first
./scripts/upgrade.sh --network testnet --dry-run --use-upgrade-manager agent-registry

# Apply the upgrade
./scripts/upgrade.sh --network testnet --use-upgrade-manager agent-registry
```

**Step 3: Verify post-upgrade state**
```bash
stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- get_current_version
# Expected: the new version string, e.g. "2.0.0"

# Smoke-test agent registry
stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_CONTRACT_ID \
  -- list_agents
```

**Step 4: Restart the backend node to pick up new contract ABIs**
```bash
docker compose restart ainet-node
# Wait for health probe to pass
curl -s http://localhost:3001/health/deep | jq '.services.stellarRpc'
# Expected: "ok"
```

**Rollback procedure (if the upgrade introduced regressions):**
```bash
# Check if within the 48-hour rollback window (~34,560 ledgers)
stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- can_rollback

# If true, execute rollback
stellar contract invoke \
  --network $NETWORK \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- rollback_upgrade
```

For the full upgrade and rollback procedure, see [TESTNET_UPGRADE_RUNBOOK.md](../../smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md).

### Prevention

- Subscribe to upgrade announcement channels (GitHub Releases, project Discord `#upgrades`).
- Run `npm run test:upgrade` in CI before every deployment to validate upgrade compatibility.
- Set a calendar reminder or cron-based health check that compares on-chain version with repository version nightly.
- Keep the admin key accessible (not in cold storage) during scheduled upgrade windows.

---

## Runbook 4: Circuit Breaker Open

**Severity:** Medium — all tasks requiring AI inference fail immediately; no new agent work is dispatched.

### Symptom

- Backend logs contain `CircuitBreakerOpenError` or `circuit_breaker_open`.
- `POST /api/v1/tasks` returns `502 Bad Gateway` with error code `PROVIDER_ERROR`.
- The Prometheus metric `ainet_circuit_breaker_state{provider="venice"}` is `1` (open).
- All agent workers log `Skipping inference: circuit breaker is OPEN`.

### Diagnosis

**1. Read the circuit breaker state from Prometheus metrics:**
```bash
curl -s http://localhost:3001/metrics | grep circuit_breaker
# Expected output:
#   ainet_circuit_breaker_state{provider="venice"} 1
#   ainet_circuit_breaker_failures_total{provider="venice"} 5
#   ainet_circuit_breaker_last_opened_at{provider="venice"} 1722345600
```

**2. Check Venice AI status directly:**
```bash
# Test Venice AI API connectivity
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $VENICE_API_KEY" \
  https://api.venice.ai/api/v1/models

# Expected: 200. If 401 → key expired. If 503 → Venice is down.
```

**3. Verify the Venice AI API key is valid:**
```bash
# Check key expiry
curl -s \
  -H "Authorization: Bearer $VENICE_API_KEY" \
  https://api.venice.ai/api/v1/account | jq '{status, quota_remaining}'
```

**4. Check for upstream outage reports:**
- Venice AI status page: https://status.venice.ai
- Stellar Horizon status: https://status.stellar.org

**5. Read circuit breaker configuration in backend:**
```bash
grep -E "CIRCUIT_BREAKER|VENICE" backend/.env
# Default: CIRCUIT_BREAKER_FAILURE_THRESHOLD=5, CIRCUIT_BREAKER_RESET_TIMEOUT_MS=60000
```

### Fix

**If Venice AI is healthy (API returns 200):**

The circuit breaker may be stuck open due to a transient failure burst. Manually reset it via the admin API:
```bash
curl -s -X POST http://localhost:3001/api/v1/admin/circuit-breaker/reset \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"provider": "venice"}'

# Expected response:
# { "provider": "venice", "state": "closed", "resetAt": "2026-10-01T12:00:00.000Z" }
```

Alternatively, restart the backend process — circuit breaker state is in-memory and resets on startup:
```bash
docker compose restart ainet-node
```

**If Venice AI is down:**

Do not reset the breaker — it is protecting the node from timeout storms. Wait for Venice AI to recover, then confirm:
```bash
# Confirm Venice is back
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $VENICE_API_KEY" \
  https://api.venice.ai/api/v1/models
# When 200, the circuit breaker will auto-close after CIRCUIT_BREAKER_RESET_TIMEOUT_MS (default: 60s)
```

**If the API key is expired:**
```bash
# 1. Rotate the key in Venice AI dashboard
# 2. Update .env
sed -i "s/^VENICE_API_KEY=.*/VENICE_API_KEY=your_new_key_here/" backend/.env

# 3. Restart to pick up new key
docker compose restart ainet-node

# 4. Verify health
curl -s http://localhost:3001/health/deep | jq '.services.venice'
# Expected: "ok"
```

### Prevention

- Configure Prometheus alerting on `ainet_circuit_breaker_state{provider="venice"} == 1` for more than 5 minutes.
- Rotate Venice AI API keys before they expire; set a calendar reminder 1 week before expiry.
- Increase `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` from `60000` to `120000` in high-traffic environments to reduce false resets.
- Consider configuring a fallback AI provider in `VENICE_FALLBACK_URL` (if supported in your deployment version).

---

## Runbook 5: Agent Heartbeat Failures

**Severity:** Medium — stale agents are excluded from task dispatch, reducing available capacity and potentially causing task routing failures.

### Symptom

- `GET /api/v1/agents` returns agents with `status: "offline"` that should be online.
- Backend logs contain `Heartbeat timeout: agent <id> marked offline`.
- The Prometheus metric `ainet_active_agents` drops unexpectedly.
- Tasks fail with `NO_AVAILABLE_AGENT` error code.

### Diagnosis

**1. Query for stale agents (last heartbeat > 10 minutes ago):**
```bash
sqlite3 backend/agents.db \
  "SELECT id, name, capability, status, last_heartbeat_at
   FROM agents
   WHERE last_heartbeat_at < datetime('now','-10 minutes')
     OR last_heartbeat_at IS NULL
   ORDER BY last_heartbeat_at ASC;"
```

**2. Check heartbeat configuration:**
```bash
grep -E "HEARTBEAT" backend/.env
# HEARTBEAT_INTERVAL_MS=300000      → agents send heartbeat every 5 minutes
# HEARTBEAT_STALE_THRESHOLD_MINUTES=5  → mark offline after 5 minutes of silence
# AGENT_OFFLINE_DELETE_HOURS=24     → delete offline agents after 24 hours
```

If `HEARTBEAT_INTERVAL_MS` ≥ `HEARTBEAT_STALE_THRESHOLD_MINUTES * 60000`, agents will always be marked stale — this is a misconfiguration.

**3. Check that the agent worker processes are running:**
```bash
# Docker: inspect container processes
docker compose exec ainet-node ps aux | grep -E "agent|worker"

# Verify agents are sending heartbeats in logs
docker compose logs ainet-node | grep -i heartbeat | tail -20
```

**4. Check for network connectivity issues between agent workers and the backend:**
```bash
# Inside the container
docker compose exec ainet-node curl -s http://localhost:3001/api/v1/health | jq .status
```

### Fix

**Step 1: Identify and restart any crashed agent workers**
```bash
# Docker Compose: restart the entire node (all agent workers run in-process)
docker compose restart ainet-node

# systemd: restart the service
sudo systemctl restart ainet-node

# Verify agents come back online (allow up to 60s for re-registration)
sleep 60
curl -s "http://localhost:3001/api/v1/agents?status=online" | jq '.[].name'
```

**Step 2: Force-deregister persistently offline agents**

For agents that are confirmed offline and should be removed from discovery:
```bash
# Force-deregister a specific agent via admin API
curl -s -X DELETE http://localhost:3001/api/v1/admin/agents/agent_AGENT_ID \
  -H "Authorization: Bearer <admin_token>" \
  -d '{"reason": "Agent confirmed offline > 24h, force-deregistering"}'

# Or via SQLite (node must be stopped):
docker compose stop ainet-node
sqlite3 backend/agents.db \
  "UPDATE agents SET status='offline', deleted_at=datetime('now')
   WHERE id='agent_AGENT_ID';"
docker compose start ainet-node
```

**Step 3: Re-register an agent after fixing its worker process**

After the underlying agent worker is healthy and running, trigger re-registration:
```bash
# The backend's agent workers auto-re-register on startup.
# For third-party agents, use the registration API:
curl -s -X POST http://localhost:3001/api/v1/agents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <agent_api_key>" \
  -d '{
    "agentId": "research-agent-v1",
    "capabilities": ["research"],
    "pricingXLM": 0.5,
    "endpoint": "https://your-agent.example.com/v1/execute",
    "stellarPublicKey": "GBZXN7..."
  }'
```

**Step 4: Send a manual heartbeat to bring an agent back online immediately**
```bash
curl -s -X POST http://localhost:3001/api/v1/agents/research-agent-v1/heartbeat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <agent_api_key>" \
  -d '{"status": "online", "activeJobs": 0}'
# Expected: { "acknowledged": true, "timestamp": "..." }
```

### Prevention

- Set `HEARTBEAT_INTERVAL_MS` to at most **half** of `HEARTBEAT_STALE_THRESHOLD_MINUTES * 60000`:
  - Example: `HEARTBEAT_INTERVAL_MS=120000` (2 min) with `HEARTBEAT_STALE_THRESHOLD_MINUTES=5` (5 min).
- Monitor `ainet_active_agents < expected_agent_count` in Prometheus and alert within 5 minutes.
- Use Docker's restart policy (`restart: always`) or systemd's `Restart=always` to automatically recover crashed worker processes.
- Implement a health check in your agent worker that calls `/api/v1/agents/:id/heartbeat` on a reliable internal timer (not dependent on the task pipeline being busy).

---

## Related Documentation

- [Node Operators Guide](../NODE_OPERATORS_GUIDE.md) — provisioning, configuration, and initial setup
- [Health Checks and Graceful Shutdown](health-and-shutdown.md) — probe contracts and shutdown order
- [Testnet Contract Upgrade Runbook](../../smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md) — full upgrade and rollback procedures
- [REST API Reference](../API_REFERENCE.md) — endpoint documentation including admin endpoints
- [Architecture Specification](../architecture/index.md) — system component reference
