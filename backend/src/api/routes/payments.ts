import { Router, type Request, type Response, type NextFunction } from "express";
import { createPaymentDb, getDb } from "../../db/index";
import type { PaymentRecord } from "../../db/index";
import { AppError } from "../../errors";

/**
 * Serialises a PaymentRecord for API responses.
 *
 * BigInt values (amountStroops) are not JSON-serialisable natively, so they
 * are converted to strings. This preserves full 64-bit precision and matches
 * the format used in the database column.
 */
function serializeRecord(r: PaymentRecord): Record<string, unknown> {
  return {
    taskId: r.taskId,
    nodeId: r.nodeId,
    balanceId: r.balanceId,
    status: r.status,
    amountStroops: r.amountStroops.toString(),
    txHash: r.txHash,
  };
}

export interface PaymentsRouterOptions {
  /** Injected payment db for testing; falls back to production db. */
  db?: ReturnType<typeof createPaymentDb>;
}

/**
 * @openapi
 * /api/payments:
 *   get:
 *     summary: List all payment records
 *     operationId: listPayments
 *     tags: [Payments]
 *     security: []
 *     description: >
 *       Returns the full local payment history — every locked, released, and
 *       refunded record. Records are ordered by taskId + nodeId (composite
 *       primary key). This is the reconciliation source of truth for the
 *       network's Stellar claimable-balance payment flow.
 *     responses:
 *       200:
 *         description: Payment record list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payments:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PaymentRecord'
 *                 total:
 *                   type: integer
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createPaymentsRouter(options: PaymentsRouterOptions = {}): Router {
  const router = Router();

  const getPaymentDb = () => options.db ?? createPaymentDb(getDb());

  router.get("/", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const db = getPaymentDb();
      const records = db.listAll();
      res.json({
        payments: records.map(serializeRecord),
        total: records.length,
      });
    } catch (err) {
      next(new AppError("Failed to retrieve payment history", 500, "INTERNAL_ERROR"));
    }
  });

  return router;
}

export default createPaymentsRouter();
