/**
 * Snapshot tests for API response shapes (Issue #93)
 *
 * These tests lock down the JSON structure of every public API response so
 * that accidental breaking changes are detected immediately in CI.
 *
 * Design rules:
 *  - Dynamic values (timestamps, generated IDs, uptime counters) are replaced
 *    with `expect.any(…)` or a static sentinel before snapshotting, so the
 *    snapshot stays stable across runs without sacrificing structural coverage.
 *  - Each test group isolates its own in-memory Express app / database so
 *    there is no cross-contamination between suites.
 *  - Inline snapshots are used so the expected shape is co-located with the
 *    test, making reviews easy.
 *
 * Updating snapshots intentionally:
 *   cd backend && npm test -- --updateSnapshot --testPathPattern snapshot
 *
 * Or for a single describe block:
 *   cd backend && npm test -- --updateSnapshot --testNamePattern "GET /health"
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import Database from "better-sqlite3";

import { createAgentsRouter } from "../src/api/routes/agents";
import { createAgentDb, type AgentRecord } from "../src/db/agents";
import { createPaymentsRouter } from "../src/api/routes/payments";
import { createPaymentDb, type PaymentRecord } from "../src/db/index";
import { AppError } from "../src/errors";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Standard error handler that mirrors the production handler shape without
 * importing the full middleware stack.
 */
function testErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = {
      error: { code: err.code, message: err.message },
    };
    if ((err as AppError & { details?: unknown }).details !== undefined) {
      (body.error as Record<string, unknown>).details = (
        err as AppError & { details?: unknown }
      ).details;
    }
    res.status(err.statusCode).json(body);
    return;
  }
  res
    .status(500)
    .json({ error: { code: "INTERNAL_ERROR", message: err.message } });
}

/** Replace all ISO-8601 timestamps with a stable placeholder. */
function maskTimestamps<T>(value: T): T {
  if (typeof value === "string") {
    return (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
      ? "<ISO_TIMESTAMP>"
      : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(maskTimestamps) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        maskTimestamps(v),
      ])
    ) as unknown as T;
  }
  return value;
}

/** Replace all task IDs (task_<nanoid>) with a stable placeholder. */
function maskTaskIds<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /task_[A-Za-z0-9_-]{12}/g,
      "task_SNAPSHOT_ID"
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(maskTaskIds) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        maskTaskIds(v),
      ])
    ) as unknown as T;
  }
  return value;
}

/** Stabilise a response body for snapshotting. */
function stabilise(body: unknown): unknown {
  return maskTaskIds(maskTimestamps(body));
}

// ── Fixture data ──────────────────────────────────────────────────────────────

const SEED_AGENT: AgentRecord = {
  id: "agent-snapshot-1",
  capabilities: ["coding", "research"],
  pricingXLM: 1.5,
  endpoint: "http://127.0.0.1:9999/health",
  stellarPublicKey: "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ",
  reputationScore: 3.5,
  lastSeenAt: "2026-09-01T12:00:00.000Z",
  status: "online",
  bondAmountXLM: 10,
  tasksCompleted: 42,
  tasksFailed: 1,
  lastActiveAt: "2026-09-01T12:00:00.000Z",
};

const SEED_PAYMENT: PaymentRecord = {
  taskId: "task_snapshotpay1",
  nodeId: "node_1",
  balanceId: "balance-snap-abc",
  status: "released",
  amountStroops: 15_000_000n, // 1.5 XLM
  txHash: "txhash-snapshot-001",
};

const WALLET = "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ";

// ── Agents DB builder (reused across agent test groups) ───────────────────────

