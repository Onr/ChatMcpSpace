const fs = require('fs');
const path = require('path');

function usage() {
  console.log('Usage: node tests/perf/compare-chat-switch-reports.js <baseline.json> <candidate.json>');
}

function pctChange(base, next) {
  if (!Number.isFinite(base) || base === 0 || !Number.isFinite(next)) return null;
  return ((next - base) / base) * 100;
}

function fmtPct(v) {
  if (v === null) return 'n/a';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function readReport(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const json = JSON.parse(raw);
  const byViewport = new Map();

  for (const v of json.viewports || []) {
    byViewport.set(v.viewport?.name, v.summary || {});
  }

  return { abs, json, byViewport };
}

(function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    usage();
    process.exit(1);
  }

  const baseline = readReport(baselinePath);
  const candidate = readReport(candidatePath);

  const viewports = new Set([...baseline.byViewport.keys(), ...candidate.byViewport.keys()]);
  const metrics = ['avgMs', 'p50Ms', 'p90Ms', 'p95Ms', 'maxMs'];

  console.log('Chat switch performance comparison');
  console.log(`Baseline:  ${baseline.abs}`);
  console.log(`Candidate: ${candidate.abs}`);
  console.log('');

  for (const name of viewports) {
    const b = baseline.byViewport.get(name) || {};
    const c = candidate.byViewport.get(name) || {};
    console.log(`[${name}]`);

    for (const metric of metrics) {
      const baseVal = b[metric];
      const candVal = c[metric];
      const delta = pctChange(baseVal, candVal);
      const baseText = Number.isFinite(baseVal) ? `${Math.round(baseVal)}ms` : 'n/a';
      const candText = Number.isFinite(candVal) ? `${Math.round(candVal)}ms` : 'n/a';
      console.log(`  ${metric}: ${baseText} -> ${candText} (${fmtPct(delta)})`);
    }

    console.log('');
  }
})();
