/**
 * Jest global setup — runs once before ALL test suites.
 *
 * Responsibilities:
 *  - Set required environment variables for unit tests
 *  - Log a marker so CI output is easy to grep
 *  - Deploy shared contracts (when RUN_SHARED_DEPLOY=true)
 *  - Testnet health check (when RUN_STELLAR_E2E_TESTS or RUN_INTEGRATION_TESTS
 *    is true) — aborts early if the Stellar testnet is fully down, so CI
 *    fails fast instead of running 60+ seconds of flaky network timeouts.
 *  - Transient error retry helper for known Stellar testnet flakiness
 *    (connection timeout, Friendbot 429, RPC 503).
 *
 * Uses CommonJS `module.exports` because Jest's `globalSetup` runs
 * in a plain Node context before `ts-jest` transformation is applied.
 */

/** Mark CI output for easy scanning */
function logBanner(label: string): void {
  console.log(
    `\n${'═'.repeat(60)}\n  ${label}\n${'═'.repeat(60)}`
  );
}

// ── Transient error retry helper ─────────────────────────────────────────────
//
// Wraps an async function with up to 3 retries on known transient Stellar
// testnet errors: connection timeouts (ECONNRESET, ETIMEDOUT), Friendbot 429,
// and RPC 503. Uses exponential backoff: 2s -> 4s -> 8s.
//
// This is used by the testnet health check and is also exported for individual
// test suites that need to wrap network-dependent operations.

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
}

/** Returns true if the given error is a known transient Stellar testnet error. */
export function isTransientStellarError(error: any): boolean {
  // Connection-level errors (timeout, reset, unreachable)
  const code = error?.code || error?.errno;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
    return true;
  }

  // HTTP-level transient status codes
  const status = error?.response?.status || error?.status;
  if (status === 429 || status === 503 || status === 504) {
    return true;
  }

  // Axios timeout message
  const message = error?.message ?? '';
  if (message.includes('timeout') || message.includes('ECONNABORTED')) {
    return true;
  }

  return false;
}

/**
 * Execute an async function with up to 3 retries on transient Stellar testnet
 * errors. Uses exponential backoff (2s -> 4s -> 8s) between attempts.
 *
 * If the final retry fails, the last error is re-thrown so callers can
 * distinguish between "all retries exhausted" and a non-transient failure.
 */
export async function retryOnTransientError<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const label = opts.label ?? 'operation';

  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (isTransientStellarError(error) && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(
          `[retry] ${label}: attempt ${attempt}/${maxRetries} failed with transient error — ` +
          `retrying in ${delay}ms…`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      // Non-transient error or out of retries — re-throw
      throw error;
    }
  }
  throw lastError;
}

// ── Testnet health check ─────────────────────────────────────────────────────
//
// Pings the Stellar testnet Horizon and Friendbot endpoints to determine
// whether the testnet is reachable. If both are down, the health check fails
// and the test run should abort early (caller decides how to handle).

const HORIZON_TESTNET_URL = 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const RPC_TESTNET_URL = 'https://soroban-testnet.stellar.org';

/** Simple HTTP GET with a timeout (no external dependencies required). */
async function httpGetWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean }> {
  // Use the global fetch if available (Node 18+), otherwise fall back to http module.
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return { status: res.status, ok: res.ok };
    } catch (error: any) {
      clearTimeout(timer);
      throw error;
    }
  }

  // Fallback: use Node's http/https module
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, (res: any) => {
      // Consume the body to free the socket
      res.resume();
      resolve({ status: res.statusCode ?? 0, ok: res.statusCode != null && res.statusCode < 400 });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
  });
}

export interface TestnetHealthResult {
  healthy: boolean;
  horizon: boolean;
  friendbot: boolean;
  rpc: boolean;
  details: string;
}

/**
 * Checks whether the Stellar testnet is reachable by pinging Horizon,
 * Friendbot, and the Soroban RPC endpoint.
 *
 * A testnet is considered "healthy" if at least 2 of the 3 endpoints respond.
 * This avoids false negatives when one endpoint is temporarily degraded.
 *
 * Each endpoint is retried up to 3 times on transient errors before being
 * marked as unreachable.
 */
