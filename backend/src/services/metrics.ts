/**
 * Health dashboard metrics collection service.
 *
 * Responsibilities
 * ────────────────
 * • Sample every HTTP response (via {@link metricsMiddleware}) into a bounded
 *   ring buffer and derive rate / latency / error-rate analytics from it.
 * • Observe garbage collection pauses through `perf_hooks`.
 * • Probe dependency reachability (SQLite, Venice AI, Stellar Horizon,
 *   WebSocket) and read domain counters out of SQLite.
 * • Serve the assembled snapshot from a short-lived cache so that a scraping
 *   dashboard cannot turn `/health/dashboard` into a load generator.
 * • Export Prometheus metrics and track agent quality and reputation telemetry.
 *
 * The heavy lifting lives in exported pure functions (`calculateRequestMetrics`,
 * `summarizePayments`, …) so that every metric calculation is unit-testable
 * without touching a database, a socket, or the clock.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { PerformanceObserver } from "perf_hooks";

import { getConfig } from "../config";
import { createLogger } from "../utils/logger";
import { getCacheMetrics } from "../cache/metrics";
import { databasePoolMetrics } from "../db/metrics";
import type {
  AgentMetrics,
  CpuMetrics,
  DashboardStatus,
  DependencyMetrics,
  DependencyStatus,
  GcMetrics,
  HealthDashboard,
  MemoryMetrics,
  MetricsCollectorOptions,
  MetricsSources,
  PaymentAmount,
  PaymentMetrics,
  RegistryCacheMetrics,
  PrometheusHistogram,
  RequestMetrics,
  RequestSample,
  ScrapeHealth,
  SystemMetrics,
  TaskMetrics,
} from "./metrics.types";

import type { NextFunction, Request, Response } from "express";

const logger = createLogger({ component: "metrics" });

/** 1 XLM = 10 000 000 stroops. */
const STROOPS_PER_XLM = 10_000_000n;

/** Timeout applied to each outbound dependency probe. */
const PROBE_TIMEOUT_MS = 5_000;

export const DEFAULT_CACHE_TTL_MS = 5_000;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_SAMPLES = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure metric calculations
// ─────────────────────────────────────────────────────────────────────────────

/** Round to at most `digits` decimal places, keeping the value JSON-safe. */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Nearest-rank percentile over an **already ascending** array of samples.
 *
 * `percentile([1, 2, 3, 4], 95)` → `4`. Returns `0` for an empty input so the
 * dashboard reports a number rather than `null` before any traffic arrives.
 *
 * @param sorted - Ascending values.
 * @param p - Percentile in `0..100`; values outside the range are clamped.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/**
 * Derive traffic analytics from the raw request samples.
 *
 * Only samples inside `[now - windowMs, now]` are considered, so the numbers
 * describe recent behaviour rather than the lifetime of the process. The error
 * rate counts every response with a status code >= 400.
 */
export function calculateRequestMetrics(
  samples: readonly RequestSample[],
  now: number,
  windowMs: number,
): RequestMetrics {
  const cutoff = now - windowMs;
  const recent = samples.filter((s) => s.timestamp >= cutoff);

  if (recent.length === 0) {
    return {
      totalRequests: 0,
      windowMs,
      requestRatePerSecond: 0,
      avgResponseTimeMs: 0,
      p95ResponseTimeMs: 0,
      p99ResponseTimeMs: 0,
      errorRate: 0,
      serverErrorCount: 0,
      clientErrorCount: 0,
    };
  }

  const durations = recent.map((s) => s.durationMs).sort((a, b) => a - b);
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const clientErrorCount = recent.filter(
    (s) => s.statusCode >= 400 && s.statusCode < 500,
  ).length;
  const serverErrorCount = recent.filter((s) => s.statusCode >= 500).length;

  return {
    totalRequests: recent.length,
    windowMs,
    requestRatePerSecond: round(recent.length / (windowMs / 1000), 4),
    avgResponseTimeMs: round(totalDuration / recent.length),
    p95ResponseTimeMs: round(percentile(durations, 95)),
    p99ResponseTimeMs: round(percentile(durations, 99)),
    errorRate: round((clientErrorCount + serverErrorCount) / recent.length, 4),
    serverErrorCount,
    clientErrorCount,
  };
}

/** Shape memory usage into the dashboard's memory block. */
export function calculateMemoryMetrics(usage: NodeJS.MemoryUsage): MemoryMetrics {
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    heapUsedPercent:
      usage.heapTotal > 0 ? round((usage.heapUsed / usage.heapTotal) * 100) : 0,
  };
}

/**
 * Convert a `process.cpuUsage()` delta into a usage percentage.
 *
 * `cpuUsage` deltas are in **microseconds**; `elapsedMs` is wall-clock time
 * since the previous sample. The result may exceed 100 % when more than one
 * core is busy, which is expected and left unclamped.
 */
export function calculateCpuMetrics(
  delta: NodeJS.CpuUsage,
  elapsedMs: number,
  loadAverage: number[],
  cpuCount: number,
): CpuMetrics {
  const userMs = delta.user / 1000;
  const systemMs = delta.system / 1000;
  const usagePercent = elapsedMs > 0 ? ((userMs + systemMs) / elapsedMs) * 100 : 0;

  return {
    userMs: round(userMs),
    systemMs: round(systemMs),
    usagePercent: round(usagePercent),
    loadAverage: [
      round(loadAverage[0] ?? 0),
      round(loadAverage[1] ?? 0),
      round(loadAverage[2] ?? 0),
    ],
    cpuCount,
  };
}

/** Accumulated garbage-collection observations. */
export interface GcState {
  available: boolean;
  collections: number;
  totalPauseMs: number;
  lastPauseMs: number;
}

/** Derive the GC block, including the mean pause, from raw counters. */
export function calculateGcMetrics(state: GcState): GcMetrics {
  return {
    available: state.available,
    collections: state.collections,
    totalPauseMs: round(state.totalPauseMs, 3),
    avgPauseMs:
      state.collections > 0 ? round(state.totalPauseMs / state.collections, 3) : 0,
    lastPauseMs: round(state.lastPauseMs, 3),
  };
}

