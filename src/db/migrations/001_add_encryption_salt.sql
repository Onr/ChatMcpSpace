-- Migration: Add encryption_salt column to users table
-- This enables end-to-end encryption for messages

-- Add encryption_salt column (nullable initially for existing users)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS encryption_salt VARCHAR(255);

-- For existing users without encryption_salt, we'll need to generate one
-- This will be handled by the migration script
