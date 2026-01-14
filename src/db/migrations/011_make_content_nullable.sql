-- Migration: Make message content columns nullable
-- This allows messages to have only attachments without text content

-- Make messages.content nullable (currently NOT NULL)
ALTER TABLE messages ALTER COLUMN content DROP NOT NULL;

-- Make user_messages.content nullable (currently NOT NULL)
ALTER TABLE user_messages ALTER COLUMN content DROP NOT NULL;

-- Add comments to document the change
COMMENT ON COLUMN messages.content IS 'Message text content (nullable when attachments are present)';
COMMENT ON COLUMN user_messages.content IS 'User message text content (nullable when attachments are present)';
