-- Empty recipients preserve existing group messages. Agent deliveries with
-- selected recipients include the owner, enforced by the message service.
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS recipient_principals JSONB NOT NULL DEFAULT '[]'::jsonb;
