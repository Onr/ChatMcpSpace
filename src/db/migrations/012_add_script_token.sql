-- Migration: Add script_token column to users table
-- This enables secure short URL access to download CLI scripts
-- Token is cryptographically random and URL-safe to prevent brute-force attacks

-- Add script_token column
ALTER TABLE users ADD COLUMN IF NOT EXISTS script_token VARCHAR(64) UNIQUE;

-- Generate script tokens for existing users using random bytes
-- This uses PostgreSQL's gen_random_bytes for cryptographic randomness
DO $$
DECLARE
  user_record RECORD;
  new_token VARCHAR(64);
BEGIN
  FOR user_record IN SELECT user_id FROM users WHERE script_token IS NULL LOOP
    -- Generate a URL-safe random token (32 bytes = 64 hex characters)
    new_token := encode(gen_random_bytes(32), 'hex');
    UPDATE users SET script_token = new_token WHERE user_id = user_record.user_id;
  END LOOP;
END $$;

-- Make script_token NOT NULL after populating existing rows
ALTER TABLE users ALTER COLUMN script_token SET NOT NULL;

-- Add index for fast lookups by script_token
CREATE INDEX IF NOT EXISTS idx_users_script_token ON users(script_token);

-- Add comment to document the column
COMMENT ON COLUMN users.script_token IS 'Cryptographically random token for secure CLI script short URL access (64 hex chars)';
