-- Migration: Add read tracking to messages
-- This migration adds read_at columns to track when messages are viewed

-- Add read_at column to messages table (agent messages read by user)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP DEFAULT NULL;

-- Add read_at column to user_messages table (user messages read by agent)
ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP DEFAULT NULL;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_read_at ON messages(read_at);
CREATE INDEX IF NOT EXISTS idx_user_messages_read_at ON user_messages(read_at);
