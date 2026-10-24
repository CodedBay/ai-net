/**
 * Jest `setupFiles` for the E2E project — runs before any module (including
 * helpers.ts → createApp → rateLimit.ts) is loaded.
 *
 * The E2E suites share module-level limiter singletons and poll task status in
 * tight loops from a single wallet/IP, so the defaults (20/min global,
 * 30/min authenticated) would trip 429s long before the application logic is
 * exercised. Raise the ceilings here — module-scope singletons read
 * `process.env` when they are first created, which happens during the import
 * of the test module only after this file has run.
 */
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS ?? '100000';
process.env.RATE_LIMIT_AUTHED_MAX_REQUESTS =
  process.env.RATE_LIMIT_AUTHED_MAX_REQUESTS ?? '100000';
process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS =
  process.env.RATE_LIMIT_PUBLIC_MAX_REQUESTS ?? '100000';
