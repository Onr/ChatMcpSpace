-- Migration: Track the latest agent CLI version reported by each agent runtime
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS reported_cli_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS reported_cli_version_at TIMESTAMP;

COMMENT ON COLUMN agents.reported_cli_version IS 'Last CLI version string reported by the agent runtime during /api/agent/responses polling';
COMMENT ON COLUMN agents.reported_cli_version_at IS 'Timestamp of the most recent CLI version report from the agent runtime';
