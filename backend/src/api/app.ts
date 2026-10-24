/**
 * Express application factory.
 *
 * Wires up middleware, routes, the WebSocket task stream, background
 * services (job queue/worker, heartbeat cleanup, metrics), and the global
 * error handler. Called by tests (`opts.disableCompression`, custom
 * dispatch/queue, etc.) and by the server entry-point (`src/index.ts`).
 */

import express, { Request, Response } from "express";
import { createServer, Server as HttpServer } from "http";
import swaggerUi from "swagger-ui-express";

import {
  createTaskJobHandler,
  type DispatchFn,
  type PaymentReleaseFn,
} from "../coordinator/coordinator";
import { httpDispatch } from "../coordinator/dispatch";
import { eventBus } from "../coordinator/eventBus";
import { getTask } from "../coordinator/taskStore";
import { getTaskDb } from "../db/tasks";
import { createPaymentReleaseFn, type StellarReleasePaymentFn } from "../payment";
import { getGlobalJobQueue, JobWorker, type JobQueue } from "../queue";
import { createHeartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat";
import { metricsMiddleware, metricsService } from "../services/metrics";
import type { EventStore } from "../events/eventStore";
import { createEventStore } from "../events/eventStore";
import {
  attachTaskStream,
  getStreamConnectionCount,
  type TaskStreamOptions,
} from "./routes/stream";
import { attachAgentStatusStream } from "./routes/agentStatusStream";
import type { DAGNode } from "../types/task";
import type { AgentRegistry } from "../types/agent";
import { agentsRouter } from "./routes/agents";
import { createAgentDb, getAgentDb } from "../db/agents";
import { excludeBannedAgents } from "../services/adminPlatform";
import { createAgentOnboardingRouter, type AgentOnboardingOptions } from "./routes/agentOnboarding";
import { healthRouter } from "./routes/health";
import { metricsRouter } from "./routes/metrics";
import { createStatsRouter } from "./routes/stats";
import { createReconciliationRouter, type ReconciliationRouterOptions } from "./routes/reconciliation";
import { createPaymentsRouter } from "./routes/payments";
import {
  rateLimitMiddleware,
  registerRateLimitMiddleware,
  publicLimiter,
  authedLimiter,
  adminLimiter,
} from "./middleware/rateLimit";
import { createCorsMiddleware } from "./middleware/cors";
import { compressionMiddleware } from "./middleware/compression";
import { errorHandler } from "./middleware/errorHandler";
import { readOnlyMiddleware } from "./middleware/readOnly";
import { requestId } from "./middleware/requestId";
import { requestLogger } from "./middleware/requestLogger";
import { versioningMiddleware } from "./middleware/versioning";
import { getOpenapiJson, getOpenapiYaml, openapiSpec, swaggerUiOptions } from "./docs";
import { createAdminQueueRouter } from "./routes/admin";
import { createAdminManagementRouter } from "./routes/adminManagement";
import { createEventsRouter } from "./routes/events";
import { createV1TasksRouter } from "./routes/v1/tasks";
import { createV2TasksRouter } from "./routes/v2/tasks";
import { createAuthRouter } from "./routes/auth";
import { createFlagsRouter } from "./routes/flags";
import { createVersionsRouter } from "./routes/versions";
import { createRateLimitRouter } from "./routes/ratelimit";
import { createAdminRouter } from "./routes/admin";
import { type AuthService } from "../services/auth";
import { createLogger } from "../utils/logger";
import { AppError } from "../errors";
import { getConfig } from "../config";

const dispatchLogger = createLogger({ module: "http-dispatch" });

export interface AppOptions {
  dispatch?: DispatchFn;
  releasePayment?: PaymentReleaseFn;
  eventStore?: EventStore;
  stream?: TaskStreamOptions;
  agentRegistry?: AgentRegistry;
  enableHeartbeatCleanup?: boolean;
  heartbeatOptions?: HeartbeatServiceOptions;
  reconciliation?: ReconciliationRouterOptions;
  disableCompression?: boolean;
  queue?: JobQueue;
  jobWorker?: JobWorker;
  /** Custom auth service instance */
  authService?: AuthService;
  /** Soroban registration hook used by the guided agent onboarding flow. */
  agentOnboarding?: AgentOnboardingOptions;
  /** Enable background queue worker (default: true) */
  enableQueueWorker?: boolean;
  /**
   * How long close() waits for in-flight jobs to finish before closing the
   * HTTP/WS server anyway. Default: 10000 (10s). A job still running when
   * this elapses is left in the queue's "active" state — the next worker
   * start (see JobWorker.start()/recoverIncompleteJobs()) resets it to
   * "pending" and retries it, rather than losing the work.
   */
  jobWorkerStopTimeoutMs?: number;
}

function tryLoadStellarRelease(): StellarReleasePaymentFn | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../../smart-contracts/src/payment/payment")
      .releasePayment as StellarReleasePaymentFn;
  } catch {
    return undefined;
  }
}

