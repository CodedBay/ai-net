import {
  Keypair,
  Server,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { PaymentDb, PaymentRecord } from "../db/index";
import {
  PaymentAlreadyReleasedError,
  HorizonUnavailableError,
  xlmToStroops,
  stroopsToXlm,
} from "./utils";
import { tracingService } from "../services/tracing";
import { currentTraceId } from "../services/traceContext";
import { getConfig } from "../config";
import { SequenceNumberManager } from "./sequenceManager";
import { metricsService } from "../services/metrics";

const MAX_RETRIES = 5;
const MAX_SEQUENCE_CONFLICT_RETRIES = 3;

/**
 * Determines whether a Horizon submission error is safe to retry.
 *
 * Retryable conditions include gateway timeouts (504), rate-limit responses
 * (429 / TOO_MANY_REQUESTS), and the Stellar `tx_too_late` result code.
 *
 * @param err - The error thrown by a Horizon or fetch call.
 * @returns `true` when the call should be retried, `false` otherwise.
 */
function isRetryable(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  // Horizon error codes for TIMEOUT and TOO_MANY_REQUESTS
  const extras = (
    err as {
      response?: { data?: { extras?: { result_codes?: { transaction?: string } } } };
    }
  )?.response?.data?.extras?.result_codes?.transaction ?? "";
  return (
    message.includes("TIMEOUT") ||
    message.includes("TOO_MANY_REQUESTS") ||
    message.includes("504") ||
    message.includes("429") ||
    extras === "tx_too_late"
  );
}

/**
 * Executes an async operation with exponential-backoff retries for transient
 * Horizon errors. Retries up to {@link MAX_RETRIES} times before re-throwing.
 *
 * @param fn - Async factory that performs the Horizon or fetch operation.
 * @returns The resolved value of `fn` on the first successful attempt.
 * @throws {@link HorizonUnavailableError} when all retry attempts are exhausted for a retryable error.
 * @throws The original error unchanged when it is not retryable.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        if (isRetryable(err)) throw new HorizonUnavailableError(MAX_RETRIES);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Returns true when the Horizon error indicates a sequence-number conflict.
 * This happens when two transactions were built from the same account state
 * concurrently and one of them was submitted after the other already advanced
 * the sequence number.
 */
function isBadSeq(err: unknown): boolean {
  const extras =
    (
      err as {
        response?: {
          data?: { extras?: { result_codes?: { transaction?: string } } };
        };
      }
    )?.response?.data?.extras?.result_codes?.transaction ?? "";
  return extras === "tx_bad_seq" || /tx_bad_seq|bad sequence/i.test(String((err as { message?: string })?.message ?? ""));
}

export interface PaymentServiceHooks {
  /**
   * Invoked after a payment is successfully released on-chain so callers can
   * trigger a reconciliation check (e.g. `ReconciliationService.run('release')`).
   */
  reconciliationHook?: (record: PaymentRecord) => void;
}

/**
 * Manages Stellar claimable-balance payments between the coordinator and
 * agent nodes. Each payment lifecycle consists of three phases:
 *
 * 1. **lock** — coordinator creates a claimable balance on Stellar; both
 *    parties are listed as claimants so either can reclaim.
 * 2. **release** — coordinator claims the balance on behalf of the agent
 *    after the agent successfully completes its task.
 * 3. **refund** — coordinator reclaims the balance when the agent fails or
 *    exceeds its deadline.
 *
 * All on-chain transactions are submitted through Horizon with automatic
 * exponential-backoff retries for transient failures.
 */
export class PaymentService {
  private server: Server;
  private networkPassphrase: string;
  /** Serialises Stellar submissions per source account to prevent tx_bad_seq. */
  private sequenceManager = new SequenceNumberManager();

  constructor(
    private db: PaymentDb,
    private hooks: PaymentServiceHooks = {}
  ) {
    const config = getConfig();
    this.server = new Server(config.STELLAR_HORIZON_URL);
    this.networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE;
  }

  /**
   * Returns every payment record held in the local SQLite database.
   *
   * This is the source of truth used by the reconciliation service to detect
   * on-chain / off-chain drift.
   *
   * @returns Array of all {@link PaymentRecord} entries, ordered by insertion.
   */
  listLocalRecords(): PaymentRecord[] {
    return this.db.listAll();
  }

  /**
   * Locks XLM into a Stellar claimable balance, escrowing funds for a task node.
   *
   * Creates a claimable balance on Stellar with both the agent and the
   * coordinator as unconditional claimants. The balance ID is persisted
   * locally with status `"locked"` and returned to the caller.
   *
   * @param taskId - Unique identifier of the parent task.
   * @param nodeId - DAG node identifier within the task.
   * @param coordinatorKeypair - Stellar keypair that funds and signs the transaction.
   * @param agentPublicKey - Stellar public key of the agent that will claim the balance.
   * @param amountXLM - Payment amount expressed in XLM (not stroops).
   * @param correlationId - Optional W3C trace ID for distributed tracing; falls back to the ambient trace context.
   * @returns The deterministic claimable balance ID derived from the transaction.
   * @throws {@link HorizonUnavailableError} when Horizon is unreachable after all retries.
   * @throws Error when the Stellar transaction fails for a non-retryable reason.
   */
  async lock(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair,
    agentPublicKey: string,
    amountXLM: number,
    correlationId?: string
  ): Promise<string> {
    const traceId = correlationId ?? currentTraceId();
    const span = traceId
      ? tracingService.startSpan(traceId, 'payment', 'lock', { taskId, nodeId, amountXLM })
      : null;

    try {
      const balanceId = await this.withSequenceRetry(
        coordinatorKeypair.publicKey(),
        async () => {
          const amountStroops = xlmToStroops(amountXLM);
          const amountStr = stroopsToXlm(amountStroops);

          /**
           * Inner helper: load account, build, sign, and submit a lock tx.
           * Extracted so we can retry once on tx_bad_seq with a freshly loaded
           * account (and therefore a fresh sequence number).
           */
          const buildAndSubmit = async (): Promise<string> => {
            const account = await withRetry(() =>
              this.server.loadAccount(coordinatorKeypair.publicKey())
            );

            const tx = new TransactionBuilder(account, {
              fee: BASE_FEE,
              networkPassphrase: this.networkPassphrase,
            })
              .addOperation(
                Operation.createClaimableBalance({
                  asset: Asset.native(),
                  amount: amountStr,
                  claimants: [
                    new Claimant(agentPublicKey, Claimant.predicateUnconditional()),
                    new Claimant(coordinatorKeypair.publicKey(), Claimant.predicateUnconditional()),
                  ],
                })
              )
              .setTimeout(30)
              .build();

            // Derive balance ID before signing — deterministic from the operation
            const bid = tx.getClaimableBalanceId(0);
            tx.sign(coordinatorKeypair);
            await withRetry(() => this.server.submitTransaction(tx));
            return bid;
          };

          const bid = await buildAndSubmit();

          this.db.insert({
            taskId,
            nodeId,
            balanceId: bid,
            status: "locked",
            amountStroops,
            txHash: null,
          });

          return bid;
        },
      );

      if (span) tracingService.endSpan(span.spanId, 'completed', { balanceId });
      return balanceId;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      throw err;
    }
  }

  /**
   * Claims the claimable balance and marks the payment as released.
   *
   * The coordinator submits a `claimClaimableBalance` operation to transfer
   * funds to the agent. If the record already has status `"released"` the
   * existing transaction hash is returned immediately (idempotent).
   *
   * @param taskId - Unique identifier of the parent task.
   * @param nodeId - DAG node identifier within the task.
   * @param coordinatorKeypair - Stellar keypair authorised to claim the balance.
   * @param correlationId - Optional W3C trace ID for distributed tracing.
   * @returns The Stellar transaction hash of the claim operation.
   * @throws Error when no payment record exists for the given `taskId`/`nodeId` pair.
   * @throws {@link HorizonUnavailableError} when Horizon is unreachable after all retries.
   */
  async release(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair,
    correlationId?: string
  ): Promise<string> {
    const record = this.db.findByKey(taskId, nodeId);
    if (!record) throw new Error(`No payment record for task=${taskId} node=${nodeId}`);

    // Idempotency: return existing hash without a second Stellar tx
    if (record.status === "released" && record.txHash) {
      return record.txHash;
    }

    const traceId = correlationId ?? currentTraceId();
    const span = traceId
      ? tracingService.startSpan(traceId, 'payment', 'release', { taskId, nodeId })
      : null;

    try {
      const txHash = await this.withSequenceRetry(
        coordinatorKeypair.publicKey(),
        async () => {
          const account = await withRetry(() => this.server.loadAccount(coordinatorKeypair.publicKey()));
          const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
          })
            .addOperation(Operation.claimClaimableBalance({ balanceId: record.balanceId }))
            .setTimeout(30)
            .build();
          tx.sign(coordinatorKeypair);
          const result = await withRetry(() => this.server.submitTransaction(tx));
          return (result as unknown as { hash: string }).hash;
        },
      );

      this.db.updateStatus(taskId, nodeId, "released", txHash);

      this.hooks.reconciliationHook?.({
        ...record,
        status: "released",
        txHash,
      });

      if (span) tracingService.endSpan(span.spanId, 'completed', { txHash });
      return txHash;
    } catch (err) {
      if (span) tracingService.endSpan(span.spanId, 'failed', { error: String(err) });
      throw err;
    }
  }

  /**
   * Reclaims the claimable balance back to the coordinator when an agent
   * fails to complete its assigned task.
   *
   * Uses the same `claimClaimableBalance` operation as `release()` because
   * the coordinator is also an unconditional claimant. The local record is
   * updated to status `"refunded"`.
   *
   * @param taskId - Unique identifier of the parent task.
   * @param nodeId - DAG node identifier within the task.
   * @param coordinatorKeypair - Stellar keypair authorised to reclaim the balance.
   * @returns The Stellar transaction hash of the refund operation.
   * @throws {@link PaymentAlreadyReleasedError} when the balance has already been released to the agent.
   * @throws Error when no payment record exists for the given `taskId`/`nodeId` pair.
   * @throws {@link HorizonUnavailableError} when Horizon is unreachable after all retries.
   */
  async refund(
    taskId: string,
    nodeId: string,
    coordinatorKeypair: Keypair
  ): Promise<string> {
    const record = this.db.findByKey(taskId, nodeId);
    if (!record) throw new Error(`No payment record for task=${taskId} node=${nodeId}`);

    if (record.status === "released") {
      throw new PaymentAlreadyReleasedError(taskId, nodeId);
    }

    const txHash = await this.withSequenceRetry(
      coordinatorKeypair.publicKey(),
      async () => {
        const account = await withRetry(() => this.server.loadAccount(coordinatorKeypair.publicKey()));
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(Operation.claimClaimableBalance({ balanceId: record.balanceId }))
          .setTimeout(30)
          .build();
        tx.sign(coordinatorKeypair);
        const result = await withRetry(() => this.server.submitTransaction(tx));
        return (result as unknown as { hash: string }).hash;
      },
    );

    this.db.updateStatus(taskId, nodeId, "refunded", txHash);
    return txHash;
  }

  /**
   * Retrieves the current local payment record for a task node.
   *
   * @param taskId - Unique identifier of the parent task.
   * @param nodeId - DAG node identifier within the task.
   * @returns The matching {@link PaymentRecord}, or `undefined` if no record exists.
   */
  getPaymentStatus(taskId: string, nodeId: string): PaymentRecord | undefined {
    return this.db.findByKey(taskId, nodeId);
  }

  private withSequenceRetry<T>(publicKey: string, submit: () => Promise<T>): Promise<T> {
    return this.sequenceManager.withAccount(publicKey, async () => {
      let retries = 0;
      while (true) {
        try {
          return await submit();
        } catch (error) {
          if (!isBadSeq(error)) throw error;
          metricsService.recordStellarSequenceConflict();
          if (retries >= MAX_SEQUENCE_CONFLICT_RETRIES) throw error;
          retries += 1;
        }
      }
    });
  }
}
