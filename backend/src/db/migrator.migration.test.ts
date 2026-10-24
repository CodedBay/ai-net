/**
 * Down-migration tests for all three SQLite databases.
 *
 * These tests run with the REAL better-sqlite3 native module (not the mock
 * used by the standard jest config) so that PRAGMA table_info / index_list
 * introspection works correctly.  The separate jest config that drives this
 * suite (jest.migrations.config.js) deliberately omits the moduleNameMapper
 * entry that otherwise replaces better-sqlite3 with the no-op mock.
 *
 * Coverage goals
 * ─────────────────────────────────────────────────────────────────────────
 * ✓ Every down migration in payments, agents, and tasks databases
 * ✓ Each test: apply migration(s) → verify schema → rollback → verify state
 * ✓ Idempotency: applying the same migration twice does not error
 * ✓ Multi-step rollback: rolling back 3+ versions in sequence
 * ✓ Round-trip: rollback then re-apply returns to the same schema
 */

import path from "path";
import Database from "better-sqlite3";
import {
  migrateToLatest,
  rollback,
  getAppliedMigrations,
} from "./migrator";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

/** Absolute path to a named migration sub-directory. */
function migrDir(db: "payments" | "agents" | "tasks"): string {
  return path.join(MIGRATIONS_DIR, db);
}

/** Return the column names of a table (empty array if the table doesn't exist). */
function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name);
}

/** Return true when the named table exists. */
function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    )
    .get(table);
  return row !== undefined;
}

/** Return the index names on a table. */
function indexNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
    name: string;
    origin: string;
  }>;
  // Exclude auto-created UNIQUE constraint indexes (origin='u') and pk indexes
  return rows
    .filter((r) => r.origin === "c")
    .map((r) => r.name);
}

