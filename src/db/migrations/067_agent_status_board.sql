-- Agent-published working status. This is deliberately separate from the
-- owner-controlled agent_briefs document: agents may replace these fields at
-- any time, and clearing a row never touches an owner's identity or goals.
CREATE TABLE IF NOT EXISTS agent_status (
  agent_id UUID PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  state VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK (state IN ('available', 'busy', 'blocked', 'away')),
  working_on VARCHAR(300) NOT NULL DEFAULT '',
  goal VARCHAR(300) NOT NULL DEFAULT '',
  responsibilities VARCHAR(600) NOT NULL DEFAULT '',
  blocker VARCHAR(300) NOT NULL DEFAULT '',
  needs VARCHAR(300) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
