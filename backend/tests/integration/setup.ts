/**
 * Integration test bootstrap utilities.
 *
 * Provides helpers to:
 * - Boot the full Express app on a random port with in-memory SQLite databases
 * - Tear down the app and close database connections after each suite
 * - Mock Venice AI HTTP calls using MSW (Mock Service Worker)
 */

import Database from "better-sqlite3";
import { createApp } from "../../src/api/app";
import { createAgentDb } from "../../src/db/agents";
import { createTaskDb } from "../../src/db/tasks";

// ── Environment bootstrap (must run before any config import) ─────────────────
beforeAll(() => {
  process.env.VENICE_API_KEY = process.env.VENICE_API_KEY || "test-venice-key-integration";
  process.env.DATABASE_URL = ":memory:";
  process.env.SKIP_STELLAR_ACCOUNT_VERIFY = "true";
  process.env.NODE_ENV = "test";
  try {
    const { loadConfig } = require("../../src/config");
    loadConfig();
  } catch {
    // Already loaded — ignore
  }
});

// ── In-memory database factories ─────────────────────────────────────────────

export function makeInMemoryTaskDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      walletPublicKey TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      dagJson TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL,
      type TEXT NOT NULL,
      nodeId TEXT,
      payload TEXT,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      statusCode INTEGER NOT NULL,
      body TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
  return db;
}

export function makeInMemoryAgentDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      capabilities TEXT NOT NULL,
      pricingXLM REAL NOT NULL,
      endpoint TEXT NOT NULL,
      stellarPublicKey TEXT NOT NULL,
      reputationScore REAL NOT NULL DEFAULT 0,
      lastSeenAt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online'
    )
  `);
  return db;
}

// ── App factory ───────────────────────────────────────────────────────────────

export interface TestApp {
  app: ReturnType<typeof createApp>;
  taskDb: Database.Database;
  agentDb: Database.Database;
  taskDbHelper: ReturnType<typeof createTaskDb>;
  agentDbHelper: ReturnType<typeof createAgentDb>;
}

/**
 * Creates a full Express app with in-memory SQLite databases and mocked
 * dispatch/payment functions. Call `teardown()` in `afterAll` to clean up.
 */
export function createTestApp(overrides: {
  dispatch?: jest.Mock;
  releasePayment?: jest.Mock;
} = {}): TestApp {
  const taskDb = makeInMemoryTaskDb();
  const agentDb = makeInMemoryAgentDb();
  const taskDbHelper = createTaskDb(taskDb);
  const agentDbHelper = createAgentDb(agentDb);

  jest.spyOn(require("../../src/db/tasks"), "getTaskDb").mockReturnValue(taskDb);
  jest.spyOn(require("../../src/db/agents"), "getAgentDb").mockReturnValue(agentDb);

  const dispatch = overrides.dispatch ?? jest.fn().mockResolvedValue({ result: "mock-result" });
  const releasePayment = overrides.releasePayment ?? jest.fn().mockResolvedValue("mock-tx-hash");

  const app = createApp({ dispatch, releasePayment });

  return { app, taskDb, agentDb, taskDbHelper, agentDbHelper };
}

export async function teardownTestApp(testApp: TestApp): Promise<void> {
  testApp.app.close();
  testApp.taskDb.close();
  testApp.agentDb.close();
  jest.restoreAllMocks();
}

// ── Valid Stellar-format test keys ────────────────────────────────────────────

/** 56-character Stellar public key (G + 55 uppercase base32 chars). */
export const TEST_WALLET = "GWALLETTESTINTEGRATIONTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const TEST_AGENT_KEY = "GINTEGRATIONAGENTSTELLARTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const SECOND_WALLET = "GSECONDWALLETINTEGRATIONTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
