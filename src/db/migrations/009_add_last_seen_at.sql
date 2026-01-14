-- Migration: Add last_seen_at column to agents table
-- Tracks when an agent was last active (sent a message or checked for updates)

-- Add last_seen_at column with default value of created_at or current timestamp
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Add index for querying by last activity
CREATE INDEX IF NOT EXISTS idx_agents_last_seen_at ON agents(last_seen_at DESC);

-- Add comment to document the column
COMMENT ON COLUMN agents.last_seen_at IS 'Timestamp when agent was last active (sent message or polled for responses)';
