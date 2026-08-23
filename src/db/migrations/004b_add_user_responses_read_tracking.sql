-- Migration: Add read_at column to user_responses table
-- This allows tracking when the agent reads option/free-response answers

-- Add read_at column to user_responses table
ALTER TABLE user_responses ADD COLUMN IF NOT EXISTS read_at TIMESTAMP DEFAULT NULL;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_user_responses_read_at ON user_responses(read_at);
