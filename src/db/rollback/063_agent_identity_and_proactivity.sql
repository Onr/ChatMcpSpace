-- Apply only after restoring code without migration 063 and taking a database
-- backup. This permanently removes identity, goal, policy, and activity data.
BEGIN;
ALTER TABLE messages DROP COLUMN IF EXISTS brief_provenance;
ALTER TABLE scheduled_user_messages DROP COLUMN IF EXISTS brief_snapshot;
ALTER TABLE user_messages DROP COLUMN IF EXISTS brief_snapshot;
DROP TABLE IF EXISTS agent_brief_wakes;
DROP TABLE IF EXISTS agent_brief_activity;
DROP TABLE IF EXISTS agent_brief_suggestions;
DROP TABLE IF EXISTS agent_brief_revisions;
DROP TABLE IF EXISTS agent_briefs;
DELETE FROM migrations WHERE migration_name='063_agent_identity_and_proactivity.sql';
COMMIT;
