-- Migration: Add encryption salt to agent_groups for group-specific E2E encrypted DMs
-- Created: 2026-02-02

-- Add encryption salt to agent_groups for per-group inter-agent encrypted messaging
ALTER TABLE agent_groups ADD COLUMN IF NOT EXISTS encryption_salt VARCHAR(255);

-- Add comment explaining the field
COMMENT ON COLUMN agent_groups.encryption_salt IS 'Base64-encoded salt for deriving encryption key for inter-agent DMs within this group';
