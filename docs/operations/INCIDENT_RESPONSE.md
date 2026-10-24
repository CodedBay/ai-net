# Incident Response Playbook

This playbook is for production incidents affecting the ai-net backend, agent
workflows, Stellar payments, and supporting services. Use the service dashboards
and deployment tooling available to the on-call engineer; never put secrets,
wallet keys, customer data, or unredacted payloads in incident channels.

## Response Process

1. Acknowledge the alert and open an incident record. Record the start time,
   affected service, customer impact, and incident lead.
2. Assign an incident lead and a communications owner. For P1 incidents, page
   the roles in the escalation matrix immediately; do not wait for a complete
   diagnosis.
3. Stabilize first. Prefer rollback, traffic reduction, or disabling an affected
   nonessential feature over risky production changes.
4. Keep a timestamped log of observations, commands, decisions, and mitigations.
   Redact credentials and personal data.
5. Post status updates at the cadence in the severity table, even when there is
   no new diagnosis. State impact, mitigation, and next update time.
6. Confirm recovery using user-facing behavior and relevant health checks or
   metrics. Continue monitoring for recurrence before resolving the incident.
7. Schedule a blameless review and track corrective actions to owners and due
   dates.

## Severity

| Severity | Classification | Response target | Update cadence |
| --- | --- | --- | --- |
| P1 | Complete outage, broad data-integrity risk, or critical payment/security impact. | Page immediately; incident lead coordinates response. | Every 30 minutes, or sooner on material change. |
| P2 | Degraded core functionality or a major feature unavailable, with a workaround or limited impact. | Page the owning service on-call promptly. | Every 60 minutes, or sooner on material change. |
| P3 | Minor, isolated issue with no material impact to core workflows. | Create a tracked issue and notify the owning team during business hours. | At diagnosis and resolution. |

When impact is uncertain, start at the higher plausible severity and downgrade
only after confirming scope. The incident lead may raise severity at any time.

## Escalation Matrix

| Severity / trigger | Page or involve | Escalate when |
| --- | --- | --- |
| P1 | Primary on-call engineer, service owner, and engineering/operations lead. Add the security lead for suspected compromise or data exposure. | Page the secondary on-call and engineering leadership if the primary does not acknowledge within 10 minutes or no mitigation is progressing. |
| P2 | On-call for the affected service and its service owner. | Escalate to the primary on-call and engineering/operations lead if impact expands, the workaround fails, or there is no progress within 30 minutes. |
| P3 | Owning team through the normal issue tracker or team channel. | Promote to P2 if customer impact grows or a core workflow becomes unreliable. |
| External dependency incident | Internal service on-call first; then the dependency's support/status channel through the approved account. | Keep an internal incident lead; do not rely on the provider status page as the sole recovery signal. |

Use the organization-maintained on-call roster and approved paging channel to
resolve these roles. If a role or channel is not staffed, page the next-level
engineering lead. Incident communications must use the approved status channel.

## Scenario Playbooks

### 1. Backend API unresponsive (5xx)

**Symptoms:** Broad increase in HTTP 5xx responses, failed readiness probes, or
clients unable to complete API workflows. Classify P1 if all users or core
workflows are down; otherwise P2.

**Diagnosis:**
1. Check `/health` and `/health/ready` on multiple instances to separate a
   process failure from a dependency/readiness failure.
2. Review load-balancer error rate, instance count, restarts, and recent deploys.
3. Inspect application logs around the first failure for startup, database,
   queue, or unhandled-error signatures.
4. Compare `/health/deep` dependency status with Venice and Stellar Horizon
   availability.
5. Check CPU, memory, connection pools, and database/queue saturation.

**Resolution:**
1. Declare severity based on affected users and page the backend on-call.
2. If failures started after a release, roll back to the last known-good
   deployment using the deployment platform.
3. Remove unhealthy instances from service; restart only after collecting logs
   and confirming restart will not interrupt durable work.
