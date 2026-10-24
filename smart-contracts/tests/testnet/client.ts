/**
 * Testnet farm client — drives the Soroban contracts on the LIVE Stellar
 * testnet via the `soroban` CLI, capturing per-operation gas diagnostics.
 *
 * Every host-side mutation is executed as a `soroban contract invoke` call and
 * measured. Gas is captured from the `--print-diag` diagnostic output, which
 * reports CPU instructions and memory instructions consumed by the invocation.
 * These values are the canonical network-side metric for gas (CU).
 *
 * The farm only runs when explicitly enabled (RUN_TESTNET_FARM=true) so it never
 * accidentally spends testnet XLM during routine unit/CI runs.
 */

import { execFile } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import axios from 'axios';

// ── Typed inputs ─────────────────────────────────────────────────────────────

export interface DeployedContracts {
  network: string;
  rpc_url: string;
  horizon_url: string;
  network_passphrase: string;
  contracts: {
    agent_registry: string;
    agent_bidding: string;
    error_registry: string;
    task_store: string;
  };
}

export interface GasMeasurement {
  operation: string;
  cpu_insns: string;
  mem_insns: string;
  fee_stroops?: number;
  committed?: boolean;
}

export interface InvokeResult {
  /** Raw CLI stdout. */
  stdout: string;
  /** Gas captured from --print-diag, or null if diagnostics unavailable. */
  gas: { cpu_insns: string; mem_insns: string } | null;
  /** Fee in stroops parsed from diagnostic output, when present. */
  feeStroops?: number;
}

// ── Config resolution ────────────────────────────────────────────────────────

/** Resolves the Soroban/Stellar CLI binary name (soroban vs stellar). */
function cliBinary(): string {
  const override = process.env.SOROBAN_CLI;
  if (override) return override;
  return process.env.SOROBAN_CLI_BIN ?? 'soroban';
}

/** Reads the deployment metadata produced by scripts/testnet-farm.sh. */
export function loadDeployedContracts(): DeployedContracts {
  const file = process.env.FARM_CONTRACT_FILE ?? resolve(__dirname, '../testnet-farm-output/deployed-contracts.json');
  if (!existsSync(file)) {
    throw new Error(`Deployment metadata not found: ${file}. Run scripts/testnet-farm.sh first.`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as DeployedContracts;
}

function rpcUrl(): string {
  const env = process.env.STELLAR_RPC_URL;
  return env ?? 'https://soroban-testnet.stellar.org';
}

function secretKey(): string {
  if (!process.env.STELLAR_SECRET_KEY) {
    throw new Error('STELLAR_SECRET_KEY is required to run the testnet farm.');
  }
  return process.env.STELLAR_SECRET_KEY;
}

// ── CLI execution ────────────────────────────────────────────────────────────

function runSoroban(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cliBinary(),
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`soroban failed (${error.message})\nstdout: ${stdout}\nstderr: ${stderr}`)
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      }
    );
  });
}

/**
 * Parse CPU / memory instructions from `soroban contract invoke --print-diag`
 * output. The diagnostic block reports lines like `CPU: 1000000` and
 * `Mem: 200000` (counts of instructions consumed toward the ledger budget).
 */
function parseDiag(stdout: string, stderr: string): { cpu_insns: string; mem_insns: string } | null {
  const text = `${stdout}\n${stderr}`;

  // Newer soroban-cli writes a diagnostics JSON to .soroban-diag.log or stderr:
  //   {"cost":{"cpuInsns":1234,"memInsns":5678,"inclusionFee":900}, ...}
  const costJson = text.match(/\{"cost":\{"cpuInsns":([0-9]+),"memInsns":([0-9]+)[^}]*\}/);
  if (costJson) {
    return { cpu_insns: costJson[1], mem_insns: costJson[2] };
  }

  // Classic soroban-tools `--print-diag` format.
  const cpu = text.match(/CPU:\s*([0-9]+)/);
  const mem = text.match(/Mem:\s*([0-9]+)/);
  if (!cpu && !mem) {
    const fee = text.match(/fee:\s*([0-9]+)/i);
    if (fee) {
      return { cpu_insns: '0', mem_insns: '0' };
    }
    return null;
  }
  return {
    cpu_insns: cpu ? cpu[1] : '0',
    mem_insns: mem ? mem[1] : '0',
  };
}

/**
 * Invoke a contract function on the live testnet and capture gas.
 *
 * @param contractId On-chain contract ID
 * @param fn         Function/entry point name
 * @param args       Arguments (each passed as a separate token or already-formatted
 *                   `--arg-type:value` tokens)
 * @param opts       Extra CLI flags (e.g. `--fee`)
 */
