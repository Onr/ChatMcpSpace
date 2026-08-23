-- Migration: Add working heartbeat fields to agents
-- Tracks whether an agent is currently executing work and the latest heartbeat timestamp

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS is_working BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS last_working_heartbeat_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_agents_is_working ON agents(is_working);
CREATE INDEX IF NOT EXISTS idx_agents_last_working_heartbeat_at ON agents(last_working_heartbeat_at DESC);

COMMENT ON COLUMN agents.is_working IS 'True while agent runner reports active command execution';
COMMENT ON COLUMN agents.last_working_heartbeat_at IS 'Timestamp of most recent runner heartbeat while command was executing';
