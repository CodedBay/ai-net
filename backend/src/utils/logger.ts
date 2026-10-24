import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";
import type { DestinationStream, Logger } from "pino";
import { getConfig } from "../config";
import { currentTraceContext } from '../services/traceContext';

// ── Module-level log level overrides (Issue #404) ────────────────────────────
// Reads LOG_LEVEL_<MODULE> env vars at first use to allow per-module verbosity.
// e.g. LOG_LEVEL_WORKER=debug, LOG_LEVEL_AGENTCLEANUP=trace
const moduleLogLevelCache = new Map<string, pino.LevelWithSilent>();

function getModuleLogLevel(module: string): pino.LevelWithSilent | null {
  const cacheKey = module.toUpperCase();
  if (moduleLogLevelCache.has(cacheKey)) {
    return moduleLogLevelCache.get(cacheKey)!;
  }
  const envKey = `LOG_LEVEL_${cacheKey.replace(/[^A-Z0-9]/g, '_')}`;
  const envVal = process.env[envKey];
  if (envVal && ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(envVal)) {
    const level = envVal as pino.LevelWithSilent;
    moduleLogLevelCache.set(cacheKey, level);
    return level;
  }
  moduleLogLevelCache.set(cacheKey, null as unknown as pino.LevelWithSilent);
  return null;
}

// ── PII redaction patterns (Issue #404) ─────────────────────────────────────
// JWT token regex: header.payload.signature (base64url-encoded parts)
const JWT_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g;

const REDACTED = "[REDACTED]";
const REDACTED_ADDRESS = "[REDACTED_ADDRESS]";
const DEFAULT_LOG_CONTEXT = {
  service: "ai-net-backend",
  requestId: "system",
  traceId: "system",
  spanId: "system",
  userId: "system",
  taskId: "none",
  route: "system",
};
const logContextStore = new AsyncLocalStorage<Record<string, unknown>>();
/** A captured error/fatal log line, surfaced by `GET /api/admin/logs`. */
export interface ErrorLogEntry {
  level: "error" | "fatal";
  message: string;
  timestamp: string;
  service?: string;
  requestId?: string;
  traceId?: string;
  taskId?: string;
  route?: string;
  error?: { name?: string; message?: string; stack?: string; code?: string };
}

const MAX_ERROR_LOG_ENTRIES = 200;
const errorLogRing: ErrorLogEntry[] = [];

/** Most recent error/fatal entries, newest first. */
export function getRecentErrorLogs(limit = 100): ErrorLogEntry[] {
  const capped = Math.max(1, Math.min(Math.trunc(limit), MAX_ERROR_LOG_ENTRIES));
  return errorLogRing.slice(-capped).reverse();
}

/** Test helper — drops buffered entries so suites stay isolated. */
export function clearErrorLogRing(): void {
  errorLogRing.length = 0;
}

function recordErrorLog(
  level: number,
  fields: Record<string, unknown>,
  message: string | undefined,
): void {
  try {
    const rawError = fields.err;
    const errorObject =
      rawError && typeof rawError === "object"
        ? (rawError as Record<string, unknown>)
        : undefined;
    const entry: ErrorLogEntry = {
      level: level >= 60 ? "fatal" : "error",
      message:
        message ??
        (typeof errorObject?.message === "string" ? errorObject.message : "(no message)"),
      timestamp: new Date().toISOString(),
      service: typeof fields.service === "string" ? fields.service : undefined,
      requestId: typeof fields.requestId === "string" ? fields.requestId : undefined,
      traceId: typeof fields.traceId === "string" ? fields.traceId : undefined,
      taskId: fields.taskId !== undefined && fields.taskId !== "none"
        ? String(fields.taskId)
        : undefined,
      route: typeof fields.route === "string" ? fields.route : undefined,
      error: errorObject
        ? {
            name: typeof errorObject.name === "string" ? errorObject.name : "Error",
            message:
              typeof errorObject.message === "string" ? errorObject.message : undefined,
            stack:
              typeof errorObject.stack === "string"
                ? errorObject.stack.slice(0, 2_000)
                : undefined,
            code:
              errorObject.code !== undefined ? String(errorObject.code) : undefined,
          }
        : undefined,
    };
    errorLogRing.push(entry);
    if (errorLogRing.length > MAX_ERROR_LOG_ENTRIES) {
      errorLogRing.splice(0, errorLogRing.length - MAX_ERROR_LOG_ENTRIES);
    }
  } catch {
    // Logging must never throw.
  }
}


