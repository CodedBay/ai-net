#!/bin/bash
# verify.sh — Verify deployed Soroban smart contracts are live.
#
# Usage: ./verify.sh [OPTIONS] [CONTRACT_NAME]
#   -n, --network         testnet | mainnet | standalone  (default: testnet)
#   -f, --deployment-file Path to a specific deployments JSON file
#   -r, --rebuild         Rebuild contracts before verification
#   -h, --help            Show this help message
#
# CONTRACT_NAME  (optional) verify only this contract; verifies all if omitted.
#
# Exits 1 if any contract is not found or metadata is missing.

set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Defaults ─────────────────────────────────────────────────────────────────
NETWORK="testnet"
DEPLOYMENT_FILE=""
REBUILD=false
CONTRACT_NAME=""

# ─── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
${BOLD}Usage:${NC} $0 [OPTIONS] [CONTRACT_NAME]

Verify deployed Soroban contracts are live and match the local build.

${BOLD}ARGUMENTS:${NC}
  CONTRACT_NAME         Verify only this contract (optional; verifies all if omitted)

${BOLD}OPTIONS:${NC}
  -n, --network NETWORK      Target network: testnet | mainnet | standalone  [default: testnet]
  -f, --deployment-file FILE Path to deployment metadata JSON file
  -r, --rebuild              Rebuild contracts before verification
  -h, --help                 Show this help message

${BOLD}ENVIRONMENT VARIABLES:${NC}
  STELLAR_SECRET_KEY         Required for live contract health checks
  STELLAR_RPC_URL            Override default RPC endpoint
  STELLAR_HORIZON_URL        Override default Horizon endpoint

${BOLD}EXIT CODES:${NC}
  0  All verified contracts are live and metadata is valid
  1  One or more contracts failed verification or were not found

${BOLD}EXAMPLES:${NC}
  $0                         Verify all contracts on testnet
  $0 agent-registry          Verify only agent-registry
  $0 -n mainnet              Verify all contracts on mainnet
  $0 -f deployments/testnet.json agent-registry
EOF
}

# ─── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--network)
      NETWORK="$2"
      shift 2
      ;;
    -f|--deployment-file)
      DEPLOYMENT_FILE="$2"
      shift 2
      ;;
    -r|--rebuild)
      REBUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -z "$CONTRACT_NAME" ]]; then
        CONTRACT_NAME="$1"
      else
        echo -e "${RED}Error: Multiple contract names specified.${NC}" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# ─── Validate network ─────────────────────────────────────────────────────────
case "$NETWORK" in
  testnet|mainnet|standalone) ;;
  *)
    echo -e "${RED}Error: Invalid network '${NETWORK}'. Must be: testnet | mainnet | standalone${NC}" >&2
    exit 1
    ;;
esac

# ─── Network defaults ─────────────────────────────────────────────────────────
set_network_defaults() {
  case "$NETWORK" in
    testnet)
      STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
      STELLAR_HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}"
      NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
      ;;
    mainnet)
      STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-rpc.stellar.org}"
      STELLAR_HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon.stellar.org}"
      NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
      ;;
    standalone)
      STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
      STELLAR_HORIZON_URL="${STELLAR_HORIZON_URL:-http://localhost:8000}"
      NETWORK_PASSPHRASE="Standalone Network ; February 2017"
      ;;
  esac
  export STELLAR_RPC_URL STELLAR_HORIZON_URL NETWORK_PASSPHRASE
}

# ─── Dependency check ─────────────────────────────────────────────────────────
check_dependencies() {
  local missing=()
  for dep in jq sha256sum; do
    command -v "$dep" >/dev/null 2>&1 || missing+=("$dep")
  done
  # xxd is optional — only used for Wasm magic number check
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}Error: Required tools not found: ${missing[*]}${NC}" >&2
    exit 1
  fi
}

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOYMENTS_DIR="$PROJECT_ROOT/deployments"
TARGET_DIR="$PROJECT_ROOT/target/wasm32-unknown-unknown/release"

# Default deployment file
[[ -z "$DEPLOYMENT_FILE" ]] && DEPLOYMENT_FILE="$DEPLOYMENTS_DIR/${NETWORK}.json"

# ─── Helpers ─────────────────────────────────────────────────────────────────
log_info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Known contracts and their Wasm stems
# Format: "contract-name:wasm-stem"
ALL_CONTRACTS=(
  "agent-registry:agent_registry"
  "task-store:task_store"
  "payment-escrow:payment_escrow"
  "error-resolver:error_resolver"
)