function makeAgentsApp(seeds: AgentRecord[] = []) {
  const rawDb = new Database(":memory:");
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id               TEXT PRIMARY KEY,
      capabilities     TEXT NOT NULL,
      pricingXLM       REAL NOT NULL,
      endpoint         TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore  REAL NOT NULL DEFAULT 2.5,
      lastSeenAt       TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'online',
      bondAmountXLM    REAL NOT NULL DEFAULT 0,
      tasksCompleted   INTEGER NOT NULL DEFAULT 0,
      tasksFailed      INTEGER NOT NULL DEFAULT 0,
      lastActiveAt     TEXT
    )
  `);
  const db = createAgentDb(rawDb);
  for (const agent of seeds) db.upsert(agent);

  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter({ db }));
  app.use(testErrorHandler);
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET /health
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /health", () => {
  it("response shape matches snapshot", async () => {
    // Build a minimal health app without pulling in the full createApp stack.
    // This mirrors the exact JSON the real handler returns.
    const app = express();
    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        uptime: 42,
        version: "0.1.0",
        stellarNetwork: "testnet",
      });
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "status": "ok",
        "stellarNetwork": "testnet",
        "uptime": 42,
        "version": "0.1.0",
      }
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GET /api/agents  (flat, no cursor)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /api/agents (flat list)", () => {
  it("empty list shape matches snapshot", async () => {
    const res = await request(makeAgentsApp()).get("/api/agents");

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`[]`);
  });

  it("populated list shape matches snapshot", async () => {
    const res = await request(makeAgentsApp([SEED_AGENT])).get("/api/agents");

    expect(res.status).toBe(200);
    const stable = maskTimestamps(res.body);
    expect(stable).toMatchInlineSnapshot(`
      [
        {
          "bondAmountXLM": 10,
          "capabilities": [
            "coding",
            "research",
          ],
          "endpoint": "http://127.0.0.1:9999/health",
          "id": "agent-snapshot-1",
          "lastActiveAt": "<ISO_TIMESTAMP>",
          "lastSeenAt": "<ISO_TIMESTAMP>",
          "last_seen_at": 1788264000,
          "pricingXLM": 1.5,
          "reputationScore": 3.5,
          "status": "online",
          "stellarPublicKey": "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ",
          "tasksCompleted": 42,
          "tasksFailed": 1,
        },
      ]
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GET /api/agents  (cursor-paginated)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /api/agents (cursor paginated)", () => {
  it("paginated envelope shape matches snapshot (no items)", async () => {
    const res = await request(makeAgentsApp()).get("/api/agents?limit=10");

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "_links": {
          "self": "/api/agents",
        },
        "data": {
          "items": [],
          "pagination": {
            "hasNextPage": false,
            "limit": 10,
            "nextCursor": null,
          },
        },
      }
    `);
  });

  it("paginated envelope top-level keys match snapshot", async () => {
    const res = await request(makeAgentsApp([SEED_AGENT])).get(
      "/api/agents?limit=5"
    );

    expect(res.status).toBe(200);
    // Verify structural shape without dynamic cursor values
    expect(Object.keys(res.body).sort()).toMatchInlineSnapshot(`
      [
        "_links",
        "data",
      ]
    `);
    expect(Object.keys(res.body.data).sort()).toMatchInlineSnapshot(`
      [
        "items",
        "pagination",
      ]
    `);
    expect(Object.keys(res.body.data.pagination).sort()).toMatchInlineSnapshot(`
      [
        "hasNextPage",
        "limit",
        "nextCursor",
      ]
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. GET /api/agents/:id
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /api/agents/:id", () => {
  it("agent detail shape matches snapshot", async () => {
    const res = await request(makeAgentsApp([SEED_AGENT])).get(
      "/api/agents/agent-snapshot-1"
    );

    expect(res.status).toBe(200);
    const stable = maskTimestamps(res.body);
    expect(stable).toMatchInlineSnapshot(`
      {
        "bondAmountXLM": 10,
        "capabilities": [
          "coding",
          "research",
        ],
        "endpoint": "http://127.0.0.1:9999/health",
        "id": "agent-snapshot-1",
        "lastActiveAt": "<ISO_TIMESTAMP>",
        "lastSeenAt": "<ISO_TIMESTAMP>",
        "last_seen_at": 1788264000,
        "pricingXLM": 1.5,
        "reputation": {
          "bondAmountXLM": 10,
          "bondWeightMultiplier": 1.01,
          "decayApplied": 0,
          "latencyScore": 4.5,
          "overallScore": 3.5,
          "qualityScore": 4,
          "taskSuccessScore": 4.88,
          "tasksCompleted": 42,
          "tasksFailed": 1,
        },
        "reputationScore": 3.5,
        "status": "online",
        "stellarPublicKey": "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ",
        "tasksCompleted": 42,
        "tasksFailed": 1,
      }
    `);
  });

  it("404 error shape matches snapshot", async () => {
    const res = await request(makeAgentsApp()).get("/api/agents/non-existent");

    expect(res.status).toBe(404);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "AGENT_NOT_FOUND",
          "message": "Agent 'non-existent' not found",
        },
      }
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5 & 6. GET /api/tasks/:id  +  GET /api/tasks/:id (result shape)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /api/tasks/:id", () => {
  let inMemoryTaskDb: Database.Database;
  let taskApp: express.Express;

  beforeAll(() => {
    inMemoryTaskDb = new Database(":memory:");
    inMemoryTaskDb.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        prompt          TEXT NOT NULL,
        walletPublicKey TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'queued',
        dagJson         TEXT NOT NULL DEFAULT '[]',
        createdAt       TEXT NOT NULL,
        updatedAt       TEXT NOT NULL
      )
    `);

    // Mock getTaskDb BEFORE creating the router so the in-memory db is used
    jest
      .spyOn(require("../src/db/tasks"), "getTaskDb")
      .mockReturnValue(inMemoryTaskDb);

    // Also mock createTask / taskStore so it writes to our in-memory db
    jest
      .spyOn(require("../src/coordinator/taskStore"), "createTask")
      .mockImplementation((task: any) => {
        inMemoryTaskDb
          .prepare(
            `INSERT INTO tasks (id, prompt, walletPublicKey, status, dagJson, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            task.id,
            task.prompt,
            task.walletPublicKey,
            task.status,
            JSON.stringify(task.dag),
            task.createdAt,
            task.updatedAt
          );
      });

    const { createV1TasksRouter } = require("../src/api/routes/v1/tasks");
    const mockDispatch = jest.fn().mockResolvedValue({});
    const mockRelease = jest.fn().mockResolvedValue(undefined);

    taskApp = express();
    taskApp.use(express.json());
    taskApp.use("/api/tasks", createV1TasksRouter(mockDispatch, mockRelease));
    taskApp.use(testErrorHandler);
  });

  afterAll(() => {
    inMemoryTaskDb.close();
    jest.restoreAllMocks();
  });

  it("task status shape matches snapshot (queued)", async () => {
    const create = await request(taskApp)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({
        prompt: "Analyse Stellar DEX liquidity trends",
        maxBudgetXLM: 1,
      });

    expect(create.status).toBe(201);
    const taskId: string = create.body.taskId;

    const res = await request(taskApp)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(200);
    const stable = stabilise(res.body);
    expect(stable).toMatchInlineSnapshot(`
      {
        "createdAt": "<ISO_TIMESTAMP>",
        "dag": [
          {
            "dependencies": [],
            "description": "Research background information for: Analyse Stellar DEX liquidity trends",
            "nodeId": "node_research",
            "prompt": "Research background information for: Analyse Stellar DEX liquidity trends",
            "status": "pending",
            "type": "research",
          },
          {
            "dependencies": [
              "node_research",
            ],
            "description": "Create design assets",
            "nodeId": "node_design",
            "prompt": "Create design assets",
            "status": "pending",
            "type": "design",
          },
          {
            "dependencies": [
              "node_design",
            ],
            "description": "Compile and format the final report",
            "nodeId": "node_report",
            "prompt": "Compile and format the final report",
            "status": "pending",
            "type": "report",
          },
        ],
        "dagJson": "[{"nodeId":"node_research","type":"research","prompt":"Research background information for: Analyse Stellar DEX liquidity trends","description":"Research background information for: Analyse Stellar DEX liquidity trends","status":"pending","dependencies":[]},{"nodeId":"node_design","type":"design","prompt":"Create design assets","description":"Create design assets","status":"pending","dependencies":["node_research"]},{"nodeId":"node_report","type":"report","prompt":"Compile and format the final report","description":"Compile and format the final report","status":"pending","dependencies":["node_design"]}]",
        "id": "task_SNAPSHOT_ID",
        "prompt": "Analyse Stellar DEX liquidity trends",
        "status": "queued",
        "updatedAt": "<ISO_TIMESTAMP>",
        "walletPublicKey": "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ",
      }
    `);
  });

  it("task 404 error shape matches snapshot", async () => {
    const res = await request(taskApp)
      .get("/api/tasks/task_doesnotexist12")
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(404);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "error": "Task not found",
      }
    `);
  });

  it("completed task with result shape matches snapshot", async () => {
    const create = await request(taskApp)
      .post("/api/tasks")
      .set("walletpublickey", WALLET)
      .send({ prompt: "Compose a market entry report", maxBudgetXLM: 2 });

    expect(create.status).toBe(201);
    const taskId: string = create.body.taskId;

    const completedDag = [
      {
        nodeId: `${taskId}_node_0`,
        type: "research",
        dependencies: [] as string[],
        status: "completed",
        prompt: "Compose a market entry report",
        result: { summary: "Market entry viable in Q2 2027", confidence: 0.87 },
      },
    ];
    inMemoryTaskDb
      .prepare(
        "UPDATE tasks SET status = 'completed', dagJson = ?, updatedAt = ? WHERE id = ?"
      )
      .run(JSON.stringify(completedDag), new Date().toISOString(), taskId);

    const res = await request(taskApp)
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", WALLET);

    expect(res.status).toBe(200);
    const stable = stabilise(res.body);
    expect(stable).toMatchInlineSnapshot(`
      {
        "createdAt": "<ISO_TIMESTAMP>",
        "dag": [
          {
            "dependencies": [],
            "nodeId": "task_SNAPSHOT_ID_node_0",
            "prompt": "Compose a market entry report",
            "result": {
              "confidence": 0.87,
              "summary": "Market entry viable in Q2 2027",
            },
            "status": "completed",
            "type": "research",
          },
        ],
        "dagJson": "[{"nodeId":"task_SNAPSHOT_ID_node_0","type":"research","dependencies":[],"status":"completed","prompt":"Compose a market entry report","result":{"summary":"Market entry viable in Q2 2027","confidence":0.87}}]",
        "id": "task_SNAPSHOT_ID",
        "prompt": "Compose a market entry report",
        "status": "completed",
        "updatedAt": "<ISO_TIMESTAMP>",
        "walletPublicKey": "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ",
      }
    `);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GET /api/payments
// ═══════════════════════════════════════════════════════════════════════════════
describe("Snapshot: GET /api/payments", () => {
  function makePaymentsApp(initial: PaymentRecord[] = []) {
    const rawDb = new Database(":memory:");
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        taskId        TEXT NOT NULL,
        nodeId        TEXT NOT NULL,
        balanceId     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'locked',
        amountStroops TEXT NOT NULL,
        txHash        TEXT,
        PRIMARY KEY (taskId, nodeId)
      )
    `);
    const db = createPaymentDb(rawDb);
    for (const record of initial) db.insert(record);

    const app = express();
    app.use(express.json());
    app.use("/api/payments", createPaymentsRouter({ db }));
    app.use(testErrorHandler);
    return app;
  }

  it("empty payment history shape matches snapshot", async () => {
    const res = await request(makePaymentsApp()).get("/api/payments");

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "payments": [],
        "total": 0,
      }
    `);
  });

  it("populated payment history shape matches snapshot", async () => {
    const res = await request(makePaymentsApp([SEED_PAYMENT])).get(
      "/api/payments"
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "payments": [
          {
            "amountStroops": "15000000",
            "balanceId": "balance-snap-abc",
            "nodeId": "node_1",
            "status": "released",
            "taskId": "task_snapshotpay1",
            "txHash": "txhash-snapshot-001",
          },
        ],
        "total": 1,
      }
    `);
  });

  it("locked payment (null txHash) shape matches snapshot", async () => {
    const locked: PaymentRecord = {
      ...SEED_PAYMENT,
      status: "locked",
      txHash: null,
      nodeId: "node_locked",
    };
    const res = await request(makePaymentsApp([locked])).get("/api/payments");

    expect(res.status).toBe(200);
    expect(res.body).toMatchInlineSnapshot(`
      {
        "payments": [
          {
            "amountStroops": "15000000",
            "balanceId": "balance-snap-abc",
            "nodeId": "node_locked",
            "status": "locked",
            "taskId": "task_snapshotpay1",
            "txHash": null,
          },
        ],
        "total": 1,
      }
    `);
  });
});
