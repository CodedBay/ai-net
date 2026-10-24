import { Router } from 'express';
import { z } from 'zod';
import {
  ReconciliationService,
  createDefaultReconciliationService,
} from '../../services/reconciliation';
import type { ReconciliationTrigger } from '../../services/reconciliation.types';
import { createLogger } from '../../utils/logger';
import { AppError } from '../../errors';
import { validate } from '../middleware/validate';

const reconciliationRunSchema = z.object({
  triggeredBy: z.enum(['manual', 'scheduled', 'release']).default('manual'),
}).strict();

export interface ReconciliationRouterOptions {
  /** Service to use; defaults to the production service. */
  service?: ReconciliationService;
}

/**
 * @openapi
 * /api/reconciliation/run:
 *   post:
 *     summary: Trigger a payment reconciliation check
 *     operationId: runReconciliation
 *     tags: [Reconciliation]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               triggeredBy:
 *                 type: string
 *                 enum: [manual, scheduled, release]
 *                 default: manual
 *     responses:
 *       200:
 *         description: Reconciliation report for this run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReconciliationReport'
 *       500:
 *         description: Reconciliation run failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * /api/reconciliation/report:
 *   get:
 *     summary: Get the latest reconciliation report
 *     operationId: getLatestReconciliationReport
 *     tags: [Reconciliation]
 *     responses:
 *       200:
 *         description: Latest reconciliation report
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReconciliationReport'
 *       404:
 *         description: No reconciliation report has been generated yet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createReconciliationRouter(
  options: ReconciliationRouterOptions = {}
): Router {
  const router = Router();
  const logger = createLogger({ module: "reconciliation" });
  let service: ReconciliationService | null = null;
  const getService = (): ReconciliationService =>
    (service ??= options.service ?? createDefaultReconciliationService());

  router.post('/run', validate(reconciliationRunSchema), async (req, res, next) => {
    try {
      const { triggeredBy } = req.body as z.infer<typeof reconciliationRunSchema>;

      const report = await getService().run(triggeredBy as ReconciliationTrigger);
      return res.status(200).json(report);
    } catch (error) {
      logger.error({ err: error }, "reconciliation run failed");
      next(new AppError('Reconciliation run failed', 500, 'RECONCILIATION_FAILED'));
    }
  });

  router.get('/report', (_req, res, next) => {
    const report = getService().getLatestReport();
    if (!report) {
      next(new AppError('No reconciliation report available', 404, 'NO_RECONCILIATION_REPORT'));
      return;
    }
    return res.status(200).json(report);
  });

  return router;
}