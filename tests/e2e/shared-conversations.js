#!/usr/bin/env node
// Disposable database + real browsers + real API/crypto. No production data or LLM calls.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('../../public/js/shared-crypto');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const { assetUrl } = require('../../src/utils/assetUrl');
const renderTemplate = (file, data = {}) => ejs.renderFile(file, { assetUrl, ...data });
const {
  Pool
} = require('pg');
const {
  chromium
} = require('@playwright/test');
const assert = require('assert/strict');
const {
  seedUser
} = require('../utils/pgMemTestUtils');
const {
  Bridge
} = require('../../scripts/external-agent-bridge');
const {
  SharedRunner
} = require('../../scripts/shared-agent-runner');
async function main() {
  if (!process.env.SHARED_TEST_DATABASE_URL) throw new Error('Provide a disposable SHARED_TEST_DATABASE_URL; this test creates/drops only its own schema');
  const schema = 'shared_e2e_' + crypto.randomUUID().replace(/-/g, '');
  const admin = new Pool({
    connectionString: process.env.SHARED_TEST_DATABASE_URL
  });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({
    connectionString: process.env.SHARED_TEST_DATABASE_URL,
    options: '-c search_path=' + schema
  });
  const query = (sql, args) => pool.query(sql, args);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-e2e-'));
  let server, browser, menuContext;
  try {
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/037_add_scheduled_user_messages.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/042_add_shared_conversations.sql'), 'utf8'));
    for (const migration of [
      '043_add_agent_devices_and_share_grants.sql', '044_add_shared_task_context.sql',
      '045_add_guest_principals_and_membership.sql', '046_add_message_run_overrides.sql',
      '047_add_guest_separate_rooms.sql', '048_enforce_guest_room_relationships.sql',
      '049_retain_guest_history_attribution.sql', '050_bind_guest_request_revisions.sql',
      '051_retain_shared_task_attempts.sql', '052_bound_guest_file_storage.sql',
      '053_bind_shared_action_approvals.sql'
    ]) await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', migration), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/054_add_agent_chat_threads.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/055_add_shared_history_imports.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/056_add_conversation_invitations.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/057_add_shared_message_recipients.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/058_add_shared_agent_read_receipts.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/064_add_sharing_switch.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/065_guest_approval_and_limits.sql'), 'utf8'));
    await query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/066_guest_link_requests.sql'), 'utf8'));
    const dbPath = require.resolve('../../src/db/connection');
    require.cache[dbPath] = {
      id: dbPath,
      filename: dbPath,
      loaded: true,
      exports: {
        query,
        getClient: () => pool.connect()
      }
    };
    const alice = await seedUser(query, {
        email: 'alice@example.test'
      }),
      bob = await seedUser(query, {
        email: 'bob@example.test'
      });
    const privateAttachmentBytes = Buffer.from('captured private attachment bytes');
    const privateAttachmentId = crypto.randomUUID();
    const privateAttachmentStore = new Map([[privateAttachmentId, privateAttachmentBytes]]);
    const agentId = crypto.randomUUID();
    const privateAgentId = crypto.randomUUID();
    await query("INSERT INTO agents(agent_id,user_id,agent_name,position,runtime_config) VALUES($1,$2,'Design Agent',0,$3)", [agentId, alice.userId, JSON.stringify({
      model_provider: 'fixture',
      model: 'test'
    })]);
    const token = await require('../../src/services/agentCredentialService').issueScopedCredential({
      agentId,
      scopes: ['agent.messages.write', 'agent.responses.read']
    });
    process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
    process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
    const {
      users,
      agents
    } = require('../../src/shared/routes');
    const {
      csrfProtection,
      validateCsrfToken
    } = require('../../src/middleware/csrfMiddleware');
    const {
      attachUserFromSession,
      requireApiKey
    } = require('../../src/middleware/authMiddleware');
    const guestRoutes = require('../../src/shared/guestRoutes');
    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'isolated-shared-browser-test',
      resave: false,
      saveUninitialized: false
    }));
    app.use(express.static(path.join(__dirname, '../../public')));
    // Isolated fixture only: expire a long-open browser session without waiting
    // two hours, while exercising the real production CSRF middleware below.
    // Multiple tabs share this session. A background GET can refresh it before
    // sharing starts, so arm expiry for the next resolve validation as well.
    const expireNextResolve = new Set();
    app.post('/fixture/expire-csrf', (req, res) => {
      expireNextResolve.add(req.sessionID);
      req.session.csrfTokenIssuedAt = Date.now() - 24 * 60 * 60 * 1000;
      res.cookie('csrfTokenIssuedAt', String(req.session.csrfTokenIssuedAt), { path: '/' });
      res.json({ ok: true });
    });
    app.get('/csrf-token', csrfProtection, (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ csrfToken: req.session.csrfToken });
    });
    app.get('/fixture/dashboard', csrfProtection, async (req, res, next) => {
      try {
        const dashboardUser = req.session.userId === bob.userId ? bob : alice;
        const body = await renderTemplate(path.join(__dirname, '../../views/dashboard.ejs'), {
          agents: (await query('SELECT agent_id,agent_name,position FROM agents WHERE user_id=$1 ORDER BY position', [dashboardUser.userId])).rows.map(row => ({ agentId: row.agent_id, name: row.agent_name, position: row.position, highestPriority: 'low', unreadCount: 0, marbleSvg: '' })),
          encryptionSalt: '', isGoogleAuth: false, groups: [], csrfToken: res.locals.csrfToken, cspNonce: 'fixture',
          user: { userId: dashboardUser.userId, email: dashboardUser.email },
          featureInPlaceAgentSharing: req.query.legacy !== '1',
          DeviceBadge: require('../../public/js/device-badge'),
          safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
        });
        res.send(await renderTemplate(path.join(__dirname, '../../views/layout.ejs'), {
          body: req.query.locked === '1'
            ? '<script nonce="fixture">localStorage.removeItem("encryptionKey");sessionStorage.removeItem("encryptionKey");</script>' + body
            : body,
          user: { userId: dashboardUser.userId, email: dashboardUser.email }, currentPath: '/dashboard',
          pageBodyClass: 'dashboard-page', cspNonce: 'fixture', title: 'Agent sharing menu'
        }));
      } catch (e) { next(e); }
    });
    app.get('/fixture/login', (req, res) => {
      req.session.userId = req.query.user === 'bob' ? bob.userId : alice.userId;
      req.session.email = req.query.user === 'bob' ? bob.email : alice.email;
      res.redirect('/shared');
    });
    app.get('/guest', async (_req, res, next) => {
      try { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.send(await renderTemplate(path.join(__dirname, '../../views/guest-shared.ejs'), {})); }
      catch (error) { next(error); }
    });
    app.get('/shared', csrfProtection, async (req, res, next) => {
      try {
        const body = await renderTemplate(path.join(__dirname, '../../views/shared.ejs'), {
          csrfToken: res.locals.csrfToken
        });
        const html = await renderTemplate(path.join(__dirname, '../../views/layout.ejs'), {
          body,
          user: {
            userId: req.session.userId,
            email: req.session.email
          },
          currentPath: '/shared',
          pageBodyClass: 'shared-page',
          cspNonce: 'fixture',
          title: 'Shared conversations'
        });
        res.send(html);
      } catch (e) {
        next(e);
      }
    });
    // The shared-chat picker now loads owned agents separately from the shared
    // runtime list. Keep enumeration synthetic; sharing/auth routes stay real.
    app.get('/api/user/agents', attachUserFromSession, async (req, res) => res.json({
      agents: (await query('SELECT agent_id,agent_name,position FROM agents WHERE user_id=$1 ORDER BY position', [req.user?.userId])).rows.map(row => ({ agentId: row.agent_id, name: row.agent_name, position: row.position }))
    }));
    // Exercise the existing owner-authorized private attachment URL while the
    // browser decrypts/re-encrypts history. The fixture stores only ciphertext.
    app.get('/api/user/attachments/:attachmentId', attachUserFromSession, async (req, res) => {
      const owned = await query(`SELECT a.attachment_id FROM attachments a JOIN agents ag ON ag.agent_id=a.agent_id
        WHERE a.attachment_id=$1 AND ag.user_id=$2`, [req.params.attachmentId, req.user?.userId]);
      const bytes = privateAttachmentStore.get(req.params.attachmentId);
      if (!owned.rowCount || !bytes) return res.sendStatus(404);
      res.type('application/octet-stream').send(bytes);
    });
    app.use('/api/user/shared', csrfProtection, validateCsrfToken, attachUserFromSession, users);
    app.use('/api/user/chat-threads', csrfProtection, (req, _res, next) => {
      if (req.method === 'POST' && req.path === '/resolve' && expireNextResolve.delete(req.sessionID)) {
        // Advance the valid request token's age at the validation boundary.
        // The real validator must reject it and the real client must refresh.
        req.session.csrfToken = req.headers['x-csrf-token'];
        req.session.csrfTokenIssuedAt = Date.now() - 24 * 60 * 60 * 1000;
      }
      next();
    }, validateCsrfToken, attachUserFromSession, require('../../src/shared/chatThreadRoutes'));
    const guestRateValues = new Map();
    const guestRateStore = {
      isReady: true,
      async incr(key) { const value = (guestRateValues.get(key) || 0) + 1; guestRateValues.set(key, value); return value; },
      async pExpire() { return 1; }, async pTTL() { return 60000; }
    };
    app.use('/api/guest', guestRoutes.createGuestRouter({ rateLimiter: require('../../src/middleware/guestRateLimit').createGuestUnlockRateLimiter({ store: guestRateStore, keyPrefix: `in-place-e2e-${crypto.randomUUID()}` }) }));
    app.use('/api/agent', requireApiKey);
    app.use('/api/agent/shared', agents);
    app.use((e, req, res, next) => {
      console.error('Fixture error:', e.message);
      res.status(e.status || 500).json({
        error: {
          message: e.message
        }
      });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const key = crypto.randomBytes(32).toString('base64'),
      state = {
        version: 1,
        baseUrl,
        agentId,
        agentName: 'Design Agent',
        token: token.token,
        key,
        history: {},
        pending: null
      };
    let seen = [];
    const bridge = new Bridge(state, {
      file: path.join(directory, 'runner.json'),
      attachmentDir: path.join(directory, 'files')
    });
    const runner = new SharedRunner(bridge, [{
      provider: 'fixture',
      model: 'test',
      command: ['node', 'fixture']
    }], {
      invoke: async (profile, messages, conversation) => {
        const transcript = JSON.parse(messages[1].content);
        seen.push({
          conversation,
          transcript
        });
        return JSON.stringify({
          replies: [{
            text: 'Alice, homepage review is ready.',
            toUserIds: [alice.userId],
            replyTo: [transcript[0].messageId]
          }, {
            text: 'Bob, the mobile layout and your file were checked.',
            toUserIds: [bob.userId],
            replyTo: [transcript[1].messageId]
          }, {
            kind: 'question',
            text: 'Alice, publish the preview?',
            toUserIds: [alice.userId],
            options: ['Yes', 'No']
          }, {
            kind: 'question',
            text: 'Which improvement next?',
            options: ['Navigation', 'Typography']
          }]
        });
      }
    });
    await runner.initialize();
    browser = await chromium.launch({
      headless: true
    });
    const ac = await browser.newContext({
        viewport: {
          width: 1440,
          height: 1000
        }
      }),
      bc = await browser.newContext({
        viewport: {
          width: 390,
          height: 844
        },
        isMobile: true,
        hasTouch: true,
        acceptDownloads: true
      });
    await ac.addInitScript(k => localStorage.setItem('encryptionKey', k), key);
    await bc.addInitScript(k => localStorage.setItem('encryptionKey', k), crypto.randomBytes(32).toString('base64'));
    const a = await ac.newPage(),
      b = await bc.newPage();
    // Run the real dashboard scripts and templates, with synthetic read APIs.
    // Icon/menu navigation must not need a provider call or production account.
    process.env.FEATURE_GUEST_SHARING = 'true';
    // Keep menu navigation independent from the active multi-chat layout and
    // localStorage state in the owner/member chat contexts above.
    menuContext = await browser.newContext();
    await menuContext.addInitScript(k => localStorage.setItem('encryptionKey', k), key);
    const menuPage = await menuContext.newPage();
    const menuErrors = [];
    menuPage.on('pageerror', error => menuErrors.push(error.message));
    // The dashboard uses Tailwind's CDN stylesheet compiler. Allow that one
    // presentation dependency; provider APIs and other external calls stay off.
    await menuPage.route('https://**/*', route => new URL(route.request().url()).hostname === 'cdn.tailwindcss.com'
      ? route.continue() : route.abort());
    await menuPage.route('**/api/user/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === '/api/user/install-chief-of-staff/status' ? { installed: true, count: 1 } : pathname === '/api/user/agents' ? { agents: [{
        agentId, name: 'Design Agent', position: 1, highestPriority: 'low', unreadCount: 0,
        lastSeenAt: new Date().toISOString(), agentType: 'standard'
      }], groups: [] } : { messages: [], batches: [], config: {}, agents: [], groups: [], statistics: {} };
      return route.fulfill({ json: body });
    });
    const menuOut = path.join(__dirname, '../../tmp/shared-conversations');
    fs.mkdirSync(menuOut, { recursive: true });
    if (process.env.IN_PLACE_DASHBOARD_ONLY !== 'true') for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      await menuPage.setViewportSize(viewport);
      await menuPage.goto(baseUrl + '/fixture/dashboard?legacy=1');
      // Restoring the last chat changes which mobile pane is interactive. Wait
      // for that real initialization before choosing the list or header icon.
      await menuPage.waitForFunction(() => window.dashboardReady === true);
      await menuPage.waitForFunction(() => getComputedStyle(document.getElementById('runCommandModal')).display === 'none');
      const icon = menuPage.locator('.agent-list-item__avatar').first();
      const headerAvatar = menuPage.locator('#selectedAgentActionIcon');
      if (await headerAvatar.isVisible()) {
        await headerAvatar.click();
      } else {
        await icon.waitFor({ state: 'visible' });
        await icon.click();
      }
      await menuPage.locator('#floatingShareAgentBtn').waitFor({ state: 'visible' });
      const menuBounds = await menuPage.locator('#floatingAgentMenu').boundingBox();
      assert(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= viewport.width && menuBounds.y + menuBounds.height <= viewport.height, device + ' menu must fit the viewport: ' + JSON.stringify(menuBounds));
      await menuPage.locator('#floatingAgentMenu summary').click();
      await menuPage.waitForFunction(() => {
        const bounds = document.getElementById('floatingAgentMenu').getBoundingClientRect();
        return bounds.y >= 0 && bounds.bottom <= innerHeight;
      });
      const expanded = await menuPage.locator('#floatingAgentMenu').boundingBox();
      assert(expanded.y >= 0 && expanded.y + expanded.height <= viewport.height, device + ' expanded details must fit');
      await menuPage.locator('#floatingAgentMenu summary').click();
      await menuPage.screenshot({ path: path.join(menuOut, `agent-menu-${device}.png`) });
      await menuPage.locator('#floatingShareAgentBtn').click();
      await menuPage.locator('#agentShareDialog').waitFor({ state: 'visible' });
      assert.equal(await menuPage.locator('#agentShareChatLink').getAttribute('href'), '/shared?agentId=' + agentId);
      assert.equal(await menuPage.locator('#agentShareGuestLink').getAttribute('href'), '/guest-sharing?agentId=' + agentId);
      const dialogBounds = await menuPage.locator('#agentShareDialog').boundingBox();
      assert(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= viewport.width, device + ' sharing dialog must fit');
      await menuPage.screenshot({ path: path.join(menuOut, `agent-share-${device}.png`) });
      await menuPage.keyboard.press('Escape');
      assert.equal(await menuPage.locator('#agentShareDialog').evaluate(dialog => dialog.open), false);
    }
    assert.deepEqual(menuErrors, []);
    await menuPage.close();
    const pageErrors = [];
    for (const p of [a, b]) {
      p.on('dialog', d => d.accept());
      p.on('pageerror', e => pageErrors.push(e.message));
      await p.route('https://**/*', route => new URL(route.request().url()).hostname === 'cdn.tailwindcss.com'
        ? route.continue() : route.abort());
    }
    const legacySharedNetwork=[];
    for(const p of [a,b]) p.on('response',response=>{
      const path=new URL(response.url()).pathname;
      if(path.startsWith('/api/user/shared/')) legacySharedNetwork.push([response.request().method(),path,response.status()]);
    });
    async function unlockShared(page, name) {
      await page.locator('#sharedUnlock input').fill(name);
      await page.getByRole('button', {
        name: 'Unlock shared chats',
        exact: true
      }).click();
      await page.locator('#sharedWorkspace').waitFor({ state: 'visible' });
      // Unlock reveals the workspace before its final room/agent refresh ends.
      // Wait for the form handler to finish before clicking a room action.
      await page.waitForFunction(() => !document.querySelector('#sharedUnlock button').disabled);
    }
    await a.goto(baseUrl + '/fixture/login');
    await unlockShared(a, 'Alice');
    await a.getByText('Start shared chat', {
      exact: true
    }).click();
    await a.locator('#sharedCreate input').fill('Website launch');
    await a.locator('#sharedCreate select[name="agentId"]').selectOption(agentId);
    await a.locator('#sharedCreate select[name="agentId"]').evaluate(select => {
      select.focus();
      window.pickerOption = select.options[0];
      window.pickerMutations = [];
      window.pickerObserver = new MutationObserver(records => window.pickerMutations.push(...records));
      window.pickerObserver.observe(select, { attributes: true, childList: true, subtree: true });
    });
    const refreshedAgents = a.waitForResponse(response => response.url().endsWith('/api/user/agents'));
    await refreshedAgents;
    await a.waitForFunction(() => !document.querySelector('#sharedRefreshAgents').disabled);
    assert.equal(await a.locator('#sharedCreate select[name="agentId"]').evaluate(select =>
      select.options[0] === window.pickerOption && document.activeElement === select && !select.disabled && window.pickerMutations.length === 0), true);
    await a.evaluate(() => window.pickerObserver.disconnect());
    await a.locator('#sharedCreate button[type="submit"]').click();
    await a.locator('#sharedTitle').filter({
      hasText: 'Website launch'
    }).waitFor();
    await a.getByText('Participants and controls', {
      exact: true
    }).click();
    await a.locator('#sharedInvite input').fill(bob.email);
    await a.locator('#sharedInvite button').click();
    await b.goto(baseUrl + '/fixture/login?user=bob');
    await unlockShared(b, 'Bob');
    await b.locator('#sharedRooms button').first().click();
    await b.locator('#sharedComposer').waitFor({
      state: 'visible',
      timeout: 20000
    });
    await a.locator('#sharedComposer textarea').fill('Please review the homepage.');
    await a.locator('#sharedComposer button').first().click();
    await a.getByText('Please review the homepage.', {
      exact: true
    }).waitFor();
    await b.locator('#sharedComposer textarea').fill('Also check the mobile layout and this file.');
    await b.locator('#sharedComposer input[type=file]').setInputFiles({
      name: 'launch-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Mobile launch notes')
    });
    await b.locator('#sharedComposer button').first().click();
    await b.getByText('Also check the mobile layout and this file.', {
      exact: true
    }).waitFor();
    await runner.sharedTurn();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].transcript.length, 2);
    assert(seen[0].transcript[1].files[0].path);
    assert.equal(fs.readFileSync(seen[0].transcript[1].files[0].path, 'utf8'), 'Mobile launch notes');
    await a.getByText('Alice, homepage review is ready.', {
      exact: true
    }).waitFor({
      timeout: 15000
    });
    await b.getByText('Bob, the mobile layout and your file were checked.', {
      exact: true
    }).waitFor({
      timeout: 15000
    });
    const bobQuestion = b.locator('article').filter({
      hasText: 'Alice, publish the preview?'
    });
    assert.equal(await bobQuestion.getByRole('button', {
      name: 'Yes',
      exact: true
    }).count(), 0);
    await a.locator('article').filter({
      hasText: 'Alice, publish the preview?'
    }).getByRole('button', {
      name: 'Yes',
      exact: true
    }).click();
    await b.locator('article').filter({
      hasText: 'Which improvement next?'
    }).getByRole('button', {
      name: 'Navigation',
      exact: true
    }).click();
    await a.getByText('Navigation', {
      exact: true
    }).last().waitFor({
      timeout: 15000
    });
    const roomId = (await query('SELECT id FROM shared_conversations LIMIT 1')).rows[0].id;
    const out = path.join(__dirname, '../../tmp/shared-conversations');
    fs.mkdirSync(out, {
      recursive: true
    });
    await a.locator('.chat-controls').evaluate(el => { el.open = false; });
    await a.locator('#sharedTimeline').evaluate(el => el.scrollTop = 0);
    await b.locator('#sharedTimeline').evaluate(el => el.scrollTop = 0);
    await a.screenshot({
      path: path.join(out, 'desktop.png'),
      fullPage: true
    });
    await b.screenshot({
      path: path.join(out, 'mobile.png'),
      fullPage: true
    });
    assert(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile shared chat overflows horizontally');
    const composerBox = await b.locator('#sharedComposer').boundingBox();
    assert(composerBox.y + composerBox.height <= 844, 'Mobile composer falls below the viewport');
    await b.locator('#sharedComposer textarea').fill('Keep this draft while browsing chats');
    await b.getByRole('button', { name: 'Back to shared chats', exact: true }).click();
    await b.locator('#sharedRooms button').first().click();
    await b.locator('#sharedComposer').waitFor({ state: 'visible' });
    assert.equal(await b.locator('#sharedComposer textarea').inputValue(), 'Keep this draft while browsing chats');
    await b.reload();
    await unlockShared(b, 'Bob');
    await b.locator('#sharedRooms button').first().click();
    await b.getByText('Bob, the mobile layout and your file were checked.', {
      exact: true
    }).waitFor({
      timeout: 15000
    });
    const privateCalls = [];
    const sharedNetwork = [];
    const dashboardPages = [
      [await ac.newPage(), 'alice'],
      [await bc.newPage(), 'bob']
    ];
    for (const [page, user] of dashboardPages) {
      page.on('pageerror', e => pageErrors.push(e.message));
      await page.addInitScript(() => { window.__IN_PLACE_CHAT_DEBUG__ = true; });
      await page.route('https://**/*', route => new URL(route.request().url()).hostname === 'cdn.tailwindcss.com'
        ? route.continue() : route.abort());
      let sharedSelected = false;
      page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (sharedSelected && (/^\/api\/user\/messages(?:\/|$)/.test(pathname) || /^\/api\/user\/questions(?:\/|$)/.test(pathname))) {
          privateCalls.push({ user, method: request.method(), pathname });
        }
      });
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/user/shared/')) sharedNetwork.push([user,response.request().method(),path,response.status()]);
      });
      await page.goto(baseUrl + '/fixture/dashboard' + (user === 'alice' ? '?conversationId=' + encodeURIComponent(roomId) : ''));
      if (user === 'bob') {
        const agentListPanel=page.locator('#agentListPanel');
        if (await agentListPanel.count() && !await agentListPanel.evaluate(panel=>panel.classList.contains('mobile-expanded'))) {
          await page.locator('#collapseMobileListBtn').click();
        }
        const sharedRow = page.locator(`[data-shared-conversation-id="${roomId}"]`);
        await sharedRow.waitFor({ state: 'visible', timeout: 20000 });
        await sharedRow.click();
      }
      await page.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, roomId, { timeout: 20000 });
      sharedSelected = true;
      await page.waitForFunction(() => document.querySelector('#userMessageInput') && !document.querySelector('#userMessageSend')?.disabled, null, { timeout: 20000 });
    }
    const [ownerDashboard, memberDashboard] = dashboardPages.map(([page]) => page);
    assert.equal(await ownerDashboard.evaluate(() => window.DashboardHelpers.getSelectedChatContext().conversationId), roomId);
    assert.equal(await memberDashboard.evaluate(() => window.DashboardHelpers.getSelectedChatContext().conversationId), roomId);
    for (const page of [ownerDashboard, memberDashboard]) {
      await page.getByText(page === ownerDashboard ? 'Alice, homepage review is ready.' : 'Bob, the mobile layout and your file were checked.', { exact: true }).waitFor({ timeout: 15000 });
    }
    await ownerDashboard.locator('#userMessageInput').fill('Owner dashboard message');
    await ownerDashboard.locator('#userMessageSend').click();
    await ownerDashboard.getByText('Owner dashboard message', { exact: true }).waitFor({ timeout: 15000 }).catch(async error => {
      console.error('In-place send trace:', JSON.stringify(await ownerDashboard.evaluate(() => window.__inPlaceChatDebugLog || [])));
      console.error('Dashboard page errors:', JSON.stringify(pageErrors));
      console.error('Owner dashboard send debug:', (await ownerDashboard.locator('#conversationArea').innerText()).slice(-1000));
      console.error('Owner dashboard body tail:', (await ownerDashboard.locator('body').innerText()).slice(-1000));
      console.error('Shared network statuses:', JSON.stringify(sharedNetwork));
      throw error;
    });
    await memberDashboard.getByText('Owner dashboard message', { exact: true }).waitFor({ timeout: 15000 }).catch(async error => {
      console.error('Member dashboard missed owner message:', (await memberDashboard.locator('#conversationArea').innerText()).slice(-700));
      console.error('Shared network statuses:', JSON.stringify(sharedNetwork));
      throw error;
    });
    await memberDashboard.locator('#userMessageInput').fill('Member dashboard reply');
    await memberDashboard.locator('#userMessageSend').click();
    await memberDashboard.getByText('Member dashboard reply', { exact: true }).waitFor({ timeout: 15000 }).catch(async error => {
      console.error('Member dashboard send debug:', (await memberDashboard.locator('#conversationArea').innerText()).slice(-1000));
      console.error('Member dashboard body tail:', (await memberDashboard.locator('body').innerText()).slice(-1000));
      console.error('Shared network statuses:', JSON.stringify(sharedNetwork));
      throw error;
    });
    await ownerDashboard.getByText('Member dashboard reply', { exact: true }).waitFor({ timeout: 15000 });
    // Receipt changes have no new timeline sequence: both ordinary dashboards
    // must patch existing rows before any provider response is delivered.
    const receiptService = require('../../src/shared/service');
    const receiptSource = (await query('SELECT id FROM shared_messages WHERE conversation_id=$1 AND sender_user_id=$2 ORDER BY seq DESC LIMIT 1', [roomId, bob.userId])).rows[0];
    const receiptSelector = `[data-message-id="${receiptSource.id}"] .message-read-indicator`;
    for (const page of [ownerDashboard, memberDashboard]) {
      assert.equal(await page.locator(receiptSelector).textContent(), '✓✓');
      assert.equal(await page.locator(receiptSelector).getAttribute('data-receipt-state'), 'delivered');
      assert.equal(await page.locator(receiptSelector).evaluate(node => getComputedStyle(node).color), 'rgb(148, 163, 184)');
    }
    const receiptBatch = await receiptService.claim(agentId, runner.runtimeId);
    assert(receiptBatch.messages.some(message => message.id === receiptSource.id));
    assert.equal(await memberDashboard.locator(receiptSelector).getAttribute('data-receipt-state'), 'delivered', 'Claim alone is not an agent-read acknowledgement');
    await memberDashboard.bringToFront();
    // Sending intentionally anchors the newest message for a brief period.
    await memberDashboard.waitForTimeout(1600);
    await memberDashboard.locator('#userMessageInput').fill('Keep receipt-test draft');
    // A keyboard/composer resize is a separate operation from a receipt.
    // Let its 700 ms preservation window finish before measuring the reader.
    await memberDashboard.waitForTimeout(750);
    await memberDashboard.evaluate(id => {
      const area = document.getElementById('conversationArea');
      window.receiptTestBubble = [...area.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === id);
      window.receiptTestImage = document.createElement('img');
      // Probe DOM identity without adding height or triggering an image reflow.
      window.receiptTestImage.style.cssText = 'position:absolute;width:1px;height:1px;pointer-events:none';
      window.receiptTestBubble.append(window.receiptTestImage);
      area.scrollTop = 30;
      window.receiptTestScroll = area.scrollTop;
    }, receiptSource.id);
    await receiptService.markBatchRead(agentId, runner.runtimeId, receiptBatch.id, { messageIds: receiptBatch.messages.map(message => message.id) });
    for (const page of [ownerDashboard, memberDashboard]) {
      await page.waitForFunction(selector => document.querySelector(selector)?.dataset.receiptState === 'read', receiptSelector);
      assert.equal(await page.locator(receiptSelector).evaluate(node => getComputedStyle(node).color), 'rgb(56, 189, 248)');
    }
    assert.equal(await memberDashboard.locator('#userMessageInput').inputValue(), 'Keep receipt-test draft');
    const receiptViewport = await memberDashboard.evaluate(() => ({ imageConnected: window.receiptTestImage.isConnected,
      sameBubble: window.receiptTestBubble.contains(window.receiptTestImage), scroll: document.getElementById('conversationArea').scrollTop, expectedScroll: window.receiptTestScroll }));
    assert(receiptViewport.imageConnected && receiptViewport.sameBubble && receiptViewport.scroll === receiptViewport.expectedScroll, 'Receipt-only updates must preserve mounted content and viewport: ' + JSON.stringify(receiptViewport));
    assert.equal((await receiptService.agentBatch(agentId, runner.runtimeId, receiptBatch.id)).status, 'processing', 'Blue receipts must arrive before a reply');
    const receiptKey = await C.unwrap(receiptBatch.keys.find(envelope => envelope.key_version === receiptBatch.room.key_version).wrapped_key, runner.privateKey);
    await receiptService.finish(agentId, runner.runtimeId, receiptBatch.id, { messages: [{ id: crypto.randomUUID(), keyVersion: receiptBatch.room.key_version,
      payload: await C.encrypt(receiptKey, { text: 'Receipt browser fixture complete' }, `${roomId}:${receiptBatch.room.key_version}`) }] });
    await memberDashboard.locator('#userMessageInput').fill('');
    assert.deepEqual(privateCalls, [], 'Shared dashboard activity must never call private history, send, read-status, or question APIs');
    await ownerDashboard.waitForFunction(() => {
      const text = document.getElementById('conversationArea').innerText;
      return text.includes('Bob') || text.includes('Alice');
    }, null, { timeout: 15000 });
    assert.deepEqual(pageErrors, []);
    // Stop the independent dashboard pollers before the legacy outbox/key-rotation
    // scenario; both flows exercise the same room and their overlapping key
    // refreshes would otherwise create an artificial race in this fixture.
    await ownerDashboard.close();
    await memberDashboard.close();
    // Convert a populated ordinary agent history through the dashboard's own
    // Share panel, then accept an account invitation in a second browser.
    await query("INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES($1,$2,'Other private agent',1)", [privateAgentId, alice.userId]);
    const privateSeedId = crypto.randomUUID();
    // The owner alone holds this local encryption key. The invitee uses a
    // different account key and must receive re-encrypted conversation history.
    const privateIv = crypto.randomBytes(12);
    const privateCipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), privateIv);
    const privateCiphertext = Buffer.concat([privateCipher.update('Populated private history to convert', 'utf8'), privateCipher.final()]);
    const encryptedPrivateText = [privateIv, privateCipher.getAuthTag(), privateCiphertext].map(value => value.toString('base64')).join(':');
    await query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,created_at)
      VALUES($1,$2,$3,TRUE,NOW()-INTERVAL '1 minute')`, [privateSeedId, agentId, encryptedPrivateText]);
    await query(`INSERT INTO attachments(attachment_id,content_type,file_name,size_bytes,storage_key,encrypted,agent_id,uploaded_by)
      VALUES($1,'text/plain','design-notes.txt',$2,'fixture-ciphertext',FALSE,$3,'user')`, [privateAttachmentId,privateAttachmentBytes.length,agentId]);
    await query('INSERT INTO user_message_attachments(user_message_id,attachment_id) VALUES($1,$2)', [privateSeedId,privateAttachmentId]);
    const answeredQuestionId = crypto.randomUUID();
    const answeredOptionId = crypto.randomUUID();
    const unansweredQuestionId = crypto.randomUUID();
    const proceedOptionId = crypto.randomUUID();
    await query(`INSERT INTO messages(message_id,agent_id,message_type,content,encrypted,created_at)
      VALUES($1,$3,'question','A previously answered question?',FALSE,NOW()-INTERVAL '30 seconds'),
        ($2,$3,'question','Choose an action after conversion',FALSE,NOW()-INTERVAL '20 seconds')`, [answeredQuestionId, unansweredQuestionId, agentId]);
    await query(`INSERT INTO question_options(option_id,message_id,option_text,is_default,option_order)
      VALUES($1,$2,'Keep',TRUE,0),($3,$2,'Discard',FALSE,1),($4,$5,'Proceed',TRUE,0),($6,$5,'Wait',FALSE,1)`, [
      answeredOptionId, answeredQuestionId, crypto.randomUUID(), proceedOptionId, unansweredQuestionId, crypto.randomUUID()
    ]);
    await query(`INSERT INTO user_responses(message_id,option_id,created_at) VALUES($1,$2,NOW()-INTERVAL '10 seconds')`, [answeredQuestionId, answeredOptionId]);
    let conversionPage = await ac.newPage();
    conversionPage.on('pageerror', error => pageErrors.push(error.message));
    await conversionPage.route('https://**/*', route => new URL(route.request().url()).hostname === 'cdn.tailwindcss.com'
      ? route.continue() : route.abort());
    await conversionPage.addInitScript(({ agentId, userId }) => {
      localStorage.setItem(`dashboard_last_agent_id:${userId}`, JSON.stringify({ agentId }));
      localStorage.setItem('dashboard_last_agent_id', agentId);
    }, { agentId, userId: alice.userId });
    await conversionPage.goto(baseUrl + '/fixture/dashboard');
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedAgentIdentity?.()?.agentId === id, agentId, { timeout: 20000 });
    await conversionPage.waitForFunction(() => window.dashboardReady === true);
    const csrfRecoveryResponses = [];
    conversionPage.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname === '/csrf-token' || pathname === '/api/user/chat-threads/resolve') {
        csrfRecoveryResponses.push([pathname, response.status()]);
      }
    });
    await conversionPage.evaluate(async () => {
      const response = await fetch('/fixture/expire-csrf', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to expire the fixture CSRF token');
    });
    await conversionPage.setViewportSize({ width: 390, height: 844 });
    await conversionPage.bringToFront();
    await conversionPage.locator('#selectedAgentActionIcon').click();
    await conversionPage.locator('#floatingShareAgentBtn').click();
    await conversionPage.locator('#shareExistingChatDialog').waitFor({ state: 'visible' });
    assert.equal(await conversionPage.locator('#agentShareDialog').count(), 0, 'The old separate sharing chooser must be absent');
    await conversionPage.locator('#shareInviteEmail').fill(bob.email);
    await conversionPage.getByText(/3 messages and 1 files will be included/).waitFor({ timeout: 20000 });
    assert(csrfRecoveryResponses.some(([pathname, status]) => pathname.endsWith('/resolve') && status === 403), 'Expired CSRF must reject the initial share request');
    assert(csrfRecoveryResponses.some(([pathname, status]) => pathname === '/csrf-token' && status === 200), 'Share must refresh CSRF automatically');
    assert.equal(await conversionPage.locator('#shareInviteEmail').inputValue(), bob.email, 'CSRF recovery must preserve the typed email');
    assert(await conversionPage.locator('#shareExistingChatPrepare').isEnabled(), 'Share must become usable after CSRF recovery on mobile');
    // The legacy harness tab shares Alice's session cookies. Restore its token
    // after this deliberate expiry so its later outbox-rekey test starts with
    // valid credentials; production in-place recovery is asserted above.
    const renewedCsrf = await conversionPage.evaluate(() => window.csrfToken);
    await a.locator('#sharedApp').evaluate((element, csrfToken) => { element.dataset.csrf = csrfToken; }, renewedCsrf);
    await conversionPage.locator('#shareExistingChatPrepare').click();
    await conversionPage.waitForFunction(() => window.DashboardHelpers?.getSelectedChatContext?.()?.capabilities?.send === true, null, { timeout: 30000 });
    await conversionPage.getByText('Populated private history to convert', { exact: true }).waitFor({ timeout: 20000 }).catch(async error => {
      const context = await conversionPage.evaluate(() => window.DashboardHelpers?.getSelectedChatContext?.());
      const view = await conversionPage.locator('#conversationArea').evaluate(element => ({ className: element.className, text: element.innerText, html: element.innerHTML.slice(0, 2000) }));
      const timeline = await conversionPage.evaluate(async () => (await window.InPlaceChat.loadTimeline()).map(message => ({ type: message.type, content: message.content, options: message.options?.length })));
      console.error('History conversion display diagnostics:', JSON.stringify({ context, view, timeline, errors: pageErrors }));
      if (context?.conversationId) console.error('History conversion database diagnostics:', JSON.stringify((await query(`SELECT t.state, i.state AS import_state,i.expected_items,i.imported_items,
        (SELECT COUNT(*)::int FROM shared_messages m WHERE m.conversation_id=t.conversation_id AND m.import_id=i.import_id) AS imported_messages
        FROM agent_chat_threads t LEFT JOIN shared_history_imports i ON i.conversation_id=t.conversation_id WHERE t.conversation_id=$1`, [context.conversationId])).rows));
      throw error;
    });
    await conversionPage.getByText('design-notes.txt', { exact: true }).waitFor({ timeout: 20000 });
    await conversionPage.locator('#shareInviteSubmit').click();
    await conversionPage.getByText(new RegExp('Invitation saved for ' + bob.email)).waitFor({ timeout: 15000 });
    await conversionPage.setViewportSize({ width: 1280, height: 900 });
    await conversionPage.locator('#shareExistingChatClose').click();
    const convertedConversationId = await conversionPage.evaluate(() => window.DashboardHelpers.getSelectedChatContext().conversationId);
    assert.equal(convertedConversationId, (await query('SELECT conversation_id FROM agent_chat_threads WHERE agent_id=$1 AND is_primary=TRUE', [agentId])).rows[0].conversation_id);
    const importedAnsweredQuestion = (await query('SELECT target_message_id FROM shared_history_import_items WHERE source_id=$1', [answeredQuestionId])).rows[0].target_message_id;
    const importedUnansweredQuestion = (await query('SELECT target_message_id FROM shared_history_import_items WHERE source_id=$1', [unansweredQuestionId])).rows[0].target_message_id;
    const preservedAnswer = conversionPage.locator(`.options-container[data-question-id="${importedAnsweredQuestion}"] .option-card--selected`);
    await preservedAnswer.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await preservedAnswer.innerText(), /Keep/);
    await conversionPage.locator(`.options-container[data-question-id="${importedUnansweredQuestion}"] .option-card`).filter({ hasText: 'Proceed' }).click();
    await conversionPage.getByText('Proceed', { exact: true }).last().waitFor({ timeout: 15000 });
    assert.equal(await conversionPage.locator('#headerShareExistingChatBtn').isVisible(), false, 'Shared chats use the participant icon instead of a duplicate Share button');
    await conversionPage.locator('#selectedChatContextStatus').click();
    assert(!/Shared by|Shared with/.test(await conversionPage.locator('#selectedChatContextStatus').textContent()), 'The sharing control must show only its icon and count');
    const conversionNetwork = [];
    for (const [page, label] of [[conversionPage, 'owner-conversion'], [b, 'invitee']]) {
      page.on('response', response => {
        const pathname = new URL(response.url()).pathname;
        if (pathname.startsWith('/api/user/shared/') || pathname.startsWith('/api/user/chat-threads/')) conversionNetwork.push([label, response.request().method(), pathname, response.status()]);
      });
    }
    // The owner stays in another ordinary private chat throughout acceptance.
    // Neither browser may need to reopen the shared room to finish key setup.
    const privateContext = await conversionPage.evaluate(async id => (await (await fetch('/api/user/chat-threads')).json()).find(context => context.agentId === id && context.mode === 'private'), privateAgentId);
    await conversionPage.reload();
    await conversionPage.waitForFunction(() => window.dashboardReady === true);
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, convertedConversationId);
    await conversionPage.evaluate(context => window.DashboardHelpers.selectChatContext(context), privateContext);
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedAgentIdentity?.()?.agentId === id && window.DashboardHelpers?.getSelectedAgentIdentity?.()?.mode === 'private', privateAgentId);
    assert.equal(await conversionPage.locator('#sharedConversationList [data-shared-conversation-id]').count(), 0, 'Owned legacy rooms must not duplicate normal agent rows');
    await b.goto(baseUrl + '/fixture/dashboard');
    const incoming = b.locator('#incomingSharingInvitations');
    await incoming.getByRole('button', { name: 'Join', exact: true }).waitFor({ timeout: 20000 });
    await incoming.getByRole('button', { name: 'Join', exact: true }).evaluate(btn => btn.click());
    try {
      await b.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, convertedConversationId, { timeout: 30000 });
    } catch (e) {
      const fb = await b.locator('#incomingSharingInvitations [role="status"]').allTextContents();
      const curr = await b.evaluate(() => ({
        selected: window.DashboardHelpers?.getSelectedChatContext?.()
      }));
      console.error('JOIN DIAGNOSTICS:', { fb, curr });
      throw e;
    }
    await b.getByText('Populated private history to convert', { exact: true }).waitFor({ timeout: 30000 }).catch(async error => {
      const state = await query(`SELECT m.status,c.key_version,c.membership_version,c.rotation_required,
        (SELECT COUNT(*)::int FROM shared_key_envelopes e WHERE e.conversation_id=c.id) AS envelopes
        FROM shared_conversations c JOIN shared_members m ON m.conversation_id=c.id AND m.user_id=$2 WHERE c.id=$1`, [convertedConversationId,bob.userId]);
      console.error('Conversion invite diagnostics:', JSON.stringify({ state: state.rows, network: conversionNetwork }));
      throw error;
    });
    await b.getByText('design-notes.txt', { exact: true }).waitFor({ timeout: 20000 });
    await b.waitForFunction(() => !document.getElementById('userMessageSend').disabled);
    assert.equal(await conversionPage.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity().agentId), privateAgentId,
      'Background key provisioning must leave the owner in their private chat');
    await b.locator('#userMessageInput').fill('Joined while owner was in another private chat');
    await b.locator('#userMessageSend').click();
    await b.getByText('Joined while owner was in another private chat', { exact: true }).waitFor({ timeout: 20000 });
    // Legacy account-encrypted rows can coexist with the shared transcript.
    // Keep them in the owner's ordinary chat without publishing them to members.
    const ownerOnlyId = crypto.randomUUID();
    await query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,created_at)
      VALUES($1,$2,'Earlier owner-only history',FALSE,NOW()-INTERVAL '2 days')`, [ownerOnlyId, agentId]);
    await conversionPage.evaluate(async id => {
      const context = await (await fetch('/api/user/chat-threads/' + id)).json();
      await window.DashboardHelpers.selectChatContext(context);
    }, convertedConversationId);
    await conversionPage.getByText('Joined while owner was in another private chat', { exact: true }).waitFor({ timeout: 20000 });
    await conversionPage.locator('#conversationArea').getByText('Earlier owner-only history', { exact: true }).waitFor();
    await conversionPage.locator(`[data-message-id="${ownerOnlyId}"]`).getByText('Visible to Owner only · private history', { exact: true }).waitFor();
    assert.equal(await conversionPage.locator('#conversationArea').getByText('Populated private history to convert', { exact: true }).count(), 1,
      'Imported original history must render once');
    assert.equal(await b.locator('#conversationArea').getByText('Earlier owner-only history', { exact: true }).count(), 0);
    await conversionPage.waitForFunction(() => document.querySelector('[data-shared-participant-count]')?.textContent === '2');
    await b.locator('#selectedChatContextStatus').click();
    await b.locator('#shareExistingChatPreview').getByText(/Owner/).waitFor();
    assert.equal(await b.locator('#shareExistingChatInvites').isVisible(), false, 'Members see the audience without owner-only invite controls');
    await b.keyboard.press('Escape');
    assert.equal(await b.locator('#selectedChatContextStatus').getAttribute('aria-expanded'), 'false');
    // Check actual hit testing, not only CSS classes: a clipped mobile panel
    // reports expanded while the underlying conversation receives every tap.
    await conversionPage.setViewportSize({ width: 390, height: 844 });
    // Slow phone/network regression: optional read acknowledgements and private
    // history must not keep an already decrypted shared transcript blank.
    await query(`INSERT INTO user_messages(user_message_id,agent_id,content,encrypted,created_at)
      SELECT gen_random_uuid(),$1,'Mobile private history '||n||E'\n\n'||repeat('Saved private conversation. ',30),FALSE,
        NOW()-INTERVAL '1 day'+n*INTERVAL '1 second' FROM generate_series(1,205) n`, [agentId]);
    const phoneSession = await conversionPage.context().newCDPSession(conversionPage);
    let phoneTraceDone;
    if (process.env.SHARED_PHONE_TRACE === 'true') {
      phoneTraceDone = new Promise(resolve => phoneSession.once('Tracing.tracingComplete', resolve));
      await phoneSession.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
    }
    await phoneSession.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const heldReads = [], heldHistory = [];
    const readHandler = route => new Promise(resolve => heldReads.push(async () => { await route.continue(); resolve(); }));
    const historyHandler = route => new Promise(resolve => heldHistory.push(async () => { await route.continue(); resolve(); }));
    await conversionPage.route('**/api/user/shared/*/read', readHandler);
    await conversionPage.route('**/api/user/chat-threads/*/owner-history?*', historyHandler);
    await conversionPage.goto(baseUrl + '/fixture/dashboard?conversationId=' + convertedConversationId, { waitUntil: 'domcontentloaded' });
    await conversionPage.locator('#conversationArea').getByText('Joined while owner was in another private chat', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error('Mobile opening diagnostics:', JSON.stringify(await conversionPage.evaluate(() => ({
        ready: window.dashboardReady, context: window.DashboardHelpers?.getSelectedChatContext?.(),
        active: window.InPlaceChat?.getContext?.(), status: document.getElementById('conversationArea')?.innerText.slice(0, 300),
        listExpanded: document.getElementById('agentListPanel')?.classList.contains('mobile-expanded')
      }))));
      throw error;
    });
    assert(await conversionPage.evaluate(() => Boolean(document.querySelector('link[href^="/css/tailwind.css"]')) && typeof window.tailwind === 'undefined'), 'Phone chat must use precompiled utility styles');
    assert(heldReads.length > 0, 'A read acknowledgement must still be stalled during this check');
    assert(heldHistory.length > 0, 'Private history must still be stalled during this check');
    const navigationStart = Date.now();
    await conversionPage.locator('#collapseMobileListBtn').click();
    await conversionPage.waitForFunction(() => document.getElementById('agentListPanel').classList.contains('mobile-expanded'), null, { timeout: 1500 });
    const stalledRequestTapMs = Date.now() - navigationStart;
    assert(stalledRequestTapMs < 1500, 'A pending history request must not make opening the mobile chat list take over 1.5 seconds');
    await conversionPage.locator('#collapseMobileListBtn').click();
    await conversionPage.unroute('**/api/user/shared/*/read', readHandler);
    await conversionPage.unroute('**/api/user/chat-threads/*/owner-history?*', historyHandler);
    await conversionPage.evaluate(() => {
      window.__phoneLongTasks = [];
      window.__phoneRenderCosts = { create: 0, scroll: 0 };
      for (const [name, key] of [['createMessageElement', 'create'], ['scrollToBottom', 'scroll']]) {
        const original = window[name];
        window[name] = function(...args) {
          const start = performance.now();
          try { return original.apply(this, args); }
          finally { window.__phoneRenderCosts[key] = Math.max(window.__phoneRenderCosts[key], performance.now() - start); }
        };
      }
      new PerformanceObserver(list => window.__phoneLongTasks.push(...list.getEntries().map(entry => entry.duration)))
        .observe({ type: 'longtask' });
    });
    await Promise.all([...heldReads, ...heldHistory].map(release => release()));
    await conversionPage.waitForFunction(() => document.querySelectorAll('#conversationArea [data-message-id]').length >= 30 &&
      !window.DashboardHelpers.chatHistoryBusy(), null, { timeout: 10000 }).catch(async error => {
      console.error('Mobile rendering diagnostics:', JSON.stringify(await conversionPage.evaluate(() => ({
        bubbles: document.querySelectorAll('#conversationArea [data-message-id]').length,
        maxLongTaskMs: Math.max(0, ...window.__phoneLongTasks),
        costs: window.__phoneRenderCosts,
        context: window.DashboardHelpers?.getSelectedChatContext?.(), active: window.InPlaceChat?.getContext?.(),
        visibility: document.visibilityState,
        notice: document.getElementById('ownerHistoryNotice')?.innerText,
        latest: document.querySelector('#conversationArea [data-message-id]:last-child')?.dataset.messageId
      }))));
      throw error;
    });
    const phoneMetrics = await conversionPage.evaluate(() => ({ maxLongTaskMs: Math.max(0, ...window.__phoneLongTasks),
      bubbles: document.querySelectorAll('#conversationArea [data-message-id]').length,
      costs: window.__phoneRenderCosts }));
    assert.equal(await conversionPage.locator('#conversationArea').getByText(/Mobile private history 205/).count(), 1,
      'The latest private history must be retained even when its layout is deferred offscreen');
    console.log('Phone responsiveness (4× CPU slowdown):', JSON.stringify({ ...phoneMetrics, stalledRequestTapMs }));
    if (phoneTraceDone) {
      await phoneSession.send('Tracing.end');
      const { stream } = await phoneTraceDone;
      const chunks = [];
      for (;;) {
        const chunk = await phoneSession.send('IO.read', { handle: stream });
        chunks.push(chunk.data);
        if (chunk.eof) break;
      }
      await phoneSession.send('IO.close', { handle: stream });
      const trace = chunks.join('');
      fs.writeFileSync(path.join(__dirname, '../../tmp/shared-conversations/phone-render-trace.json'), trace);
      console.log('Phone trace tasks:', JSON.stringify(JSON.parse(trace).traceEvents.filter(event => event.ph === 'X' && event.dur > 50000)
        .sort((a, b) => b.dur - a.dur).slice(0, 30).map(event => ({ name: event.name, durationMs: event.dur / 1000, ts: event.ts, args: event.args }))));
    }
    assert(phoneMetrics.maxLongTaskMs < 500, 'A long history must yield instead of freezing the phone for half a second');
    assert(phoneMetrics.bubbles < 60, 'Opening a phone chat must page private history instead of rendering the entire backlog');
    await phoneSession.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await phoneSession.detach();
    const oldestPrivate = conversionPage.locator('#conversationArea').getByText('Earlier owner-only history', { exact: true });
    for (let page = 0; page < 4; page += 1) {
      const nextPage = conversionPage.waitForResponse(response => response.url().includes('/owner-history?') && response.status() === 200);
      await conversionPage.locator('#conversationArea').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await nextPage;
      await conversionPage.waitForFunction(() => document.getElementById('conversationArea').getAttribute('aria-busy') !== 'true');
    }
    await oldestPrivate.waitFor({ state: 'attached', timeout: 20000 });
    await oldestPrivate.scrollIntoViewIfNeeded();
    await oldestPrivate.waitFor({ timeout: 10000 });
    await conversionPage.locator('#collapseMobileListBtn').click();
    const privateRow = conversionPage.locator(`#agentListScroll .agent-list-item[data-agent-id="${privateAgentId}"]`);
    await privateRow.waitFor({ state: 'visible' });
    assert(await privateRow.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }), 'Expanded regular mobile chat rows must receive taps');
    await privateRow.click();
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedAgentIdentity?.()?.agentId === id, privateAgentId);
    assert.equal(await conversionPage.locator('#selectedChatContextStatus').isVisible(), false, 'Private chats do not show a shared participant count');
    await conversionPage.evaluate(async id => window.DashboardHelpers.selectChatContext(await (await fetch('/api/user/chat-threads/' + id)).json()), convertedConversationId);
    await conversionPage.setViewportSize({ width: 1440, height: 1000 });
    const memberMobileChat = await b.locator('#conversationArea').evaluate(area => ({
      visible: !area.classList.contains('hidden') && getComputedStyle(area).display !== 'none',
      text: area.innerText,
      bounds: (() => { const rect = area.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })(),
      selected: window.DashboardHelpers?.getSelectedChatContext?.()
    }));
    assert(memberMobileChat.visible && memberMobileChat.bounds.height > 0 && memberMobileChat.text.includes('Populated private history to convert'),
      'The invitee mobile dashboard must show the shared timeline and composer: ' + JSON.stringify(memberMobileChat));
    if (await b.locator('#mainInteractiveContent').isVisible()) {
      await b.locator('#mainInteractiveToggle').click();
      await b.locator('#mainInteractiveContent').waitFor({ state: 'hidden' });
    }
    await b.locator('#conversationArea').getByText('Populated private history to convert', { exact: true }).waitFor({ state: 'visible' });
    // Reproduce the invitee picker after regular-agent handlers have been
    // rebound by dashboard polling. Shared entries must keep their own context.
    for (const viewport of [{ width: 688, height: 900 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
      await b.setViewportSize(viewport);
      await b.evaluate(() => { setupAgentListHandlers(); setupAgentListHandlers(); });
      if (viewport.width < 768 && !await b.locator('#agentListPanel').evaluate(panel => panel.classList.contains('mobile-expanded'))) {
        await b.locator('#collapseMobileListBtn').click();
      }
      const card = b.locator(`#sharedConversationList [data-shared-conversation-id="${convertedConversationId}"]`);
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.boundingBox();
      assert(bounds && bounds.width > 160 && bounds.height <= 90, 'Shared invitee names must not wrap vertically: ' + JSON.stringify(bounds));
      assert(await card.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), 'Shared conversation cards must receive taps');
      await b.screenshot({ path: path.join(__dirname, `../../tmp/shared-conversations/invitee-picker-${viewport.width}.png`), fullPage: true });
      await card.click();
      await b.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, convertedConversationId);
      if (viewport.width < 768) {
        await b.waitForFunction(() => !document.getElementById('agentListPanel').classList.contains('mobile-expanded'), null, { timeout: 5000 });
        assert.equal(await b.locator('#agentListPanel').evaluate(panel => panel.classList.contains('mobile-expanded')), false,
          'Tapping even the current shared chat must close the phone picker so its messages are visible');
      }
      await b.locator('#conversationArea').getByText('Populated private history to convert', { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await b.locator('#userMessageSend').isEnabled(), true, 'The shared member must retain a usable composer');
      await b.evaluate(() => window.InPlaceChat.refreshList());
      assert.equal(await b.locator(`#sharedConversationList [data-shared-conversation-id="${convertedConversationId}"]`).getAttribute('aria-current'), 'true');
      await b.screenshot({ path: path.join(__dirname, `../../tmp/shared-conversations/invitee-chat-${viewport.width}.png`), fullPage: true });
    }
    await b.setViewportSize({ width: 390, height: 844 });
    await b.screenshot({ path: path.join(__dirname, '../../tmp/shared-conversations/member-dashboard-mobile.png'), fullPage: true });
    await conversionPage.locator('#generalFileInput').setInputFiles({ name: 'new-shared-note.txt', mimeType: 'text/plain', buffer: Buffer.from('sent through the ordinary shared composer') });
    await conversionPage.locator('#userMessageInput').fill('I added a shared attachment');
    await conversionPage.locator('#userMessageSend').click();
    await conversionPage.getByText('new-shared-note.txt', { exact: true }).waitFor({ timeout: 20000 });
    await b.getByText('I added a shared attachment', { exact: true }).waitFor({ timeout: 30000 });
    const memberAttachment = b.locator('.message-attachment-item').filter({ hasText: 'new-shared-note.txt' });
    await memberAttachment.waitFor({ timeout: 20000 });
    const memberDownload = b.waitForEvent('download');
    await memberAttachment.locator('.message-attachment-btn[title="Download"]').click();
    assert.equal((await memberDownload).suggestedFilename(), 'new-shared-note.txt');
    await conversionPage.locator('#selectedChatContextStatus').click();
    assert.equal(await conversionPage.getByText('Earlier conversations and private history', { exact: true }).count(), 0);
    assert.equal(await conversionPage.locator('#sharePrivateHistory, #shareEarlierConversations').count(), 0);
    await conversionPage.locator('#shareInviteList button[aria-label^="Remove "]').first().waitFor({ timeout: 20000 });
    const screenshotDir = path.join(__dirname, '../../tmp/shared-conversations');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await conversionPage.screenshot({ path: path.join(screenshotDir, 'owner-share-panel-desktop.png'), fullPage: true });
    await conversionPage.setViewportSize({ width: 390, height: 844 });
    await conversionPage.screenshot({ path: path.join(screenshotDir, 'owner-share-panel-mobile.png'), fullPage: true });
    await conversionPage.setViewportSize({ width: 1440, height: 1000 });
    await conversionPage.locator('#shareInviteList button[aria-label^="Remove "]').first().click();
    let removedMember;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      removedMember = (await query('SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [convertedConversationId,bob.userId])).rows[0];
      if (removedMember?.status === 'removed') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(removedMember?.status, 'removed', 'the in-panel Remove control must revoke the collaborator');
    let rotationRequired = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      rotationRequired = (await query('SELECT rotation_required FROM shared_conversations WHERE id=$1', [convertedConversationId])).rows[0].rotation_required;
      if (!rotationRequired) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(rotationRequired, false, 'the owner dashboard must provision a rotated key after removal');
    assert.equal(await b.evaluate(async id => (await fetch('/api/user/chat-threads/' + encodeURIComponent(id))).status, convertedConversationId), 404,
      'the removed collaborator must lose conversation access');
    assert.equal((await query('SELECT COUNT(*)::int AS count FROM shared_messages WHERE conversation_id=$1 AND dispatch_eligible=FALSE', [convertedConversationId])).rows[0].count, 3);
    await conversionPage.locator('#shareGuestControls').waitFor({ state: 'visible' });
    await conversionPage.locator('#shareGuestLinkCreate').click();
    await conversionPage.getByText(/Guest link created for this conversation/).waitFor({ timeout: 15000 });
    const guestLink = await conversionPage.locator('#shareGuestLinkValue').inputValue();
    const guestShareId = (await query('SELECT share_id FROM guest_shares WHERE owner_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [alice.userId])).rows[0].share_id;
    assert.equal((await query('SELECT room_id FROM guest_share_agents WHERE share_id=$1', [guestShareId])).rows[0].room_id, convertedConversationId);
    // Reproduce admission while the owner is absent, then returns locally
    // locked in another private chat. No password or owner key goes to guests.
    await conversionPage.locator('#shareExistingChatClose').click();
    await conversionPage.evaluate(context => window.DashboardHelpers.selectChatContext(context), privateContext);
    await conversionPage.close();
    const guestContext = await browser.newContext({ acceptDownloads: true });
    const guestPage = await guestContext.newPage();
    guestPage.on('pageerror', error => pageErrors.push(error.message));
    await guestPage.route('https://**/*', route => route.abort());
    await guestPage.goto(guestLink);
    await guestPage.locator('#guestDisplayName').fill('In-place guest');
    await guestPage.getByRole('button', { name: 'Join chat', exact: true }).click();
    await guestPage.locator('#guestWorkspace').waitFor({ state: 'visible', timeout: 30000 });
    await guestPage.locator(`#guestRooms button[data-chat-room="${convertedConversationId}"]`).waitFor({ state: 'visible', timeout: 20000 });
    await guestPage.locator('#guestConversationStatus').filter({ hasText: /Waiting for .* to (unlock encrypted access|approve you)/ }).waitFor({ timeout: 15000 });
    assert.equal(await guestPage.locator('#guestComposer').isVisible(), false, 'Guests must wait for encrypted admission while the owner is absent');
    // Link guests now wait for owner approval (065). Approve through the real
    // route; the locked owner dashboard must then ask for a local unlock.
    const waitingGuestId = (await query("SELECT guest_id FROM shared_guest_members WHERE conversation_id=$1 AND status='pending' AND approved_at IS NULL", [convertedConversationId])).rows[0]?.guest_id;
    assert.ok(waitingGuestId, 'the link guest must wait for owner approval');
    const approvalToken = (await (await ac.request.get(baseUrl + '/csrf-token')).json()).csrfToken;
    const approval = await ac.request.post(`${baseUrl}/api/user/shared/${convertedConversationId}/guests/${waitingGuestId}/approve`, { headers: { 'x-csrf-token': approvalToken } });
    assert.equal(approval.status(), 200, await approval.text());
    conversionPage = await ac.newPage();
    conversionPage.on('pageerror', error => pageErrors.push(error.message));
    await conversionPage.route('https://**/*', route => new URL(route.request().url()).hostname === 'cdn.tailwindcss.com' ? route.continue() : route.abort());
    await conversionPage.goto(baseUrl + '/fixture/dashboard?locked=1');
    await conversionPage.locator('#sharingAccessNotice').waitFor({ state: 'visible', timeout: 20000 });
    assert.match(await conversionPage.locator('#sharingAccessNoticeText').textContent(), /Unlock your account encryption locally/);
    // Store a locally unlocked fixture key through the real encryption module;
    // its unlock event must promptly restart admission without selecting a room.
    await conversionPage.evaluate(async encoded => {
      const raw = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const localKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
      await window.E2EEncryption.storeEncryptionKey(localKey);
      await checkEncryptionKey();
      document.getElementById('decryptionPasswordModal').classList.add('hidden');
    }, key);
    await conversionPage.locator('#sharingAccessNotice').waitFor({ state: 'hidden', timeout: 20000 });
    await guestPage.locator('#guestTimeline').getByText('Populated private history to convert', { exact: true }).waitFor({ timeout: 30000 });
    const guestFileDownload = guestPage.locator('#guestTimeline').getByRole('button', { name: 'Download design-notes.txt', exact: true });
    await guestFileDownload.waitFor({ timeout: 20000 });
    const guestDownload = guestPage.waitForEvent('download');
    await guestFileDownload.click();
    assert.equal((await guestDownload).suggestedFilename(), 'design-notes.txt');
    assert.equal((await query('SELECT COUNT(*)::int AS count FROM shared_messages WHERE conversation_id=$1 AND dispatch_eligible=FALSE', [convertedConversationId])).rows[0].count, 3);
    // Guest replies belong to this populated ordinary conversation. Check the
    // actual hit target, including landscape and the space left by a keyboard.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 },
      { width: 844, height: 390 }, { width: 390, height: 500 }, { width: 320, height: 568 }]) {
      await guestPage.setViewportSize(viewport);
      const reachable = await guestPage.locator('#guestComposer button[type="submit"]').evaluate(button => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth
          && (hit === button || button.contains(hit));
      });
      assert(reachable, `Guest send button is clipped or covered at ${viewport.width}×${viewport.height}`);
    }
    await guestPage.locator('.chat-send-label').waitFor({ state: 'visible' });
    await guestPage.locator('#guestMessage').fill('Guest reply in the same regular conversation');
    await guestPage.getByRole('button', { name: 'Send message', exact: true }).click();
    await conversionPage.evaluate(async id => {
      const context = await (await fetch('/api/user/chat-threads/' + id)).json();
      await window.DashboardHelpers.selectChatContext(context);
    }, convertedConversationId);
    await conversionPage.locator('#conversationArea').getByText('Guest reply in the same regular conversation', { exact: true }).waitFor({ timeout: 20000 });
    const secondGuestContext = await browser.newContext();
    const secondGuestPage = await secondGuestContext.newPage();
    secondGuestPage.on('pageerror', error => pageErrors.push(error.message));
    await secondGuestPage.route('https://**/*', route => route.abort());
    await secondGuestPage.goto(guestLink);
    await secondGuestPage.locator('#guestDisplayName').fill('Other in-place guest');
    await secondGuestPage.getByRole('button', { name: 'Join chat', exact: true }).click();
    let secondWaitingGuestId;
    for (let attempt = 0; attempt < 150 && !secondWaitingGuestId; attempt += 1) {
      secondWaitingGuestId = (await query("SELECT guest_id FROM shared_guest_members WHERE conversation_id=$1 AND status='pending' AND approved_at IS NULL", [convertedConversationId])).rows[0]?.guest_id;
      if (!secondWaitingGuestId) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(secondWaitingGuestId, 'the second link guest must wait for owner approval');
    const secondApprovalToken = (await (await ac.request.get(baseUrl + '/csrf-token')).json()).csrfToken;
    const secondApproval = await ac.request.post(`${baseUrl}/api/user/shared/${convertedConversationId}/guests/${secondWaitingGuestId}/approve`, { headers: { 'x-csrf-token': secondApprovalToken } });
    assert.equal(secondApproval.status(), 200, await secondApproval.text());
    await secondGuestPage.locator('#guestComposer').waitFor({ state: 'visible', timeout: 30000 });
    const guests = (await query("SELECT guest_id,display_name FROM guest_principals WHERE share_id=$1", [guestShareId])).rows;
    const selectedGuest = guests.find(person => person.display_name === 'In-place guest');
    const sharedService = require('../../src/shared/service');
    await sharedService.registerRuntime(agentId, { runtimeId: runner.runtimeId, protocol: 2, executionMode: 'trusted', profiles: [{ provider: 'fixture', model: 'test' }] });
    const roomVersion = (await query('SELECT key_version FROM shared_conversations WHERE id=$1', [convertedConversationId])).rows[0].key_version;
    const wrapped = (await query('SELECT wrapped_key FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [convertedConversationId, roomVersion, `agent:${agentId}`])).rows[0].wrapped_key;
    const roomKey = await C.unwrap(wrapped, runner.privateKey);
    const deliveries = [
      { text: 'Private agent reply for owner', audience: { mode: 'owner' } },
      { text: 'Agent reply for owner and selected guest', audience: { mode: 'selected', principals: [{ kind: 'guest', id: selectedGuest.guest_id }] } },
      { text: 'Agent reply for everyone', audience: { mode: 'all' } }
    ];
    for (const delivery of deliveries) await sharedService.agentSend(agentId, convertedConversationId, {
      id: crypto.randomUUID(), keyVersion: roomVersion, audience: delivery.audience,
      payload: await C.encrypt(roomKey, { text: delivery.text }, `${convertedConversationId}:${roomVersion}`)
    }, runner.runtimeId);
    for (const delivery of deliveries) await conversionPage.locator('#conversationArea').getByText(delivery.text, { exact: true }).waitFor({ timeout: 20000 });
    await conversionPage.waitForFunction(texts => {
      const area = document.getElementById('conversationArea');
      return texts.every(text => [...area.querySelectorAll('.message-content')].some(node => node.textContent.trim() === text)) &&
        area.querySelector('.shared-message-audience--owner') && area.querySelector('.shared-message-audience--selected') &&
        area.querySelector('.shared-message-audience--all');
    }, [...deliveries.map(delivery => delivery.text), 'Guest reply in the same regular conversation'], { timeout: 20000 });
    await guestPage.locator('#guestTimeline').getByText(deliveries[1].text, { exact: true }).waitFor({ timeout: 20000 });
    await guestPage.locator('#guestTimeline').getByText(deliveries[2].text, { exact: true }).waitFor({ timeout: 20000 });
    await secondGuestPage.locator('#guestTimeline').getByText(deliveries[2].text, { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await guestPage.getByText(deliveries[0].text, { exact: true }).count(), 0, 'Owner-only replies must not reach guests');
    assert.equal(await secondGuestPage.getByText(deliveries[0].text, { exact: true }).count(), 0);
    assert.equal(await secondGuestPage.getByText(deliveries[1].text, { exact: true }).count(), 0, 'Selected replies must not reach unselected guests');
    await secondGuestContext.close();
    const guestReply = (await query('SELECT sender_guest_id, dispatch_eligible FROM shared_messages WHERE conversation_id=$1 AND sender_guest_id IS NOT NULL ORDER BY seq DESC LIMIT 1', [convertedConversationId])).rows[0];
    assert(guestReply.sender_guest_id, 'The guest reply must retain its guest identity');
    assert.equal(guestReply.dispatch_eligible, true, 'Guest replies must be available to the existing agent runtime');
    await conversionPage.goto(baseUrl + '/fixture/dashboard');
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, convertedConversationId, { timeout: 30000 });
    await conversionPage.locator('#conversationArea').getByText('Guest reply in the same regular conversation', { exact: true }).waitFor({ timeout: 30000 });
    await conversionPage.locator(`#agentListScroll .agent-list-item[data-agent-id="${privateAgentId}"]`).click();
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedAgentIdentity?.()?.agentId === id, privateAgentId);
    await conversionPage.locator(`#agentListScroll .agent-list-item[data-agent-id="${agentId}"]`).click();
    await conversionPage.waitForFunction(id => window.DashboardHelpers?.getSelectedChatContext?.()?.conversationId === id, convertedConversationId);
    await conversionPage.locator('#conversationArea').getByText('Guest reply in the same regular conversation', { exact: true }).waitFor({ timeout: 20000 });
    await guestContext.close();
    await conversionPage.close();
    await b.close();
    // A lost send followed by member removal must rekey the durable outbox and file.
    await a.route('**/api/user/shared/*/messages', async route => {
      if (route.request().method() === 'POST') await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'Simulated send outage'
          }
        })
      });else await route.continue();
    });
    await a.locator('#sharedComposer textarea').fill('Retry safely after rotation');
    await a.locator('#sharedComposer input[type=file]').setInputFiles({
      name: 'retry.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Preserved retry attachment')
    });
    await a.locator('#sharedComposer button').first().click();
    await a.getByText('Simulated send outage', { exact: false }).waitFor({ timeout: 10000 }).catch(async e => { console.error('Outbox UI error:', await a.locator('#sharedError').textContent()); throw e; });
    await a.unroute('**/api/user/shared/*/messages');
    await require('../../src/shared/service').membership(alice.userId, roomId, bob.userId, {});
    await a.locator('#sharedComposer button').first().click();
    await a.getByText('Retry safely after rotation', { exact: true }).waitFor({ timeout: 15000 }).catch(async e => {
      console.error('Retry UI error:', await a.locator('#sharedError').textContent(), await a.locator('#sharedStatus').textContent());
      console.error('Legacy shared network statuses:', JSON.stringify(legacySharedNetwork));
      console.error('Room key state:', JSON.stringify((await query('SELECT key_version,membership_version,rotation_required FROM shared_conversations WHERE id=$1',[roomId])).rows[0]));
      throw e;
    });
    const retried = (await query('SELECT key_version FROM shared_messages WHERE sender_user_id=$1 ORDER BY seq DESC LIMIT 1', [alice.userId])).rows[0];
    assert.equal(retried.key_version, 2);
    assert.equal((await query('SELECT COUNT(*) AS count FROM shared_files WHERE uploader=$1 AND conversation_id=$2', ['user:' + alice.userId,roomId])).rows[0].count, '1');
    assert.deepEqual(pageErrors, []);
    console.log('PASS: mobile expired-CSRF sharing recovery with editable email and preserved draft; ordinary dashboard owner/member shared composer and deep-link/sidebar selection; populated private-history conversion with preserved question answers and shared question replies, account invitation acceptance while the owner views another private chat, local-password encrypted history without sharing the owner key, tappable regular mobile chat list, no duplicate owned shared rows, and same-thread guest history; desktop/mobile legacy agent-icon sharing, bounded menus and dialog Escape, stable picker through polling, two real browsers, real authenticated routes, RSA/AES keys, full shared history, batched attributed replies, encrypted upload/download, addressed/group questions, reconnect, outbox/file rekey after member removal. Screenshots: ' + out);
  } finally {
    await browser?.close();
    await menuContext?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
    delete process.env.FEATURE_GUEST_SHARING;
    fs.rmSync(directory, {
      recursive: true,
      force: true
    });
  }
}
main().catch(e => {
  console.error(e.stack);
  process.exitCode = 1;
});
