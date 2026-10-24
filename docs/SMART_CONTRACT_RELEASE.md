# Smart Contract Release Engineering Guide

This guide covers the full release lifecycle for ai-net Soroban smart contracts: WASM compilation, artifact versioning, testnet validation, governance approval, mainnet deployment, emergency hotfixes, and post-deployment verification.

> For backend and frontend release procedures, see [RELEASE_ENGINEERING.md](./RELEASE_ENGINEERING.md).
> For detailed upgrade mechanics and rollback commands, see [smart-contracts/docs/UPGRADE_GUIDE.md](../smart-contracts/docs/UPGRADE_GUIDE.md) and [smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md](../smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md).

---

## Table of Contents

1. [Release Workflow Overview](#1-release-workflow-overview)
2. [WASM Compilation & Artifact Versioning](#2-wasm-compilation--artifact-versioning)
3. [Testnet Deployment & Validation](#3-testnet-deployment--validation)
4. [Governance Approval for Breaking Upgrades](#4-governance-approval-for-breaking-upgrades)
5. [Mainnet Deployment](#5-mainnet-deployment)
6. [Emergency Hotfix Process](#6-emergency-hotfix-process)
7. [Post-Deployment Verification](#7-post-deployment-verification)
8. [Upgrade Safety Checklist](#8-upgrade-safety-checklist)

---

## 1. Release Workflow Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Smart Contract Release Pipeline                     │
│                                                                     │
│  1. Compile WASM  ──►  2. Testnet Deploy  ──►  3. E2E Validation   │
│                                                        │            │
│                                                        ▼            │
│  Non-breaking:  ────────────────────────────►  4. Mainnet Deploy   │
│  Breaking:      ──►  Governance Proposal ──►  Timelock ──► Deploy  │
└─────────────────────────────────────────────────────────────────────┘
```

### Change Classification

| Change type | Example | Governance required | Testnet window |
|---|---|---|---|
| **Patch** — bug fix, no storage change | Off-by-one in fee calc | No | 24 hours |
| **Minor** — new endpoint, additive storage | New `get_agent_stats` function | No | 48 hours |
| **Breaking** — storage layout change, removed function, auth change | Migrate `agents` map key format | **Yes** | 7 days |
| **Security hotfix** — active exploit mitigation | Reentrancy guard addition | **No** (bypass) | CI only |

---

## 2. WASM Compilation & Artifact Versioning

### 2.1 Deterministic Build

All WASM artifacts must be built deterministically to produce reproducible SHA-256 hashes:

```bash
cd smart-contracts

# Install the locked Rust toolchain (from rust-toolchain.toml)
rustup show

# Build optimized WASM binaries (locked deps, reproducible output)
cargo build --locked --target wasm32v1-none --release

# Artifacts are at:
ls target/wasm32v1-none/release/*.wasm
```

### 2.2 Generate Checksums

Every release artifact must have a corresponding SHA-256 checksum:

```bash
cd smart-contracts/target/wasm32v1-none/release

# Generate checksums for all contracts
sha256sum agent_registry.wasm \
           agent_bidding.wasm \
           upgrade_manager.wasm \
           error_resolver.wasm \
  > SHA256SUMS

cat SHA256SUMS
```

### 2.3 Version Management

Smart contracts follow SemVer. The version is tracked in two places:

1. **`Cargo.toml`** — Rust crate version used by the build toolchain
2. **On-chain** — The `get_version` contract function returns the deployed version string

Bump versions before releasing:

```bash
# In smart-contracts/contracts/agent-registry/Cargo.toml
# version = "1.2.0"

# Verify the version is embedded at build time
cargo build --locked --target wasm32v1-none --release
```

### 2.4 WASM Artifact Storage

Release artifacts are published to:

- **GitHub Releases** — each tag includes WASM files and `SHA256SUMS` as release assets
- **`smart-contracts/deployments/`** — JSON metadata records the deployed WASM hash per network and contract

Never commit WASM binaries to source control. The `deployments/*.json` files record the hash reference only.

---

## 3. Testnet Deployment & Validation

### 3.1 Prerequisites

```bash
# Ensure environment variables are set
export NETWORK="testnet"
export STELLAR_SECRET_KEY="S..."        # Funded testnet account
export UPGRADE_MANAGER_ID="C..."        # Upgrade Manager contract ID on testnet
export ADMIN_ADDRESS="G..."             # Admin keypair address
```

If you do not have a funded testnet account, use Friendbot:

```bash
curl "https://friendbot.stellar.org?addr=$ADMIN_ADDRESS"
```

### 3.2 Deploy to Testnet

```bash
cd smart-contracts

# Full deployment with verification
./scripts/deploy.sh --network testnet --verify

# Or upgrade an already-deployed contract
./scripts/upgrade.sh --network testnet --use-upgrade-manager --dry-run
./scripts/upgrade.sh --network testnet --use-upgrade-manager agent-registry
```

### 3.3 Run Integration Tests

```bash
# Unit and integration tests (no network required)
cargo test

# Full testnet E2E tests (requires RUN_STELLAR_E2E_TESTS=true)
cd smart-contracts
cp .env.example .env
# Set STELLAR_COORDINATOR_SECRET, VENICE_API_KEY, RUN_STELLAR_E2E_TESTS=true
npm run test:e2e
```

Expected E2E test duration: 60–120 seconds. Tests fund fresh testnet accounts via Friendbot, execute the five-node market report DAG, verify payment operations through Horizon, and validate the Report Agent result.

### 3.4 Mandatory Testnet Soak Period

| Change type | Minimum testnet soak |
|---|---|
| Patch | 24 hours with no error events |
| Minor | 48 hours with no error events |
| Breaking | 7 days, with stakeholder sign-off |
| Security hotfix | CI green (no additional soak required) |

Monitor the testnet deployment during the soak period:

```bash
# Watch upgrade and error events on testnet
stellar events --network testnet \
  --start-ledger $CURRENT_LEDGER \
  --contract $CONTRACT_ID \
  --topic registry

# Check contract health
./scripts/verify.sh --network testnet
```

---

## 4. Governance Approval for Breaking Upgrades

Breaking upgrades require a governance proposal before mainnet deployment. The governance system enforces a minimum **48-hour timelock** between proposal and execution.

### 4.1 What Requires Governance Approval

A governance proposal is required for any upgrade that:

- Changes the storage layout of an existing contract (add/remove/rename keys)
- Removes or renames a public contract function
- Changes the authorization model (adds/removes `require_auth` calls)
- Changes fee structures or token economics
- Upgrades the `upgrade_manager` contract itself

### 4.2 Creating a Governance Proposal

```bash
# Step 1: Propose the upgrade via the upgrade manager
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- propose_upgrade \
  --new_version "2.0.0" \
  --new_wasm_hash $NEW_WASM_HASH \
  --description "v2.0.0: Migrate agent records to composite key format for pagination performance" \
  --migration_plan '{
    "pre_migration_checks": ["validate_storage_keys", "verify_agent_count"],
    "data_transformations": ["migrate_agent_records_to_v2_composite_key"],
    "post_migration_validations": ["verify_record_counts", "validate_composite_index"],
    "estimated_items": 500
  }'
```

### 4.3 Announcing the Proposal

Post a governance announcement to the project's governance forum and Discord `#governance` channel. Include:

- **Summary** of what changes and why
- **WASM hash** of the new artifact (`sha256sum agent_registry.wasm`)
- **Migration plan** (data transformations and validation steps)
- **Testnet evidence** (E2E test results, soak period logs)
- **Rollback plan** (48-hour rollback window via `rollback_upgrade`)
- **Voting deadline** — minimum 48 hours from proposal time

**Example announcement template:**

```markdown
## Governance Proposal: Agent Registry v2.0.0

**Type:** Breaking change (storage migration)
**Proposed by:** @<github-handle>
**WASM hash:** sha256:abc123...
**Testnet deployment:** Testnet since 2026-09-01, 7-day soak complete
**Proposed mainnet execution:** 2026-09-15T12:00:00Z (48h after this post)

### What changes
The agent record storage key format is migrated from a simple string key to a
composite key (capability + agent_id) to enable O(1) capability-filtered lookups.

### Migration
500 existing agent records will be migrated in the post-upgrade hook. Estimated
gas cost: 1.2 XLM. Migration is atomic — if any record fails, the entire upgrade
reverts.

### Rollback
Emergency rollback is available within 48 hours of execution via `rollback_upgrade`.
Rollback WASM hash: sha256:prev123...

### Testnet Evidence
- E2E tests: 100% pass rate
- Soak period: 7 days, 0 error events
- Gas benchmark: within 10% of v1.0 baseline
```

### 4.4 Validating and Executing the Proposal

```bash
# After community review and no objections:

# Step 2: Validate the proposal (checks compatibility and estimates gas)
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- validate_proposal

# Step 3: Execute after the timelock window has passed
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- execute_upgrade
```

### 4.5 Multi-Signature for Mainnet

For mainnet upgrades, configure the upgrade manager to require multi-signature authorization. A 2-of-3 multi-sig setup is recommended for production:

```bash
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- set_multisig_config \
  --threshold 2 \
  --signers "[\"$ADMIN_1\", \"$ADMIN_2\", \"$ADMIN_3\"]"
```

---

## 5. Mainnet Deployment

### 5.1 Pre-Deployment Checklist

Complete all items in the [Upgrade Safety Checklist](#8-upgrade-safety-checklist) before executing on mainnet.

### 5.2 Deploy or Upgrade

**Initial mainnet deployment (first time only):**

```bash
cd smart-contracts

export NETWORK="mainnet"
export STELLAR_SECRET_KEY="S..."   # Funded mainnet account

./scripts/deploy.sh --network mainnet --verify
```

**Subsequent upgrades:**

```bash
# Dry-run to confirm what will change
./scripts/upgrade.sh --network mainnet --use-upgrade-manager --dry-run

# Execute upgrade (non-breaking) or post-governance approval (breaking)
./scripts/upgrade.sh --network mainnet --use-upgrade-manager agent-registry

# Verify the upgrade
./scripts/verify.sh --network mainnet
```

### 5.3 Update Deployment Metadata

After a successful deployment, commit the updated `deployments/mainnet.json` to the repository:

```bash
git add smart-contracts/deployments/mainnet.json
git commit -m "chore(contracts): update mainnet deployment metadata for v2.0.0"
git push origin main
```

### 5.4 Announce Completion

Post in `#announcements` with the mainnet contract IDs, WASM hash, and a link to the GitHub Release.

---

## 6. Emergency Hotfix Process

Emergency hotfixes address **active exploits or critical security vulnerabilities** and may bypass the normal governance approval and testnet soak requirements.

### 6.1 When to Use the Hotfix Track

The hotfix track is appropriate when:

- An exploit is actively draining funds or disrupting the network
- A critical vulnerability has been privately disclosed and requires immediate patching
- A consensus-breaking bug is preventing ledger progression

It is **not** appropriate for:

- Performance improvements
- Non-critical bug fixes
- Feature additions
- Routine breaking changes

### 6.2 Hotfix Procedure

```
Hotfix Track:
  1. Write & test fix (local + CI)
  2. Build deterministic WASM
  3. Notify security team (private channel)
  4. Deploy directly to mainnet (bypassing governance timelock)
  5. Post-hoc governance ratification within 72 hours
```

**Step 1: Create a hotfix branch**

```bash
git checkout -b hotfix/exploit-escrow-drain-CVE-2026-001
# Apply minimal fix
# Run: cargo test && cargo clippy -- -D warnings
```

**Step 2: Build and hash the hotfix WASM**

```bash
cd smart-contracts
cargo build --locked --target wasm32v1-none --release
sha256sum target/wasm32v1-none/release/agent_registry.wasm
```

**Step 3: Notify the security team**

Before deploying, notify the security team via the private `#security-incidents` channel with:
- CVE or incident ID
- Nature of the vulnerability
- WASM hash of the hotfix
- Proposed deployment time

**Step 4: Deploy to mainnet using the upgrade manager bypass**

```bash
# The upgrade manager supports an emergency upgrade path that bypasses
# the timelock when called by a quorum of the emergency multisig signers.

# Signer 1
stellar contract invoke \
  --network mainnet \
  --source-account $EMERGENCY_SIGNER_1_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- emergency_upgrade \
  --new_wasm_hash $HOTFIX_WASM_HASH \
  --incident_id "CVE-2026-001" \
  --justification "Active escrow drain exploit mitigated by reentrancy guard"

# Signer 2 (second signature completes the 2-of-3 threshold)
stellar contract invoke \
  --network mainnet \
  --source-account $EMERGENCY_SIGNER_2_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- emergency_upgrade \
  --new_wasm_hash $HOTFIX_WASM_HASH \
  --incident_id "CVE-2026-001" \
  --justification "Active escrow drain exploit mitigated by reentrancy guard"
```

> **Note:** The 48-hour rollback window is still active after an emergency upgrade. If the hotfix introduces a regression, use `rollback_upgrade` immediately.

**Step 5: Post-hoc governance ratification**

Within 72 hours of the emergency deployment, publish a governance post documenting:

- The incident (CVE or incident ID)
- The vulnerability exploited
- The fix applied
- The WASM hash deployed
- Post-deployment impact assessment

This ensures transparency and community oversight of the emergency track.

**Step 6: Merge hotfix to main**

```bash
git checkout main
git merge hotfix/exploit-escrow-drain-CVE-2026-001
git tag -a v1.3.1 -m "Security hotfix: escrow drain (CVE-2026-001)"
git push origin main v1.3.1
```

---

## 7. Post-Deployment Verification

Run these checks immediately after every mainnet deployment.

### 7.1 Version and Hash Verification

```bash
# Confirm the new version is active
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- get_current_version
# Expected: { "version": "2.0.0", "wasm_hash": "<NEW_WASM_HASH>" }
```

### 7.2 State Equivalence — Existing Records Still Readable

```bash
# Query a known pre-upgrade agent
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_agent \
  --agent_id "agent-prod-001"

# List agents by capability (tests the migrated composite index)
stellar contract invoke \
  --network mainnet \
  --source-account $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_agents_by_capability \
  --capability "research"
```

### 7.3 Backend Reconciliation

Trigger a reconciliation to confirm the backend's off-chain state matches the on-chain registry:

```bash
curl -s -X POST https://api.mainnet.ai-net.epta-node.io/api/v1/reconciliation \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
# Expected: { "reconciliationStatus": "success", "discrepanciesResolved": 0, ... }
```

### 7.4 End-to-End Smoke Test

Submit a minimal task through the live API and confirm it completes and settles:

```bash
TASK_ID=$(curl -s -X POST https://api.mainnet.ai-net.epta-node.io/api/v1/tasks \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskType": "health_check", "requiredCapability": "research", "budgetXlm": "0.1"}' \
  | jq -r .taskId)

# Poll until completed
for i in $(seq 1 12); do
  STATUS=$(curl -s "https://api.mainnet.ai-net.epta-node.io/api/v1/tasks/$TASK_ID" | jq -r .status)
  echo "[$i] status: $STATUS"
  [ "$STATUS" = "completed" ] && break
  sleep 10
done
```

### 7.5 Monitor for 24 Hours

Watch the Grafana `ai-net Overview` dashboard and Prometheus alerts for 24 hours after every mainnet deployment. Pay particular attention to:

- Escrow lock/release error rate (should be 0)
- `StellarHorizonUnhealthy` alert (should not fire)
- Task completion rate (should return to baseline within 15 minutes)

---

## 8. Upgrade Safety Checklist

Complete all items before executing a mainnet upgrade. Use this as the sign-off document.

### Build & Artifacts

- [ ] WASM built with `cargo build --locked` (reproducible build)
- [ ] `SHA256SUMS` generated and verified against the uploaded WASM
- [ ] `Cargo.toml` version bumped correctly (patch / minor / major)
- [ ] No `console.log`, debug macros, or test-only code in WASM artifact

### Testing

- [ ] All unit tests pass: `cargo test`
- [ ] Clippy passes with no warnings: `cargo clippy --all-targets -- -D warnings`
- [ ] E2E tests pass on testnet: `npm run test:e2e`
- [ ] Upgrade integration test passes: `npm run test:upgrade`

### Storage Migration Review

- [ ] Storage layout diff reviewed — no unintentional key removals
- [ ] Migration plan tested on a testnet fork with production-scale data
- [ ] Gas benchmark within 20% of previous version baseline
- [ ] Post-migration data integrity validation passes for all entity types

### Governance (Breaking Changes Only)

- [ ] Governance proposal published at least 48 hours before execution
- [ ] No blocking objections from community or core team
- [ ] Multi-sig 2-of-3 signatures collected for `execute_upgrade`
- [ ] Governance ratification post published after deployment

### Rollback Readiness

- [ ] Previous WASM hash recorded: `_______________________`
- [ ] Rollback tested on testnet: `rollback_upgrade` confirmed working
- [ ] Rollback window confirmed: 48 hours (34,560 ledgers) from execution time

### Post-Deployment

- [ ] `get_current_version` returns expected new version
- [ ] Existing records readable post-migration
- [ ] Backend reconciliation reports zero discrepancies
- [ ] E2E smoke test task completes and settles on mainnet
- [ ] `deployments/mainnet.json` committed and pushed
- [ ] GitHub Release created with WASM artifacts and SHA256SUMS attached
- [ ] Monitoring dashboard reviewed for 24 hours post-deployment

### Sign-Off

| Role | Name | Date | Signature |
|---|---|---|---|
| Smart Contract Engineer | | | |
| Release Manager | | | |
| Security Reviewer | | | |
| On-call Engineer (24h watch) | | | |

---

## Related Documentation

- [Release Engineering Guide](./RELEASE_ENGINEERING.md) — Backend and frontend release procedures
- [UPGRADE_GUIDE.md](../smart-contracts/docs/UPGRADE_GUIDE.md) — Upgrade Manager architecture and migration hooks
- [TESTNET_UPGRADE_RUNBOOK.md](../smart-contracts/docs/TESTNET_UPGRADE_RUNBOOK.md) — Step-by-step testnet upgrade commands
- [DEPLOYMENT_GUIDE.md](../smart-contracts/docs/DEPLOYMENT_GUIDE.md) — Initial deployment workflow
- [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md) — Release security gate
- [THREAT_MODEL.md](./THREAT_MODEL.md) — On-chain threat analysis and mitigations
