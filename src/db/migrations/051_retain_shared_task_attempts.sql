-- A reviewed retry is a new execution attempt. Never replace the task identity
-- referenced by an earlier batch, action, approval or external receipt.
ALTER TABLE shared_tasks DROP CONSTRAINT IF EXISTS shared_tasks_first_message_id_key;
CREATE INDEX IF NOT EXISTS shared_tasks_first_message ON shared_tasks(first_message_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS shared_tasks_one_active_attempt ON shared_tasks(first_message_id)
  WHERE state IN ('queued','running','waiting_for_approval','paused','cancellation_requested');