const SECRET_KEY_RE =
  /secret|token|jwt|api[_-]?key|password|authorization|cookie|private[_-]?key|seed/i;
const ADDRESS_KEY_RE =
  /address|public[_-]?key|wallet|owner|claimant|destination|source|account/i;
const STELLAR_ADDRESS_RE = /\b[CGM][A-Z2-7]{55}\b/g;
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE_SECRET_RE =
  /\b(api[_-]?key|token|secret|password|authorization)=([^\s"',}]+)/gi;

export interface LoggerFactoryOptions {
  destination?: DestinationStream;
  redactPaths?: string[];
}

function matchesRedactionPath(path: string, paths: readonly string[]): boolean {
  const segments = path.split(".");
  return paths.some((redactionPath) => {
    const pattern = redactionPath.split(".");
    return (
      pattern.length === segments.length &&
      pattern.every((segment, index) => segment === "*" || segment === segments[index])
    );
  });
}

function redactString(value: string): string {
  return value
    .replace(STELLAR_SECRET_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE_SECRET_RE, (_match, key) => `${key}=${REDACTED}`)
    .replace(STELLAR_ADDRESS_RE, REDACTED_ADDRESS)
    .replace(JWT_RE, REDACTED);
}

function redactByKey(key: string | undefined, value: unknown): unknown {
  if (!key) return value;
  if (SECRET_KEY_RE.test(key)) {
    return value ? REDACTED : value;
  }
  if (ADDRESS_KEY_RE.test(key)) {
    if (typeof value === "string") return redactString(value) === value ? REDACTED_ADDRESS : redactString(value);
    return value ? REDACTED_ADDRESS : value;
  }
  return value;
}

function serializeError(error: Error): Record<string, unknown> {
  const maybeCoded = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    details?: unknown;
  };

  return sanitizeLogPayload({
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: maybeCoded.code,
    status: maybeCoded.status,
    statusCode: maybeCoded.statusCode,
    details: maybeCoded.details,
  }) as Record<string, unknown>;
}

export function sanitizeLogPayload(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
  path = "",
  redactPaths: readonly string[] = [],
): unknown {
  if (path && matchesRedactionPath(path, redactPaths)) {
    return value ? REDACTED : value;
  }
  const keyed = redactByKey(key, value);
  if (keyed !== value) return keyed;

  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeLogPayload(entry, key, seen, path ? `${path}.${index}` : String(index), redactPaths),
    );
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    output[childKey] = sanitizeLogPayload(
      childValue,
      childKey,
      seen,
      path ? `${path}.${childKey}` : childKey,
      redactPaths,
    );
  }
  return output;
}

