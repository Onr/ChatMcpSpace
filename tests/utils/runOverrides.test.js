const { validateRunOverrides } = require('../../src/utils/runOverrides');

describe('validateRunOverrides', () => {
  it('treats missing or empty input as no override', () => {
    expect(validateRunOverrides(undefined)).toEqual({ valid: true, value: null });
    expect(validateRunOverrides(null)).toEqual({ valid: true, value: null });
    expect(validateRunOverrides({ model: '', thinking_effort: null })).toEqual({ valid: true, value: null });
  });

  it('normalizes danger-full-access to none and keeps valid fields', () => {
    const result = validateRunOverrides({ model_provider: 'codex', model: 'gpt-5.6-terra', sandbox_mode: 'danger-full-access', thinking_effort: 'xhigh' });
    expect(result.value).toEqual({ model_provider: 'codex', model: 'gpt-5.6-terra', sandbox_mode: 'none', thinking_effort: 'xhigh' });
  });

  it('requires a provider when a model is given', () => {
    expect(validateRunOverrides({ model: 'gpt-5.6-terra' }).valid).toBe(false);
  });

  it('enforces the agent provider allow-list', () => {
    const perms = { codex: {}, inter_agent: { enabled: true } };
    expect(validateRunOverrides({ model_provider: 'claude', model: 'x' }, perms).valid).toBe(false);
    expect(validateRunOverrides({ model_provider: 'codex', model: 'x' }, perms).valid).toBe(true);
    expect(validateRunOverrides({ model_provider: 'default', model: 'x' }, perms).valid).toBe(true);
  });
});
