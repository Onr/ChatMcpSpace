-- Additive; private conversations and existing agent permissions are untouched.
CREATE TABLE IF NOT EXISTS shared_identities (
  principal TEXT PRIMARY KEY,
  public_key JSONB NOT NULL,
  private_key JSONB,
  display_name VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shared_runtimes (
  agent_id UUID PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  runtime_id UUID NOT NULL,
  capabilities JSONB NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_id UUID,
  execution_kind TEXT,
  execution_started_at TIMESTAMPTZ,
  execution_uncertain BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS shared_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  membership_version INTEGER NOT NULL DEFAULT 1,
  rotation_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shared_members (
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','participant')),
  status TEXT NOT NULL CHECK (status IN ('invited','pending','active','recovering','removed')),
  invited_by UUID NOT NULL REFERENCES users(user_id),
  expires_at TIMESTAMPTZ,
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS shared_key_envelopes (
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  principal TEXT NOT NULL REFERENCES shared_identities(principal),
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY(conversation_id,key_version,principal)
);
CREATE TABLE IF NOT EXISTS shared_batches (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('processing','answered','uncertain','retry','skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS shared_messages (
  id UUID PRIMARY KEY,
  seq BIGSERIAL UNIQUE NOT NULL,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES users(user_id),
  sender_agent_id UUID REFERENCES agents(agent_id),
  kind TEXT NOT NULL CHECK (kind IN ('message','question','answer')),
  payload JSONB,
  key_version INTEGER NOT NULL,
  addressed_to UUID[] NOT NULL DEFAULT '{}',
  reply_to UUID[] NOT NULL DEFAULT '{}',
  question_id UUID REFERENCES shared_messages(id),
  batch_id UUID REFERENCES shared_batches(id),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((sender_user_id IS NULL) <> (sender_agent_id IS NULL)),
  UNIQUE(question_id)
);
CREATE INDEX IF NOT EXISTS shared_messages_timeline ON shared_messages(conversation_id,seq);
CREATE TABLE IF NOT EXISTS shared_files (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  uploader TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  bytes BYTEA NOT NULL,
  message_id UUID REFERENCES shared_messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shared_audit (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(user_id),
  action TEXT NOT NULL,
  subject_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
