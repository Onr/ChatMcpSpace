-- Migration: 033_chief_of_staff_all_provider_permissions.sql
-- Description: Local Chief of Staff agents were originally installed with
-- only claude/codex in allowed_permissions. Add every supported local provider
-- so existing CoS instances show the same provider choices as newly-installed
-- agents. Existing explicit provider settings win if already present.

UPDATE agents
SET allowed_permissions = '{
  "inter_agent": { "enabled": true, "mode": "listen_all", "groups": [] },
  "claude": {
    "--permission-mode": ["default", "acceptEdits", "plan", "bypassPermissions"],
    "--dangerously-skip-permissions": true
  },
  "codex": {
    "--sandbox": ["workspace-write", "danger-full-access"],
    "--dangerously-bypass-approvals-and-sandbox": true
  },
  "gemini": {
    "--sandbox": true,
    "--no-sandbox": true,
    "--yolo": true
  },
  "copilot": {
    "--allow-all": true,
    "--allow-all-tools": true,
    "--allow-all-paths": true
  },
  "antigravity": {
    "--sandbox": ["workspace-write", "danger-full-access"],
    "--dangerously-skip-permissions": true
  },
  "pi": { "enabled": true },
  "kilo": { "--auto": true },
  "ollama": {
    "--sandbox": ["workspace-write", "danger-full-access"],
    "--dangerously-bypass-approvals-and-sandbox": true
  },
  "openrouter": {
    "--sandbox": ["workspace-write", "danger-full-access"],
    "--dangerously-bypass-approvals-and-sandbox": true
  },
  "lmstudio": {
    "--sandbox": ["workspace-write", "danger-full-access"],
    "--dangerously-bypass-approvals-and-sandbox": true
  }
}'::jsonb || COALESCE(allowed_permissions, '{}'::jsonb)
WHERE is_chief_of_staff = TRUE;
