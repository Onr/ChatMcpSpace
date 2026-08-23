-- Migration: 030_add_chief_of_staff.sql
-- Description: Add is_chief_of_staff flag to agents table for the Chief of Staff
--              privileged agent role. Multiple named CoS agents are allowed
--              per user so each local machine can have its own instance.
-- Date: 2026-05-15
-- Feature: Chief of Staff agent (privileged agent that can spawn / delete /
--          edit other agents on behalf of the user via /api/agent/cos/*).

-- is_chief_of_staff flag
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'is_chief_of_staff'
    ) THEN
        ALTER TABLE agents
            ADD COLUMN is_chief_of_staff BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Lookup index for the chiefOfStaffOnly middleware.
CREATE INDEX IF NOT EXISTS idx_agents_is_chief_of_staff
    ON agents(is_chief_of_staff)
    WHERE is_chief_of_staff = TRUE;

-- (user_id, agent_name) supports the per-request middleware lookup that
-- resolves the X-Agent-Name header to an agent_id on every CoS API call.
CREATE INDEX IF NOT EXISTS idx_agents_user_name
    ON agents(user_id, agent_name);
