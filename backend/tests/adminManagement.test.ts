/**
 * Admin platform-management endpoints (#33).
 *
 * Boots the management router against a throwaway working directory so the
 * agents/tasks/payments SQLite files are isolated from the repository.
 */
import fs from "fs";
import os from "os";
import path from "path";

import express from "express";
import request from "supertest";

const ADMIN_KEY = "test-admin-key";
const originalCwd = process.cwd();
let tmpDir: string;
let app: express.Express;
let taskDb: import("../src/db/tasks").TaskDb;
let agentDb: import("../src/db/agents").AgentDb;
let logger: { error: (obj: unknown, msg: string) => void };
let excludeBannedAgents: <T extends { id: string }>(agents: T[]) => T[];

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-admin-"));
  process.chdir(tmpDir);
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key";
  // Tests default to LOG_LEVEL=silent; enable error capture for /admin/logs.
  process.env.LOG_LEVEL = "error";

  const { createTaskDb, getTaskDb } = require("../src/db/tasks") as typeof import("../src/db/tasks");
  const { createAgentDb, getAgentDb } = require("../src/db/agents") as typeof import("../src/db/agents");
  const { getDb } = require("../src/db") as typeof import("../src/db");
  const platform = require("../src/services/adminPlatform") as typeof import("../src/services/adminPlatform");
  const logging = require("../src/utils/logger") as typeof import("../src/utils/logger");
  const { createAdminManagementRouter } = require("../src/api/routes/adminManagement") as typeof import("../src/api/routes/adminManagement");
  const { errorHandler } = require("../src/api/middleware/errorHandler") as typeof import("../src/api/middleware/errorHandler");

  taskDb = createTaskDb(getTaskDb());
  agentDb = createAgentDb(getAgentDb());
  logger = logging.createLogger({ module: "admin-test" });
  excludeBannedAgents = platform.excludeBannedAgents;
  logging.clearErrorLogRing();

  taskDb.insert({
    id: "task_a",
    prompt: "Alpha research",
    walletPublicKey: "GALICE",
    status: "queued",
    dag: [],
    createdAt: iso(-60_000),
    updatedAt: iso(-60_000),
  });
  taskDb.insert({
    id: "task_b",
    prompt: "Beta report",
    walletPublicKey: "GBOB",
    status: "completed",
    dag: [],
    createdAt: iso(-120_000),
    updatedAt: iso(-90_000),
  });

  agentDb.upsert({
    id: "agent_a",
    capabilities: ["research"],
    pricingXLM: 0.5,
    endpoint: "http://127.0.0.1:4001",
    stellarPublicKey: "GA",
    reputationScore: 3,
    lastSeenAt: iso(),
    status: "online",
  });
  agentDb.upsert({
    id: "agent_b",
    capabilities: ["report"],
    pricingXLM: 0.3,
    endpoint: "http://127.0.0.1:4002",
    stellarPublicKey: "GB",
    reputationScore: 2,
    lastSeenAt: iso(),
    status: "offline",
  });

  const paymentDb = getDb();
  paymentDb
    .prepare(
      `INSERT INTO payments (taskId, nodeId, balanceId, status, amountStroops, txHash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("task_b", "n1", "bal_1", "released", "25000000", "hash_1");
  paymentDb
    .prepare(
      `INSERT INTO payments (taskId, nodeId, balanceId, status, amountStroops, txHash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("task_a", "n2", "bal_2", "locked", "10000000", null);

  app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminManagementRouter());
  app.use(errorHandler);
});

