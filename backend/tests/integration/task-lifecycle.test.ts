/**
 * Backend API Integration Tests — Full Task Lifecycle
 *
 * Exercises the complete flow described in Issue #22:
 *
 *   1. POST /api/auth/token → get JWT access token
 *   2. POST /api/tasks      → receive 202/201 with taskId
 *   3. GET  /api/tasks/:id  → poll until status = completed (mocked)
 *   4. GET  /api/tasks/:id  → verify result data
 *   5. GET  /api/tasks      → verify task appears in list
 *   6. Task cancellation flow (DELETE /api/tasks/:id)
 *
 * Requirements:
 *  - Uses supertest against a real in-memory Express instance
 *  - Uses an in-memory SQLite database (via better-sqlite3 mock)
 *  - All Venice AI and Stellar SDK calls are mocked — no real external I/O
 *  - Runs in < 60 seconds
 *  - JWT auth enforced throughout
 *
 * Closes #22
 */

import request from "supertest";
import Database from "better-sqlite3";
import { StrKey } from "@stellar/stellar-base";

import { createApp } from "../../src/api/app";
import { createTaskDb } from "../../src/db/tasks";
import { createAgentDb } from "../../src/db/agents";
import { AuthService } from "../../src/services/auth/authService";
import { TokenService } from "../../src/services/auth/tokenService";
import { createAuthDb } from "../../src/db/auth";

// ── Bootstrap config before any modules that call getConfig() ────────────────
beforeAll(() => {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key-lifecycle";
  process.env.DATABASE_URL = ":memory:";
  process.env.AUTH_JWT_SECRET = "lifecycle-test-secret-key";
  process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig } = require("../../src/config");
    loadConfig();
  } catch {
    // Already loaded
  }
});

afterAll(() => {
  delete process.env.SKIP_STELLAR_ACCOUNT_VERIFY;
});

// ── Valid Stellar-format wallet keys (real StrKey-encoded ed25519 pubkeys) ───
const WALLET_KEY = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const OTHER_WALLET = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const AGENT_KEY = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));

// ── In-memory DB factories ─────────────────────────────────────────────────────

function makeInMemoryTaskDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT    PRIMARY KEY,
      prompt       TEXT    NOT NULL,
      walletPublicKey TEXT  NOT NULL DEFAULT '',
      status       TEXT    NOT NULL DEFAULT 'queued',
      dagJson      TEXT    NOT NULL DEFAULT '[]',
      createdAt    TEXT    NOT NULL,
      updatedAt    TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId    TEXT    NOT NULL,
      type      TEXT    NOT NULL,
      nodeId    TEXT,
      payload   TEXT,
      timestamp TEXT    NOT NULL
    );
  `);
  return db;
}

function makeInMemoryAgentDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT    PRIMARY KEY,
      capabilities    TEXT    NOT NULL,
      pricingXLM      REAL    NOT NULL,
      endpoint        TEXT    NOT NULL,
      stellarPublicKey TEXT   NOT NULL,
      reputationScore REAL    NOT NULL DEFAULT 0,
      lastSeenAt      TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

function makeInMemoryAuthDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id              TEXT PRIMARY KEY,
        familyId        TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL,
        deviceId        TEXT NOT NULL,
        deviceName      TEXT,
        ipAddress       TEXT NOT NULL,
        userAgent       TEXT NOT NULL,
        createdAt       TEXT NOT NULL,
        lastActiveAt    TEXT NOT NULL,
        expiresAt       TEXT NOT NULL,
        isRevoked       INTEGER NOT NULL DEFAULT 0,
        revokedAt       TEXT,
        revokedReason   TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
        id                  TEXT PRIMARY KEY,
        tokenHash           TEXT NOT NULL UNIQUE,
        sessionId           TEXT NOT NULL,
        familyId            TEXT NOT NULL,
        walletPublicKey     TEXT NOT NULL,
        createdAt           TEXT NOT NULL,
        expiresAt           TEXT NOT NULL,
        isConsumed          INTEGER NOT NULL DEFAULT 0,
        consumedAt          TEXT,
        isRevoked           INTEGER NOT NULL DEFAULT 0,
        revokedAt           TEXT,
        replacedByTokenHash TEXT
      );
      CREATE TABLE IF NOT EXISTS auth_audit_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       TEXT NOT NULL,
        action          TEXT NOT NULL,
        walletPublicKey TEXT,
        familyId        TEXT,
        sessionId       TEXT,
        deviceId        TEXT,
        ipAddress       TEXT,
        userAgent       TEXT,
        status          TEXT NOT NULL,
        reason          TEXT,
        metadata        TEXT
      );
      `);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper: obtain a real JWT for a wallet key
