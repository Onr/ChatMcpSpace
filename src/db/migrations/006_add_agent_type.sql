-- Migration: Add agent_type column to agents table
-- This enables differentiation between standard agents and news feed agents

-- Add agent_type column with default value 'standard'
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(20) DEFAULT 'standard';

-- Add check constraint to ensure valid values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage 
    WHERE constraint_name = 'agents_agent_type_check'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_agent_type_check 
    CHECK (agent_type IN ('standard', 'news_feed'));
  END IF;
END $$;

-- Add index for querying by type
CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON agents(agent_type);

-- Add comment to document the column
COMMENT ON COLUMN agents.agent_type IS 'Agent type: standard (interactive agent) or news_feed (read-only activity log)';
