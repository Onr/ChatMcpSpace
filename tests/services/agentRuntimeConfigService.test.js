const {
  DEFAULT_AGENT_API_CONFIG,
  normalizeRuntimeConfig
} = require('../../src/services/agentRuntimeConfigService');

describe('agentRuntimeConfigService', () => {
  it('defaults Codex-backed runtime config to GPT-5.6 Terra inside a workspace sandbox', () => {
    expect(DEFAULT_AGENT_API_CONFIG).toMatchObject({
      model_provider: 'codex',
      model: 'gpt-5.6-terra',
      approval_mode: 'full-auto',
      sandbox_mode: 'workspace-write'
    });
  });

  it('normalizes empty runtime config to the GPT-5.6 Terra defaults', () => {
    expect(normalizeRuntimeConfig(undefined)).toMatchObject({
      model_provider: 'codex',
      model: 'gpt-5.6-terra',
      approval_mode: 'full-auto',
      sandbox_mode: 'workspace-write'
    });
  });

  it.each(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol'])(
    'preserves an explicitly selected Codex GPT-5.6 submodel: %s',
    (model) => {
      expect(normalizeRuntimeConfig({ model_provider: 'codex', model })).toMatchObject({
        model_provider: 'codex',
        model
      });
    }
  );
});
