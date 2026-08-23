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
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-terra')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-luna')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.6-sol')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.5')).toBe(true);
    expect(catalog.codex.some(m => m.value === 'gpt-5.4')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-4-7')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-4-8')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-opus-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-fable-5')).toBe(true);
    expect(catalog.claude.some(m => m.value === 'claude-sonnet-5')).toBe(true);
    expect(catalog.copilot.some(m => m.value === 'gpt-5.4-mini')).toBe(true);
    expect(catalog.copilot.some(m => m.value === 'claude-opus-4.7')).toBe(true);
    expect(catalog.antigravity.some(m => m.value === 'claude-opus-4.8')).toBe(true);
    expect(catalog.antigravity.some(m => m.value === 'gemini-3.1-pro')).toBe(true);
    expect(catalog.pi.some(m => m.value === 'default')).toBe(true);
    expect(catalog.pi.some(m => m.value === 'sonnet:high')).toBe(true);
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
});
