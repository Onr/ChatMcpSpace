-- Additive owner-controlled execution devices and scoped sharing grants.
-- Guest principals are added by the later guest-sharing migration.
CREATE TABLE IF NOT EXISTS agent_devices (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  custodian_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  device_label VARCHAR(120) NOT NULL,
  platform VARCHAR(80) NOT NULL,
  runner_version VARCHAR(80),
  executor_type VARCHAR(40) NOT NULL CHECK (executor_type IN ('container', 'vm', 'host', 'remote_http', 'unknown')),
  verification_status VARCHAR(30) NOT NULL DEFAULT 'self-reported' CHECK (verification_status IN ('self-reported', 'owner-approved', 'isolation-tested', 'revoked')),
  workspace_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  credential_epoch INTEGER NOT NULL DEFAULT 1 CHECK (credential_epoch > 0),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_devices_owner_agent ON agent_devices(owner_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_devices_active ON agent_devices(agent_id, revoked_at);

CREATE TABLE IF NOT EXISTS agent_share_grants (
  grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES agent_devices(device_id) ON DELETE RESTRICT,
  grantee_kind VARCHAR(20) NOT NULL CHECK (grantee_kind IN ('user', 'guest')),
  grantee_id UUID NOT NULL,
  workspace_alias VARCHAR(120) NOT NULL,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  resources JSONB NOT NULL DEFAULT '[]'::jsonb,
  destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_share_grants_active_target
  ON agent_share_grants(agent_id, room_id, device_id, grantee_kind, grantee_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_share_grants_lookup
  ON agent_share_grants(grantee_kind, grantee_id, agent_id, room_id, status, expires_at);

CREATE TABLE IF NOT EXISTS shared_security_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  actor_kind VARCHAR(20) NOT NULL CHECK (actor_kind IN ('user', 'guest', 'agent', 'system')),
  actor_id UUID NOT NULL,
  device_id UUID REFERENCES agent_devices(device_id) ON DELETE SET NULL,
  grant_id UUID REFERENCES agent_share_grants(grant_id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shared_security_events_agent_created
  ON shared_security_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS shared_security_events_grant_created
  ON shared_security_events(grant_id, created_at DESC);