4. If a dependency is failing, apply the matching dependency playbook and
   temporarily disable or shed nonessential dependent requests if supported.
5. If resources are exhausted, scale within established limits and reduce
   excess load; do not increase limits without checking downstream capacity.
6. Verify representative API workflows, readiness, error rates, and task
   processing before closing the incident.

**Prevention:** Keep deploy rollback available, alert on 5xx and readiness
failures, exercise graceful shutdown, and load-test resource limits.

### 2. Stellar payment failures (`SEQ_NUM_TOO_LOW`, `INSUFFICIENT_FEE`)

**Symptoms:** Payment submissions fail or remain unreconciled with Horizon
errors for sequence-number conflicts or insufficient fees. Classify P1 if a
broad set of payments is blocked or funds may be at risk; otherwise P2/P3 by
scope. Do not retry blindly.

**Diagnosis:**
1. Identify the affected network, wallet/account, transaction hash, and time
   range; keep secret keys out of the incident record.
2. Query the approved Horizon endpoint for account sequence, transaction
   status, and recent ledger state.
3. Check whether another worker or wallet client submitted a transaction using
   the same source account.
4. Inspect configured fee strategy and current network fee statistics.
5. Check payment task state and idempotency records before resubmitting any
   transaction.

**Resolution:**
1. Pause automated retries for the affected account or payment queue if they
   could create duplicate submissions.
2. For `SEQ_NUM_TOO_LOW`, reconcile the account sequence and pending
   transactions against Horizon before allowing the next submission.
3. Confirm the original transaction's ledger status; do not submit a replacement
   until duplicate-payment risk is ruled out.
4. For `INSUFFICIENT_FEE`, update the fee through the approved configuration or
   fee estimator, then rebuild and re-sign only through the authorized wallet
   flow.
5. Resume submissions gradually and monitor confirmation, failure, and
   reconciliation metrics.
6. Escalate disputed or potentially duplicated payments to the payment owner
   and finance/security contact; preserve transaction hashes and ledger evidence.

**Prevention:** Serialize account sequence allocation, use idempotency keys,
base fees on current network conditions, and alert on retry storms and
unreconciled payments.

### 3. Venice AI rate limiting (HTTP 429)

**Symptoms:** Venice requests return 429, task latency rises, or tasks enter
retry/degraded states. Classify P2 while core workflows are degraded; P1 only
if the resulting outage meets the complete-outage criteria.

**Diagnosis:**
1. Check provider status and the rate of 429 responses by endpoint/model.
2. Review internal request volume, concurrency, queue depth, and configured
   per-wallet or global quotas.
3. Inspect retry logs for `Retry-After`, backoff behavior, and repeated
   immediate retries.
4. Verify whether a recent deploy or traffic spike changed prompt size,
   concurrency, or request fan-out.
5. Confirm that provider credentials and account limits are valid without
   exposing credential values.

**Resolution:**
1. Preserve the response status and provider request ID in redacted logs, then
   page the backend/service on-call if impact is material.
2. Honor `Retry-After`; otherwise use bounded exponential backoff with jitter
   and a maximum attempt count.
3. Reduce concurrency and defer non-urgent work to prevent retry amplification.
4. Enforce existing wallet quotas and prompt-size limits; reject or queue excess
   work with a clear retryable response.
5. Use a configured fallback model/provider only if it is approved and
   compatible with the task's requirements.
6. Resume normal concurrency gradually after 429 rates fall and queue age
   returns to baseline.

**Prevention:** Bound concurrency, keep retries idempotent and jittered, alert
on provider throttling and queue age, and document provider quotas and fallback
behavior.

### 4. Redis connection failure

**Symptoms:** Redis connection timeouts/refusals, cache miss spikes, or errors
from features using Redis. Classify P2 if the service remains available with
degraded performance; P1 if the API is broadly unavailable.

**Diagnosis:**
1. Check Redis provider status, instance health, and network reachability from
   the backend environment.
