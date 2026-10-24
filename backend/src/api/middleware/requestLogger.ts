import type { Request, Response, NextFunction } from "express";
import {
  createLogger,
  hashLogIdentifier,
  runWithLogContext,
  updateLogContext,
} from "../../utils/logger";

const REDACTED_WALLET = "[REDACTED_WALLET]";

// Stellar wallet address pattern: starts with G/C/M followed by 55 Base32 chars
const STELLAR_ADDRESS_RE = /\b[GCM][A-Z2-7]{55}\b/g;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Redact a wallet address for safe log emission (Issue #404).
 * Returns a hash-prefixed placeholder so logs remain correlatable
 * without leaking the full public key.
 */
function redactWallet(wallet: string): string {
  return `${REDACTED_WALLET}_${hashLogIdentifier(wallet)}`;
}

/**
 * Extract and redact a wallet identifier from the request (Issue #404).
 * Returns a hashed placeholder for correlation without exposing the address.
 */
function deriveUserWallet(req: Request): string | undefined {
  const raw =
    firstHeader(req.headers["walletpublickey"] as string | string[] | undefined) ??
    (typeof req.body?.walletPublicKey === "string" ? req.body.walletPublicKey : undefined);

  if (!raw) return undefined;
  // Validate it looks like a Stellar address before redacting
  if (STELLAR_ADDRESS_RE.test(raw)) {
    STELLAR_ADDRESS_RE.lastIndex = 0;
    return redactWallet(raw);
  }
  STELLAR_ADDRESS_RE.lastIndex = 0;
  // Still hash any wallet-looking value
  return redactWallet(raw);
}

function deriveUserId(req: Request): string {
  const rawUser =
    firstHeader(req.headers["x-user-id"] as string | string[] | undefined) ??
    firstHeader(req.headers["walletpublickey"] as string | string[] | undefined) ??
    (typeof req.body?.walletPublicKey === "string" ? req.body.walletPublicKey : undefined);

  return rawUser ? `usr_${hashLogIdentifier(rawUser)}` : "anonymous";
}

function deriveTaskId(req: Request): string | undefined {
  if (typeof req.params?.taskId === "string") return req.params.taskId;
  if (req.path.startsWith("/api/tasks/") && typeof req.params?.id === "string") {
    return req.params.id;
  }
  const path = req.originalUrl?.split("?")[0] ?? req.path;
  const taskPathMatch = path.match(/^\/api\/tasks\/([^/]+)/);
  if (taskPathMatch?.[1]) return taskPathMatch[1];
  if (typeof req.body?.taskId === "string") return req.body.taskId;
  return undefined;
}

function deriveRoute(req: Request): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : undefined;
  if (routePath) {
    return `${req.baseUrl}${routePath}`;
  }
  return req.originalUrl?.split("?")[0] ?? req.path;
}

function buildLogContext(req: Request, res: Response): Record<string, unknown> {
  const context: Record<string, unknown> = {
    requestId: res.locals.requestId ?? req.requestId,
    traceId: res.locals.traceId ?? res.locals.correlationId ?? req.traceId ?? req.correlationId,
    userId: deriveUserId(req),
    taskId: deriveTaskId(req) ?? "none",
    route: deriveRoute(req),
    // endpoint: method + normalized path (Issue #404)
    endpoint: `${req.method} ${deriveRoute(req)}`,
  };

  // Attach redacted wallet for PII-safe correlation (Issue #404)
  const wallet = deriveUserWallet(req);
  if (wallet) {
    context.user_wallet = wallet;
  }

  return context;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  runWithLogContext(buildLogContext(req, res), () => {
    res.locals.logContext = buildLogContext(req, res);

    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const logContext = buildLogContext(req, res);
      res.locals.logContext = logContext;
      updateLogContext(logContext);

      createLogger().info(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs,
          ip: req.ip,
        },
        "request completed",
      );
    });

    next();
  });
}
