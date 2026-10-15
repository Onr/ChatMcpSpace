#!/usr/bin/env node
'use strict';
const { reviewExecutorRecovery } = require('../src/shared/executorRecovery');
const { stopExecutorRecovery } = require('../src/shared/executorRecoveryStop');
const { releaseExecutorRecovery } = require('../src/shared/executorRecoveryRelease');

async function main(argv) {
  const mode = argv[0];
  if (!['inspect', 'stop', 'release'].includes(mode)) throw Error('Expected inspect, stop or release');
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    if (mode === 'release' && argv[i] === '--discard-task-files') {
      if (options.discardTaskFiles) throw Error('Repeated discard option');
      options.discardTaskFiles = true; continue;
    }
    const key = { '--root': 'root', '--podman': 'podmanPath',
      ...(mode !== 'inspect' ? { '--receipt-sha256': 'receiptSha256' } : {}),
      ...(mode === 'release' ? { '--stop-operation': 'stopOperation' } : {}) }[argv[i]];
    if (!key || options[key] !== undefined || !argv[i + 1]) throw Error('Invalid or repeated recovery option');
    options[key] = argv[++i];
  }
  const action = { inspect: reviewExecutorRecovery, stop: stopExecutorRecovery, release: releaseExecutorRecovery }[mode];
  const report = await action(options);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.blockers.length ? 2 : 0;
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
  // Engine diagnostics and corrupted receipt contents may be sensitive.
  process.stderr.write(process.argv[2] === 'inspect' ?
    'Recovery review failed; preserve admission and consult the operator. No cleanup was performed.\n' :
    'Recovery operation failed; preserve retained files and durable operator audits. Review the recorded outcome before continuing.\n');
  process.exitCode = 1;
});
module.exports = { main };
