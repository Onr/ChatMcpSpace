# Agent identity and proactive work: implementation and rollback

## User flow

1. Open an agent from chat header, agent menu, list, Council Chamber, multi-chat, or Settings → Agents. All controls open the same four-tab drawer. A newly connected agent also offers an optional **Describe agent** prompt that can be dismissed.
2. Enter a website display name and emoji avatar, role, purpose, boundaries, and one or more goals. Select one active goal and describe what would count as finished. The connection name used for routing stays stable; provider, tools, memory, and existing permissions remain separate.
3. Review **What the agent sees**, then save. Saves are explicit and numbered. A message already being processed keeps its old brief. By default, unread and future scheduled messages keep the revision captured when queued. The save flow asks before changing those snapshots.
4. Use History to inspect changes and restore a prior revision. A restore creates a new revision and pauses automatic work.
5. An agent can suggest edits to role, purpose, preferences, and goal details. The owner sees a proposed comparison and must accept it. The agent cannot alter boundaries, visibility, permissions, or automatic-work limits.
6. A supported local runner advertises wake support when it polls. Its version report must be from the last 10 minutes. Only then can the owner enable a bounded policy for an active goal. The initial allowance is four runs, at least 30 minutes apart, expiring after 24 hours unless the owner changes it. **Check once** expires after five minutes if the runner is offline. **Pause future** blocks new claims; **Stop now** also sends the existing process stop request after the pause is saved.
7. The runner requests admission only when no user message is waiting. The server reserves a run before invocation. The agent reports progress, no progress, a blocker, a user decision, a result ready for review, or sleep. Two no-progress outcomes sleep. Missing confirmation is recorded as unknown and never replayed automatically.
8. Automatic work can serve only the active goal. Switching the active goal or marking the policy goal ready, blocked, done, or archived turns off the draft policy before save. Re-enable it deliberately for the new active goal. The server rejects a mismatched policy even if a client bypasses the editor.

## Supported scope

- Automatic wake-ups require the generated local runner from CLI 1.5.27 or later. MCP apps, the external bridge, Windows native runner, and older local runners do not advertise this capability. The UI explains that automatic work is unavailable for them.
- Existing agents begin with proactivity off and no invented goals. The new local runner retains legacy `.scheduled_tasks.json` and `.self_wakeup.txt` files for rollback but does not execute them. User-scheduled chat messages remain supported as separate explicit messages.
- An owner edits everything. An active shared-conversation manager can edit goals and pause an existing policy; a participant can read a redacted brief. Fields hidden from collaborators are excluded from their brief reads and revision history, and activity reasons are withheld from collaborators. Shared collaborators cannot enable or renew automatic work. Those fields still reach the agent, and this feature cannot prevent an agent from mentioning them in a reply; do not put secrets in the brief.
- `ⓘ` shows a revision only when the runner reported one. Older messages show **Not recorded**. The native local helper and external bridge now report revision metadata for new replies.
- Brief text is stored in the application database as JSONB and sent to the agent as context. It must not contain secrets. Existing end-to-end chat encryption does not encrypt these new brief fields at rest.
- Stage 4 items from the plan remain outside this release: event-triggered wake-ups, proactive work in MCP/shared/Windows adapters, parent-child allowance accounting, objective completion rules, per-run token accounting, and encrypted-at-rest brief storage. Delegated agents cannot enable automatic work until parent allowance accounting exists. The generated local runner supports periodic checks and Check once only.

## Operations and verification

- Apply migration `063_agent_identity_and_proactivity.sql` before serving the updated routes. The migration is additive and leaves existing messages intact.
- For an immediate automatic-work stop, set `FEATURE_AGENT_PROACTIVE=false` and restart the server. The claim endpoint then admits no new runs, including Check once. Existing in-flight runs should still be stopped through the UI if needed. **Stop now** uses the existing agent-process stop endpoint; a local agent may need restarting before it receives normal messages again.
- Verify an owner can save/restore, a manager cannot change identity or limits, a participant cannot edit, two queued messages retain different revisions, and a supported local runner can claim one turn while an unsupported connection cannot.
- The new runner relies on the backend for automatic claims. Keep the previous 1.5.26 runner and website release artifact available until the new version has been verified on a test agent.

## Full rollback

1. Set `FEATURE_AGENT_PROACTIVE=false` and restart the server to stop new automatic admissions. Pause active policies in Settings and stop any currently running automatic turns.
2. Back up the database with the project's existing backup process and retain the exact previous website and CLI release artifacts. Export the identity tables before dropping them if identity data must survive: `agent_briefs`, `agent_brief_revisions`, `agent_brief_suggestions`, `agent_brief_activity`, and `agent_brief_wakes`.
3. Restore the previous website source and generated CLI 1.5.26 files. Restart the service and verify normal user and agent messaging. Because migration 063 is additive, the old code can run with its tables still present; this is the preferred reversible rollback.
4. Only if schema removal is required, run `src/db/rollback/063_agent_identity_and_proactivity.sql` **after** the old code is live and the backup has been checked. This step destroys all brief history and metadata. Do not run the current migration runner afterward, because it would reapply migration 063.

This feature is implemented in the workspace but has not been deployed by this document.
