-- Retain history while fencing queued guest work to its original share authority.
-- Legacy requests have unknown authority (0), never the current share revision.
ALTER TABLE shared_messages ADD COLUMN IF NOT EXISTS guest_share_revision INTEGER;
UPDATE shared_messages SET guest_share_revision=0
  WHERE sender_guest_id IS NOT NULL AND guest_share_revision IS NULL;
ALTER TABLE shared_messages DROP CONSTRAINT IF EXISTS shared_messages_guest_revision_check;
ALTER TABLE shared_messages ADD CONSTRAINT shared_messages_guest_revision_check CHECK (
  (sender_guest_id IS NULL AND guest_share_revision IS NULL) OR
  (sender_guest_id IS NOT NULL AND (guest_share_revision IS NULL OR guest_share_revision >= 0))
);
