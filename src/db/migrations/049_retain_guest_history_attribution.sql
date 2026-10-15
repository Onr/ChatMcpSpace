-- Guest revocation/removal is soft while conversation history is retained.
-- SET NULL would violate sender exclusivity and erase guest audit attribution.
-- Deferred NO ACTION permits an intentional full room/owner purge in one
-- transaction, without depending on the order of cascading deletes.
DO $$
BEGIN
  ALTER TABLE shared_messages DROP CONSTRAINT IF EXISTS shared_messages_sender_guest_id_fkey;
  ALTER TABLE shared_messages ADD CONSTRAINT shared_messages_sender_guest_id_fkey
    FOREIGN KEY(sender_guest_id) REFERENCES guest_principals(guest_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

  ALTER TABLE shared_audit DROP CONSTRAINT IF EXISTS shared_audit_actor_guest_id_fkey;
  ALTER TABLE shared_audit ADD CONSTRAINT shared_audit_actor_guest_id_fkey
    FOREIGN KEY(actor_guest_id) REFERENCES guest_principals(guest_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
END;
$$;
