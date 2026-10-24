/**
 * openapi-contract.test.ts
 *
 * API contract tests: validates that real HTTP responses from the running
 * Express app satisfy the OpenAPI spec defined in docs/openapi.yaml.
 *
 * Uses jest-openapi's `toSatisfyApiSpec()` matcher, which is registered
 * globally in tests/jestSetup.ts so no additional setup is needed here.
 *
 * Requirements covered:
 *  - openapi.yaml covers all endpoints (verified structurally in docs.test.ts)
 *  - Schema validation runs in existing API tests (this file)
 *  - CI fails on schema mismatch (tests are run in the backend CI job)
 */

// Pull in the jest-openapi global type augmentations so TypeScript recognises
// toSatisfyApiSpec() and toSatisfySchemaInApiSpec().
import "jest-openapi";

import request from "supertest";
import express from "express";
import { createApp } from "../src/api/app";
import { createAgentsRouter } from "../src/api/routes/agents";
import { errorHandler } from "../src/api/middleware/errorHandler";
import type { AgentDb, AgentRecord } from "../src/db/agents";
import { openapiSpec } from "../src/api/docs";
import type { ReconciliationService } from "../src/services/reconciliation";

// ── Shared app instance ───────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;

const contractReconciliationReport = {
  id: "contract-report",
  runAt: "2026-10-23T00:00:00.000Z",
  triggeredBy: "manual" as const,
  status: "consistent" as const,
  summary: {
    totalLocalRecords: 0,
    totalOnChainBalances: 0,
    matched: 0,
    discrepancies: 0,
    missingOnChain: 0,
    missingLocal: 0,
    amountMismatch: 0,
  },
  discrepancies: [],
};

const contractReconciliationService = {
  run: async (triggeredBy = "manual") => ({ ...contractReconciliationReport, triggeredBy }),
  getLatestReport: () => contractReconciliationReport,
} as unknown as ReconciliationService;

beforeAll(() => {
  app = createApp({
    disableCompression: true,
    enableHeartbeatCleanup: false,
    enableQueueWorker: false,
    reconciliation: { service: contractReconciliationService },
  });
});

