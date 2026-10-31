const { test, expect } = require('@playwright/test');
const express = require('express');
const ejs = require('ejs');
const path = require('path');
const root = process.env.DOCKED_LIST_ROOT || path.join(__dirname, '../..');
const { assetUrl } = require(path.join(root, 'src/utils/assetUrl'));
const DeviceBadge = require(path.join(root, 'public/js/device-badge'));
const { safeJsonForScript } = require(path.join(root, 'src/utils/safeJsonHelper'));
const agents = Array.from({ length: 45 }, (_, i) => ({ agentId: `agent-${i}`, name: `Reviewer ${i}`,
  agentType: 'standard', position: i + 1, highestPriority: 'low', lastMessagePriority: 'low', unreadCount: 0, marbleSvg: '' }));
let server, origin;
test.beforeAll(async () => {
  const app = express();
  app.use(express.static(path.join(root, 'public')));
  app.get('/dashboard', async (_req, res) => {
    const locals = { agents, groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
      assetUrl, DeviceBadge, safeJsonForScript, currentPath: '/dashboard', user: { userId: 'fixture', email: 'fixture@example.test' } };
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body }));
  });
  app.get('/api/user/agents', (_req, res) => res.json({ agents, groups: [] }));
  app.get('/api/user/messages/:agentId', (_req, res) => res.json({ messages: [], hasMore: false }));
  app.get('/dashboard/config', (_req, res) => res.json({}));
  app.use('/api', (_req, res) => res.json([]));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
for (const [width, height] of [[844, 390], [740, 360]]) {
  test(`sideways phone ${width}x${height} leaves room for the chat`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.addInitScript(() => localStorage.setItem('cos_modal_dismissed_at', new Date().toISOString()));
    await page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashboardReady);
    const later = page.getByRole('button', { name: 'Maybe later', exact: true });
    if (await later.isVisible()) await later.click();
    const item = page.locator('.agent-list-item[data-agent-id="agent-0"]:visible').first();
    if (await item.count()) await item.click();
    await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe('agent-0');
    await page.waitForTimeout(400);
    if (process.env.LANDSCAPE_SHOTS) await page.screenshot({ path: `${process.env.LANDSCAPE_SHOTS}/landscape-${width}x${height}.png` });
    const navHeight = await page.evaluate(() => document.querySelector('nav')?.getBoundingClientRect().height || 0);
    expect(navHeight).toBeLessThan(height * 0.25);
    const input = page.locator('#userMessageInput');
    if (await input.count()) {
      const box = await input.boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(height + 1);
      expect(box.y).toBeGreaterThan(0);
    }
    const chat = await page.locator('#conversationArea').boundingBox();
    expect(chat.height).toBeGreaterThan(height * 0.3);
    await context.close();
  });
}