2. Inspect application logs for connection timeout, authentication, TLS, or
   pool-exhaustion errors.
3. Review Redis memory, connection count, eviction, and latency metrics.
4. Determine which paths use Redis and whether Redis is cache-only or holds
   transient coordination state for the affected deployment.
5. Compare the incident start with deploys, network-policy changes, and secret
   rotation events.

**Resolution:**
1. Page the backend and infrastructure on-call; avoid logging connection
   strings or credentials.
2. If Redis is cache-only, enable the application's documented degraded mode
   or bypass cache reads while protecting the backing store from a load spike.
3. Restore service by correcting the identified network, TLS, authentication,
   or capacity issue through the normal infrastructure change process.
4. Restart or fail over the Redis service only after checking persistence and
   the effect on active coordination state.
5. Reconnect backend instances gradually and monitor connection pools, cache
   hit rate, and backing-store load.
6. Verify affected user workflows and ensure stale cache data is not being
   served before resolving the incident.

**Prevention:** Alert on Redis reachability and saturation, test degraded-mode
behavior, size connection pools deliberately, and document which state is safe
to lose.

### 5. SQLite database lock contention

**Symptoms:** `SQLITE_BUSY`/locked errors, slow writes, or failed task/payment
updates. Classify P2 if durable workflows are impaired; P1 if broad data
integrity or service availability is at risk.

**Diagnosis:**
1. Identify the database file and affected process from logs without copying
   production database contents into chat.
2. Check concurrent writers, long-running transactions, and connection lifetime
   in the affected service.
3. Inspect disk capacity, I/O latency, and SQLite journal/WAL configuration.
4. Correlate lock errors with backups, maintenance, migrations, or batch jobs.
5. Check health/readiness and confirm whether writes are failing or only
   delayed; preserve database files before any repair attempt.

**Resolution:**
1. Pause or throttle nonessential write-heavy jobs and retries to reduce
   contention.
2. Allow short transactions to finish; do not delete lock, journal, or WAL
   files while a process may still be using the database.
3. Stop duplicate writers or long-running maintenance processes using the
   service's normal shutdown procedure.
4. If contention persists, take a consistent backup and use the approved
   maintenance window to inspect integrity and journal mode.
5. Restore from a verified backup only if integrity is compromised, following
   the database recovery procedure and recording the recovery point.
6. Resume writers in stages and verify row counts, task/payment state, and
   readiness before closing.

**Prevention:** Keep write transactions short, serialize writes where needed,
avoid shared-file multi-process writers, run maintenance off-peak, and verify
backups and integrity checks.

### 6. Smart contract deployment failure on testnet

**Symptoms:** Deployment, invocation, or verification fails on Stellar testnet;
the expected contract ID or WASM hash is absent. Classify P2 when blocking a
release or shared test environment; otherwise P3.

**Diagnosis:**
1. Record the network, deploy command/version, contract WASM hash, and
   transaction hash; never include a private key or secret phrase.
2. Query the testnet Horizon/Soroban RPC for transaction status and diagnostic
   events.
3. Confirm the deployer account has testnet XLM and an available sequence.
4. Check build target, WASM artifact, CLI/toolchain version, and required
   contract constructor arguments.
5. Compare the failing artifact and invocation with the last successful
   deployment record.

**Resolution:**
1. Stop repeated deploy attempts until the failed transaction status and
   account sequence are reconciled.
2. For resource or fee failures, inspect simulation output and adjust only the
   approved resource/fee settings before retrying.
3. Rebuild the contract from the checked-in source with the pinned toolchain
   and verify the artifact hash.
4. Confirm the correct testnet and contract arguments, then submit one
   controlled deployment using the approved test account.
5. Wait for final ledger status and verify the deployed contract ID and WASM
   hash through the RPC/read path.
6. Run a harmless read or test invocation and record the deployment metadata
   before unblocking downstream work.

**Prevention:** Pin the Soroban toolchain, retain artifact hashes and deploy
logs, preflight balances/network selection, and exercise deployment in CI.

