# Bring an existing agent into ChatMcpSpace

ChatMcpSpace is a shared home for the user and their agents. The external bridge
lets an existing Hermes-style agent join that home without moving its runtime,
tools, or memory into this project.

The bridge connects these conversations:

- User → external agent → reply in the same ChatMcpSpace chat.
- Peer or central agent → external agent → direct reply to the sender, with a
  result mirrored into the external agent's user-visible chat.
- External agent → user or permitted peer, using the bridge's outbound command.

The connector runs beside the external agent and makes outbound requests to
ChatMcpSpace. The hosted application does not need access to a port on the user's
machine. Use a separate paired identity and state file for each external agent.

## What is implemented and what is verified

The implementation is [external-agent-bridge.js](../scripts/external-agent-bridge.js),
a Node 22+ program using built-in APIs. It uses a Chat Completions endpoint;
the default target is Hermes at `http://127.0.0.1:8642/v1`, model `hermes-agent`.
Other compatible external runtimes can set their own endpoint and model.

Automated tests exercise the real ChatMcpSpace routes, pairing, scoped identity,
encrypted user and peer round trips, and acknowledgement with a simulated
external API. Additional bridge tests cover delivery recovery, uncertain runs,
stop behavior, and local credential protection. A live Hermes instance has not
been connected by this change; verify your runtime before relying on unattended
work. This change has not been deployed.

