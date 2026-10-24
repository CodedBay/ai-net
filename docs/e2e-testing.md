# End-to-End Testing Guide

This guide covers everything you need to run, write, debug, and maintain the E2E test suites for **ai-net**. It is aimed at new contributors and covers all four test layers: backend integration, smart-contract testnet pipeline, frontend Playwright, and CI automation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Running E2E Tests Locally](#3-running-e2e-tests-locally)
   - [3.1 Backend Integration E2E](#31-backend-integration-e2e)
   - [3.2 Smart-Contract Testnet E2E](#32-smart-contract-testnet-e2e)
   - [3.3 Frontend Playwright E2E](#33-frontend-playwright-e2e)
4. [Running E2E Tests in CI](#4-running-e2e-tests-in-ci)
   - [4.1 GitHub Actions Jobs](#41-github-actions-jobs)
   - [4.2 Required CI Secrets](#42-required-ci-secrets)
   - [4.3 Retry Strategy](#43-retry-strategy)
5. [Writing New E2E Test Cases](#5-writing-new-e2e-test-cases)
   - [5.1 Backend Integration Tests](#51-backend-integration-tests)
   - [5.2 Testnet Pipeline Tests](#52-testnet-pipeline-tests)
   - [5.3 Frontend Playwright Tests](#53-frontend-playwright-tests)
6. [Debugging Test Failures](#6-debugging-test-failures)
   - [6.1 Common Failure Modes](#61-common-failure-modes)
   - [6.2 Stellar Explorer & Network Tools](#62-stellar-explorer--network-tools)
   - [6.3 Log Output Interpretation](#63-log-output-interpretation)
7. [Expected Test Duration and Flakiness Handling](#7-expected-test-duration-and-flakiness-handling)

---

## 1. Overview

The ai-net E2E test framework exercises cross-cutting workflows end-to-end across four layers:

| Layer | What is tested | Runner |
|---|---|---|
| **Backend Integration** | REST API routes, DAG coordinator, SQLite persistence, WebSocket streaming, agent lifecycle | Jest (`tests/e2e/`) |
| **Smart-Contract Testnet** | Full 5-node market report DAG on Stellar testnet; Friendbot funding, escrow lock/release, Horizon verification | Jest (`smart-contracts/tests/e2e/`) |
| **Frontend Playwright** | Agent registry table, task submission wizard, wallet flow, i18n switching | Playwright (`frontend/tests/e2e/`) |
| **Docker-Compose Stack** | Full stack (local Stellar standalone + backend + frontend) smoke check | Docker Compose (`tests/e2e/docker-compose.test.yml`) |

The test framework uses a **Soroban Contract Emulator** (`tests/e2e/helpers.ts`) for backend tests so they run entirely in-process without a live blockchain. The `smart-contracts/tests/e2e/market-report.test.ts` suite is the only test that requires a real Stellar testnet connection; it is opt-in via `RUN_STELLAR_E2E_TESTS=true`.

---

## 2. Prerequisites

### 2.1 Software Requirements

- **Node.js** ≥ 20 (v24 recommended — matches CI)
- **npm** ≥ 10
- **Docker** ≥ 24 and **Docker Compose** ≥ 2.20 (required for the local Stellar stack and Docker-backed E2E runs)
- **Rust** stable toolchain with `wasm32v1-none` target (for smart-contract tests only)

Install the Wasm target if running smart-contract tests:
```bash
rustup target add wasm32v1-none
```

### 2.2 Environment Variables

Copy and fill the example env files before running any E2E suite:

```bash
# Root-level env (for backend integration tests)
cp .env.example .env

# Smart-contracts env (for testnet E2E)
cp smart-contracts/.env.example smart-contracts/.env
```

#### Backend integration tests (`.env`)

| Variable | Required | Description |
|---|---|---|
| `SKIP_STELLAR_ACCOUNT_VERIFY` | Yes (for local) | Set to `true` to bypass Stellar account existence checks against Horizon |
| `REGISTRY_CONTRACT_ID` | No | Override contract ID (tests set a mock value automatically) |
| `ERROR_RESOLVER_CONTRACT_ID` | No | Override contract ID (tests set a mock value automatically) |

#### Smart-contract testnet E2E (`smart-contracts/.env`)

| Variable | Required | Description |
|---|---|---|
| `RUN_STELLAR_E2E_TESTS` | **Yes** | Must be `true` to opt into the testnet pipeline test |
| `STELLAR_COORDINATOR_SECRET` | Recommended | Ed25519 secret key for the coordinator Stellar account. If omitted, a random keypair is generated and funded via Friendbot |
| `VENICE_API_KEY` | Yes (for real LLM) | Venice AI API key. The testnet E2E test uses a deterministic fallback for report generation if the key is absent or Venice is unavailable |
| `STELLAR_HORIZON_URL` | No | Defaults to `https://horizon-testnet.stellar.org` |
| `STELLAR_NETWORK` | No | Defaults to `testnet` |

#### Funding testnet accounts

If you supply a `STELLAR_COORDINATOR_SECRET`, fund the account at least once:

```bash
# Using Stellar Laboratory
open https://laboratory.stellar.org/#account-creator?network=testnet

# Or via Friendbot directly
curl "https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>"
```

> **Friendbot rate limit**: Friendbot allows one funding request per account. If an account is already funded, repeat calls return HTTP 400 and are silently ignored by the test setup. Do not use Friendbot in tight loops.

### 2.3 Install Dependencies

```bash
# Root workspace
npm install

# Backend
cd backend && npm ci && cd ..

# Frontend
cd frontend && npm ci && cd ..

# Smart contracts
cd smart-contracts && npm ci && cd ..
```

---

## 3. Running E2E Tests Locally

### 3.1 Backend Integration E2E

The backend integration tests run entirely in-process and do not require Docker or a live Stellar node. They use the Soroban Contract Emulator in `tests/e2e/helpers.ts` to emulate on-chain state.

#### Run all backend E2E scenarios

```bash
npm run test:e2e
```

This runs the full `tests/e2e/` Jest suite which covers:

- **Scenario A** (`scenario-a-registration.test.ts`) — Agent registration flow: `POST /api/agents/register`, on-chain state sync, `GET /api/agents`
- **Scenario B** (`scenario-b-task-lifecycle.test.ts`) — Task lifecycle: multi-stage DAG creation, coordinator assignment, error recording
- **Scenario C** (`scenario-c-agent-removal.test.ts`) — Agent removal cascades: deregistration from backend DB and on-chain emulator, error cleanup
- **Full Pipeline** (`full-pipeline.test.ts`) — Complete 5-node DAG (research → risk → coding → design → report) with mock payment releases and section validation
- **Agent Lifecycle** (`agent-lifecycle.test.ts`) — Heartbeat expiry, status transitions, and re-registration

#### With coverage report

```bash
npm run test:e2e:coverage
```

HTML coverage output is generated under `coverage-e2e/`.

#### Run a single scenario

```bash
cd backend
npx jest --config ../tests/e2e/jest.config.js --runInBand --forceExit \
  --testPathPattern="scenario-a-registration"
```

#### Using Docker Compose (local Stellar standalone)

To spin up a local Stellar standalone node alongside the backend:

```bash
docker compose -f tests/e2e/docker-compose.test.yml up -d
```

Wait for the Soroban RPC to be ready (check `http://localhost:8000/soroban/rpc`), then run:

```bash
npm run test:e2e
```

Tear down after testing:
```bash
docker compose -f tests/e2e/docker-compose.test.yml down -v
```

### 3.2 Smart-Contract Testnet E2E

The testnet pipeline test (`smart-contracts/tests/e2e/market-report.test.ts`) runs a **real** 5-node market report DAG against Stellar testnet. It funds fresh accounts via Friendbot, locks escrow, executes agents, releases payments, and validates the final report via Horizon.

**Expected duration: 60–120 seconds.**

```bash
cd smart-contracts
cp .env.example .env
# Edit .env: set RUN_STELLAR_E2E_TESTS=true
# Optionally set STELLAR_COORDINATOR_SECRET and VENICE_API_KEY

npm run test:e2e
```

The `jest.setTimeout` is set to 120 000 ms for this suite. If you see timeout errors, check Stellar testnet latency at [https://stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet).

> **Note**: The testnet E2E uses a deterministic fallback report agent when `VENICE_API_KEY` is absent or Venice returns an error, so basic pipeline validation still passes. The LLM-generated report section is replaced by a canned fixture.

### 3.3 Frontend Playwright E2E

The frontend E2E tests use [Playwright](https://playwright.dev/) and run against a local `vite dev` server (started automatically by the Playwright config).

#### Install browsers (first-time setup)

```bash
cd frontend
npx playwright install --with-deps chromium
```

#### Run all frontend E2E tests

```bash
cd frontend
npm run test:e2e
```

#### Run a specific spec file

```bash
cd frontend
npx playwright test tests/e2e/agent-registry.spec.ts --reporter=html
```

#### View Playwright HTML report

```bash
cd frontend
npx playwright show-report
```

Available spec files:

| File | Coverage |
|---|---|
| `agent-registry.spec.ts` | Agent registry table: listing, filtering, hire CTA |
| `task-submission.spec.ts` | Task submission wizard: DAG preview, cost estimate, submit |
| `task-monitoring.spec.ts` | WebSocket task status updates, progress indicator |
| `wallet.spec.ts` | Wallet wizard: connect, send XLM form, transaction table |
| `i18n.spec.ts` | Language switching (English / Spanish / French) |

---

## 4. Running E2E Tests in CI

### 4.1 GitHub Actions Jobs

E2E tests are defined in `.github/workflows/ci.yml` and run automatically on every push to `main` and on all pull requests (path-filtered for efficiency).

| Job | Trigger condition | Description |
|---|---|---|
| `e2e-backend-smoke` | PR touching `backend/**`, `tests/e2e/**`, `smart-contracts/**`; always on `main` | Runs `scenario-a-registration` only. Fast (~2 min). Required. |
| `e2e-backend-heavy` | Same as smoke | Runs `scenario-b`, `scenario-c`, `full-pipeline`, `agent-lifecycle`. Slower (~10 min). Required. |
| `e2e-frontend-smoke` | PR touching `frontend/**`; always on `main` | Playwright: `agent-registry.spec.ts` + `task-submission.spec.ts`. Chromium only. |
| `e2e-frontend-heavy` | Same as frontend-smoke | Playwright: `task-monitoring.spec.ts` + `wallet.spec.ts` + `i18n.spec.ts`. Chromium + Firefox. |
| `contracts-integration` | Push to `main` or manual dispatch only | Smart-contract testnet E2E. Requires `STELLAR_COORDINATOR_SECRET` and `VENICE_API_KEY` secrets. `continue-on-error: true`. |

All jobs except `contracts-integration` are required by the `ci-gate` job. A skipped job (due to path filtering) counts as success.

#### Step-by-step CI flow for a backend PR

1. `changes` job detects modified paths via `dorny/paths-filter`.
2. `backend` job runs unit tests and build.
3. `e2e-backend-smoke` and `e2e-backend-heavy` run in parallel, each with up to 3 retry attempts.
4. `ci-gate` evaluates all required jobs; PR can merge only when it passes.

### 4.2 Required CI Secrets

Configure these in your GitHub repository → Settings → Secrets and variables → Actions:

| Secret | Used by | How to obtain |
|---|---|---|
| `STELLAR_TEST_SECRET` | `e2e-backend-smoke`, `e2e-backend-heavy` | Any valid Stellar keypair (does not need to be funded for backend-only tests) |
| `VENICE_API_KEY` | `contracts-integration` | [venice.ai](https://venice.ai) API key |
| `STELLAR_COORDINATOR_SECRET` | `contracts-integration` | Funded Stellar testnet keypair. Create at [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=testnet) |

For backend integration tests, `STELLAR_TEST_SECRET` is only used as an env var placeholder; account verification is disabled via `SKIP_STELLAR_ACCOUNT_VERIFY: "true"` in the workflow.

### 4.3 Retry Strategy

Backend and frontend E2E jobs use [`nick-fields/retry@v3`](https://github.com/nick-fields/retry) for automatic retries:

```yaml
- uses: nick-fields/retry@v3
  with:
    timeout_minutes: 12
    max_attempts: 3
    retry_wait_seconds: 10
    command: cd backend && npx jest ...
```

This handles transient failures due to:
- Race conditions in async task state polling
- Port binding conflicts from parallel test runners
- Occasional Horizon or Friendbot unavailability (for testnet jobs)

If a job fails all 3 attempts, inspect the uploaded test result JSON artifact (`test-results-backend-smoke-<run_id>-<attempt>`) for the exact failure.

---

## 5. Writing New E2E Test Cases

### 5.1 Backend Integration Tests

Create a new test file in `tests/e2e/` following the naming convention:

```
scenario-<letter>-<short-description>.test.ts
```

**Minimal test skeleton:**

```typescript
// tests/e2e/scenario-d-my-feature.test.ts
import type { Server as HttpServer } from 'http';
import supertest from 'supertest';
import {
  createTestApp,
  onChainContracts,
  createE2ETestKeypair,
  signChallenge,
} from './helpers';

let request: ReturnType<typeof supertest>;
let closeApp: () => void;

beforeAll((done) => {
  // Reset on-chain state
  onChainContracts.initialize();

  const { app, request: req, close } = createTestApp();
  closeApp = close;
  request = req;

  app.httpServer.listen(0, '127.0.0.1', done);
}, 15_000);

afterAll((done) => {
  closeApp();
  onChainContracts.clearAll();
  done();
});

describe('Scenario D: My Feature', () => {
  it('does something expected', async () => {
    const res = await request
      .post('/api/some-endpoint')
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY')
      .send({ field: 'value' });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });
});
```

**Key helpers from `tests/e2e/helpers.ts`:**

| Helper | Purpose |
|---|---|
| `createTestApp()` | Creates backend app instance with Stellar verification disabled |
| `onChainContracts.registerAgent(record)` | Register an agent in the in-process on-chain emulator |
| `onChainContracts.lookupAgent(id)` | Look up a registered agent by ID |
| `onChainContracts.clearAll()` | Reset all emulator state between test suites |
| `createE2ETestKeypair()` | Generate a test Stellar keypair |
| `signChallenge(keypair, challenge)` | Sign an auth challenge string |
| `MOCK_CONTRACT_IDS` | Stable mock contract addresses for env configuration |

### 5.2 Testnet Pipeline Tests

Add new testnet pipeline scenarios in `smart-contracts/tests/e2e/`. New tests should:

1. Use `describe.skip` wrapped in a `const describeE2E = process.env.RUN_STELLAR_E2E_TESTS === 'true' ? describe : describe.skip` pattern to opt in.
2. Set `jest.setTimeout(120_000)` at the top of the file.
3. Use `fundWithFriendbot()` from the existing test for account setup.
4. Release payments via `releasePayment()` from `src/payment/payment.ts`.
5. Validate results with Zod schemas.

```typescript
// smart-contracts/tests/e2e/my-scenario.test.ts
const describeE2E =
  process.env.RUN_STELLAR_E2E_TESTS === 'true' ? describe : describe.skip;

jest.setTimeout(120_000);

describeE2E('My scenario on Stellar testnet', () => {
  // ...
});
```

### 5.3 Frontend Playwright Tests

Add new Playwright spec files in `frontend/tests/e2e/`:

```typescript
// frontend/tests/e2e/my-feature.spec.ts
import { test, expect } from '@playwright/test';

test('page loads correctly', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
```

Use `page.waitForSelector()` and `page.waitForResponse()` for async operations. The Playwright config (`playwright.config.ts`) starts `vite dev` automatically as a web server with a 30-second startup timeout.

For WebSocket tests, increase the per-test timeout:

```typescript
test('receives task update over WebSocket', async ({ page }) => {
  test.setTimeout(60_000);
  // ...
});
```

---

## 6. Debugging Test Failures

### 6.1 Common Failure Modes

#### `TIMEOUT` / `tx_too_late` from Stellar Horizon

**Symptom**: `HorizonUnavailableError` after 5 retries, or `tx_too_late` in Horizon extras.

**Cause**: Stellar testnet congestion or Horizon lag. Transactions expire after the sequence number advances too far.

**Fix**: Reduce the `setTimeout` value in `TransactionBuilder` or increase the retry backoff. Check testnet health at [Stellar Status](https://status.stellar.org/).

#### Friendbot 400 / account already funded

**Symptom**: Friendbot returns HTTP 400 with `"createAccountAlreadyExist"`.

**Cause**: The keypair was already funded in a previous run. Friendbot can only fund each account once.

**Fix**: This is expected and safe — `fundWithFriendbot()` in the test setup silently swallows HTTP 400 responses. If the account balance is zero despite being funded before, the account may have been merged. Generate a new keypair.

#### `Task <id> did not reach status "completed"` in full-pipeline test

**Symptom**: `pollUntilStatus` times out at 120 seconds.

**Cause**: A DAG node agent threw an error that wasn't caught, or the coordinator's worker queue stalled.

**Fix**:
1. Enable verbose Jest output: `npx jest --verbose`
2. Check for `[worker]` errors in stdout — worker errors are printed to `process.stderr`
3. Run the single failing test in isolation with `--testNamePattern`

#### Playwright `Timeout 30000ms exceeded` waiting for element

**Cause**: The Vite dev server did not start within 30 seconds, or the backend API returned an unexpected status.

**Fix**:
1. Start the backend manually first: `cd backend && npm run dev`
2. Set `VITE_API_URL` in `frontend/.env` to point to your backend
3. Increase `webServer.timeout` in `playwright.config.ts` if startup is slow

#### Port already in use

**Symptom**: `Error: listen EADDRINUSE :::3000`

**Cause**: A previous test run left the server running (crash without cleanup).

**Fix**:
```bash
# Find and kill the process
lsof -ti :3000 | xargs kill -9
```

The backend E2E tests use `listen(0, '127.0.0.1')` (OS-assigned port) to avoid this in CI.

### 6.2 Stellar Explorer & Network Tools

| Tool | URL | Purpose |
|---|---|---|
| **Stellar Explorer (Testnet)** | [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet) | Browse accounts, transactions, operations on testnet |
| **Stellar Laboratory** | [laboratory.stellar.org](https://laboratory.stellar.org/#?network=testnet) | Build transactions, inspect XDR, fund accounts |
| **Friendbot** | `https://friendbot.stellar.org/?addr=<PUBLIC_KEY>` | Fund testnet accounts with 10,000 XLM |
| **Horizon Testnet** | `https://horizon-testnet.stellar.org` | REST API for accounts, payments, transactions |
| **Soroban RPC Testnet** | `https://soroban-testnet.stellar.org` | Soroban-specific RPC endpoint |
| **Stellar Status** | [status.stellar.org](https://status.stellar.org/) | Testnet health and incident reports |

To inspect a payment transaction from the E2E tests:

```bash
# Look up account payments via Horizon
curl "https://horizon-testnet.stellar.org/accounts/<COORDINATOR_PUBLIC_KEY>/payments?order=desc&limit=10" | jq .
```

### 6.3 Log Output Interpretation

Backend E2E test logs include structured Pino JSON output when `NODE_ENV=test`. Key log fields:

| Field | Meaning |
|---|---|
| `level` | `30` = info, `40` = warn, `50` = error |
| `taskId` | Task being processed |
| `nodeId` | DAG node (e.g. `node_research`) |
| `msg` | Human-readable event description |
| `err.message` | Error details (on error-level logs) |

To print pretty logs during debugging:

```bash
NODE_ENV=test npx jest --runInBand 2>&1 | \
  npx pino-pretty --colorize --translateTime
```

For Playwright visual debugging, use headed mode:

```bash
cd frontend
npx playwright test --headed --slowMo=500
```

To capture a Playwright trace for a failing test:

```bash
npx playwright test --trace=on
npx playwright show-trace test-results/<test-name>/trace.zip
```

---

## 7. Expected Test Duration and Flakiness Handling

### Duration Estimates

| Suite | Local | CI |
|---|---|---|
| Backend smoke (`scenario-a` only) | ~15–30 seconds | ~2–4 minutes (with startup + retry overhead) |
| Backend heavy (full lifecycle) | ~45–90 seconds | ~5–12 minutes |
| Smart-contract testnet E2E | **60–120 seconds** | ~3–6 minutes (+ Friendbot/Horizon latency) |
| Frontend smoke Playwright | ~30–60 seconds | ~3–5 minutes |
| Frontend heavy Playwright | ~60–90 seconds | ~5–8 minutes |

The testnet E2E duration depends heavily on Stellar testnet congestion. In quiet periods it finishes in ~60 seconds; under high load it can reach the 120-second Jest timeout.

### Flakiness Sources and Mitigations

| Source | Mitigation |
|---|---|
| Stellar testnet Horizon lag | 5-attempt exponential-backoff retry in `withRetry()` in `payment.ts`; CI outer retry via `nick-fields/retry` (3 attempts) |
| Friendbot rate limits | `fundWithFriendbot()` catches HTTP 400 and treats it as success |
| Port conflicts in parallel CI | Backend tests use `listen(0)` for OS-assigned ports |
| React state updates in Playwright | All Playwright assertions use auto-retry built into `expect().toBeVisible()` etc. |
| WebSocket race conditions | Playwright WebSocket tests have `test.setTimeout(60_000)` and use `page.waitForResponse()` |
| DAG polling timeout | `pollUntilStatus()` has a configurable `timeoutMs` (default 120 s); increase for slow CI runners |

### Marking a Test as Known-Flaky

If a test is intermittently flaky and not yet fixed, mark it with `test.fixme` (Playwright) or `it.skip` (Jest) and link a tracking issue:

```typescript
// Jest
it.skip('flaky: tracked in #123', async () => { ... });

// Playwright
test.fixme('flaky: tracked in #123', async ({ page }) => { ... });
```

Do not commit permanently skipped tests without a linked issue.

---

## See Also

- [Developer Setup Guide](DEVELOPER_SETUP.md) — environment setup from scratch
- [Architecture Specification](architecture/index.md) — system context and component architecture
- [Smart Contract Deployment Guide](../smart-contracts/docs/DEPLOYMENT_GUIDE.md) — deploying contracts to testnet
- [Frontend Visual Regression Testing](visual-regression-testing.md) — screenshot-based regression tests
- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR workflow and quality gate commands
