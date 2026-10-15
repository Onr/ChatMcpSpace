'use strict';
const fs = require('fs');
const path = require('path');

// Public, dependency-free artifact. Reads only fixed source paths, never config or secrets.
function generateSharedRunnerBundle() {
  const root = path.join(__dirname, '../..');
  const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/^#!.*\n/, '');
  const shared = read('scripts/shared-agent-runner.js');
  const bridge = read('scripts/external-agent-bridge.js');
  const cryptoSource = read('public/js/shared-crypto.js');
  const executor = read('src/shared/restrictedExecutor.js').replace(/require\(['"]\.\/executorCgroup['"]\)/, 'bundled.cgroup')
    .replace(/require\(['"]\.\/executorHostPolicy['"]\)/, 'bundled.hostPolicy')
    .replace(/require\(['"]\.\/restricted-seccomp\.json['"]\)/, 'bundled.seccomp');
  const hostPolicy = read('src/shared/executorHostPolicy.js');
  const cgroup = read('src/shared/executorCgroup.js').replace(/require\(['"]\.\/restrictedExecutor['"]\)/, 'bundled.executor');
  const supervisor = read('src/shared/executorSupervisor.js').replace(/require\(['"]\.\/restrictedExecutor['"]\)/, 'bundled.executor')
    .replace(/require\(['"]\.\/executorCgroup['"]\)/, 'bundled.cgroup');
  const broker = read('src/shared/boundActionBroker.js');
  return '#!/usr/bin/env node\nconst bundled = {};\n' +
    `/*\n${read('src/shared/restricted-seccomp.NOTICE')}\n${read('src/shared/restricted-seccomp.LICENSE')}\n*/\n` +
    `bundled.seccomp = JSON.parse(${JSON.stringify(read('src/shared/restricted-seccomp.json'))});\n` +
    `bundled.bridge = (() => { const module = {exports:{}}; ${bridge}\n return module.exports; })();\n` +
    `bundled.crypto = (() => { const module = {exports:{}}; ${cryptoSource}\n return module.exports; })();\n` +
    `bundled.hostPolicy = (() => { const module = {exports:{}}; ${hostPolicy}\n return module.exports; })();\n` +
    `bundled.executor = (() => { const module = {exports:{}}; ${executor}\n return module.exports; })();\n` +
    `bundled.cgroup = (() => { const module = {exports:{}}; ${cgroup}\n return module.exports; })();\n` +
    `bundled.supervisor = (() => { const module = {exports:{}}; ${supervisor}\n return module.exports; })();\n` +
    `bundled.broker = (() => { const module = {exports:{}}; ${broker}\n return module.exports; })();\n` +
    shared.replace(/require\(['"]\.\/external-agent-bridge['"]\)/, 'bundled.bridge')
      .replace(/require\(['"]\.\.\/public\/js\/shared-crypto['"]\)/, 'bundled.crypto')
      .replace(/require\(['"]\.\.\/src\/shared\/restrictedExecutor['"]\)/, 'bundled.executor')
      .replace(/require\(['"]\.\.\/src\/shared\/boundActionBroker['"]\)/, 'bundled.broker')
      .replace(/require\(['"]\.\.\/src\/shared\/executorSupervisor['"]\)/, 'bundled.supervisor');
}
module.exports = { generateSharedRunnerBundle };
