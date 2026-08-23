-- Migration: Add inter_agent_mode to agents table
-- Created: 2026-02-02

-- Add inter_agent_mode column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'inter_agent_mode') THEN
        ALTER TABLE agents ADD COLUMN inter_agent_mode VARCHAR(50) DEFAULT 'disabled';
    END IF;
END $$;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_agents_inter_agent_mode ON agents(inter_agent_mode);
