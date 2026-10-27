-- Hosted decryption is a separate, explicit approval. Existing grants remain
-- browser-only and must never acquire this authority through token refresh.
ALTER TABLE mcp_oauth_codes ADD COLUMN IF NOT EXISTS hosted_approved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mcp_oauth_tokens ADD COLUMN IF NOT EXISTS hosted_approved BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS mcp_hosted_connections (
  grant_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mcp_hosted_connections_owner_idx ON mcp_hosted_connections(user_id);
CREATE INDEX IF NOT EXISTS mcp_hosted_connections_agent_idx ON mcp_hosted_connections(agent_id);

CREATE TABLE IF NOT EXISTS mcp_hosted_peer_keys (
  grant_id UUID NOT NULL REFERENCES mcp_hosted_connections(grant_id) ON DELETE CASCADE,
  peer_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  PRIMARY KEY(grant_id, peer_id)
);
CREATE INDEX IF NOT EXISTS mcp_hosted_peer_keys_peer_idx ON mcp_hosted_peer_keys(peer_id);
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS encryption_peer_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;

-- Only ciphertext and non-secret delivery metadata are stored for retries.
CREATE TABLE IF NOT EXISTS mcp_hosted_retries (
  grant_id UUID NOT NULL REFERENCES mcp_hosted_connections(grant_id) ON DELETE CASCADE,
  idempotency_id UUID NOT NULL,
  operation TEXT NOT NULL,
  recipient_id UUID,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(grant_id, idempotency_id)
);
CREATE INDEX IF NOT EXISTS mcp_hosted_retries_created_idx ON mcp_hosted_retries(created_at);

CREATE TABLE IF NOT EXISTS agent_message_attachments (
  agent_message_id UUID NOT NULL REFERENCES agent_messages(agent_message_id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  attachment_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(agent_message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS agent_message_attachments_attachment_idx ON agent_message_attachments(attachment_id);
