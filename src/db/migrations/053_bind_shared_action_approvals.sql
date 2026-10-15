-- An approval authorizes one exact operation on one original execution attempt.
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS action_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS grant_id UUID REFERENCES agent_share_grants(grant_id) ON DELETE SET NULL;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE shared_task_actions ADD COLUMN IF NOT EXISTS execution_nonce UUID;
ALTER TABLE shared_tasks ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
ALTER TABLE shared_tasks ADD COLUMN IF NOT EXISTS cancellation_confirmed_at TIMESTAMPTZ;
ALTER TABLE shared_tasks ADD COLUMN IF NOT EXISTS held_result JSONB;
ALTER TABLE shared_tasks ADD COLUMN IF NOT EXISTS result_held_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS shared_task_actions_pending_approval ON shared_task_actions(approval_state, expires_at);
