-- Resumable, auditable conversion of an owner's private timeline into the
-- canonical shared timeline. Imported messages are never dispatch candidates.
CREATE TABLE IF NOT EXISTS shared_history_imports (
  import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  source_boundary TIMESTAMPTZ NOT NULL,
  source_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'importing' CHECK (state IN ('importing','ready','activated','aborted','stale')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  expected_items INTEGER NOT NULL DEFAULT 0 CHECK (expected_items >= 0),
  imported_items INTEGER NOT NULL DEFAULT 0 CHECK (imported_items >= 0),
  expected_files INTEGER NOT NULL DEFAULT 0 CHECK (expected_files >= 0),
  imported_files INTEGER NOT NULL DEFAULT 0 CHECK (imported_files >= 0),
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  UNIQUE (conversation_id, owner_id, revision)
);
CREATE TABLE IF NOT EXISTS shared_history_import_files (
  import_id UUID NOT NULL REFERENCES shared_history_imports(import_id) ON DELETE CASCADE,
  source_attachment_id UUID NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  target_file_id UUID NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
  encrypted_fingerprint TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (import_id, source_attachment_id),
  UNIQUE (target_file_id)
);
ALTER TABLE shared_messages
  ADD COLUMN IF NOT EXISTS agent_context_eligible BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS shared_history_imports_request
  ON shared_history_imports(owner_id, request_id);
CREATE INDEX IF NOT EXISTS shared_history_imports_owner_state
  ON shared_history_imports(owner_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS shared_history_import_items (
  import_id UUID NOT NULL REFERENCES shared_history_imports(import_id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message','user_message')),
  source_id UUID NOT NULL,
  source_fingerprint TEXT NOT NULL,
  target_message_id UUID NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (import_id, source_kind, source_id),
  UNIQUE (target_message_id)
);
