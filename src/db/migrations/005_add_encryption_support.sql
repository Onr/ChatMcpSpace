-- Migration: Add encryption support to messages
-- This adds columns to track whether messages are encrypted

-- Add encrypted flag to messages table
ALTER TABLE messages 
ADD COLUMN encrypted BOOLEAN DEFAULT FALSE;

-- Add encrypted flag to user_messages table
ALTER TABLE user_messages 
ADD COLUMN encrypted BOOLEAN DEFAULT FALSE;

-- Add indexes for encrypted queries (optional optimization)
CREATE INDEX idx_messages_encrypted ON messages(encrypted);
CREATE INDEX idx_user_messages_encrypted ON user_messages(encrypted);

-- Add comment to document encryption model
COMMENT ON COLUMN messages.encrypted IS 'TRUE if content is E2E encrypted (client-side), FALSE if plain text';
COMMENT ON COLUMN user_messages.encrypted IS 'TRUE if content is E2E encrypted (client-side), FALSE if plain text';
