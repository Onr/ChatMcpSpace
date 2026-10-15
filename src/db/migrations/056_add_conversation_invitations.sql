-- Durable, account-bound admission separate from shared_membership state.
CREATE TABLE IF NOT EXISTS conversation_invitations (
  invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  recipient_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  request_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','declined','revoked','expired')),
  delivery_state TEXT NOT NULL DEFAULT 'in_app_only' CHECK (delivery_state IN ('in_app_only','queued','sent','failed','not_available')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, request_id)
);
CREATE INDEX IF NOT EXISTS conversation_invitations_recipient
  ON conversation_invitations(recipient_email, state, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_invitations_room
  ON conversation_invitations(conversation_id, state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_invitations_pending_recipient
  ON conversation_invitations(conversation_id, recipient_email) WHERE state='pending';