/** Return the version numbers recorded in schema_migrations (empty if absent). */
function appliedVersions(db: Database.Database): number[] {
  return getAppliedMigrations(db).map((m) => m.version);
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a fresh in-memory database for each test. */
function freshDb(): Database.Database {
  return new Database(":memory:");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

describe("payments down migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── v001: create_payments_table ────────────────────────────────────────────

  describe("v001 create_payments_table", () => {
    it("up: creates the payments table with expected columns", () => {
      migrateToLatest(db, migrDir("payments"));
      // Only assert v001 columns exist (v002 only adds an index, not columns)
      expect(tableColumns(db, "payments")).toEqual(
        expect.arrayContaining([
          "taskId",
          "nodeId",
          "balanceId",
          "status",
          "amountStroops",
          "txHash",
        ])
      );
    });

    it("down: DROP TABLE removes the payments table", () => {
      migrateToLatest(db, migrDir("payments"));
      expect(tableExists(db, "payments")).toBe(true);

      rollback(db, migrDir("payments"), 2); // roll back both migrations

      expect(tableExists(db, "payments")).toBe(false);
      expect(appliedVersions(db)).toEqual([]);
    });

    it("schema before v001 has no payments table", () => {
      expect(tableExists(db, "payments")).toBe(false);
    });
  });

  // ── v002: add_status_index ─────────────────────────────────────────────────

  describe("v002 add_status_index", () => {
    it("up: creates idx_payments_status on payments", () => {
      migrateToLatest(db, migrDir("payments"));
      expect(indexNames(db, "payments")).toContain("idx_payments_status");
      expect(appliedVersions(db)).toEqual([1, 2]);
    });

    it("down (1 step): removes idx_payments_status, table still exists", () => {
      migrateToLatest(db, migrDir("payments"));

      const { rolledBack } = rollback(db, migrDir("payments"), 1);

      expect(rolledBack).toEqual(["2_add_status_index"]);
      // Index gone
      expect(indexNames(db, "payments")).not.toContain("idx_payments_status");
      // Table still present
      expect(tableExists(db, "payments")).toBe(true);
      expect(appliedVersions(db)).toEqual([1]);
    });

    it("round-trip: rollback v002 then re-apply restores the index", () => {
      migrateToLatest(db, migrDir("payments"));
      rollback(db, migrDir("payments"), 1);

      // Re-apply
      const { applied } = migrateToLatest(db, migrDir("payments"));
      expect(applied).toEqual(["2_add_status_index"]);
      expect(indexNames(db, "payments")).toContain("idx_payments_status");
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("running migrateToLatest twice is a no-op on the second call", () => {
      migrateToLatest(db, migrDir("payments"));
      const second = migrateToLatest(db, migrDir("payments"));
      expect(second.applied).toEqual([]);
      expect(appliedVersions(db)).toEqual([1, 2]);
    });

    it("rollback followed by full re-apply reaches the same final state", () => {
      migrateToLatest(db, migrDir("payments"));
      rollback(db, migrDir("payments"), 2);
      migrateToLatest(db, migrDir("payments"));

      expect(appliedVersions(db)).toEqual([1, 2]);
      expect(tableExists(db, "payments")).toBe(true);
      expect(indexNames(db, "payments")).toContain("idx_payments_status");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AGENTS DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

describe("agents down migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── v001: create_agents_table ──────────────────────────────────────────────

  describe("v001 create_agents_table", () => {
    it("up: creates agents table with all expected columns", () => {
      migrateToLatest(db, migrDir("agents"));
      expect(tableColumns(db, "agents")).toEqual(
        expect.arrayContaining([
          "id",
          "capabilities",
          "pricingXLM",
          "endpoint",
          "stellarPublicKey",
          "reputationScore",
          "lastSeenAt",
          "status",
        ])
      );
      expect(appliedVersions(db)).toEqual([1]);
    });

    it("down: DROP TABLE removes agents table", () => {
      migrateToLatest(db, migrDir("agents"));

      const { rolledBack } = rollback(db, migrDir("agents"), 1);

      expect(rolledBack).toEqual(["1_create_agents_table"]);
      expect(tableExists(db, "agents")).toBe(false);
      expect(appliedVersions(db)).toEqual([]);
    });

    it("schema before v001 has no agents table", () => {
      expect(tableExists(db, "agents")).toBe(false);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("migrateToLatest is idempotent (second call applies nothing)", () => {
      migrateToLatest(db, migrDir("agents"));
      const second = migrateToLatest(db, migrDir("agents"));
      expect(second.applied).toEqual([]);
      expect(appliedVersions(db)).toEqual([1]);
    });

    it("rollback then re-apply returns the same schema", () => {
      migrateToLatest(db, migrDir("agents"));
      rollback(db, migrDir("agents"), 1);
      migrateToLatest(db, migrDir("agents"));

      expect(tableExists(db, "agents")).toBe(true);
      expect(tableColumns(db, "agents")).toEqual(
        expect.arrayContaining(["id", "capabilities", "pricingXLM"])
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

describe("tasks down migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  // ── v001: create_tasks_table ───────────────────────────────────────────────

  describe("v001 create_tasks_table", () => {
    it("up: tasks table has expected columns", () => {
      // Apply only v001 by migrating to latest after adding only that file on
      // a fresh db; since our fixture dir has all 4 we just verify columns exist.
      migrateToLatest(db, migrDir("tasks"));
      expect(tableColumns(db, "tasks")).toEqual(
        expect.arrayContaining([
          "id",
          "prompt",
          "walletPublicKey",
          "status",
          "dagJson",
          "createdAt",
          "updatedAt",
        ])
      );
    });

    it("down (4 steps): rolling back all migrations removes tasks table", () => {
      migrateToLatest(db, migrDir("tasks"));
      rollback(db, migrDir("tasks"), 4);

      expect(tableExists(db, "tasks")).toBe(false);
      expect(appliedVersions(db)).toEqual([]);
    });
  });

  // ── v002: create_task_events_table ─────────────────────────────────────────

  describe("v002 create_task_events_table", () => {
    it("up: task_events table and idx_task_events_taskId exist after v002", () => {
      migrateToLatest(db, migrDir("tasks"));
      expect(tableExists(db, "task_events")).toBe(true);
      expect(indexNames(db, "task_events")).toContain("idx_task_events_taskId");
    });

    it("down (2 steps from v4): removes task_events table and its index", () => {
      migrateToLatest(db, migrDir("tasks")); // applies v1–v4
      rollback(db, migrDir("tasks"), 3);     // rolls back v4, v3, v2

      expect(tableExists(db, "task_events")).toBe(false);
      expect(tableExists(db, "tasks")).toBe(true); // v1 still applied
      expect(appliedVersions(db)).toEqual([1]);
    });

    it("round-trip: rollback v2–v4 then re-apply restores task_events", () => {
      migrateToLatest(db, migrDir("tasks"));
      rollback(db, migrDir("tasks"), 3);
      migrateToLatest(db, migrDir("tasks"));

      expect(tableExists(db, "task_events")).toBe(true);
      expect(indexNames(db, "task_events")).toContain("idx_task_events_taskId");
      expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
    });
  });

  // ── v003: create_quality_scores_table ─────────────────────────────────────

  describe("v003 create_quality_scores_table", () => {
    it("up: quality_scores table and idx_quality_scores_agentId exist after v003", () => {
      migrateToLatest(db, migrDir("tasks"));
      expect(tableExists(db, "quality_scores")).toBe(true);
      expect(indexNames(db, "quality_scores")).toContain(
        "idx_quality_scores_agentId"
      );
      expect(tableColumns(db, "quality_scores")).toEqual(
        expect.arrayContaining([
          "id",
          "taskId",
          "nodeId",
          "agentId",
          "agentType",
          "score",
          "completeness",
          "relevance",
          "format",
          "needsReview",
          "timestamp",
        ])
      );
    });

    it("down (2 steps from v4): removes quality_scores table and its index", () => {
      migrateToLatest(db, migrDir("tasks")); // applies v1–v4
      rollback(db, migrDir("tasks"), 2);     // rolls back v4, v3

      expect(tableExists(db, "quality_scores")).toBe(false);
      expect(tableExists(db, "task_events")).toBe(true); // v2 still applied
      expect(appliedVersions(db)).toEqual([1, 2]);
    });

    it("round-trip: rollback v3–v4 then re-apply restores quality_scores", () => {
      migrateToLatest(db, migrDir("tasks"));
      rollback(db, migrDir("tasks"), 2);
      migrateToLatest(db, migrDir("tasks"));

      expect(tableExists(db, "quality_scores")).toBe(true);
      expect(indexNames(db, "quality_scores")).toContain(
        "idx_quality_scores_agentId"
      );
    });
  });

  // ── v004: add_created_at_index ─────────────────────────────────────────────

  describe("v004 add_created_at_index", () => {
    it("up: idx_tasks_created_at index exists on tasks after v004", () => {
      migrateToLatest(db, migrDir("tasks"));
      expect(indexNames(db, "tasks")).toContain("idx_tasks_created_at");
      expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
    });

    it("down (1 step): removes idx_tasks_created_at, tasks table intact", () => {
      migrateToLatest(db, migrDir("tasks"));

      const { rolledBack } = rollback(db, migrDir("tasks"), 1);

      expect(rolledBack).toEqual(["4_add_created_at_index"]);
      expect(indexNames(db, "tasks")).not.toContain("idx_tasks_created_at");
      expect(tableExists(db, "tasks")).toBe(true);
      expect(appliedVersions(db)).toEqual([1, 2, 3]);
    });

    it("round-trip: rollback v4 then re-apply restores the index", () => {
      migrateToLatest(db, migrDir("tasks"));
      rollback(db, migrDir("tasks"), 1);

      const { applied } = migrateToLatest(db, migrDir("tasks"));
      expect(applied).toEqual(["4_add_created_at_index"]);
      expect(indexNames(db, "tasks")).toContain("idx_tasks_created_at");
    });
  });

  // ── Multi-step rollback ────────────────────────────────────────────────────

  describe("multi-step rollback (3 versions)", () => {
    it("rolls back v4 → v3 → v2 in order, leaving only v1", () => {
      migrateToLatest(db, migrDir("tasks"));

      const { rolledBack } = rollback(db, migrDir("tasks"), 3);

      expect(rolledBack).toEqual([
        "4_add_created_at_index",
        "3_create_quality_scores_table",
        "2_create_task_events_table",
      ]);
      expect(appliedVersions(db)).toEqual([1]);
      // Artifacts removed
      expect(tableExists(db, "quality_scores")).toBe(false);
      expect(tableExists(db, "task_events")).toBe(false);
      expect(indexNames(db, "tasks")).not.toContain("idx_tasks_created_at");
      // v1 artifact still present
      expect(tableExists(db, "tasks")).toBe(true);
    });

    it("after 3-step rollback, full re-apply reaches v4 again", () => {
      migrateToLatest(db, migrDir("tasks"));
      rollback(db, migrDir("tasks"), 3);

      const { applied } = migrateToLatest(db, migrDir("tasks"));
      expect(applied).toEqual([
        "2_create_task_events_table",
        "3_create_quality_scores_table",
        "4_add_created_at_index",
      ]);
      expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
      expect(tableExists(db, "quality_scores")).toBe(true);
      expect(tableExists(db, "task_events")).toBe(true);
      expect(indexNames(db, "tasks")).toContain("idx_tasks_created_at");
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("migrateToLatest is idempotent when already at v4", () => {
      migrateToLatest(db, migrDir("tasks"));
      const second = migrateToLatest(db, migrDir("tasks"));
      expect(second.applied).toEqual([]);
      expect(appliedVersions(db)).toEqual([1, 2, 3, 4]);
    });

    it("full rollback then full re-apply produces the same schema each time", () => {
      for (let iteration = 0; iteration < 2; iteration++) {
        migrateToLatest(db, migrDir("tasks"));
        expect(tableExists(db, "tasks")).toBe(true);
        expect(tableExists(db, "task_events")).toBe(true);
        expect(tableExists(db, "quality_scores")).toBe(true);
        expect(indexNames(db, "tasks")).toContain("idx_tasks_created_at");
        rollback(db, migrDir("tasks"), 4);
        expect(tableExists(db, "tasks")).toBe(false);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-DB: All three databases in sequence (integration smoke)
// ═══════════════════════════════════════════════════════════════════════════════

describe("all three databases — full migrate + rollback cycle", () => {
  let payDb: Database.Database;
  let agDb: Database.Database;
  let tkDb: Database.Database;

  beforeEach(() => {
    payDb = freshDb();
    agDb = freshDb();
    tkDb = freshDb();
  });

  afterEach(() => {
    payDb.close();
    agDb.close();
    tkDb.close();
  });

  it("migrates all three to latest then rolls all the way back to empty", () => {
    migrateToLatest(payDb, migrDir("payments"));
    migrateToLatest(agDb, migrDir("agents"));
    migrateToLatest(tkDb, migrDir("tasks"));

    expect(appliedVersions(payDb)).toEqual([1, 2]);
    expect(appliedVersions(agDb)).toEqual([1]);
    expect(appliedVersions(tkDb)).toEqual([1, 2, 3, 4]);

    // Roll back all
    rollback(payDb, migrDir("payments"), 2);
    rollback(agDb, migrDir("agents"), 1);
    rollback(tkDb, migrDir("tasks"), 4);

    expect(tableExists(payDb, "payments")).toBe(false);
    expect(tableExists(agDb, "agents")).toBe(false);
    expect(tableExists(tkDb, "tasks")).toBe(false);

    expect(appliedVersions(payDb)).toEqual([]);
    expect(appliedVersions(agDb)).toEqual([]);
    expect(appliedVersions(tkDb)).toEqual([]);
  });
});
