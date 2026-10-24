/**
 * Migration tests for agents.db
 *
 * These tests verify that every migration in the agents migrations directory
 * applies the expected schema changes and rolls back cleanly to the prior
 * state.  They use the real better-sqlite3 (via jest.requireActual) so that
 * actual SQL is executed against an in-memory SQLite database rather than the
 * no-op mock wired up by moduleNameMapper.
 */

import path from "path";
import { migrateToLatest, rollback, getAppliedMigrations } from "../migrator";

// Bypass the moduleNameMapper mock so real SQLite is used for schema assertions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = jest.requireActual<typeof import("better-sqlite3")>("better-sqlite3");

const MIGRATIONS_DIR = path.join(__dirname, "agents");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh in-memory database that is automatically closed after the test. */
function openDb(): InstanceType<typeof RealDatabase> {
  return new RealDatabase(":memory:");
}

/**
 * Returns the names of all user tables (excluding SQLite internals and the
 * schema_migrations ledger) present in the database.
 */
function tables(db: InstanceType<typeof RealDatabase>): string[] {
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

/** Returns the column names of a table, or an empty array if it doesn't exist. */
function columns(db: InstanceType<typeof RealDatabase>, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// 001_create_agents_table
// ---------------------------------------------------------------------------

describe("agents migrations — 001_create_agents_table", () => {
  let db: InstanceType<typeof RealDatabase>;

  beforeEach(() => {
    db = openDb();
  });

  afterEach(() => {
    db.close();
  });

  it("up() creates the agents table with the expected columns", () => {
    expect(tables(db)).not.toContain("agents");

    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("agents");
    const cols = columns(db, "agents");
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "capabilities",
        "pricingXLM",
        "endpoint",
        "stellarPublicKey",
        "reputationScore",
        "lastSeenAt",
        "status",
      ]),
    );
  });

  it("up() sets the correct DEFAULT values for reputationScore and status", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    db.prepare(
      `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, lastSeenAt)
       VALUES ('agent-1', '["nlp"]', 0.5, 'http://localhost', 'GABC', '2024-01-01T00:00:00Z')`,
    ).run();

    const row = db
      .prepare("SELECT reputationScore, status FROM agents WHERE id = 'agent-1'")
      .get() as { reputationScore: number; status: string };

    expect(row.reputationScore).toBe(0);
    expect(row.status).toBe("offline");
  });

  it("up() is idempotent — running migrateToLatest twice does not error and adds no duplicate rows", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const secondRun = migrateToLatest(db, MIGRATIONS_DIR);

    expect(secondRun.applied).toEqual([]);
    expect(getAppliedMigrations(db)).toHaveLength(2);
    // Table still exists and is intact.
    expect(tables(db)).toContain("agents");
  });

  it("down() drops the agents table", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    expect(tables(db)).toContain("agents");

    rollback(db, MIGRATIONS_DIR, 2);

    expect(tables(db)).not.toContain("agents");
    expect(getAppliedMigrations(db)).toHaveLength(0);
  });

  it("down() reverts to exact prior schema (no agents table at all)", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    rollback(db, MIGRATIONS_DIR, 2);

    // No user tables should remain after rolling back every migration.
    expect(tables(db)).toHaveLength(0);
  });

  it("up → down → up round-trip restores the same schema", () => {
    migrateToLatest(db, MIGRATIONS_DIR);
    const colsBefore = columns(db, "agents");

    rollback(db, MIGRATIONS_DIR, 2);
    migrateToLatest(db, MIGRATIONS_DIR);

    expect(tables(db)).toContain("agents");
    expect(columns(db, "agents")).toEqual(colsBefore);
    expect(getAppliedMigrations(db)).toHaveLength(2);
  });

  it("agents table accepts data and enforces PRIMARY KEY uniqueness", () => {
    migrateToLatest(db, MIGRATIONS_DIR);

    const insert = db.prepare(
      `INSERT INTO agents (id, capabilities, pricingXLM, endpoint, stellarPublicKey, lastSeenAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    insert.run("a1", '["search"]', 1.0, "http://a1", "GA1", "2024-01-01T00:00:00Z");

    expect(() =>
      insert.run("a1", '["nlp"]', 2.0, "http://a1b", "GA1B", "2024-01-02T00:00:00Z"),
    ).toThrow();
  });
});
