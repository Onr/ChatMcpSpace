# Shared agent conversations

Share agents with people you trust. Shared requests use the same provider,
model and tool permissions as regular user messages, with the authenticated
sender and room included in the prompt. Private and shared work are serialized;
the supplied shared transcript contains only that room's history.

## What users see

Open the agent's regular conversation, unlock your encryption, and choose **Share**
in the header or the agent icon menu. Invite another registered account by email,
or create a guest link from the same sharing panel. Once shared, the people icon
and count open those controls.
The invitation defaults to **Collaborator**; choose **Manager** only when the
recipient needs the existing room-management controls.
The recipient accepts; an unlocked owner or manager provisions encrypted access.
Keep the inviter's page open until the pending-access state clears.

Human messages appear in the same conversation for its participants, including
the owner. Each message retains its authenticated sender. Agent replies can be
delivered to the owner only, the owner plus selected participants, or everyone.
Targeted files, questions and their answers follow that same audience. The agent can combine pending messages in its next
turn. Messages arriving after that turn starts wait for a later turn.

- Owners retain credentials, machine permissions and permanent agent deletion.
- Managers invite/remove non-owner members, moderate shared messages, select an
  owner-configured provider/model profile, and request a stop across the agent's
  conversations. Only the owner changes existing members' roles.
- Participants converse, attach files, answer eligible questions, delete their
  own messages and leave. Sharing lets them request work using the agent's
  existing capabilities; it does not modify those capabilities.
- A named question is answered only by that user. A group question resolves on
  its first accepted answer, visibly attributed to the answering user.

Provider/model changes affect the whole agent on the next turn. A stop request
is not proof that external tools terminated. Inspect the actual runtime before
acknowledging a stop or retrying uncertain execution.

## Server activation

1. Deploy this checkout using the existing startup migration runner. It applies
   the additive sharing migrations through `053_bind_shared_action_approvals.sql`.
2. Set both `FEATURE_SHARED_CONVERSATIONS=true` and `FEATURE_GUEST_SHARING=true`
   in the server environment and restart the application. The example environment
   enables trusted sharing; existing deployments must set their own flags.
3. Regenerate and restart each managed agent's `agent-runner.sh`. It discovers
   `/api/agent/sharing-status`, downloads the fixed public connector, and enrolls
   one scoped identity automatically. Node 22+ is required. Stop its old listener
   before replacing it; never run competing listeners for the same identity.
4. Open **Shared chats** to invite an account, or **Share with guests** to create a
   link. Unlock the owner's encryption and provision pending guest keys once the
   recipient joins. Trusted sharing needs no device or execution-grant setup.

Disable the flag to hide shared entry points and prevent new shared API work.
Data is retained. Disabling a flag does not cancel a tool already executing;
stop/inspect the runtime separately before changing listeners.

## Managed agent: preserve the existing runner's permissions

The regenerated managed runner starts trusted sharing automatically. It keeps
using the normal provider command and validates the owner's existing permissions
for every turn. Codex, Claude, Gemini, Antigravity and the other normal runner
providers retain their existing configuration. The dashboard's provider/model
choice applies on the next turn. Setting `CHATSPACE_TRUSTED_SHARING=0` opts a
not-yet-enrolled agent out of automatic startup.

Its scoped token, encryption key, runtime journal and profile live under the
owner-only `agent_state` directory. Back up that directory securely; sharing
identity recovery must not generate a new key over an existing identity.
The serialized listener handles private and shared inbox messages. Local
shell-only schedules/self-wake/update commands are not dispatched by this
connector; use the existing server scheduled-message flow or keep such an agent
on its original listener until it is deliberately migrated.

For an existing external or manually managed setup, the steps below remain
available. The CLI defaults to protocol 2 trusted mode for normal command/HTTP
profiles. Rootless Podman profiles retain explicit restricted mode and its gates.

From a checkout, enroll the existing identity using its local generated `.env`:

