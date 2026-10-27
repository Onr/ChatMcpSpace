const { test, expect } = require('@playwright/test');
const express = require('express');
const ejs = require('ejs');
const path = require('path');
const root = path.join(__dirname, '../..');
const { assetUrl } = require('../../src/utils/assetUrl');
const DeviceBadge = require('../../public/js/device-badge');
const { safeJsonForScript } = require('../../src/utils/safeJsonHelper');
const agents = [{ agentId: 'personal', name: 'Personal notes', agentType: 'standard', position: 1,
  highestPriority: 'low', unreadCount: 0, marbleSvg: '' }];
agents.push(...['research', 'writer', 'reviewer'].map((agentId, i) => ({...agents[0], agentId, name: agentId + ' with a long chat name', position: i + 2})));
const shared = { conversationId: 'shared-room', agentId: 'colleague-agent', agentName: 'Team conversation',
  ownerId: 'colleague', mode: 'shared', state: 'shared', role: 'participant', membershipStatus: 'active',
  capabilities: { read: false, send: false } };
let server, origin;
test.setTimeout(60000);
test.use({ launchOptions: { args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } });
test.beforeEach(async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('cos_modal_dismissed_at', new Date().toISOString()));
});
test.beforeAll(async () => {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const app = express(); app.use(express.json());
  app.use(express.static(path.join(root, 'public')));
  app.get('/dashboard', async (_req, res) => {
    const locals = { agents, groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
      assetUrl, DeviceBadge, safeJsonForScript, currentPath: '/dashboard', user: { userId: 'fixture', email: 'fixture@example.test' } };
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    const html = await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body });
    res.send(html.replace(/<link[^>]*fonts\.g(?:oogleapis|static)\.com[^>]*>/g, ''));
  });
  app.get('/api/user/agents', (_req, res) => res.json({ agents, groups: [] }));
  app.get('/api/user/chat-threads', (_req, res) => res.json([shared]));
  app.get('/api/user/chat-threads/invitations/incoming', (_req, res) => res.json([]));
  app.get('/api/user/chat-threads/shared-room', (_req, res) => res.json(shared));
  app.get('/api/user/chat-threads/invitations/direct-invite', (_req, res) => res.json({
    agentName: 'Invited conversation', ownerDisplayName: 'A colleague', verified: true }));
  app.post('/api/user/chat-threads/resolve', (req, res) => res.json({ agentId: req.body.agentId,
    agentName: agents.find(a => a.agentId === req.body.agentId)?.name, conversationId: 'personal-thread', mode: 'private', state: 'private', role: 'owner' }));
  app.get('/api/user/shared/shared-room', (_req, res) => res.json({ room: { owner_id: 'colleague' }, members: [] }));
  app.get('/api/user/shared/identity', (_req, res) => res.status(404).json({ error: { message: 'Synthetic fixture is locked' } }));
  app.get('/api/user/messages/:agentId', (_req, res) => res.json({ messages: [], hasMore: false }));
  app.get('/dashboard/config', (_req, res) => res.json({}));
  app.use('/api', (_req, res) => res.json([]));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
