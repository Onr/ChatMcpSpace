#!/usr/bin/env node
'use strict';

// Component harness only: put the real public runner in a separate OS process.
// IPC serves the same explicit API fixture; it is not live server authorization.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { joinDriver, readJSON, processIdentity } = require('./protocol');

function launch(config, handlers) {
  const child = fork(__filename, [], { execArgv: ['--max-old-space-size=128'],
    env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const identity = processIdentity(child.pid);
  let resolve, reject, received = false, stderr = '';
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  child.stderr.on('data', bytes => { if (stderr.length < 4096) stderr += bytes.toString().slice(0, 4096 - stderr.length); });
  const exited = new Promise(yes => child.once('exit', (code, signal) => {
    if (!received) reject(Error('Runner worker exited before result: ' + (stderr || code || signal)));
    yes({ code, signal });
  }));
  child.once('error', reject);
  child.on('message', async message => {
    try {
      if (message?.kind === 'result') {
        if (received || message.pid !== child.pid || typeof message.ok !== 'boolean') throw Error('Unexpected worker result');
        received = true; resolve(message); return;
      }
      if (message?.kind !== 'request' || !Number.isSafeInteger(message.id) || message.id < 1 ||
          !['api', 'fetch'].includes(message.method)) throw Error('Unexpected worker request');
      let value;
      try { value = await handlers[message.method](...message.args); }
      catch (error) { child.send({ kind: 'response', id: message.id, error: error.message }); return; }
      child.send({ kind: 'response', id: message.id, value });
    } catch (error) { reject(error); }
  });
  child.send({ kind: 'initialize', config });
  return { child, identity, completed, exited };
}

async function worker() {
  if (process.platform !== 'linux' || process.getuid() !== 1000 || !process.send) throw Error('Guest IPC worker required');
  joinDriver(__dirname);
  const config = await new Promise(resolve => process.once('message', message => {
    if (message?.kind !== 'initialize') throw Error('Unexpected worker initialization');
    resolve(message.config);
  }));
  const metadata = readJSON(path.join(__dirname, 'verification-round.json'));
  if (fs.readFileSync('/etc/agent-sharing-verification-guest', 'utf8').trim() !== metadata.roundId ||
      process.env.AGENT_SHARING_GUEST_READY !== metadata.roundId) throw Error('Worker guest marker mismatch');
  const { SharedRunner } = require('./shared-runner-bundle');
  const { Bridge } = require('./bridge-reference');
  const C = require('./shared-crypto-reference');
  let nextId = 0, finished = false;
  const pending = new Map();
  function request(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      process.send({ kind: 'request', id, method, args });
    });
  }
  process.on('message', message => {
    if (message?.kind === 'exit' && finished && !pending.size) { process.exit(0); }
    if (message?.kind !== 'response' || !pending.has(message.id)) throw Error('Unexpected fixture response');
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    if (message.error) reject(Error(message.error)); else resolve(message.value);
  });
  process.on('disconnect', () => { process.exit(finished ? 0 : 1); });
  const state = readJSON(config.stateFile);
  const bridge = new Bridge(state, { file: config.stateFile, attachmentDir: config.attachmentDir });
  const fetchImpl = async (url, options = {}) => {
    let upload;
    if (options.method === 'POST') upload = Buffer.from(await options.body.get('file').arrayBuffer()).toString('base64');
    const response = await request('fetch', [url, { method: options.method, redirect: options.redirect, upload }]);
    return new Response(Buffer.from(response.body, 'base64'), { status: response.status });
  };
  const runner = new SharedRunner(bridge, [config.profile], { fetchImpl, protocolVersion: 2,
    deviceId: config.device, supervisorRoot: config.supervisorRoot });
  if (runner.invokeOverride !== undefined) throw Error('Real runner invocation required');
  runner.privateKey = await C.privateKey(await C.aes(state.key), config.identityEnvelope, 'component');
  runner.api = (route, body) => request('api', [route, body]);
  let error;
  try { await runner.sharedTurn(); } catch (caught) { error = caught.message; }
  finished = true;
  process.send({ kind: 'result', pid: process.pid, ok: !error, error,
    pendingPhase: runner.state.shared.pending?.phase, pendingNull: runner.state.shared.pending === null,
    invocationOverrideAbsent: true });
}

if (require.main === module) worker().catch(error => { console.error(error.stack); process.exit(1); });
module.exports = { launch };
