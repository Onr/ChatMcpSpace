-- Apply only after restoring code without migration 067. This permanently
-- removes agent-published status; owner briefs are not affected.
BEGIN;
DROP TABLE IF EXISTS agent_status;
DELETE FROM migrations WHERE migration_name='067_agent_status_board.sql';
COMMIT;
