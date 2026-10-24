/**
 * Migration tests for payments.db
 *
 * Verifies that every migration in the payments migrations directory applies
 * the correct schema changes (tables, columns, indexes) and rolls back
 * cleanly.  Also covers the multi-step chain v1→v2 forward and v2→v1 in
 * reverse.
 *
 * Real SQLite is used (jest.requireActual) so that actual DDL executes rather
 * than the no-op mock wired via moduleNameMapper.
 */

import path from "path";
import { migrateToLatest, rollback, getAppliedMigrations } from "../migrator";

// Bypass the moduleNameMapper mock — we need real SQLite for schema assertions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = jest.requireActual<typeof import("better-sqlite3")>("better-sqlite3");

const MIGRATIONS_DIR = path.join(__dirname, "payments");

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
// 001_create_payments_table
// ---------------------------------------------------------------------------

describe("payments migrations — 001_create_payments_table", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("up() creates the payments table", () => {
    expect(tables(db)).not.toContain("payments");

    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("payments");
  });

  it("up() creates all expected columns", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    const cols = columns(db, "payments");
    expect(cols).toEqual(
      expect.arrayContaining([
        "taskId",
        "nodeId",
        "balanceId",
        "status",
        "amountStroops",
        "txHash",
      ]),
    );
  });

  it("up() sets default value 'locked' for status", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    db.prepare(
      `INSERT INTO payments (taskId, nodeId, balanceId, amountStroops)
       VALUES ('t1', 'n1', 'b1', '100')`,
    ).run();

    const row = db
      .prepare("SELECT status FROM payments WHERE taskId = 't1' AND nodeId = 'n1'")
      .get() as { status: string };

    expect(row.status).toBe("locked");
  });

  it("up() enforces composite PRIMARY KEY (taskId, nodeId)", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    const insert = db.prepare(
      `INSERT INTO payments (taskId, nodeId, balanceId, amountStroops)
       VALUES (?, ?, ?, ?)`,
    );

    insert.run("t1", "n1", "b1", "100");

    // Inserting a row with the same (taskId, nodeId) pair must fail.
    expect(() => insert.run("t1", "n1", "b2", "200")).toThrow();
  });

  it("up() is idempotent — a second migrateToLatest applies nothing extra", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const second = migrateToLatest(db, MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
    expect(appliedVersions(db)).toHaveLength(2); // both v1 and v2 applied
  });

  it("down() removes the payments table", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    rollback(db, MIGRATIONS_DIR, 2); // roll back both migrations

    expect(tables(db)).not.toContain("payments");
    expect(appliedVersions(db)).toHaveLength(0);
  });

  it("down() leaves an empty schema after rolling back the only initial migration", () => {
    // Only apply v1, not v2, then roll it back.
    // We achieve this by applying all and rolling back all.
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 2);

    expect(tables(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 002_add_status_index
// ---------------------------------------------------------------------------

describe("payments migrations — 002_add_status_index", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
    // Start at v1 only.
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 1); // roll back v2
  });

  afterEach(() => {
    db.close();
  });

  it("starting state: payments table exists but idx_payments_status does not", () => {
    expect(appliedVersions(db)).toEqual([1]);
    expect(tables(db)).toContain("payments");
    expect(indexes(db)).not.toContain("idx_payments_status");
  });

  it("up() adds idx_payments_status index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_payments_status");
    expect(appliedVersions(db)).toEqual([1, 2]);
  });

  it("down() removes idx_payments_status and leaves payments table intact", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 1);

    expect(indexes(db)).not.toContain("idx_payments_status");
    expect(tables(db)).toContain("payments");
    expect(appliedVersions(db)).toEqual([1]);
  });

  it("up() is idempotent — a second migrateToLatest applies nothing", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const second = migrateToLatest(db, MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
    expect(indexes(db)).toContain("idx_payments_status");
  });
});

// ---------------------------------------------------------------------------
// Full chain: v1 → v2 forward and v2 → v1 → (empty) reverse
// ---------------------------------------------------------------------------

describe("payments migrations — full forward and reverse chain", () => {
  let db: Db;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("applies both migrations in order and records them", () => {
    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toEqual([
      "1_create_payments_table",
      "2_add_status_index",
    ]);
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(tables(db)).toContain("payments");
    expect(indexes(db)).toContain("idx_payments_status");
  });

  it("v2 → v1 rollback removes only the status index", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const { rolledBack } = rollback(db, MIGRATIONS_DIR, 1);

    expect(rolledBack).toEqual(["2_add_status_index"]);
    expect(appliedVersions(db)).toEqual([1]);
    expect(indexes(db)).not.toContain("idx_payments_status");
    expect(tables(db)).toContain("payments");
  });

  it("full rollback (both steps) leaves an empty schema", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const { rolledBack } = rollback(db, MIGRATIONS_DIR, 2);

    expect(rolledBack).toEqual([
      "2_add_status_index",
      "1_create_payments_table",
    ]);
    expect(tables(db)).toHaveLength(0);
    expect(indexes(db)).toHaveLength(0);
    expect(appliedVersions(db)).toHaveLength(0);
  });

  it("full rollback then re-migrate restores the complete schema", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 2);

    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toHaveLength(2);
    expect(tables(db)).toContain("payments");
    expect(indexes(db)).toContain("idx_payments_status");
    expect(appliedVersions(db)).toEqual([1, 2]);
  });

  it("partial rollback (v2→v1) then re-migrate restores v2", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 1);

    const { applied } = migrateToLatest(db, MIGRATIONS_DIR);

    expect(applied).toEqual(["2_add_status_index"]);
    expect(appliedVersions(db)).toEqual([1, 2]);
    expect(indexes(db)).toContain("idx_payments_status");
  });

  it("data inserted before v2 is still accessible after rolling back and re-applying v2", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    db.prepare(
      `INSERT INTO payments (taskId, nodeId, balanceId, status, amountStroops)
       VALUES ('t1', 'n1', 'b1', 'released', '500')`,
    ).run();

    // Roll back v2 (index) — data must survive.
    rollback(db, MIGRATIONS_DIR, 1);

    const row = db
      .prepare("SELECT status FROM payments WHERE taskId = 't1' AND nodeId = 'n1'")
      .get() as { status: string } | undefined;

    expect(row?.status).toBe("released");

    // Re-apply v2.
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(indexes(db)).toContain("idx_payments_status");
    expect(
      (db.prepare("SELECT status FROM payments WHERE taskId = 't1'").get() as { status: string })
        .status,
    ).toBe("released");
  });
});
