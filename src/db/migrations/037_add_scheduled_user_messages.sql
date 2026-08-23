-- User-authored messages that should be delivered to an agent at a future time.
CREATE TABLE IF NOT EXISTS scheduled_user_messages (
  scheduled_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_for TIMESTAMP NOT NULL,
  delivered_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_user_messages_due
  ON scheduled_user_messages (scheduled_for)
  WHERE delivered_at IS NULL;
