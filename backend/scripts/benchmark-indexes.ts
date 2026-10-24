/**
 * Benchmark the #32 indexes on representative SQLite workloads.
 *
 * Usage: `npm run benchmark:indexes` (from `backend/`).
 *
 * Each case seeds a throwaway database, measures the filtered query without
 * the index, creates the index, measures again, and prints a markdown table.
 */
import fs from "fs";
import os from "os";
import path from "path";

import Database from "better-sqlite3";

const TASKS = 50_000;
const PAYMENTS = 30_000;
const AGENTS = 10_000;
const RUNS = 25;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-net-index-bench-"));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function measure(
  db: Database.Database,
  sql: string,
  params: unknown[],
  runs = RUNS,
): { avg: number; p95: number } {
  const samples: number[] = [];
  const statement = db.prepare(sql);
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    statement.all(...params);
    samples.push(performance.now() - start);
  }
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { avg, p95: percentile(samples, 95) };
}

function format(ms: number): string {
  return ms < 0.01 ? "<0.01" : ms.toFixed(2);
}

interface CaseResult {
  table: string;
  index: string;
  query: string;
  before: { avg: number; p95: number };
  after: { avg: number; p95: number };
}

const results: CaseResult[] = [];

function runCase(
  label: string,
  file: string,
  schema: string,
  seed: (db: Database.Database) => void,
  indexSql: string,
  sql: string,
  params: unknown[],
): void {
  const filePath = path.join(tmpDir, file);
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.exec(schema);
  seed(db);
  db.exec("ANALYZE");

  const before = measure(db, sql, params);
  db.exec(indexSql);
  db.exec("ANALYZE");
  const after = measure(db, sql, params);

  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => String((row as { detail?: string }).detail ?? ""))
    .join("; ");
  console.log(`\n${label}\n  plan: ${plan}`);

  results.push({ table: label, index: indexSql, query: sql, before, after });
  db.close();
  fs.rmSync(filePath, { force: true });
  fs.rmSync(`${filePath}-wal`, { force: true });
  fs.rmSync(`${filePath}-shm`, { force: true });
}

// ── tasks(walletPublicKey, createdAt) ────────────────────────────────────────
runCase(
  "tasks(walletPublicKey, createdAt)",
  "tasks.db",
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     prompt TEXT NOT NULL,
     walletPublicKey TEXT NOT NULL,
     status TEXT NOT NULL,
     "createdAt" TEXT NOT NULL
   );`,
  (db) => {
    const insert = db.prepare(
      `INSERT INTO tasks (id, prompt, walletPublicKey, status, "createdAt")
       VALUES (?, ?, ?, ?, ?)`,
    );
    const statuses = ["queued", "running", "completed", "failed", "cancelled"];
    const base = Date.now() - 365 * 86_400_000;
    db.transaction(() => {
      for (let i = 0; i < TASKS; i += 1) {
        insert.run(
          `task_${i}`,
          `Prompts for task ${i}`,
          `GWALLET${i % 500}`,
          statuses[i % statuses.length],
          new Date(base + i * 60_000).toISOString(),
        );
      }
    })();
  },
  `CREATE INDEX idx_tasks_wallet_created ON tasks (walletPublicKey, "createdAt")`,
  `SELECT * FROM tasks WHERE walletPublicKey = ? AND "createdAt" >= ?
   ORDER BY "createdAt" DESC LIMIT 20`,
  ["GWALLET42", new Date(Date.now() - 180 * 86_400_000).toISOString()],
);

// ── payments(taskId, status) ─────────────────────────────────────────────────
runCase(
  "payments(taskId, status)",
  "payments.db",
  `CREATE TABLE payments (
     taskId TEXT NOT NULL,
     nodeId TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'locked',
     amountStroops TEXT NOT NULL,
     PRIMARY KEY (taskId, nodeId)
   );`,
  (db) => {
    const insert = db.prepare(
      "INSERT INTO payments (taskId, nodeId, status, amountStroops) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < PAYMENTS; i += 1) {
        insert.run(
          `task_${i % 5}`,
          `node_${i}`,
          i % 3 === 0 ? "released" : i % 3 === 1 ? "locked" : "refunded",
          "10000000",
        );
      }
    })();
  },
  "CREATE INDEX idx_payments_task_status ON payments (taskId, status)",
  "SELECT * FROM payments WHERE taskId = ? AND status = ?",
  ["task_2", "refunded"],
);

// ── agents(status, capabilities) ─────────────────────────────────────────────
runCase(
  "agents(status, capabilities)",
  "agents.db",
  `CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     capabilities TEXT NOT NULL,
     status TEXT NOT NULL
   );`,
  (db) => {
    const insert = db.prepare(
      "INSERT INTO agents (id, capabilities, status) VALUES (?, ?, ?)",
    );
    const capabilities = ["research", "risk", "coding", "design", "report"];
    db.transaction(() => {
      for (let i = 0; i < AGENTS; i += 1) {
        insert.run(
          `agent_${i}`,
          JSON.stringify([capabilities[i % capabilities.length]]),
          i % 10 === 0 ? "offline" : "online",
        );
      }
    })();
  },
  "CREATE INDEX idx_agents_status_capabilities ON agents (status, capabilities)",
  `SELECT * FROM agents
   WHERE status = ? AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)`,
  ["offline", "research"],
);

// ── report ──────────────────────────────────────────────────────────────────
console.log("\n| Index | Query | Before avg (ms) | Before p95 (ms) | After avg (ms) | After p95 (ms) | Speedup |");
console.log("|---|---|---:|---:|---:|---:|---:|");
for (const result of results) {
  const speedup =
    result.after.avg > 0 ? result.before.avg / result.after.avg : Infinity;
  console.log(
    `| \`${result.index.replace(/^CREATE INDEX /, "")}\` | \`${result.query.replace(/\s+/g, " ").slice(0, 70)}…\` | ${format(result.before.avg)} | ${format(result.before.p95)} | ${format(result.after.avg)} | ${format(result.after.p95)} | ${speedup.toFixed(1)}× |`,
  );
}

fs.rmSync(tmpDir, { recursive: true, force: true });
