/**
 * POST /api/tasks/:id/cancel
 *
 * Cancellation flow:
 *  1. Validate requester is the task owner (walletpublickey header) or an
 *     admin (x-admin-key header matching ADMIN_API_KEY env var).
 *  2. Reject with 409 if the task is already completed, failed, or cancelled.
 *  3. Mark the task as `cancelled` in tasks.db.
 *  4. Cancel any pending or active Bull/job-store job for this task so the
 *     worker stops processing it.
 *  5. Attempt an XLM refund for every locked payment record associated with
 *     this task via PaymentService.refund(); collect the tx hashes.
 *  6. Return the final task state together with all refund transaction hashes.
 *
 * Auth:
 *  - Task owner: `walletpublickey` header must equal the task's `walletPublicKey`.
 *  - Admin:      `x-admin-key` header must equal `process.env.ADMIN_API_KEY`.
 *
 * Responses:
 *  200  { taskId, status: "cancelled", refundTxHashes: string[] }
 *  403  Access denied
 *  404  Task not found
 *  409  Task already completed / failed / cancelled
 *  500  Internal error during cancellation
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createTaskDb, getTaskDb } from '../../db/tasks';
import { getGlobalJobQueue, type JobQueue } from '../../queue';
import { createLogger } from '../../utils/logger';
import { getConfig } from '../../config';
import { PaymentService } from '../../payment/payment';
import { getDb } from '../../db/index';
import { Keypair } from '@stellar/stellar-sdk';

const log = createLogger({ component: 'cancel-task' });

/** Task statuses that cannot be cancelled. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface CancelTaskRouterOptions {
  queue?: JobQueue;
  /** Injected PaymentService — allows tests to stub Stellar calls. */
  paymentService?: PaymentService;
}

/**
 * Create and return the cancel router.
 *
 * Mount this as:
 *   tasksRouter.use('/:id/cancel', createCancelTaskRouter(options));
 * or equivalently:
 *   tasksRouter.post('/:id/cancel', cancelTaskHandler);
 */
export function createCancelTaskRouter(options: CancelTaskRouterOptions = {}): Router {
  const router = Router({ mergeParams: true });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id: taskId } = req.params as { id: string };
      const correlationId = res.locals.correlationId as string | undefined;

      // ── 1. Load task ──────────────────────────────────────────────────────
      const taskDb = createTaskDb(getTaskDb());
      const task = taskDb.findById(taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found', taskId });
        return;
      }

      // ── 2. Authorisation: task owner or admin ─────────────────────────────
      const requesterKey = req.user?.sub;
      const adminKey = req.headers['x-admin-key'] as string | undefined;
      const configAdminKey = getConfig().ADMIN_API_KEY;

      const isOwner = requesterKey && requesterKey === task.walletPublicKey;
      const isAdmin = configAdminKey && adminKey && adminKey === configAdminKey;

      if (!isOwner && !isAdmin) {
        res.status(403).json({ error: 'Access denied — you are not the task owner or an admin' });
        return;
      }

      // ── 3. Guard: cannot cancel terminal tasks ────────────────────────────
      if (TERMINAL_STATUSES.has(task.status)) {
        res.status(409).json({
          error: `Task cannot be cancelled in '${task.status}' status`,
          taskId,
          currentStatus: task.status,
        });
        return;
      }

      // ── 4. Mark task cancelled in DB ──────────────────────────────────────
      taskDb.updateStatus(taskId, 'cancelled');

      // ── 5. Cancel the queued / active job ─────────────────────────────────
      const jobQueue = options.queue ?? getGlobalJobQueue();
      const job = jobQueue.getJobByTaskId(taskId);
      if (job) {
        try {
          const store = jobQueue.getStore();
          // Mark as failed/dead-letter so the worker will not pick it up again.
          // We prefer updating to 'failed' with a cancellation message rather
          // than deleting, so audit trails are preserved.
          store.updateStatus(job.id, 'failed', {
            lastError: 'Cancelled by user or admin request',
          });
          log.info({ taskId, jobId: job.id }, 'Job cancelled in job store');
        } catch (jobErr) {
          // Non-fatal — the task is already marked cancelled in the DB.
          log.warn({ taskId, err: jobErr }, 'Could not cancel job in job store');
        }
      }

      // ── 6. Refund locked XLM payments ─────────────────────────────────────
      const refundTxHashes: string[] = [];

      try {
        const secret = getConfig().STELLAR_COORDINATOR_SECRET;
        if (secret) {
          const coordinatorKeypair = Keypair.fromSecret(secret);
          const paymentDb = getDb(); // payments.db
          const svc = options.paymentService ?? new PaymentService(paymentDb as any);

          // Find all payment records locked for this task.
          const payments = svc.listLocalRecords().filter(
            (r) => r.taskId === taskId && r.status === 'locked',
          );

          for (const payment of payments) {
            try {
              const txHash = await svc.refund(taskId, payment.nodeId, coordinatorKeypair);
              refundTxHashes.push(txHash);
              log.info({ taskId, nodeId: payment.nodeId, txHash }, 'XLM refund submitted');
            } catch (refundErr) {
              // Log but continue — we want to attempt all refunds.
              log.error({ taskId, nodeId: payment.nodeId, err: refundErr }, 'XLM refund failed');
            }
          }
        } else {
          log.warn({ taskId }, 'STELLAR_COORDINATOR_SECRET not configured — skipping refund');
        }
      } catch (paymentErr) {
        // Non-fatal — task is cancelled regardless of refund outcome.
        log.error({ taskId, err: paymentErr }, 'Payment refund step encountered an error');
      }

      // ── 7. Return result ──────────────────────────────────────────────────
      const updatedTask = taskDb.findById(taskId);
      res.status(200).json({
        taskId,
        status: 'cancelled',
        refundTxHashes,
        task: updatedTask ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
