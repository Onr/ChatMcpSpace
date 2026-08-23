-- Migration: Add run_command to messages for the dashboard message info modal
-- schema.sql already includes this column for fresh installs, but no migration
-- was ever created for existing databases, so production silently stored NULL
-- (the routes probe for the column and fall back to NULL AS run_command).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS run_command VARCHAR(500) DEFAULT NULL;

COMMENT ON COLUMN messages.run_command IS 'Exact CLI command the agent ran to produce this message. Reported by the agent client; shown in the dashboard message info modal.';