afterAll((done) => {
  app.close(done);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_STELLAR_KEY = "GB3W5IYBKWGAZ277DJEEG5H635MUUGBTFPUTF7R2N5IJYP36AY2H2CUZ";

/**
 * In-memory stub AgentDb — no SQLite dependency.
 * Covers only the methods exercised by the agents router.
 */
function makeStubAgentDb(initial: AgentRecord[] = []): AgentDb {
  const store = new Map<string, AgentRecord>(initial.map((a) => [a.id, a]));

  return {
    upsert(agent: AgentRecord) {
      store.set(agent.id, agent);
    },
    findById(id: string) {
      return store.get(id);
    },
    list(filters?: { capability?: string; minReputation?: number; maxPriceXLM?: number; status?: string }) {
      let items = Array.from(store.values());
      if (filters?.capability) {
        items = items.filter((a) => a.capabilities.includes(filters.capability!));
      }
      if (filters?.status) {
        items = items.filter((a) => a.status === filters.status);
      }
      return items;
    },
    listCursor(_options?: Record<string, unknown>) {
      return { items: Array.from(store.values()), nextCursor: undefined };
    },
    delete(id: string) {
      store.delete(id);
    },
    updateReputation(id: string, delta: number) {
      const a = store.get(id);
      if (a) store.set(id, { ...a, reputationScore: a.reputationScore + delta });
    },
    updateReputationWithStats(id: string, delta: number) {
      const a = store.get(id);
      if (a) store.set(id, { ...a, reputationScore: a.reputationScore + delta });
    },
    countByStellarKey(stellarPublicKey: string) {
      return Array.from(store.values()).filter((a) => a.stellarPublicKey === stellarPublicKey).length;
    },
    markAllOffline() {
      for (const [id, a] of store) store.set(id, { ...a, status: "offline" });
    },
    updateLastSeen(agentId: string) {
      const a = store.get(agentId);
      if (a) store.set(agentId, { ...a, lastSeenAt: new Date().toISOString() });
    },
    markStaleAgents() { return 0; },
    deleteOfflineAgents() { return 0; },
  } as AgentDb;
}

/** Minimal Express app that exposes the agents router for isolated tests. */
function makeAgentsApp(agents: AgentRecord[] = []) {
  const db = makeStubAgentDb(agents);
  const miniApp = express();
  miniApp.use(express.json());
  miniApp.use("/api/agents", createAgentsRouter({ db }));
  miniApp.use(errorHandler);
  return miniApp;
}

const sampleAgent: AgentRecord = {
  id: "contract-agent-01",
  capabilities: ["research"],
  pricingXLM: 0.5,
  endpoint: "http://localhost:9999/health",
  stellarPublicKey: VALID_STELLAR_KEY,
  reputationScore: 85,
  lastSeenAt: new Date().toISOString(),
  status: "online",
};

const documentedHttpOperations = Object.entries(openapiSpec.paths ?? {}).flatMap(([routePath, pathItem]) =>
  Object.keys(pathItem as Record<string, unknown>)
    .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
    .filter(() => !routePath.endsWith("/stream"))
    .map((method) => ({ method, routePath }))
);

describe("OpenAPI contract — all documented HTTP operations", () => {
  it.each(documentedHttpOperations)("$method $routePath satisfies the API spec", async ({ method, routePath }) => {
    const url = routePath.replace(/\{[^}]+\}/g, "contract-test-missing");
    const verb = method as "get" | "post" | "put" | "patch" | "delete";
    let testRequest = request(app.httpServer)[verb](url).set("API-Version", "2.0");
    if (["post", "put", "patch"].includes(method)) testRequest = testRequest.send({});

    const response = await testRequest;
    expect(response).toSatisfyApiSpec();
  });
});

// ── Health endpoints ──────────────────────────────────────────────────────────

describe("OpenAPI contract — /health", () => {
  it("GET /health satisfies spec", async () => {
    const res = await request(app.httpServer).get("/health");
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("GET /health/live satisfies spec", async () => {
    const res = await request(app.httpServer).get("/health/live");
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });
});

// ── Agent endpoints ───────────────────────────────────────────────────────────

describe("OpenAPI contract — /api/agents", () => {
  it("GET /api/agents (empty) satisfies spec", async () => {
    const miniApp = makeAgentsApp();
    const res = await request(miniApp).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("GET /api/agents (with agent) satisfies spec", async () => {
    const miniApp = makeAgentsApp([sampleAgent]);
    const res = await request(miniApp).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("GET /api/agents/:id (found) satisfies spec", async () => {
    const miniApp = makeAgentsApp([sampleAgent]);
    const res = await request(miniApp).get(`/api/agents/${sampleAgent.id}`);
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("GET /api/agents/:id (not found) satisfies spec", async () => {
    const miniApp = makeAgentsApp();
    const res = await request(miniApp).get("/api/agents/does-not-exist");
    expect(res.status).toBe(404);
    expect(res).toSatisfyApiSpec();
  });

  it("POST /api/agents/register (valid) satisfies spec", async () => {
    const savedEnv = process.env.SKIP_STELLAR_ACCOUNT_VERIFY;
    process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
    try {
      const miniApp = makeAgentsApp();
      const res = await request(miniApp)
        .post("/api/agents/register")
        .send({
          agentId: "contract-test-agent",
          capabilities: ["coding"],
          pricingXLM: 1.0,
          endpoint: "http://localhost:3001/health",
          stellarPublicKey: VALID_STELLAR_KEY,
        });
      expect(res.status).toBe(201);
      expect(res).toSatisfyApiSpec();
    } finally {
      process.env.SKIP_STELLAR_ACCOUNT_VERIFY = savedEnv;
    }
  });

  it("POST /api/agents/:id/heartbeat (found) satisfies spec", async () => {
    const miniApp = makeAgentsApp([sampleAgent]);
    const res = await request(miniApp).post(`/api/agents/${sampleAgent.id}/heartbeat`);
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("POST /api/agents/:id/heartbeat (not found) satisfies spec", async () => {
    const miniApp = makeAgentsApp();
    const res = await request(miniApp).post("/api/agents/ghost/heartbeat");
    expect(res.status).toBe(404);
    expect(res).toSatisfyApiSpec();
  });
});

// ── Stats endpoint ────────────────────────────────────────────────────────────

describe("OpenAPI contract — /api/stats", () => {
  it("GET /api/stats satisfies spec", async () => {
    const res = await request(app.httpServer).get("/api/stats");
    // The bare in-memory test database has no tables, so the stats aggregation
    // throws and the route surfaces a 500 by design (see tests/stats.test.ts).
    // Either way the response must match one of the documented shapes.
    expect([200, 500]).toContain(res.status);
    expect(res).toSatisfyApiSpec();
  });
});

// ── Auth endpoints ────────────────────────────────────────────────────────────

describe("OpenAPI contract — /api/auth", () => {
  it("POST /api/auth/token (valid payload) satisfies spec", async () => {
    const res = await request(app.httpServer)
      .post("/api/auth/token")
      .send({
        walletPublicKey: VALID_STELLAR_KEY,
        deviceId: "test-device-01",
        deviceName: "Jest test runner",
      });
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
  });

  it("POST /api/auth/refresh (invalid token) returns 401", async () => {
    const res = await request(app.httpServer)
      .post("/api/auth/refresh")
      .send({ refreshToken: "not-a-real-token" });
    // 4xx is acceptable — we just verify the shape matches the spec
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // spec must define a content schema for toSatisfyApiSpec() — covered via
    // the UnauthorizedError schema added to the 401 response in openapi.yaml.
    expect(res).toSatisfyApiSpec();
  });
});

// ── Schema object validation (unit-style) ────────────────────────────────────

describe("OpenAPI contract — schema object validation", () => {
  it("a Task object satisfies the Task schema in the spec", () => {
    const task = {
      id: "task_abc123",
      taskId: "task_abc123",
      prompt: "Analyze Stellar DeFi liquidity",
      walletPublicKey: VALID_STELLAR_KEY,
      status: "queued",
      dag: [],
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    };
    expect(task).toSatisfySchemaInApiSpec("Task");
  });

  it("an Agent object satisfies the Agent schema in the spec", () => {
    const agent = {
      id: "agent_abc",
      capabilities: ["research"],
      pricingXLM: 0.25,
      endpoint: "https://agent.example.com/api",
      stellarPublicKey: VALID_STELLAR_KEY,
      reputationScore: 95,
      lastSeenAt: "2026-09-01T12:00:00.000Z",
    };
    expect(agent).toSatisfySchemaInApiSpec("Agent");
  });

  it("a StatsResponse object satisfies the StatsResponse schema in the spec", () => {
    const stats = {
      totalAgents: 5,
      totalTasks: 100,
      uptimePercent: 99.9,
      totalXLMTransacted: 250.5,
      tasksLast24h: [{ timestamp: "2026-09-01T12:00:00.000Z", value: 10 }],
      xlmLast24h: [{ timestamp: "2026-09-01T12:00:00.000Z", value: 5.5 }],
    };
    expect(stats).toSatisfySchemaInApiSpec("StatsResponse");
  });

  it("a CreateTaskResponse object satisfies the CreateTaskResponse schema in the spec", () => {
    const createTaskResponse = {
      taskId: "task_xyz789",
      status: "queued",
      dagPreview: [],
    };
    expect(createTaskResponse).toSatisfySchemaInApiSpec("CreateTaskResponse");
  });

  it("a HealthStatus object satisfies the HealthStatus schema in the spec", () => {
    const health = {
      status: "ok",
      uptime: 3600,
      version: "0.1.0",
      stellarNetwork: "testnet",
    };
    expect(health).toSatisfySchemaInApiSpec("HealthStatus");
  });
});
