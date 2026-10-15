#!/usr/bin/env node
'use strict';

// Dedicated-VM harness only. Forward argv, stdin and environment unchanged to
// real local Podman. The metadata and guest marker must match before forwarding.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { publishJSON, readJSON } = require('./protocol');
const root = __dirname;
const metadata = readJSON(path.join(root, 'verification-round.json'));
if (!metadata.roundId || fs.readFileSync('/etc/agent-sharing-verification-guest', 'utf8').trim() !== metadata.roundId) {
  throw Error('Dedicated verification guest marker mismatch');
}
const dir = path.join(root, 'evidence');
const log = path.join(dir, 'engine-phases.jsonl');
const argv = process.argv.slice(2);
const at = Date.now(), call = process.pid + '-' + at;
const args = argv[0] === '--remote=false' ? argv.slice(1) : argv;
const phase = args[0];
let out = Buffer.alloc(0), err = Buffer.alloc(0), outBytes = 0, errBytes = 0;
function record(data) {
  fs.appendFileSync(log, JSON.stringify({ call, at: new Date().toISOString(), ...data }) + '\n', { mode: 0o600 });
}
let control;
try { control = readJSON(path.join(root, 'phase-control.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = process.env.CONTAINERS_CONF;
let configIdentity, configRootIdentity;
try {
  const stat = fs.lstatSync(config, { bigint: true });
  configIdentity = { dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode & 0o777n) };
  const parent = fs.lstatSync(path.dirname(config), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== BigInt(process.getuid()) || (parent.mode & 0o777n) !== 0o700n) {
    throw Error('Engine configuration directory is not privately owned');
  }
  configRootIdentity = { dev: String(parent.dev), ino: String(parent.ino) };
} catch (error) { if (error.code !== 'ENOENT' && config !== undefined) throw error; }
record({ event: 'invoke', argv, envKeys: Object.keys(process.env).sort(), config, configIdentity, configRootIdentity, phase });

async function barrier(where) {
  const selected = control?.plans ? control.plans.find(plan => plan.phase === phase && plan.where === where) : control;
  if (!selected || selected.phase !== phase || selected.where !== where || (selected.subcommand && args[1] !== selected.subcommand)) return;
  for (const file of [selected.claim, selected.ready, selected.release]) {
    if (path.dirname(file) !== root) throw Error('Barrier pathname is outside the verification round');
  }
  try { fs.closeSync(fs.openSync(selected.claim, 'wx', 0o600)); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  record({ event: 'barrier', where });
  publishJSON(selected.ready, { call, phase, where, argv, config, configIdentity, configRootIdentity, stdout: out.toString('utf8').slice(0, 1024), pid: process.pid });
  const until = Date.now() + 7000;
  while (!fs.existsSync(selected.release) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  record({ event: 'released', where, released: fs.existsSync(selected.release) });
}

(async () => {
  await barrier('before');
  const child = spawn('/usr/bin/podman', argv, { env: process.env, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); });
  child.stdout.on('data', bytes => {
    outBytes += bytes.length;
    const cap = phase === 'unshare' ? 512 * 1024 : phase === 'container' ? 256 * 1024 : 4096;
    if (out.length < cap) out = Buffer.concat([out, bytes.subarray(0, cap - out.length)]);
    process.stdout.write(bytes);
  });
  child.stderr.on('data', bytes => {
    errBytes += bytes.length;
    if (err.length < 4096) err = Buffer.concat([err, bytes.subarray(0, 4096 - err.length)]);
    process.stderr.write(bytes);
  });
  child.on('error', error => { record({ event: 'spawn-error', code: error.code }); });
  const { code, signal } = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  if ((phase === 'unshare' || (phase === 'container' && args[1] === 'inspect')) && code === 0) {
    const file = path.join(dir, (phase === 'unshare' ? 'boundary-' : 'inspect-') + call + '.json');
    fs.writeFileSync(file, out, { mode: 0o600, flag: 'wx' });
    record({ event: 'control-output-saved', file, bytes: out.length });
  }
  record({ event: 'exit', phase, code, signal, elapsedMs: Date.now() - at,
    stdout: phase === 'unshare' ? '[bounded control output saved separately]' : out.toString('utf8').slice(0, 8192),
    stderr: err.toString('utf8'), stdoutBytes: outBytes, stderrBytes: errBytes });
  await barrier('after');
  process.exitCode = code === null ? 128 : code;
})().catch(error => { record({ event: 'wrapper-error', message: error.message, stack: error.stack }); process.exitCode = 126; });
