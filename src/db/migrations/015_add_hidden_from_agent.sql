-- Migration: Add hidden_from_agent column to user_messages table
-- When TRUE, the message is still visible to the user in the dashboard
-- but is NOT sent to the agent when they poll for responses

-- Add the column with default FALSE (messages are visible to agent by default)
ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE;

-- Create index for efficient filtering when agents poll for messages
CREATE INDEX IF NOT EXISTS idx_user_messages_hidden_from_agent ON user_messages(hidden_from_agent);
