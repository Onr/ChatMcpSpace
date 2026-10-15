-- Additive guest principals, share mappings and typed shared-message attribution.
CREATE TABLE IF NOT EXISTS guest_shares (
  share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  password_hash VARCHAR(255),
  password_revision INTEGER NOT NULL DEFAULT 1 CHECK (password_revision > 0),
  room_mode VARCHAR(20) NOT NULL DEFAULT 'separate' CHECK (room_mode IN ('separate', 'common')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guest_shares_owner_active ON guest_shares(owner_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS guest_share_agents (
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  room_id UUID REFERENCES shared_conversations(id) ON DELETE CASCADE,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY(share_id, agent_id),
  UNIQUE(share_id, room_id)
);
CREATE INDEX IF NOT EXISTS guest_share_agents_lookup ON guest_share_agents(share_id, agent_id, removed_at);

CREATE TABLE IF NOT EXISTS guest_principals (
  guest_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  display_name VARCHAR(80) NOT NULL,
  public_key JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(share_id, guest_id)
);
CREATE INDEX IF NOT EXISTS guest_principals_share_status ON guest_principals(share_id, status);

CREATE TABLE IF NOT EXISTS guest_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guest_principals(guest_id) ON DELETE CASCADE,
  session_token_hash VARCHAR(128) NOT NULL UNIQUE,
  share_revision INTEGER NOT NULL,
  password_revision INTEGER NOT NULL,
  csrf_secret_hash VARCHAR(128),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (share_id, guest_id) REFERENCES guest_principals(share_id, guest_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guest_sessions_active ON guest_sessions(session_id, share_id, guest_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS shared_guest_members (
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guest_principals(guest_id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'participant' CHECK (role = 'participant'),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed')),
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  PRIMARY KEY(conversation_id, guest_id),
  UNIQUE(share_id, guest_id, conversation_id),
  FOREIGN KEY (share_id, guest_id) REFERENCES guest_principals(share_id, guest_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS shared_guest_members_lookup ON shared_guest_members(share_id, guest_id, status);

ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS sender_guest_id UUID REFERENCES guest_principals(guest_id) ON DELETE SET NULL;
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS addressed_to_principals JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shared_messages DROP CONSTRAINT IF EXISTS shared_messages_check;
ALTER TABLE shared_messages DROP CONSTRAINT IF EXISTS shared_messages_constraint_2;
ALTER TABLE shared_messages DROP CONSTRAINT IF EXISTS shared_messages_sender_check;
ALTER TABLE shared_messages ADD CONSTRAINT shared_messages_sender_check CHECK (
  (CASE WHEN sender_user_id IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN sender_guest_id IS NOT NULL THEN 1 ELSE 0 END) +
  (CASE WHEN sender_agent_id IS NOT NULL THEN 1 ELSE 0 END) = 1
);
CREATE INDEX IF NOT EXISTS shared_messages_guest_sender ON shared_messages(sender_guest_id, conversation_id, seq);

ALTER TABLE shared_audit ADD COLUMN IF NOT EXISTS actor_kind VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'guest', 'agent', 'system'));
ALTER TABLE shared_audit ADD COLUMN IF NOT EXISTS actor_guest_id UUID REFERENCES guest_principals(guest_id) ON DELETE SET NULL;
ALTER TABLE shared_audit ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE shared_audit DROP CONSTRAINT IF EXISTS shared_audit_actor_id_fkey;
CREATE INDEX IF NOT EXISTS shared_audit_guest_actor ON shared_audit(actor_guest_id, created_at);
