-- Migration: 022_add_agent_lineage.sql
-- Description: Add agent spawning / lineage support columns to agents table
-- Date: 2026-02-09
-- Feature: Independent Agent Spawning (Phase 1)
--
-- New columns:
--   parent_agent_id  - FK to parent agent (NULL for root / user-created agents)
--   spawn_depth      - 0=root, 1=child, 2=grandchild, 3=great-grandchild (max)
--   initial_instructions - Seeded instructions from parent at spawn time
--   auto_spawned     - TRUE if created programmatically by another agent
--   can_spawn        - TRUE if this agent is allowed to spawn children

-- parent_agent_id (nullable FK → agents)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'parent_agent_id') THEN
        ALTER TABLE agents ADD COLUMN parent_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
    END IF;
END $$;

-- spawn_depth (default 0 for existing agents = root level)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'spawn_depth') THEN
        ALTER TABLE agents ADD COLUMN spawn_depth INTEGER DEFAULT 0;
    END IF;
END $$;

-- initial_instructions (text blob seeded at spawn time)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'initial_instructions') THEN
        ALTER TABLE agents ADD COLUMN initial_instructions TEXT;
    END IF;
END $$;

-- auto_spawned flag
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'auto_spawned') THEN
        ALTER TABLE agents ADD COLUMN auto_spawned BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- can_spawn flag (opt-in; default false for safety)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'can_spawn') THEN
        ALTER TABLE agents ADD COLUMN can_spawn BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Indexes for efficient lineage queries
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_spawn_depth ON agents(spawn_depth);
CREATE INDEX IF NOT EXISTS idx_agents_auto_spawned ON agents(auto_spawned) WHERE auto_spawned = TRUE;
