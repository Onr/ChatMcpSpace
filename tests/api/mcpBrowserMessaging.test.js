const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { chromium } = require('@playwright/test');
const { createTestDatabase, applyRuntimeUserColumns, seedUser } = require('../utils/pgMemTestUtils');

// Real browser + real OAuth/broker/crypto; the downstream agent API is a local
// contract fixture. This is not a live provider or production database test.
test.each([[false, false], [true, false], [true, true]])('MCP approval, crypto, messages and disconnect (hosted=%s, saved key=%s)', async (hosted, savedKey) => {
  const trace = label => { if (process.env.MCP_TEST_TRACE) process.stderr.write(`MCP fixture hosted=${hosted}: ${label}\n`); };
  trace('starting');
  jest.resetModules();
  const database = createTestDatabase();
  const previousBase = process.env.BASE_URL;
  const previousKeyFile = process.env.MCP_HOSTED_KEY_FILE;
  const previousWrappingKey = process.env.MCP_HOSTED_WRAPPING_KEY;
  const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-browser-key-'));
  delete process.env.MCP_HOSTED_WRAPPING_KEY;
  process.env.MCP_HOSTED_KEY_FILE = path.join(keyDirectory, 'master-key');
  let server;
  let browser;
  let broker;
  try {
    await applyRuntimeUserColumns(database.query);
    await database.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS can_spawn BOOLEAN DEFAULT FALSE');
    await database.query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS inter_agent_mode VARCHAR(50) DEFAULT 'disabled'");
    await database.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_from_agent BOOLEAN DEFAULT FALSE');
    const { userId } = await seedUser(database.query);
    const sharedOwner = await seedUser(database.query, { email: 'shared-peer@fixture.test' });
    const sharedPeerId = crypto.randomUUID();
    await database.query("INSERT INTO agents(agent_id,user_id,agent_name,position,inter_agent_mode) VALUES($1,$2,'Shared peer',9,'listen_all')", [sharedPeerId, sharedOwner.userId]);
    let sharedAllowed = true;
    let sharedIncoming = false;
    jest.doMock('../../src/shared/a2aAccess', () => ({ peers: async () => sharedAllowed ? [{ agent_id: sharedPeerId }] : [] }));
    const salt = crypto.randomBytes(32).toString('base64');
    await database.query('UPDATE users SET email_verified=TRUE, encryption_salt=$2 WHERE user_id=$1', [userId, salt]);
    for (const migration of ['018_add_agent_messages.sql', '059_add_mcp_oauth.sql', '061_add_mcp_message_grants.sql', '062_add_hosted_mcp.sql']) {
      await database.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', migration), 'utf8'));
    }
    jest.doMock('../../src/db/connection', () => ({ query: database.query, getClient: async () => { const client = await database.pool.connect(); const original = client.query.bind(client); client.query = (sql, args) => /pg_advisory_(?:un)?lock/.test(sql) ? Promise.resolve({ rows: [] }) : original(sql, args); return client; }, pool: database.pool }));
    jest.doMock('../../src/middleware/rateLimitMiddleware', () => ({ createRateLimiter: () => (_req, _res, next) => next() }));
    const storedFiles = new Map();
    const storage = { name: 'local', store: async (buffer, id) => { storedFiles.set(id, Buffer.from(buffer)); return id; }, retrieve: async id => storedFiles.get(id), delete: async id => storedFiles.delete(id) };
    jest.doMock('../../src/storage', () => ({ initializeStorage: async () => storage }));
    jest.doMock('../../src/utils/logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn(), logDebug: jest.fn() }));
    const routes = require('../../src/routes/mcpRoutes');
    const { verifyScopedCredential } = require('../../src/services/agentCredentialService');
    broker = require('../../src/services/mcpMessageBroker');
    const app = express();
    app.use(express.json({ limit: '30mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: 'local-browser-fixture-only', resave: false, saveUninitialized: false }));
    app.use((_req, res, next) => {
      res.locals.cspNonce = 'fixture-nonce';
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'nonce-fixture-nonce'; style-src 'self' 'unsafe-inline'; form-action 'self'");
      next();
    });
    app.use('/js', express.static(path.join(process.env.MCP_CONNECTION_ASSET_ROOT || path.join(__dirname, '../..'), 'public/js')));
    app.use('/css', express.static(path.join(__dirname, '../../public/css')));
    app.get('/login', (req, res) => { req.session.userId = userId; res.redirect(req.session.mcpOAuthReturnTo || '/'); });
    app.get('/fixture-callback', (_req, res) => res.send('Fixture client connected'));
    app.use(routes);

    const password = 'local-browser-encryption-fixture';
    const key = crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), 100000, 32, 'sha256');
    const sharedPassword = 'fixture-shared-password';
    const sharedSalt = crypto.randomBytes(32).toString('base64');
    const groupKey = crypto.pbkdf2Sync(sharedPassword, Buffer.from(sharedSalt, 'base64'), 100000, 32, 'sha256');
    const seal = (text, selectedKey = key) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', selectedKey, iv);
      const content = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), content].map(part => part.toString('base64')).join(':');
    };
    const open = (value, selectedKey = key) => {
      const [iv, tag, content] = value.split(':').map(part => Buffer.from(part, 'base64'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', selectedKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8');
    };
    const peerId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const peerMessageId = crypto.randomUUID();
    const sends = [];
    const acks = [];
    app.use('/api/agent', async (req, res, next) => {
      try {
        const identity = await verifyScopedCredential(req.get('x-agent-token'));
        if (!identity || identity.user.userId !== userId || identity.agentName !== req.get('x-agent-name')) return res.sendStatus(401);
        req.user = identity.user;
        req.authContext = { type: 'agent_token', agentId: identity.agentId, agentName: identity.agentName, scopes: identity.scopes };
        next();
      } catch (error) { next(error); }
    });
    const attachmentController = require('../../src/controllers/agentAttachmentController');
    app.post('/api/agent/attachments', attachmentController.uploadAttachment);
    app.get('/api/agent/attachments/:attachmentId/metadata', attachmentController.attachmentMetadata);
    app.get('/api/agent/attachments/:attachmentId', attachmentController.downloadAttachment);
    app.get('/api/agent/discover', (_req, res) => res.json({ agents: [{ agentId: peerId, agentName: 'Permitted peer', shared: false }, ...(hosted && sharedAllowed ? [{ agentId: sharedPeerId, agentName: 'Shared peer', shared: true }] : [])] }));
    app.get('/api/agent/responses', (req, res) => {
      expect(req.query.markRead).toBe('false');
      res.json({ responses: [{ messageId: userMessageId, responseType: 'text', content: seal('Hello from the user'), encrypted: true, timestamp: '2026-01-01T00:00:00.000Z' }] });
    });
    app.get('/api/agent/messages/history', (_req, res) => res.json({ messages: [] }));
    app.get('/api/agent/messages/direct', (req, res) => {
      expect(req.query.markRead).toBe('false');
      res.json({ messages: [{ messageId: peerMessageId, fromAgentId: peerId, fromAgentName: 'Permitted peer', content: seal('Hello from the peer'), encrypted: true, timestamp: '2026-01-01T00:00:01.000Z' }, ...(sharedIncoming ? [{ messageId: crypto.randomUUID(), fromAgentId: sharedPeerId, shared: true, content: seal('Shared reply', groupKey), encrypted: true, timestamp: '2026-01-01T00:00:02.000Z' }] : [])] });
    });
    const acceptSend = (req, res) => {
      expect(req.body.encrypted).toBe(true);
      expect(open(req.body.content, req.body.toAgentName === sharedPeerId ? groupKey : key)).toBe('Browser encrypted reply');
      const previous = sends.find(item => item.clientMessageId === req.body.clientMessageId);
      if (previous && previous.content !== req.body.content) return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      sends.push(req.body);
      res.json({ messageId: req.body.clientMessageId, status: 'sent', idempotent: !!previous });
    };
    app.post('/api/agent/messages', acceptSend);
    app.post('/api/agent/messages/direct', acceptSend);
    app.post('/api/agent/responses/ack', (req, res) => { acks.push(req.body); res.json({ acknowledged: true }); });

    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.BASE_URL = base;
    const redirectUri = `${base}/fixture-callback`;
    const registration = await request(app).post('/oauth/register').send({ client_name: 'Browser fixture', redirect_uris: [redirectUri] }).expect(201);
    const verifier = 'V'.repeat(64);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const challengeResponse = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 0, method: 'initialize' }).expect(401);
    expect(challengeResponse.headers['www-authenticate']).toContain('messages.read');
    const authorize = new URL(`${base}/oauth/authorize`);
    authorize.search = new URLSearchParams({ client_id: registration.body.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp`, scope: 'agents.read messages.read messages.write peers.read peers.write attachments.read attachments.write', state: 'browser-fixture-state' }).toString();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    if (savedKey) await context.addInitScript(({ value, salt }) => {
      localStorage.setItem('encryptionKey', value);
      localStorage.setItem(`encryptionKey:${salt}`, value);
    }, { value: key.toString('base64'), salt });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    let enrollmentRequests = 0;
    let enrollment;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (new URL(req.url()).pathname === '/mcp/gateway/enroll') enrollmentRequests++; });
    page.on('response', async response => {
      if (new URL(response.url()).pathname === '/mcp/gateway/enroll' && response.ok()) enrollment = await response.json();
    });
    await page.goto(authorize.toString());
    trace('consent loaded');
    await page.locator('input[name="allow_peers"]').check();
    if (!hosted) await page.locator('input[name="allow_hosted"]').uncheck();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForURL('**/mcp/connection?**');
    expect(await page.locator('.agent strong').textContent()).toBe('Browser fixture MCP');
    if (savedKey) {
      await page.waitForFunction(() => document.getElementById('state').textContent === 'Waiting for AI app');
      expect(await page.locator('#detail').textContent()).toContain('Return to your AI app');
      expect(await page.locator('#reconnect').isDisabled()).toBe(true);
      // Reproduce the reported production case with real Web Crypto: the
      // ordinary stored key stays non-exportable, hosted approval opts in.
      expect(await page.evaluate(async () => {
        const ordinary = await E2EEncryption.getStoredEncryptionKey();
        const approved = await E2EEncryption.getStoredEncryptionKey({ extractable: true });
        return { ordinary: ordinary.extractable, approved: approved.extractable };
      })).toEqual({ ordinary: false, approved: true });
    } else {
      await page.locator('#password').waitFor({ state: 'visible' });
      await page.locator('#unlockButton').click();
      expect(await page.locator('#detail').textContent()).toContain('empty');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const evidenceDirectory = path.join(__dirname, '../../test-results/mcp-connection');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDirectory, `pending-${hosted}-${savedKey}.png`), fullPage: true });
    const callbackLink = page.locator(`a[href^="${redirectUri}"]`);
    await callbackLink.waitFor();
    expect(await callbackLink.getAttribute('target')).toBe('_blank');
    const popupPromise = context.waitForEvent('page');
    await callbackLink.click();
    expect(await page.locator('#returnFeedback').textContent()).toContain('Opened the return link');
    const popup = await popupPromise;
    await popup.waitForURL('**/fixture-callback?**');
    const code = new URL(popup.url()).searchParams.get('code');
    const issued = await request(app).post('/oauth/token').send({ grant_type: 'authorization_code', client_id: registration.body.client_id, redirect_uri: redirectUri, code, code_verifier: verifier, resource: `${base}/mcp` }).expect(200);
    expect(enrollmentRequests).toBe(0);
    if (!savedKey) {
      await page.locator('#password').fill(password);
      await page.locator('#password').press('Enter');
    }
    await page.waitForFunction(() => document.getElementById('state').textContent === 'Connected');
    trace('unlocked');
    expect(await page.locator('#successActions').isVisible()).toBe(true);
    expect(await page.locator('#reconnect').isDisabled()).toBe(true);
    await page.screenshot({ path: path.join(evidenceDirectory, `connected-${hosted}-${savedKey}.png`), fullPage: true });
    expect(await page.locator('#password').inputValue()).toBe('');
    const config = await page.locator('#mcp-config').textContent().then(JSON.parse);
    const cookies = (await context.cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (!hosted) await request(app).post('/mcp/hosted/enable').set('Cookie', cookies).set('X-CSRF-Token', config.csrf).set('Origin', base).send({ grantId: config.grantId, encryptionKey: key.toString('base64') }).expect(403);
    await request(app).post('/mcp/gateway/enroll').set('Cookie', cookies).send({ grantId: config.grantId }).expect(403);
    await request(app).post('/mcp/gateway/enroll').set('Cookie', cookies).set('X-CSRF-Token', config.csrf)
      .set('Origin', 'https://untrusted.example').send({ grantId: config.grantId }).expect(403);
    const otherSession = request.agent(app);
    await otherSession.get('/login');
    const otherPage = await otherSession.get(`/mcp/connection?grant_id=${config.grantId}`).expect(200);
    const otherCsrf = JSON.parse(otherPage.text.match(/<script id="mcp-config" type="application\/json">([^<]+)<\/script>/)[1]).csrf;
    if (!hosted) await otherSession.post('/mcp/gateway/claim').set('X-CSRF-Token', otherCsrf).set('Origin', base)
      .send({ grantId: config.grantId, connectionId: enrollment.connectionId, gatewaySecret: enrollment.gatewaySecret }).expect(403);
    const accessHash = crypto.createHash('sha256').update(issued.body.access_token).digest('hex');
    await database.query('UPDATE mcp_oauth_tokens SET scope=$1 WHERE access_token_hash=$2', ['agents.read', accessHash]);
    await request(app).post('/mcp').set('Authorization', `Bearer ${issued.body.access_token}`)
      .send({ jsonrpc: '2.0', id: 'scope-bypass', method: 'tools/call', params: { name: 'send_message', arguments: { text: 'Denied', idempotencyId: crypto.randomUUID() } } }).expect(403);
    await database.query('UPDATE mcp_oauth_tokens SET scope=$1 WHERE access_token_hash=$2', [issued.body.scope, accessHash]);
    const call = async (name, args = {}) => {
      const reply = await request(app).post('/mcp').set('Authorization', `Bearer ${issued.body.access_token}`).send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }).expect(200);
      expect(reply.body.result).toMatchObject({ isError: false });
      return reply.body.result.structuredContent;
    };
    if (hosted) {
      await page.locator('#sharedPeerSetup').waitFor({ state: 'visible' });
      await page.locator('#sharedPeerPassword').fill(sharedPassword);
      await page.locator('#sharedPeerSalt').fill(sharedSalt);
      await page.locator('#saveSharedPeer').click();
      await page.waitForFunction(() => document.getElementById('sharedPeerResult').textContent.includes('Shared peer configured'));
      await browser.close(); browser = null;
      const status = await call('get_connection_status');
      expect(status).toMatchObject({ mode: 'hosted', browserRequired: false, gateway: 'connected' });
    }
    const inbox = await call('read_inbox', { limit: 10 });
    trace('inbox read');
    expect(inbox.messages.map(item => item.content)).toEqual(['Hello from the user', 'Hello from the peer']);
    expect(acks).toHaveLength(0);
    const idempotencyId = crypto.randomUUID();
    await call('send_message', { text: 'Browser encrypted reply', idempotencyId });
    await call('send_message', { text: 'Browser encrypted reply', idempotencyId });
    expect(sends[0].content).toBe(sends[1].content);
    await call('send_peer_message', { peerId, text: 'Browser encrypted reply', idempotencyId: crypto.randomUUID() });
    expect(sends[2].toAgentName).toBe('Permitted peer');
    await call('ack_message', { messageId: userMessageId, kind: 'user' });
    expect(acks).toEqual([{ messageId: userMessageId, responseType: 'text' }]);
    // The saved-key regression exercises OAuth, activation, messages and
    // revocation. The first-time hosted case covers the large-file matrix.
    if (hosted && !savedKey) {
      trace('starting files');
      const inputs = [
        { fileName: 'report.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nPRIVATE FILE CONTENT\n%%EOF') },
        { fileName: 'pixel.png', contentType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64') },
        { fileName: 'data.bin', contentType: 'application/octet-stream', bytes: crypto.randomBytes(2200000) }
      ];
      for (const file of inputs) {
        const uploadArgs = { fileName: file.fileName, contentType: file.contentType, dataBase64: file.bytes.toString('base64'), idempotencyId: crypto.randomUUID() };
        const uploaded = await call('upload_attachment', uploadArgs);
        expect(uploaded.attachmentId).toBe(uploadArgs.idempotencyId);
        expect(storedFiles.get(uploaded.attachmentId)).not.toEqual(file.bytes);
        const duplicate = await call('upload_attachment', uploadArgs);
        expect(duplicate.attachmentId).toBe(uploaded.attachmentId);
        const chunks = [];
        let offset = 0;
        do {
          const chunk = await call('read_attachment', { attachmentId: uploaded.attachmentId, offset });
          expect(chunk.mimeType).toBe(file.contentType);
          chunks.push(Buffer.from(chunk.dataBase64, 'base64'));
          offset = chunk.nextOffset;
        } while (offset !== null);
        expect(Buffer.concat(chunks)).toEqual(file.bytes);
        const resource = await request(app).post('/mcp').set('Authorization', `Bearer ${issued.body.access_token}`)
          .send({ jsonrpc: '2.0', id: 'resource', method: 'resources/read', params: { uri: uploaded.uri } }).expect(200);
        expect(resource.body.result.contents[0].blob).toBe(file.bytes.subarray(0, 262144).toString('base64'));
        await call('send_message', { text: 'Browser encrypted reply', attachmentIds: [uploaded.attachmentId], idempotencyId: crypto.randomUUID() });
      }
      const sharedUpload = await call('upload_attachment', { fileName: 'shared.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('Shared attachment bytes').toString('base64'), idempotencyId: crypto.randomUUID(), peerId: sharedPeerId });
      await call('send_peer_message', { peerId: sharedPeerId, text: 'Browser encrypted reply', attachmentIds: [sharedUpload.attachmentId], idempotencyId: crypto.randomUUID() });
      expect(sends[sends.length - 1].encryptionScope).toBe('shared_dm_password');
      const sharedFile = await call('read_attachment', { attachmentId: sharedUpload.attachmentId });
      expect(Buffer.from(sharedFile.dataBase64, 'base64').toString()).toBe('Shared attachment bytes');
      sharedIncoming = true;
      expect((await call('read_inbox', { limit: 10 })).messages.some(item => item.content === 'Shared reply')).toBe(true);
      sharedAllowed = false;
      const revokedPeer = await request(app).post('/mcp').set('Authorization', `Bearer ${issued.body.access_token}`)
        .send({ jsonrpc: '2.0', id: 'revoked-peer', method: 'tools/call', params: { name: 'read_attachment', arguments: { attachmentId: sharedUpload.attachmentId } } }).expect(200);
      expect(revokedPeer.body.result.isError).toBe(true);
      const wrapped = (await database.query('SELECT sealed_key FROM mcp_hosted_connections WHERE grant_id=$1', [config.grantId])).rows[0].sealed_key;
      expect(wrapped).not.toContain(key.toString('base64'));
      jest.resetModules();
      const restarted = require('../../src/services/mcpHostedService');
      const recovered = await restarted.execute({ grantId: config.grantId, ownerId: userId, origin: base }, 'send_message', { text: 'Browser encrypted reply', idempotencyId });
      trace('service reload passed');
      expect(recovered.sent).toBe(true);
      expect(sends[sends.length - 1].content).toBe(sends[0].content);
    }
    // Revocation remains available after losing all process-local broker state.
    broker._resetForTests();
    if (hosted) {
      await request(app).post('/mcp/gateway/close').set('Cookie', cookies).set('X-CSRF-Token', config.csrf).set('Origin', base).send({ grantId: config.grantId }).expect(200);
      expect((await database.query('SELECT grant_id FROM mcp_hosted_connections WHERE grant_id=$1', [config.grantId])).rows).toHaveLength(0);
      expect((await database.query('SELECT grant_id FROM mcp_hosted_peer_keys WHERE grant_id=$1', [config.grantId])).rows).toHaveLength(0);
    } else {
      await page.locator('#disconnect').click();
      await page.waitForFunction(() => document.getElementById('detail').textContent.includes('access revoked'));
    }
    await request(app).post('/mcp').set('Authorization', `Bearer ${issued.body.access_token}`).send({ jsonrpc: '2.0', id: 'revoked', method: 'tools/list' }).expect(401);
    expect(errors).toEqual([]);
    trace('operations passed');
  } finally {
    trace('closing browser');
    await browser?.close();
    broker?._resetForTests();
    trace('closing server');
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await database.pool.end();
    if (previousBase === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBase;
    if (previousKeyFile === undefined) delete process.env.MCP_HOSTED_KEY_FILE; else process.env.MCP_HOSTED_KEY_FILE = previousKeyFile;
    if (previousWrappingKey === undefined) delete process.env.MCP_HOSTED_WRAPPING_KEY; else process.env.MCP_HOSTED_WRAPPING_KEY = previousWrappingKey;
    fs.rmSync(keyDirectory, { recursive: true, force: true });
    jest.resetModules();
    trace('cleanup finished');
  }
}, 90000);
