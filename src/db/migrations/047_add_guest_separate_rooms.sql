-- Separate guest shares need one conversation per guest and selected agent.
-- Common-mode shares continue to use guest_share_agents.room_id.
CREATE TABLE IF NOT EXISTS guest_share_rooms (
  share_id UUID NOT NULL REFERENCES guest_shares(share_id) ON DELETE CASCADE,
  guest_id UUID NOT NULL REFERENCES guest_principals(guest_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (share_id, guest_id, agent_id),
  UNIQUE (room_id)
);

CREATE INDEX IF NOT EXISTS guest_share_rooms_lookup
  ON guest_share_rooms(share_id, guest_id, agent_id);
