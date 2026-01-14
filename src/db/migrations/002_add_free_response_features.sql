-- Add allow_free_response and free_response_hint to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS allow_free_response BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS free_response_hint TEXT;

-- Add free_response to user_responses table
ALTER TABLE user_responses ADD COLUMN IF NOT EXISTS free_response TEXT;

-- Make option_id nullable in user_responses (if it wasn't already)
ALTER TABLE user_responses ALTER COLUMN option_id DROP NOT NULL;

-- Create user_messages table if it doesn't exist
CREATE TABLE IF NOT EXISTS user_messages (
  user_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for user_messages
CREATE INDEX IF NOT EXISTS idx_user_messages_agent_id ON user_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_user_messages_created_at ON user_messages(created_at DESC);
