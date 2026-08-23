-- Migration: 025_add_agent_api_credentials.sql
-- Description: Scoped per-agent credentials and auth audit events
-- Date: 2026-02-18

CREATE TABLE IF NOT EXISTS agent_api_credentials (
  credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  token_prefix VARCHAR(24) NOT NULL,
  scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  rotated_from UUID REFERENCES agent_api_credentials(credential_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_api_credentials_agent_id
  ON agent_api_credentials(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_api_credentials_active
  ON agent_api_credentials(agent_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS agent_auth_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  credential_id UUID REFERENCES agent_api_credentials(credential_id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  ip_hash VARCHAR(128),
  user_agent_hash VARCHAR(128),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_auth_events_agent_id
  ON agent_auth_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_auth_events_type
  ON agent_auth_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_auth_events_created_at
  ON agent_auth_events(created_at DESC);
