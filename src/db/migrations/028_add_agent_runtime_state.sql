-- Migration: Persist agent runtime config/permissions in the database
-- This keeps dashboard/API config changes authoritative even when the
-- agent runtime lives on a different machine than the web server.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_config JSONB DEFAULT '{}'::jsonb;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS allowed_permissions JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agents.runtime_config IS 'Server-side source of truth for agent runtime config (provider/model/approval/sandbox).';
COMMENT ON COLUMN agents.allowed_permissions IS 'Server-side copy of CLI-granted permissions used for validation and spawned child inheritance.';
