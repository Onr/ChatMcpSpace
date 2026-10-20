-- Explicit owner opt-in; existing shares do not gain agent access automatically.
ALTER TABLE shared_conversations ADD COLUMN IF NOT EXISTS allow_agent_messages BOOLEAN NOT NULL DEFAULT FALSE;
