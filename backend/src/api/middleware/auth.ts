import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config/index';
import { getAuthService } from '../../services/auth';
import type { AccessTokenPayload } from '../../services/auth/tokenService';

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

function loadKeys(): Set<string> | null {
  const raw = getConfig().API_KEYS;
  if (!raw) return null;
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

/**
 * General auth middleware.
 * Supports session access tokens and static API keys.
 * If API_KEYS is unset and no token is passed, it passes through (backward compatibility).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const keys = loadKeys();
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (token) {
    try {
      const payload = getAuthService().verifyAccessToken(token);
      req.user = payload;
      return next();
    } catch {
      if (keys && keys.has(token)) {
        return next();
      }

      if (keys) {
        const error = new Error("Unauthorized") as Error & { statusCode?: number };
        error.statusCode = 401;
        return next(error);
      }

      res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
      return;
    }
  }

  if (!keys) {
    return next();
  }

  const error = new Error("Unauthorized") as Error & { statusCode?: number };
  error.statusCode = 401;
  return next(error);
}

export const sessionAuthMiddleware = authMiddleware;

export function requireWalletAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.headers["authorization"] ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Unauthorized", message: "Bearer JWT required" });
    return;
  }
  try {
    req.user = getAuthService().verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}

/**
 * Optional session auth middleware: extracts user token if present without rejecting unauthenticated requests.
 */
export function optionalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (token) {
    try {
      req.user = getAuthService().verifyAccessToken(token);
    } catch {
      // Ignore errors for optional authentication
    }
  }

  next();
}

/**
 * Resolve the configured admin API key.
 *
 * Reads only the validated config so admin secrets have one source of truth.
 */
export function resolveAdminApiKey(): string | undefined {
  let fromConfig: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fromConfig = (require("../../config") as typeof import("../../config")).getConfig()
      .ADMIN_API_KEY;
  } catch {
    // Config not loaded — fall through to the environment.
  }
  const key = fromConfig ?? process.env.ADMIN_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

/** Constant-time string comparison; length differences short-circuit safely. */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Extract the presented admin key from either supported header. */
function readPresentedKey(req: Request): string {
  const header = req.headers["x-admin-api-key"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader.trim();

  const auth = req.headers["authorization"] ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/**
 * Guard admin-only endpoints with a shared secret.
 *
 * Accepts `X-Admin-API-Key: <key>` or `Authorization: Bearer <key>`. Unlike
 * {@link authMiddleware}, this middleware **fails closed**: when
 * `ADMIN_API_KEY` is not configured the endpoint still responds 403, so an
 * unconfigured deployment never exposes admin data anonymously.
 *
 * Per the admin API contract, every unauthorized response (missing key,
 * invalid key, or unconfigured server) is a 403 so callers cannot probe
 * whether the admin surface exists.
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = resolveAdminApiKey();
  const auth = req.headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (bearer.split(".").length === 3) {
    try {
      const payload = getAuthService().verifyAccessToken(bearer);
      req.user = payload;
      const scopes = Array.isArray(payload.scope)
        ? payload.scope
        : (payload.scope ?? "").split(/\s+/).filter(Boolean);
      if (scopes.includes("admin")) {
        next();
        return;
      }
      res.status(403).json({ error: "Forbidden", message: "Admin scope required" });
      return;
    } catch {
      if (!expected) {
        res.status(503).json({
          error: "Admin API not configured",
          message: "Set ADMIN_API_KEY to enable admin endpoints.",
        });
        return;
      }
    }
  }

  if (!expected) {
    res.status(403).json({
      error: "Forbidden",
      message: "Admin API not configured. Set ADMIN_API_KEY to enable admin endpoints.",
    });
    return;
  }

  const presented = req.headers["x-admin-api-key"]
    ? readPresentedKey(req)
    : bearer;
  if (!presented || !timingSafeEquals(presented, expected)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
