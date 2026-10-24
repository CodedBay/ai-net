import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { getAgentDb, createAgentDb, AgentDb } from "../../db/agents";
import { heartbeatRateLimitMiddleware } from "../middleware/rateLimit";
import { NotFoundError, ValidationError, UnauthorizedError, AppError } from "../../errors";
import { cacheMiddleware } from "../middleware/cache";
import { invalidateAgentsCache } from "../../cache/invalidation";
import { ttlForRoute } from "../../config";
import { requireWalletAuthMiddleware } from "../middleware/auth";
import {
  calculateReputationBreakdown,
  computeReputationDelta,
} from "../../services/qualityScorer";

const AgentCursorListSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  capability: z.string().optional(),
  minReputation: z.coerce.number().optional(),
  maxPriceXLM: z.coerce.number().optional(),
  status: z.enum(["online", "offline"]).optional(),
});

export interface AgentsRouterOptions {
  healthTimeoutMs?: number;
  db?: AgentDb;
}

const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

// Mirrors the RegisterAgentRequest schema documented in api/docs.ts.
const RegisterAgentSchema = z.object({
  agentId: z.string().min(1),
  capabilities: z.array(z.string()).min(1),
  pricingXLM: z.number().min(0.001),
  endpoint: z.string().url(),
  stellarPublicKey: z.string().regex(STELLAR_PUBLIC_KEY_REGEX, "Invalid Stellar public key format"),
});

/** Sybil resistance cap: agents registerable per Stellar account (Issue #497). */
const MAX_AGENTS_PER_STELLAR_ACCOUNT = 2;

/** Body for POST /api/agents/:id/task-result (Issue #497). */
const TaskResultSchema = z
  .object({
    outcome: z.enum(["success", "failure"]),
    qualityScore: z.number().min(0).max(100).optional(),
    latencyMs: z.number().min(0).optional(),
  })
  .strict();

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const QUALITY_SCORE_VERSION = "1.0";
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON_URL);

