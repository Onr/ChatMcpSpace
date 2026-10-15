-- Additive task provenance and protocol-2 execution context.
ALTER TABLE shared_runtimes
  ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES agent_devices(device_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS shared_tasks (
  task_id UUID PRIMARY KEY,
  first_message_id UUID NOT NULL UNIQUE REFERENCES shared_messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  requester_kind VARCHAR(20) NOT NULL CHECK (requester_kind IN ('user', 'guest')),
  requester_id UUID NOT NULL,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  grant_id UUID REFERENCES agent_share_grants(grant_id) ON DELETE SET NULL,
  grant_revision INTEGER,
  grant_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  execution_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_authorization JSONB NOT NULL DEFAULT '{}'::jsonb,
  state VARCHAR(30) NOT NULL CHECK (state IN ('queued', 'running', 'waiting_for_approval', 'paused', 'cancellation_requested', 'cancellation_confirmed', 'completed', 'failed', 'outcome_uncertain', 'unsupported_runtime')),
  device_id UUID REFERENCES agent_devices(device_id) ON DELETE SET NULL,
  connector_id UUID,
  device_epoch INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shared_tasks_conversation_state ON shared_tasks(conversation_id, state, created_at);
CREATE INDEX IF NOT EXISTS shared_tasks_requester ON shared_tasks(requester_kind, requester_id, created_at);

ALTER TABLE shared_batches
  ADD COLUMN IF NOT EXISTS task_id UUID UNIQUE REFERENCES shared_tasks(task_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS shared_task_actions (
  action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES shared_tasks(task_id) ON DELETE CASCADE,
  action_digest VARCHAR(128) NOT NULL,
  action_name VARCHAR(120) NOT NULL,
  resource VARCHAR(120),
  destination VARCHAR(120),
  grant_revision INTEGER,
  device_epoch INTEGER,
  approval_state VARCHAR(30) NOT NULL DEFAULT 'not_required' CHECK (approval_state IN ('not_required', 'pending', 'approved', 'denied', 'expired', 'revoked')),
  outcome VARCHAR(30),
  external_receipt JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shared_task_actions_task ON shared_task_actions(task_id, created_at);
