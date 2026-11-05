const express = require('express');
const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const routes = require('../../src/routes/agentDiscoveryRoutes');

const root = path.join(__dirname, '../..');

function app() {
  const application = express();
  application.set('views', path.join(root, 'views'));
  application.set('view engine', 'ejs');
  application.locals.assetUrl = url => url;
  application.use(routes);
  application.use((error, _req, res, _next) => res.status(500).send('Configuration error'));
  return application;
}

describe('Public visiting-agent discovery', () => {
  const original = process.env.BASE_URL;
  beforeEach(() => { process.env.BASE_URL = 'https://workspace.example/'; });
  afterAll(() => {
    if (original === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = original;
  });

  test('lets a visitor discover the instructions and approval contract without a session', async () => {
    const application = app();
    const index = await request(application).get('/llms.txt').expect(200).expect('Content-Type', /text\/plain/);
    expect(index.headers['set-cookie']).toBeUndefined();
    const setupUrl = index.text.match(/\[Agent onboarding instructions\]\(([^)]+)\)/)[1];
    expect(setupUrl).toBe('https://workspace.example/agent-setup.md');
    const guide = await request(application).get(new URL(setupUrl).pathname).expect(200);
    expect(guide.text).toBe(fs.readFileSync(path.join(root, 'docs/AGENT_START_HERE.md'), 'utf8'));
    const metadata = await request(application).get('/.well-known/chatmcpspace.json').expect(200);
    expect(metadata.body).toMatchObject({
      schemaVersion: 1,
      kind: 'chatmcpspace.agent-onboarding',
      instructions: setupUrl,
      requirements: { userApproval: true, localBridgeSecretsOnly: true, hostedKeysRequireExplicitApproval: true },
      mcp: {
        scopes: ['agents.read', 'messages.read', 'messages.write', 'peers.read', 'peers.write', 'attachments.read', 'attachments.write'],
        tools: ['list_agents', 'get_connection_status', 'read_inbox', 'read_thread', 'send_message', 'send_peer_message', 'ack_message', 'upload_attachment', 'read_attachment'],
        messaging: true,
        browserGateway: true,
        backgroundListening: false,
      },
    });
    expect(metadata.body.approvalUrlTemplate).toBe('https://workspace.example/settings/external-agents/approve?provider={provider}&agentName={url_encoded_agent_name}');
    expect(metadata.body.supportedPairingProviders).toEqual(['hermes', 'openclaw', 'pi', 'custom']);
    expect(guide.text).toContain('A visit\nalone is not permission');
    expect(guide.text).toContain('restart the listener');
    expect(guide.text).toContain('revoke its scoped credential');
    expect(guide.text).toContain('the browser may close');
    expect(metadata.headers['set-cookie']).toBeUndefined();
  });

  test('renders an accessible, public copy request containing only canonical site links', async () => {
    const response = await request(app()).get('/for-agents').set('Host', 'attacker.example').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const dom = new JSDOM(response.text);
    const document = dom.window.document;
    expect(document.querySelector('link[rel="alternate"][href="/llms.txt"]')).not.toBeNull();
    expect(document.querySelector('a[href="/agent-setup.md"]')).not.toBeNull();
    expect(document.querySelector('label[for="externalAgentSetupPrompt"]')).not.toBeNull();
    expect(document.getElementById('externalAgentCopyStatus').getAttribute('role')).toBe('status');
    const prompt = document.getElementById('externalAgentSetupPrompt').value;
    expect(prompt).toContain('https://workspace.example/agent-setup.md');
    expect(prompt).toContain('enter secrets locally, never in chat');
    expect(prompt).toContain('check compatibility');
    expect(prompt).not.toContain('attacker.example');
    expect(document.querySelector('form')).toBeNull();
    dom.window.close();
  });

  test('offers Grok Bot MCP onboarding without bridge pairing or account mutations', async () => {
    const application = app();
    const response = await request(application).get('/grok-bot-guide?token=DO_NOT_COPY')
      .set('Host', 'attacker.example').expect(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    const dom = new JSDOM(response.text);
    const document = dom.window.document;
    const prompt = document.getElementById('externalAgentSetupPrompt').value;
    expect(prompt).toContain('https://workspace.example/mcp');
    expect(prompt).toContain('https://workspace.example/grok-bot-setup.md');
    expect(prompt).toContain('existing Grok Bot');
    expect(prompt).toContain('get_connection_status');
    expect(prompt).not.toContain('/settings/external-agents/approve');
    expect(response.text).not.toMatch(/attacker\.example|DO_NOT_COPY/);
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('label[for="externalAgentSetupPrompt"]')).not.toBeNull();
    expect(document.getElementById('externalAgentCopyStatus').getAttribute('role')).toBe('status');
    expect(document.querySelector('a[href="/grok-bot-setup.md"]')).not.toBeNull();
    dom.window.close();
    const guide = await request(application).get('/grok-bot-setup.md').expect(200).expect('Content-Type', /text\/plain/);
    expect(guide.text).toBe(fs.readFileSync(path.join(root, 'docs/GROK_BOT.md'), 'utf8'));
    const metadata = await request(application).get('/.well-known/chatmcpspace.json').expect(200);
    expect(metadata.body.mcp.clientGuides['grok-bot']).toEqual({
      name: 'Grok Bot', mode: 'oauth-mcp', guide: 'https://workspace.example/grok-bot-guide',
      instructions: 'https://workspace.example/grok-bot-setup.md',
      verificationStatus: 'requires-client-verification', automaticWakeup: false,
    });
    expect(metadata.body.supportedPairingProviders).not.toContain('grok-bot');
    const index = await request(application).get('/llms.txt').expect(200);
    expect(index.text).toContain('https://workspace.example/grok-bot-setup.md');
  });

  test.each(['/llms.txt', '/agent-setup.md', '/.well-known/chatmcpspace.json', '/for-agents', '/grok-bot-guide', '/grok-bot-setup.md'])('does not accept connection mutations at %s', async route => {
    await request(app()).post(route).send({ pairingCode: 'do-not-redeem' }).expect(404);
    const response = await request(app()).head(route).expect(200);
    expect(response.text).toBeUndefined();
  });

  test('uses the configured origin despite a forged Host and never reflects URL query secrets', async () => {
    const response = await request(app()).get('/.well-known/chatmcpspace.json?token=DO_NOT_COPY')
      .set('Host', 'attacker.example').expect(200);
    expect(response.text).not.toMatch(/attacker|DO_NOT_COPY/);
    expect(response.body.connectionGuide).toBe('https://workspace.example/api/agent/connect-guide');
  });

  test.each(['https://user:secret@example.test', 'https://example.test/?token=secret', 'javascript:alert(1)', 'https://example.test/subpath'])('rejects invalid canonical origins without echoing secrets: %s', async baseUrl => {
    process.env.BASE_URL = baseUrl;
    const response = await request(app()).get('/.well-known/chatmcpspace.json').expect(500);
    expect(response.text).toBe('Configuration error');
  });

  test('resolves a self-hosted development origin when BASE_URL is absent', async () => {
    delete process.env.BASE_URL;
    const response = await request(app()).get('/llms.txt').set('Host', 'localhost:4321').expect(200);
    expect(response.text).toContain('http://localhost:4321/agent-setup.md');
  });
});
