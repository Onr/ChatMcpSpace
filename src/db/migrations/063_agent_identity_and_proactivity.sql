-- Versioned, owner-controlled agent briefs. Existing agents have no goal and
-- automatic work remains off until an owner explicitly configures it.
CREATE TABLE IF NOT EXISTS agent_briefs (
  agent_id UUID PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  document JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL DEFAULT '{"enabled":false}'::jsonb,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_brief_revisions (
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  document JSONB NOT NULL,
  policy JSONB NOT NULL,
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('owner', 'collaborator', 'restore')),
  changed_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (agent_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_brief_suggestions (
  suggestion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL,
  proposed_document JSONB NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_brief_suggestions_pending
  ON agent_brief_suggestions(agent_id, created_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS agent_brief_activity (
  activity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_brief_activity_recent
  ON agent_brief_activity(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_brief_wakes (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  brief_revision INTEGER NOT NULL,
  trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('periodic', 'check_once')),
  status VARCHAR(20) NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'completed', 'unknown', 'cancelled')),
  policy_snapshot JSONB NOT NULL,
  outcome VARCHAR(30),
  reason VARCHAR(500),
  admitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_expires_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_brief_wakes_recent ON agent_brief_wakes(agent_id, admitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_brief_wakes_one_admitted ON agent_brief_wakes(agent_id) WHERE status = 'admitted';

ALTER TABLE user_messages ADD COLUMN IF NOT EXISTS brief_snapshot JSONB;
ALTER TABLE scheduled_user_messages ADD COLUMN IF NOT EXISTS brief_snapshot JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS brief_provenance JSONB;