export async function checkTestnetHealth(): Promise<TestnetHealthResult> {
  const checkEndpoint = async (url: string, label: string): Promise<boolean> => {
    try {
      const result = await retryOnTransientError(
        () => httpGetWithTimeout(url, 15_000),
        { maxRetries: 3, baseDelayMs: 2000, label: `health-check:${label}` },
      );
      return result.ok;
    } catch {
      return false;
    }
  };

  const [horizonOk, friendbotOk, rpcOk] = await Promise.all([
    checkEndpoint(`${HORIZON_TESTNET_URL}/`, 'horizon'),
    checkEndpoint(FRIENDBOT_URL, 'friendbot'),
    checkEndpoint(`${RPC_TESTNET_URL}/`, 'rpc'),
  ]);

  const reachableCount = [horizonOk, friendbotOk, rpcOk].filter(Boolean).length;
  const healthy = reachableCount >= 2;

  const details = [
    `Horizon: ${horizonOk ? '✅' : '❌'}`,
    `Friendbot: ${friendbotOk ? '✅' : '❌'}`,
    `RPC: ${rpcOk ? '✅' : '❌'}`,
  ].join(' | ');

  return { healthy, horizon: horizonOk, friendbot: friendbotOk, rpc: rpcOk, details };
}

// ── Main setup ────────────────────────────────────────────────────────────────

async function setup(): Promise<void> {
  logBanner('Jest globalSetup — smart-contracts');

  // ── Environment defaults for unit tests ──────────────────────────────
  // Provide safe fallbacks so tests don't fail on missing env vars.
  // Note: individual tests that need to verify missing-key behaviour
  // delete these vars within their own scope, so this doesn't mask issues.
  if (!process.env.STELLAR_NETWORK) {
    process.env.STELLAR_NETWORK = 'testnet';
  }

  // ── Testnet health check (E2E / integration tests only) ──────────────────
  //
  // When running E2E or integration tests that hit the live testnet, perform
  // a health check before running any test. If the testnet is fully down,
  // abort early to avoid 60+ seconds of flaky timeout failures and produce a
  // clear diagnostic message instead.
  //
  // This guard is skipped for unit tests (which don't touch the network) and
  // can be bypassed with SKIP_TESTNET_HEALTH_CHECK=true for debugging.
  const requiresTestnet =
    process.env.RUN_STELLAR_E2E_TESTS === 'true' ||
    process.env.RUN_INTEGRATION_TESTS === 'true' ||
    process.env.RUN_TESTNET_FARM === 'true';

  if (requiresTestnet && process.env.SKIP_TESTNET_HEALTH_CHECK !== 'true') {
    logBanner('Testnet health check');
    console.log('Pinging Stellar testnet endpoints (Horizon, Friendbot, RPC)…');

    const health = await checkTestnetHealth();
    console.log(`Health: ${health.details}`);

    if (!health.healthy) {
      const message =
        `⚠️  Stellar testnet health check FAILED.\n` +
        `   ${health.details}\n` +
        `   Aborting test run — testnet appears to be fully down.\n` +
        `   This is a testnet outage, not a code regression.\n` +
        `   Set SKIP_TESTNET_HEALTH_CHECK=true to bypass this check.`;
      console.error(message);
      // Exit non-zero so CI fails fast with a clear signal
      process.exit(2);
    }

    console.log('✅ Testnet is healthy — proceeding with tests.\n');
  }

  // ── Shared contract deployment (CI optimisation) ──────────────────────
  if (process.env.RUN_SHARED_DEPLOY === 'true') {
    logBanner('Deploying shared contracts');
    // When Soroban JS test utilities are wired in, deploy contracts here:
    //   const { deployContracts } = require('./fixtures/deploy');
    //   const fixtures = await deployContracts();
    //   process.env.__CONTRACT_FIXTURES__ = JSON.stringify(fixtures);
  }

  logBanner('globalSetup complete');
}

module.exports = setup;
module.exports.retryOnTransientError = retryOnTransientError;
module.exports.checkTestnetHealth = checkTestnetHealth;
module.exports.isTransientStellarError = isTransientStellarError;
