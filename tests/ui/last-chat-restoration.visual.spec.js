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
const shared = { conversationId: 'shared-room', agentId: 'colleague-agent', agentName: 'Team conversation',
  ownerId: 'colleague', mode: 'shared', state: 'shared', role: 'participant', membershipStatus: 'active',
  capabilities: { read: false, send: false } };
let server, origin;
test.beforeAll(async () => {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const app = express(); app.use(express.json());
  app.use(express.static(path.join(root, 'public')));
  app.get('/dashboard', async (_req, res) => {
    const locals = { agents, groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
      assetUrl, DeviceBadge, safeJsonForScript, currentPath: '/dashboard', user: { userId: 'fixture', email: 'fixture@example.test' } };
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body }));
  });
  app.get('/api/user/agents', (_req, res) => res.json({ agents, groups: [] }));
  app.get('/api/user/chat-threads', (_req, res) => res.json([shared]));
  app.get('/api/user/chat-threads/invitations/incoming', (_req, res) => res.json([]));
  app.get('/api/user/chat-threads/shared-room', (_req, res) => res.json(shared));
  app.get('/api/user/chat-threads/invitations/direct-invite', (_req, res) => res.json({
    agentName: 'Invited conversation', ownerDisplayName: 'A colleague', verified: true }));
  app.post('/api/user/chat-threads/resolve', (req, res) => res.json({ agentId: req.body.agentId,
    agentName: 'Personal notes', conversationId: 'personal-thread', mode: 'private', state: 'private', role: 'owner' }));
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
  await page.goto(origin + '/dashboard' + suffix);
  await page.waitForFunction(() => window.dashboardReady);
  const later = page.getByRole('button', { name: 'Maybe later', exact: true });
  if (await later.isVisible()) await later.click();
}
async function selected(page, id) {
  await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe(id);
}
async function openShared(page) {
  await page.locator('[data-shared-conversation-id="shared-room"]').click();
  await selected(page, 'colleague-agent');
}
for (const width of [390, 1280]) {
  test(`shared to private reopens the last chat after reload and a new tab at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 850 }); await ready(page);
    await openShared(page);
    await expect(page).toHaveURL(/conversationId=shared-room/);
    // Use the actual dashboard picker control on mobile before selecting a personal chat.
    if (width < 1024) await page.evaluate(() => setMobileListExpanded(true));
    await page.locator('#agentListScroll .agent-list-item[data-agent-id="personal"]').click();
    await selected(page, 'personal');
    await expect(page).toHaveURL(origin + '/dashboard');
    await page.reload(); await page.waitForFunction(() => window.dashboardReady);
    await selected(page, 'personal');
    await expect(page.locator('#selectedAgentName')).toHaveText('Personal notes');
    const reopened = await context.newPage(); await reopened.setViewportSize({ width, height: 850 });
    await ready(reopened); await selected(reopened, 'personal');
    await expect(reopened.locator('#selectedAgentName')).toHaveText('Personal notes');
    await reopened.close();
  });
  test(`a last shared chat restores on a fresh dashboard visit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 }); await ready(page); await openShared(page);
    await ready(page); await selected(page, 'colleague-agent');
    await expect(page.locator('#selectedAgentName')).toHaveText('Team conversation');
    await expect(page).toHaveURL(/conversationId=shared-room/);
  });
}
test('an explicit shared link overrides saved private memory without briefly opening the private chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 }); await ready(page);
  await page.evaluate(() => selectAgent('personal', 'Personal notes', { forceMainSelection: true }));
  let privateLookups = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/user/chat-threads/resolve') privateLookups++; });
  await ready(page, '?conversationId=shared-room'); await selected(page, 'colleague-agent');
  expect(privateLookups).toBe(0);
});
test('an invitation link shows Join instead of restoring the saved chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 }); await ready(page);
  await page.evaluate(() => selectAgent('personal', 'Personal notes', { forceMainSelection: true }));
  await ready(page, '?invitationId=direct-invite');
  await expect(page.getByRole('button', { name: 'Join chat', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity())).toBeNull();
});