export function createApp(opts: AppOptions = {}): {
  httpServer: HttpServer;
  close: (callback?: () => void) => void;
} {
  const config = getConfig();
  const logger = createLogger({ module: "api-app" });
  const app = express();
  const httpServer = createServer(app);
  const eventStore: EventStore = opts.eventStore ?? eventBus.store ?? createEventStore();

  if (config.NODE_ENV !== "test") {
    void eventBus.connectRedis(config.REDIS_URL);
  }

  app.use(express.json());
  app.use((_req, res, next) => {
    if (config.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });
  app.use(createCorsMiddleware());
  app.use(requestId);
  app.use(requestLogger);
  app.use(metricsMiddleware);
  app.use(rateLimitMiddleware);
  app.use(versioningMiddleware);
  app.use(
    readOnlyMiddleware({
      exemptPaths: ["/api/admin", "/api/reconciliation"],
    }),
  );

  if (!opts.disableCompression && config.NODE_ENV !== "test") {
    app.use(...compressionMiddleware());
  }

  const dispatch: DispatchFn = opts.dispatch ?? makeHttpDispatch(opts.agentRegistry);
  const releasePayment: PaymentReleaseFn =
    opts.releasePayment ?? createPaymentReleaseFn(tryLoadStellarRelease());

  const jobQueue = opts.queue ?? getGlobalJobQueue();
  const jobWorker =
    opts.jobWorker ??
    new JobWorker({
      jobStore: jobQueue.getStore(),
      handler: createTaskJobHandler(dispatch, releasePayment),
    });
  jobQueue.setWorker(jobWorker);

  if (opts.enableQueueWorker !== false) {
    jobWorker.start();
  }

  const heartbeatService = createHeartbeatService(opts.heartbeatOptions);
  if (
    opts.enableHeartbeatCleanup ||
    (opts.enableHeartbeatCleanup !== false && config.NODE_ENV !== "test")
  ) {
    heartbeatService.start();
  }

  // ── API docs (Swagger UI) ──────────────────────────────────────────────────
  app.get("/docs/swagger.json", (_req: Request, res: Response) => {
    res.json(getOpenapiJson());
  });
  app.get("/docs/swagger.yaml", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/yaml");
    res.send(getOpenapiYaml());
  });
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, swaggerUiOptions),
  );
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openapiSpec);
  });
  app.get("/openapi.yaml", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/yaml");
    res.send(getOpenapiYaml());
  });

  // ── Health routes ───────────────────────────────────────────────────────────
  app.use("/health", publicLimiter.middleware, healthRouter);

  // ── Metrics routes ────────────────────────────────────────────────────────
  app.use("/metrics", metricsRouter);
  app.use("/api/metrics", metricsRouter);

  // ── Stats routes ───────────────────────────────────────────────────────────
  app.use("/api/stats", publicLimiter.middleware, createStatsRouter(getTaskDb()));

  // ── Auth routes ────────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(opts.authService));

  // ── Admin event replay ─────────────────────────────────────────────────────
  app.use("/api/events", adminLimiter.middleware, createEventsRouter(eventStore));

  // ── Agent routes ───────────────────────────────────────────────────────────
  app.use("/api/agents", publicLimiter.middleware);
  app.post("/api/agents/register", registerRateLimitMiddleware);
  app.post("/api/agents/onboarding/start", registerRateLimitMiddleware);
  app.use("/api/agents/onboarding", createAgentOnboardingRouter(opts.agentOnboarding));
  app.use("/api/agents", agentsRouter);

  // ── Task routes ────────────────────────────────────────────────────────────
  const v1TasksRouter = createV1TasksRouter(dispatch, releasePayment, jobQueue);
  const v2TasksRouter = createV2TasksRouter(dispatch, releasePayment, jobQueue);

  app.use("/api/tasks", authedLimiter.middleware, (req, res, next) => {
    const apiVersion = (res.locals.apiVersion as string) || "1.0";
    if (apiVersion.startsWith("1.")) {
      return v1TasksRouter(req, res, next);
    }
    return v2TasksRouter(req, res, next);
  });

  // ── Admin Queue routes ─────────────────────────────────────────────────────
  app.use("/api/admin", createAdminRouter({ queue: jobQueue, reconciliation: opts.reconciliation }));
  app.use("/api/admin/queue", adminLimiter.middleware, createAdminQueueRouter(jobQueue));
  app.use("/api/admin", adminLimiter.middleware, createAdminQueueRouter(jobQueue));

  // ── Feature-flag admin routes (#425) ───────────────────────────────────────
  app.use("/api/admin/flags", createFlagsRouter());

  // ── Admin platform management (#33) ───────────────────────────────────────
  // Mounted after /flags so its catch-all /api/admin mount does not shadow the
  // feature-flag router. All routes enforce the 403 admin-key contract.
  app.use("/api/admin", adminLimiter.middleware, createAdminManagementRouter());

  // ── Versioning lifecycle endpoint (#426) ───────────────────────────────────
  app.use("/api/versions", createVersionsRouter());

  // ── Events and payment history ─────────────────────────────────────────────
  app.use("/api/payments", createPaymentsRouter());

  // ── Payment reconciliation routes ──────────────────────────────────────────
  app.use("/api/reconciliation", createReconciliationRouter(opts.reconciliation));

  // ── Rate-limit status endpoint ─────────────────────────────────────────────
  app.use("/api/ratelimit", publicLimiter.middleware, createRateLimitRouter());

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { message: "Not found", code: "NOT_FOUND" },
      requestId: res.locals.requestId,
      traceId: res.locals.traceId,
    });
  });

  app.use(errorHandler);

  // ── WebSocket task stream ──────────────────────────────────────────────────
  // ── Agent-status broadcast stream (ws://<host>/ws) ─────────────────────────
  // Attached BEFORE the task stream: the task-stream upgrade handler destroys
  // sockets for paths it doesn't own, so /ws must be claimed first.
  const detachAgentStatusStream = attachAgentStatusStream(httpServer, {
    eventBus,
    heartbeatIntervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: config.WS_PONG_TIMEOUT_MS,
    getAgentSnapshot: () => {
      try {
        return createAgentDb(getAgentDb()).list().map((agent) => ({
          id: agent.id,
          capabilities: agent.capabilities,
          status: agent.status,
          lastSeenAt: agent.lastSeenAt,
        }));
      } catch {
        return [];
      }
    },
  });

  const detachStream = attachTaskStream({
    httpServer,
    eventStore,
    eventBus,
    getTask,
    heartbeatIntervalMs: config.WS_HEARTBEAT_INTERVAL_MS,
    pongTimeoutMs: config.WS_PONG_TIMEOUT_MS,
    inactivityTimeoutMs: config.WS_INACTIVITY_TIMEOUT_MS,
    ...opts.stream,
  });

  metricsService.startGcObserver();
  metricsService.setWebSocketProbe(() => ({
    listening: httpServer.listening,
    connections: getStreamConnectionCount(),
  }));

  function close(callback?: () => void): void {
    jobWorker.stop(opts.jobWorkerStopTimeoutMs ?? 10_000).finally(() => {
      heartbeatService.stop();
      eventBus.disconnectRedis();
      metricsService.setWebSocketProbe(null);
      detachAgentStatusStream();
      detachStream();
      if (httpServer.listening) {
        httpServer.close(callback);
      } else if (callback) {
        callback();
      }
    });
  }

  const routeCount = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack?.length;
  logger.debug({ routeCount }, "api app initialized");
  return { httpServer, close };
}

/**
 * Build a DispatchFn that looks up the cheapest agent for a node's type in the
 * provided registry and forwards the call to that agent via HTTP.
 */
function makeHttpDispatch(registry?: AgentRegistry): DispatchFn {
  return async (_taskId: string, node: DAGNode, context: string): Promise<unknown> => {
    if (!registry) {
      throw new Error(
        "No agent registry configured. Provide agentRegistry in AppOptions or supply a custom dispatch function.",
      );
    }

    const agents = await registry.getAgents(node.type);
    if (!agents || agents.length === 0) {
      throw new AppError(`No agent registered for type: ${node.type}`, 500, "AGENT_NOT_FOUND");
    }

    // Admin-banned agents are excluded from all new task assignments (#33).
    const eligible = excludeBannedAgents(agents);
    if (eligible.length === 0) {
      throw new AppError(
        `All agents for type ${node.type} are banned`,
        503,
        "NO_ELIGIBLE_AGENT",
      );
    }

    const agent = [...eligible].sort((a, b) => a.cost - b.cost)[0];
    return httpDispatch(agent, node.nodeId, node, context);
  };
}
