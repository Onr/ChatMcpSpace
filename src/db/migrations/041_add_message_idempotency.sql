-- Make agent-to-user message delivery idempotent.  Clients retain the same
-- UUID when retrying a request whose response may have been lost.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_message_id UUID DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_client_message_id
  ON messages(agent_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
