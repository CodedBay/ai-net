/**
 * Migration tests for tasks.db
 *
 * Verifies that every migration in the tasks migrations directory applies the
 * correct schema changes (tables, columns, indexes) and rolls back cleanly.
 * Also covers the multi-step chain v1→…→v6 forward and v6→…→v1
 * in reverse.
 *
 * Real SQLite is used (jest.requireActual) so that actual DDL executes rather
 * than the no-op mock wired via moduleNameMapper.
 */

import path from "path";
import { migrateToLatest, rollback, getAppliedMigrations } from "../migrator";

// Bypass the moduleNameMapper mock — we need real SQLite for schema assertions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = jest.requireActual<typeof import("better-sqlite3")>("better-sqlite3");

const MIGRATIONS_DIR = path.join(__dirname, "tasks");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = InstanceType<typeof RealDatabase>;

function openDb(): Db {
  return new RealDatabase(":memory:");
}

function tables(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name != 'schema_migrations'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columns(db: Db, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexes(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function appliedVersions(db: Db): number[] {
  return getAppliedMigrations(db).map((m) => m.version);
}

// ---------------------------------------------------------------------------
// 001_create_tasks_table
// ---------------------------------------------------------------------------

describe("tasks migrations — 001_create_tasks_table", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("up() creates the tasks table with all expected columns", () => {
    expect(tables(db)).not.toContain("tasks");

    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("tasks");
    const cols = columns(db, "tasks");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "prompt",
        "walletPublicKey",
        "status",
        "dagJson",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("up() applies correct DEFAULT values for walletPublicKey, status, and dagJson", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    db.prepare(
      `INSERT INTO tasks (id, prompt, createdAt, updatedAt)
       VALUES ('t1', 'hello', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
    ).run();

    const row = db
      .prepare("SELECT walletPublicKey, status, dagJson FROM tasks WHERE id = 't1'")
      .get() as { walletPublicKey: string; status: string; dagJson: string };

    expect(row.walletPublicKey).toBe("");
    expect(row.status).toBe("queued");
    expect(row.dagJson).toBe("[]");
  });

  it("up() is idempotent — a second migrateToLatest call applies nothing extra", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const second = migrateToLatest(db, MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
  });

  it("down() removes the tasks table", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 6); // roll back all 6 migrations

    expect(tables(db)).not.toContain("tasks");
    expect(appliedVersions(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 002_create_task_events_table
// ---------------------------------------------------------------------------

describe("tasks migrations — 002_create_task_events_table", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
    migrateToLatest(db, MIGRATIONS_DIR);
    // Roll back to just v1 so we can test v2 in isolation.
    rollback(db, MIGRATIONS_DIR, 5);
  });

  afterEach(() => {
    db.close();
  });

  it("starting state: only tasks table exists after rolling back to v1", () => {
    expect(appliedVersions(db)).toEqual([1]);
    expect(tables(db)).toContain("tasks");
    expect(tables(db)).not.toContain("task_events");
  });

  it("up() adds task_events table with correct columns", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("task_events");
    const cols = columns(db, "task_events");
    expect(cols).toEqual(
      expect.arrayContaining(["id", "taskId", "type", "nodeId", "payload", "timestamp"]),
    );
  });

  it("up() creates idx_task_events_taskId index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_task_events_taskId");
  });

  it("down() drops the task_events table and its index", () => {
    migrateToLatest(db, MIGRATIONS_DIR); // bring back to v6
    rollback(db, MIGRATIONS_DIR, 5);    // roll back v6, v5, v4, v3, v2

    expect(appliedVersions(db)).toEqual([1]);
    expect(tables(db)).not.toContain("task_events");
    expect(indexes(db)).not.toContain("idx_task_events_taskId");
  });

  it("down() leaves tasks table untouched", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 5);

    expect(tables(db)).toContain("tasks");
  });
});

// ---------------------------------------------------------------------------
// 003_create_quality_scores_table
// ---------------------------------------------------------------------------

describe("tasks migrations — 003_create_quality_scores_table", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
    migrateToLatest(db, MIGRATIONS_DIR);
    // Roll back to v2 so we can test v3 in isolation.
    rollback(db, MIGRATIONS_DIR, 4);
  });

  afterEach(() => {
    db.close();
  });

  it("starting state: tasks + task_events exist, quality_scores does not", () => {
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tables(db)).not.toContain("quality_scores");
  });

  it("up() creates quality_scores with all expected columns", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("quality_scores");
    const cols = columns(db, "quality_scores");
    expect(cols).toEqual(
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
      ]),
    );
  });

  it("up() creates idx_quality_scores_agentId index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_quality_scores_agentId");
  });

  it("down() drops quality_scores table and its index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 4);

    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tables(db)).not.toContain("quality_scores");
    expect(indexes(db)).not.toContain("idx_quality_scores_agentId");
  });
});

// ---------------------------------------------------------------------------
// 004_add_created_at_index
// ---------------------------------------------------------------------------

describe("tasks migrations — 004_add_created_at_index", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
    migrateToLatest(db, MIGRATIONS_DIR);
    // Roll back to v3 so we can test v4 in isolation.
    rollback(db, MIGRATIONS_DIR, 3);
  });

  afterEach(() => {
    db.close();
  });

  it("starting state: idx_tasks_created_at does not exist at v3", () => {
    expect(appliedVersions(db)).toEqual([1, 2, 3]);
    expect(indexes(db)).not.toContain("idx_tasks_created_at");
  });

  it("up() adds idx_tasks_created_at index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_tasks_created_at");
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("down() removes idx_tasks_created_at index and leaves tasks table intact", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 3);

    expect(indexes(db)).not.toContain("idx_tasks_created_at");
    expect(tables(db)).toContain("tasks");
  });

  it("up() is idempotent — a second migrateToLatest adds nothing", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const second = migrateToLatest(db, MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// Full chain: v1 → v2 → v3 → v4 then v4 → v3 → v2 → v1 → (empty)
// ---------------------------------------------------------------------------

describe("tasks migrations — full forward and reverse chain", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("applies all 6 migrations in order and records them in the ledger", () => {
    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toEqual([
      "1_create_tasks_table",
      "2_create_task_events_table",
      "3_create_quality_scores_table",
      "4_add_created_at_index",
      "5_add_task_results",
      "6_create_idempotency_keys",
    ]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("single-step rollback removes only the latest migration (v6)", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const { rolledBack } = rollback(db, MIGRATIONS_DIR, 1);

    expect(rolledBack).toEqual(["6_create_idempotency_keys"]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tables(db)).not.toContain("idempotency_keys");
    expect(tables(db)).toContain("quality_scores");
    expect(indexes(db)).toContain("idx_tasks_created_at");
  });

  it("rollback to v2 removes quality_scores but keeps task_events", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 4); // removes v6 + v5 + v4 + v3

    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tables(db)).not.toContain("quality_scores");
    expect(tables(db)).toContain("task_events");
  });

  it("rollback to v1 removes task_events but keeps tasks", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 5); // removes v6 + v5 + v4 + v3 + v2

    expect(appliedVersions(db)).toEqual([1]);
    expect(tables(db)).not.toContain("task_events");
    expect(tables(db)).toContain("tasks");
  });

  it("full rollback (all 6 steps) leaves an empty schema", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const { rolledBack } = rollback(db, MIGRATIONS_DIR, 6);

    expect(rolledBack).toEqual([
      "6_create_idempotency_keys",
      "5_add_task_results",
      "4_add_created_at_index",
      "3_create_quality_scores_table",
      "2_create_task_events_table",
      "1_create_tasks_table",
    ]);
    expect(tables(db)).toHaveLength(0);
    expect(indexes(db)).toHaveLength(0);
    expect(appliedVersions(db)).toHaveLength(0);
  });

  it("migrating forward again after a full rollback restores the complete schema", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 6);

    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toHaveLength(6);
    expect(tables(db)).toEqual(
      expect.arrayContaining(["tasks", "task_events", "quality_scores", "idempotency_keys"]),
    );
    expect(indexes(db)).toEqual(
      expect.arrayContaining(["idx_task_events_taskId", "idx_quality_scores_agentId", "idx_tasks_created_at", "idx_idempotency_expires_at"]),
    );
  });

  it("partial rollback (v6→v4) then re-migrate restores v5 and v6", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 2); // back to v4

    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toEqual([
      "5_add_task_results",
      "6_create_idempotency_keys",
    ]);
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// 006_create_idempotency_keys
// ---------------------------------------------------------------------------

describe("tasks migrations — 006_create_idempotency_keys", () => {
  let db: InstanceType<typeof RealDatabase>;

  beforeEach(() => {
    db = openDb();
    // Roll back to v5 so we can test v6 in isolation.
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 1);
  });

  afterEach(() => {
    db.close();
  });

  it("starting state: idempotency_keys does not exist at v5", () => {
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tables(db)).not.toContain("idempotency_keys");
  });

  it("up() creates idempotency_keys with all expected columns", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("idempotency_keys");
    const cols = columns(db, "idempotency_keys");
    expect(cols).toEqual(
      expect.arrayContaining([
        "key",
        "wallet_address",
        "response_body",
        "status_code",
        "created_at",
        "expires_at",
        "request_hash",
      ]),
    );
  });

  it("up() creates idx_idempotency_expires_at index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_idempotency_expires_at");
  });

  it("down() drops the idempotency_keys table", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    expect(tables(db)).toContain("idempotency_keys");

    rollback(db, MIGRATIONS_DIR, 1);

    expect(tables(db)).not.toContain("idempotency_keys");
    expect(indexes(db)).not.toContain("idx_idempotency_expires_at");
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);
  });
});
