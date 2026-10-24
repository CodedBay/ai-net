import {
  BASE_FEE,
  Asset,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { AppError } from "../errors";
import { getConfig } from "../config";
import { SequenceNumberManager } from "../payment/sequenceManager";
import { metricsService } from "./metrics";

export interface TransactionResult {
  hash: string;
  successful: boolean;
  ledger?: number;
  [key: string]: unknown;
}

export interface StellarHorizonClient {
  loadAccount(publicKey: string): Promise<{ sequence: string; [key: string]: unknown }>;
  submitTransaction(transaction: Transaction): Promise<{ hash: string; [key: string]: unknown }>;
  getTransaction(hash: string): { call(): Promise<TransactionResult> };
}

interface TransactionPlan {
  from: Keypair;
  operations: Array<Record<string, unknown>>;
  memo?: string;
}

export class StellarServiceError extends AppError {
  constructor(message: string, statusCode: number, code: string, details?: Record<string, unknown>) {
    super(message, statusCode, code, details);
  }
}

function statusOf(error: any): number | undefined {
  return error?.response?.status ?? error?.status;
}

function isSequenceConflict(error: any): boolean {
  const transactionCode = error?.response?.data?.extras?.result_codes?.transaction;
  return transactionCode === "tx_bad_seq" || /tx_bad_seq|bad sequence/i.test(String(error?.message ?? ""));
}

function isRetryable(error: any): boolean {
  const message = String(error?.message ?? "");
  const status = statusOf(error);
  return status === 429 || status === 504 || message.includes("TIMEOUT") ||
    message.includes("TOO_MANY_REQUESTS") || message.includes("504") || message.includes("429");
}

function mapStellarError(error: unknown): StellarServiceError {
  if (error instanceof StellarServiceError) return error;
  const value = error as any;
  const status = statusOf(value);
  if (status === 404) {
    return new StellarServiceError("Stellar account or transaction was not found", 404, "STELLAR_NOT_FOUND");
  }
  if (status === 429 || status === 503 || status === 504) {
    return new StellarServiceError("Stellar Horizon is temporarily unavailable", 503, "STELLAR_HORIZON_UNAVAILABLE", { upstreamStatus: status });
  }
  const detail = typeof value?.message === "string" ? value.message : "Unknown Stellar error";
  return new StellarServiceError(`Stellar operation failed: ${detail}`, 502, "STELLAR_OPERATION_FAILED", { upstreamStatus: status });
}

export class StellarService {
  private readonly server: StellarHorizonClient;
  private readonly networkPassphrase: string;
  private readonly maxSequenceRetries: number;
  private readonly pollIntervalMs: number;
  private readonly sequenceManager: SequenceNumberManager;
  private readonly plans = new Map<string, TransactionPlan>();

  constructor(options: {
    server?: StellarHorizonClient;
    networkPassphrase?: string;
    maxSequenceRetries?: number;
    pollIntervalMs?: number;
    sequenceManager?: SequenceNumberManager;
  } = {}) {
    const config = getConfig();
    this.server = options.server ?? new Horizon.Server(config.STELLAR_HORIZON_URL) as unknown as StellarHorizonClient;
    this.networkPassphrase = options.networkPassphrase ?? config.STELLAR_NETWORK_PASSPHRASE;
    this.maxSequenceRetries = Math.min(3, Math.max(0, options.maxSequenceRetries ?? 3));
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.sequenceManager = options.sequenceManager ?? new SequenceNumberManager();
  }

  async buildPaymentTransaction(from: Keypair, to: string, amount: number, memo?: string): Promise<Transaction> {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new StellarServiceError("Payment amount must be a positive finite number", 400, "INVALID_PAYMENT_AMOUNT");
    }
    const amountXlm = amount.toFixed(7);
    if (Number(amountXlm) <= 0) {
      throw new StellarServiceError("Payment amount is below the minimum XLM precision", 400, "INVALID_PAYMENT_AMOUNT");
    }
    try {
      const payment = Operation.payment({ destination: to, asset: Asset.native(), amount: amountXlm });
      return this.buildTransaction(from, [payment], memo);
    } catch (error) {
      throw mapStellarError(error);
    }
  }

  async buildTransaction(from: Keypair, operations: Array<Record<string, unknown>>, memo?: string): Promise<Transaction> {
    const plan: TransactionPlan = { from, operations, memo };
    try {
      const transaction = await this.buildFromPlan(plan);
      this.plans.set(transaction.toXDR(), plan);
      return transaction;
    } catch (error) {
      throw mapStellarError(error);
    }
  }

  async submitTransaction(xdr: string): Promise<{ hash: string; success: boolean }> {
    const plan = this.plans.get(xdr);
    let transaction: Transaction;
    try {
      transaction = TransactionBuilder.fromXDR(xdr, this.networkPassphrase);
    } catch (error) {
      throw mapStellarError(error);
    }

    const submit = async (): Promise<{ hash: string; success: boolean }> => {
      for (let retry = 0; ; retry += 1) {
        try {
          const response = await this.withHorizonRetry(() => this.server.submitTransaction(transaction), true);
          if (!response.hash) {
            throw new StellarServiceError("Stellar Horizon accepted the request without returning a transaction hash", 502, "STELLAR_INVALID_RESPONSE");
          }
          this.plans.delete(xdr);
          return { hash: response.hash, success: true };
        } catch (error) {
          if (isSequenceConflict(error)) metricsService.recordStellarSequenceConflict();
          if (isSequenceConflict(error) && plan && retry < this.maxSequenceRetries) {
            try {
              transaction = await this.buildFromPlan(plan);
              continue;
            } catch (rebuildError) {
              throw mapStellarError(rebuildError);
            }
          }
          if (isSequenceConflict(error)) {
            if (!plan) {
              throw new StellarServiceError("Sequence conflict; rebuild the transaction with StellarService before retrying", 409, "STELLAR_SEQUENCE_CONFLICT");
            }
            throw new StellarServiceError("Stellar transaction sequence conflict persisted after retries", 409, "STELLAR_SEQUENCE_CONFLICT");
          }
          if (error instanceof StellarServiceError) throw error;
          throw mapStellarError(error);
        }
      }
    };

    return plan
      ? this.sequenceManager.withAccount(plan.from.publicKey(), submit)
      : submit();
  }

  async getAccountBalance(publicKey: string): Promise<number> {
    try {
      const account = await this.server.loadAccount(publicKey);
      const balances = account["balances"] as Array<{ asset_type?: string; balance?: string }> | undefined;
      const nativeBalance = balances?.find((balance) => balance.asset_type === "native");
      return Number(nativeBalance?.balance ?? 0);
    } catch (error) {
      throw mapStellarError(error);
    }
  }

  async waitForTransaction(hash: string, timeoutMs: number): Promise<TransactionResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new StellarServiceError("Transaction wait timeout must be a non-negative number", 400, "INVALID_TIMEOUT");
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      try {
        return await this.server.getTransaction(hash).call();
      } catch (error) {
        if (statusOf(error) !== 404) throw mapStellarError(error);
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new StellarServiceError(`Timed out waiting for Stellar transaction ${hash}`, 504, "STELLAR_TRANSACTION_TIMEOUT", { hash, timeoutMs });
  }

  private async buildFromPlan(plan: TransactionPlan): Promise<Transaction> {
    const account = await this.withHorizonRetry(() => this.server.loadAccount(plan.from.publicKey()));
    let builder = new TransactionBuilder(account as any, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });
    for (const operation of plan.operations) builder = builder.addOperation(operation as any);
    if (plan.memo) builder = builder.addMemo(Memo.text(plan.memo));
    const transaction = builder.setTimeout(30).build();
    transaction.sign(plan.from);
    return transaction;
  }

  private async withHorizonRetry<T>(operation: () => Promise<T>, stopOnSequenceConflict = false): Promise<T> {
    const maxAttempts = 5;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (stopOnSequenceConflict && isSequenceConflict(error)) throw error;
        if (!isRetryable(error) || attempt + 1 >= maxAttempts) {
          if (isRetryable(error)) {
            throw new StellarServiceError(
              `Stellar Horizon unavailable after ${maxAttempts} attempts`,
              503,
              "STELLAR_HORIZON_UNAVAILABLE",
            );
          }
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  }
}
