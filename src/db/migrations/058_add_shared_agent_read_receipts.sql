-- Agent receipt is separate from participant reads and execution completion.
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS agent_read_at TIMESTAMPTZ;

-- Completed batches prove that the agent received their source messages.
-- A queued task cancelled before execution must never be marked as read.
UPDATE shared_messages SET agent_read_at=b.created_at
FROM shared_batches b
WHERE shared_messages.batch_id=b.id AND b.status='answered' AND shared_messages.sender_agent_id IS NULL
  AND shared_messages.agent_read_at IS NULL;

CREATE INDEX IF NOT EXISTS shared_messages_agent_receipts
  ON shared_messages(conversation_id,agent_read_at) WHERE agent_read_at IS NOT NULL;
