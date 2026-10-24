#!/usr/bin/env node
/**
 * detect-flaky-tests.js
 *
 * Runs the test suite N times and reports tests that don't pass on every run.
 * A test is "flaky" if it passes on at least one run but fails on at least one
 * other run.  A test that fails every single run is a "consistently failing"
 * test — still worth knowing about, but different from a flake.
 *
 * Usage
 * -----
 *   node scripts/detect-flaky-tests.js --suite backend --runs 5
 *   node scripts/detect-flaky-tests.js --suite frontend --runs 5
 *
 * Options
 * -------
 *   --suite   backend | frontend   (required)
 *   --runs    number of times to run the suite  (default: 5)
 *   --json    path to write a JSON summary file  (optional)
 *
 * Exit codes
 * ----------
 *   0  no flaky or consistently-failing tests detected
 *   1  one or more flaky tests detected
 *   2  invalid arguments or runner error
 *
 * Issue: #95
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let suite = null;
let runs = 5;
let jsonOut = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--suite' && args[i + 1]) suite = args[++i];
  else if (args[i] === '--runs' && args[i + 1]) runs = parseInt(args[++i], 10);
  else if (args[i] === '--json' && args[i + 1]) jsonOut = args[++i];
}

if (!suite || !['backend', 'frontend'].includes(suite)) {
  console.error('❌  --suite must be "backend" or "frontend"');
  process.exit(2);
}

if (!Number.isInteger(runs) || runs < 1) {
  console.error('❌  --runs must be a positive integer');
  process.exit(2);
}

// ─── suite configuration ─────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

const SUITE_CONFIG = {
  backend: {
    cwd: path.join(ROOT, 'backend'),
    cmd: 'npx',
    // --json writes structured output we can parse; --no-coverage speeds things up
    args: ['jest', '--runInBand', '--forceExit', '--json', '--no-coverage'],
    jsonField: 'testResults',
  },
  frontend: {
    cwd: path.join(ROOT, 'frontend'),
    cmd: 'npx',
    args: ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-flaky-out.json'],
    jsonField: 'testResults',
    jsonFile: '/tmp/vitest-flaky-out.json',
  },
};

const config = SUITE_CONFIG[suite];

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Runs the test command once and returns an array of
 * { name: string, passed: boolean, duration: number } objects.
 */
function runOnce(runIndex) {
  console.log(`\n▶  Run ${runIndex + 1}/${runs} (${suite})…`);

  const result = spawnSync(config.cmd, config.args, {
    cwd: config.cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0' },
    // Jest --json emits to stdout; allow up to 64 MB
    maxBuffer: 64 * 1024 * 1024,
  });

  let parsed = null;

  if (suite === 'backend') {
    // Jest writes the JSON to stdout when --json is set
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Jest can emit non-JSON preamble (ts-jest banner etc.) before the JSON
      const jsonStart = result.stdout.indexOf('{');
      if (jsonStart !== -1) {
        try {
          parsed = JSON.parse(result.stdout.slice(jsonStart));
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    // Vitest writes to --outputFile
    try {
      const raw = fs.readFileSync(config.jsonFile, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }

  if (!parsed) {
    console.warn(`  ⚠  Could not parse JSON output for run ${runIndex + 1}; treating all tests as "unknown"`);
    return [];
  }

  const tests = [];

  // Normalize Jest and Vitest JSON shapes into a common array
  const fileResults = parsed.testResults ?? parsed.files ?? [];
  for (const file of fileResults) {
    const assertions = file.assertionResults ?? file.tests ?? [];
    for (const t of assertions) {
      const name = [
        ...(t.ancestorTitles ?? t.suiteName?.split(' > ') ?? []),
        t.title ?? t.name ?? 'unknown',
      ].join(' > ');
      tests.push({
        name,
        file: file.testFilePath ?? file.name ?? '',
        passed: (t.status === 'passed') || (t.result === 'pass'),
        duration: t.duration ?? 0,
      });
    }
  }

  return tests;
}

// ─── main ────────────────────────────────────────────────────────────────────

console.log(`\n🔍  Flaky-test detector — suite: ${suite}, runs: ${runs}\n`);

/** Map<testName, { passes: number, failures: number, file: string }> */
const stats = new Map();

for (let i = 0; i < runs; i++) {
  const tests = runOnce(i);
  for (const t of tests) {
    if (!stats.has(t.name)) {
      stats.set(t.name, { passes: 0, failures: 0, file: t.file });
    }
    const entry = stats.get(t.name);
    if (t.passed) entry.passes++;
    else entry.failures++;
  }
}

// ─── classify results ─────────────────────────────────────────────────────────

const flaky = [];
const alwaysFailing = [];

for (const [name, entry] of stats.entries()) {
  if (entry.passes > 0 && entry.failures > 0) {
    flaky.push({ name, ...entry });
  } else if (entry.passes === 0 && entry.failures > 0) {
    alwaysFailing.push({ name, ...entry });
  }
}

// ─── report ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(72));
console.log(`📊  Results after ${runs} runs (${suite})`);
console.log('─'.repeat(72));

if (flaky.length === 0 && alwaysFailing.length === 0) {
  console.log('✅  No flaky or consistently failing tests detected.\n');
} else {
  if (flaky.length > 0) {
    console.log(`\n⚠️   FLAKY TESTS (${flaky.length}):`);
    for (const t of flaky) {
      const rate = ((t.failures / runs) * 100).toFixed(0);
      console.log(`  • [${rate}% failure rate]  ${t.name}`);
      console.log(`    File: ${t.file}`);
    }
  }

  if (alwaysFailing.length > 0) {
    console.log(`\n❌  CONSISTENTLY FAILING TESTS (${alwaysFailing.length}):`);
    for (const t of alwaysFailing) {
      console.log(`  • ${t.name}`);
      console.log(`    File: ${t.file}`);
    }
  }
}

console.log('─'.repeat(72) + '\n');

// ─── JSON output ──────────────────────────────────────────────────────────────

const summary = {
  suite,
  runs,
  timestamp: new Date().toISOString(),
  flaky,
  alwaysFailing,
  totalUnique: stats.size,
};

if (jsonOut) {
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(`📄  JSON summary written to ${jsonOut}\n`);
}

// Always print a machine-readable summary to stdout for CI consumption
process.stdout.write(`::set-output name=flaky_count::${flaky.length}\n`);
process.stdout.write(`::set-output name=always_failing_count::${alwaysFailing.length}\n`);

process.exit(flaky.length > 0 ? 1 : 0);