export async function invoke(
  contractId: string,
  fn: string,
  args: string[] = [],
  opts: string[] = []
): Promise<InvokeResult> {
  const diagFile = resolve(process.cwd(), '.soroban-diag.log');
  const base = [
    'contract',
    'invoke',
    '--id', contractId,
    '--source-account', secretKey(),
    '--rpc-url', rpcUrl(),
    '--print-diag',
  ];
  const full = [...base, ...opts, '--', fn, ...args];
  const { stdout, stderr } = await runSoroban(full);

  let diagnostics = parseDiag(stdout, stderr);
  if (!diagnostics) {
    try {
      if (existsSync(diagFile)) {
        const diag = readFileSync(diagFile, 'utf8');
        diagnostics = parseDiag(diag, '');
      }
    } catch {
      diagnostics = null;
    }
  }

  // Attempt to parse fee from the JSON-ish diagnostics that newer soroban-cli
  // versions print (e.g. `"cost": ..., "fee": ...`).
  let feeStroops: number | undefined;
  const combined = `${stdout}\n${stderr}`;
  const feeMatch = combined.match(/"fee"\s*:\s*"?([0-9]+)"?/);
  if (feeMatch) feeStroops = Number(feeMatch[1]);

  return { stdout, gas: diagnostics, feeStroops };
}

/**
 * Record a gas measurement into the shared farm report JSON.
 */
export function recordGas(measurement: GasMeasurement): void {
  const file = process.env.FARM_GAS_FILE ?? resolve(__dirname, '../testnet-farm-output/gas-measurements.json');
  let entries: GasMeasurement[] = [];
  if (existsSync(file)) {
    try {
      entries = JSON.parse(readFileSync(file, 'utf8')) as GasMeasurement[];
    } catch {
      entries = [];
    }
  }
  entries.push(measurement);
  writeFileSync(file, JSON.stringify(entries, null, 2));
}

/** Loads previously recorded gas measurements (for delta computation). */
export function loadGasMeasurements(): GasMeasurement[] {
  const file = process.env.FARM_GAS_FILE ?? resolve(__dirname, '../testnet-farm-output/gas-measurements.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as GasMeasurement[];
  } catch {
    return [];
  }
}

// ── Horizon API verification helpers ─────────────────────────────────────────
//
// These functions query the Stellar Horizon API to verify that a transaction
// was recorded on-chain after a payment operation. They are used by E2E
// payment tests to confirm that the backend state and the Stellar ledger agree.

/** Resolves the Horizon URL from the environment (defaults to testnet). */
function horizonUrl(): string {
  return process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
}

/** Represents a verified Horizon transaction with its key fields. */
export interface HorizonTransactionDetails {
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  memo_type: string;
  memo: string | null;
  operation_count: number;
  fee_paid: number;
  successful: boolean;
}

/** Represents a verified Horizon payment operation. */
export interface HorizonPaymentDetails {
  id: string;
  transaction_hash: string;
  type: string; // "payment", "create_claimable_balance", "claim_claimable_balance"
  asset_type: string;
  amount: string | null;
  from: string | null;
  to: string | null;
  created_at: string;
}

/**
 * Fetches a transaction from Horizon by its hash.
 * Queries GET /transactions/{hash} and returns the decoded transaction details.
 *
 * Retries up to 3 times with exponential backoff to allow the transaction
 * to propagate to Horizon (ledger close time is ~5s on testnet).
 */
