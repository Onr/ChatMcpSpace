// Shared defaults for server and locally initialized spawned agents.
const DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS = {
  inter_agent: { enabled: true, mode: 'listen_all', groups: [] },
  claude: {
    '--permission-mode': ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    '--dangerously-skip-permissions': false
  },
  codex: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  gemini: {
    '--sandbox': true,
    '--no-sandbox': false,
    '--yolo': true
  },
  copilot: {
    '--allow-all': false,
    '--allow-all-tools': false,
    '--allow-all-paths': false
  },
  antigravity: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-skip-permissions': false
  },
  pi: { enabled: true },
  kilo: { '--auto': true },
  ollama: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  openrouter: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  },
  lmstudio: {
    '--sandbox': ['workspace-write', 'read-only'],
    '--dangerously-bypass-approvals-and-sandbox': false
  }
};

function buildDefaultLocalAgentAllowedPermissions() {
  return JSON.parse(JSON.stringify(DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS));
}

module.exports = { buildDefaultLocalAgentAllowedPermissions, DEFAULT_LOCAL_AGENT_ALLOWED_PERMISSIONS };
