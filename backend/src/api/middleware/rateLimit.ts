import { LRUCache } from "lru-cache";
import type { Request, Response, NextFunction } from "express";
import { getConfig } from "../../config";

/** Internal sliding-window state per tracked IP. */
interface SlidingWindow {
  timestamps: number[];
}

export interface RateLimitOptions {
  /** Rolling window in milliseconds. Default: 60 000 (1 minute). */
  windowMs?: number;
  /** Maximum number of requests allowed within the window. Default: 20. */
  maxRequests?: number;
  /**
   * Maximum number of distinct IPs tracked simultaneously per limiter instance.
   * When the limit is reached the least-recently-used IP is evicted on the
   * next accepted request. Defaults to 10 000 (issue #154).
   */
  maxEntries?: number;
}

export interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Fully clears tracked state. Kept for API compatibility and graceful
   * shutdown hooks.
   */
  stop: () => void;
  /**
   * Current number of tracked IPs. Exposed for tests and operational
   * debugging — not part of the rate-limiting contract.
   * @internal
   */
  size: () => number;
}

/**
 * Attach standard rate-limit headers to the response.
 *
 * Headers emitted on **every** response so clients can track their quota
 * without waiting for a 429:
 *  - `X-RateLimit-Limit`     — max requests allowed per window
 *  - `X-RateLimit-Remaining` — requests remaining in the current window
 *  - `X-RateLimit-Reset`     — Unix timestamp (seconds) when the window resets
 *
 * On 429 responses `Retry-After` is also set (seconds until reset).
 */
function setRateLimitHeaders(
  res: Response,
  limit: number,
  remaining: number,
  resetAtMs: number,
): void {
  const resetSec = Math.ceil(resetAtMs / 1000);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-RateLimit-Reset", String(resetSec));
}

/**
 * Extract a rate-limit key from the request.
 *
 * For authenticated routes we key by wallet address so that a single wallet
 * cannot circumvent limits by rotating IP addresses (e.g. when behind a NAT
 * or load balancer). For unauthenticated routes we fall back to the client IP.
 *
 * Wallet address is read from the `walletpublickey` request header, which is
 * the convention already used by the rest of the codebase (task routes,
 * idempotency middleware, etc.).
 */