export function createAgentsRouter(options: AgentsRouterOptions = {}): Router {
  const router = Router();
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const getDb = () => options.db ?? createAgentDb(getAgentDb());
  const agentNotFound = (id: string) => new AppError(`Agent '${id}' not found`, 404, "AGENT_NOT_FOUND");

  /**
   * @openapi
   * /api/agents:
   *   get:
   *     summary: List registered agents
   *     operationId: listAgents
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: query
   *         name: capability
   *         schema: { type: string }
   *         description: Filter agents that support this capability
   *       - in: query
   *         name: minReputation
   *         schema: { type: number }
   *       - in: query
   *         name: maxPriceXLM
   *         schema: { type: number }
   *     responses:
   *       200:
   *         description: List of agents
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Agent'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // GET /api/agents — supports cursor pagination when ?cursor or ?limit present
  router.get("/", cacheMiddleware({ ttl: ttlForRoute("agents") }), (req: Request, res: Response, next: NextFunction): void => {
    const db = getDb();
    const useCursor = "cursor" in req.query || "limit" in req.query;

    if (useCursor) {
      const parse = AgentCursorListSchema.safeParse(req.query);
      if (!parse.success) {
        res.status(400).json({ error: parse.error.flatten() });
        return;
      }
      const { cursor, limit, capability, minReputation, maxPriceXLM, status } = parse.data;
      try {
        const page = db.listCursor({ cursor, limit, capability, minReputation, maxPriceXLM, status });
        const items = page.items.map((agent) => {
          const quality = getAgentQualityMetrics(agent.id);
          return quality ? { ...agent, quality_score: quality.average } : agent;
        });
        res.json({
          data: {
              items,
            pagination: {
              limit,
              nextCursor: page.nextCursor ?? null,
              hasNextPage: !!page.nextCursor,
            },
          },
          _links: {
            self: `/api/agents`,
            ...(page.nextCursor
              ? { next: `/api/agents?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}` }
              : {}),
          },
        });
      } catch (err) {
        res.status(500).json({ error: "Internal Server Error" });
      }
      return;
    }

    // Legacy flat-array response for backward compatibility
    const capability = req.query.capability as string | undefined;
    const minReputation = req.query.minReputation ? parseFloat(req.query.minReputation as string) : undefined;
    const maxPriceXLM = req.query.maxPriceXLM ? parseFloat(req.query.maxPriceXLM as string) : undefined;

    try {
      const agents = db.list({ capability, minReputation, maxPriceXLM });
      res.json(agents.map((agent) => {
        const quality = getAgentQualityMetrics(agent.id);
        return quality ? { ...agent, quality_score: quality.average } : agent;
      }));
    } catch (err) {
      next(new AppError("Internal Server Error", 500, "INTERNAL_ERROR"));
    }
  });

  /**
   * @openapi
   * /api/agents/{id}:
   *   get:
   *     summary: Get registered agent by ID
   *     description: Fetches agent profile, capabilities, reputation score, and status by unique agentId.
   *     operationId: getAgent
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Agent details retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Agent'
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // GET /api/agents/:id
  router.get("/:id", cacheMiddleware({ ttl: ttlForRoute("agents") }), (req: Request, res: Response, next: NextFunction): void => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) {
        return next(agentNotFound(req.params.id));
      }
      res.json({
        ...agent,
        reputation: calculateReputationBreakdown({
          reputationScore: agent.reputationScore,
          tasksCompleted: agent.tasksCompleted,
          tasksFailed: agent.tasksFailed,
          bondAmountXLM: agent.bondAmountXLM,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/task-result:
   *   post:
   *     summary: Report a task outcome and update agent reputation
   *     description: >
   *       Applies the Issue #497 reputation update rules: success raises the
   *       score based on quality and latency with a bounded bond multiplier;
   *       failure applies a fixed penalty. Response includes the full
   *       reputation breakdown after the update.
   *     tags: [Agents]
   *     security: []
   *     operationId: recordAgentTaskResult
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [outcome]
   *             properties:
   *               outcome:
   *                 type: string
   *                 enum: [success, failure]
   *               qualityScore:
   *                 type: number
   *                 minimum: 0
   *                 maximum: 100
   *               latencyMs:
   *                 type: number
   *                 minimum: 0
   *     responses:
   *       200:
   *         description: Reputation updated
   *       404:
   *         description: Agent not found
   */
  // POST /api/agents/:id/task-result
  router.post("/:id/task-result", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parse = TaskResultSchema.safeParse(req.body);
      if (!parse.success) {
        throw new ValidationError(
          "Invalid task result data",
          { issues: parse.error.flatten() },
          res.locals.correlationId as string | undefined,
        );
      }

      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        return next(agentNotFound(req.params.id));
      }

      const { outcome, qualityScore, latencyMs } = parse.data;
      const delta = computeReputationDelta({
        outcome,
        qualityScore,
        latencyMs,
        bondAmountXLM: agent.bondAmountXLM ?? 0,
        currentReputation: agent.reputationScore,
      });
      db.updateReputationWithStats(req.params.id, delta, outcome);

      const updated = db.findById(req.params.id);
      const reputationScore = updated?.reputationScore ?? agent.reputationScore;
      res.json({
        agentId: req.params.id,
        reputationDelta: delta,
        reputationScore,
        reputation: calculateReputationBreakdown({
          reputationScore,
          tasksCompleted: updated?.tasksCompleted,
          tasksFailed: updated?.tasksFailed,
          bondAmountXLM: updated?.bondAmountXLM,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/quality:
   *   get:
   *     summary: Get an agent's composite quality score and sub-scores
   *     operationId: getAgentQuality
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Versioned quality score breakdown
   *       404:
   *         description: Agent not found
   */
  router.get("/:id/quality", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) return next(agentNotFound(req.params.id));

      const metrics = getAgentQualityMetrics(agent.id);
      const records = createTaskDb(getTaskDb()).listQualityScores(agent.id);
      const responseSamples = records.filter((record) => record.responseTimeMs !== undefined);
      const totalTasks = (agent.tasksCompleted ?? 0) + (agent.tasksFailed ?? 0);
      res.json({
        agent_id: agent.id,
        composite_score: metrics?.average ?? 0,
        sub_scores: {
          completion_rate: totalTasks > 0 ? (agent.tasksCompleted ?? 0) / totalTasks : 0,
          response_time: responseSamples.length > 0
            ? responseSamples.reduce((sum, record) => sum + (record.responseTimeMs ?? 0), 0) / responseSamples.length
            : 0,
          accuracy: records.length > 0
            ? records.reduce((sum, record) => sum + record.relevance, 0) / records.length
            : 0,
        },
        score_version: QUALITY_SCORE_VERSION,
        sample_size: metrics?.sampleSize ?? 0,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/quality/history:
   *   get:
   *     summary: Get an agent's quality score history for the last 30 days
   *     operationId: getAgentQualityHistory
   *     tags: [Agents]
   *     security: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Quality score records, oldest first
   *       404:
   *         description: Agent not found
   */
  router.get("/:id/quality/history", (req: Request, res: Response, next: NextFunction): void => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) return next(agentNotFound(req.params.id));

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const records = createTaskDb(getTaskDb()).listQualityScores(agent.id, 500, since);
      res.json({
        agent_id: agent.id,
        score_version: QUALITY_SCORE_VERSION,
        data: records.map((record) => ({
          task_id: record.taskId,
          node_id: record.nodeId,
          score: record.score,
          sub_scores: {
            completeness: record.completeness,
            relevance: record.relevance,
            format: record.format,
          },
          response_time_ms: record.responseTimeMs ?? null,
          timestamp: record.timestamp,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/health:
   *   get:
   *     summary: Check an agent's live health/reachability
   *     tags: [Agents]
   *     security: []
   *     operationId: checkAgentHealth
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Health check result
   *       404:
   *         description: Agent not found
   */
  // GET /api/agents/:id/health
    /**
     * @openapi
     * /api/agents/{id}/reputation/history:
     *   get:
     *     summary: Get an agent's reputation history for the last 30 days
     *     tags: [Agents]
     *     security: []
     *     operationId: getAgentReputationHistory
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Reputation snapshots, oldest first
     *       404:
     *         description: Agent not found
     */
    router.get("/:id/reputation/history", (req: Request, res: Response, next: NextFunction): void => {
      try {
        const db = getDb();
        if (!db.findById(req.params.id)) {
          return next(agentNotFound(req.params.id));
        }
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const history = db.listReputationHistory?.(req.params.id, since) ?? [];
        res.json(history.map(({ timestamp, ...record }) => ({ ...record, date: timestamp })));
      } catch (error) {
        next(error);
      }
    });

    // GET /api/agents/:id/health
  router.get("/:id/health", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agent = getDb().findById(req.params.id);
      if (!agent) {
        return next(agentNotFound(req.params.id));
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);

      try {
        const response = await fetch(agent.endpoint, {
          method: "GET",
          signal: controller.signal,
        });
        res.status(200).json({
          status: response.ok ? "healthy" : "unreachable",
          latencyMs: Date.now() - startedAt,
        });
      } catch {
        res.status(200).json({
          status: "unreachable",
          latencyMs: Date.now() - startedAt,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/register:
   *   post:
   *     summary: Register a new specialized agent
   *     tags: [Agents]
   *     security: []
   *     operationId: registerAgent
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/RegisterAgentRequest'
   *     responses:
   *       201:
   *         description: Agent registered successfully
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Agent'
   *       400:
   *         description: Validation error or Stellar account verification failure
   *       429:
   *         description: Registration rate limit exceeded
   */
  // POST /api/agents/register
  router.post("/register", requireWalletAuthMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const parse = RegisterAgentSchema.safeParse(req.body);
      if (!parse.success) {
        throw new ValidationError(
          "Invalid agent registration data",
          { issues: parse.error.flatten() },
          correlationId,
        );
      }

      const data = parse.data;
      if (data.stellarPublicKey !== req.user?.sub) {
        return next(new UnauthorizedError("Wallet JWT must match stellarPublicKey", undefined, correlationId));
      }

      // Verify Stellar account exists
      if (process.env.SKIP_STELLAR_ACCOUNT_VERIFY !== "true") {
        try {
          await horizon.loadAccount(data.stellarPublicKey);
        } catch (error: any) {
          if (error?.response?.status === 404) {
            res.status(400).json({
              error: "Stellar account not found",
              code: "StellarAccountNotFound",
            });
            return;
          }
          if (process.env.NODE_ENV !== "test") {
            res.status(400).json({
              error: "Failed to verify Stellar account",
              code: "StellarVerificationFailed",
            });
            return;
          }
        }
      }

      const db = getDb();

      // Sybil resistance — cap agents per Stellar account (Issue #497)
      if (db.countByStellarKey(data.stellarPublicKey) >= MAX_AGENTS_PER_STELLAR_ACCOUNT) {
        res.status(400).json({
          error: `Agent limit per Stellar account reached (max ${MAX_AGENTS_PER_STELLAR_ACCOUNT} agents per key)`,
        });
        return;
      }

      const existing = db.findById(data.agentId);
      const agent = {
        id: data.agentId,
        capabilities: data.capabilities,
        pricingXLM: data.pricingXLM,
        endpoint: data.endpoint,
        stellarPublicKey: data.stellarPublicKey,
        reputationScore: 0,
        lastSeenAt: new Date().toISOString(),
        // A banned agent stays banned across re-registration (#33).
        status: existing?.bannedAt ? ("offline" as const) : ("online" as const),
        bannedAt: existing?.bannedAt ?? null,
      };

      db.upsert(agent);

      // Await invalidation so the new agent appears on the next GET
      await invalidateAgentsCache().catch(() => {/* best-effort */});

      res.status(201).json(agent);
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}/heartbeat:
   *   post:
   *     summary: Agent heartbeat keep-alive
   *     description: Updates the agent's lastSeenAt timestamp and keeps its online status active.
   *     tags: [Agents]
   *     security: []
   *     operationId: agentHeartbeat
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         example: "agent_crypto_analyst_01"
   *     responses:
   *       200:
   *         description: Heartbeat recorded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AgentHeartbeatResponse'
   *             example:
   *               status: "ok"
   *               lastSeenAt: "2026-08-25T17:30:00.000Z"
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   *       429:
   *         description: Heartbeat rate limit exceeded
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/RateLimitError'
   */
  // POST /api/agents/:id/heartbeat
  router.post("/:id/heartbeat", requireWalletAuthMiddleware, heartbeatRateLimitMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        return next(agentNotFound(req.params.id));
      }
      if (agent.bannedAt) {
        res.status(403).json({
          error: "AGENT_BANNED",
          message: "This agent has been banned by an administrator.",
        });
        return;
      }
      if (agent.stellarPublicKey !== req.user?.sub) {
        return next(new UnauthorizedError("Wallet JWT does not own this agent", undefined, res.locals.correlationId as string | undefined));
      }

      db.updateLastSeen(req.params.id);
      const updated = db.findById(req.params.id);

      // Await invalidation so the updated lastSeenAt is visible on the next GET
      await invalidateAgentsCache().catch(() => {/* best-effort */});

      res.status(200).json({
        status: "ok",
        lastSeenAt: updated?.lastSeenAt ?? new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * @openapi
   * /api/agents/{id}:
   *   delete:
   *     summary: Deregister an agent
   *     description: >
   *       Removes an agent from the registry. Requires cryptographic verification of
   *       an Ed25519 signature generated with the agent's registered Stellar secret key.
   *     tags: [Agents]
   *     security:
   *       - AgentSignatureAuth: []
   *       - AgentChallengeAuth: []
   *     operationId: deleteAgent
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *         description: Unique agent identifier
   *         example: "agent_crypto_analyst_01"
   *       - in: header
   *         name: x-signature
   *         required: true
   *         schema: { type: string }
   *         description: Base64-encoded Ed25519 signature of the challenge
   *       - in: header
   *         name: x-challenge
   *         required: true
   *         schema: { type: string }
   *         description: Plaintext challenge string matching the server challenge
   *     responses:
   *       200:
   *         description: Agent deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message: { type: string, example: "Agent deleted successfully" }
   *       401:
   *         description: Missing or invalid signature/challenge
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UnauthorizedError'
   *             example:
   *               error: "Invalid signature"
   *       404:
   *         description: Agent not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/NotFoundError'
   */
  // DELETE /api/agents/:id
  router.delete("/:id", requireWalletAuthMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const correlationId = res.locals.correlationId as string | undefined;
      const db = getDb();
      const agent = db.findById(req.params.id);
      if (!agent) {
        return next(agentNotFound(req.params.id));
      }

      if (agent.stellarPublicKey !== req.user?.sub) {
        throw new UnauthorizedError("Wallet JWT does not own this agent", undefined, correlationId);
      }

      const signature = req.headers["x-signature"] as string | undefined;
      const challenge = req.headers["x-challenge"] as string | undefined;
      if (!signature || !challenge) {
        throw new UnauthorizedError("Missing challenge or signature", undefined, correlationId);
      }

      try {
        const keypair = Keypair.fromPublicKey(agent.stellarPublicKey);
        const isValid = keypair.verify(Buffer.from(challenge), Buffer.from(signature, "base64"));
        if (!isValid) {
          throw new UnauthorizedError("Invalid signature", undefined, correlationId);
        }
      } catch (innerErr) {
        if (innerErr instanceof UnauthorizedError) throw innerErr;
        throw new UnauthorizedError("Invalid signature format", undefined, correlationId);
      }

      db.delete(req.params.id);

      // Await invalidation so deleted agent is not served from cache
      await invalidateAgentsCache().catch(() => {/* best-effort */});

      res.json({ message: "Agent deleted successfully" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const agentsRouter = createAgentsRouter();
export default agentsRouter;