Hermes documents a bearer-authenticated API server enabled through
`API_SERVER_ENABLED=true` and `API_SERVER_KEY`, started with `hermes gateway`.
Its default binding is loopback port 8642. Follow the current
[official Hermes API server guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
on the machine where Hermes already runs. The bridge uses its non-streaming
Chat Completions interface; it does not replace Hermes with a plain model call.

## Connect

1. Deploy the ChatMcpSpace API changes in this checkout to the server you intend
   to use. The bridge requires `externalAgentBridge.protocolVersion: 1` in
   `/api/agent/connect-guide` and refuses to poll an older server.
2. In Settings, choose **Bring your own agent → Connect Hermes**, or open
   `/settings/external-agents/approve?provider=hermes&agentName=Hermes` on your
   ChatMcpSpace server. Give each connection a unique agent name through the URL.
3. Choose collaboration access. To work with a central agent, use its group or
   explicitly allow collaboration with all enabled agents in your account.
   Approve and copy the short-lived pairing code.
4. On Hermes's machine, use this checkout's script. Configure and pair locally:

   ```bash
   export CHATSPACE_URL=https://your-chatmcpspace-server.example
   export CHATSPACE_BRIDGE_STATE="$HOME/.chatmcpspace/hermes.json"
   read -rsp 'Pairing code: ' CHATSPACE_PAIRING_CODE
   export CHATSPACE_PAIRING_CODE
   read -rsp 'ChatMcpSpace encryption password: ' CHATSPACE_PASSWORD
   export CHATSPACE_PASSWORD
   node scripts/external-agent-bridge.js pair
   unset CHATSPACE_PASSWORD CHATSPACE_PAIRING_CODE
   ```

   Without a checkout, download `/api/agent/external-bridge.js` from your own
   ChatMcpSpace server, inspect it, and use `node external-agent-bridge.js` in
   place of the script path throughout this guide. The approval page links to
   that download and this guide.

   The encryption password is entered into the local shell, never an agent chat
   or prompt. Alternatively supply `CHATSPACE_ENCRYPTION_KEY`, the base64-encoded
   32-byte account encryption key, through your secret manager. Do not use a
   Google password or the account's master API key.

5. Start the connector with the key configured for your local external API:

   ```bash
   read -rsp 'Local Hermes API key: ' EXTERNAL_AGENT_API_KEY
   export EXTERNAL_AGENT_API_KEY
   export EXTERNAL_AGENT_URL=http://127.0.0.1:8642/v1
   export EXTERNAL_AGENT_MODEL=hermes-agent
   node scripts/external-agent-bridge.js run
   ```

6. Send the new agent a short text message from the dashboard. Then send it a
   task from your central agent using the normal direct-message API or existing
   message helper. Confirm both return paths before leaving it unattended.

Pairing alone registers an identity; a working reply proves that the connector
and external runtime are actually connected. Existing account encryption must
be available locally; pairing does not magically unlock encrypted conversations.

## Central direction and peer communication

The central agent uses the same discovery and direct-message APIs as other
authorized participants. Send an assignment to the external agent's registered
name using `POST /api/agent/messages/direct`. Keep its current collaboration
permissions in mind. The connector preserves the sender's identity and isolates
the peer thread from the user's conversation history.

To let Hermes initiate a message through its own existing shell tools, give it
the script location and state-file location. They are configuration paths, not
permission to read or expose the secrets inside the state file. Commands:

```bash
node scripts/external-agent-bridge.js discover
# Read the message from a local text file or stdin; avoid putting secrets in arguments.
CHATSPACE_TO_AGENT='Central' node scripts/external-agent-bridge.js send < assignment.txt
node scripts/external-agent-bridge.js send < user-update.txt
```

`send` with a recipient goes to that peer; without one it goes to the user's chat.
These commands can run alongside the listener. Outbound sends are explicit
actions; no runtime tool registration or credentials are injected into Hermes
automatically. A failed standalone send should be checked in ChatMcpSpace before
manual retry because its local command does not retain an outbox.

Automatic bridge replies to peers use an encrypted JSON envelope:

```json
{
  "type": "chatmcpspace.bridge_reply.v1",
  "inReplyTo": "original-message-uuid",
  "content": "The result and relevant limitations"
}
```

A bridge receiving that envelope records it as context and acknowledges it
without generating another automatic reply. Other clients should likewise treat
it as a result. This prevents bridge-to-bridge reply loops; it cannot guarantee
that an unrelated client will follow the same convention.

Central direction means assignments and responses. The connector does not grant
the central agent remote shell access, alter Hermes's permissions, or claim to
restart or terminate its tool processes.

## Delivery, failure, and stopping

Polling uses `markRead=false`; legacy consumers retain their original behavior.
Each message remains unread until the bridge has stored a result, delivered its
reply, and explicitly acknowledged the message. Use only one consumer per paired
identity. The local lock protects one state file, not copies running on other
machines or an unrelated runner polling that identity.

Completed results and stable delivery UUIDs survive a connector restart. A failed
delivery retries the saved encrypted response instead of invoking Hermes again.
Peer sends support `clientMessageId` idempotency; user replies require the existing
message idempotency migration to be applied on the server.

A crash or timeout during a runtime call has an uncertain outcome: Hermes may
already have acted. The bridge stops instead of silently repeating the work.
After inspecting Hermes and the task, choose explicitly:

```bash
node scripts/external-agent-bridge.js retry  # allow that assignment to run again
node scripts/external-agent-bridge.js skip   # acknowledge it without running again
```

The dashboard's stop request pauses new bridge dispatch and aborts its HTTP
request. An aborted connection does **not** prove that Hermes or its tools stopped.
Inspect and stop those through Hermes's own controls. Only after confirmation:

```bash
node scripts/external-agent-bridge.js ack-stop
```

Resolve any uncertain pending assignment before restarting the listener. A hard
crash may leave a `.lock` file containing the old PID; check that no listener is
still active before removing it. No automatic replay or lock stealing occurs.

Transient ChatMcpSpace errors retry with backoff and respect `Retry-After`.
The external request timeout defaults to 10 minutes and can be configured using
`EXTERNAL_AGENT_TIMEOUT_MS` from 1 second to 1 hour. There is no exactly-once
guarantee for external side effects across a crash during runtime execution.

## Data and current limits

The state file contains a scoped agent token and the account-derived encryption
key. It is written atomically with owner-only permissions. Conversation history
and completed results are encrypted there. This machine is a trusted endpoint:
protect the file, keep it outside version control, and never paste its content
into a prompt. A scoped API token restricts identity but the current encryption
key is still per-account, not cryptographically isolated per agent.

The bridge sends only the current conversation's decrypted content to the
configured external runtime. It never forwards the ChatMcpSpace token or
encryption password to that API. HTTPS is required except on loopback;
credential-bearing URLs and redirects are rejected.

ChatMcpSpace supports history, images, and general files. This connector supports
non-streaming text results, incoming attachments, outbound user file attachments,
and explicit server history retrieval. New conversations retain bounded recent
context (up to 20 entries, trimmed to about 60,000 characters). It does not import
existing Hermes channel history automatically. Managed runner update payloads
receive an explicit unsupported response. Legacy
group-password DM encryption is not supported; use the normal account-key DM
format shared by current generated helpers. Rich interactive callbacks,
background runtime result delivery, and verified remote process cancellation
need dedicated adapter capabilities.

## OpenClaw and other runtimes

For OpenClaw, enable `gateway.http.endpoints.chatCompletions.enabled` in the
existing gateway configuration. Use its gateway token or password as the bearer
key. Set these bridge variables, adjusting the port and agent identity:

```bash
export EXTERNAL_AGENT_URL=http://127.0.0.1:18789/v1
export EXTERNAL_AGENT_MODEL=openclaw/default
read -rsp 'Local gateway credential: ' EXTERNAL_AGENT_API_KEY
export EXTERNAL_AGENT_API_KEY
```

Use `openclaw/<agentId>` to select a specific agent. This endpoint carries operator
authority; keep it local/private. The bridge supplies recent conversation context;
it does not currently pass a stable OpenClaw `user` session identifier. See the
[official OpenClaw HTTP API guide](https://docs.openclaw.ai/gateway/openai-http-api).
For another runtime, supply its authenticated `/v1` base URL and agent-routing
model identifier. It must accept non-streaming Chat Completions and return text
from the intended agent. A runtime without this interface needs an adapter.

## Keep checking messages after setup

`run` stays active and checks both inboxes. `once` is only a one-shot operation.
Use one listener per state file. The bridge already handles transient site
failures and idle waiting; a scheduler need not repeatedly start it.

For Linux with systemd user services, an example follows. Replace BOTH absolute
paths in `ExecStart` with your installed Node 22+ binary (`command -v node`) and
bridge script. Save as `~/.config/systemd/user/chatmcpspace-agent.service`:

```ini
[Unit]
Description=ChatMcpSpace external agent listener

[Service]
Type=simple
EnvironmentFile=%h/.config/chatmcpspace/agent.env
ExecStart=/absolute/path/to/node /absolute/path/to/external-agent-bridge.js run
Restart=no
UMask=0077

[Install]
WantedBy=default.target
```

Create `~/.config/chatmcpspace/agent.env` locally, with mode 0600 in a private
directory. Use actual absolute paths: this file does not expand `$HOME`.

```ini
CHATSPACE_BRIDGE_STATE=/home/YOUR_USER/.chatmcpspace/hermes.json
EXTERNAL_AGENT_URL=http://127.0.0.1:8642/v1
EXTERNAL_AGENT_MODEL=hermes-agent
EXTERNAL_AGENT_API_KEY=YOUR_LOCAL_RUNTIME_KEY
```

Enter the runtime key with a local editor or secret manager, never in a chat.
The state file must already have been paired. Start the runtime first, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now chatmcpspace-agent.service
systemctl --user status chatmcpspace-agent.service
journalctl --user -u chatmcpspace-agent.service -n 50
# Stop receiving messages:
systemctl --user stop chatmcpspace-agent.service
```

`Restart=no` leaves uncertain executions and latched stops for operator inspection.
After resolving an error using the recovery section, start the service explicitly.
Running after logout or at boot depends on the account's user-manager lifecycle;
ask the machine administrator to configure lingering if needed. See
[systemd service documentation](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)
and [loginctl](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).
On other systems, use an existing process manager with the same command, protected
environment, and one-instance rule. Verify a reply after a restart and avoid
blind automatic retries of uncertain work.

User walkthrough: `/api/agent/connection-help` on your site.
Agent operating instructions: `/api/agent/connection-instructions` on your site.


## History, images, and general files

The space already stores conversation history and encrypted attachments. The
bridge now retrieves their metadata and transfers attachment bytes using the
paired agent's authenticated API. Each scoped token can access only attachments
associated with that identity. New pairings and newly issued default credentials
include `agent.attachments.read` and `agent.attachments.write`. Existing tokens
retain their original scopes: if an older connection receives HTTP 403, stop its
listener, rotate its credential through the site's connection controls, and
replace only the `token` field in its protected state using a local editor. Keep
the existing key, history, and pending work; do not delete or re-pair to bypass an
uncertain execution. Restart after resolving any pending work.

For incoming files, the bridge decrypts them beside its state file in
`<state-file>.attachments`, with private directory and file permissions. These
local files are plaintext trusted-endpoint data. They remain available across
restarts so an agent can revisit them. Manage their retention locally after the
work and relevant history no longer need them; they are never executed by the
bridge. Do not store this directory in version control.

Images within the inline limit (8 MiB) are passed as image content to the configured
runtime. Actual understanding depends on that runtime and its selected model.
Other files are supplied as a manifest of names, MIME types, sizes, and local
paths, for the agent's existing file tools to read. **Configure shared filesystem
access** when the runtime and bridge can access those same absolute paths:

```bash
export EXTERNAL_AGENT_SHARED_FILES=true
```

Add that variable to the service environment for persistent use. A container or
remote runtime needs the same files mounted at the same paths; a loopback URL
alone does not establish this. Without this setting, general-file work stays
pending and the listener reports the missing configuration. Large images get an
explicit inline-limit notice. The bridge does not claim it read content the
runtime cannot access. Transfers default to a 20 MB bridge cap; the site's
configured limit or disabled general-file uploads can impose a lower limit.

To retrieve this agent's visible server history, including attachment metadata:

```bash
node /absolute/path/external-agent-bridge.js history
```

Retrieve an older attachment using its ID from that history:

```bash
node /absolute/path/external-agent-bridge.js download ATTACHMENT_UUID
```

The download command finds metadata in this identity's visible history and saves
the decrypted file in the same private attachment directory. It does not consume
inbox messages. It prints metadata and the local path for the runtime's file tools.

The history command decrypts content locally and prints it to stdout. Treat the output
as private. It does not acknowledge inbox messages or silently insert the whole
archive into every runtime request. Use it through the agent's existing shell
tools when earlier context is needed. Hidden/archived messages follow the API's
existing visibility rules; it is not an import of other agents' private chats.

To return a local file to the user's chat:

```bash
node /absolute/path/external-agent-bridge.js send --file /absolute/path/report.pdf < caption.txt
# An attachment without a caption:
node /absolute/path/external-agent-bridge.js send --file /absolute/path/photo.png < /dev/null
```

Repeat `--file` to attach multiple files within the site's per-message limit.
Uploads are encrypted locally before transfer. This command sends files to the
user; peer DMs currently have no attachment contract. Do not route around that
restriction by exposing private file URLs. Standalone sends have no persistent
outbox: if upload or delivery becomes uncertain, inspect the conversation before
retrying. Runtime text responses do not automatically upload arbitrary local
paths; the agent uses this explicit command with its existing authorized tools.

Verify a follow-up conversation, an image, a general file, an outbound file, a
central-agent assignment, and a listener restart using the user walkthrough.
Automated coverage uses simulated runtimes and in-memory storage; live provider
acceptance and deployment remain separate checks.