export function extractRateLimitKey(req: Request, useWallet = false): string {
  if (useWallet) {
    const walletKey = req.headers["walletpublickey"];
    if (typeof walletKey === "string" && walletKey.trim().length > 0) {
      return `wallet:${walletKey.trim()}`;
    }
  }
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Create a configurable in-memory sliding-window rate limiter.
 *
 * Backing store is `lru-cache`, which provides:
 *  - a hard cap on entry count (`maxEntries`) bounding memory under IP/wallet floods
 *    (issue #154); and
 *  - TTL-based eviction so quiet keys drop out automatically.
 *
 * Standard rate-limit headers are emitted on every response so clients can
 * proactively back off rather than only learning about limits on 429.
 *
 * @param opts          Configuration options (see RateLimitOptions).
 * @param useWalletKey  When true the limiter keys by wallet address extracted
 *                      from the `walletpublickey` header, falling back to IP.
 *                      Defaults to false (IP-only keying).
 */
export function createRateLimiter(opts: RateLimitOptions = {}, useWalletKey = false): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 20;
  const maxEntries = opts.maxEntries ?? 10_000;

  const windows = new LRUCache<string, SlidingWindow>({
    max: maxEntries,
    ttl: windowMs,
    // Don't refresh age on read: a 429 must not let stale keys linger.
    updateAgeOnGet: false,
  });

  function middleware(req: Request, res: Response, next: NextFunction): void {
    // Key by wallet (when configured) so rotating IPs cannot bypass the
    // limit; otherwise by IP. NOTE: req.ip depends on Express's `trust proxy`
    // setting. Until trust proxy is configured every untrusted request
    // collapses to "unknown", making this effectively a global cap.
    const key = extractRateLimitKey(req, useWalletKey);
    const now = Date.now();
    const cutoff = now - windowMs;

    let win = windows.get(key) ?? { timestamps: [] };
    win.timestamps = win.timestamps.filter((t: number) => t > cutoff);

    const oldest = win.timestamps[0];
    const resetAtMs = oldest !== undefined ? oldest + windowMs : now + windowMs;
    const remaining = maxRequests - win.timestamps.length;

    if (win.timestamps.length >= maxRequests) {
      const retryAfter = Math.ceil((resetAtMs - now) / 1000);
      setRateLimitHeaders(res, maxRequests, 0, resetAtMs);
      res.setHeader("Retry-After", String(retryAfter));
      res
        .status(429)
        .json({ error: { message: "Too many requests", code: "RATE_LIMIT_EXCEEDED" } });
      return;
    }

    win.timestamps.push(now);
    windows.set(key, win);

    // Emit headers on every allowed response so clients can track quota.
    setRateLimitHeaders(res, maxRequests, remaining - 1, resetAtMs);

    next();
  }

  return {
    middleware,
    stop() {
      windows.clear();
    },
    size() {
      return windows.size;
    },
  };
}

// ── Route-group limiters ─────────────────────────────────────────────────────
//
// Four groups with distinct limits, all configurable via env vars:
//
//   public      — unauthenticated endpoints (/api/stats, /api/agents GET, /health)
//   authed      — authenticated task creation (/api/tasks), keyed per wallet
//   admin       — admin-only endpoints (/api/admin/*)
//   veniceProxy — endpoints that invoke the Venice AI API, keyed per wallet
//
// Limits are intentionally conservative; operators should tune via env.

function readEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readEnvWindowMs(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Lazily-created group limiters.  Using factory functions so tests can reset
 * process.env before the limiter is instantiated.
 */
export function createPublicLimiter(): RateLimiter {
  return createRateLimiter({
    windowMs: readEnvWindowMs("RATE_LIMIT_PUBLIC_WINDOW_MS", 60_000),
    maxRequests: readEnvInt("RATE_LIMIT_PUBLIC_MAX_REQUESTS", 100),
  });
}

export function createAuthedLimiter(): RateLimiter {
  return createRateLimiter(
    {
      windowMs: readEnvWindowMs("RATE_LIMIT_AUTHED_WINDOW_MS", 60_000),
      maxRequests: readEnvInt("RATE_LIMIT_AUTHED_MAX_REQUESTS", 30),
    },
    true, // keyed by wallet address
  );
}

export function createAdminLimiter(): RateLimiter {
  return createRateLimiter({
    windowMs: readEnvWindowMs("RATE_LIMIT_ADMIN_WINDOW_MS", 60_000),
    maxRequests: readEnvInt("RATE_LIMIT_ADMIN_MAX_REQUESTS", 20),
  });
}

/**
 * Venice AI proxy routes: strict limit to respect upstream API quotas.
 * 10 req/min per wallet address (configurable via RATE_LIMIT_VENICE_PROXY_*).
 *
 * Apply this in front of any endpoint that ultimately invokes the Venice AI
 * inference API (task creation, agent execution).  Keeping this low prevents
 * a single wallet from exhausting the shared Venice quota.
 */
export function createVeniceProxyLimiter(): RateLimiter {
  return createRateLimiter(
    {
      windowMs: readEnvWindowMs("RATE_LIMIT_VENICE_PROXY_WINDOW_MS", 60_000),
      maxRequests: readEnvInt("RATE_LIMIT_VENICE_PROXY_MAX_REQUESTS", 10),
    },
    true, // keyed by wallet address
  );
}

// ── Module-level singleton instances ─────────────────────────────────────────

/** Public routes: generous limit for read-heavy unauthenticated traffic. */
export const publicLimiter = createPublicLimiter();

/** Authenticated routes: tighter limit for task creation, per wallet. */
export const authedLimiter = createAuthedLimiter();

/** Admin routes: conservative limit for privileged operations. */
export const adminLimiter = createAdminLimiter();

/** Venice AI proxy routes: strict per-wallet limit protecting upstream quotas. */
export const veniceProxyLimiter = createVeniceProxyLimiter();

// ── Legacy named exports (kept for backward compatibility) ───────────────────

/**
 * Default rate limiter used by POST /api/tasks.
 * 20 requests per minute per IP.
 */
let defaultLimiter: RateLimiter | null = null;

function getDefaultLimiter(): RateLimiter {
  if (!defaultLimiter) {
    const config = getConfig();
    defaultLimiter = createRateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
    });
  }
  return defaultLimiter;
}

export function getRateLimiter(): RateLimiter {
  return getDefaultLimiter();
}

export const rateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => getDefaultLimiter().middleware(req, res, next);

/**
 * Stricter rate limiter used by POST /api/agents/register.
 * 10 requests per minute per IP — registration is an expensive operation.
 */
let registerLimiter: RateLimiter | null = null;

function getRegisterLimiter(): RateLimiter {
  if (!registerLimiter) {
    const config = getConfig();
    registerLimiter = createRateLimiter({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      maxRequests: config.REGISTER_RATE_LIMIT_MAX_REQUESTS,
    });
  }
  return registerLimiter;
}

export const registerRateLimitMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => getRegisterLimiter().middleware(req, res, next);

/**
 * Rate limiter used by POST /api/agents/:id/heartbeat.
 * 60 requests per minute per IP to allow periodic agent pings while preventing abuse.
 */
const heartbeatLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
export const heartbeatRateLimitMiddleware = heartbeatLimiter.middleware;

/**
 * Reset all module-level singleton rate-limiter instances.
 *
 * **For test use only.** Clears every tracked window so tests that create
 * multiple server instances sharing the same module-level singletons don't
 * bleed rate-limit state across describe blocks.
 */
export function resetRateLimitersForTest(): void {
  if (defaultLimiter) {
    defaultLimiter.stop();
    defaultLimiter = null;
  }
  if (registerLimiter) {
    registerLimiter.stop();
    registerLimiter = null;
  }
  publicLimiter.stop();
  authedLimiter.stop();
  adminLimiter.stop();
  veniceProxyLimiter.stop();
  heartbeatLimiter.stop();
}
