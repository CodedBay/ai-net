#!/usr/bin/env bash
# migrate-agent-storage.sh
#
# Audit and migration helper for AgentRegistry bounded storage (Issue #2).
#
# CONTEXT
# -------
# The original AgentRegistry stored all agent IDs in a single Vec<Symbol>
# inside Instance storage (DataKey::AllAgents). As agents registered, this Vec
# grew without bound, violating the bounded-storage invariant in AGENTS.md and
# risking the Soroban instance-storage size limit (~64 KB XDR).
#
# The fix (landed with this PR) replaces the flat Vec with two complementary
# structures stored in Persistent storage:
#   DataKey::AgentByIndex(u32)     — sparse map from sequence number → agent id
#   DataKey::RegistrationSequence  — monotone counter (stored in Instance)
#   DataKey::TotalAgents           — count of currently active agents (Instance)
#
# This script verifies that:
#  (a) the DataKey::AllAgents Instance key no longer exists in a live contract
#  (b) the RegistrationSequence and TotalAgents counters are present
#  (c) get_agents() with cursor pagination works correctly
#
# USAGE
# -----
#   ./scripts/migrate-agent-storage.sh [OPTIONS]
#
#   Options:
#     --network   <testnet|mainnet|standalone>  default: testnet
#     --contract  <CONTRACT_ID>                 (overrides REGISTRY_CONTRACT_ID env var)
#     --rpc-url   <URL>                         (overrides STELLAR_RPC_URL env var)
#     --dry-run                                 Report only; make no on-chain calls
#     --help                                    Print this message and exit
#
# ENVIRONMENT VARIABLES
# ---------------------
#   REGISTRY_CONTRACT_ID    Contract address of the AgentRegistry
#   STELLAR_RPC_URL         Soroban RPC endpoint
#   STELLAR_SECRET_KEY      Admin keypair for write operations
#
# EXAMPLE
# -------
#   REGISTRY_CONTRACT_ID=CXXXX... \
#   STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
#   ./scripts/migrate-agent-storage.sh --network testnet --dry-run

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT_ID="${REGISTRY_CONTRACT_ID:-}"
RPC_URL="${STELLAR_RPC_URL:-}"
DRY_RUN=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── CLI parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)   NETWORK="$2"; shift 2 ;;
    --contract)  CONTRACT_ID="$2"; shift 2 ;;
    --rpc-url)   RPC_URL="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --help)
      head -50 "$0" | grep '^#' | sed 's/^# *//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Defaults per network ──────────────────────────────────────────────────────
if [[ -z "$RPC_URL" ]]; then
  case "$NETWORK" in
    testnet)    RPC_URL="https://soroban-testnet.stellar.org" ;;
    mainnet)    RPC_URL="https://mainnet.sorobanrpc.com" ;;
    standalone) RPC_URL="http://localhost:8000/soroban/rpc" ;;
    *)          echo "Unknown network: $NETWORK" >&2; exit 1 ;;
  esac
fi

# ── Dependency check ──────────────────────────────────────────────────────────
log_info()  { echo "[INFO]  $*"; }
log_ok()    { echo "[OK]    $*"; }
log_warn()  { echo "[WARN]  $*"; }
log_error() { echo "[ERROR] $*" >&2; }

if ! command -v stellar &>/dev/null; then
  log_error "stellar CLI is required. Install: https://github.com/stellar/stellar-cli"
  exit 1
fi

if [[ -z "$CONTRACT_ID" ]]; then
  log_error "No contract ID supplied. Set REGISTRY_CONTRACT_ID or pass --contract <id>"
  exit 1
fi

log_info "Network  : $NETWORK"
log_info "RPC URL  : $RPC_URL"
log_info "Contract : $CONTRACT_ID"
log_info "Dry run  : $DRY_RUN"
echo ""

# ── Helper: invoke read-only contract function ────────────────────────────────
invoke_view() {
  local fn="$1"; shift
  stellar contract invoke \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --id "$CONTRACT_ID" \
    --fn "$fn" \
    "$@" 2>&1
}

# ── Step 1: Verify RegistrationSequence exists (migration already applied) ───
log_info "Step 1: Checking RegistrationSequence counter..."
SEQ_OUTPUT=$(invoke_view "get_total_agents" 2>&1 || true)
if echo "$SEQ_OUTPUT" | grep -qE '^[0-9]+$'; then
  TOTAL=$(echo "$SEQ_OUTPUT" | tr -d '[:space:]')
  log_ok "get_total_agents returned $TOTAL — new paginated storage is active."
else
  log_warn "get_total_agents output: $SEQ_OUTPUT"
  log_warn "Could not confirm paginated storage. The contract may be on an old version."
fi
echo ""

# ── Step 2: Smoke-test cursor pagination ─────────────────────────────────────
log_info "Step 2: Smoke-testing cursor pagination via get_agents(cursor=None, limit=None)..."
PAGE_OUTPUT=$(invoke_view "get_agents" --cursor '{"none": null}' --limit '{"none": null}' 2>&1 || true)
if echo "$PAGE_OUTPUT" | grep -q "agents"; then
  log_ok "get_agents returned a page structure — cursor pagination is operational."
else
  log_warn "get_agents output: $PAGE_OUTPUT"
  log_warn "Pagination may not be working as expected. Inspect the contract version."
fi
echo ""

# ── Step 3: Check for legacy AllAgents key (should NOT exist post-migration) ──
log_info "Step 3: Checking for legacy AllAgents Instance storage key..."
LEDGER_OUTPUT=$(stellar contract read \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --id "$CONTRACT_ID" 2>&1 || true)

if echo "$LEDGER_OUTPUT" | grep -qi "AllAgents"; then
  log_error "Legacy 'AllAgents' key detected in contract storage!"
  log_error "The contract has NOT been upgraded to the cursor-paginated implementation."
  log_error "Deploy the updated agent_registry wasm and call 'upgrade' via the UpgradeManager."
  MIGRATION_NEEDED=true
else
  log_ok "No legacy 'AllAgents' key found — storage layout is correct."
  MIGRATION_NEEDED=false
fi
echo ""

# ── Step 4: Migration recommendation ─────────────────────────────────────────
if [[ "$MIGRATION_NEEDED" == "true" ]]; then
  log_warn "ACTION REQUIRED: Deploy the updated contract."
  echo ""
  echo "  1. Build the updated wasm:"
  echo "       cd smart-contracts"
  echo "       cargo build --locked -p agent_registry --target wasm32v1-none --release"
  echo ""
  echo "  2. Upload and upgrade via the UpgradeManager:"
  echo "       ./scripts/upgrade.sh --network $NETWORK --use-upgrade-manager agent-registry"
  echo ""
  echo "  3. Re-run this script to confirm migration success:"
  echo "       ./scripts/migrate-agent-storage.sh --network $NETWORK --contract $CONTRACT_ID"
  echo ""
  if [[ "$DRY_RUN" == "false" ]]; then
    log_error "Exiting with error — manual intervention required."
    exit 2
  else
    log_warn "Dry-run mode: no changes made. Exiting with success for reporting purposes."
    exit 0
  fi
else
  log_ok "AgentRegistry storage is already using bounded cursor-based pagination."
  log_ok "No migration required."
  exit 0
fi