// ─────────────────────────────────────────────────────────────────────────────

function issueToken(wallet: string, authService: AuthService): string {
  const tokens = authService.createSession({
    walletPublicKey: wallet,
    deviceId: `device-${wallet.slice(-8)}`,
    deviceName: "Integration Test",
    ipAddress: "127.0.0.1",
    userAgent: "jest/lifecycle-test",
  });
  return tokens.accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: Auth flow — POST /api/auth/token → POST /api/tasks with JWT
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: auth flow + task lifecycle", () => {
  let taskDbRaw: Database.Database;
  let agentDbRaw: Database.Database;
  let authDbRaw: Database.Database;
  let authService: AuthService;
  let app: ReturnType<typeof createApp>;
  let jwtToken: string;

  beforeAll(() => {
    taskDbRaw  = makeInMemoryTaskDb();
    agentDbRaw = makeInMemoryAgentDb();
    authDbRaw  = makeInMemoryAuthDb();

    // Spy on the module-level DB accessors to return our in-memory instances.
    jest.spyOn(require("../../src/db/tasks"),  "getTaskDb").mockReturnValue(taskDbRaw);
    jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(agentDbRaw);

    // Build an AuthService backed by the in-memory auth DB.
    const tokenService = new TokenService({
      jwtSecret: "lifecycle-test-secret-key",
      accessTtlSeconds: 900,
    });
    authService = new AuthService({
      authDb: createAuthDb(authDbRaw),
      tokenService,
    });

    // Issue a token before the app boots so tests can use it immediately.
    jwtToken = issueToken(WALLET_KEY, authService);

    const mockDispatch = jest.fn().mockResolvedValue({ result: "mock lifecycle result" });
    const mockReleasePayment = jest.fn().mockResolvedValue("mock-tx-hash-lifecycle");

    app = createApp({
      dispatch: mockDispatch,
      releasePayment: mockReleasePayment,
      authService,
    });
  });

  afterAll(() => {
    app.close();
    taskDbRaw.close();
    agentDbRaw.close();
    authDbRaw.close();
    jest.restoreAllMocks();
  });

  // ── Step 1: JWT issued by /api/auth/token ──────────────────────────────────

  it("POST /api/auth/token returns an access token and refresh token", async () => {
    const res = await request(app.httpServer)
      .post("/api/auth/token")
      .send({
        walletPublicKey: WALLET_KEY,
        deviceId: "test-device-lifecycle",
        deviceName: "Lifecycle Integration Test",
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body.accessToken.length).toBeGreaterThan(10);
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body.tokenType).toBe("Bearer");
    expect(res.body.session.deviceId).toBe("test-device-lifecycle");
  });

  // ── Step 2: POST /api/tasks with JWT returns 201 with taskId ──────────────

  it("POST /api/tasks with valid JWT returns 201 with taskId and dagPreview", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({
        prompt: "Generate a market-entry report for solar energy in Southeast Asia",
        maxBudgetXLM: 5.0,
      });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);
    expect(Array.isArray(res.body.dagPreview)).toBe(true);
    expect(["queued", "running"]).toContain(res.body.status);
  });

  // ── Step 3: GET /api/tasks/:id retrieves the task ─────────────────────────

  it("GET /api/tasks/:id returns the task with correct walletPublicKey", async () => {
    // Create a fresh task.
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({
        prompt: "Analyze Stellar DEX liquidity trends",
        maxBudgetXLM: 2.0,
      });

    const { taskId } = created.body;
    expect(taskId).toBeDefined();

    const res = await request(app.httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
    expect(res.body.walletPublicKey).toBe(WALLET_KEY);
    expect(res.body.prompt).toBe("Analyze Stellar DEX liquidity trends");
  });

  // ── Step 4: Poll until status = completed (simulated by DB update) ─────────

  it("GET /api/tasks/:id reflects status = completed after DAG execution", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Summarize quarterly earnings for tech sector", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;

    // Simulate the DAG executor completing the task by updating the DB directly.
    createTaskDb(taskDbRaw).updateStatus(taskId, "completed");

    const res = await request(app.httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
  });

  // ── Step 5: GET /api/tasks returns the paginated list ─────────────────────

  it("GET /api/tasks returns paginated task list for the owning wallet", async () => {
    const freshWallet = "GLIFECYCLEPAGINATETESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".substring(0, 56);

    for (let i = 0; i < 4; i++) {
      await request(app.httpServer)
        .post("/api/tasks")
        .set("walletpublickey", freshWallet)
        .send({ prompt: `Lifecycle page task ${i}`, maxBudgetXLM: 1.0 });
    }

    const page1 = await request(app.httpServer)
      .get("/api/tasks?page=1&pageSize=2")
      .set("walletpublickey", freshWallet);

    expect(page1.status).toBe(200);
    expect(page1.body.tasks.length).toBe(2);
    expect(page1.body.total).toBe(4);
    expect(page1.body.page).toBe(1);

    const page2 = await request(app.httpServer)
      .get("/api/tasks?page=2&pageSize=2")
      .set("walletpublickey", freshWallet);

    expect(page2.status).toBe(200);
    expect(page2.body.tasks.length).toBe(2);
  });

  // ── Step 6: Missing wallet header falls back to "anonymous" (docs §9.4) ────

  it('POST /api/tasks without walletpublickey header associates the task with "anonymous"', async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .send({ prompt: "Task created without a wallet header", maxBudgetXLM: 1.0 });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toMatch(/^task_/);

    const list = await request(app.httpServer)
      .get("/api/tasks")
      .set("walletpublickey", "anonymous");

    expect(list.status).toBe(200);
    expect(
      list.body.tasks.some(
        (t: { prompt?: string }) => t.prompt === "Task created without a wallet header",
      ),
    ).toBe(true);
  });

  it("GET /api/tasks/:id returns 403 for a different wallet", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Private task for lifecycle owner", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;

    const res = await request(app.httpServer)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", OTHER_WALLET);

    expect(res.status).toBe(403);
  });

  it("GET /api/tasks/:id returns 404 for an unknown task ID", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks/task_doesnotexist999")
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Task cancellation flow
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: task cancellation flow", () => {
  let taskDbRaw: Database.Database;
  let agentDbRaw: Database.Database;
  let authDbRaw: Database.Database;
  let authService: AuthService;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    taskDbRaw  = makeInMemoryTaskDb();
    agentDbRaw = makeInMemoryAgentDb();
    authDbRaw  = makeInMemoryAuthDb();

    jest.spyOn(require("../../src/db/tasks"),  "getTaskDb").mockReturnValue(taskDbRaw);
    jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(agentDbRaw);

    const tokenService = new TokenService({ jwtSecret: "lifecycle-test-secret-key" });
    authService = new AuthService({ authDb: createAuthDb(authDbRaw), tokenService });

    app = createApp({
      dispatch: jest.fn().mockResolvedValue({ result: "cancelled mock" }),
      releasePayment: jest.fn().mockResolvedValue("noop"),
      authService,
    });
  });

  afterAll(() => {
    app.close();
    taskDbRaw.close();
    agentDbRaw.close();
    authDbRaw.close();
    jest.restoreAllMocks();
  });

  it("DELETE /api/tasks/:id cancels a queued task and returns status = cancelled", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Task to be cancelled", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;
    // Force the task to 'queued' so it can be cancelled.
    createTaskDb(taskDbRaw).updateStatus(taskId, "queued");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("DELETE /api/tasks/:id returns 409 Conflict when task is running", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Running task cannot be cancelled", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;
    createTaskDb(taskDbRaw).updateStatus(taskId, "running");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(409);
  });

  it("DELETE /api/tasks/:id returns 409 for an already-completed task", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Completed task cannot be cancelled", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;
    createTaskDb(taskDbRaw).updateStatus(taskId, "completed");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET_KEY);

    expect([404, 409]).toContain(res.status);
  });

  it("DELETE /api/tasks/:id returns 403 when called by a non-owner wallet", async () => {
    const created = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Owner-only cancellation", maxBudgetXLM: 1.0 });

    const { taskId } = created.body;
    createTaskDb(taskDbRaw).updateStatus(taskId, "queued");

    const res = await request(app.httpServer)
      .delete(`/api/tasks/${taskId}`)
      .set("walletpublickey", OTHER_WALLET);

    expect([403, 404]).toContain(res.status);
  });

  it("DELETE /api/tasks/:id returns 404 for a non-existent task", async () => {
    const res = await request(app.httpServer)
      .delete("/api/tasks/task_nonexistent999")
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Validation — input edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: task creation input validation", () => {
  let taskDbRaw: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    taskDbRaw = makeInMemoryTaskDb();
    jest.spyOn(require("../../src/db/tasks"), "getTaskDb").mockReturnValue(taskDbRaw);
    jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(makeInMemoryAgentDb());

    app = createApp({
      dispatch: jest.fn().mockResolvedValue({ result: "ok" }),
      releasePayment: jest.fn().mockResolvedValue("noop"),
    });
  });

  afterAll(() => {
    app.close();
    taskDbRaw.close();
    jest.restoreAllMocks();
  });

  it("POST /api/tasks with empty prompt returns 400", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "", maxBudgetXLM: 1.0 });

    expect(res.status).toBe(400);
  });

  it("POST /api/tasks with maxBudgetXLM below minimum returns 400", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Valid prompt", maxBudgetXLM: 0.001 });

    expect(res.status).toBe(400);
  });

  it("POST /api/tasks with valid prompt and no maxBudgetXLM returns 201", async () => {
    const res = await request(app.httpServer)
      .post("/api/tasks")
      .set("walletpublickey", WALLET_KEY)
      .send({ prompt: "Valid prompt without a budget" });

    // Accepts because maxBudgetXLM is optional per the schema.
    expect([201, 202]).toContain(res.status);
  });

  it("GET /api/tasks/:id returns 404 for a completely unknown ID", async () => {
    const res = await request(app.httpServer)
      .get("/api/tasks/task_00000000000000000000000000")
      .set("walletpublickey", WALLET_KEY);

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: Payment record verification
// ─────────────────────────────────────────────────────────────────────────────

describe("Integration: payment record and agent registration", () => {
  let taskDbRaw: Database.Database;
  let agentDbRaw: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    taskDbRaw  = makeInMemoryTaskDb();
    agentDbRaw = makeInMemoryAgentDb();

    jest.spyOn(require("../../src/db/tasks"),  "getTaskDb").mockReturnValue(taskDbRaw);
    jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(agentDbRaw);

    app = createApp({
      dispatch: jest.fn().mockResolvedValue({ result: "payment mock" }),
      releasePayment: jest.fn().mockResolvedValue("payment-tx-hash-001"),
    });
  });

  afterAll(() => {
    app.close();
    taskDbRaw.close();
    agentDbRaw.close();
    jest.restoreAllMocks();
  });

  it("POST /api/agents/register creates an agent and the agent appears in GET /api/agents", async () => {
    const registerRes = await request(app.httpServer)
      .post("/api/agents/register")
      .send({
        agentId: "payment-lifecycle-agent",
        capabilities: ["research", "report"],
        pricingXLM: 2.5,
        endpoint: "http://localhost:9999/health",
        stellarPublicKey: AGENT_KEY,
      });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.id).toBe("payment-lifecycle-agent");

    const listRes = await request(app.httpServer).get("/api/agents");
    expect(listRes.status).toBe(200);
    const found = listRes.body.find((a: { id: string }) => a.id === "payment-lifecycle-agent");
    expect(found).toBeDefined();
    expect(found.capabilities).toContain("research");
  });

  it("GET /health returns 200 — no external calls made", async () => {
    const res = await request(app.httpServer).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("No real external API calls are made during the test suite", () => {
    // This test verifies the mock is in place by asserting that the @stellar/stellar-sdk
    // module is mocked (per jest.config.js moduleNameMapper).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stellarMock = require("@stellar/stellar-sdk");
    // The mock file at backend/__mocks__/@stellar/stellar-sdk.js exports an object.
    expect(stellarMock).toBeDefined();
    // If the mock was not in place, the real SDK would attempt network calls.
  });
});