# ─── Deployment file check ────────────────────────────────────────────────────
check_deployment_file() {
  if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
    log_error "Deployment file not found: ${DEPLOYMENT_FILE}"
    echo -e "${YELLOW}Hint: Run deploy.sh first to create the deployment record.${NC}" >&2
    exit 1
  fi

  # Validate it's valid JSON
  if ! jq empty "$DEPLOYMENT_FILE" 2>/dev/null; then
    log_error "Deployment file is not valid JSON: ${DEPLOYMENT_FILE}"
    exit 1
  fi
}

# ─── Rebuild ─────────────────────────────────────────────────────────────────
maybe_rebuild() {
  [[ "$REBUILD" != "true" ]] && return 0

  log_info "Rebuilding contracts for verification…"
  cd "$PROJECT_ROOT"
  if ! cargo build --target wasm32-unknown-unknown --release 2>&1; then
    log_error "cargo build failed"
    exit 1
  fi
  log_success "Rebuild complete"
  echo ""
}

# ─── Verify a single contract ─────────────────────────────────────────────────
verify_contract() {
  local name="$1"
  local wasm_stem="$2"
  local wasm_file="$TARGET_DIR/${wasm_stem}.wasm"
  local result=0

  echo -e "${BOLD}Verifying ${name}…${NC}"

  # 1. Check contract ID exists in deployment file
  local contract_info
  contract_info="$(jq -r --arg n "$name" '.contracts[$n] // empty' "$DEPLOYMENT_FILE")"

  if [[ -z "$contract_info" ]]; then
    log_error "Contract '${name}' not found in deployment metadata: ${DEPLOYMENT_FILE}"
    return 1
  fi

  local contract_id stored_hash deployed_at
  contract_id="$(echo "$contract_info" | jq -r '.contract_id')"
  stored_hash="$(echo "$contract_info"  | jq -r '.wasm_hash')"
  deployed_at="$(echo "$contract_info"  | jq -r '.deployed_at')"

  if [[ -z "$contract_id" || "$contract_id" == "null" ]]; then
    log_error "Contract ID missing in metadata for '${name}'"
    return 1
  fi

  log_info "  Contract ID  : ${contract_id}"
  log_info "  Deployed at  : ${deployed_at}"

  # 2. Validate contract ID format (Soroban contract IDs start with 'C', 56 chars)
  if ! echo "$contract_id" | grep -qE '^C[A-Z0-9]{55}$'; then
    log_error "  Invalid contract ID format: ${contract_id}"
    result=1
  else
    log_success "  Contract ID format valid"
  fi

  # 3. Check Wasm file exists and compute current hash
  if [[ -f "$wasm_file" ]]; then
    local current_hash
    current_hash="$(sha256sum "$wasm_file" | cut -d' ' -f1)"
    log_info "  Stored hash  : ${stored_hash}"
    log_info "  Current hash : ${current_hash}"

    if [[ "$stored_hash" == "$current_hash" ]]; then
      log_success "  Wasm hash matches deployment record"
    else
      log_warn "  Wasm hash mismatch — contract may have been upgraded or local build differs"
    fi

    # 4. Check Wasm magic number (0x00 0x61 0x73 0x6D = '\0asm')
    if command -v xxd >/dev/null 2>&1; then
      if xxd -l 4 "$wasm_file" 2>/dev/null | grep -q "0061 736d"; then
        log_success "  Wasm magic number valid"
      else
        log_error "  Invalid Wasm file: bad magic number"
        result=1
      fi
    fi

    # 5. Ensure Wasm file is non-empty
    if [[ -s "$wasm_file" ]]; then
      local size
      size="$(stat -c%s "$wasm_file" 2>/dev/null || stat -f%z "$wasm_file" 2>/dev/null || echo "?")"
      log_success "  Wasm file size: ${size} bytes"
    else
      log_error "  Wasm file is empty: ${wasm_file}"
      result=1
    fi
  else
    log_warn "  Wasm file not found locally: ${wasm_file} (skipping hash/integrity checks)"
  fi

  # 6. Live contract check via Soroban RPC (if soroban CLI available)
  if command -v soroban >/dev/null 2>&1 && [[ -n "${STELLAR_SECRET_KEY:-}" ]]; then
    log_info "  Checking contract is live on ${NETWORK}…"
    local invoke_output
    if invoke_output="$(soroban contract invoke \
        --id "$contract_id" \
        --source "$STELLAR_SECRET_KEY" \
        --rpc-url "$STELLAR_RPC_URL" \
        --network-passphrase "$NETWORK_PASSPHRASE" \
        -- --help 2>&1)"; then
      log_success "  Contract is live and responsive"
    else
      # Soroban may print help to stderr even on success; treat a non-fatal
      # "function not found" as live (contract exists, just no --help fn)
      if echo "$invoke_output" | grep -qi "not found\|unknown function\|no such"; then
        log_success "  Contract is live (no --help function, which is expected)"
      else
        log_warn "  Could not verify liveness via soroban invoke: ${invoke_output}"
      fi
    fi
  elif [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
    log_warn "  STELLAR_SECRET_KEY not set — skipping live contract check"
  else
    log_warn "  soroban CLI not found — skipping live contract check"
  fi

  if [[ "$result" -eq 0 ]]; then
    log_success "Verified ${name}"
  else
    log_error "Verification FAILED for ${name}"
  fi

  echo ""
  return "$result"
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}${BLUE}═══ ai-net Smart Contract Verification ═══${NC}"
  echo -e "Network         : ${BOLD}${NETWORK}${NC}"
  echo -e "RPC URL         : ${STELLAR_RPC_URL}"
  echo -e "Deployment file : ${DEPLOYMENT_FILE}"
  if [[ -n "$CONTRACT_NAME" ]]; then
    echo -e "Contract        : ${BOLD}${CONTRACT_NAME}${NC}"
  else
    echo -e "Contracts       : all"
  fi
  echo ""

  check_deployment_file
  maybe_rebuild

  # Determine which contracts to verify
  local contracts_to_verify=()
  if [[ -n "$CONTRACT_NAME" ]]; then
    # Validate the named contract is known
    local found=false
    for entry in "${ALL_CONTRACTS[@]}"; do
      IFS=':' read -r name _stem <<< "$entry"
      if [[ "$name" == "$CONTRACT_NAME" ]]; then
        found=true
        break
      fi
    done
    if [[ "$found" == "false" ]]; then
      log_error "Unknown contract: '${CONTRACT_NAME}'"
      echo -e "${YELLOW}Known contracts: $(printf '%s ' "${ALL_CONTRACTS[@]}" | sed 's/:[^ ]*//g')${NC}" >&2
      exit 1
    fi
    contracts_to_verify+=("${CONTRACT_NAME}")
  else
    # Verify all contracts recorded in the deployment file
    while IFS= read -r name; do
      [[ -n "$name" ]] && contracts_to_verify+=("$name")
    done < <(jq -r '.contracts | keys[]' "$DEPLOYMENT_FILE" 2>/dev/null || true)
  fi

  if [[ ${#contracts_to_verify[@]} -eq 0 ]]; then
    log_warn "No contracts found in deployment file to verify."
    exit 0
  fi

  local overall_ok=true
  local results_json="["
  local first=true

  for name in "${contracts_to_verify[@]}"; do
    # Look up wasm_stem
    local wasm_stem="$name"  # fallback: replace hyphens with underscores
    for entry in "${ALL_CONTRACTS[@]}"; do
      IFS=':' read -r ename estem <<< "$entry"
      if [[ "$ename" == "$name" ]]; then
        wasm_stem="$estem"
        break
      fi
    done
    wasm_stem="${wasm_stem//-/_}"  # normalise hyphens → underscores

    if verify_contract "$name" "$wasm_stem"; then
      status="verified"
    else
      status="failed"
      overall_ok=false
    fi

    [[ "$first" == "false" ]] && results_json+=","
    results_json+="{\"contract\":\"${name}\",\"status\":\"${status}\"}"
    first=false
  done

  results_json+="]"

  # Write verification report
  local report_file="$PROJECT_ROOT/verification-report-${NETWORK}-$(date +%Y%m%d-%H%M%S).json"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  jq -n \
    --arg ts "$ts" \
    --arg net "$NETWORK" \
    --arg rpc "$STELLAR_RPC_URL" \
    --argjson results "$results_json" \
    '{
      timestamp: $ts,
      network: $net,
      rpc_url: $rpc,
      results: $results,
      overall: (if ($results | map(select(.status == "failed")) | length) == 0 then "passed" else "failed" end)
    }' > "$report_file"
  log_info "Verification report saved to: ${report_file}"
  echo ""

  if [[ "$overall_ok" == "true" ]]; then
    echo -e "${GREEN}${BOLD}═══ Verification passed ═══${NC}"
    exit 0
  else
    echo -e "${RED}${BOLD}═══ Verification FAILED ═══${NC}" >&2
    exit 1
  fi
}

check_dependencies
set_network_defaults
main "$@"
