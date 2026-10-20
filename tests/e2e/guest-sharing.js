#!/usr/bin/env node
// Disposable PostgreSQL schema + owner and two real guest browsers. No production
// data or provider calls. Initial keys are provisioned through the owner UI.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const { assetUrl } = require('../../src/utils/assetUrl');
const renderTemplate = (file, data = {}) => ejs.renderFile(file, { assetUrl, ...data });
const { Pool } = require('pg');
const { chromium } = require('@playwright/test');
const assert = require('assert/strict');

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: crypto.webcrypto });
const C = require('../../public/js/shared-crypto');
const { seedUser } = require('../utils/pgMemTestUtils');

const ROOT = path.join(__dirname, '../..');
const uid = () => crypto.randomUUID();
const sqlFile = file => fs.readFileSync(path.join(ROOT, 'src/db/migrations', file), 'utf8');
const migrationFiles = [
  '042_add_shared_conversations.sql',
  '043_add_agent_devices_and_share_grants.sql',
  '044_add_shared_task_context.sql',
  '045_add_guest_principals_and_membership.sql',
  '047_add_guest_separate_rooms.sql',
  '048_enforce_guest_room_relationships.sql',
  '049_retain_guest_history_attribution.sql',
  '050_bind_guest_request_revisions.sql',
  '051_retain_shared_task_attempts.sql',
  '052_bound_guest_file_storage.sql',
  '053_bind_shared_action_approvals.sql',
  '057_add_shared_message_recipients.sql',
  '058_add_shared_agent_read_receipts.sql'
];

class TestStore {
  constructor() {
    this.isReady = true;
    this.values = new Map();
  }

  async incr(key) {
    const value = (this.values.get(key) || 0) + 1;
    this.values.set(key, value);
    return value;
  }

  async pExpire() { return 1; }
  async pTTL() { return 60_000; }
}

