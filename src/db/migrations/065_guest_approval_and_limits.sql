-- Guests who open a link wait until the owner approves them. Guests who were
-- already admitted keep access.
ALTER TABLE shared_guest_members
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
UPDATE shared_guest_members SET approved_at=COALESCE(activated_at,NOW())
  WHERE status='active' AND approved_at IS NULL;

-- Optional per-guest message allowance for a guest link (validated by guestService).
ALTER TABLE guest_shares
  ADD COLUMN IF NOT EXISTS max_messages INTEGER;