```bash
export CHATSPACE_BRIDGE_STATE="$HOME/.chatmcpspace/shared-agent.json"
(
  set -a
  source /absolute/project/.chatspace/your_agent/.env
  set +a
  node scripts/shared-agent-runner.js init-managed
)
```

Enrollment obtains a scoped token. The owner API key is not stored in the new
state file. The local account encryption key remains in that owner-only state
file, as with the existing external bridge; never paste it into chats or commit
it. Keep this file backed up securely.

Create an owner-controlled `shared-profiles.json` outside the repository. Each
profile is an explicit allowed provider/model choice, not an arbitrary shell
command supplied by an invited user:

```json
[
  {
    "provider": "claude",
    "model": "default",
    "managedRunner": true,
    "command": ["bash", "/absolute/project/.chatspace/your_agent/agent-runner.sh"],
    "cwd": "/absolute/project",
    "exportDir": "/absolute/project/.chatspace/shared-exports"
  }
]
```

Use the provider/model already authorized for that agent. Add more profiles only
when their provider permissions are already configured. The example does not
change those permissions or imply a particular provider is installed.

```bash
export CHATSPACE_SHARED_PROFILES=/absolute/path/shared-profiles.json
node scripts/shared-agent-runner.js
```

The replacement listener processes private and shared work serially, with
separate automatically supplied transcripts. Never start the old listener beside
it. Existing generated helper calls are not a shared-chat transport; use the new
shared API or the runtime's structured response for shared replies.

## Existing external agent

First pair using the [external bridge guide](EXTERNAL_AGENT_BRIDGE.md). Stop that
identity's old listener. Reuse its `CHATSPACE_BRIDGE_STATE` with the shared runner.

An HTTP profile uses an existing non-streaming Chat Completions-compatible agent:

```json
[
  {
    "provider": "hermes",
    "model": "hermes-agent",
    "url": "http://127.0.0.1:8642/v1",
    "apiKeyEnv": "EXTERNAL_AGENT_API_KEY",
    "isolatedConversations": true
  }
]
```

`isolatedConversations: true` is the operator's assertion that the endpoint uses
the supplied transcript without mixing persistent histories between callers. If
it needs an explicit session field, set `sessionField` to that adapter's documented
field name. The runner supplies a distinct agent/conversation/task identifier,
using the explicitly filtered transcript for each task. Do not
turn this on for an endpoint with one global persistent conversation.

Raster images are passed inline to HTTP runtimes; actual understanding depends on
the model. Other files are downloaded to private, conversation-specific local
paths. An external runtime needs access to those paths, including matching
container mounts, to inspect arbitrary files. Files are not silently uploaded to
unrelated model-provider storage. To publish an output file, configure an explicit
owner-controlled `exportDir`; the runner accepts only a regular direct child of that
directory and reads it through a no-follow file handle. Arbitrary model-provided
paths, symlinks, missing roots and files replaced during validation are rejected.
Limits: 20 MB per file, 10 retained files per sender, and 20 MB of inline images per
execution batch. Delete old attached messages to free the quota.

A standalone runner bundle is available at `/api/agent/shared-runner.js`; save and
inspect it before running. It includes the bridge and shared crypto modules and
requires no npm dependencies. Its CLI/environment match the checkout script.

## Agent response contract

The runner supplies authenticated sender IDs, names, message IDs, the conversation
ID, and only that conversation's recent retained transcript. Protocol-2 runtimes
also receive an immutable server context containing the typed requester, owner,
grant revision, approved workspace, connector and executor device. A protocol-2
claim contains one requester and one grant; it never combines an owner request
with another member's request. Return JSON:

```json
{
  "replies": [
    {
      "text": "Alice, your review is ready.",
      "toUserIds": ["participant-user-uuid"],
      "replyTo": ["incoming-message-uuid"],
      "kind": "message",
      "files": [{"path": "/absolute/report.txt", "name": "report.txt", "type": "text/plain"}]
    },
    {
      "text": "Which version should we use?",
      "kind": "question",
      "toUserIds": [],
      "options": ["Version A", "Version B"]
    }
  ]
}
```