async function identityPair(withPrivate = false) {
  const pair = await crypto.subtle.generateKey({
    name: 'RSA-OAEP',
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, false, ['wrapKey', 'unwrapKey']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return withPrivate ? { publicKey, privateKey: pair.privateKey } : publicKey;
}

async function waitFor(check, message, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function insertAgentMessage(query, { roomId, agentId, kind, payload, questionId = null }) {
  const id = uid();
  await query(`INSERT INTO shared_messages
    (id,conversation_id,sender_agent_id,kind,payload,key_version,addressed_to,reply_to,question_id)
    VALUES($1,$2,$3,$4,$5,1,'{}','{}',$6)`, [id, roomId, agentId, kind, JSON.stringify(payload), questionId]);
  return id;
}

async function main() {
  if (!process.env.SHARED_TEST_DATABASE_URL) {
    throw new Error('Provide a disposable SHARED_TEST_DATABASE_URL; this test creates and drops only its own schema');
  }

  const schemaName = 'guest_e2e_' + uid().replace(/-/g, '');
  const admin = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL });
  const pool = new Pool({
    connectionString: process.env.SHARED_TEST_DATABASE_URL,
    options: `-c search_path=${schemaName}`
  });
  const query = (text, params) => pool.query(text, params);
  let server;
  let browser;
  let contextA;
  let contextB;
  let ownerContext;
  let runnerDirectory;
  try {
    await admin.query(`CREATE SCHEMA ${schemaName}`);
    await query(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'));
    for (const file of migrationFiles) await query(sqlFile(file));

    const dbPath = require.resolve('../../src/db/connection');
    require.cache[dbPath] = {
      id: dbPath,
      filename: dbPath,
      loaded: true,
      exports: { query, getClient: () => pool.connect() }
    };
    process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
    process.env.FEATURE_GUEST_SHARING = 'true';

    const guestRoutes = require('../../src/shared/guestRoutes');
    const owner = await seedUser(query, { email: 'guest-e2e-owner@example.test' });
    const member = await seedUser(query, { email: 'guest-e2e-member@example.test' });
    const agents = [
      { id: uid(), name: 'Pilot Alpha' },
      { id: uid(), name: 'Pilot Beta' },
      { id: uid(), name: 'Unselected Agent' }
    ];
    await query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
      VALUES($1,$2,$3,0,'{}'::jsonb),($4,$2,$5,1,'{}'::jsonb),($6,$2,$7,2,'{}'::jsonb)`, [
      agents[0].id, owner.userId, agents[0].name,
      agents[1].id, agents[1].name,
      agents[2].id, agents[2].name
    ]);
    const executionDevice = await require('../../src/shared/authorization').createDevice(owner.userId, {
      agentId: agents[0].id, deviceLabel: 'Synthetic browser-test device', platform: 'linux', executorType: 'container',
      workspaceAliases: ['Pilot project'], capabilities: { actions: ['workspace.read', 'workspace.execute'], resources: ['Pilot project'], destinations: [] }
    });

    const agentPairs = { alpha: await identityPair(true), beta: await identityPair(true) };
    const identities = {
      member: await identityPair(),
      alpha: agentPairs.alpha.publicKey,
      beta: agentPairs.beta.publicKey
    };
    await query(`INSERT INTO shared_identities(principal,public_key,private_key,display_name)
      VALUES($1,$2,NULL,$3),($4,$5,NULL,$6),($7,$8,NULL,$9)`, [
      `user:${member.userId}`, JSON.stringify(identities.member), 'Registered friend',
      `agent:${agents[0].id}`, JSON.stringify(identities.alpha), agents[0].name,
      `agent:${agents[1].id}`, JSON.stringify(identities.beta), agents[1].name
    ]);

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'isolated-guest-owner-browser-test', resave: false, saveUninitialized: false }));
    app.use(express.static(path.join(ROOT, 'public')));
    app.get('/guest', async (req, res, next) => {
      if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true' || process.env.FEATURE_GUEST_SHARING !== 'true') {
        return res.status(404).send('Not found');
      }
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      try {
        return res.send(await renderTemplate(path.join(ROOT, 'views/guest-shared.ejs'), { layout: false }));
      } catch (error) {
        return next(error);
      }
    });
    const { csrfProtection, validateCsrfToken } = require('../../src/middleware/csrfMiddleware');
    const { attachUserFromSession } = require('../../src/middleware/authMiddleware');
    app.get('/fixture/owner-login', (req, res) => {
      req.session.userId = owner.userId;
      req.session.email = owner.email;
      res.redirect('/shared');
    });
    for (const [route, template] of [['/shared', 'shared.ejs'], ['/guest-sharing', 'guest-sharing.ejs']]) {
      app.get(route, csrfProtection, async (req, res, next) => {
        try {
          const body = await renderTemplate(path.join(ROOT, 'views', template), {
            csrfToken: res.locals.csrfToken, userId: req.session.userId
          });
          res.send(await renderTemplate(path.join(ROOT, 'views/layout.ejs'), {
            body, user: { userId: req.session.userId, email: req.session.email },
            currentPath: route, pageBodyClass: route === '/shared' ? 'shared-page' : 'guest-sharing-page', cspNonce: 'fixture', title: 'Guest sharing browser test'
          }));
        } catch (error) { next(error); }
      });
    }
    // Agent enumeration is a fixture; all sharing, session and CSRF operations use
    // the real application middleware and routes.
    app.get('/api/user/agents', attachUserFromSession, (req, res) => res.json({
      agents: agents.map(agent => ({ agentId: agent.id, name: agent.name }))
    }));
    app.use('/api/user/shared', csrfProtection, validateCsrfToken, attachUserFromSession, require('../../src/shared/routes').users);
    app.use('/api/guest', guestRoutes.createGuestRouter({ rateLimiter: require('../../src/middleware/guestRateLimit').createGuestUnlockRateLimiter({ store: new TestStore(), keyPrefix: `guest-e2e-${uid()}` }) }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { message: error.message } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ headless: true });
    ownerContext = await browser.newContext();
    await ownerContext.addInitScript(key => localStorage.setItem('encryptionKey', key), crypto.randomBytes(32).toString('base64'));
    const ownerPage = await ownerContext.newPage();
    await ownerPage.route('https://**/*', route => route.abort());
    ownerPage.on('dialog', dialog => dialog.accept());
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const accountPage = await ownerContext.newPage();
    await accountPage.route('https://**/*', route => route.abort());
    const pageErrors = [];
    for (const page of [ownerPage, accountPage, pageA, pageB]) page.on('pageerror', error => pageErrors.push(error.message));

    await ownerPage.goto(`${baseUrl}/fixture/owner-login`);
    await ownerPage.locator('#sharedUnlock input').fill('Pilot owner');
    await ownerPage.getByRole('button', { name: 'Unlock shared chats', exact: true }).click();
    await ownerPage.locator('#sharedWorkspace').waitFor({ state: 'visible' });
    identities.owner = (await query('SELECT public_key FROM shared_identities WHERE principal=$1', [`user:${owner.userId}`])).rows[0].public_key;
    await ownerPage.goto(`${baseUrl}/guest-sharing`);
    for (const agent of agents.slice(0, 2)) await ownerPage.locator(`#guestAgentSelection input[value="${agent.id}"]`).check();
    await ownerPage.locator('#guestPasswordEnabled').check();
    await ownerPage.locator('#guestShareForm input[name="password"]').fill('pilot password 2026');
    await ownerPage.locator('#guestCreateShare').click();
    await ownerPage.locator('#guestCreatedLink').waitFor({ state: 'visible' });
    const link = await ownerPage.locator('#guestCreatedLinkValue').inputValue();
    const shareId = (await query('SELECT share_id FROM guest_shares WHERE owner_id=$1', [owner.userId])).rows[0].share_id;
    const share = { shareId, linkSecret: new URL(link).hash.slice(1) };
    assert.equal((await query('SELECT agent_id FROM guest_share_agents WHERE share_id=$1 AND removed_at IS NULL', [shareId])).rowCount, 2);
    assert.equal(await ownerPage.locator('#guestShareForm input[name="password"]').inputValue(), '');

    await pageA.goto(`${baseUrl}/guest#${share.linkSecret}`);
    await pageA.locator('#guestDisplayName').fill('Guest Alpha');
    await pageA.locator('#guestPassword').fill('pilot password 2026');
    await pageA.getByRole('button', { name: 'Join chat', exact: true }).click();
    await pageA.locator('#guestWorkspace').waitFor({ state: 'visible' });
    await pageA.locator('#guestRooms button').nth(1).waitFor();

    await pageB.goto(`${baseUrl}/guest#${share.linkSecret}`);
    await pageB.locator('#guestDisplayName').fill('Guest Beta');
    await pageB.locator('#guestPassword').fill('pilot password 2026');
    await pageB.getByRole('button', { name: 'Join chat', exact: true }).click();
    await pageB.locator('#guestWorkspace').waitFor({ state: 'visible' });
    await pageB.locator('#guestRooms button').nth(1).waitFor();

    const principals = (await query(`SELECT guest_id,display_name,public_key FROM guest_principals
      WHERE share_id=$1 ORDER BY display_name`, [share.shareId])).rows;
    assert.equal(principals.length, 2);
    const guestA = principals.find(row => row.display_name === 'Guest Alpha');
    const guestB = principals.find(row => row.display_name === 'Guest Beta');
    assert(guestA && guestB);
    const scopedRooms = (await query(`SELECT gsr.guest_id,gsr.agent_id,gsr.room_id,sc.key_version
      FROM guest_share_rooms gsr JOIN shared_conversations sc ON sc.id=gsr.room_id
      WHERE gsr.share_id=$1 ORDER BY gsr.guest_id,gsr.agent_id`, [share.shareId])).rows;
    assert.equal(scopedRooms.length, 4);
    assert.equal(new Set(scopedRooms.map(row => row.room_id)).size, 4);
    assert.deepEqual(new Set(scopedRooms.map(row => row.agent_id)), new Set(agents.slice(0, 2).map(agent => agent.id)));

    for (const row of scopedRooms) {
      await query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
        VALUES($1,$2,'participant','active',$3) ON CONFLICT DO NOTHING`, [row.room_id, member.userId, owner.userId]);
    }
    await ownerPage.locator('#guestRefreshShares').click();
    for (const name of ['Guest Alpha', 'Guest Beta']) {
      const audience = ownerPage.locator('.guest-share-audience li').filter({ hasText: name });
      await audience.getByRole('button', { name: 'Provision pending keys', exact: true }).click();
      await ownerPage.locator('#guestSharingStatus').filter({ hasText: `Encrypted keys provisioned for ${name}.` }).waitFor();
      assert.equal(await ownerPage.locator('#guestSharingError').textContent(), '');
    }
    const alphaAudience = ownerPage.locator('.guest-share-audience li').filter({ hasText: 'Guest Alpha' });
    await alphaAudience.getByRole('button', { name: 'Execution permissions', exact: true }).waitFor({ state: 'visible' });
    await alphaAudience.getByRole('button', { name: 'Execution permissions', exact: true }).click();
    await alphaAudience.getByRole('button', { name: 'Grant read-only execution', exact: true }).click();
    await ownerPage.locator('#guestSharingStatus').filter({ hasText: 'Scoped execution access granted.' }).waitFor();
    const createdGrant = (await query('SELECT * FROM agent_share_grants WHERE grantee_id=$1 AND status=$2', [guestA.guest_id, 'active'])).rows;
    assert.equal(createdGrant.length, 1);
    assert.equal(createdGrant[0].device_id, executionDevice.device_id);
    assert.equal(createdGrant[0].room_id, scopedRooms.find(row => row.guest_id === guestA.guest_id && row.agent_id === agents[0].id).room_id);
    assert.deepEqual(createdGrant[0].actions, ['workspace.read', 'workspace.execute']);
    assert.deepEqual(createdGrant[0].destinations, []);
    await alphaAudience.getByRole('button', { name: 'Revoke execution access', exact: true }).click();
    await ownerPage.locator('#guestSharingStatus').filter({ hasText: 'Execution access revoked.' }).waitFor();
    assert.equal((await query('SELECT status FROM agent_share_grants WHERE grant_id=$1', [createdGrant[0].grant_id])).rows[0].status, 'revoked');
    await waitFor(async () => await alphaAudience.getByRole('button', { name: 'Revoke execution access', exact: true }).count() === 0, 'Guest permission panel did not finish refreshing');
    await alphaAudience.locator('select[name="executionRequester"]').selectOption('user');
    await alphaAudience.getByRole('button', { name: 'Grant read-only execution', exact: true }).click();
    await waitFor(async () => (await query("SELECT grant_id FROM agent_share_grants WHERE grantee_id=$1 AND status='active'", [owner.userId])).rowCount === 1, 'Owner scoped execution grant was not stored');
    const ownerGrant = (await query("SELECT * FROM agent_share_grants WHERE grantee_id=$1 AND status='active'", [owner.userId])).rows[0];
    assert.equal(ownerGrant.grantee_kind, 'user');
    assert.equal(ownerGrant.room_id, createdGrant[0].room_id);
    assert.equal(ownerGrant.device_id, executionDevice.device_id);
    assert.deepEqual(ownerGrant.actions, ['workspace.read', 'workspace.execute']);
    assert.deepEqual(ownerGrant.destinations, []);
    await alphaAudience.getByRole('button', { name: 'Revoke execution access', exact: true }).click();
    await waitFor(async () => (await query('SELECT status FROM agent_share_grants WHERE grant_id=$1', [ownerGrant.grant_id])).rows[0].status === 'revoked', 'Owner scoped grant was not revoked');
    const keys = new Map();
    for (const row of scopedRooms) {
      const envelope = (await query('SELECT wrapped_key FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2 AND key_version=1', [row.room_id, `agent:${row.agent_id}`])).rows[0];
      const pair = row.agent_id === agents[0].id ? agentPairs.alpha : agentPairs.beta;
      keys.set(`${row.guest_id}:${row.agent_id}`, await C.unwrap(envelope.wrapped_key, pair.privateKey));
    }

    await pageA.reload();
    await pageB.reload();
    await pageA.locator('#guestComposer').waitFor({ state: 'visible' });
    await pageB.locator('#guestComposer').waitFor({ state: 'visible' });
    await pageA.locator('#guestPeopleButton').click();
    await pageA.getByText('Registered friend · participant · registered account', { exact: true }).waitFor();
    await pageA.getByRole('button', { name: 'Close people', exact: true }).click();
    assert.equal(await pageA.getByText('Unselected Agent', { exact: true }).count(), 0);

    const alphaRoomA = scopedRooms.find(row => row.guest_id === guestA.guest_id && row.agent_id === agents[0].id);
    const alphaRoomB = scopedRooms.find(row => row.guest_id === guestB.guest_id && row.agent_id === agents[0].id);
    assert(alphaRoomA && alphaRoomB && alphaRoomA.room_id !== alphaRoomB.room_id);
    await pageA.locator('#guestMessage').fill('Private guest room message');
    await pageA.locator('#guestComposer button[type="submit"]').click();
    await pageA.getByText('Private guest room message', { exact: true }).waitFor();
    await pageB.waitForTimeout(1000);
    assert.equal(await pageB.getByText('Private guest room message', { exact: true }).count(), 0);
    const denied = await pageB.evaluate(roomId => fetch(`/api/guest/rooms/${roomId}/messages?after=0`).then(response => response.status), alphaRoomA.room_id);
    assert.equal(denied, 404);

    // A real provider subprocess receives the decrypted, attributed guest turn.
    // It is a local fixture, so this makes no live-provider compatibility claim.
    const service = require('../../src/shared/service');
    const tasks = require('../../src/shared/taskAuthority');
    const { SharedRunner } = require('../../scripts/shared-agent-runner');
    const { Bridge } = require('../../scripts/external-agent-bridge');
    runnerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-sharing-e2e-'));
    const bridge = new Bridge({ version: 1, baseUrl, agentName: agents[0].name, agentId: agents[0].id,
      token: 'synthetic-credential', key: crypto.randomBytes(32).toString('base64'), history: {}, pending: null },
    { file: path.join(runnerDirectory, 'state.json'), runtimeKey: 'synthetic' });
    const trustedRunner = new SharedRunner(bridge, [{ provider: 'antigravity', model: 'owner-test-choice', managedRunner: true,
      command: [process.execPath, '-e', `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(!input.includes('Guest Alpha')||!input.includes('${guestA.guest_id}')||!input.includes('trusted collaborators'))process.exit(2);process.stdout.write(JSON.stringify({replies:[{text:'Trusted agent reply for Guest Alpha'}]}));});`] }],
    { protocolVersion: 2, executionMode: 'trusted' });
    const runtimeId = trustedRunner.runtimeId;
    trustedRunner.agentId = agents[0].id;
    trustedRunner.privateKey = agentPairs.alpha.privateKey;
    trustedRunner.api = async (route, body) => {
      if (route === '/runtime') return service.registerRuntime(agents[0].id, body);
      if (route === '/claim') return service.claim(agents[0].id, runtimeId);
      if (route === '/release') return service.release(agents[0].id, runtimeId, body.executionId, body.uncertain);
      if (route.endsWith('/authorization')) return tasks.authorize({ agentId: agents[0].id, runtimeId }, route.split('/')[2]);
      if (route.startsWith('/batches/') && route.endsWith('/read')) return service.markBatchRead(agents[0].id, runtimeId, route.split('/')[2], body);
      if (route.startsWith('/batches/')) return route.endsWith('/finish')
        ? service.finish(agents[0].id, runtimeId, route.split('/')[2], body)
        : service.agentBatch(agents[0].id, runtimeId, route.split('/')[2]);
      if (route.includes('/messages?')) return service.agentHistory(agents[0].id, route.split('/')[1], new URLSearchParams(route.split('?')[1]).get('after'), runtimeId);
      return service.agentDetails(agents[0].id, route.slice(1), runtimeId);
    };
    await trustedRunner.register();
    assert.equal(await trustedRunner.sharedTurn(), true);
    await pageA.getByText('Trusted agent reply for Guest Alpha', { exact: true }).waitFor();
    assert.equal(await pageB.getByText('Trusted agent reply for Guest Alpha', { exact: true }).count(), 0);
    const trustedTask = (await query('SELECT state,grant_id FROM shared_tasks WHERE agent_id=$1', [agents[0].id])).rows[0];
    assert.equal(trustedTask.state, 'completed');
    assert.equal(trustedTask.grant_id, null);

    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZUAAAAASUVORK5CYII=', 'base64');
    await pageA.locator('#guestFiles').setInputFiles([
      { name: 'pilot.png', mimeType: 'image/png', buffer: photo },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('guest notes') }
    ]);
    await pageA.locator('#guestMessage').fill('Photo and file upload');
    await pageA.locator('#guestComposer button[type="submit"]').click();
    await pageA.getByRole('button', { name: 'Download pilot.png', exact: true }).waitFor();
    await pageA.getByRole('button', { name: 'View image', exact: true }).click();
    await pageA.waitForFunction(() => document.querySelector('.guest-attachment-preview')?.naturalWidth > 0);
    const downloadPromise = pageA.waitForEvent('download');
    await pageA.getByRole('button', { name: 'Download pilot.png', exact: true }).click();
    const downloaded = await downloadPromise;
    assert.deepEqual(await downloaded.createReadStream().then(stream => new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    })), photo);

    const roomKey = keys.get(`${guestA.guest_id}:${agents[0].id}`);
    const questionId = await insertAgentMessage(query, {
      roomId: alphaRoomA.room_id,
      agentId: agents[0].id,
      kind: 'question',
      payload: await C.encrypt(roomKey, { text: 'Choose an outcome', options: ['Approve', 'Decline'] }, `${alphaRoomA.room_id}:1`)
    });
    const richId = await insertAgentMessage(query, {
      roomId: alphaRoomA.room_id,
      agentId: agents[0].id,
      kind: 'message',
      payload: await C.encrypt(roomKey, { text: JSON.stringify({
        type: 'rich_interactive',
        title: 'Pilot form',
        html: '<form class="rich-content-form"><label>Decision <input name="decision" value="Ready"></label><button type="submit">Send response</button><script>alert(1)</script></form>'
      }) }, `${alphaRoomA.room_id}:1`)
    });
    const guestOnlyQuestion = await insertAgentMessage(query, {
      roomId: alphaRoomA.room_id, agentId: agents[0].id, kind: 'question',
      payload: await C.encrypt(roomKey, { text: 'Question for Guest Alpha', options: ['Guest choice'] }, `${alphaRoomA.room_id}:1`)
    });
    await query('UPDATE shared_messages SET addressed_to_principals=$2 WHERE id=$1', [guestOnlyQuestion, JSON.stringify([{ kind: 'guest', id: guestA.guest_id }])]);
    await accountPage.goto(`${baseUrl}/shared`);
    await accountPage.locator('#sharedUnlock input').fill('Pilot owner');
    await accountPage.getByRole('button', { name: 'Unlock shared chats', exact: true }).click();
    await accountPage.locator('#sharedWorkspace').waitFor({ state: 'visible' });
    await accountPage.waitForFunction(() => !document.querySelector('#sharedUnlock button').disabled);
    const roomTitle = (await query('SELECT title FROM shared_conversations WHERE id=$1', [alphaRoomA.room_id])).rows[0].title;
    await accountPage.locator('#sharedRooms button').filter({ hasText: `${roomTitle} — ${agents[0].name}` }).click();
    await accountPage.getByText('Private guest room message', { exact: true }).waitFor();
    await accountPage.getByText('Trusted agent reply for Guest Alpha', { exact: true }).waitFor();
    await accountPage.getByText('Question for Guest Alpha', { exact: true }).waitFor();
    assert.equal(await accountPage.getByRole('button', { name: 'Guest choice', exact: true }).count(), 0);
    assert((await accountPage.locator('#sharedTimeline strong').allTextContents()).some(text => text.startsWith('Guest Alpha · ') && text.includes(' · guest')));
    await accountPage.locator('form.rich-content-form input[name="decision"]').fill('Owner form response');
    await accountPage.waitForTimeout(5500);
    assert.equal(await accountPage.locator('form.rich-content-form input[name="decision"]').inputValue(), 'Owner form response');
    await accountPage.locator('form.rich-content-form button[type="submit"]').click();
    await waitFor(async () => (await query('SELECT id FROM shared_messages WHERE sender_user_id=$1 AND reply_to @> ARRAY[$2]::uuid[]', [owner.userId, richId])).rowCount === 1, 'Owner rich form response was not stored');
    assert.equal(await accountPage.locator('#sharedTimeline script').count(), 0);
    assert.equal(await accountPage.locator('#sharedTimeline [onclick]').count(), 0);
    await accountPage.getByRole('button', { name: 'Download pilot.png', exact: true }).waitFor();
    const accountAnswerDenied = await accountPage.evaluate(({ roomId, questionId, id, payload }) => fetch(`/api/user/shared/${roomId}/questions/${questionId}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.querySelector('#sharedApp').dataset.csrf },
      body: JSON.stringify({ id, keyVersion: 1, payload })
    }).then(response => response.status), { roomId: alphaRoomA.room_id, questionId: guestOnlyQuestion, id: uid(), payload: await C.encrypt(roomKey, { text: 'Unauthorized account answer' }, `${alphaRoomA.room_id}:1`) });
    assert.equal(accountAnswerDenied, 403);
    await pageA.reload();
    await pageA.getByRole('button', { name: 'Guest choice', exact: true }).click();
    await waitFor(async () => (await query('SELECT id FROM shared_messages WHERE question_id=$1', [guestOnlyQuestion])).rowCount === 1, 'Typed guest question was not answered');
    await pageA.getByText('Choose an outcome', { exact: true }).waitFor();
    await pageA.getByRole('button', { name: 'Approve', exact: true }).click();
    await waitFor(async () => (await query('SELECT id FROM shared_messages WHERE question_id=$1', [questionId])).rows.length === 1, 'Guest question answer was not stored');
    await pageA.locator('form.rich-content-form input[name="decision"]').fill('Approved safely');
    await pageA.waitForTimeout(5500);
    assert.equal(await pageA.locator('form.rich-content-form input[name="decision"]').inputValue(), 'Approved safely');
    await pageA.locator('form.rich-content-form button[type="submit"]').click();
    await waitFor(async () => (await query(`SELECT id FROM shared_messages WHERE conversation_id=$1 AND reply_to @> ARRAY[$2]::uuid[] AND sender_guest_id=$3`, [alphaRoomA.room_id, richId, guestA.guest_id])).rows.length === 1, 'Rich form reply was not stored')
      .catch(async error => { throw new Error(error.message + ': ' + await pageA.locator('#guestConversationStatus').textContent()); });
    assert.equal(await pageA.locator('#guestTimeline script').count(), 0);
    assert.equal(await pageA.locator('#guestTimeline [onclick]').count(), 0);

    // Real authority/approval/cancellation APIs with no launched executor. This
    // verifies browser behavior; it is not provider or process-stoppage evidence.
    const authority = require('../../src/shared/authorization');
    await authority.createGrant(owner.userId, { agentId: agents[0].id, roomId: alphaRoomA.room_id,
      deviceId: executionDevice.device_id, granteeKind: 'guest', granteeId: guestA.guest_id, workspaceAlias: 'Pilot project',
      actions: ['workspace.read', 'workspace.execute'], resources: ['Pilot project'], destinations: [],
      budget: { maxRuntimeMs: 300000 }, approvalPolicy: { requiresApproval: ['workspace.execute'] } });
    await service.registerRuntime(agents[0].id, { runtimeId, protocol: 2, deviceId: executionDevice.device_id,
      profiles: [{ provider: 'browser-fixture', model: 'no-inference' }] });
    const taskBatch = await service.claim(agents[0].id, runtimeId);
    assert.equal(taskBatch.context.request.requester.id, guestA.guest_id);
    const receiptSourceId = taskBatch.messages.find(message => message.sender_guest_id === guestA.guest_id).id;
    const guestReceiptSelector = `[data-message-id="${receiptSourceId}"] .message-read-indicator`;
    assert.equal(await pageA.locator(guestReceiptSelector).textContent(), '✓✓');
    assert.equal(await pageA.locator(guestReceiptSelector).getAttribute('data-receipt-state'), 'delivered');
    assert.equal(await pageA.locator(guestReceiptSelector).evaluate(node => getComputedStyle(node).color), 'rgb(148, 163, 184)');
    await pageA.locator('#guestMessage').fill('Keep guest receipt draft');
    await pageA.evaluate(id => {
      window.receiptTestArticle = [...document.querySelectorAll('#guestTimeline [data-message-id]')].find(node => node.dataset.messageId === id);
      window.receiptTestImage = document.createElement('img');
      window.receiptTestImage.style.cssText = 'position:absolute;width:1px;height:1px;pointer-events:none';
      window.receiptTestArticle.append(window.receiptTestImage);
    }, receiptSourceId);
    await service.markBatchRead(agents[0].id, runtimeId, taskBatch.id, { messageIds: taskBatch.messages.map(message => message.id) });
    await pageA.waitForFunction(selector => document.querySelector(selector)?.dataset.receiptState === 'read', guestReceiptSelector);
    assert.equal(await pageA.locator(guestReceiptSelector).evaluate(node => getComputedStyle(node).color), 'rgb(56, 189, 248)');
    assert.equal(await pageA.locator('#guestMessage').inputValue(), 'Keep guest receipt draft');
    assert(await pageA.evaluate(() => window.receiptTestImage.isConnected && window.receiptTestArticle.contains(window.receiptTestImage)));
    assert.equal((await service.agentBatch(agents[0].id, runtimeId, taskBatch.id)).status, 'processing');
    await pageA.locator('#guestMessage').fill('');
    const runtime = { agentId: agents[0].id, runtimeId };
    const pendingAction = await tasks.propose(runtime, taskBatch.id, { actionId: uid(), name: 'workspace.execute',
      resource: 'Pilot project', parameters: { argv: ['node', 'fixture-only-<script>'] } });
    await accountPage.locator('#sharedTasks').waitFor({ state: 'visible' });
    await accountPage.locator('#sharedTasks summary').click();
    await accountPage.getByRole('button', { name: 'Approve action', exact: true }).click();
    await waitFor(async () => (await query('SELECT approval_state FROM shared_task_actions WHERE action_id=$1', [pendingAction.actionId])).rows[0].approval_state === 'approved', 'Owner action approval was not retained');
    await pageA.locator('#guestTasks').waitFor({ state: 'visible' });
    await pageA.locator('#guestTasks summary').click();
    assert.equal(await pageA.getByRole('button', { name: 'Approve action', exact: true }).count(), 0);
    assert.equal(await pageA.getByText('fixture-only-<script>', { exact: false }).count(), 0);
    await pageA.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await pageA.getByText('Stopping — confirmation pending', { exact: true }).waitFor();
    assert.equal((await query('SELECT state FROM shared_tasks WHERE task_id=$1', [taskBatch.id])).rows[0].state, 'cancellation_requested');
    assert.equal((await query('SELECT approval_state FROM shared_task_actions WHERE action_id=$1', [pendingAction.actionId])).rows[0].approval_state, 'revoked');
    // The fixture never launched a process, so no container can still be running.
    await tasks.confirmCancellation(runtime, taskBatch.id, { confirmedStopped: true });
    await pageA.locator('#guestTasks').getByText('Stopped', { exact: true }).waitFor();
    await pageA.locator('#guestTasks').evaluate(element => { element.open = false; });

    const screenshots = path.join(ROOT, 'tmp/guest-sharing');
    fs.mkdirSync(screenshots, { recursive: true });
    await accountPage.locator('#sharedTasks').evaluate(element => { element.open = false; });
    await accountPage.screenshot({ path: path.join(screenshots, 'owner-desktop.png'), fullPage: true });
    await pageA.screenshot({ path: path.join(screenshots, 'guest-desktop.png'), fullPage: true });
    await pageA.setViewportSize({ width: 390, height: 844 });
    assert(await pageA.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Guest layout overflows mobile width');
    assert(await pageA.locator('#guestComposer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), 'Guest composer is outside the mobile viewport');
    await pageA.locator('#guestMessage').fill('Keep my mobile draft');
    await pageA.getByRole('button', { name: 'Back to shared agents', exact: true }).click();
    await pageA.locator('#guestRooms button').first().click();
    assert.equal(await pageA.locator('#guestMessage').inputValue(), 'Keep my mobile draft');
    const betaRoomA = scopedRooms.find(row => row.guest_id === guestA.guest_id && row.agent_id === agents[1].id);
    await pageA.getByRole('button', { name: 'Back to shared agents', exact: true }).click();
    await Promise.all([
      pageA.waitForResponse(response => response.url().includes(`/rooms/${betaRoomA.room_id}/messages?`)),
      pageA.locator(`#guestRooms button[data-chat-room="${betaRoomA.room_id}"]`).click()
    ]);
    assert.equal(await pageA.getByText('Private guest room message', { exact: true }).count(), 0);
    assert.equal(await pageA.locator('#guestMessage').inputValue(), '');
    await pageA.getByRole('button', { name: 'Back to shared agents', exact: true }).click();
    await pageA.locator(`#guestRooms button[data-chat-room="${alphaRoomA.room_id}"]`).click();
    await pageA.getByText('Private guest room message', { exact: true }).waitFor();
    assert.equal(await pageA.locator('#guestMessage').inputValue(), 'Keep my mobile draft');
    await pageA.screenshot({ path: path.join(screenshots, 'guest-mobile.png'), fullPage: true });
    await pageA.locator('#guestPeopleButton').click();
    await pageA.locator('#guestAudienceDialog').waitFor({ state: 'visible' });
    assert.equal(await pageA.locator('[data-guest-people-count]').textContent(), String(await pageA.locator('#guestAudience > span').count()));
    await pageA.screenshot({ path: path.join(screenshots, 'guest-people-mobile.png'), fullPage: true });
    await pageA.keyboard.press('Escape');
    await pageA.locator('#guestAudienceDialog').waitFor({ state: 'hidden' });
    assert(await pageA.locator('#guestPeopleButton').evaluate(button => button === document.activeElement), 'Closing people should restore keyboard focus');
    assert.equal(await pageA.locator('#guestMessage').inputValue(), 'Keep my mobile draft');
    await pageA.locator('#guestMessage').fill('');
    // Expanded activity panels and short viewports must never cover
    // the guest's composer. Hit-testing catches clipping that visibility misses.
    await pageA.locator('#guestTasks').evaluate(element => { element.open = true; });
    for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 },
      { width: 390, height: 500 }, { width: 320, height: 568 }]) {
      await pageA.setViewportSize(viewport);
      const reachable = await pageA.locator('#guestComposer button[type="submit"]').evaluate(button => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth
          && (hit === button || button.contains(hit));
      });
      assert(reachable, `Expanded guest panels cover the send button at ${viewport.width}×${viewport.height}`);
      assert(await pageA.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Guest composer overflows the viewport width');
      await pageA.locator('.chat-send-label').waitFor({ state: 'visible' });
    }
    await pageA.locator('#guestTasks').evaluate(element => { element.open = false; });
    await pageA.setViewportSize({ width: 1280, height: 720 });

    // Retain a failed encrypted request, rotate the room, then retry its original
    // message/file IDs. The transport fault is injected; crypto and DB are real.
    const messageRoute = `**/api/guest/rooms/${alphaRoomA.room_id}/messages`;
    await pageA.route(messageRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture transport interruption' } }) }));
    await pageA.locator('#guestFiles').setInputFiles([{ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retained encrypted file') }]);
    await pageA.locator('#guestMessage').fill('Retry after rotation');
    await pageA.locator('#guestComposer button[type="submit"]').click();
    await pageA.getByText('Fixture transport interruption The encrypted message is retained for retry.', { exact: true }).waitFor();
    const pendingId = await pageA.evaluate(() => {
      const entry = Object.keys(sessionStorage).find(key => key.endsWith(':message'));
      return JSON.parse(sessionStorage.getItem(entry)).id;
    });
    await pageA.unroute(messageRoute);
    const removedStatus = await ownerPage.evaluate(({ roomId, memberId }) => fetch(`/api/user/shared/${roomId}/members/${memberId}`, {
      method: 'DELETE', headers: { 'x-csrf-token': document.querySelector('#guestSharingApp').dataset.csrf }
    }).then(response => response.status), { roomId: alphaRoomA.room_id, memberId: member.userId });
    assert.equal(removedStatus, 200);
    await ownerPage.locator('#guestRefreshShares').click();
    await ownerPage.locator('.guest-share-audience li').filter({ hasText: 'Guest Alpha' })
      .getByRole('button', { name: 'Provision pending keys', exact: true }).click();
    await ownerPage.locator('#guestSharingStatus').filter({ hasText: 'Encrypted keys provisioned for Guest Alpha.' }).waitFor().catch(async error => {
      console.error('Guest reprovisioning failed:', await ownerPage.locator('#guestSharingError').textContent(),
        'Status:', await ownerPage.locator('#guestSharingStatus').textContent());
      throw error;
    });
    const rotatedEnvelope = (await query('SELECT wrapped_key FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2 AND key_version=2', [alphaRoomA.room_id, `agent:${agents[0].id}`])).rows[0];
    const rotatedKey = await C.unwrap(rotatedEnvelope.wrapped_key, agentPairs.alpha.privateKey);
    await pageA.reload();
    await pageA.locator('#guestComposer').waitFor({ state: 'visible' });
    await pageA.locator('#guestMessage').fill('Retry saved request');
    await pageA.locator('#guestComposer button[type="submit"]').click();
    await pageA.getByText('Retry after rotation', { exact: true }).waitFor();
    const retried = (await query('SELECT id,key_version,payload FROM shared_messages WHERE id=$1', [pendingId])).rows;
    assert.equal(retried.length, 1);
    assert.equal(retried[0].key_version, 2);
    assert.equal((await C.decrypt(rotatedKey, retried[0].payload, `${alphaRoomA.room_id}:2`)).text, 'Retry after rotation');
    const retriedFile = (await query('SELECT key_version,bytes FROM shared_files WHERE message_id=$1', [pendingId])).rows[0];
    assert.equal(retriedFile.key_version, 2);
    const bytes = new Uint8Array(retriedFile.bytes);
    const decryptedFile = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: Buffer.from(`${alphaRoomA.room_id}:2`) }, rotatedKey, bytes.slice(12));
    assert.equal(Buffer.from(decryptedFile).toString(), 'retained encrypted file');

    process.env.FEATURE_GUEST_SHARING = 'false';
    const flagDenied = await pageA.evaluate(() => fetch('/api/guest/session').then(response => response.status));
    assert.equal(flagDenied, 404);
    process.env.FEATURE_GUEST_SHARING = 'true';
    await pageA.reload();
    await pageA.locator('#guestWorkspace').waitFor({ state: 'visible' });
    await ownerPage.locator('.guest-share-audience li').filter({ hasText: 'Guest Beta' })
      .getByRole('button', { name: 'Remove guest', exact: true }).click();
    await ownerPage.locator('#guestSharingStatus').filter({ hasText: 'Guest removed.' }).waitFor();
    assert.equal(await pageB.evaluate(() => fetch('/api/guest/session').then(response => response.status)), 401);
    assert.equal(await pageA.evaluate(() => fetch('/api/guest/session').then(response => response.status)), 200);
    await ownerPage.getByRole('button', { name: 'Revoke share', exact: true }).click();
    await ownerPage.locator('#guestSharingStatus').filter({ hasText: 'Guest share revoked.' }).waitFor();
    assert.equal(await pageA.evaluate(() => fetch('/api/guest/session').then(response => response.status)), 401);
    assert.deepEqual(pageErrors, []);
    console.log('PASS: owner and two guest browsers; encrypted onboarding, scoped execution grants/revocation, exact owner action approval and requester cancellation UI (no executor launched), desktop/mobile chat and draft navigation, member-removal rotation, guest/share revocation, selected-agent enforcement, registered audience, typed questions, encrypted photo/file transfer, rich-form sanitization, cross-guest denial, retry/file rekey and feature-flag denial.');
  } finally {
    await ownerContext?.close();
    await contextA?.close();
    await contextB?.close();
    await browser?.close();
    if (runnerDirectory) fs.rmSync(runnerDirectory, { recursive: true, force: true });
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
    delete process.env.FEATURE_SHARED_CONVERSATIONS;
    delete process.env.FEATURE_GUEST_SHARING;
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
