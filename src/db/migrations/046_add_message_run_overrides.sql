-- Optional per-message run settings (provider, model, effort, permissions).
-- NULL means "use the agent's own runtime config".
ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS run_overrides JSONB DEFAULT NULL;
ALTER TABLE scheduled_user_messages ADD COLUMN IF NOT EXISTS run_overrides JSONB DEFAULT NULL;
