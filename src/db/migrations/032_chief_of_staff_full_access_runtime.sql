-- Migration: 032_chief_of_staff_full_access_runtime.sql
-- Description: Existing Local Chief of Staff agents were created with
-- sandbox_mode=workspace-write, which can route Codex-backed providers through
-- bubblewrap on machines where bwrap cannot create loopback networking. CoS is
-- explicitly a privileged local agent, so keep its persisted runtime config in
-- full-access mode.

UPDATE agents
SET runtime_config = jsonb_set(
  jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{approval_mode}',
    '"full-auto"'::jsonb,
    true
  ),
  '{sandbox_mode}',
  '"none"'::jsonb,
  true
)
WHERE is_chief_of_staff = TRUE;