export async function getTransactionByHash(txHash: string): Promise<HorizonTransactionDetails> {
  const url = `${horizonUrl()}/transactions/${txHash}`;
  let lastError: any;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 30_000 });
      const tx = response.data;
      return {
        hash: tx.hash,
        ledger: tx.ledger,
        created_at: tx.created_at,
        source_account: tx.source_account,
        memo_type: tx.memo_type,
        memo: tx.memo,
        operation_count: tx.operation_count,
        fee_paid: tx.fee_paid,
        successful: tx.successful,
      };
    } catch (error: any) {
      lastError = error;
      if (error?.response?.status === 404 && attempt < 3) {
        // Transaction not yet in Horizon — wait for ledger close and retry
        const delay = 5000 * attempt; // 5s, 10s
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Fetches all payment operations for a given transaction hash from Horizon.
 * Queries GET /transactions/{hash}/payments.
 */
export async function getTransactionPayments(txHash: string): Promise<HorizonPaymentDetails[]> {
  const url = `${horizonUrl()}/transactions/${txHash}/payments`;
  const response = await axios.get(url, { timeout: 30_000 });
  const records = response.data?._embedded?.records ?? [];
  return records.map((record: any) => ({
    id: record.id,
    transaction_hash: record.transaction_hash,
    type: record.type,
    asset_type: record.asset_type ?? 'native',
    amount: record.amount ?? null,
    from: record.from ?? record.source_account ?? null,
    to: record.to ?? record.destination ?? null,
    created_at: record.created_at,
  }));
}

/**
 * Verifies a payment transaction on Horizon by checking the transaction hash,
 * amount, sender, recipient, and memo.
 *
 * This is the primary E2E verification function: after a payment is made
 * via lockEscrow/releasePayment, call this with the returned tx hash to
 * confirm the on-chain state matches the expected payment parameters.
 *
 * @param txHash          The transaction hash returned by the payment function
 * @param expectedSender  The expected sender account (G... public key)
 * @param expectedRecipient The expected recipient (G... public key, or null for claimable balance creation)
 * @param expectedAmount  The expected payment amount in XLM (string, e.g. "5.0000000")
 * @param expectedMemo    The expected memo text (taskId)
 * @returns An object with verification results and the Horizon transaction link
 */
export async function verifyPaymentOnHorizon(
  txHash: string,
  expectedSender: string,
  expectedRecipient: string | null,
  expectedAmount: string | null,
  expectedMemo: string,
): Promise<{
  verified: boolean;
  transaction: HorizonTransactionDetails;
  payments: HorizonPaymentDetails[];
  horizonLink: string;
  details: string[];
}> {
  const details: string[] = [];

  // 1. Verify the transaction exists and is successful
  const tx = await getTransactionByHash(txHash);
  const horizonLink = `${horizonUrl()}/transactions/${txHash}`;
  details.push(`Transaction hash: ${tx.hash}`);
  details.push(`Ledger: ${tx.ledger}`);
  details.push(`Successful: ${tx.successful}`);
  details.push(`Horizon link: ${horizonLink}`);

  if (!tx.successful) {
    details.push(`❌ Transaction ${txHash} was not successful on Horizon`);
    return { verified: false, transaction: tx, payments: [], horizonLink, details };
  }

  // 2. Verify the memo
  if (tx.memo_type === 'text' && tx.memo !== null) {
    details.push(`Memo: ${tx.memo} (expected: ${expectedMemo})`);
    if (tx.memo !== expectedMemo) {
      details.push(`❌ Memo mismatch: got "${tx.memo}", expected "${expectedMemo}"`);
      return { verified: false, transaction: tx, payments: [], horizonLink, details };
    }
  } else {
    details.push(`❌ Memo type is "${tx.memo_type}", expected "text"`);
    return { verified: false, transaction: tx, payments: [], horizonLink, details };
  }

  // 3. Verify the payment operations
  const payments = await getTransactionPayments(txHash);
  details.push(`Operations found: ${payments.length}`);

  // For releasePayment: there should be a "payment" operation from coordinator to agent
  if (expectedRecipient && expectedAmount) {
    const paymentOp = payments.find(
      (p) =>
        p.type === 'payment' &&
        p.from === expectedSender &&
        p.to === expectedRecipient,
    );

    if (!paymentOp) {
      details.push(`❌ No payment operation from ${expectedSender} to ${expectedRecipient} found`);
      return { verified: false, transaction: tx, payments, horizonLink, details };
    }

    details.push(`Payment: ${paymentOp.from} → ${paymentOp.to}, amount: ${paymentOp.amount}`);
    if (paymentOp.amount !== expectedAmount) {
      details.push(`❌ Amount mismatch: got "${paymentOp.amount}", expected "${expectedAmount}"`);
      return { verified: false, transaction: tx, payments, horizonLink, details };
    }
  }

  // For lockEscrow: there should be a "create_claimable_balance" operation
  if (!expectedRecipient && expectedAmount) {
    const createOp = payments.find((p) => p.type === 'create_claimable_balance');
    if (!createOp) {
      details.push(`❌ No create_claimable_balance operation found`);
      return { verified: false, transaction: tx, payments, horizonLink, details };
    }
    details.push(`CreateClaimableBalance: amount ${createOp.amount}`);
    if (createOp.amount !== expectedAmount) {
      details.push(`❌ Amount mismatch: got "${createOp.amount}", expected "${expectedAmount}"`);
      return { verified: false, transaction: tx, payments, horizonLink, details };
    }
  }

  details.push('✅ All Horizon verification checks passed');
  return { verified: true, transaction: tx, payments, horizonLink, details };
}
