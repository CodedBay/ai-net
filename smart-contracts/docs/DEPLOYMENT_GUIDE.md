# Smart Contract Deployment & Upgrade Guide

Complete reference for deploying and upgrading ai-net Soroban smart contracts on standalone, testnet, and mainnet.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-Time Deployment](#2-first-time-deployment)
   - [Standalone (Local Docker)](#21-standalone-local-docker)
   - [Testnet](#22-testnet)
   - [Mainnet](#23-mainnet)
3. [Verifying Deployment](#3-verifying-deployment)
4. [Upgrading Contracts](#4-upgrading-contracts)
   - [Standard Upgrade Path](#41-standard-upgrade-path)
   - [Emergency Upgrade Path](#42-emergency-upgrade-path)
5. [Using the UpgradeManager](#5-using-the-upgrademanager)
6. [Rollback Procedure](#6-rollback-procedure)
7. [Post-Upgrade Verification](#7-post-upgrade-verification)
8. [Troubleshooting Deployment Failures](#8-troubleshooting-deployment-failures)

---

## 1. Prerequisites

### 1.1 Required Tools

| Tool | Minimum Version | Install |
|---|---|---|
| Rust | 1.74+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `wasm32-unknown-unknown` target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI (`stellar`) | 22.0+ | `cargo install --locked stellar-cli` |
| `jq` | 1.6+ | `apt install jq` / `brew install jq` |
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |

Verify the installation:

```bash
stellar --version
# Expected: stellar 22.x.x

cargo --version
# Expected: cargo 1.74.x

jq --version
# Expected: jq-1.6 or higher
```

### 1.2 Funded Accounts

Every deployment requires an account with sufficient XLM to pay transaction fees and minimum balance reserves.

**Testnet** — use Friendbot to create and fund a free testnet account:

```bash
# Generate a new keypair
stellar keys generate --global deployer --network testnet

# Fund via Friendbot
stellar keys fund deployer --network testnet

# Confirm balance
stellar keys address deployer --network testnet
# Then check: https://horizon-testnet.stellar.org/accounts/<PUBLIC_KEY>
```

Expected Friendbot response:
```
Account funded: GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**Mainnet** — you must transfer at least 10 XLM to the deployer account before running any scripts.

### 1.3 Environment Variables

All scripts read from a `.env` file in `smart-contracts/`. Copy the template and fill in values:

```bash
cd smart-contracts
cp .env.example .env
```

Open `.env` and configure:

```bash
# Required — the deployer's secret key
STELLAR_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Required for live agent tests
VENICE_API_KEY=your_venice_api_key_here

# Network selector (testnet | futurenet | mainnet | standalone)
STELLAR_NETWORK=testnet

# Optional overrides — scripts use network defaults if left blank
STELLAR_RPC_URL=
STELLAR_HORIZON_URL=

# Enable live E2E tests against Stellar
RUN_STELLAR_E2E_TESTS=false
RUN_STELLAR_INTEGRATION_TESTS=false
```

> **Security:** Never commit `.env` to version control. The repository's `.gitignore` excludes it. Use separate keys for each network and rotate mainnet keys regularly.

### 1.4 Scripts Directory

```
smart-contracts/scripts/
├── deploy.sh          # First-time contract deployment
├── upgrade.sh         # Contract upgrades with safety checks
├── verify.sh          # Post-deployment verification
└── manage.sh          # High-level orchestration interface
```

### 1.5 Deployment Metadata

Each network maintains a versioned JSON manifest under `smart-contracts/deployments/`:

```
smart-contracts/deployments/
├── testnet.json             # Live testnet state (auto-updated by scripts)
├── mainnet.json             # Live mainnet state (auto-updated by scripts)
├── futurenet.json           # Futurenet state
├── testnet.json.template    # Starting template for new deployments
└── mainnet.json.template
```

---

## 2. First-Time Deployment

### 2.1 Standalone (Local Docker)

Use the Docker Compose stack for rapid local iteration. The `stellar-standalone` service runs a private Stellar node.

```bash
# 1. Start the full stack
docker compose up -d stellar-standalone

# Wait for it to become healthy (≈15 seconds)
docker compose ps
# Expected: ai-net-stellar-standalone   running (healthy)

# 2. Configure environment for standalone
cd smart-contracts
cat > .env << 'EOF'
STELLAR_NETWORK=standalone
STELLAR_SECRET_KEY=SBDZKJFEOYFLUXHYY7IJQZAJKJFXBQHZFQKZLLMFBJ5GCJJSMGYGFQB
STELLAR_RPC_URL=http://localhost:8000/soroban/rpc
STELLAR_HORIZON_URL=http://localhost:8000
VENICE_API_KEY=mock_local_key
EOF

# 3. Install Node dependencies
npm ci

# 4. Deploy all contracts
./scripts/deploy.sh --network standalone
```

Expected output:

```
=== ai-net Smart Contract Deployment ===
Network:    standalone
RPC URL:    http://localhost:8000/soroban/rpc

Building contracts...
✓ Built agent-registry
✓ Built error-resolver

Deploying contracts to standalone...

Deploying agent-registry...
✓ Deployed agent-registry
  Contract ID: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  Wasm Hash:   a3f9...

Deploying error-resolver...
✓ Deployed error-resolver
  Contract ID: CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
  Wasm Hash:   7e1d...

=== Deployment completed successfully ===
Deployment metadata saved to: deployments/standalone.json
```

### 2.2 Testnet

```bash
cd smart-contracts

# 1. Ensure STELLAR_SECRET_KEY and VENICE_API_KEY are set in .env
source .env

# 2. Run the deployment (builds Wasm, deploys, saves manifest)
./scripts/deploy.sh --network testnet

# 3. Verify after deployment
./scripts/verify.sh --network testnet
```

To skip rebuilding (e.g., redeploying from existing artifacts):

```bash
./scripts/deploy.sh --network testnet --skip-build
```

To deploy and immediately verify in one command:

```bash
./scripts/deploy.sh --network testnet --verify
```

Expected verification output:

```
=== Verification Report ===
Network: testnet
Deployment file: deployments/testnet.json

Verifying agent-registry...
  ✓ Contract found on network
  ✓ Wasm hash matches: a3f9...
  ✓ Contract responds to health check

Verifying error-resolver...
  ✓ Contract found on network
  ✓ Wasm hash matches: 7e1d...
  ✓ Contract responds to health check

=== All contracts verified ===
```

### 2.3 Mainnet

Mainnet deployment follows the same steps as testnet with additional safeguards.

> **Warning:** Mainnet transactions cost real XLM. Always run a dry-run and verify on testnet first.

```bash
cd smart-contracts

# 1. Confirm your .env points to mainnet
STELLAR_NETWORK=mainnet
STELLAR_RPC_URL=https://soroban-rpc.stellar.org
STELLAR_HORIZON_URL=https://horizon.stellar.org

# 2. Dry-run — inspect what would be deployed without sending transactions
./scripts/deploy.sh --network mainnet --dry-run

# 3. Deploy (only after testnet validation)
./scripts/deploy.sh --network mainnet --verify
```

**Network Endpoints Reference**

| Network | RPC URL | Horizon URL | Passphrase |
|---|---|---|---|
| Standalone | `http://localhost:8000/soroban/rpc` | `http://localhost:8000` | `Standalone Network ; February 2017` |
| Testnet | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` | `Test SDF Network ; September 2015` |
| Futurenet | `https://rpc-futurenet.stellar.org` | `https://horizon-futurenet.stellar.org` | `Test SDF Future Network ; October 2022` |
| Mainnet | `https://soroban-rpc.stellar.org` | `https://horizon.stellar.org` | `Public Global Stellar Network ; September 2015` |

### 2.4 Manual Deployment (Without Scripts)

For environments where the shell scripts cannot run, deploy manually with the Stellar CLI:

```bash
# 1. Build Wasm
cargo build --target wasm32-unknown-unknown --release

# 2. Optimize (optional but reduces on-chain fees)
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm

# 3. Upload Wasm to network
WASM_HASH=$(stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm \
  --source $STELLAR_SECRET_KEY \
  --network testnet)

echo "Wasm hash: $WASM_HASH"

# 4. Instantiate the contract
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash $WASM_HASH \
  --source $STELLAR_SECRET_KEY \
  --network testnet)

echo "Contract ID: $CONTRACT_ID"
```

---

## 3. Verifying Deployment

Run the verification script after any deployment or upgrade to confirm contracts are live and responsive.

```bash
# Verify all contracts on testnet
./scripts/verify.sh --network testnet

# Verify a single contract
./scripts/verify.sh --network testnet --contract agent-registry

# Rebuild Wasm before verification (re-calculates expected hash)
./scripts/verify.sh --network testnet --rebuild

# Use an explicit deployment manifest
./scripts/verify.sh --deployment-file deployments/testnet.json
```

The verification script checks:

1. **Contract reachability** — queries the contract ID on-chain
2. **Wasm hash integrity** — compares the on-chain hash against the local build artifact
3. **Function responsiveness** — invokes a read-only function (`get_version`) and validates the response

### Manual Verification

```bash
# Read the stored contract ID from the deployment manifest
CONTRACT_ID=$(jq -r '.contracts["agent-registry"].contract_id' deployments/testnet.json)

# Query the contract version
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_version
# Expected output: "1.0.0"

# Query registered agents (should be empty on first deploy)
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- lookup_agents \
  --capability research
# Expected output: []
```

---

## 4. Upgrading Contracts

### 4.1 Standard Upgrade Path

Always perform a dry-run first to confirm which contracts will be upgraded:

```bash
cd smart-contracts

# Step 1: Dry-run — shows the upgrade plan without executing
./scripts/upgrade.sh --network testnet --dry-run
```

Expected dry-run output:

```
=== Upgrade Dry Run ===
Network: testnet

agent-registry
  Current hash:   a3f9...
  New hash:       c8b2...
  Status:         NEEDS UPGRADE

error-resolver
  Current hash:   7e1d...
  New hash:       7e1d...  (unchanged)
  Status:         UP TO DATE

Would upgrade 1 contract(s). Run without --dry-run to apply.
```

```bash
# Step 2: Upgrade using the UpgradeManager (recommended)
./scripts/upgrade.sh --network testnet --use-upgrade-manager agent-registry

# Step 3: Upgrade a specific contract to a specific version
./scripts/upgrade.sh --network testnet --use-upgrade-manager --version "1.2.0" agent-registry

# Step 4: Upgrade all contracts that have changed
./scripts/upgrade.sh --network testnet --use-upgrade-manager
```

Expected upgrade output:

```
=== Upgrade: agent-registry ===
Network: testnet

Pre-upgrade checks...
  ✓ Contract exists on network
  ✓ Wasm file valid
  ✓ Hash comparison: upgrade needed
  ✓ Storage layout compatible

Creating backup...
  ✓ State snapshot saved: backups/testnet/agent-registry-20260928-142000.json

Executing upgrade...
  ✓ Wasm uploaded: c8b2...
  ✓ Contract upgraded

Post-upgrade verification...
  ✓ New version confirmed: 1.2.0
  ✓ Contract responsive

=== Upgrade completed ===
```

**upgrade.sh Option Reference**

| Flag | Description |
|---|---|
| `-n, --network NETWORK` | Target network: `testnet`, `futurenet`, `mainnet` |
| `-s, --skip-build` | Use existing Wasm artifacts, skip `cargo build` |
| `-b, --skip-backup` | Skip state snapshot before upgrade |
| `-f, --force` | Skip safety checks (not recommended) |
| `-d, --dry-run` | Print what would change without executing |
| `-u, --use-upgrade-manager` | Route upgrade through the UpgradeManager contract |
| `-r, --no-rollback` | Disable rollback capability for this upgrade |
| `-v, --version VERSION` | Set explicit semantic version for the upgrade |

### 4.2 Emergency Upgrade Path

Use when a critical bug requires bypassing the standard UpgradeManager flow.

> **Caution:** Emergency upgrades skip pre-upgrade validation and migration hooks. Only use if a standard upgrade is not possible.

```bash
# Emergency upgrade — forces the upgrade without safety checks
./scripts/upgrade.sh --network testnet --force agent-registry

# Or directly via Stellar CLI
NEW_WASM_HASH=$(stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm \
  --source $STELLAR_SECRET_KEY \
  --network testnet)

stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- upgrade \
  --new_wasm_hash $NEW_WASM_HASH
```

After an emergency upgrade, immediately run verification and create a post-incident report documenting what was skipped and why.

---

## 5. Using the UpgradeManager

The UpgradeManager contract (`smart-contracts/contracts/upgrade-manager`) is the recommended upgrade coordinator. It adds validation, migration hooks, versioning enforcement, and a 48-hour rollback window.

### 5.1 Initial UpgradeManager Setup

Deploy and initialize the UpgradeManager first:

```bash
# Deploy the upgrade manager
./scripts/deploy.sh --network testnet --contract upgrade-manager

# Read the deployed contract ID
UPGRADE_MANAGER_ID=$(jq -r '.contracts["upgrade-manager"].contract_id' deployments/testnet.json)

# Initialize with the admin account
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- initialize \
  --admin $ADMIN_ADDRESS \
  --initial_version "1.0.0" \
  --initial_wasm_hash $INITIAL_WASM_HASH
```

### 5.2 Connecting Contracts to the UpgradeManager

```bash
AGENT_REGISTRY_ID=$(jq -r '.contracts["agent-registry"].contract_id' deployments/testnet.json)

stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_ID \
  -- set_upgrade_manager \
  --upgrade_manager $UPGRADE_MANAGER_ID
```

### 5.3 Managed Upgrade Sequence

```bash
# 1. Check current version
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_ID \
  -- get_version
# Output: "1.0.0"

# 2. Check compatibility before proposing
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_ID \
  -- check_upgrade_compatibility \
  --target_version "1.1.0"
# Output: { "compatible": true, "migration_type": "minor" }

# 3. Propose the upgrade
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- propose_upgrade \
  --new_version "1.1.0" \
  --new_wasm_hash $NEW_WASM_HASH \
  --description "Add paginated agent listing" \
  --migration_plan '{"pre_migration_checks":["validate_data_integrity"],"data_transformations":[],"post_migration_validations":["verify_data_integrity"]}'

# 4. Validate the proposal
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- validate_proposal
# Output: { "valid": true, "estimated_gas": 500000 }

# 5. Execute the upgrade
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- execute_upgrade
# Output: { "success": true, "new_version": "1.1.0" }
```

### 5.4 Version Compatibility Rules

| Upgrade Type | Example | Migration Required | Rollback Allowed |
|---|---|---|---|
| Patch | `1.0.0 → 1.0.1` | Minimal | Yes, 48h |
| Minor | `1.0.0 → 1.1.0` | Selective | Yes, 48h |
| Major | `1.0.0 → 2.0.0` | Full | Yes, 48h |
| Downgrade | `1.1.0 → 1.0.0` | Blocked | Use rollback instead |

### 5.5 Monitoring Upgrade Events

```bash
# Monitor all upgrade events from a starting ledger
stellar events \
  --network testnet \
  --start-ledger $START_LEDGER \
  --contract $UPGRADE_MANAGER_ID \
  --topic upgrade

# Monitor specific contract upgrade events
stellar events \
  --network testnet \
  --start-ledger $START_LEDGER \
  --contract $AGENT_REGISTRY_ID \
  --topic registry upgraded
```

Upgrade event types emitted during the lifecycle:

| Event | Trigger |
|---|---|
| `UpgradeProposed` | A new upgrade is proposed |
| `UpgradeValidated` | Proposal passes pre-upgrade checks |
| `UpgradeApplied` | Upgrade executes successfully |
| `UpgradeRolledBack` | A rollback completes |
| `MigrationProgress` | Each migration step completes |
| `MigrationComplete` | Full migration finishes |

---

## 6. Rollback Procedure

The UpgradeManager provides a 48-hour rollback window after every managed upgrade. After 48 hours, rollback is disabled and you must issue a forward upgrade to fix issues.

### 6.1 Checking Rollback Availability

```bash
UPGRADE_MANAGER_ID=$(jq -r '.contracts["upgrade-manager"].contract_id' deployments/testnet.json)

stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- can_rollback
# Output: { "can_rollback": true, "window_closes_at": "2026-09-30T14:20:00Z" }
```

### 6.2 Performing a Rollback

```bash
# Option A: Via the upgrade script
./scripts/upgrade.sh --network testnet --rollback agent-registry

# Option B: Via the UpgradeManager contract directly
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- rollback_upgrade
# Output: { "success": true, "rolled_back_to": "1.0.0" }

# Option C: Emergency rollback with an explicit Wasm hash (when the
# UpgradeManager itself is unavailable)
PREVIOUS_HASH=$(jq -r '.contracts["agent-registry"].wasm_hash' backups/testnet/agent-registry-20260928-142000.json)

stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $AGENT_REGISTRY_ID \
  -- emergency_rollback \
  --rollback_wasm_hash $PREVIOUS_HASH \
  --rollback_version "1.0.0"
```

### 6.3 Restoring from Deployment Backup

If the deployment manifest itself was corrupted:

```bash
# List available backups
ls -la backups/testnet/

# Restore a specific backup
cp backups/testnet/deployment-20260928-142000.json deployments/testnet.json

# Re-verify the restored state
./scripts/verify.sh --network testnet
```

---

## 7. Post-Upgrade Verification

Run the full verification suite after every upgrade before announcing it complete.

```bash
# Full verification
./scripts/verify.sh --network testnet

# Manual checks for critical functions
CONTRACT_ID=$(jq -r '.contracts["agent-registry"].contract_id' deployments/testnet.json)

# 1. Check version updated
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_version
# Expected: new version string, e.g. "1.1.0"

# 2. Check upgrade status
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_upgrade_status
# Expected: { "status": "completed", "version": "1.1.0", "upgraded_at": "..." }

# 3. Validate core functionality still works
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- lookup_agents \
  --capability research
# Expected: same agents as before upgrade (data integrity)
```

### Post-Upgrade Checklist

- [ ] `get_version` returns the expected new version
- [ ] `get_upgrade_status` reports `completed`
- [ ] All existing data is intact (spot-check agent records)
- [ ] Core read/write functions work correctly
- [ ] No unexpected events emitted during upgrade
- [ ] Deployment manifest updated with new Wasm hash and timestamp
- [ ] Rollback window noted (`can_rollback` shows `true` for the next 48h)

---

## 8. Troubleshooting Deployment Failures

### "Contract not found on network"

The contract ID in the deployment manifest does not match a live contract on the chosen network.

```bash
# Step 1: Confirm you are targeting the right network
cat deployments/testnet.json | jq '.network'

# Step 2: Re-run status check
./scripts/manage.sh status -n testnet

# Step 3: Re-verify
./scripts/verify.sh -n testnet

# Step 4: If the contract was never deployed, run full deployment
./scripts/deploy.sh --network testnet
```

### "Hash verification failed"

The local Wasm differs from the on-chain deployed Wasm.

```bash
# Rebuild from source and recalculate hashes
./scripts/verify.sh -n testnet --rebuild

# If the hash genuinely changed (someone upgraded outside the scripts):
# Update the manifest by querying the on-chain hash
stellar contract info \
  --network testnet \
  --id $CONTRACT_ID | jq '.wasm_hash'
```

### "Upgrade safety checks failed"

Pre-upgrade validation rejected the upgrade.

```bash
# See the specific failure
./scripts/upgrade.sh --network testnet --dry-run

# Common causes:
# 1. Incompatible major version change — provide an explicit migration plan
# 2. Admin key mismatch — ensure STELLAR_SECRET_KEY is the deployer account
# 3. Storage layout change — see STORAGE_MIGRATION.md
```

### "Soroban RPC timeout" / "connection refused"

```bash
# Confirm the RPC endpoint is reachable
curl -s $STELLAR_RPC_URL/health | jq .
# Expected: { "status": "healthy" }

# For standalone, ensure the Docker service is running
docker compose ps stellar-standalone
docker compose logs stellar-standalone --tail 20
```

### "Insufficient XLM balance"

```bash
# Check deployer account balance
stellar account balance \
  --network testnet \
  --source $STELLAR_SECRET_KEY

# Fund testnet account via Friendbot
stellar keys fund deployer --network testnet
```

### "cargo build" fails

```bash
# Ensure the wasm32 target is installed
rustup target add wasm32-unknown-unknown

# Clean and rebuild
cargo clean
cargo build --target wasm32-unknown-unknown --release
```

### Partially failed upgrade

If an upgrade completes Wasm upload but fails during contract invocation:

```bash
# 1. Check current on-chain status
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $CONTRACT_ID \
  -- get_upgrade_status

# 2. If within the 48h rollback window, roll back
stellar contract invoke \
  --network testnet \
  --source $STELLAR_SECRET_KEY \
  --id $UPGRADE_MANAGER_ID \
  -- can_rollback

# 3. If rollback is available, use it (see Section 6)
# 4. Otherwise, prepare a corrective upgrade and test on testnet first
```

---

## Further Reading

- [Upgrade Guide](UPGRADE_GUIDE.md) — detailed UpgradeManager internals and migration planning
- [Storage Migration Guide](STORAGE_MIGRATION.md) — handling breaking storage layout changes
- [Testnet Upgrade Runbook](TESTNET_UPGRADE_RUNBOOK.md) — step-by-step testnet operator instructions
- [Exit Codes](EXIT_CODES.md) — script exit code reference
- [Soroban Documentation](https://soroban.stellar.org/docs) — official Soroban developer docs
- [Stellar Developer Discord](https://discord.gg/stellardev)
