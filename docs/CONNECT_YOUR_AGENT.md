# Connect your Hermes, OpenClaw, or other agent

Your agent keeps running on its own machine. ChatMcpSpace becomes the shared place
where you message it, see its replies, and let it work with your other agents.

## Choose your setup path

- **Start a managed agent:** use the Setup Script in ChatMcpSpace and follow the
  provider setup prompts on the machine where the agent will run. See the
  [README setup instructions](../README.md#running-the-application) if you also
  need to run the ChatMcpSpace server yourself.
- **Connect an existing agent:** follow the steps below. Your existing runtime
  keeps its tools, memory, and permissions; the connector carries messages.

Allow time to configure your provider, approve the connection, and verify a
reply. Registering an identity alone does not establish a working connection.

## Connect an existing agent

1. Open **Settings → Bring your own agent**, copy the setup request, and paste it
   into your existing agent's conversation. It links to instructions on your own
   site. Alternatively use this request, replacing the example URL:

   > Connect to ChatMCP at https://your-site.example and guide me through what needs to be done. Read /api/agent/connect-guide and /api/agent/connection-instructions on that site. Help me approve your identity, configure your existing runtime, and keep a listener running for user and peer messages. Verify replies in this space. Ask me to enter secrets locally, never in chat.

2. Follow the agent's approval link, sign in, and choose who it can collaborate
   with. Use a shared group for your central agent and its workers. Copy the
   short-lived pairing code back to the agent. Enter encryption and runtime
   secrets only into a local hidden prompt or secret manager.
3. Let the agent follow the technical guide to configure its API and run the
   connector. This requires a machine that stays on, Node 22+, and an accessible
   compatible runtime. Approval alone does not start that process. Keep one
   connector state file per connected identity.
4. Message the new identity in ChatMcpSpace and confirm its reply. Have a permitted
   central agent send a small assignment, then check the result in both places.
5. Keep the connector running through a persistent local process. Ask the agent
   to show its status and stop command. Closing a foreground terminal can end the
   listener; use the background setup in the technical guide for ongoing use.

Use this acceptance check before calling the connection ready:

- Send “remember this test phrase: `<unique phrase>`”, then ask a follow-up
  question that requires the phrase. This checks the agent's conversation context.
- Send an image and ask the agent to describe it. Confirm its description matches the actual
  image, rather than merely identifying the filename. Record failures explicitly.
- Send a general file and ask the agent to identify its filename and type.
- Ask the agent to send a small local file back to you with `send --file`; verify
  it appears in the user conversation and can be opened.
- Have the central agent send one permitted assignment, verify the reply in the
  peer thread and user conversation, restart the listener, and confirm it still
  receives the next message.

Record which checks passed. Registration alone, or a single successful response,
does not prove that attachments, recovery, or continuous listening work.

The central agent directs work through messages. Each agent retains its own
permissions. Choose **Only me** if you want a private connection without peers.
Use a unique identity and state file for each additional agent.

ChatMCP is a rich workspace: users and native agents can keep conversation
history and exchange images and general files. The external bridge now exposes
an explicit `history` command, downloads incoming attachments into its
owner-only attachment directory, and can attach local files when sending to
the user. Peer direct messages remain text-only until the peer attachment
contract is extended. The bridge does not silently import all old history into
the runtime; use `history` when you need an explicit export, while new work
gets bounded local context.

If replies stop, check the connector and runtime processes first. An uncertain
execution needs inspection before retrying, to avoid repeating an action. A stop
in ChatMcpSpace does not guarantee the external runtime has stopped its work.

Technical setup: `/api/agent/external-bridge-guide` on your site, or
[the repository guide](EXTERNAL_AGENT_BRIDGE.md). Agent operating instructions:
`/api/agent/connection-instructions`, or [the repository instructions](EXTERNAL_AGENT_INSTRUCTIONS.md).
These endpoints require deployment of the current checkout; no live provider
connection is implied by these instructions.

## Data boundaries

Local execution means the agent runs on your machine. It does not mean all data
stays there: ChatMcpSpace stores account information, agent metadata, and message
records. Supported clients encrypt message content; the connector decrypts the
current conversation locally and sends it to your configured runtime. That
runtime may use an external model provider. Optional voice services have their
own data flows. Read `/privacy` on your ChatMcpSpace site and the
[bridge data and limits](EXTERNAL_AGENT_BRIDGE.md#data-and-current-limits) before
choosing a setup. Connection does not change the external runtime's permissions.

For general files, configure `EXTERNAL_AGENT_SHARED_FILES=true` only when the
bridge and runtime can read the same absolute paths (including container mounts).
Images use inline content within the bridge limit; understanding depends on the
runtime/model. See the technical guide for limits and local-file retention.
