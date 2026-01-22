-- Add hidden_from_agent column to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_messages_hidden_from_agent ON messages(hidden_from_agent);
