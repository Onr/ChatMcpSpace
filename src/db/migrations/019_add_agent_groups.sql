-- Migration: Add agent groups for inter-agent communication control
-- Created: 2026-02-01

-- Agent groups table - allows organizing agents into communication groups
CREATE TABLE IF NOT EXISTS agent_groups (
  group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  group_name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, group_name)
);

-- Agent group membership - tracks which agents belong to which groups
CREATE TABLE IF NOT EXISTS agent_group_members (
  group_id UUID NOT NULL REFERENCES agent_groups(group_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, agent_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_groups_user_id ON agent_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_group_members_agent_id ON agent_group_members(agent_id);