async function ready(page, suffix = '') {
  await page.goto(origin + '/dashboard' + suffix, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.dashboardReady);
  const later = page.getByRole('button', { name: 'Maybe later', exact: true });
  if (await later.isVisible()) await later.click({force:true});
}
async function selected(page, id) {
  await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe(id);
}
async function openShared(page) {
  await page.locator('[data-shared-conversation-id="shared-room"]').click();
  await selected(page, 'colleague-agent');
}
async function openPersonal(page, id) {
  await page.evaluate(() => setMobileListExpanded(true));
  await page.locator(`#agentListScroll .agent-list-item[data-agent-id="${id}"]`).click();
  await selected(page, id);
}
const ids = page => page.locator('#recentChats button').evaluateAll(buttons => buttons.map(b => JSON.parse(b.dataset.chatKey)[0]));
for (const width of [390, 1280]) {
  test(`recent chats track real personal/shared navigation, reorder and survive reload at ${width}px`, async ({page}) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width,height:900}); await ready(page);
    await expect(page.locator('#recentChats button')).toHaveCount(0);
    await openPersonal(page,'personal'); await openPersonal(page,'research'); await openPersonal(page,'writer');
    await openPersonal(page,'reviewer');
    expect(await ids(page)).toEqual(['reviewer','writer','research']);
    if(width<1024) await page.evaluate(()=>setMobileListExpanded(true));
    await expect(page.locator('#recentChatsTitle')).toBeVisible();
    await expect(page.locator('#recentChatsHint')).toHaveText('Last 3 opened · Newest first');
    await expect(page.getByRole('navigation', {name:'Recent chats'})).toBeVisible();
    const opacities = await page.locator('#recentChats button').evaluateAll(btns =>
      btns.map(b => parseFloat(getComputedStyle(b).opacity))
    );
    expect(opacities).toHaveLength(3);
    expect(opacities[0]).toBeGreaterThan(opacities[1]);
    expect(opacities[1]).toBeGreaterThan(opacities[2]);
    await page.locator('#recentChats button').nth(2).click(); await selected(page,'research');
    expect(await ids(page)).toEqual(['research','reviewer','writer']);
    if(width<1024) await page.evaluate(()=>setMobileListExpanded(true));
    await openShared(page);
    expect(await ids(page)).toEqual(['colleague-agent','research','reviewer']);
    await page.reload(); await page.waitForFunction(()=>window.dashboardReady);
    await selected(page,'colleague-agent');
    await expect(page.locator('#recentChats button')).toHaveCount(3);
    if(width<1024) await page.evaluate(()=>setMobileListExpanded(true));
    await page.locator('#recentChats button').nth(1).focus(); await page.keyboard.press('Enter'); await selected(page,'research');
    if(width<1024) await page.evaluate(()=>setMobileListExpanded(true));
    await page.locator('#recentChats button').filter({has:page.locator('.recent-chat__shared')}).click(); await selected(page,'colleague-agent');
    if(width<1024) await page.evaluate(()=>setMobileListExpanded(true));
    await expect(page.locator('#recentChats')).toBeVisible();
    await page.screenshot({path:test.info().outputPath(`recent-${width}.png`)});
    expect(errors).toEqual([]);
  });
}
test('labelled shortcuts and Back fit as the divider changes chamber width', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000}); await ready(page);
  for(const id of ['personal','research','writer']) await openPersonal(page,id);
  await page.evaluate(()=>{
    stopAgentPolling();
    currentGroups=[{groupId:'team',groupName:'Team',memberIds:currentAgentList.map(a=>a.agentId)}];
    cachedGroupPartition=null; enterGroupView('team');
  });
  const handle = page.locator('#councilResizeHandle');
  for(const width of [310,500,360]) {
    const bounds=await handle.boundingBox(); const chamber=await page.locator('.council-chamber').boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2); await page.mouse.down();
    await page.mouse.move(bounds.x+width-chamber.width,bounds.y+bounds.height/2,{steps:8}); await page.mouse.up();
    await expect(page.locator('#groupBackBtn')).toBeVisible();
    await expect(page.locator('#recentChatsTitle')).toBeVisible();
    const boxes=await page.locator('.council-chat-shortcuts').evaluate(row=>{
      const r=row.getBoundingClientRect();
      return {left:r.left,right:r.right,buttons:[...row.querySelectorAll('button')].map(b=>{
        const box=b.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:box.height,width:box.width};
      })};
    });
    expect(boxes.buttons).toHaveLength(4);
    for(let i=0;i<boxes.buttons.length;i++) {
      expect(boxes.buttons[i].left).toBeGreaterThanOrEqual(boxes.left - 1);
      expect(boxes.buttons[i].right).toBeLessThanOrEqual(boxes.right + 1);
      expect(boxes.buttons[i].width).toBeGreaterThanOrEqual(34);
      expect(boxes.buttons[i].height).toBeGreaterThanOrEqual(22);
      expect(boxes.buttons[i].height).toBeLessThanOrEqual(36);
      for(let j=0;j<i;j++) {
        const earlier=boxes.buttons[j], current=boxes.buttons[i];
        expect(current.left>=earlier.right || current.right<=earlier.left || current.top>=earlier.bottom || current.bottom<=earlier.top).toBe(true);
      }
    }
  }
  await page.locator('.council-chamber').screenshot({path:test.info().outputPath('recent-with-back.png')});
  await page.locator('#groupBackBtn').click();
  await expect(page.locator('#recentChats')).toBeVisible();
});
