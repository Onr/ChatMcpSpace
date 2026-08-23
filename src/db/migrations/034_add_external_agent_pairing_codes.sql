-- Migration: 034_add_external_agent_pairing_codes.sql
-- Description: Short-lived pairing codes for agent-started external agent setup
-- Date: 2026-06-05

CREATE TABLE IF NOT EXISTS external_agent_pairing_codes (
  pairing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  requested_agent_name VARCHAR(255) NOT NULL,
  provider_bot_ref VARCHAR(255),
  inter_agent_mode VARCHAR(50) NOT NULL DEFAULT 'groups',
  group_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  can_spawn BOOLEAN NOT NULL DEFAULT FALSE,
  pairing_code_hash VARCHAR(128) NOT NULL UNIQUE,
  display_code_prefix VARCHAR(12) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  redeemed_at TIMESTAMP,
  redeemed_agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL,
  connection_id UUID REFERENCES external_bot_connections(connection_id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_external_agent_pairing_codes_user_id
  ON external_agent_pairing_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_external_agent_pairing_codes_expires_at
  ON external_agent_pairing_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_external_agent_pairing_codes_redeemed_at
  ON external_agent_pairing_codes(redeemed_at);
