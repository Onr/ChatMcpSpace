-- Migration: 023_enable_spawn_for_existing_agents.sql
-- Description: Enable can_spawn for all existing agents so they can use the spawn API.
--              Previously can_spawn defaulted to FALSE, which meant agents didn't know
--              they could create child agents. Now all agents can spawn by default.
-- Date: 2026-02-10

-- Enable spawning for all existing non-spawned (root) agents
UPDATE agents SET can_spawn = TRUE WHERE auto_spawned = FALSE AND can_spawn = FALSE;

-- Also change the column default so new agents get can_spawn = TRUE
ALTER TABLE agents ALTER COLUMN can_spawn SET DEFAULT TRUE;
