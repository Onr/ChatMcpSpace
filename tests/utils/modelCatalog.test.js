const fs = require('fs');
const path = require('path');
const {
  getProviderModelCatalog,
  updateProviderModelsForUser
} = require('../../src/utils/modelCatalog');

describe('modelCatalog', () => {
  const userId = 'test-user-models';
  const cacheFile = path.join(process.cwd(), 'data', 'provider-model-cache', `${userId}.json`);

  afterEach(() => {
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  });

  it('returns static catalog when no cache exists', () => {
    const catalog = getProviderModelCatalog(userId);
    expect(Array.isArray(catalog.codex)).toBe(true);
    expect(catalog.codex.some(m => m.value === 'default')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-6-astra')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-6-sol')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-6.1-sol')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-6-luna')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-terra')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-luna')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-sol')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.5')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.4')).toBe(true);
    expect(catalog.openai.some(m => m.value === 'gpt-6-astra')).toBe(true);
    expect(catalog.openai.some(m => m.value === 'gpt-6-sol')).toBe(true);
    expect(catalog.openai.some(m => m.value === 'gpt-6.1-sol')).toBe(true);
    expect(catalog.openai.some(m => m.value === 'gpt-6-luna')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-4-7')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-4-8')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-fable-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-fable-5-1')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-mythos-5-1')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-5-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-mythos-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-sonnet-5-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-sonnet-5')).toBe(true);
    expect(catalog.gemini.some(m => m.value === 'gemini-3.8-flash')).toBe(true);
    expect(catalog.gemini.some(m => m.value === 'gemini-3.7-flash')).toBe(true);
    expect(catalog.copilot.some(m => m.value === 'gpt-5.4-mini')).toBe(true);
    expect(catalog.copilot.some(m => m.value === 'claude-opus-4.7')).toBe(true);
    // agy rejects dotted IDs like claude-opus-4.8 and gemini-3.1-pro.
    expect(catalog.antigravity.some(m => m.value === 'claude-opus-4.8')).toBe(false);
    expect(catalog.antigravity.some(m => m.value === 'claude-opus-4-6-thinking')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-haiku-5-5')).toBe(true);
    expect(catalog.gemini.some(m => m.value === 'gemini-4-argon')).toBe(true);
    expect(catalog.openrouter.some(m => m.value === 'google/gemini-4-argon')).toBe(true);
    expect(catalog.antigravity.some(m => m.value === 'gemini-3.8-flash')).toBe(true);
    expect(catalog.pi.some(m => m.value === 'default')).toBe(true);
    expect(catalog.pi.some(m => m.value === 'sonnet:high')).toBe(true);
  });

  it('splits tab-separated "id<TAB>label" lines from `agy models`', () => {
    const sync = updateProviderModelsForUser(userId, 'antigravity', [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)'
    ], 'test');
    expect(sync.updated).toBe(true);

    const catalog = getProviderModelCatalog(userId);
    expect(catalog.antigravity).toContainEqual({ value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' });
    expect(catalog.antigravity).toContainEqual({ value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' });
    expect(catalog.antigravity.some(m => m.value.includes('\t'))).toBe(false);
  });

  it('repairs cached option objects whose value and label hold a tabbed line', () => {
    const tabbed = 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)';
    updateProviderModelsForUser(userId, 'antigravity', [{ value: tabbed, label: tabbed }], 'test');

    const catalog = getProviderModelCatalog(userId);
    expect(catalog.antigravity).toContainEqual({ value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' });
    expect(catalog.antigravity.some(m => m.value.includes('\t') || m.label.includes('\t'))).toBe(false);
  });

  it('merges synced models into provider catalog', () => {
    const sync = updateProviderModelsForUser(userId, 'openai', ['gpt-4.1', 'o3-mini'], 'test');
    expect(sync.updated).toBe(true);

    const catalog = getProviderModelCatalog(userId);
    const openaiValues = catalog.openai.map(m => m.value);
    expect(openaiValues).toContain('gpt-4.1');
    expect(openaiValues).toContain('o3-mini');
    expect(openaiValues[0]).toBe('default');
  });

  it('keeps public discovery untested until a native CLI lists a model', () => {
    updateProviderModelsForUser(userId, 'openrouter', [{ value: 'vendor/future-model', label: 'Future' }], 'public-catalog');
    expect(getProviderModelCatalog(userId).openrouter.find(model => model.value === 'vendor/future-model'))
      .toMatchObject({ label: 'Future · New, untested', unconfirmed: true });
    updateProviderModelsForUser(userId, 'claude', [{ value: 'claude-future', label: 'Future Claude' }], 'cli-metadata');
    expect(getProviderModelCatalog(userId).claude.find(model => model.value === 'claude-future'))
      .toEqual({ value: 'claude-future', label: 'Future Claude' });
  });

  it('offers xAI Grok models via OpenRouter and Kilo', () => {
    const catalog = getProviderModelCatalog(userId);
    for (const provider of ['openrouter', 'kilo']) {
      const values = catalog[provider].map((m) => m.value);
      expect(values).toEqual(expect.arrayContaining(['x-ai/grok-4', 'x-ai/grok-4-fast', 'x-ai/grok-code-fast-1']));
    }
  });
});
