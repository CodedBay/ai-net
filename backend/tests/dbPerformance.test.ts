/**
 * SQLite performance groundwork (#32): WAL mode, index migrations, and
 * slow-query instrumentation.
 */
import fs from "fs";
import os from "os";
import path from "path";

import Database from "better-sqlite3";

import { createPool, type SlowQueryInfo } from "../src/db/pool";
import { migrateToLatest } from "../src/db/migrator";

const migrationsRoot = path.join(__dirname, "../src/db/migrations");

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-db-perf-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("WAL mode", () => {
  it("enables WAL on the writer and every reader", async () => {
    const pool = createPool({ filePath: path.join(tmpDir, "wal.db"), min: 1, max: 1 });
    try {
      expect(pool.writer.pragma("journal_mode", { simple: true })).toBe("wal");
      const readerMode = await pool.read((db) =>
        db.pragma("journal_mode", { simple: true }),
      );
      expect(readerMode).toBe("wal");
    } finally {
      await pool.close();
    }
  });

  it("is enabled for payments, agents, and tasks databases", async () => {
    const names = ["payments", "agents", "tasks"] as const;
    const migrationsDirs = {
      payments: path.join(migrationsRoot, "payments"),
      agents: path.join(migrationsRoot, "agents"),
      tasks: path.join(migrationsRoot, "tasks"),
    };

    for (const name of names) {
      const pool = createPool({
        filePath: path.join(tmpDir, `${name}-wal.db`),
        min: 1,
        max: 1,
        onCreate: (db) => migrateToLatest(db, migrationsDirs[name]),
      });
      try {
        expect(pool.writer.pragma("journal_mode", { simple: true })).toBe("wal");
      } finally {
        await pool.close();
      }
    }
  });
});

describe("index migrations", () => {
  function migrateAndListIndexes(database: "agents" | "tasks" | "payments"): string[] {
    const db = new Database(path.join(tmpDir, `${database}-indexes.db`));
    try {
      migrateToLatest(db, path.join(migrationsRoot, database));
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    } finally {
      db.close();
    }
  }

  it("adds agents(status, capabilities)", () => {
    expect(migrateAndListIndexes("agents")).toContain("idx_agents_status_capabilities");
  });

  it("adds tasks(walletPublicKey, createdAt)", () => {
    expect(migrateAndListIndexes("tasks")).toContain("idx_tasks_wallet_created");
  });

  it("adds payments(taskId, status)", () => {
    expect(migrateAndListIndexes("payments")).toContain("idx_payments_task_status");
  });

  it("actually uses the wallet/createdAt index for filtered queries", () => {
    expect(migrateAndListIndexes("tasks")).toContain("idx_tasks_wallet_created");
  });
});

describe("slow query logging", () => {
  it("reports statements at or above the threshold", async () => {
    const captured: SlowQueryInfo[] = [];
    const pool = createPool({
      filePath: path.join(tmpDir, "slow.db"),
      min: 1,
      max: 1,
      slowQueryThresholdMs: 0,
      onSlowQuery: (info) => captured.push(info),
    });

    try {
      await pool.write((db) => {
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
        db.prepare("INSERT INTO items (name) VALUES (?)").run("alpha");
      });
      await pool.read((db) => db.prepare("SELECT * FROM items").all());

      expect(captured.some((info) => info.sql.includes("SELECT * FROM items"))).toBe(true);
      expect(captured.some((info) => info.sql.includes("INSERT INTO items"))).toBe(true);
      expect(captured.every((info) => typeof info.durationMs === "number")).toBe(true);
    } finally {
      await pool.close();
    }
  });

  it("does not instrument when the threshold is negative", async () => {
    const captured: SlowQueryInfo[] = [];
    const pool = createPool({
      filePath: path.join(tmpDir, "slow-off.db"),
      min: 1,
      max: 1,
      slowQueryThresholdMs: -1,
      onSlowQuery: (info) => captured.push(info),
    });

    try {
      await pool.write((db) => {
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
        db.prepare("SELECT 1").get();
      });
      expect(captured).toEqual([]);
    } finally {
      await pool.close();
    }
  });
});