afterAll(() => {
  const { closeTaskDb } = require("../src/db/tasks") as typeof import("../src/db/tasks");
  const { closeAgentDb } = require("../src/db/agents") as typeof import("../src/db/agents");
  const { closeDb } = require("../src/db") as typeof import("../src/db");
  closeTaskDb();
  closeAgentDb();
  closeDb();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const admin = (method: "get" | "post" | "delete", url: string) =>
  request(app)[method](url).set("X-Admin-API-Key", ADMIN_KEY);

describe("admin auth (#33)", () => {
  it.each([
    ["/api/admin/stats"],
    ["/api/admin/tasks"],
    ["/api/admin/logs"],
  ])("returns 403 without a key for %s", async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Forbidden");
  });

  it("returns 403 for a wrong key", async () => {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Admin-API-Key", "wrong");
    expect(res.status).toBe(403);
  });

  it("returns 403 for a prefix of the configured key", async () => {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Admin-API-Key", ADMIN_KEY.slice(0, 4));
    expect(res.status).toBe(403);
  });

  it("returns 403 for mutating endpoints without a key", async () => {
    expect((await request(app).delete("/api/admin/tasks/task_a")).status).toBe(403);
    expect((await request(app).post("/api/admin/agents/agent_a/ban")).status).toBe(403);
  });

  it("accepts the key via Authorization: Bearer", async () => {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Authorization", `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/stats", () => {
  it("returns agent, task, and XLM aggregates", async () => {
    const res = await admin("get", "/api/admin/stats");
    expect(res.status).toBe(200);
    expect(res.body.agents).toMatchObject({ total: 2, online: 1, offline: 1, banned: 0 });
    expect(res.body.tasks).toMatchObject({
      total: 2,
      queued: 1,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      last24h: 2,
    });
    expect(res.body.xlm).toEqual({ released: 2.5, locked: 1, total: 3.5 });
  });
});

describe("GET /api/admin/tasks", () => {
  it("lists all tasks with pagination metadata", async () => {
    const res = await admin("get", "/api/admin/tasks");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tasks.map((task: { id: string }) => task.id)).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("filters by status and wallet", async () => {
    const byStatus = await admin("get", "/api/admin/tasks?status=queued");
    expect(byStatus.body.tasks.map((task: { id: string }) => task.id)).toEqual(["task_a"]);

    const byWallet = await admin("get", "/api/admin/tasks?wallet=GBOB");
    expect(byWallet.body.tasks.map((task: { id: string }) => task.id)).toEqual(["task_b"]);
  });

  it("filters by date range and paginates", async () => {
    const from = encodeURIComponent(iso(-180_000));
    const res = await admin("get", `/api/admin/tasks?from=${from}&limit=1&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
    expect(res.body.tasks).toHaveLength(1);
  });

  it("rejects an invalid status filter", async () => {
    const res = await admin("get", "/api/admin/tasks?status=nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_QUERY");
  });
});

describe("DELETE /api/admin/tasks/:id", () => {
  it("cancels a queued task", async () => {
    const res = await admin("delete", "/api/admin/tasks/task_a");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(Array.isArray(res.body.refundTxHashes)).toBe(true);
  });

  it("rejects cancelling an already terminal task", async () => {
    const completed = await admin("delete", "/api/admin/tasks/task_b");
    expect(completed.status).toBe(409);

    const cancelledAgain = await admin("delete", "/api/admin/tasks/task_a");
    expect(cancelledAgain.status).toBe(409);
  });

  it("returns 404 for a missing task", async () => {
    const res = await admin("delete", "/api/admin/tasks/task_missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
  });
});

describe("POST /api/admin/agents/:id/ban", () => {
  it("bans an agent, marks it offline, and excludes it from assignments", async () => {
    const res = await admin("post", "/api/admin/agents/agent_a/ban").send({
      reason: "malicious output",
    });
    expect(res.status).toBe(200);
    expect(res.body.banned).toBe(true);
    expect(res.body.agent.status).toBe("offline");
    expect(res.body.agent.bannedAt).toEqual(expect.any(String));

    expect(agentDb.findById("agent_a")?.bannedAt).toEqual(expect.any(String));

    const eligible = excludeBannedAgents([{ id: "agent_a" }, { id: "agent_b" }]);
    expect(eligible.map((agent) => agent.id)).toEqual(["agent_b"]);

    const stats = await admin("get", "/api/admin/stats");
    expect(stats.body.agents.banned).toBe(1);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await admin("post", "/api/admin/agents/missing/ban").send({});
    expect(res.status).toBe(404);
  });

  it("lifts the ban", async () => {
    const res = await admin("post", "/api/admin/agents/agent_a/unban");
    expect(res.status).toBe(200);
    expect(res.body.banned).toBe(false);
    expect(res.body.agent.bannedAt).toBeNull();
  });
});

describe("GET /api/admin/logs", () => {
  it("returns recent error entries and filters by level", async () => {
    logger.error({ err: new Error("boom"), taskId: "task_a" }, "something failed");

    const res = await admin("get", "/api/admin/logs?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      level: "error",
      message: "something failed",
      taskId: "task_a",
      error: { message: "boom" },
    });

    const filtered = await admin("get", "/api/admin/logs?level=fatal");
    expect(filtered.body.entries).toEqual([]);
  });

  it("rejects an invalid limit", async () => {
    const res = await admin("get", "/api/admin/logs?limit=0");
    expect(res.status).toBe(400);
  });
});
