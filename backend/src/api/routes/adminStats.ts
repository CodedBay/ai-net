/**
 * Admin Stats Routes (#406)
 *
 * Endpoints:
 *   GET /api/admin/stats          — snapshot (active_agents, tasks_today, …)
 *   GET /api/admin/stats/revenue  — daily XLM volume for last 30 days
 *   GET /api/admin/stats/errors   — error breakdown by code for last 24 h
 *
 * All endpoints are protected by `adminAuthMiddleware`.
 * Responses support `?format=csv` for offline analysis.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { adminAuthMiddleware } from '../middleware/auth';
import { getDb } from '../../db/index';
import { getTaskDb } from '../../db/tasks';
import { getAgentDb } from '../../db/agents';
import { getErrorDb } from '../../db/errorRegistry';
import { createLogger } from '../../utils/logger';
import {
  getAdminStats,
  computeRevenueLast30Days,
  computeErrorBreakdown24h,
  adminStatsToCsv,
  revenueToCsv,
  errorBreakdownToCsv,
} from '../../services/adminStats';

const logger = createLogger({ module: 'adminStatsRoutes' });

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

export function createAdminStatsRouter(): Router {
  const router = Router();

  // All admin stats endpoints require the admin API key.
  router.use(adminAuthMiddleware);

  /**
   * @openapi
   * /api/admin/stats:
   *   get:
   *     summary: Admin platform statistics snapshot
   *     description: >
   *       Returns active agents, tasks today/this week, XLM transacted in the
   *       last 24 h, error rate over the last hour, and the top-5 agents by
   *       completed tasks. Results are cached for 5 minutes.
   *     operationId: getAdminStats
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: format
   *         schema:
   *           type: string
   *           enum: [json, csv]
   *           default: json
   *         description: Response format — json (default) or csv
   *     responses:
   *       200:
   *         description: Platform statistics
   *       401:
   *         description: Missing or invalid admin API key
   *       503:
   *         description: ADMIN_API_KEY is not configured
   */
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const agentDb = getAgentDb();
      const taskDb = getTaskDb();
      const paymentDb = getDb();
      let errorDb = null;
      try {
        errorDb = getErrorDb();
      } catch {
        // errors.db is optional
      }

      const snapshot = await getAdminStats(agentDb, taskDb, paymentDb, errorDb);

      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="admin_stats.csv"');
        res.send(adminStatsToCsv(snapshot));
        return;
      }

      res.json(snapshot);
    }),
  );

  /**
   * @openapi
   * /api/admin/stats/revenue:
   *   get:
   *     summary: Daily XLM revenue for last 30 days
   *     description: >
   *       Returns an array of daily XLM volume data points covering the last
   *       30 calendar days. Suitable for rendering a revenue chart.
   *     operationId: getAdminRevenue
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: format
   *         schema:
   *           type: string
   *           enum: [json, csv]
   *           default: json
   *     responses:
   *       200:
   *         description: Daily revenue data
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/revenue',
    asyncHandler(async (req: Request, res: Response) => {
      const paymentDb = getDb();
      const points = computeRevenueLast30Days(paymentDb);

      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
        res.send(revenueToCsv(points));
        return;
      }

      res.json({ revenue: points });
    }),
  );

  /**
   * @openapi
   * /api/admin/stats/errors:
   *   get:
   *     summary: Error breakdown by code for last 24 hours
   *     description: >
   *       Returns a count of active errors grouped by error code from the last
   *       24 hours, sorted by frequency descending.
   *     operationId: getAdminErrors
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: format
   *         schema:
   *           type: string
   *           enum: [json, csv]
   *           default: json
   *     responses:
   *       200:
   *         description: Error breakdown
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/errors',
    asyncHandler(async (req: Request, res: Response) => {
      let items: ReturnType<typeof computeErrorBreakdown24h> = [];
      try {
        const errorDb = getErrorDb();
        items = computeErrorBreakdown24h(errorDb);
      } catch {
        logger.warn('errors.db unavailable, returning empty error breakdown');
      }

      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="errors.csv"');
        res.send(errorBreakdownToCsv(items));
        return;
      }

      res.json({ errors: items });
    }),
  );

  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'admin stats error');
    res.status(500).json({ error: 'ADMIN_STATS_ERROR', message: err.message });
  });

  return router;
}
