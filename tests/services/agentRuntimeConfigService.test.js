const {
  DEFAULT_AGENT_API_CONFIG,
  normalizeRuntimeConfig,
  persistAgentRuntimeState
} = require('../../src/services/agentRuntimeConfigService');

describe('agentRuntimeConfigService', () => {
  it('changing the model preserves permissions when the caller did not provide them', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await persistAgentRuntimeState({ agentId: 'agent-id', config: { model_provider: 'claude', model: 'owner-model' }, dbClient: { query } });
    expect(query.mock.calls[0][1][2]).toBeNull();
    expect(JSON.parse(query.mock.calls[0][1][1])).toMatchObject({ model_provider: 'claude', model: 'owner-model' });
  });

  it('changing permissions preserves config when the caller did not provide it', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const allowedPermissions = { claude: { '--permission-mode': ['default'] } };
    await persistAgentRuntimeState({ agentId: 'agent-id', allowedPermissions, dbClient: { query } });
    expect(query.mock.calls[0][1][1]).toBeNull();
    expect(JSON.parse(query.mock.calls[0][1][2])).toEqual(allowedPermissions);
  });

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

  it('strips the display label from a tab-separated Antigravity model value', () => {
    expect(normalizeRuntimeConfig({
      model_provider: 'antigravity',
      model: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)'
    })).toMatchObject({
      model_provider: 'antigravity',
      model: 'gemini-3.8-flash-high'
    });
  });

  it('preserves GPT-6 Astra with its maximum supported reasoning effort', () => {
    expect(normalizeRuntimeConfig({
      model_provider: 'codex',
      model: 'gpt-6-astra',
      thinking_effort: 'max'
    })).toMatchObject({
      model_provider: 'codex',
      model: 'gpt-6-astra',
      thinking_effort: 'max'
    });
  });
});
