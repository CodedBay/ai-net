import { Router, Request, Response, RequestHandler } from "express";
import { getConfig } from "../../config";
import { adminAuthMiddleware } from "../middleware/auth";
import { metricsService } from "../../services/metrics";
import { tracingService } from "../../services/tracing";

const router = Router();
const startTime = Date.now();

/**
 * Set to true by the graceful shutdown handler before closing connections.
 * When draining, `GET /health` returns `{ status: "draining" }` so load
 * balancers know to stop sending new traffic.
 */
let _isDraining = false;

/** Mark the server as entering the drain window (called by shutdown handler). */
export function setDraining(value: boolean): void {
  _isDraining = value;
}

/** Returns true when the server is in the drain window. */
export function isDraining(): boolean {
  return _isDraining;
}

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Basic liveness check
 *     operationId: getHealth
 *     description: Returns process uptime, version, and Stellar network name. No external dependency checks.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is up
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
const livenessHandler: RequestHandler = (_req: Request, res: Response) => {
  const config = getConfig();
  if (_isDraining) {
    // During shutdown: return 503 so load balancers stop sending new traffic,
    // while the drain window allows in-flight requests to finish.
    res.status(503).json({
      status: "draining",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: config.NPM_PACKAGE_VERSION,
      stellarNetwork: config.STELLAR_NETWORK,
    });
    return;
  }
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: config.NPM_PACKAGE_VERSION,
    stellarNetwork: config.STELLAR_NETWORK,
  });
};

router.get("/", livenessHandler);

/**
 * @openapi
 * /health/live:
 *   get:
 *     summary: Basic liveness check
 *     operationId: getLive
 *     description: Alias for `GET /health` — process-only liveness, no dependency checks.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Service is up
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
router.get("/live", livenessHandler);

/**
 * @openapi
 * /health/deep:
 *   get:
 *     summary: Deep dependency health check
 *     operationId: getDeepHealth
 *     description: >
 *       Probes external dependencies (Venice AI, Stellar Horizon) and reports
 *       their individual status. Always returns 200 — dependency degradation
 *       is reported in the body (`status: "degraded"`) rather than as an HTTP
 *       failure, so diagnostic consumers can read full details. Readiness for
 *       traffic lives on `/health/ready`.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Dependency status report (ok or degraded)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status, services]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok, degraded]
 *                   example: degraded
 *                 services:
 *                   type: object
 *                   properties:
 *                     venice: { type: string, enum: [ok, error, unknown], example: error }
 *                     horizon: { type: string, enum: [ok, error, unknown], example: ok }
 *                 venice: { type: string, enum: [ok, error, unknown], example: error }
 *                 horizon: { type: string, enum: [ok, error, unknown], example: ok }
 */
router.get("/deep", async (_req: Request, res: Response) => {
  const config = getConfig();
  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY),
    checkHorizon(config.STELLAR_HORIZON_URL),
  ]);

  const allOk = veniceStatus === "ok" && horizonStatus === "ok";
  // Deep health is a diagnostic report, not a readiness gate: always 200 so
  // degraded dependencies surface in the body (`status: "degraded"`) without
  // being treated as an outage. Readiness lives on /health/ready.
  res.status(200).json({
    status: allOk ? "ok" : "degraded",
    services: {
      venice: veniceStatus,
      horizon: horizonStatus,
    },
    venice: veniceStatus,
    horizon: horizonStatus,
  });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     summary: Readiness probe
 *     operationId: getReady
 *     description: >
 *       Returns 200 when every dependency check passes (task DB, payment DB,
 *       queue, Venice AI, Horizon, WebSocket server) and 500 otherwise, so
 *       orchestrators can gate traffic on readiness.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: All dependencies ready
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 *       500:
 *         description: One or more dependencies failing
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReadinessStatus'
 */
router.get("/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, "ok" | "error" | "unknown"> = {
    tasks: "ok",
    payments: "ok",
    queue: "ok",
    venice: "ok",
    horizon: "ok",
    websocket: "ok",
  };

  try {
    const tasksModule = await import("../../db/tasks.js");
    const paymentsModule = await import("../../db/index.js");
    const queueModule = await import("../../queue/jobStore.js");

    try {
      const taskDb = (tasksModule.getTaskDb as Function)();
      taskDb.prepare("SELECT 1").get();
    } catch {
      checks.tasks = "error";
    } finally {
      (tasksModule.closeTaskDb as Function)();
    }

    try {
      const paymentDb = (paymentsModule.getDb as Function)();
      paymentDb.prepare("SELECT 1").get();
    } catch {
      checks.payments = "error";
    } finally {
      (paymentsModule.closeDb as Function)();
    }

    try {
      const jobDb = (queueModule.getJobDb as Function)();
      jobDb.prepare("SELECT 1").get();
    } catch (error) {
      (checks as any).queue = "error";
    } finally {
      (queueModule.closeJobDb as Function)();
    }
  } catch (error) {
    res.status(500).json({ status: "error", checks, error: String(error) });
    return;
  }

  const config = getConfig();
  const timeoutMs = config.HEALTH_PROBE_TIMEOUT_MS;
  const [veniceStatus, horizonStatus] = await Promise.all([
    checkVenice(config.VENICE_API_KEY, timeoutMs),
    checkHorizon(config.STELLAR_HORIZON_URL, timeoutMs),
  ]);
  checks.venice = veniceStatus === "ok" ? "ok" : "error";
  checks.horizon = horizonStatus === "ok" ? "ok" : "error";

  const websocketStatus = metricsService.getWebSocketStatus();
  checks.websocket =
    websocketStatus.status === "unknown"
      ? "unknown"
      : websocketStatus.status === "ok"
        ? "ok"
        : "error";

  // A missing WebSocket probe ("unknown") is a valid configuration — the
  // stream layer may simply not be attached — so it alone does not fail
  // readiness. A probe that *is* attached and reports "error" (not
  // listening) does, same as every other dependency.
  const failing = Object.values(checks).filter((status) => status === "error");
  const ready = failing.length === 0;
  res.status(ready ? 200 : 500).json({ status: ready ? "ok" : "error", checks });
});

router.get("/dashboard", adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const dashboard = await metricsService.getDashboard(req.query.refresh === "true");
    res.json(dashboard);
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: "Failed to collect metrics",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/traces/:traceId", (req: Request, res: Response) => {
  const trace = tracingService.getTrace(req.params.traceId);
  if (!trace) {
    res.status(404).json({
      error: "Trace not found",
      traceId: req.params.traceId,
      correlationId: req.params.traceId,
    });
    return;
  }
  res.json(trace);
});

async function checkVenice(apiKey: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch("https://api.venice.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok || response.status === 401 ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

async function checkHorizon(url: string, timeoutMs = 5000): Promise<"ok" | "unreachable"> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok ? "ok" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export { router as healthRouter };
export default router;
