#!/usr/bin/env node
'use strict';
// Native Windows runtime. No Bash, tmux, Python, provider SDK or shell interpolation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');
const { Bridge, endpoint, seal, open, loadState, saveState, acquireLock } = require('./external-agent-bridge');
const PACKAGES = {
  codex: '@openai/codex/bin/codex.js',
  claude: '@anthropic-ai/claude-code/cli.js',
  gemini: '@google/gemini-cli/dist/index.js'
};
const NPM_PACKAGES = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli' };
function networkFlags({ supported = process.allowedNodeEnvironmentFlags, active = process.execArgv, env = process.env } = {}) {
  const flags = ['--use-system-ca'];
  if (Object.entries(env).some(([name, value]) => /^https?_proxy$/i.test(name) && value)) flags.push('--use-env-proxy');
  return flags.filter(flag => supported.has(flag) && !active.includes(flag));
}
function connectionError(baseUrl, error) {
  const known = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
  const candidates = [error?.code, error?.cause?.code, ...(error?.cause?.errors || []).map(item => item.code)];
  const code = candidates.find(item => known.has(item)) || (error?.name === 'TimeoutError' ? 'ETIMEDOUT' : 'NETWORK_ERROR');
  const certificate = /CERT|SELF_SIGNED|UNABLE_TO/.test(code);
  const hint = certificate ? 'Check your Windows trusted certificates, corporate proxy and system clock. Update Node.js if it lacks system certificate support.'
    : /ENOTFOUND|EAI_AGAIN/.test(code) ? 'Check DNS, your VPN and internet connection.'
      : 'Check your connection, VPN and firewall. If your network needs a proxy, configure HTTPS_PROXY and NO_PROXY for Node.js.';
  return Object.assign(new Error(`Cannot connect to ${new URL(baseUrl).host} (${code}). ${hint} Run jetspace doctor for a connection check.`), { code, retryable: !certificate });
}
async function networkRequest(url, options, fetchImpl = global.fetch) {
  try { return await fetchImpl(url, options); }
  catch (error) { throw connectionError(url, error); }
}
async function readServerJson(response, baseUrl) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('The server returned an unexpected response. Check the server address and any network sign-in page.');
    throw connectionError(baseUrl, error);
  }
}
async function checkConnection(baseUrl, { fetchImpl = global.fetch, wait = sleep } = {}) {
  const base = endpoint(baseUrl);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await networkRequest(`${base}/setup/windows/manifest.json`, { signal: AbortSignal.timeout(10000), redirect: 'error' }, fetchImpl);
      if (!response.ok) throw Object.assign(new Error(`Cannot connect to ${new URL(base).host} (HTTP ${response.status}). Check your network or try again later.`), { retryable: response.status === 429 || response.status >= 500 });
      const manifest = await readServerJson(response, base);
      if (!/^[a-f0-9]{64}$/.test(manifest?.files?.['windows-agent-runner.js'] || '')) throw new Error('The server returned an unexpected response. Check the server address and any network sign-in page.');
      return;
    } catch (error) {
      if (!error.retryable || attempt === 2) throw error;
      await wait(500 * (attempt + 1));
    }
  }
}
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function powershell(script, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // PowerShell 7 only fixes module paths for direct powershell.exe children.
  // Through Node, 5.1 inherits incompatible PS7 modules and Get-Acl cannot load.
  // Let Windows PowerShell construct its own defaults, without changing ours.
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) {
    if (name.toUpperCase() === 'PSMODULEPATH') delete childEnv[name];
  }
  const result = spawnSyncImpl(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: childEnv });
  if (result.error || result.status !== 0) throw new Error('Windows credential ACL check failed. Run the installer again to repair permissions.');
  return result.stdout.trim();
}
function verifyPrivateDirectory(directory, requireProtected = true, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('This runtime requires native Windows.');
  powershell(`$ErrorActionPreference='Stop'; $p=${psQuote(directory)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $item=Get-Item -LiteralPath $p -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }; $acl=Get-Acl -LiteralPath $p; ${requireProtected ? "if (-not $acl.AreAccessRulesProtected) { throw 'Inherited ACL' };" : ''} foreach ($rule in $acl.Access) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,'S-1-5-18')) { throw 'Public ACL' } }`, options);
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
  const pathsForPlatform = platform === 'win32' ? path.win32 : path;
  const paths = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  // npm's global folder is not on PATH when Node.js came from setup's portable build.
  if (env.APPDATA) paths.push(pathsForPlatform.join(env.APPDATA, 'npm'));
  for (const entry of paths) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    // Prefer a native executable; execute npm's JavaScript entrypoint with Node,
    // avoiding cmd.exe parsing and npm .cmd shim quoting entirely.
    const exe = pathsForPlatform.join(directory, provider + (platform === 'win32' ? '.exe' : ''));
    if (exists(exe)) return { command: exe, prefix: [] };
    const js = pathsForPlatform.join(directory, 'node_modules', ...PACKAGES[provider].split('/'));
    if (exists(js)) return { command: process.execPath, prefix: [js] };
  }
  throw new Error(`Install and sign in to ${provider} in PowerShell first, then reopen PowerShell and retry. Its executable or npm entrypoint is missing from PATH.`);
}
function availableProviders(resolve = resolveProvider) {
  return Object.keys(PACKAGES).filter(provider => { try { resolve(provider); return true; } catch (_) { return false; } });
}
// The dashboard's "default" provider means this agent's local default, which
// may be Claude or Gemini on computers without Codex.
function concreteProvider(provider, local) {
  if (provider && provider !== 'default') return provider;
  return local?.defaultProvider || local?.providers?.[0] || 'codex';
}
function diagnose(root, { resolve = resolveProvider, verify = verifyPrivateDirectory } = {}) {
  const checks = [];
  const check = (label, action) => {
    try { action(); checks.push({ label, ok: true }); }
    catch (_) { checks.push({ label, ok: false }); }
  };
  check('Private installation permissions', () => verify(root));
  for (const name of ['windows-cli.ps1', 'windows-agent-runner.js', 'external-agent-bridge.js', 'installation.json']) {
    check(`Installed ${name}`, () => {
      const file = path.join(root, name);
      assertStorePath(root, file);
      if (!fs.statSync(file).isFile()) throw new Error('Missing file');
    });
  }
  check('Server configuration', () => {
    const file = path.join(root, 'installation.json');
    assertStorePath(root, file);
    endpoint(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).baseUrl);
  });
  const found = availableProviders(resolve);
  const providers = Object.keys(PACKAGES).map(provider => ({ provider, available: found.includes(provider) }));
  return { checks, providers, ok: checks.every(check => check.ok) && providers.some(provider => provider.available) };
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
  const acknowledge = bridge.acknowledge.bind(bridge);
  bridge.acknowledge = async pending => {
    await acknowledge(pending);
    // The normal bridge persists immediately after acknowledgment. Mark setup
    // verified only after a real user task ran and its reply was delivered.
    if (state.native && pending.kind === 'user' && pending.phase === 'delivered' && pending.input && pending.result && !pending.message.updateAction) {
      state.native.setupVerifiedAt ||= new Date().toISOString();
    }
  };
  const decode = bridge.decode.bind(bridge);
  bridge.decode = message => {
    try { return decode(message); }
    catch (_) {
      throw Object.assign(new Error('Cannot decrypt the incoming message. Use jetspace repair-encryption with this agent name and the password from Settings > Decryption Password. The message is still unread; no AI task was started.'), { code: 'MESSAGE_DECRYPTION_FAILED' });
    }
  };
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
        state.native.current.model_provider = concreteProvider(state.native.current.model_provider, state.native);
      }
      try {
        const content = await invoke(state, request.messages, options.signal);
        return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
      } catch (error) {
        console.error(`Native provider failed: ${error.message}`);
        throw error;
      } finally { if (state.native) state.native.current = original; }
    }
    try { return await networkRequest(url, options, fetchImpl); }
    catch (error) {
      // Bridge retains pending work on transport failures. Preserve the safe
      // network diagnosis in the local log before its generic retry message.
      console.error(error.message);
      throw error;
    }
  };
  return bridge;
}
async function accountApi(baseUrl, apiKey, route, body, fetchImpl = global.fetch) {
  // Never replay registration/enrollment after an uncertain response: enrollment
  // rotates credentials. Retry only the unauthenticated connection probe.
  const response = await networkRequest(`${baseUrl}/api/agent${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-Agent-Name': body.agentName }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' }, fetchImpl);
  if (!response.ok) throw new Error(`Setup request failed (HTTP ${response.status}). Check the API key and account verification.`);
  return readServerJson(response, baseUrl);
}
function messageKey(secret, salt) {
  const saltBytes = Buffer.from(salt || '', 'base64');
  if (saltBytes.length !== 32) throw new Error('Invalid account encryption salt.');
  if (secret.trim().startsWith('JETSPACE1.')) {
    try {
      const encoded = secret.trim().slice('JETSPACE1.'.length);
      if (encoded.length > 2048 || !/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error();
      const code = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const key = Buffer.from(code.key || '', 'base64');
      if (code.version !== 1 || !Buffer.from(code.salt || '', 'base64').equals(saltBytes) || key.length !== 32) throw new Error();
      return key.toString('base64');
    } catch (_) { throw new Error('This connection code is invalid or belongs to another account. Copy a fresh Agent Connection Code from Settings for this account.'); }
  }
  return crypto.pbkdf2Sync(secret, saltBytes, 100000, 32, 'sha256').toString('base64');
}
async function initialize(root, input, { fetchImpl = global.fetch, resolve = resolveProvider } = {}) {
  const name = String(input.agentName || '').trim();
  const file = agentFile(root, name);
  assertStorePath(root, file);
  if (fs.existsSync(file)) throw new Error('This agent is already installed. Use start or choose a new name.');
  if (!input.apiKey || typeof input.password !== 'string' || !input.password) throw new Error('API key and agent connection code or message encryption password are required.');
  const baseUrl = endpoint(input.baseUrl);
  const project = fs.realpathSync(input.project);
  if (!fs.statSync(project).isDirectory()) throw new Error('Project path must be a directory.');
  // Like Linux setup: every installed provider is allowed and the dashboard
  // chooses among them. An explicit provider only selects the default.
  const providers = availableProviders(resolve);
  if (!providers.length) throw new Error('No supported AI CLI was found. Install Codex, Claude Code or Gemini CLI, sign in, then run create again.');
  if (input.provider && !providers.includes(input.provider)) throw new Error(`${input.provider} is not installed. Found: ${providers.join(', ')}.`);
  const provider = input.provider || providers[0];
  // Validate codes and their account binding before creating any server agent.
  const metadataResponse = await networkRequest(`${baseUrl}/api/agent/encryption-info`, { method: 'GET', headers: { 'X-API-Key': input.apiKey }, signal: AbortSignal.timeout(30000), redirect: 'error' }, fetchImpl);
  if (!metadataResponse.ok) throw new Error(`Account check failed (HTTP ${metadataResponse.status}). Check the API key and update Windows setup.`);
  const metadata = await readServerJson(metadataResponse, baseUrl);
  const key = messageKey(input.password, metadata.encryptionSalt);
  const registered = await accountApi(baseUrl, input.apiKey, '/register', { agentName: name }, fetchImpl);
  // Enrollment rotates credentials. Never take over an existing agent silently.
  if (!registered.created) throw new Error('That agent name already exists on the server. Choose a new name to avoid replacing its running installation.');
  const contract = registered.encryptionParams;
  if (contract && (contract.iterations !== 100000 || contract.keyLength !== 256)) throw new Error('Unsupported account encryption parameters. Update the installer.');
  if (Buffer.from(registered.encryptionSalt || '', 'base64').length !== 32) throw new Error('Invalid account encryption salt.');
  if (registered.encryptionSalt !== metadata.encryptionSalt) throw new Error('Account encryption settings changed during setup. Please check your account before continuing.');
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
    native: { project, providers, defaultProvider: provider, allowEdits, current: config, directory, encryptionSalt: registered.encryptionSalt } });
  return { file, agentName: name, providers, provider };
}
async function repairEncryption(file, input, { fetchImpl = global.fetch } = {}) {
  if (running(file)) throw new Error('Stop the agent before repairing message encryption.');
  if (typeof input.password !== 'string' || !input.password) throw new Error('Enter the message encryption password from Settings > Decryption Password.');
  const unlock = acquireLock(file);
  try {
    const state = loadState(file);
    if (state.pending && (state.pending.phase !== 'queued' || state.pending.kind !== 'user')) {
      throw new Error('Resolve the pending task before changing encryption. Inspect its status and logs; no state was changed.');
    }
    const bridge = makeBridge(state, null, { fetchImpl });
    let salt = state.native.encryptionSalt;
    if (!salt) {
      // Older installations did not save the salt. Retrieve it with the
      // existing scoped identity; never register again or rotate credentials.
      const config = await bridge.api(`/config?agentName=${encodeURIComponent(state.agentName)}`);
      if (config.agentId !== state.agentId) throw new Error('Agent identity mismatch; no state was changed.');
      salt = config.encryptionSalt;
    }
    if (Buffer.from(salt || '', 'base64').length !== 32) throw new Error('Account encryption salt is unavailable. Update the server before repairing this installation.');
    const message = state.pending?.message || (await bridge.api(`/responses?markRead=false&agentName=${encodeURIComponent(state.agentName)}`)).responses?.[0];
    if (!message?.encrypted || !message.content || (message.responseType && message.responseType !== 'text')) {
      throw new Error('Send a new text message from the website first so the password can be verified. No state was changed.');
    }
    const key = messageKey(input.password, salt);
    try { open(message.content, key); }
    catch (_) { throw new Error('This password cannot decrypt the waiting message. Use the password configured in that browser under Settings > Decryption Password. No state was changed.'); }
    // Finish every conversion before the single atomic save. A wrong password
    // or unreadable history leaves the original key, pending work and token intact.
    const history = Object.fromEntries(Object.entries(state.history || {}).map(([channel, value]) => [channel, seal(open(value, state.key), key)]));
    if (state.pending?.input) state.pending.input = seal(open(state.pending.input, state.key), key);
    state.history = history;
    state.key = key;
    state.native.encryptionSalt = salt;
    delete state.native.lastError;
    saveState(file, state);
  } finally { unlock(); }
}
function running(file) {
  try {
    const info = JSON.parse(fs.readFileSync(`${file}.runtime`, 'utf8'));
    if (!Number.isInteger(info.pid) || info.pid < 1 || typeof info.instance !== 'string') return null;
    process.kill(info.pid, 0);
    return info;
  } catch (_) { return null; }
}
function setupCheck(state, live) {
  if (state.pending?.phase === 'queued') {
    try { makeBridge(state, null).decode(state.pending.message); }
    catch (error) { if (error.code === 'MESSAGE_DECRYPTION_FAILED') return { status: 'password-mismatch' }; throw error; }
  }
  if (state.pending?.phase === 'uncertain' || (!live && state.pending?.phase === 'running')) return { status: 'task-failed' };
  if (!live) return { status: state.native.lastError ? 'failed' : 'stopped' };
  if (state.native.setupVerifiedAt) return { status: 'verified' };
  return { status: 'waiting', phase: state.pending?.phase || 'none' };
}
async function waitForSetup(file, { timeoutMs = 300000, read = () => loadState(file), live = () => Boolean(running(file)), wait = sleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const result = setupCheck(read(), live());
    if (result.status !== 'waiting' || now() >= deadline) return result;
    await wait(Math.min(500, Math.max(1, deadline - now())));
  }
}
async function run(file, dependencies = {}) {
  const state = loadState(file);
  const unlock = acquireLock(file);
  const instance = crypto.randomUUID();
  const runtimeFile = `${file}.runtime`;
  const stopFile = `${file}.stop`;
  const bridge = makeBridge(state, file, dependencies);
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
    if (state.native.lastError) { delete state.native.lastError; saveState(file, state); }
    console.log(`Native Windows agent ${state.agentName} started in ${state.native.project}.`);
    while (!stopping) {
      try {
        const remote = await bridge.api(`/config?agentName=${encodeURIComponent(state.agentName)}`);
        state.native.current = { ...state.native.current, ...remote.config };
        state.native.current.model_provider = concreteProvider(state.native.current.model_provider, state.native);
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
        if (!error.retryable) {
          // Surface background failures in status without persisting provider
          // output or secret-bearing exception details in the status field.
          state.native.lastError = error.code === 'MESSAGE_DECRYPTION_FAILED'
            ? error.message : 'The agent stopped after an error. Run jetspace logs with this agent name for details.';
          try { saveState(file, state); } catch (_) { /* The original error is in the log. */ }
          throw error;
        }
      }
      const deadline = Date.now() + bridge.nextPollMs;
      while (!stopping && Date.now() < deadline) await sleep(250);
    }
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    bridge.controller?.abort();
    // completePending awaits provider tree termination before returning here.
    if (bridge.stopped && !bridge.terminatedReason) await bridge.api('/stop/acknowledge', { agentName: state.agentName }).catch(error => console.error(error.message));
    if (!bridge.terminatedReason) await bridge.api('/heartbeat', { agentName: state.agentName, isWorking: false }).catch(() => {});
    for (const item of [runtimeFile, stopFile]) { try { fs.unlinkSync(item); } catch (_) {} }
    unlock();
  }
}
async function start(file) {
  if (running(file)) { console.log('Agent is already running.'); return; }
  const state = loadState(file);
  if (['running', 'uncertain'].includes(state.pending?.phase)) throw new Error('The previous task may have made changes. Inspect the project, then use retry or skip before starting.');
  if (state.pending?.phase === 'queued') makeBridge(state, null).decode(state.pending.message);
  if (fs.existsSync(`${file}.lock`)) {
    const pid = Number(fs.readFileSync(`${file}.lock`, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid runner lock. Inspect the installation before removing it.');
    try { process.kill(pid, 0); throw new Error('A runner lock is still active. Inspect the process before restarting.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(`${file}.lock`);
  }
  const log = fs.openSync(`${file}.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...process.execArgv, __filename, 'run', file], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: safeProviderEnv() });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(log); }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const info = running(file);
    if (info?.status === 'running') { console.log('Agent connected and listening. Use jetspace verify to check a website message and reply.'); return; }
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
  const [command, name] = args;
  const checkServer = async () => {
    const configFile = path.join(root, 'installation.json');
    assertStorePath(root, configFile);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    await checkConnection(config.baseUrl);
    console.log(`OK Connection to ${new URL(config.baseUrl).host}`);
  };
  if (command === 'doctor') {
    const report = diagnose(root);
    console.log(`Jetspace native Windows diagnostics; Node.js ${process.versions.node}`);
    for (const check of report.checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}`);
    for (const provider of report.providers) console.log(`${provider.available ? 'FOUND' : 'MISSING'} ${provider.provider}`);
    await checkServer();
    console.log('Provider discovery does not verify provider login. Open the provider CLI and sign in before creating an agent.');
    if (!report.ok) throw new Error('Repair missing runtime files by rerunning setup; install a missing provider and reopen PowerShell.');
    return;
  }
  verifyPrivateDirectory(root);
  if (command === 'check-connection') { await checkServer(); return; }
  if (command === 'check-provider') { resolveProvider(name); console.log(`${name} found. Make sure you have signed in to its CLI.`); return; }
  if (command === 'providers') { console.log(JSON.stringify({ found: availableProviders(), installable: NPM_PACKAGES })); return; }
  if (command === 'init') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    const result = await initialize(root, input);
    console.log(`Agent "${result.agentName}" is registered. Default AI: ${result.provider}. Available: ${result.providers.join(', ')}.`); return;
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
  if (command === 'wait-for-setup') { console.log(JSON.stringify(await waitForSetup(file))); return; }
  if (command === 'repair-encryption') {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    await repairEncryption(file, input);
    console.log('Message encryption verified and repaired. The queued message and agent identity were preserved.');
    return;
  }
  if (command === 'status') {
    const state = loadState(file), runtime = running(file);
    console.log(`${state.agentName}: ${runtime?.status || 'stopped'}; pending task: ${state.pending?.phase || 'none'}`);
    console.log(state.native.setupVerifiedAt ? 'Website message and reply verified.' : 'Website message and reply have not been verified. Use jetspace verify with this agent name.');
    if (!runtime && state.native.lastError) console.log(state.native.lastError);
    return;
  }
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
if (require.main === module) {
  const flags = process.platform === 'win32' ? networkFlags() : [];
  if (flags.length) {
    // These Node options take effect at process startup. Inherit stdin directly
    // so account credentials never enter process arguments or temporary files.
    const child = spawnSync(process.execPath, [...process.execArgv, ...flags, __filename, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    if (child.error) console.error('Could not start the Windows runtime. Rerun Windows setup.');
    process.exitCode = child.status ?? 1;
  } else main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { networkFlags, connectionError, checkConnection, psQuote, verifyPrivateDirectory, agentFile, assertStorePath, resolveProvider, availableProviders, concreteProvider, diagnose, providerArgs, safeProviderEnv, invokeProvider, makeBridge, initialize, messageKey, repairEncryption, setupCheck, waitForSetup, run, terminateTree };