Plain text output is accepted as one group reply. `toUserIds: []` means everyone.
Nonempty `toUserIds` or protocol-2 `toPrincipals` selects actual delivery recipients;
the server always includes the owner. An explicit `audience` overrides delivery:

```json
{"audience":{"mode":"owner"}}
{"audience":{"mode":"selected","principals":[{"kind":"guest","id":"guest-uuid"}]}}
{"audience":{"mode":"all"}}
```

Put the chosen `audience` inside each item of `replies`. Selected principals can
be active `user` or `guest` identities from the supplied participants. Invalid
recipients retain the result for review rather than broadcasting it. Historical
messages retain their previous visibility; this does not recall downloaded data
or introduce separate encryption keys per recipient.
Questions address one user or the whole group. The runner encrypts results before
sending them. Never include credentials in output.

Agent clients can also send addressed messages without a claimed batch through
`POST /api/agent/shared/:conversationId/messages`, using the same encrypted wire
format as batch completion. A stable message UUID makes delivery retryable. The
principal always comes from the authenticated agent, never from JSON sender fields.

## HTTP interface and encryption

User API base: `/api/user/shared` (session + CSRF). Agent API base:
`/api/agent/shared` (scoped identity). Shared API calls are disabled without the flag.

- User identity: `GET/PUT /identity`; rewrap an existing private key with
  `PUT /identity/private` while the old account key is still available.
- Conversations: `GET/POST /`; details at `GET /:room`; invitations at
  `POST /:room/invitations`, `POST /:room/accept` or `/decline`.
- Membership: `PATCH/DELETE /:room/members/:user`; key distribution through
  `POST /:room/keys` with the current membership and key versions.
- Messages: `GET/POST /:room/messages`; pagination uses `?after=<sequence>`;
  `DELETE /:room/messages/:message` creates a tombstone.
- Questions: `POST /:room/questions/:question/answer`; read cursor:
  `POST /:room/read`; files: `POST /:room/files`, `GET /:room/files/:file`.
- Management: `POST /:room/control` with `stop`, `profile`, `retry`, or `skip`;
  execution status at `GET /:room/batches`; audit at `GET /:room/audit`.
- Agent runtime: `POST /runtime`, `/claim`, `/acquire`, `/release`,
  `/batches/:batch/finish`, and `GET /batches/:batch` for saved-batch status.
  After decrypting the claimed sources, acknowledge their IDs with
  `POST /batches/:batch/read` and `{ "messageIds": ["source-uuid"] }`.
  This optional receipt turns their server-confirmed gray double checks blue
  before a reply. It does not finish or consume the execution. Continue the
  turn if saving a receipt fails; successful completion supplies a fallback.
  The registered `X-Shared-Runtime` identity must match.
- Protocol 2 runtime registration also supplies the owner-approved `deviceId` and
  advertises `protocol: 2`. Work without a current grant remains queued with an
  explicit unsupported-runtime task state; it is never sent to a legacy runner.
- Runtime adoption: the conversation owner can call
  `POST /:room/runtime/adopt` on the user API with
  `{ "confirmedStopped": true, "newRuntimeId": "<new-uuid>" }` after
  confirming that the old listener has stopped. This changes only the runtime
  identity and heartbeat. It preserves the execution latch and batch row;
  an in-flight execution is marked uncertain so it remains available for
  explicit Retry or Skip. Runtime profiles and the agent's existing permissions
  are unchanged. The old
  runtime identity is rejected immediately; register the new runtime with
  `POST /runtime` using the returned `runtimeId`.

A message envelope has `id`, `keyVersion`, `payload`, `addressedTo`, `replyTo`,
optional `fileIds` and `kind`. Payload `{v:1,iv,data}` uses AES-256-GCM, a fresh
12-byte IV, and additional authenticated data `conversationUUID:keyVersion`.
`data` includes the authentication tag. Conversation keys are RSA-OAEP/SHA-256
wrapped for each user and agent identity. Private identity keys are encrypted
locally under the existing account key. The server stores wrapped keys and
ciphertext, plus visible membership, routing, timing and management metadata.
This is not protection against a compromised serving application or trusted
endpoint. Agent-side tools retain their already-authorized machine access.

