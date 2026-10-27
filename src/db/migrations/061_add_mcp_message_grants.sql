-- Stable identity for a consented MCP grant. Token hashes rotate; grant IDs do not.
ALTER TABLE mcp_oauth_codes ADD COLUMN IF NOT EXISTS grant_id UUID;
ALTER TABLE mcp_oauth_tokens ADD COLUMN IF NOT EXISTS grant_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_oauth_tokens_grant_id_idx
  ON mcp_oauth_tokens(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_grant_id_idx ON mcp_oauth_codes(grant_id);

ALTER TABLE mcp_oauth_tokens ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
ALTER TABLE mcp_oauth_codes ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;

ALTER TABLE agent_api_credentials ADD COLUMN IF NOT EXISTS mcp_grant_id UUID;
CREATE INDEX IF NOT EXISTS agent_api_credentials_mcp_grant_idx
  ON agent_api_credentials(mcp_grant_id) WHERE mcp_grant_id IS NOT NULL;
