#!/usr/bin/env node
'use strict';
// Metadata discovery only: never send a prompt, run a tool, or start login.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function command(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, {
    timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function options(rows) {
  return (rows || []).map(row => ({
    value: row.slug || row.id || row.value || row.modelId,
    label: row.display_name || row.displayName || row.name || row.label || row.id || row.slug || row.modelId
  })).filter(row => typeof row.value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,199}$/.test(row.value));
}
function bundledGeminiModels(searchPath = process.env.PATH || '') {
  // Older Gemini ACP versions expose no roster, and session/new may start
  // configured MCP servers. Read public package constants instead of launching
  // a conversation or attempting OAuth. These IDs remain unconfirmed.
  const executable = searchPath.split(path.delimiter).map(dir => path.join(dir, 'gemini'))
    .find(file => fs.existsSync(file));
  if (!executable) return [];
  let directory = path.dirname(fs.realpathSync(executable));
  for (let depth = 0; depth < 6; depth++, directory = path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (pkg.name !== '@google/gemini-cli') continue;
    const core = require.resolve('@google/gemini-cli-core', { paths: [directory] });
    const modelFile = ['config/models.js', 'src/config/models.js'].map(file => path.join(path.dirname(core), file))
      .find(file => fs.existsSync(file));
    if (!modelFile) return [];
    const models = fs.readFileSync(modelFile, 'utf8');
    return [...new Set([...models.matchAll(/['"](gemini-[a-z0-9.-]+)['"]/g)].map(match => match[1]))]
      .filter(value => !value.endsWith('-') && !value.includes('embedding'))
      .map(value => ({ value, label: value }));
  }
  return [];
}
function metadataSession(file, args, protocol, requests, resultOf) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = Buffer.alloc(0), settled = false, index = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.destroy(); child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref();
      child.once('exit', () => clearTimeout(killTimer));
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Model metadata timed out')), 20000);
    const send = () => {
      const body = JSON.stringify(requests[index]);
      child.stdin.write(protocol === 'framed' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : body + '\n');
    };
    const accept = message => {
      if (message.type === 'control_response' || message.id === requests[index]?.id) {
        if (message.error || message.response?.subtype === 'error') return finish(new Error('Model metadata unavailable'));
        if (++index < requests.length) return send();
        const value = resultOf(message);
        return Array.isArray(value) && value.length ? finish(null, options(value)) : finish(new Error('No model metadata'));
      }
    };
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Model metadata process exited')));
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Model metadata too large'));
      while (!settled) {
        let raw;
        if (protocol === 'framed') {
          const boundary = buffer.indexOf('\r\n\r\n');
          if (boundary < 0) break;
          const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString())?.[1]);
          if (!length || length > 4 * 1024 * 1024) return finish(new Error('Invalid metadata frame'));
          if (buffer.length < boundary + 4 + length) break;
          raw = buffer.subarray(boundary + 4, boundary + 4 + length).toString();
          buffer = buffer.subarray(boundary + 4 + length);
        } else {
          const boundary = buffer.indexOf(10); if (boundary < 0) break;
          raw = buffer.subarray(0, boundary).toString(); buffer = buffer.subarray(boundary + 1);
        }
        try { accept(JSON.parse(raw)); } catch (_) { /* Non-protocol startup notices. */ }
      }
    });
    send();
  });
}
async function discover(provider) {
  if (provider === 'codex') {
    const data = JSON.parse(await command(process.env.CODEX_BIN || 'codex', ['debug', 'models']));
    return options((data.models || data.data || []).filter(row => !row.visibility || row.visibility === 'list'));
  }
  if (provider === 'claude') return metadataSession('claude', [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
  ], 'lines', [{ type: 'control_request', request_id: 'model-discovery', request: { subtype: 'initialize', hooks: {} } }],
  message => message.response?.response?.models);
  if (provider === 'copilot') return metadataSession('copilot', ['--headless', '--stdio', '--no-auto-update'], 'framed',
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'models.list', params: {} }], message => message.result?.models);
  if (provider === 'gemini' && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) return bundledGeminiModels();
  if (provider === 'antigravity') return (await command('agy', ['models'])).trim().split('\n')
    .map(line => { const [value, label] = line.split('\t'); return { value, label: label || value }; });
  if (provider === 'kilo') return (await command('kilo', ['models'])).trim().split('\n').map(value => ({ value: value.replace(/^kilo\//, ''), label: value }));
  if (provider === 'pi') return (await command('pi', ['--list-models'])).split('\n').flatMap(line => {
    const match = /^\s*(\S+)\s+(\S+)/.exec(line);
    return match && !['provider', 'Provider'].includes(match[1]) ? [{ value: match[1] + '/' + match[2], label: match[2] }] : [];
  });
  let url, headers = {};
  if (provider === 'openrouter') url = 'https://openrouter.ai/api/v1/models';
  else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    url = 'https://api.openai.com/v1/models'; headers.Authorization = 'Bearer ' + process.env.OPENAI_API_KEY;
  } else if (provider === 'gemini' && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    url = 'https://generativelanguage.googleapis.com/v1beta/models'; headers['x-goog-api-key'] = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  } else if (provider === 'ollama') url = 'http://127.0.0.1:11434/api/tags';
  else if (provider === 'lmstudio') url = 'http://127.0.0.1:1234/v1/models';
  else return [];
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Model listing unavailable');
  const data = await response.json();
  const rows = data.data || data.models || [];
  return options(rows.filter(row => provider === 'gemini' ? row.supportedGenerationMethods?.includes('generateContent')
    : provider === 'openrouter' ? row.architecture?.output_modalities?.includes('text')
    : provider === 'openai' ? /^(?:gpt-|o\d|chatgpt-)/.test(row.id || '') && !/embedding|tts|audio|image|sora|moderation/i.test(row.id)
    : true)
    .map(row => ({ ...row, id: (row.id || row.name || '').replace(/^models\//, '') })));
}
async function main() {
  const stamp = process.env.CHATSPACE_MODEL_STAMP;
  if (stamp && fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 3 * 3600000) return;
  const api = process.env.CHATSPACE_MODEL_API_BASE || process.env.API_BASE;
  const key = process.env.CHATSPACE_MODEL_API_KEY || process.env.API_KEY;
  const selected = process.env.CHATSPACE_MODEL_PROVIDER || process.argv[2];
  const providers = selected ? [selected] : ['codex','claude','copilot','gemini','antigravity','pi','kilo','openai','openrouter','ollama','lmstudio'];
  const results = await Promise.allSettled(providers.map(async provider => {
    const models = options(await discover(provider));
    if (!models.length) return;
    if (api && key) {
      const response = await fetch(api.replace(/\/$/, '') + '/agent/models/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ provider, models, source: provider === 'openrouter' ? 'public-catalog'
          : provider === 'gemini' && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY ? 'cli-bundled' : 'cli-metadata' }),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Catalog sync unavailable');
    } else console.log(JSON.stringify({ provider, models }));
  }));
  if (stamp && results.some(result => result.status === 'fulfilled')) fs.writeFileSync(stamp, new Date().toISOString(), { mode: 0o600 });
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { discover, options, metadataSession, bundledGeminiModels, main };