### 7. WebSocket connections dropping at scale

**Symptoms:** Elevated disconnect/reconnect rates, missed task updates, or
connection errors as concurrent clients increase. Classify P2 if real-time
updates are degraded but polling/API recovery works; P1 if core workflows are
unavailable.

**Diagnosis:**
1. Compare active connections and disconnect codes across instances and
   clients.
2. Check load-balancer idle timeouts, websocket upgrade routing, proxy limits,
   and heartbeat behavior.
3. Inspect per-instance memory, file descriptors, event-loop lag, and outbound
   queue depth.
4. Check whether clients reconnect with exponential backoff or synchronize
   reconnects into a thundering herd.
5. Verify that reconnecting clients can recover current state through the API
   or replay mechanism.

**Resolution:**
1. Page the realtime/backend on-call and set incident severity based on
   workflow impact, not disconnect count alone.
2. Roll back a recent websocket or proxy configuration change if it aligns
   with the failure.
3. Increase capacity only within known limits and distribute connections
   across healthy instances.
4. Apply bounded client reconnect backoff with jitter; rate-limit reconnect
   bursts if needed.
5. Tune heartbeat and idle timeout settings consistently across app and
   load-balancer layers.
6. Confirm reconnect state recovery and monitor disconnect rate, event-loop
   lag, and queue depth while gradually restoring traffic.

**Prevention:** Load-test realistic concurrent sessions, alert on disconnect
rate and event-loop lag, use jittered reconnects, and provide an API recovery
path for missed events.

### 8. Nightly E2E pipeline failure

**Symptoms:** Scheduled end-to-end workflow fails, times out, or reports
flakiness. Classify P2 if it blocks a release or signals a production-impacting
regression; otherwise P3.

**Diagnosis:**
1. Identify the failed workflow, job, commit, test, and whether the failure is
   reproducible; link the CI run in the incident record.
2. Read the first failing assertion and collect sanitized logs, screenshots,
   traces, and artifacts.
3. Check environment health, deployed test version, fixture state, and external
   dependency availability.
4. Compare with recent successful runs and changes affecting the failure path.
5. Determine whether the failure is product regression, infrastructure issue,
   test flake, or test-data drift; do not dismiss a failure as flaky without
   evidence.

**Resolution:**
1. Notify the owning team and link the failed run; raise severity if release
   confidence or production safety is affected.
2. Re-run once in a clean environment when infrastructure instability is
   plausible, preserving the original run's artifacts.
3. If a product regression is confirmed, block promotion and revert or fix the
   responsible change through the normal review process.
4. If test infrastructure is responsible, restore the runner/service or
   dependency and rerun the same workflow.
5. If a test is nondeterministic, quarantine only through the established
   process, create an owner-tracked issue, and retain coverage for the behavior.
6. Confirm the full relevant pipeline passes and communicate release impact
   before closing the incident.

**Prevention:** Keep E2E environments reproducible, retain artifacts, track
flake rates, use deterministic fixtures, and assign owners and deadlines to
quarantined tests.

## Post-Incident Review Template

Copy this section into the incident record and complete it without changing the
template structure.

### Incident Summary

- Incident ID and title:
- Severity and final status:
- Incident lead / review facilitator:
- Start, detection, mitigation, and resolution timestamps (include timezone):
- Services and user workflows affected:
- Customer impact and duration:

### Timeline

| Time (timezone) | Event, observation, or decision | Owner / source |
| --- | --- | --- |
| | | |

### Analysis

- What happened:
- Technical root cause and contributing factors:
- How the incident was detected; what delayed detection:
- What went well:
- What made response or recovery harder:
- Data loss, security, payment, or compliance impact (state none if none):

### Corrective Actions

| Action | Type (prevent / detect / mitigate) | Owner | Due date | Tracking link | Status |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

### Review

- Review date and attendees:
- Open questions and follow-up owner:
- Next review date, if actions remain open: