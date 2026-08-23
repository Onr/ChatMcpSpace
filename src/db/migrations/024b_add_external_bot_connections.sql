-- Migration: 024_add_external_bot_connections.sql
-- Description: Track externally managed bot connections (e.g. OpenClaw)
-- Date: 2026-02-18

CREATE TABLE IF NOT EXISTS external_bot_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  provider_bot_ref VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'pending_setup',
  last_handshake_at TIMESTAMP,
  last_error_code VARCHAR(100),
  last_error_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id),
  UNIQUE (user_id, provider, provider_bot_ref)
);

CREATE INDEX IF NOT EXISTS idx_external_bot_connections_user_id
  ON external_bot_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_external_bot_connections_provider
  ON external_bot_connections(provider);
CREATE INDEX IF NOT EXISTS idx_external_bot_connections_status
  ON external_bot_connections(status);
