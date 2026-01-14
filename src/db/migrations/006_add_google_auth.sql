-- Migration: Add Google Auth support
-- Description: Adds google_id column and makes password_hash nullable

-- Add google_id column for OAuth identification
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'users' AND column_name = 'google_id') THEN
    ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE;
  END IF;
END $$;

-- Make password_hash nullable since OAuth users won't have a password
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Create index for faster lookups by google_id
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
