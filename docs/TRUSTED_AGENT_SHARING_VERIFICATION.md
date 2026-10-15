# Trusted agent sharing — 2026-10-08

## Sharing UX update — 2026-10-09

Agent, provider and recipient pickers retain their option nodes, selection and
focus during background refreshes. A delayed response respects selections made
while it was in flight. Transient catalogue failures retain the picker and block
creation until recovery; removed agents and participants are still excluded.

Pressing an agent avatar in the list, orbit, dock or main chat header opens an
actions menu with **Share agent**. The sharing dialog offers a registered shared
chat or guest link, with the pressed agent preselected. Menus use their measured
size, stay within the viewport as details expand, and close using Escape. The
viewport menu sits outside the dashboard's animated main element. Owner and guest
screens use larger typography, consistent slate/emerald surfaces and mobile touch
targets. Guest rich forms keep their drafts and pause submission during key
refreshes, preventing intermittent stale-state submissions.

Verification: 47 focused UI tests passed; the broader Jest run passed 96 suites
and 1,463 tests (one suite and 30 tests skipped in that run). Disposable PostgreSQL
authorization/runtime checks passed 385 tests with two skipped. All three browser
drivers passed, including desktop/mobile icon sharing, dialog Escape, unchanged
picker DOM through a poll, registered invitations, and owner/two-guest chat flows.
The final registered/menu driver was rerun separately after the menu adjustments.
Temporary database services and owned browser caches were removed.

Repeat the UI and browser checks with `bash scripts/verify-agent-sharing.sh --ui`.
Run without `--ui` to include authorization/runtime suites. Browser provider
subprocesses are fixtures; these checks do not invoke a billed provider.

The running service was restarted successfully. Public HTTPS checks confirmed
both sharing flags enabled in trusted mode, the updated guest template returning
200, and the live menu/chat assets matching the checkout byte for byte.

Sharing is enabled in the running application at https://chatmcp.space. Both
`FEATURE_SHARED_CONVERSATIONS` and `FEATURE_GUEST_SHARING` are true. The public
`/api/agent/sharing-status` endpoint reports both enabled and execution mode
`trusted`; the HTTPS guest page returns 200. The supervised
`agent-messaging-platform.service` was restarted successfully with this checkout.

The owner explicitly chose trusted collaborators using the same command path as
regular agent messages, with authenticated sender details added. This replaces
the earlier requirement to block sharing on native provider sandbox/MCP gates.
Restricted execution remains separately available and is never silently converted
to trusted execution while a task is unfinished.

Trusted shared turns use the owner's existing executable, provider/model and
permission validation. They include sender kind, ID, display name, room identity
and that room's supplied history. Server checks still enforce membership, guest
allowlists, expiry, share revisions, revocation, encryption and current runtime
identity before claim and publication. Revoked results are held rather than
published. The normal provider's tools are available to trusted collaborators;
this mode does not claim container isolation, per-action grants or provider token
caps. Cancellation requests stop dispatch and attempt to stop the provider process;
uncertain outcomes require inspection before retry, rather than automatic replay.

Managed startup discovers the enabled feature and replaces its old listener with
one serialized private/shared listener. The dashboard's chosen provider/model and
permission settings are passed to the existing single-turn runner. An unavailable
selected provider fails instead of switching to another one. Shared configuration
errors cannot send a fallback into the private chat. Idle polling follows server
advice and Retry-After; provider turns keep their working heartbeat.

The local `AgentsMCPspace` agent was migrated after confirming no queued user
messages, question responses or direct messages, and no active provider process.
Its old listener exited before the new one started. Its prior stopped state was
acknowledged through the existing API after that verification. Its existing
provider/model and permissions were preserved. The original generated script is
backed up in `agent_state/backups/agent-runner.before-trusted-sharing-20261008.sh`.
The new listener is running in the existing dedicated tmux session, with a fresh
trusted runtime heartbeat, no unfinished/uncertain execution and owner-only mode
600 connector state. The authenticated private inbox remains available. A live
polling check exposed the earlier duplicate-heartbeat rate pressure; after the
fix and the prior counter's cooldown, subsequent inbox polls returned 200.
No AI inference was requested for this migration or these live checks.

| Check | Result |
| --- | --- |
| `bash scripts/verify-agent-sharing.sh` | 9 suites passed; 385 passed, 2 skipped; all 3 Chromium drivers passed |
| Full regression with disposable PostgreSQL and Redis | 96 suites passed; 1,479 passed, 2 skipped |
| Final managed runner/configuration/API checks | 3 suites passed; 229 passed |
| Final runner/bridge checks after polling fix | 2 suites passed; 103 passed |
| Live HTTPS service | Sharing flags active, guest page 200, trusted runtime connected |

The browser flow sends a real guest message through a real local subprocess,
publishes its encrypted reply through the application service, and displays it to
the guest and owner while excluding the other guest's separate room. It also
checks guest/account onboarding, keys surviving refresh, revocation, file/photo
transfer, questions/forms, sanitization, mobile layouts and preserved drafts.
Subprocess provider fixtures cover Codex, Claude, Gemini, Antigravity and custom
profiles with the selected model. These are transport/configuration checks, not
live compatibility certifications for every installed provider. The two skipped
checks require an actual restricted output-store mount; they do not gate trusted
sharing. Temporary test services and browser caches were removed.

To use sharing, open **Shared chats** and unlock the owner's encryption. Choose
the connected agent and invite a registered friend, or use **Share with guests**
to create a link for selected agents. After a guest joins, use **Provision pending
keys** once; keep the owner page unlocked during onboarding. Send a short message
from the recipient's browser and confirm its name and the agent reply appear in
the intended room. Remove the guest or revoke the share to verify access ends.

Other existing managed agents need their generated `agent-runner.sh` updated and
restarted once to enroll; newly generated runners discover sharing automatically.
External command/HTTP runtimes use their existing owner-controlled profiles as
described in [SHARED_CONVERSATIONS.md](SHARED_CONVERSATIONS.md). Local shell-only
schedules/self-wake/update dispatch remain a separate managed-listener capability;
the sharing connector handles inbox work and server-delivered scheduled messages.
