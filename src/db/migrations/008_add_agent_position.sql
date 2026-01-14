-- Add position column to agents table for fixed ordering
-- This ensures agents maintain their positions when new agents are added

-- Add position column
ALTER TABLE agents ADD COLUMN IF NOT EXISTS position INTEGER;

-- Set initial positions for existing agents based on creation order (per user)
UPDATE agents a
SET position = sub.row_num
FROM (
  SELECT agent_id, 
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC) as row_num
  FROM agents
) sub
WHERE a.agent_id = sub.agent_id;

-- Make position NOT NULL after initial population
ALTER TABLE agents ALTER COLUMN position SET NOT NULL;

-- Add index for efficient ordering by user and position
CREATE INDEX IF NOT EXISTS idx_agents_user_position ON agents(user_id, position);
