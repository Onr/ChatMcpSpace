const fs = require('fs');
const path = require('path');

const STATIC_PROVIDER_MODELS = {
  codex: [
    { value: 'default', label: 'Default' },
    { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-pro', label: 'GPT-5.4 Pro' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
    { value: 'gpt-5.2', label: 'GPT-5.2' }
  ],
  openai: [
    { value: 'default', label: 'Default' },
    { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { value: 'o3', label: 'o3' },
    { value: 'o3-mini', label: 'o3-mini' },
    { value: 'o1', label: 'o1' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' }
  ],
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { value: 'claude-mythos-5-1', label: 'Claude Mythos 5.1 (invite only)' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-fable-5', label: 'Claude Fable 5' },
    { value: 'claude-mythos-5', label: 'Claude Mythos 5 (invite only)' },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (2025-09-29)' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (2025-10-01)' },
    { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' }
  ],
  gemini: [
    { value: 'default', label: 'Default' },
    { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash' },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' }
  ],
  copilot: [
    { value: 'default', label: 'Default' },
    { value: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
    { value: 'claude-opus-4.7', label: 'Claude Opus 4.7' },
    { value: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
    { value: 'claude-opus-4.6-fast', label: 'Claude Opus 4.6 Fast' },
    { value: 'claude-opus-4.5', label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-5.1', label: 'GPT-5.1' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'grok-code-fast-1', label: 'Grok Code Fast 1' },
    { value: 'raptor-mini', label: 'Raptor Mini' },
    { value: 'goldeneye', label: 'Goldeneye' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'o3-mini', label: 'o3-mini' }
  ],
  pi: [
    { value: 'default', label: 'Default' },
    { value: 'sonnet', label: 'Claude Sonnet alias' },
    { value: 'sonnet:high', label: 'Claude Sonnet high thinking' },
    { value: 'opus', label: 'Claude Opus alias' },
    { value: 'openai/gpt-4o', label: 'OpenAI GPT-4o' },
    { value: 'openai/o3', label: 'OpenAI o3' }
  ],
  antigravity: [
    // IDs `agy --model` accepted on 2026-10-16 (4.6 Claude models were retired);
    // account rosters differ, so the CLI's `agy models` sync adds the rest.
    { value: 'default', label: 'Default' },
    { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { value: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    { value: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
    { value: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
    { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
    { value: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
    { value: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
  ],
  kilo: [
    { value: 'default', label: 'Default' },
    { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'google/gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'x-ai/grok-4', label: 'Grok 4' },
    { value: 'x-ai/grok-4-fast', label: 'Grok 4 Fast' },
    { value: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast 1' },
    { value: 'x-ai/grok-3', label: 'Grok 3' },
    { value: 'x-ai/grok-3-mini', label: 'Grok 3 Mini' },
    { value: 'openai/gpt-5', label: 'GPT-5' },
    { value: 'openai/o3', label: 'o3' }
  ],
  openrouter: [
    { value: 'default', label: 'Default' },
    { value: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
    { value: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
    { value: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
    { value: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1' },
    { value: 'google/gemini-4-argon', label: 'Gemini 4 Argon' },
    { value: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    { value: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'openai/gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'x-ai/grok-4.7', label: 'Grok 4.7' },
    { value: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
    { value: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { value: 'google/gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'x-ai/grok-4', label: 'Grok 4' },
    { value: 'x-ai/grok-4-fast', label: 'Grok 4 Fast' },
    { value: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast 1' },
    { value: 'x-ai/grok-3', label: 'Grok 3' },
    { value: 'x-ai/grok-3-mini', label: 'Grok 3 Mini' },
    { value: 'openai/o3', label: 'o3' },
    { value: 'openai/o3-mini', label: 'o3-mini' },
    { value: 'openai/gpt-4o', label: 'GPT-4o' }
  ],
  ollama: [
    { value: 'default', label: 'Default' }
  ],
  lmstudio: [
    { value: 'default', label: 'Default' }
  ]
};

const CACHE_DIR = path.join(process.cwd(), 'data', 'provider-model-cache');
const SUPPORTED_PROVIDERS = new Set(Object.keys(STATIC_PROVIDER_MODELS));

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeModelValue(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  if (value.length > 200) return '';
  return value;
}

// Some CLIs (e.g. `agy models`) print "<id>\t<display label>" per line, and
// older syncs cached that whole line as both value and label.
function splitTabbedModel(raw) {
  const [id, ...labelParts] = String(raw).split('\t');
  return { id, tabLabel: labelParts.join(' ').trim() };
}

function normalizeModelOption(input) {
  if (typeof input === 'string') {
    const { id, tabLabel } = splitTabbedModel(input);
    const value = sanitizeModelValue(id);
    if (!value) return null;
    return { value, label: tabLabel || value };
  }
  if (!input || typeof input !== 'object') return null;
  const rawValue = input.value || input.id || input.model || '';
  const { id, tabLabel } = splitTabbedModel(rawValue);
  const value = sanitizeModelValue(id);
  if (!value) return null;
  let rawLabel = typeof input.label === 'string' ? input.label.trim() : '';
  if (rawLabel.includes('\t')) rawLabel = splitTabbedModel(rawLabel).tabLabel;
  return { value, label: rawLabel || tabLabel || value, ...(input.unconfirmed === true ? { unconfirmed: true } : {}) };
}

function dedupeAndNormalizeOptions(options = []) {
  const byValue = new Map();
  for (const option of options) {
    const normalized = normalizeModelOption(option);
    if (!normalized) continue;
    if (!byValue.has(normalized.value)) {
      byValue.set(normalized.value, normalized);
    }
  }

  const deduped = Array.from(byValue.values());
  deduped.sort((a, b) => {
    if (a.value === 'default') return -1;
    if (b.value === 'default') return 1;
    return a.value.localeCompare(b.value);
  });

  if (!deduped.some(m => m.value === 'default')) {
    deduped.unshift({ value: 'default', label: 'Default' });
  }

  return deduped;
}

function readUserModelCache(userId) {
  try {
    const cachePath = path.join(CACHE_DIR, `${userId}.json`);
    if (!fs.existsSync(cachePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeUserModelCache(userId, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${userId}.json`);
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function getProviderModelCatalog(userId) {
  const staticCatalog = deepClone(STATIC_PROVIDER_MODELS);
  let discovered = {};
  try { discovered = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, '_discovered.json'), 'utf8')).providers || {}; } catch (_) { /* Use the last built-in catalog offline. */ }
  const cache = userId ? readUserModelCache(userId) : {};
  const merged = {};
  for (const provider of Object.keys(staticCatalog)) {
    const staticModels = staticCatalog[provider] || [];
    const staticIds = new Set(staticModels.map(option => option.value));
    const cachedModels = (Array.isArray(cache[provider]?.models) ? cache[provider].models : []).map(option => {
      const normalized = normalizeModelOption(option);
      if (normalized && ['public-catalog', 'cli-bundled'].includes(cache[provider]?.source) && !staticIds.has(normalized.value)) {
        return { ...normalized, label: `${normalized.label} · New, untested`, unconfirmed: true };
      }
      return option;
    });
    const known = new Set([...staticModels, ...cachedModels].map(option => normalizeModelOption(option)?.value));
    const candidates = (discovered[provider] || []).filter(option => !known.has(option.value))
      .map(option => ({ ...option, label: `${option.label} · New, untested`, unconfirmed: true }));
    merged[provider] = dedupeAndNormalizeOptions([...staticModels, ...cachedModels, ...candidates]);
  }
  return merged;
}

function updateProviderModelsForUser(userId, provider, models, source = 'cli') {
  if (!userId || !SUPPORTED_PROVIDERS.has(provider)) {
    return { updated: false, reason: 'invalid_user_or_provider' };
  }

  const normalized = dedupeAndNormalizeOptions(models);
  if (normalized.length === 0) {
    return { updated: false, reason: 'no_models' };
  }

  const cache = readUserModelCache(userId);
  cache[provider] = {
    source,
    updatedAt: new Date().toISOString(),
    models: normalized
  };
  writeUserModelCache(userId, cache);

  return {
    updated: true,
    provider,
    count: normalized.length,
    updatedAt: cache[provider].updatedAt
  };
}

function getProviderModels(provider, userId) {
  const catalog = getProviderModelCatalog(userId);
  return catalog[provider] || [{ value: 'default', label: 'Default' }];
}

module.exports = {
  STATIC_PROVIDER_MODELS,
  SUPPORTED_PROVIDERS,
  dedupeAndNormalizeOptions,
  getProviderModelCatalog,
  getProviderModels,
  updateProviderModelsForUser
};