/** Convert an exact stroop total into the dashboard's payment amount block. */
export function toPaymentAmount(count: number, stroops: bigint): PaymentAmount {
  return {
    count,
    stroops: stroops.toString(),
    // Number() on the quotient keeps whole XLM exact; the remainder adds the
    // fractional part. Exactness is preserved in the `stroops` string.
    xlm: round(
      Number(stroops / STROOPS_PER_XLM) +
        Number(stroops % STROOPS_PER_XLM) / Number(STROOPS_PER_XLM),
      7,
    ),
  };
}

/** A payment row as stored: status plus a stroop amount in string form. */
export interface PaymentRow {
  status: string;
  amountStroops: string | number | bigint | null;
}

/**
 * Total locked / released / refunded escrow amounts.
 *
 * Amounts are summed as `bigint` so that totals beyond `Number.MAX_SAFE_INTEGER`
 * stroops stay exact. Unparseable amounts contribute `0` rather than `NaN`, and
 * rows with an unrecognised status are ignored.
 */
export function summarizePayments(rows: readonly PaymentRow[]): PaymentMetrics {
  const totals = { locked: 0n, released: 0n, refunded: 0n };
  const counts = { locked: 0, released: 0, refunded: 0 };

  for (const row of rows) {
    const status = row.status as keyof typeof totals;
    if (!(status in totals)) continue;
    counts[status] += 1;
    totals[status] += parseStroops(row.amountStroops);
  }

  return {
    locked: toPaymentAmount(counts.locked, totals.locked),
    released: toPaymentAmount(counts.released, totals.released),
    refunded: toPaymentAmount(counts.refunded, totals.refunded),
  };
}

/** Parse a stroop amount into a `bigint`, treating malformed values as zero. */
export function parseStroops(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

/** A `status → count` aggregate row as produced by `GROUP BY status`. */
export interface StatusCountRow {
  status: string;
  count: number;
}

/**
 * Fold task status counts into the dashboard's task block.
 *
 * `active` mirrors the `running` status; `total` is the sum of every row,
 * including statuses the dashboard does not break out individually.
 */
export function summarizeTasks(rows: readonly StatusCountRow[]): TaskMetrics {
  const metrics: TaskMetrics = {
    total: 0,
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    const count = Number(row.count) || 0;
    metrics.total += count;
    switch (row.status) {
      case "running":
        metrics.active += count;
        break;
      case "queued":
        metrics.queued += count;
        break;
      case "completed":
        metrics.completed += count;
        break;
      case "failed":
        metrics.failed += count;
        break;
      case "cancelled":
        metrics.cancelled += count;
        break;
      default:
        break;
    }
  }

  return metrics;
}

/** Fold agent status counts, plus a measured mean latency, into one block. */
export function summarizeAgents(
  rows: readonly StatusCountRow[],
  avgResponseTimeMs: number,
): AgentMetrics {
  let total = 0;
  let online = 0;
  let offline = 0;

  for (const row of rows) {
    const count = Number(row.count) || 0;
    total += count;
    if (row.status === "online") online += count;
    else offline += count;
  }

  return { total, online, offline, avgResponseTimeMs: round(avgResponseTimeMs) };
}

/** A node lifecycle event used to measure how long agents take to respond. */
export interface NodeTimingEvent {
  taskId: string;
  nodeId: string | null;
  type: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/**
 * Mean agent response time, in milliseconds, derived from node lifecycle events.
 *
 * Each `node_started` is paired with the first subsequent `node_completed` or
 * `node_failed` for the same `(taskId, nodeId)`. Unpaired starts (still running)
 * and events without a `nodeId` are skipped. Returns `0` when nothing pairs up.
 */
export function calculateAgentResponseTime(events: readonly NodeTimingEvent[]): number {
  const started = new Map<string, number>();
  let totalMs = 0;
  let pairs = 0;

  const ordered = [...events].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );

  for (const event of ordered) {
    if (!event.nodeId) continue;
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) continue;
    const key = `${event.taskId}::${event.nodeId}`;

    if (event.type === "node_started") {
      started.set(key, at);
      continue;
    }

    if (event.type !== "node_completed" && event.type !== "node_failed") continue;

    const startedAt = started.get(key);
    if (startedAt === undefined) continue;
    started.delete(key);
    totalMs += Math.max(0, at - startedAt);
    pairs += 1;
  }

  return pairs > 0 ? round(totalMs / pairs) : 0;
}

/**
 * Roll the individual dependency verdicts up into one dashboard status.
 *
 * SQLite is the only hard dependency: without it the service cannot serve
 * traffic, so an unreachable database is `unhealthy`. Any other failure or a
 * degraded dependency downgrades the dashboard to `degraded`.
 */
