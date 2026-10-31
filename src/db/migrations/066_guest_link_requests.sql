-- A guest link either lets people join straight into the owner's approval
-- queue ('join') or first asks them to send the owner a request ('request').
ALTER TABLE guest_shares
  ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'join' CHECK (access_mode IN ('join','request'));

-- Optional note a guest sends with a request.
ALTER TABLE guest_principals
  ADD COLUMN IF NOT EXISTS request_note TEXT;

-- Signed-in people can ask through a guest link with their account. Approval
-- adds them as a pending member; the owner's browser then provisions keys.
-- guestService keeps at most one pending request per person and conversation.
CREATE TABLE IF NOT EXISTS guest_share_account_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  note TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS guest_share_account_requests_room_user
  ON guest_share_account_requests(conversation_id,user_id);
CREATE INDEX IF NOT EXISTS guest_share_account_requests_share
  ON guest_share_account_requests(share_id);
