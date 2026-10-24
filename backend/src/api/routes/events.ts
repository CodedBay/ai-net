/**
 * GET /api/events — query indexed Soroban contract events.
 *
 * Query parameters:
 *   contract  — filter by Soroban contract ID
 *   type      — filter by event type (e.g. "registry:agent_reg")
 *   from      — ISO-8601 lower bound on occurred_at (inclusive)
 *   to        — ISO-8601 upper bound on occurred_at (inclusive)
 *   limit     — max records per page (1–200, default 50)
 *   offset    — pagination offset (default 0)
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createEventsDb, getEventsDb } from "../../db/contractEvents";
import type { EventStore, StoredEvent } from "../../events/eventStore";
import { eventBus } from "../../coordinator/eventBus";
import { replayTask } from "../../events/replay";
import { CURRENT_EVENT_VERSION } from "../../events/eventTypes";
import { validateEvent } from "../../events/schemaRegistry";
import { getEventIndexer } from "../../services/eventIndexer";
import { ValidationError } from "../../errors";
import { adminAuthMiddleware } from "../middleware/auth";

const QuerySchema = z.object({
  contract: z.string().optional(),
  type: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ReplayQuerySchema = z.object({
  task_id: z.string().min(1),
  until: z.string().datetime({ offset: true }).optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(10_000),
  dry_run: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
});

export function createEventsRouter(eventStore?: EventStore): Router {
  const router = Router();

  /**
   * @openapi
   * /api/events:
   *   get:
   *     summary: Query indexed Soroban contract events
   *     operationId: listContractEvents
   *     tags:
   *       - Events
   *     parameters:
   *       - in: query
   *         name: contract
   *         schema:
   *           type: string
   *         description: Filter by Soroban contract ID
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *         description: Filter by event type (e.g. "registry:agent_reg")
   *       - in: query
   *         name: from
   *         schema:
   *           type: string
   *           format: date-time
   *         description: ISO-8601 lower bound (inclusive) on occurred_at
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *           format: date-time
   *         description: ISO-8601 upper bound (inclusive) on occurred_at
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 200
   *           default: 50
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *     responses:
   *       200:
   *         description: Paginated list of contract events
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 events:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/ContractEvent'
   *                 total:
   *                   type: integer
   *                 limit:
   *                   type: integer
   *                 offset:
   *                   type: integer
   *       400:
   *         description: Invalid query parameters
   */
  router.get("/", (req: Request, res: Response, next: NextFunction) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return next(new ValidationError(parsed.error.message));
    }

    const { contract, type, from, to, limit, offset } = parsed.data;

    try {
      const db = createEventsDb(getEventsDb());
      const events = db.query({
        contractId: contract,
        eventType: type,
        from,
        to,
        limit,
        offset,
      });
      const total = db.count({
        contractId: contract,
        eventType: type,
        from,
        to,
      });

      return res.json({ events, total, limit, offset });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * @openapi
   * /api/events/status:
   *   get:
   *     summary: Return the event indexer status
   *     operationId: getEventIndexerStatus
   *     tags:
   *       - Events
   *     responses:
   *       200:
   *         description: Indexer status
   */
  router.get("/status", (_req: Request, res: Response) => {
    try {
      const status = getEventIndexer().status();
      return res.json(status);
    } catch {
      return res.json({
        running: false,
        lastIndexedLedger: 0,
        eventsIndexed: 0,
        lastPollAt: null,
        lastError: "Indexer not initialised",
      });
    }
  });

  router.get("/replay", adminAuthMiddleware, (req: Request, res: Response) => {
    const parsed = ReplayQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_QUERY", details: parsed.error.flatten() });
      return;
    }

    const store = eventStore ?? eventBus.store;
    const { task_id, until, cursor, limit, dry_run: dryRun } = parsed.data;
    const page = store.listByTaskPage(task_id, {
      until,
      afterTaskSeq: cursor,
      limit: limit + 1,
    });
    const hasMore = page.length > limit;
    const events = hasMore ? page.slice(0, limit) : page;
    if (events.length === 0 && cursor === undefined) {
      res.status(404).json({ error: "TASK_EVENTS_NOT_FOUND", task_id });
      return;
    }

    const warnings: Array<{
      taskSeq: number;
      globalSeq: number;
      eventType: string;
      version: number;
      message: string;
    }> = [];
    const validEvents: StoredEvent[] = [];

    for (const event of events) {
      const validation = validateEvent(event);
      if (!validation.valid) {
        warnings.push({
          taskSeq: event.taskSeq,
          globalSeq: event.globalSeq,
          eventType: event.type,
          version: event.version,
          message: validation.errors.join("; "),
        });
        continue;
      }
      if (event.version < CURRENT_EVENT_VERSION) {
        warnings.push({
          taskSeq: event.taskSeq,
          globalSeq: event.globalSeq,
          eventType: event.type,
          version: event.version,
          message: `Event uses older schema version ${event.version}; current version is ${CURRENT_EVENT_VERSION}`,
        });
      }
      validEvents.push(event);
    }

    const replayed = dryRun ? undefined : replayTask(validEvents);
    const state = replayed
      ? { ...replayed, nodes: Object.fromEntries(replayed.nodes) }
      : null;
    res.json({
      task_id,
      until: until ?? null,
      dry_run: dryRun,
      state,
      events,
      eventsApplied: dryRun ? 0 : validEvents.length,
      warnings,
      next_cursor: hasMore ? events[events.length - 1].taskSeq : null,
    });
  });

  return router;
}
