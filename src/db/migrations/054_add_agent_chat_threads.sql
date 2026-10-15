-- Stable identity for the ordinary chat attached to an agent. Shared rooms
-- created by the legacy sharing flow remain independent until explicitly bound.
CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_pair ON agents(agent_id, user_id);
CREATE TABLE IF NOT EXISTS agent_chat_threads (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  state TEXT NOT NULL DEFAULT 'private' CHECK (state IN ('private', 'preparing', 'shared')),
  preparation_revision INTEGER NOT NULL DEFAULT 0 CHECK (preparation_revision >= 0),
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (agent_id, owner_id) REFERENCES agents(agent_id, user_id) ON DELETE CASCADE,
  UNIQUE (conversation_id, agent_id, owner_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_chat_threads_primary_agent
  ON agent_chat_threads(agent_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS agent_chat_threads_owner_state
  ON agent_chat_threads(owner_id, state);

-- Imported rows are historical display data and must never enter request claims.
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS import_id UUID;
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS dispatch_eligible BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS shared_messages_dispatch_queue
  ON shared_messages(conversation_id, seq) WHERE dispatch_eligible AND deleted_at IS NULL;
