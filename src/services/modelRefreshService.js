'use strict';
const fs = require('fs');
const path = require('path');
const CATALOG_PATH = path.join(process.cwd(), 'data', 'provider-model-cache', '_discovered.json');
const REFRESH_MS = 3 * 60 * 60 * 1000;
let timer = null;
let pending = null;

function mapPublicModels(rows, now = Date.now()) {
  const result = {};
  const add = (provider, value, row) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(value)) return;
    (result[provider] ||= []).push({ value, label: String(row.name || value).slice(0, 180),
      discoveredAt: new Date(now).toISOString(), unconfirmed: true });
  };
  for (const row of rows || []) {
    if (typeof row.id !== 'string' || !row.architecture?.output_modalities?.includes('text')) continue;
    add('openrouter', row.id, row);
    const slash = row.id.indexOf('/');
    const vendor = row.id.slice(0, slash), model = row.id.slice(slash + 1);
    if (vendor === 'anthropic' && /^claude-[a-z0-9.-]+$/.test(model)) {
      add('claude', model.replace(/\.(\d+)/g, '-$1'), row);
      add('copilot', model, row);
    } else if (vendor === 'google' && /^gemini-[a-z0-9.-]+$/.test(model)) {
      add('gemini', model, row); add('copilot', model, row);
    } else if (vendor === 'openai') {
      add('openai', model, row);
      if (/^gpt-[0-9]/.test(model)) { add('codex', model, row); add('copilot', model, row); }
    }
    // Antigravity IDs are account-specific; never guess them from vendor IDs.
  }
  return result;
}

async function refreshModelCatalog({ fetchImpl = global.fetch, now = Date.now(), force = false, file = CATALOG_PATH } = {}) {
  if (pending) return pending;
  if (!force && fs.existsSync(file) && now - fs.statSync(file).mtimeMs < REFRESH_MS) return { refreshed: false };
  pending = (async () => {
    const response = await fetchImpl('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(20000), redirect: 'error', headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Public model catalog returned HTTP ' + response.status);
    const body = await response.json();
    if (!Array.isArray(body.data) || !body.data.length || body.data.length > 20000) throw new Error('Public model catalog is incomplete');
    const providers = mapPublicModels(body.data, now);
    if (!providers.openrouter?.length) throw new Error('Public model catalog contains no chat models');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ updatedAt: new Date(now).toISOString(), providers }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return { refreshed: true, models: providers.openrouter.length };
  })().finally(() => { pending = null; });
  return pending;
}
function startModelRefresh() {
  if (timer || process.env.MODEL_CATALOG_AUTO_REFRESH === 'false') return;
  const refresh = () => refreshModelCatalog().catch(error => console.warn('[model-catalog]', error.message));
  void refresh();
  timer = setInterval(refresh, REFRESH_MS); timer.unref();
}
function stopModelRefresh() { clearInterval(timer); timer = null; }
module.exports = { CATALOG_PATH, REFRESH_MS, mapPublicModels, refreshModelCatalog, startModelRefresh, stopModelRefresh };
