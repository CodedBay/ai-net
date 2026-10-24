#!/usr/bin/env node

const fs = require('node:fs');

const [currentPath, baselinePath, reportPath] = process.argv.slice(2);

if (!currentPath || !baselinePath || !reportPath) {
  console.error('Usage: node compare-gas.js <current.json> <baseline.json> <report.json>');
  process.exit(2);
}

function readMeasurements(path) {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  const measurements = Array.isArray(parsed) ? parsed : parsed.gas;

  if (!Array.isArray(measurements)) {
    throw new Error(`${path} must contain an array of gas measurements`);
  }

  const byOperation = new Map();
  for (const measurement of measurements) {
    if (typeof measurement.operation !== 'string' || measurement.operation.length === 0) {
      throw new Error(`${path} contains a measurement without an operation name`);
    }
    if (byOperation.has(measurement.operation)) {
      throw new Error(`${path} contains duplicate measurements for ${measurement.operation}`);
    }

    const cpuInsns = BigInt(measurement.cpu_insns);
    if (cpuInsns <= 0n) {
      throw new Error(`${path} contains a non-positive CPU instruction count for ${measurement.operation}`);
    }
    byOperation.set(measurement.operation, cpuInsns);
  }

  if (byOperation.size === 0) {
    throw new Error(`${path} contains no gas measurements`);
  }

  return byOperation;
}

try {
  const current = readMeasurements(currentPath);
  const baseline = fs.existsSync(baselinePath) ? readMeasurements(baselinePath) : new Map();
  const results = [...current].map(([operation, currentCpu]) => {
    const baselineCpu = baseline.get(operation);
    const deltaBasisPoints = baselineCpu === undefined ? null : (currentCpu - baselineCpu) * 10000n;
    const changeHundredths = deltaBasisPoints === null
      ? null
      : Number(deltaBasisPoints >= 0n
        ? (deltaBasisPoints + baselineCpu / 2n) / baselineCpu
        : (deltaBasisPoints - baselineCpu / 2n) / baselineCpu);
    const changePercent = changeHundredths === null ? null : changeHundredths / 100;

    return {
      operation,
      baseline_cpu_insns: baselineCpu?.toString() ?? null,
      current_cpu_insns: currentCpu.toString(),
      change_percent: changePercent,
      regression: baselineCpu !== undefined && currentCpu * 100n > baselineCpu * 120n,
    };
  });

  const report = {
    threshold_percent: 20,
    baseline_available: baseline.size > 0,
    results,
    regressions: results.filter((result) => result.regression).map((result) => result.operation),
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdownPath = reportPath.replace(/\.json$/i, '.md');
  const table = [
    '| Function | Baseline gas (CPU insns) | Current gas (CPU insns) | Change |',
    '| --- | ---: | ---: | ---: |',
    ...results.map((result) => (
      `| ${result.operation} | ${result.baseline_cpu_insns ?? 'n/a'} | ` +
      `${result.current_cpu_insns} | ${result.change_percent === null ? 'baseline' : `${result.change_percent.toFixed(2)}%`} |`
    )),
  ];
  fs.writeFileSync(markdownPath, `${table.join('\n')}\n`);
  console.table(results.map(({ operation, baseline_cpu_insns, current_cpu_insns, change_percent }) => ({
    operation,
    baseline_cpu_insns: baseline_cpu_insns ?? 'n/a',
    current_cpu_insns,
    change_percent: change_percent === null ? 'new baseline' : `${change_percent.toFixed(2)}%`,
  })));

  if (report.regressions.length > 0) {
    console.error(`Gas regression exceeds 20%: ${report.regressions.join(', ')}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Unable to compare gas measurements: ${error.message}`);
  process.exitCode = 2;
}