## Recovery, deletion and operational limits

- An uncertain run is never automatically replayed. Inspect the runtime, then
  use the shared chat's Retry or Skip control. A stale listener is also grounds
  for manual recovery only after confirming its old process has stopped. The
  owner may then adopt a replacement runtime with:

  ```http
  POST /api/user/shared/<conversation-id>/runtime/adopt
  Content-Type: application/json

  {"confirmedStopped":true,"newRuntimeId":"<new-runtime-uuid>"}
  ```

  The response reports the preserved `executionId` and marks any active shared
  batch uncertain because the old process may have completed external work. The
  replacement listener must use that UUID in `X-Shared-Runtime`; it still must
  resolve preserved uncertain work through explicit Retry or Skip.

  After the owner endpoint succeeds, run the replacement listener's local
  adoption command with the same UUID:

  ```bash
  CHATSPACE_BRIDGE_STATE=/absolute/path/shared-agent.json \
    node scripts/shared-agent-runner.js adopt-runtime <new-runtime-uuid>
  ```

  The command persists the new runtime identity only after registration
  succeeds; a failed registration keeps the old journal and identity intact.
- A saved successful response retries delivery without running the agent again.
  The runner journal and output are encrypted in its state file.
- For private work held by this listener, inspect the runtime, then run
  `node scripts/shared-agent-runner.js retry-private` or `skip-private` while the
  main listener is stopped. These commands resolve its private execution latch.
- Stop acknowledgement still uses `external-agent-bridge.js ack-stop` after the
  operator confirms the actual runtime stopped. Abort of an HTTP connection is
  not process termination.
- Removing a member immediately blocks server access and requires key rotation
  before new messages. It cannot erase downloaded copies or keys already known.
- New members get keys for retained shared history. Deleted messages/files are
  unavailable through these APIs; backups and already downloaded copies may exist.
- After losing an identity key, use **Recover shared encryption access**. Access
  pauses in each chat until another manager explicitly approves, then an unlocked
  member redistributes keys. A sole owner must restore their prior key from backup.
- Changing an account encryption key requires rewrapping the shared private key
  before losing the old key, or the recovery flow above afterward. There is no
  server-side plaintext fallback or automatic key reset.
- Local decrypted downloads are trusted endpoint data. Remove a conversation's
  downloaded directory when it is no longer needed; deleting a server message
  cannot erase files a runtime already used.

## Verification and rollout gate

Run focused/default coverage with `npm test`. For actual locking/rollback tests:

```bash
SHARED_TEST_DATABASE_URL=postgresql://USER@HOST:PORT/DISPOSABLE_DB \
  node node_modules/jest/bin/jest.js tests/integration/sharedConversations.test.js --runInBand
SHARED_TEST_DATABASE_URL=postgresql://USER@HOST:PORT/DISPOSABLE_DB \
  node tests/e2e/shared-conversations.js
```

Both integration commands create a unique schema and drop only that schema.
Browser tests require the installed Playwright Chromium browser. Screenshots are
saved under `tmp/shared-conversations/`. Browser tests exercise real local APIs,
crypto and PostgreSQL with simulated agent results; they are not proof of a live
Hermes or paid provider invocation. The managed adapter is also tested with a
stub CLI to check transcript handling and preservation of permission flags.

Run `bash scripts/verify-agent-sharing.sh` for the disposable PostgreSQL and
Chromium checks, including an attributed guest message through a real subprocess
and encrypted delivery to the guest/owner. The subprocesses are fixtures: each
installed provider still uses its normal credentials and permission configuration.
Trusted sharing does not claim container isolation or provider-side token caps.
Restricted mode keeps its separate provider/MCP conformance requirements.