export function hashLogIdentifier(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeBindings(bindings?: Record<string, unknown>): Record<string, unknown> {
  const sanitized = (sanitizeLogPayload(bindings ?? {}) ?? {}) as Record<string, unknown>;
  const traceId = sanitized.traceId ?? sanitized.correlationId ?? DEFAULT_LOG_CONTEXT.traceId;

  return {
    ...DEFAULT_LOG_CONTEXT,
    ...sanitized,
    traceId,
    requestId: sanitized.requestId ?? DEFAULT_LOG_CONTEXT.requestId,
  };
}

export function runWithLogContext<T>(context: Record<string, unknown>, callback: () => T): T {
  return logContextStore.run(normalizeBindings(context), callback);
}

export function updateLogContext(context: Record<string, unknown>): void {
  const store = logContextStore.getStore();
  if (!store) return;
  Object.assign(store, normalizeBindings({ ...store, ...context }));
}

export function getLogContext(): Record<string, unknown> {
  return logContextStore.getStore() ?? DEFAULT_LOG_CONTEXT;
}

function createBaseLogger(destination?: DestinationStream, redactPaths: readonly string[] = []): Logger {
  let level: pino.LevelWithSilent = "info";
  try {
    level = getConfig().LOG_LEVEL;
  } catch {
    // Startup calls loadConfig() explicitly and reports schema issues.
  }
  const options: pino.LoggerOptions = {
    level,
    enabled: level !== "silent",
    base: DEFAULT_LOG_CONTEXT,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    messageKey: "message",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    // Auto-inject traceId / spanId from the active AsyncLocalStorage trace
    // context (Issue #407) so every log line in a traced flow carries the
    // correlation IDs without the caller having to pass them explicitly.
    mixin() {
      const ctx = currentTraceContext();
      if (!ctx) return {};
      const bindings: Record<string, unknown> = { traceId: ctx.traceId, spanId: ctx.spanId };
      if (ctx.taskId) bindings.taskId = ctx.taskId;
      if (ctx.requestId) bindings.requestId = ctx.requestId;
      return bindings;
    },
    hooks: {
      logMethod(inputArgs, method) {
        const currentLogger = this as Logger & {
          bindings?: () => Record<string, unknown>;
        };
        const loggerBindings =
          typeof currentLogger.bindings === "function" ? currentLogger.bindings() : {};
        const activeContext = logContextStore.getStore();
        const context = normalizeBindings(
          activeContext ? { ...loggerBindings, ...activeContext } : loggerBindings,
        );
        const sanitizedArgs = inputArgs.map((arg) =>
          sanitizeLogPayload(arg, undefined, new WeakSet<object>(), "", redactPaths),
        );
        const first = sanitizedArgs[0];
        if (
          first &&
          typeof first === "object" &&
          !Array.isArray(first) &&
          !(first instanceof Error)
        ) {
          const fields = first as Record<string, unknown>;
          sanitizedArgs[0] = {
            ...context,
            ...fields,
            context: { ...context, ...fields },
          };
        } else {
          sanitizedArgs.unshift({ ...context, context });
        }

        return method.apply(this, sanitizedArgs as any);
      },
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

/** Capture error/fatal calls even when the pino level is `silent`. */
function captureError(level: number, args: unknown[]): void {
  try {
    const sanitized = args.map((arg) =>
      sanitizeLogPayload(arg, undefined, new WeakSet<object>(), "", []),
    );
    const fields = sanitized.find(
      (arg): arg is Record<string, unknown> =>
        Boolean(arg) && typeof arg === "object" && !Array.isArray(arg),
    ) ?? {};
    const message = [...sanitized]
      .reverse()
      .find((arg): arg is string => typeof arg === "string");
    recordErrorLog(level, fields, message);
  } catch {
    // Never let observability break logging.
  }
}

function withErrorCapture(logger: Logger): Logger {
  const wrapped = logger as Logger & Record<string, unknown>;
  for (const [level, method] of [[50, "error"], [60, "fatal"]] as const) {
    const original = (logger[method] as (...args: unknown[]) => unknown).bind(logger);
    wrapped[method] = (...args: unknown[]) => {
      captureError(level, args);
      return original(...args);
    };
  }
  return logger;
}

let baseLogger: Logger | null = null;

export function createLogger(
  bindings?: Record<string, unknown>,
  options: LoggerFactoryOptions = {},
): Logger {
  const root = options.destination
    ? createBaseLogger(options.destination, options.redactPaths)
    : baseLogger ?? createBaseLogger(undefined, options.redactPaths);
  if (!options.destination && !baseLogger) {
    baseLogger = root;
  }
  const normalizedBindings = normalizeBindings(bindings);

  // Apply per-module log level override if a component is specified (Issue #404)
  const component = bindings?.component as string | undefined;
  if (component) {
    const moduleLevel = getModuleLogLevel(component);
    if (moduleLevel) {
      return withErrorCapture(root.child(normalizedBindings, { level: moduleLevel }));
    }
  }

  return withErrorCapture(root.child(normalizedBindings));
}

const logger = createLogger();

export default logger;
