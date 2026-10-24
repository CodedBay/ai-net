/**
 * Jest `setupFiles` — runs before any test module (and before tests/jestSetup.ts)
 * is evaluated, so `config` is first loaded with these values applied.
 *
 * The full Express app mounts a global IP-keyed limiter driven by
 * RATE_LIMIT_MAX_REQUESTS (default 20/min). Test suites routinely issue
 * hundreds of requests from the same loopback IP, so the ceiling is raised
 * here to keep suites focused on behaviour rather than incidental limiter
 * trips. Behavioural 429 coverage uses the per-wallet daily task quota
 * (DAILY_TASK_LIMIT_PER_WALLET) and the group limiters, which are untouched:
 * rateLimit.test.ts asserts their defaults (100/30/20/10).
 */
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS ?? '100000';
process.env.REGISTER_RATE_LIMIT_MAX_REQUESTS =
  process.env.REGISTER_RATE_LIMIT_MAX_REQUESTS ?? '100000';
