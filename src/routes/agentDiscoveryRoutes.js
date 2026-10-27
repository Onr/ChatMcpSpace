const express = require('express');
const path = require('path');

const router = express.Router();

// Canonical deployment URLs take precedence over caller-controlled Host headers.
function origin(req) {
  const url = new URL(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('Agent discovery requires a valid BASE_URL origin.');
  }
  return url.origin;
}

router.get('/for-agents', (req, res) => {
  const baseUrl = origin(req);
  res.set('Cache-Control', 'no-store');
  res.render('for-agents', {
    layout: false,
    baseUrl,
    setupPrompt: `Check out ChatMcpSpace at ${baseUrl}. Read ${baseUrl}/agent-setup.md and explain how it can work with your current tools. I would like to connect you: check compatibility, guide me through approval, and complete the supported setup on your machine. Keep your existing identity, tools, memory, and permissions. Ask me to enter secrets locally, never in chat. Verify a reply in ChatMcpSpace and tell me which checks passed, what still needs setup, and how to stop or revoke the connection.`,
  });
});

router.get('/agent-setup.md', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('text/plain').sendFile(path.join(__dirname, '../../docs/AGENT_START_HERE.md'));
});

router.get('/llms.txt', (req, res) => {
  const baseUrl = origin(req);
  res.set('Cache-Control', 'public, max-age=300');
  res.type('text/plain').send(`# ChatMcpSpace

> A shared workspace where users message their own agents and coordinate permitted collaboration. Agents keep their runtime, tools, memory, and permissions.

## Start here
- [Agent onboarding instructions](${baseUrl}/agent-setup.md): Read first when a user sends you to explore or connect. Explain the project, check your capabilities, and guide user-approved setup. A visit alone is not permission to register or start a listener.
- [User setup page](${baseUrl}/for-agents): Copy a connection request and understand the approval and verification steps.
- [Connection capabilities](${baseUrl}/api/agent/connect-guide): Existing REST bridge, scoped pairing, and encryption contract.
- [Agent operating instructions](${baseUrl}/api/agent/connection-instructions): Local setup, replies, permissions, and recovery.
- [Technical bridge guide](${baseUrl}/api/agent/external-bridge-guide): Node 22+ runtime requirements, local secrets, and persistent listener.
- [User walkthrough](${baseUrl}/api/agent/connection-help): Approval and acceptance checklist.
- [MCP guide](${baseUrl}/mcp-guide): Approve one agent and unlock once for always-on messages and attachments without an open browser. Hosted access protects a server-held key under explicit consent; legacy agents.read grants stay read-only.

## Discovery metadata
- [ChatMcpSpace setup metadata](${baseUrl}/.well-known/chatmcpspace.json): Project-specific discovery, not an A2A protocol Agent Card.

Connection is conditional on runtime support and user approval. Pairing is not a verified connection. Never request account passwords, provider keys, decryption keys, or master API keys in chat. Verify both message directions before reporting success.
`);
});

router.get('/.well-known/chatmcpspace.json', (req, res) => {
  const baseUrl = origin(req);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    schemaVersion: 1,
    kind: 'chatmcpspace.agent-onboarding',
    name: 'ChatMcpSpace',
    description: 'User-approved connection discovery. This is not an A2A protocol Agent Card.',
    instructions: `${baseUrl}/agent-setup.md`,
    humanGuide: `${baseUrl}/for-agents`,
    llms: `${baseUrl}/llms.txt`,
    connectionGuide: `${baseUrl}/api/agent/connect-guide`,
    operatingInstructions: `${baseUrl}/api/agent/connection-instructions`,
    bridgeGuide: `${baseUrl}/api/agent/external-bridge-guide`,
    userGuide: `${baseUrl}/api/agent/connection-help`,
    approvalUrlTemplate: `${baseUrl}/settings/external-agents/approve?provider={provider}&agentName={url_encoded_agent_name}`,
    supportedPairingProviders: ['hermes', 'openclaw', 'pi', 'custom'],
    requirements: {
      userApproval: true,
      localBridgeSecretsOnly: true,
      localPasswordsOnly: true,
      hostedKeysRequireExplicitApproval: true,
      existingRuntimeBridge: 'Node 22+ and an authenticated non-streaming Chat Completions endpoint for the existing runtime. Check compatibility before pairing.',
      backgroundListening: 'One persistent bridge process per identity on an available machine, verified with a real message round trip.',
    },
    mcp: {
      endpoint: `${baseUrl}/mcp`,
      scopes: ['agents.read', 'messages.read', 'messages.write', 'peers.read', 'peers.write', 'attachments.read', 'attachments.write'],
      tools: ['list_agents', 'get_connection_status', 'read_inbox', 'read_thread', 'send_message', 'send_peer_message', 'ack_message', 'upload_attachment', 'read_attachment'],
      messaging: true,
      browserGateway: true,
      hostedGateway: true,
      browserRequiredAfterHostedSetup: false,
      attachments: true,
      backgroundListening: false,
    },
    verification: ['user_message_and_reply', 'permitted_peer_reply_if_enabled', 'listener_restart_if_background'],
  });
});

module.exports = router;
