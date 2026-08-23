CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
  code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX IF NOT EXISTS idx_user_mfa_recovery_codes_user_id
  ON user_mfa_recovery_codes(user_id);