export function deriveDashboardStatus(dependencies: DependencyMetrics): DashboardStatus {
  if (dependencies.sqlite.status === "unreachable") return "unhealthy";

  const states = Object.values(dependencies).map((d) => d.status);
  if (states.some((s) => s === "unreachable" || s === "degraded")) return "degraded";
  return "healthy";
}

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus metrics rendering pure functions (Issue #499)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TASK_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
export const DEFAULT_VENICE_LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

export function createEmptyHistogram(bucketBounds: number[]): PrometheusHistogram {
  const buckets: Record<number, number> = {};
  for (const b of bucketBounds) {
    buckets[b] = 0;
  }
  return { buckets, sum: 0, count: 0 };
}

export function observeHistogram(histogram: PrometheusHistogram, value: number): void {
  histogram.count += 1;
  histogram.sum = round(histogram.sum + Math.max(0, value), 4);
  const bounds = Object.keys(histogram.buckets).map(Number).sort((a, b) => a - b);
  for (const bound of bounds) {
    if (value <= bound) {
      histogram.buckets[bound] = (histogram.buckets[bound] ?? 0) + 1;
    }
  }
}

export function renderHistogram(name: string, help: string, histogram: PrometheusHistogram): string {
  const lines: string[] = [];
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  const bounds = Object.keys(histogram.buckets).map(Number).sort((a, b) => a - b);
  let cumulative = 0;
  for (const bound of bounds) {
    cumulative = histogram.buckets[bound] ?? 0;
    lines.push(`${name}_bucket{le="${bound}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${histogram.count}`);
  lines.push(`${name}_sum ${histogram.sum}`);
  lines.push(`${name}_count ${histogram.count}`);
  return lines.join("\n");
}

export function formatPrometheusMetrics(params: {
  tasks: TaskMetrics;
  agents: AgentMetrics;
  payments: PaymentMetrics;
  taskDurationHistogram: PrometheusHistogram;
  veniceRequests: Map<string, number>;
  veniceLatencyHistogram: PrometheusHistogram;
  veniceCircuitBreakerState: number;
  totalXlmTransacted?: number;
}): string {
  const lines: string[] = [];

  // 1. ainet_tasks_total{status} — counter of tasks by final status
  lines.push("# HELP ainet_tasks_total Counter of tasks by final status");
  lines.push("# TYPE ainet_tasks_total counter");
  lines.push(`ainet_tasks_total{status="completed"} ${params.tasks.completed}`);
  lines.push(`ainet_tasks_total{status="failed"} ${params.tasks.failed}`);
  lines.push(`ainet_tasks_total{status="cancelled"} ${params.tasks.cancelled}`);
  lines.push(`ainet_tasks_total{status="active"} ${params.tasks.active}`);
  lines.push(`ainet_tasks_total{status="queued"} ${params.tasks.queued}`);

  // 2. ainet_tasks_duration_seconds — histogram of task execution time
  lines.push("");
  lines.push(renderHistogram("ainet_tasks_duration_seconds", "Histogram of task execution time", params.taskDurationHistogram));

  // 3. ainet_agents_total — gauge of registered agents
  lines.push("");
  lines.push("# HELP ainet_agents_total Gauge of registered agents");
  lines.push("# TYPE ainet_agents_total gauge");
  lines.push(`ainet_agents_total ${params.agents.total}`);

  // 4. ainet_payments_total{status,currency} — counter of payments by status
  lines.push("");
  lines.push("# HELP ainet_payments_total Counter of payments by status");
  lines.push("# TYPE ainet_payments_total counter");
  lines.push(`ainet_payments_total{currency="XLM",status="locked"} ${params.payments.locked.count}`);
  lines.push(`ainet_payments_total{currency="XLM",status="released"} ${params.payments.released.count}`);
  lines.push(`ainet_payments_total{currency="XLM",status="refunded"} ${params.payments.refunded.count}`);

  // 5. ainet_payment_amount_xlm_total — gauge/counter of total XLM transacted
  lines.push("");
  lines.push("# HELP ainet_payment_amount_xlm_total Total XLM transacted through payment escrows");
  lines.push("# TYPE ainet_payment_amount_xlm_total gauge");
  const xlmTotal = params.totalXlmTransacted !== undefined
    ? params.totalXlmTransacted
    : round(params.payments.locked.xlm + params.payments.released.xlm + params.payments.refunded.xlm, 4);
  lines.push(`ainet_payment_amount_xlm_total ${xlmTotal}`);

  // 6. ainet_venice_requests_total{model,status} — counter of Venice calls
  lines.push("");
  lines.push("# HELP ainet_venice_requests_total Counter of Venice calls");
  lines.push("# TYPE ainet_venice_requests_total counter");
  if (params.veniceRequests.size === 0) {
    lines.push(`ainet_venice_requests_total{model="default",status="success"} 0`);
  } else {
    for (const [key, count] of params.veniceRequests.entries()) {
      const [model, status] = key.split("::");
      lines.push(`ainet_venice_requests_total{model="${model || "default"}",status="${status || "success"}"} ${count}`);
    }
  }

  // 7. ainet_venice_latency_seconds — histogram of Venice call latency
  lines.push("");
  lines.push(renderHistogram("ainet_venice_latency_seconds", "Histogram of Venice call latency", params.veniceLatencyHistogram));

  // 8. ainet_venice_circuit_breaker_state — gauge (0 closed, 1 open, 2 half-open)
  lines.push("");
  lines.push("# HELP ainet_venice_circuit_breaker_state Gauge (0 closed, 1 open, 2 half-open)");
  lines.push("# TYPE ainet_venice_circuit_breaker_state gauge");
  lines.push(`ainet_venice_circuit_breaker_state ${params.veniceCircuitBreakerState}`);

  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics service
// ─────────────────────────────────────────────────────────────────────────────

/** Reported by whoever owns the WebSocket server, for the dependency block. */
export interface WebSocketProbeResult {
  listening: boolean;
  connections: number;
}

/**
 * Collects, caches and serves the health dashboard snapshot.
 *
 * A single shared instance ({@link metricsService}) is used by the HTTP
 * middleware and the dashboard route; tests construct their own instances with
 * injected sources and clock.
 */
export class MetricsService {
  private readonly cacheTtlMs: number;
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly clock: () => number;
  private readonly sources: MetricsSources;

  /** Bounded ring buffer of observed requests, oldest first. */
  private samples: RequestSample[] = [];

  private readonly startedAtMs: number;
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuSampleAtMs: number;

  private gcState: GcState = {
    available: false,
    collections: 0,
    totalPauseMs: 0,
    lastPauseMs: 0,
  };
  private gcObserver: PerformanceObserver | null = null;

  private cached: HealthDashboard | null = null;
  private cachedAtMs = 0;
  /** In-flight collection, shared so concurrent requests collect only once. */
  private inFlight: Promise<HealthDashboard> | null = null;

  private webSocketProbe: (() => WebSocketProbeResult) | null = null;

  private getLastBackupAgeHours(): number {
    const markerPath = process.env.BACKUP_TIMESTAMP_FILE ?? path.join(
      process.env.DB_DIR ?? process.cwd(),
      ".last-backup-timestamp",
    );
    try {
      const timestampSeconds = Number(fs.readFileSync(markerPath, "utf8").trim());
      if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return -1;
      return Math.max(0, (this.clock() / 1000 - timestampSeconds) / 3600);
    } catch {
      return -1;
    }
  }

  constructor(options: MetricsCollectorOptions = {}) {
    const config = readMetricsConfig();
    this.cacheTtlMs = options.cacheTtlMs ?? config.cacheTtlMs;
    this.windowMs = options.windowMs ?? config.windowMs;
    this.maxSamples = options.maxSamples ?? config.maxSamples;
    this.clock = options.clock ?? Date.now;
    this.sources = options.sources ?? {};

    this.startedAtMs = this.clock();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAtMs = Date.now();
    this.lastScrapeTimestamp = new Date(this.startedAtMs).toISOString();
  }

  /** Record one completed HTTP response. */
  recordRequest(durationMs: number, statusCode: number, method?: string, path?: string): void {
    this.samples.push({ timestamp: this.clock(), durationMs, statusCode, method, path });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  /** Samples currently retained — exposed for assertions and diagnostics. */
  getSamples(): readonly RequestSample[] {
    return this.samples;
  }

  /** Traffic analytics over the rolling window. */
  getRequestMetrics(): RequestMetrics {
    return calculateRequestMetrics(this.samples, this.clock(), this.windowMs);
  }

  /**
   * Register the source of truth for WebSocket liveness.
   *
   * Called by the stream layer when it attaches to the HTTP server; without it
   * the WebSocket dependency reports `unknown` rather than a false failure.
   */
  setWebSocketProbe(probe: (() => WebSocketProbeResult) | null): void {
    this.webSocketProbe = probe;
  }

  /**
   * Current WebSocket reachability, without a full dashboard collection.
   * Used by GET /health/ready. See {@link checkWebSocket} for the "no probe
   * registered" -> `unknown` semantics.
   */
  getWebSocketStatus(): DependencyStatus {
    return checkWebSocket(this.webSocketProbe);
  }

  /** Begin observing GC pauses. Safe to call more than once. */
  startGcObserver(): void {
    if (this.gcObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gcState.collections += 1;
          this.gcState.totalPauseMs += entry.duration;
          this.gcState.lastPauseMs = entry.duration;
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      // Newer Node builds expose unref() so the observer never holds the event
      // loop open; older typings omit it, hence the guarded cast.
      (observer as unknown as { unref?: () => void }).unref?.();
      this.gcObserver = observer;
      this.gcState.available = true;
    } catch (error) {
      // GC entries are unavailable on some runtimes/flags — report, don't throw.
      logger.warn({ err: error }, "garbage collection observer unavailable");
      this.gcState.available = false;
    }
  }

  /** Stop observing GC pauses and release the observer. */
  stopGcObserver(): void {
    this.gcObserver?.disconnect();
    this.gcObserver = null;
  }

  /** Process health: uptime, memory, CPU-since-last-sample and GC. */
  getSystemMetrics(): SystemMetrics {
    const nowMs = Date.now();
    const cpuDelta = process.cpuUsage(this.lastCpuUsage);
    const elapsedMs = nowMs - this.lastCpuSampleAtMs;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAtMs = nowMs;

    return {
      uptimeSeconds: Math.max(0, Math.floor((this.clock() - this.startedAtMs) / 1000)),
      memory: calculateMemoryMetrics(process.memoryUsage()),
      cpu: calculateCpuMetrics(cpuDelta, elapsedMs, os.loadavg(), os.cpus().length),
      gc: calculateGcMetrics(this.gcState),
    };
  }

  /**
   * The dashboard snapshot, recollected at most once per `cacheTtlMs`.
   *
   * @param force - Bypass the cache and collect immediately.
   */
  async getDashboard(force = false): Promise<HealthDashboard> {
    const now = this.clock();
    if (!force && this.cached) {
      const age = now - this.cachedAtMs;
      if (age < this.cacheTtlMs) {
        return { ...this.cached, cacheAgeMs: Math.max(0, age) };
      }
    }

    // Collapse concurrent misses onto a single collection.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.collect()
      .then((dashboard) => {
        this.cached = dashboard;
        this.cachedAtMs = this.clock();
        return dashboard;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Drop the cached snapshot so the next read collects fresh data. */
  resetCache(): void {
    this.cached = null;
    this.cachedAtMs = 0;
  }

  /** Discard every recorded request sample. */
  resetSamples(): void {
    this.samples = [];
  }

  // ── Prometheus Metric Families (Issue #499) ────────────────────────────────

  private taskDurationHistogram = createEmptyHistogram(DEFAULT_TASK_DURATION_BUCKETS);
  private veniceRequests = new Map<string, number>();
  private veniceLatencyHistogram = createEmptyHistogram(DEFAULT_VENICE_LATENCY_BUCKETS);
  private veniceCircuitBreakerState = 0; // 0=closed, 1=open, 2=half-open
  private registeredOnce = true;
  private lastScrapeTimestamp: string;

  // ── Extended Prometheus Metrics (Observability Enhancement) ────────────────
  /** tasks_submitted_total — counter incremented on each new task submission. */
  private tasksSubmittedTotal = 0;
  /** tasks_failed_total by reason — key: reason, value: count. */
  private tasksFailedByReason = new Map<string, number>();
  /** venice_ai_calls_total by agent_type — key: agent_type::status, value: count. */
  private veniceCallsByAgentType = new Map<string, number>();
  /** stellar_transactions_total by type — key: type, value: count. */
  private stellarTransactionsByType = new Map<string, number>();
  private taskResultCompressionRatioTotal = 0;
  private taskResultCompressionCount = 0;
  /** active_websocket_connections gauge — live count set externally. */
  private activeWsConnections = 0;
  /** agent_health_status by agent_id — key: agentId, value: 1|0. */
  private agentHealthStatuses = new Map<string, number>();
  private agentQualityScores = new Map<string, number>();

  /** Record completed task duration in seconds. */
  recordTaskCompletion(durationSeconds: number, _status: string = "completed"): void {
    observeHistogram(this.taskDurationHistogram, Math.max(0, durationSeconds));
  }

  /** Task duration histogram getter. */
  getTaskDurationHistogram(): PrometheusHistogram {
    return this.taskDurationHistogram;
  }

  /** Record outbound Venice AI request latency and status. */
  recordVeniceCall(model: string, status: string, latencySeconds: number): void {
    const key = `${model || "default"}::${status || "success"}`;
    this.veniceRequests.set(key, (this.veniceRequests.get(key) || 0) + 1);
    observeHistogram(this.veniceLatencyHistogram, Math.max(0, latencySeconds));
  }

  /** Venice latency histogram getter. */
  getVeniceLatencyHistogram(): PrometheusHistogram {
    return this.veniceLatencyHistogram;
  }

  /** Set Venice AI circuit breaker state (0 closed, 1 open, 2 half-open). */
  setVeniceCircuitBreakerState(state: number | "closed" | "open" | "half-open"): void {
    if (typeof state === "number") {
      this.veniceCircuitBreakerState = Math.max(0, Math.min(2, Math.floor(state)));
    } else if (state === "closed") {
      this.veniceCircuitBreakerState = 0;
    } else if (state === "open") {
      this.veniceCircuitBreakerState = 1;
    } else if (state === "half-open") {
      this.veniceCircuitBreakerState = 2;
    }
  }

  /** Get current Venice AI circuit breaker state code. */
  getVeniceCircuitBreakerState(): number {
    return this.veniceCircuitBreakerState;
  }

  // ── Extended Metrics (Observability Enhancement) ───────────────────────────

  /** Increment tasks_submitted_total counter. */
  recordTaskSubmitted(): void {
    this.tasksSubmittedTotal += 1;
  }

  /** Increment tasks_failed_total counter by reason label. */
  recordTaskFailed(reason: string): void {
    const key = reason || "unknown";
    this.tasksFailedByReason.set(key, (this.tasksFailedByReason.get(key) ?? 0) + 1);
  }

  /**
   * Record a Venice AI call attributed to a specific agent type.
   * Also increments the existing model-keyed counter for backward compat.
   */
  recordVeniceCallByAgentType(agentType: string, status: string, latencySeconds: number): void {
    const key = `${agentType || "unknown"}::${status || "success"}`;
    this.veniceCallsByAgentType.set(key, (this.veniceCallsByAgentType.get(key) ?? 0) + 1);
    // Keep the existing histogram up-to-date too
    observeHistogram(this.veniceLatencyHistogram, Math.max(0, latencySeconds));
  }

  /** Record a Stellar transaction by type (e.g. payment, create_account). */
  recordStellarTransaction(type: string): void {
    const key = type || "unknown";
    this.stellarTransactionsByType.set(key, (this.stellarTransactionsByType.get(key) ?? 0) + 1);
  }

  recordTaskResultCompressionRatio(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio < 0) return;
    this.taskResultCompressionRatioTotal += ratio;
    this.taskResultCompressionCount += 1;
  }

  /** Set active WebSocket connections gauge (called by stream layer). */
  setActiveWsConnections(count: number): void {
    this.activeWsConnections = Math.max(0, count);
  }

  /** Get current active WebSocket connections count. */
  getActiveWsConnections(): number {
    return this.activeWsConnections;
  }

  /**
   * Update agent health status gauge.
   * @param agentId - Agent identifier (used as label).
   * @param healthy - true = 1 (healthy), false = 0 (unhealthy).
   */
  setAgentHealthStatus(agentId: string, healthy: boolean): void {
    this.agentHealthStatuses.set(agentId, healthy ? 1 : 0);
  }

  setAgentQualityScore(agentId: string, score: number): void {
    this.agentQualityScores.set(agentId, Math.max(0, Math.min(100, score)));
  }

  /** Remove an agent's health entry (e.g. on deregistration). */
  removeAgentHealthStatus(agentId: string): void {
    this.agentHealthStatuses.delete(agentId);
  }

  /**
   * Render all metric families in Prometheus text format.
   * Emits the full set of required metrics including labelled counters for
   * HTTP method/path/status, task submission, task failures by reason,
   * Venice AI calls by agent type, Stellar transactions by type,
   * active WebSocket connections, and per-agent health status.
   */
  async exportPrometheusMetrics(): Promise<string> {
    const dashboard = await this.getDashboard();
    this.lastScrapeTimestamp = new Date(this.clock()).toISOString();

    const samples = this.samples;

    // Build http_requests_total{method,path,status} from the sample buffer
    const httpCountByLabel = new Map<string, number>();
    const httpDurationsMs: number[] = [];
    for (const s of samples) {
      const method = s.method ?? "UNKNOWN";
      const path = s.path ?? "/";
      const status = String(s.statusCode);
      const key = `${method}::${path}::${status}`;
      httpCountByLabel.set(key, (httpCountByLabel.get(key) ?? 0) + 1);
      httpDurationsMs.push(s.durationMs);
    }

    const lines: string[] = [];
    const poolMetrics = databasePoolMetrics();

    // ── 0. ainet_up gauge ─────────────────────────────────────────────────────
    lines.push("# HELP ainet_up Whether the ai-net backend is running");
    lines.push("# TYPE ainet_up gauge");
    lines.push("ainet_up 1");
    lines.push("");

    // ── 1. ainet_http_requests_total{method,path,status} ─────────────────────
    lines.push("# HELP ainet_http_requests_total Total number of HTTP requests by method, path and status");
    lines.push("# TYPE ainet_http_requests_total counter");
    if (httpCountByLabel.size === 0) {
      lines.push('ainet_http_requests_total{method="GET",path="/",status="200"} 0');
    } else {
      for (const [key, count] of httpCountByLabel.entries()) {
        const parts = key.split("::");
        const method = parts[0] ?? "UNKNOWN";
        const path = parts[1] ?? "/";
        const status = parts[2] ?? "0";
        lines.push(`ainet_http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
      }
    }

    // ── 2. http_request_duration_seconds histogram ────────────────────────────
    lines.push("");
    const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    const durHist = createEmptyHistogram(durationBuckets);
    for (const ms of httpDurationsMs) {
      observeHistogram(durHist, ms / 1000); // convert ms to seconds
    }
    lines.push(renderHistogram("ainet_http_request_duration_seconds", "HTTP request latency in seconds", durHist));

    // ── 3. tasks_submitted_total ──────────────────────────────────────────────
    lines.push("");
    lines.push("# HELP tasks_submitted_total Total number of tasks submitted");
    lines.push("# TYPE tasks_submitted_total counter");
    lines.push(`tasks_submitted_total ${this.tasksSubmittedTotal}`);

    // ── 4. tasks_completed_total{status} ─────────────────────────────────────
    lines.push("");
    lines.push("# HELP tasks_completed_total Total number of tasks by completion status");
    lines.push("# TYPE tasks_completed_total counter");
    lines.push(`tasks_completed_total{status="completed"} ${dashboard.tasks.completed}`);
    lines.push(`tasks_completed_total{status="failed"} ${dashboard.tasks.failed}`);
    lines.push(`tasks_completed_total{status="cancelled"} ${dashboard.tasks.cancelled}`);

    // ── 5. tasks_failed_total{reason} ────────────────────────────────────────
    lines.push("");
    lines.push("# HELP tasks_failed_total Total number of failed tasks by reason");
    lines.push("# TYPE tasks_failed_total counter");
    if (this.tasksFailedByReason.size === 0) {
      lines.push('tasks_failed_total{reason="unknown"} 0');
    } else {
      for (const [reason, count] of this.tasksFailedByReason.entries()) {
        lines.push(`tasks_failed_total{reason="${reason}"} ${count}`);
      }
    }

    // ── 6. venice_ai_calls_total{agent_type,status} ───────────────────────────
    lines.push("");
    lines.push("# HELP venice_ai_calls_total Total Venice AI API calls by agent type and status");
    lines.push("# TYPE venice_ai_calls_total counter");
    if (this.veniceCallsByAgentType.size === 0) {
      lines.push('venice_ai_calls_total{agent_type="unknown",status="success"} 0');
    } else {
      for (const [key, count] of this.veniceCallsByAgentType.entries()) {
        const parts = key.split("::");
        const agentType = parts[0] ?? "unknown";
        const status = parts[1] ?? "success";
        lines.push(`venice_ai_calls_total{agent_type="${agentType}",status="${status}"} ${count}`);
      }
    }

    // ── 7. stellar_transactions_total{type} ───────────────────────────────────
    lines.push("");
    lines.push("# HELP stellar_transactions_total Total Stellar blockchain transactions by type");
    lines.push("# TYPE stellar_transactions_total counter");
    if (this.stellarTransactionsByType.size === 0) {
      lines.push('stellar_transactions_total{type="payment"} 0');
    } else {
      for (const [type, count] of this.stellarTransactionsByType.entries()) {
        lines.push(`stellar_transactions_total{type="${type}"} ${count}`);
      }
    }

    lines.push("");
    lines.push("# HELP task_result_compression_ratio Average compressed-to-original result size ratio");
    lines.push("# TYPE task_result_compression_ratio gauge");
    const compressionRatio = this.taskResultCompressionCount === 0
      ? 0
      : this.taskResultCompressionRatioTotal / this.taskResultCompressionCount;
    lines.push(`task_result_compression_ratio ${compressionRatio}`);

    // ── 8. active_websocket_connections gauge ─────────────────────────────────
    // Prefer the live probe result from the stream layer; fall back to our counter.
    const wsProbeResult = this.webSocketProbe?.();
    const wsCount = wsProbeResult !== undefined ? wsProbeResult.connections : this.activeWsConnections;
    lines.push("");
    lines.push("# HELP active_websocket_connections Number of active WebSocket connections");
    lines.push("# TYPE active_websocket_connections gauge");
    lines.push(`active_websocket_connections ${wsCount}`);

    lines.push("");
    lines.push("# HELP last_backup_age_hours Age of the last successful database backup in hours; -1 means no timestamp is available");
    lines.push("# TYPE last_backup_age_hours gauge");
    lines.push(`last_backup_age_hours ${this.getLastBackupAgeHours()}`);

    // ── 9. agent_health_status{agent_id} gauge ────────────────────────────────
    lines.push("");
    lines.push("# HELP agent_health_status Agent health status (1=healthy, 0=unhealthy) by agent_id");
    lines.push("# TYPE agent_health_status gauge");
    if (this.agentHealthStatuses.size === 0) {
      // No agents registered yet — emit a synthetic zero so Grafana panels load
      lines.push('agent_health_status{agent_id="none"} 0');
    } else {
      for (const [agentId, status] of this.agentHealthStatuses.entries()) {
        lines.push(`agent_health_status{agent_id="${agentId}"} ${status}`);
      }
    }

    // ── SQLite connection pool health ───────────────────────────────────────
    lines.push("");
    lines.push("# HELP db_pool_active_connections Active SQLite reader connections");
    lines.push("# TYPE db_pool_active_connections gauge");
    lines.push("# HELP db_pool_idle_connections Idle SQLite reader connections");
    lines.push("# TYPE db_pool_idle_connections gauge");
    lines.push("# HELP db_pool_waiting_queue_size Callers waiting for an SQLite reader");
    lines.push("# TYPE db_pool_waiting_queue_size gauge");
    lines.push("# HELP db_pool_acquire_wait_seconds SQLite reader acquisition wait time");
    lines.push("# TYPE db_pool_acquire_wait_seconds histogram");
    for (const [database, pool] of Object.entries(poolMetrics)) {
      const labels = `{database="${database}"}`;
      lines.push(`db_pool_active_connections${labels} ${pool.activeConnections}`);
      lines.push(`db_pool_idle_connections${labels} ${pool.idleConnections}`);
      lines.push(`db_pool_waiting_queue_size${labels} ${pool.pendingAcquires}`);
      let cumulative = 0;
      for (const [bound, count] of Object.entries(pool.acquireWaitBuckets)) {
        cumulative = count;
        lines.push(`db_pool_acquire_wait_seconds_bucket{database="${database}",le="${bound}"} ${cumulative}`);
      }
      lines.push(`db_pool_acquire_wait_seconds_bucket{database="${database}",le="+Inf"} ${pool.acquireWaitCount}`);
      lines.push(`db_pool_acquire_wait_seconds_sum${labels} ${pool.acquireWaitSumSeconds}`);
      lines.push(`db_pool_acquire_wait_seconds_count${labels} ${pool.acquireWaitCount}`);
    }

    // ── Legacy metric families (keep for backward compat with existing dashboard) ──
    lines.push("");
    lines.push(formatPrometheusMetrics({
      tasks: dashboard.tasks,
      agents: dashboard.agents,
      payments: dashboard.payments,
      taskDurationHistogram: this.taskDurationHistogram,
      veniceRequests: this.veniceRequests,
      veniceLatencyHistogram: this.veniceLatencyHistogram,
      veniceCircuitBreakerState: this.veniceCircuitBreakerState,
    }));

    // ── Process gauges ────────────────────────────────────────────────────────
    const mem = process.memoryUsage();
    lines.push("");
    lines.push("# HELP ainet_process_uptime_seconds Process uptime in seconds");
    lines.push("# TYPE ainet_process_uptime_seconds gauge");
    lines.push(`ainet_process_uptime_seconds ${process.uptime()}`);
    lines.push("# HELP ainet_process_memory_rss_bytes Resident Set Size in bytes");
    lines.push("# TYPE ainet_process_memory_rss_bytes gauge");
    lines.push(`ainet_process_memory_rss_bytes ${mem.rss}`);
    lines.push("# HELP ainet_process_memory_heap_total_bytes Total heap size in bytes");
    lines.push("# TYPE ainet_process_memory_heap_total_bytes gauge");
    lines.push(`ainet_process_memory_heap_total_bytes ${mem.heapTotal}`);
    lines.push("# HELP ainet_process_memory_heap_used_bytes Used heap size in bytes");
    lines.push("# TYPE ainet_process_memory_heap_used_bytes gauge");
    lines.push(`ainet_process_memory_heap_used_bytes ${mem.heapUsed}`);
    lines.push("# HELP ainet_process_memory_external_bytes External memory in bytes");
    lines.push("# TYPE ainet_process_memory_external_bytes gauge");
    lines.push(`ainet_process_memory_external_bytes ${mem.external}`);

    return lines.join("\n") + "\n";
  }

  /**
   * Scrape reliability endpoint payload.
   */
  getScrapeHealth(): ScrapeHealth {
    return {
      status: "ok",
      uptimeSeconds: Math.max(0, Math.floor((this.clock() - this.startedAtMs) / 1000)),
      lastScrapeTimestamp: this.lastScrapeTimestamp,
      metricFamiliesCount: 18, // 10 new + 8 legacy families
      registeredOnce: this.registeredOnce,
    };
  }

  /**
   * Reset Prometheus metrics safely without duplicate registration crash.
   */
  resetPrometheusMetrics(): void {
    this.taskDurationHistogram = createEmptyHistogram(DEFAULT_TASK_DURATION_BUCKETS);
    this.veniceRequests.clear();
    this.veniceLatencyHistogram = createEmptyHistogram(DEFAULT_VENICE_LATENCY_BUCKETS);
    this.veniceCircuitBreakerState = 0;
    this.registeredOnce = true;
    // Reset extended counters
    this.tasksSubmittedTotal = 0;
    this.tasksFailedByReason.clear();
    this.veniceCallsByAgentType.clear();
    this.stellarTransactionsByType.clear();
    this.taskResultCompressionRatioTotal = 0;
    this.taskResultCompressionCount = 0;
    this.activeWsConnections = 0;
    this.agentHealthStatuses.clear();
    this.agentQualityScores.clear();
    this.resetCache();
  }

  /** Collect every metric family in parallel and assemble the snapshot. */
  private async collect(): Promise<HealthDashboard> {
    const [sqlite, venice, stellarHorizon, websocket, agents, tasks, payments] =
      await Promise.all([
        resolveProbe(this.sources.checkSqlite, checkSqlite),
        resolveProbe(this.sources.checkVenice, checkVenice),
        resolveProbe(this.sources.checkStellarHorizon, checkStellarHorizon),
        resolveProbe(this.sources.checkWebSocket, () =>
          checkWebSocket(this.webSocketProbe),
        ),
        resolveSource(this.sources.collectAgents, collectAgentMetrics, EMPTY_AGENTS),
        resolveSource(this.sources.collectTasks, collectTaskMetrics, EMPTY_TASKS),
        resolveSource(this.sources.collectPayments, collectPaymentMetrics, EMPTY_PAYMENTS),
      ]);

    const dependencies: DependencyMetrics = { sqlite, venice, stellarHorizon, websocket };
    const config = readMetricsConfig();

    return {
      status: deriveDashboardStatus(dependencies),
      timestamp: new Date(this.clock()).toISOString(),
      version: config.version,
      stellarNetwork: config.stellarNetwork,
      cacheAgeMs: 0,
      cacheTtlMs: this.cacheTtlMs,
      requests: this.getRequestMetrics(),
      dependencies,
      system: this.getSystemMetrics(),
      agents,
      tasks,
      payments,
      registryCache: getCacheMetrics() as RegistryCacheMetrics,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency probes and SQLite collectors
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_AGENTS: AgentMetrics = { total: 0, online: 0, offline: 0, avgResponseTimeMs: 0 };

const EMPTY_TASKS: TaskMetrics = {
  total: 0,
  active: 0,
  queued: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

const EMPTY_PAYMENTS: PaymentMetrics = {
  locked: toPaymentAmount(0, 0n),
  released: toPaymentAmount(0, 0n),
  refunded: toPaymentAmount(0, 0n),
};

/** Run an overridable probe, converting a rejection into an `unreachable`. */
async function resolveProbe(
  override: (() => Promise<DependencyStatus> | DependencyStatus) | undefined,
  fallback: () => Promise<DependencyStatus> | DependencyStatus,
): Promise<DependencyStatus> {
  try {
    return await (override ?? fallback)();
  } catch (error) {
    return { status: "unreachable", error: errorMessage(error) };
  }
}

/** Run an overridable collector, falling back to zeroed metrics on failure. */
async function resolveSource<T>(
  override: (() => Promise<T> | T) | undefined,
  fallback: () => Promise<T> | T,
  empty: T,
): Promise<T> {
  try {
    return await (override ?? fallback)();
  } catch (error) {
    logger.warn({ err: error }, "metrics source failed; reporting zeroed metrics");
    return empty;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `SELECT 1` against the task and payment databases. */
async function checkSqlite(): Promise<DependencyStatus> {
  const startedAt = Date.now();
  try {
    const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
    const { getDb } = require("../db/index") as typeof import("../db/index");
    getTaskDb().prepare("SELECT 1").get();
    getDb().prepare("SELECT 1").get();
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: "unreachable",
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

/** Probe the Venice AI model listing with a bounded timeout. */
async function checkVenice(): Promise<DependencyStatus> {
  const apiKey = safeConfig()?.VENICE_API_KEY ?? "";
  return probeHttp("https://api.venice.ai/api/v1/models", {
    Authorization: `Bearer ${apiKey}`,
  });
}

/** Probe the configured Stellar Horizon root endpoint. */
async function checkStellarHorizon(): Promise<DependencyStatus> {
  const url = safeConfig()?.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  return probeHttp(url);
}

/**
 * Report WebSocket liveness from the registered probe.
 *
 * Without a registered probe the stream layer has not attached — that is
 * reported as `unknown` rather than a failure, because a backend running
 * without the WebSocket server is a valid configuration.
 */
function checkWebSocket(probe: (() => WebSocketProbeResult) | null): DependencyStatus {
  if (!probe) {
    return { status: "unknown", error: "WebSocket server not attached" };
  }
  try {
    const result = probe();
    return {
      status: result.listening ? "ok" : "unreachable",
      details: { connections: result.connections },
    };
  } catch (error) {
    return { status: "unreachable", error: errorMessage(error) };
  }
}

/** Issue a bounded HEAD-like GET and classify the response. */
async function probeHttp(
  url: string,
  headers: Record<string, string> = {},
): Promise<DependencyStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) return { status: "ok", latencyMs };
    return {
      status: "degraded",
      latencyMs,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: "unreachable",
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Agent population and mean node execution time, read from SQLite. */
function collectAgentMetrics(): AgentMetrics {
  const { getAgentDb } = require("../db/agents") as typeof import("../db/agents");
  const rows = getAgentDb()
    .prepare("SELECT status, COUNT(*) AS count FROM agents GROUP BY status")
    .all() as StatusCountRow[];

  let avgResponseTimeMs = 0;
  try {
    const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
    const events = getTaskDb()
      .prepare(
        `SELECT taskId, nodeId, type, timestamp FROM task_events
          WHERE type IN ('node_started', 'node_completed', 'node_failed')
          ORDER BY timestamp DESC
          LIMIT 1000`,
      )
      .all() as NodeTimingEvent[];
    avgResponseTimeMs = calculateAgentResponseTime(events);
  } catch (error) {
    // A missing task_events table must not sink the whole agent block.
    logger.warn({ err: error }, "unable to derive agent response time");
  }

  return summarizeAgents(rows, avgResponseTimeMs);
}

/** Task pipeline counters, read from SQLite. */
function collectTaskMetrics(): TaskMetrics {
  const { getTaskDb } = require("../db/tasks") as typeof import("../db/tasks");
  const rows = getTaskDb()
    .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
    .all() as StatusCountRow[];
  return summarizeTasks(rows);
}

/** Escrow totals, read from SQLite and summed exactly as `bigint`. */
function collectPaymentMetrics(): PaymentMetrics {
  const { getDb } = require("../db/index") as typeof import("../db/index");
  const rows = getDb()
    .prepare("SELECT status, amountStroops FROM payments")
    .all() as PaymentRow[];
  return summarizePayments(rows);
}

/** Config-backed knobs, with defaults for contexts where config is unloaded. */
function readMetricsConfig(): {
  cacheTtlMs: number;
  windowMs: number;
  maxSamples: number;
  version: string;
  stellarNetwork: string;
} {
  const config = safeConfig();
  return {
    cacheTtlMs: config?.METRICS_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS,
    windowMs: config?.METRICS_WINDOW_MS ?? DEFAULT_WINDOW_MS,
    maxSamples: config?.METRICS_MAX_SAMPLES ?? DEFAULT_MAX_SAMPLES,
    version: config?.NPM_PACKAGE_VERSION ?? "0.0.0",
    stellarNetwork: config?.STELLAR_NETWORK ?? "unknown",
  };
}

/** `getConfig()` throws before `loadConfig()`; metrics must not depend on order. */
function safeConfig(): ReturnType<typeof getConfig> | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared instance and Express middleware
// ─────────────────────────────────────────────────────────────────────────────

/** Process-wide metrics instance used by the middleware and dashboard route. */
export const metricsService = new MetricsService();

/**
 * Sample every HTTP response into {@link metricsService}.
 *
 * Mount before the routers so that latency covers the full handler chain.
 * Captures method, normalized path, status code and duration for labelled counters.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    // Normalize path to avoid high-cardinality label explosion.
    // Replace UUIDs and numeric IDs with placeholders.
    const rawPath = req.path ?? "/";
    const normalizedPath = rawPath
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
      .replace(/\/task_[a-z0-9]+/gi, "/:taskId")
      .replace(/\/[0-9]+/g, "/:id");
    const method = req.method ?? "UNKNOWN";
    metricsService.recordRequest(durationMs, res.statusCode, method, normalizedPath);
  });

  next();
}
