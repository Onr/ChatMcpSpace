-- Keep existing shared conversations available until their owner pauses access.
ALTER TABLE shared_conversations
  ADD COLUMN IF NOT EXISTS sharing_enabled BOOLEAN NOT NULL DEFAULT TRUE;
