#!/usr/bin/env node
'use strict';
// Native Windows runtime. No Bash, tmux, Python, provider SDK or shell interpolation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');
const { Bridge, endpoint, seal, loadState, saveState, acquireLock } = require('./external-agent-bridge');
const PACKAGES = {
  codex: '@openai/codex/bin/codex.js',
  claude: '@anthropic-ai/claude-code/cli.js',
  gemini: '@google/gemini-cli/dist/index.js'
};
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function powershell(script) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Windows credential ACL check failed. Run the installer again to repair permissions.');
  return result.stdout.trim();
}
function verifyPrivateDirectory(directory, requireProtected = true) {
  if (process.platform !== 'win32') throw new Error('This runtime requires native Windows.');
  powershell(`$ErrorActionPreference='Stop'; $p=${psQuote(directory)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $item=Get-Item -LiteralPath $p -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }; $acl=Get-Acl -LiteralPath $p; ${requireProtected ? "if (-not $acl.AreAccessRulesProtected) { throw 'Inherited ACL' };" : ''} foreach ($rule in $acl.Access) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')) { throw 'Public ACL' } }`);
}
function assertStorePath(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid private storage path.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Credential storage cannot contain junctions or symbolic links.'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}
function agentFile(root, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Provide an agent name.');
  return path.join(root, 'agents', crypto.createHash('sha256').update(name.trim()).digest('hex'), 'state.json');
}
function resolveProvider(provider, { env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  if (!PACKAGES[provider]) throw new Error('Supported native providers: codex, claude, gemini.');
  const paths = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  for (const directory of paths) {
    // Prefer a native executable; execute npm's JavaScript entrypoint with Node,
    // avoiding cmd.exe parsing and npm .cmd shim quoting entirely.
    const exe = path.join(directory, provider + (platform === 'win32' ? '.exe' : ''));
    if (exists(exe)) return { command: exe, prefix: [] };
    const js = path.join(directory, 'node_modules', ...PACKAGES[provider].split('/'));
    if (exists(js)) return { command: process.execPath, prefix: [js] };
  }
  throw new Error(`Install and sign in to ${provider} in PowerShell first, then reopen PowerShell and retry. Its executable or npm entrypoint is missing from PATH.`);
}
function providerArgs(provider, config, local, resultFile) {
  if (!local.providers.includes(provider)) throw new Error(`Provider ${provider} was not approved during local setup.`);
  const edit = local.allowEdits === true;
  const sandbox = config.sandbox_mode || (edit ? 'workspace-write' : 'read-only');
  const approval = config.approval_mode || 'suggest';
  if (!['read-only', 'workspace-write', 'none', 'danger-full-access'].includes(sandbox) ||
      !['suggest', 'default', 'auto-edit', 'acceptEdits', 'plan', 'full-auto', 'bypassPermissions'].includes(approval)) {
    throw new Error('Unsupported native execution mode. Choose a supported mode in agent settings.');
  }
  if (['none', 'danger-full-access'].includes(sandbox) || ['full-auto', 'bypassPermissions'].includes(approval)) {
    throw new Error('Unrestricted execution is not enabled by this Windows installation. Change agent settings to the approved workspace/default mode.');
  }
  if (!edit && (sandbox === 'workspace-write' || ['auto-edit', 'acceptEdits'].includes(approval))) {
    throw new Error('Workspace edits were not approved locally. Reconfigure the local agent before enabling edits.');
  }
  let args;
  if (provider === 'codex') args = ['--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', sandbox, '--output-last-message', resultFile, '-'];
  if (provider === 'claude') args = ['--print', '--output-format', 'text', '--permission-mode', edit && ['auto-edit', 'acceptEdits'].includes(approval) ? 'acceptEdits' : approval === 'plan' ? 'plan' : 'default'];
  if (provider === 'gemini') args = ['--prompt', 'Process the request supplied on stdin.', '--output-format', 'text', '--approval-mode', edit && ['auto-edit', 'acceptEdits'].includes(approval) ? 'auto_edit' : approval === 'plan' ? 'plan' : 'default'];
  if (config.model && config.model !== 'default') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,119}$/.test(config.model)) throw new Error('Invalid model name.');
    args.push('--model', config.model);
  }
  return args;
}
function safeProviderEnv(env = process.env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (/^(CHATSPACE_|JETSPACE_|USER_PASSWORD$|ENCRYPTION_|API_BASE$|API_KEY$)/i.test(name)) delete clean[name];
  }
  return clean;
}
async function terminateTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => code === 0 || child.exitCode !== null ? resolve() : reject(new Error('Could not confirm provider process-tree shutdown. Inspect Task Manager before restarting.')));
    });
  } else child.kill('SIGKILL'); // portable fixture tests; production requires Windows
}
async function invokeProvider(state, messages, signal, { spawnImpl = spawn, resolve = resolveProvider, terminate = terminateTree } = {}) {
  const local = state.native;
  const provider = local.current.model_provider;
  const executable = resolve(provider);
  const resultFile = path.join(local.directory, `result-${crypto.randomUUID()}.txt`);
  const args = [...executable.prefix, ...providerArgs(provider, local.current, local, resultFile)];
  const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')}`).join('\n\n') +
    '\n\nNative Windows agent: complete the task with your installed tools and current permissions. Return your final answer as text; the runner delivers it to the correct conversation. Do not read Jetspace credential storage. Chief of Staff spawning, shared rooms and automatic runner updates are unavailable in this native runtime.';
  try {
    return await new Promise((resolveRun, rejectRun) => {
      if (signal?.aborted) return rejectRun(new Error('Provider invocation cancelled.'));
      const child = spawnImpl(executable.command, args, { cwd: local.project, env: safeProviderEnv(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errors = '', size = 0, failure = null, stopping = null;
      const stop = () => {
        failure ||= new Error('Provider invocation interrupted; inspect its work before retrying.');
        stopping ||= terminate(child).catch(error => { failure = error; });
      };
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', bytes => { size += bytes.length; if (size > 2 * 1024 * 1024) { failure = new Error('Provider output exceeds 2 MB.'); stop(); } else output += bytes.toString('utf8'); });
      child.stderr.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-8000); });
      child.stdin.on('error', () => {});
      child.once('error', error => { signal?.removeEventListener('abort', stop); rejectRun(error); });
      child.once('close', async code => {
        signal?.removeEventListener('abort', stop);
        if (stopping) await stopping;
        if (failure) return rejectRun(failure);
        if (code !== 0) return rejectRun(new Error(`Provider exited ${code}: ${errors.slice(-2000)}`));
        if (provider === 'codex') {
          try { if (fs.statSync(resultFile).size > 60000) throw new Error('Reply exceeds 60 KB.'); output = fs.readFileSync(resultFile, 'utf8'); }
          catch (error) { return rejectRun(new Error(`Codex did not save a usable final reply: ${error.message}`)); }
        }
        if (!output.trim()) return rejectRun(new Error('Provider returned no final text.'));
        resolveRun(output.trim());
      });
      child.stdin.end(prompt, 'utf8');
    });
  } finally { try { fs.unlinkSync(resultFile); } catch (_) {} }
}
function makeBridge(state, file, { fetchImpl = global.fetch, invoke = invokeProvider } = {}) {
  const bridge = new Bridge(state, { file, runtimeUrl: 'http://127.0.0.1:8642/v1', runtimeKey: 'native-local', timeoutMs: 3600000, sharedFiles: true });
  const prepareInput = bridge.prepareRuntimeInput.bind(bridge);
  bridge.prepareRuntimeInput = async (...args) => {
    const prepared = await prepareInput(...args);
    // Provider CLIs receive text on stdin, not Chat Completions image parts.
    // The downloaded image path remains in the manifest for their file/image tools.
    if (Array.isArray(prepared.runtimeContent)) {
      prepared.runtimeContent = prepared.runtimeContent.filter(part => part.type === 'text').map(part => part.text).join('\n') +
        '\nImage attachments were saved at the manifest paths. Use your image/file tool to inspect them. If your CLI cannot view images, say so explicitly; do not infer image contents from their filenames.';
    }
    return prepared;
  };
  bridge.fetch = async (url, options) => {
    if (url === 'http://127.0.0.1:8642/v1/chat/completions') {
      const request = JSON.parse(options.body);
      const original = state.native?.current;
      if (state.native && state.pending?.message?.runOverrides) {
        const overrides = state.pending.message.runOverrides;
        state.native.current = { ...original };
        for (const key of ['model_provider', 'model', 'approval_mode', 'sandbox_mode']) {
          if (overrides[key] !== undefined) state.native.current[key] = overrides[key];
        }
        if (state.native.current.model_provider === 'default') state.native.current.model_provider = 'codex';
      }
      try {
        const content = await invoke(state, request.messages, options.signal);
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
      } catch (error) {
        console.error(`Native provider failed: ${error.message}`);
        throw error;
      } finally { if (state.native) state.native.current = original; }
    }
    return fetchImpl(url, options);
  };
  return bridge;
}
async function accountApi(baseUrl, apiKey, route, body, fetchImpl = global.fetch) {
  const response = await fetchImpl(`${baseUrl}/api/agent${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-Agent-Name': body.agentName }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Setup request failed (HTTP ${response.status}). Check the API key and account verification.`);
  return response.json();
}
async function initialize(root, input, { fetchImpl = global.fetch, resolve = resolveProvider } = {}) {
  const name = String(input.agentName || '').trim();
  const file = agentFile(root, name);
  assertStorePath(root, file);
  if (fs.existsSync(file)) throw new Error('This agent is already installed. Use start or choose a new name.');
  if (!input.apiKey || !input.password) throw new Error('API key and account password are required.');
  const baseUrl = endpoint(input.baseUrl);
  const project = fs.realpathSync(input.project);
  if (!fs.statSync(project).isDirectory()) throw new Error('Project path must be a directory.');
  const provider = input.provider || 'codex';
  resolve(provider);
  const providers = Object.keys(PACKAGES).filter(item => { try { resolve(item); return true; } catch (_) { return false; } });
  const registered = await accountApi(baseUrl, input.apiKey, '/register', { agentName: name }, fetchImpl);
  // Enrollment rotates credentials. Never take over an existing agent silently.
  if (!registered.created) throw new Error('That agent name already exists on the server. Choose a new name to avoid replacing its running installation.');
  const contract = registered.encryptionParams;
  if (contract && (contract.iterations !== 100000 || contract.keyLength !== 256)) throw new Error('Unsupported account encryption parameters. Update the installer.');
  if (Buffer.from(registered.encryptionSalt || '', 'base64').length !== 32) throw new Error('Invalid account encryption salt.');
  const key = crypto.pbkdf2Sync(input.password, Buffer.from(registered.encryptionSalt, 'base64'), 100000, 32, 'sha256').toString('base64');
  const allowEdits = input.allowEdits === true;
  const config = { model_provider: provider, model: input.model || 'default', approval_mode: allowEdits ? 'auto-edit' : 'suggest', sandbox_mode: allowEdits ? 'workspace-write' : 'read-only', project_path: project };
  const allowedPermissions = { inter_agent: { enabled: true, mode: 'listen_all' }, project_path: project };
  for (const item of providers) {
    if (item === 'codex') allowedPermissions.codex = { '--sandbox': allowEdits ? ['read-only', 'workspace-write'] : ['read-only'] };
    if (item === 'claude') allowedPermissions.claude = { '--permission-mode': allowEdits ? ['default', 'acceptEdits'] : ['default'] };
    if (item === 'gemini') allowedPermissions.gemini = { '--yolo': false };
  }
  await accountApi(baseUrl, input.apiKey, '/runtime-permissions', { agentName: name, allowedPermissions, config }, fetchImpl);
  const identity = await accountApi(baseUrl, input.apiKey, '/runtime-enroll', { agentName: name }, fetchImpl);
  if (!identity.token || identity.agentId !== registered.agentId) throw new Error('Server returned an invalid agent credential.');
  const directory = path.dirname(file);
  saveState(file, { version: 1, baseUrl, agentName: name, agentId: identity.agentId, token: identity.token, key, history: {}, pending: null,
    native: { project, providers, allowEdits, current: config, directory } });
  return { file, agentName: name, providers };
}
function running(file) {
  try {
    const info = JSON.parse(fs.readFileSync(`${file}.runtime`, 'utf8'));
    if (!Number.isInteger(info.pid) || info.pid < 1 || typeof info.instance !== 'string') return null;
    process.kill(info.pid, 0);
    return info;
  } catch (_) { return null; }
}
async function run(file) {
  const state = loadState(file);
  const unlock = acquireLock(file);
  const instance = crypto.randomUUID();
  const runtimeFile = `${file}.runtime`;
  const stopFile = `${file}.stop`;
  const bridge = makeBridge(state, file);
  fs.writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, instance, status: 'starting' }), { mode: 0o600 });
  let ready = false;
  let stopping = false, lastHeartbeat = Date.now(), timerBusy = false;
  const stop = () => { stopping = true; bridge.controller?.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setInterval(async () => {
    if (timerBusy) return;
    timerBusy = true;
    try {
      try { if (fs.readFileSync(stopFile, 'utf8') === instance) stop(); } catch (_) {}
      if (!stopping && bridge.busy && Date.now() - lastHeartbeat > 30000) { lastHeartbeat = Date.now(); await bridge.heartbeat(); }
    } catch (error) { if (bridge.stopped) stop(); else console.error(error.message); }
    finally { timerBusy = false; }
  }, 500);
  try {
    console.log(`Native Windows agent ${state.agentName} started in ${state.native.project}.`);
    while (!stopping) {
      try {
        const remote = await bridge.api(`/config?agentName=${encodeURIComponent(state.agentName)}`);
        state.native.current = { ...state.native.current, ...remote.config };
        if (state.native.current.model_provider === 'default') state.native.current.model_provider = 'codex';
        // Validate each turn against the local ceiling, even if server settings changed.
        providerArgs(state.native.current.model_provider, state.native.current, state.native, 'unused');
        if (!ready) {
          await bridge.heartbeat();
          fs.writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, instance, status: 'running' }), { mode: 0o600 });
          ready = true;
        }
        await bridge.tick();
      } catch (error) {
        console.error(error.message);
        if (bridge.stopped) { stopping = true; break; }
        if (!error.retryable) throw error;
      }
      const deadline = Date.now() + bridge.nextPollMs;
      while (!stopping && Date.now() < deadline) await sleep(250);
    }
  } finally {
    clearInterval(timer);
    bridge.controller?.abort();
    // completePending awaits provider tree termination before returning here.
    if (bridge.stopped) await bridge.api('/stop/acknowledge', { agentName: state.agentName }).catch(error => console.error(error.message));
    await bridge.api('/heartbeat', { agentName: state.agentName, isWorking: false }).catch(() => {});
    for (const item of [runtimeFile, stopFile]) { try { fs.unlinkSync(item); } catch (_) {} }
    unlock();
  }
}
async function start(file) {
  if (running(file)) { console.log('Agent is already running.'); return; }
  const state = loadState(file);
  if (['running', 'uncertain'].includes(state.pending?.phase)) throw new Error('The previous task may have made changes. Inspect the project, then use retry or skip before starting.');
  if (fs.existsSync(`${file}.lock`)) {
    const pid = Number(fs.readFileSync(`${file}.lock`, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid runner lock. Inspect the installation before removing it.');
    try { process.kill(pid, 0); throw new Error('A runner lock is still active. Inspect the process before restarting.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(`${file}.lock`);
  }
  const log = fs.openSync(`${file}.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [__filename, 'run', file], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: safeProviderEnv() });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(log); }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const info = running(file);
    if (info?.status === 'running') { console.log('Agent connected and started. Use status or logs to inspect it.'); return; }
    if (i > 4 && !info) throw new Error('Runner exited during startup. Use logs to inspect its error.');
  }
  throw new Error('Runner is still connecting. Check status and logs; use stop to cancel startup.');
}
async function stop(file) {
  const info = running(file);
  if (!info) { console.log('Agent is already stopped.'); return; }
  fs.writeFileSync(`${file}.stop`, info.instance, { mode: 0o600 });
  for (let i = 0; i < 90; i++) { await sleep(500); if (!running(file)) { console.log('Agent stopped.'); return; } }
  throw new Error('Shutdown is still pending. Inspect logs and Task Manager; no unrelated PID was terminated.');
}
async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const root = path.join(process.env.LOCALAPPDATA || '', 'Jetspace');
  verifyPrivateDirectory(root);
  const [command, name] = args;
  if (command === 'init') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(await initialize(root, input))); return;
  }
  if (command === 'list') {
    const folder = path.join(root, 'agents');
    assertStorePath(root, folder);
    for (const entry of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
      const file = path.join(folder, entry, 'state.json');
      assertStorePath(root, file);
      if (fs.existsSync(file)) { verifyPrivateDirectory(file, false); const state = loadState(file); console.log(`${state.agentName}\t${running(file) ? 'running' : 'stopped'}\t${state.native.project}`); }
    }
    return;
  }
  const file = command === 'run' ? path.resolve(name) : agentFile(root, name);
  if (!file.startsWith(path.join(root, 'agents') + path.sep)) throw new Error('Agent state must be inside the private installation directory.');
  assertStorePath(root, file);
  verifyPrivateDirectory(file, false);
  if (command === 'run') return run(file);
  if (command === 'start') return start(file);
  if (command === 'stop') return stop(file);
  if (command === 'restart') { await stop(file); return start(file); }
  if (command === 'status') { const state = loadState(file); console.log(`${state.agentName}: ${running(file)?.status || 'stopped'}; pending task: ${state.pending?.phase || 'none'}`); return; }
  if (command === 'logs') { console.log(fs.existsSync(`${file}.log`) ? fs.readFileSync(`${file}.log`, 'utf8').slice(-20000) : 'No logs yet.'); return; }
  if (command === 'send') {
    const state = loadState(file), content = fs.readFileSync(0, 'utf8').trim();
    if (!content || Buffer.byteLength(content) > 60000) throw new Error('Send needs 1–60000 bytes of text.');
    await makeBridge(state, null).api('/messages', { agentName: state.agentName, encrypted: true, priority: 0, clientMessageId: crypto.randomUUID(), content: seal(content, state.key) });
    console.log('Encrypted message sent.'); return;
  }
  if (['retry', 'skip'].includes(command)) {
    if (running(file)) throw new Error('Stop the agent before changing pending work.');
    const state = loadState(file);
    if (!state.pending) { console.log('No pending task.'); return; }
    if (command === 'retry') {
      if (!['running', 'uncertain', 'queued'].includes(state.pending.phase)) throw new Error('This task already has a saved result. Use start to deliver it without rerunning tools.');
      state.pending.phase = 'queued'; delete state.pending.failureReason;
    }
    else { await makeBridge(state, null).acknowledge(state.pending); state.pending = null; }
    saveState(file, state); console.log('Pending task updated. Use start to continue.'); return;
  }
  throw new Error('Unknown command. Use jetspace help.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { psQuote, agentFile, assertStorePath, resolveProvider, providerArgs, safeProviderEnv, invokeProvider, makeBridge, initialize, terminateTree };
