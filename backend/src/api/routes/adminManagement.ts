import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { adminAuthMiddleware } from "../middleware/auth";
import {
  actorFromRequest,
  recordAdminAudit,
} from "../../services/adminControl";
import {
  banAgent,
  cancelTaskAsAdmin,
  getAdminPlatformStats,
  listAdminTasks,
  unbanAgent,
} from "../../services/adminPlatform";
import { createLogger, getRecentErrorLogs } from "../../utils/logger";

const logger = createLogger({ module: "admin-management" });

const TASK_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;

const taskListQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  wallet: z.string().min(1).max(128).optional(),
  walletAddress: z.string().min(1).max(128).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const banBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  level: z.enum(["error", "fatal"]).optional(),
});

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

function auditAdminRequests(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    recordAdminAudit({
      at: new Date().toISOString(),
      actor: actorFromRequest(req),
      action: `${req.method} ${req.baseUrl}${req.path}`,
      target: req.params.id,
      statusCode: res.statusCode,
      requestId:
        (res.locals.requestId as string | undefined) ??
        (res.locals.correlationId as string | undefined),
      details: {
        params: req.params,
        query: req.query,
        body: req.method === "GET" ? undefined : req.body,
      },
    });
  });
  next();
}

/**
 * Admin platform-management endpoints (#33).
 *
 * Mounted at `/api/admin`; every route is guarded by {@link adminAuthMiddleware}
 * so a missing, wrong, or unconfigured `ADMIN_API_KEY` always yields 403.
 */
export function createAdminManagementRouter(): Router {
  const router = Router();

  router.use(adminAuthMiddleware);
  router.use(auditAdminRequests);

  /**
   * @openapi
   * /api/admin/stats:
   *   get:
   *     summary: Platform metrics for administrators
   *     description: >
   *       Agent counts, task volume by status, and XLM throughput. Requires
   *       the admin API key; missing or invalid keys return 403.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     responses:
   *       200: { description: Platform aggregates }
   *       403: { description: Missing or invalid admin API key }
   */
  router.get("/stats", (_req: Request, res: Response) => {
    try {
      res.json(getAdminPlatformStats());
    } catch (error) {
      logger.error({ err: error }, "failed to build admin stats");
      res.status(500).json({ error: "ADMIN_STATS_FAILED" });
    }
  });

  /**
   * @openapi
   * /api/admin/tasks:
   *   get:
   *     summary: List all tasks with filters
   *     description: Supports status, wallet, date-range and pagination filters.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema: { type: string, enum: [queued, running, completed, failed, cancelled] }
   *       - in: query
   *         name: wallet
   *         schema: { type: string }
   *       - in: query
   *         name: from
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: to
   *         schema: { type: string, format: date-time }
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, minimum: 0, default: 0 }
   *     responses:
   *       200: { description: Paginated task list }
   *       400: { description: Invalid query }
   *       403: { description: Missing or invalid admin API key }
   */
  router.get("/tasks", (req: Request, res: Response) => {
    const parsed = taskListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_QUERY", details: parsed.error.flatten() });
      return;
    }

    const { wallet, walletAddress, ...rest } = parsed.data;
    res.json(
      listAdminTasks({
        ...rest,
        wallet: wallet ?? walletAddress,
      }),
    );
  });

  /**
   * @openapi
   * /api/admin/tasks/{id}:
   *   delete:
   *     summary: Cancel any task
   *     description: Force-cancels a task, cancels its queued job, and refunds locked payments where possible.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Task cancelled }
   *       403: { description: Missing or invalid admin API key }
   *       404: { description: Task not found }
   *       409: { description: Task already terminal }
   */
  router.delete(
    "/tasks/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const result = await cancelTaskAsAdmin(req.params.id);
      if (!result.ok) {
        res.status(result.statusCode).json({
          error: result.error,
          currentStatus: result.currentStatus,
        });
        return;
      }
      res.json({
        taskId: result.task.id,
        status: result.task.status,
        refundTxHashes: result.refundTxHashes,
        task: result.task,
      });
    }),
  );

  /**
   * @openapi
   * /api/admin/agents/{id}/ban:
   *   post:
   *     summary: Ban an agent
   *     description: >
   *       Marks an agent as banned and offline so it is excluded from new task
   *       assignments until unbanned.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason: { type: string, maxLength: 500 }
   *     responses:
   *       200: { description: Agent banned }
   *       403: { description: Missing or invalid admin API key }
   *       404: { description: Agent not found }
   */
  router.post("/agents/:id/ban", (req: Request, res: Response) => {
    const parsed = banBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
      return;
    }

    const agent = banAgent(req.params.id, parsed.data.reason);
    if (!agent) {
      res.status(404).json({ error: "AGENT_NOT_FOUND" });
      return;
    }
    res.json({ banned: true, agent });
  });

  /**
   * @openapi
   * /api/admin/agents/{id}/unban:
   *   post:
   *     summary: Lift an agent ban
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200: { description: Agent unbanned }
   *       403: { description: Missing or invalid admin API key }
   *       404: { description: Agent not found }
   */
  router.post("/agents/:id/unban", (req: Request, res: Response) => {
    const agent = unbanAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "AGENT_NOT_FOUND" });
      return;
    }
    res.json({ banned: false, agent });
  });

  /**
   * @openapi
   * /api/admin/logs:
   *   get:
   *     summary: Recent error log entries
   *     description: In-memory ring buffer of the most recent error/fatal log lines.
   *     tags: [Admin]
   *     security:
   *       - adminApiKey: []
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
   *       - in: query
   *         name: level
   *         schema: { type: string, enum: [error, fatal] }
   *     responses:
   *       200: { description: Recent error log entries (newest first) }
   *       400: { description: Invalid query }
   *       403: { description: Missing or invalid admin API key }
   */
  router.get("/logs", (req: Request, res: Response) => {
    const parsed = logsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_QUERY", details: parsed.error.flatten() });
      return;
    }

    const entries = getRecentErrorLogs(parsed.data.limit).filter(
      (entry) => !parsed.data.level || entry.level === parsed.data.level,
    );
    res.json({ entries, total: entries.length });
  });

  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "admin management operation failed");
    res.status(500).json({ error: "ADMIN_OPERATION_FAILED", message: err.message });
  });

  return router;
}

export default createAdminManagementRouter;
