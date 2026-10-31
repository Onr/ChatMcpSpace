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
for (const width of [768, 952, 1180]) for (const fast of [false, true]) {
  test(`agent list stays beside the chat at ${width}px, fast=${fast}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 914 }, hasTouch: true });
    const page = await context.newPage();
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('https://fonts.gstatic.com/**', route => route.abort());
    await page.addInitScript(fast => {
      localStorage.setItem('cos_modal_dismissed_at', new Date().toISOString());
      if (fast) localStorage.setItem('dashboardFastMode', '1');
    }, fast);
    await page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashboardReady);
    const later = page.getByRole('button', { name: 'Maybe later', exact: true });
    if (await later.isVisible()) await later.click();
    const list = page.locator('#agentListPanel'), search = page.locator('#agentListSearchInput');
    await expect(search).toBeVisible();
    const first = page.locator('#agentListScroll .agent-list-item[data-agent-id="agent-0"]');
    await first.click();
    await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe('agent-0');
    // Selection collapses the mobile overlay; the docked list must remain rendered.
    await expect(list).not.toHaveClass(/mobile-expanded/);
    await expect(page.locator('#agentListScroll .agent-list-item')).toHaveCount(45);
    await expect(search).toBeVisible();
    const sidebar = await list.boundingBox(), chat = await page.locator('#multiChatContainer').boundingBox();
    expect(sidebar.x).toBeGreaterThanOrEqual(chat.x + chat.width - 1);
    expect(sidebar.height).toBeGreaterThan(500);
    expect(chat.width).toBeGreaterThan(360);
    await expect(page.locator('#collapseMobileListBtn')).toBeHidden();
    await expect(page.locator('#fastModeChatListToggle')).toBeHidden();
    expect(await page.locator('#agentListScroll').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn')).toBeVisible();
    await page.setViewportSize({ width, height: 914 });
    await expect(search).toBeVisible();
    await expect(page.locator('#agentListScroll .agent-list-item')).toHaveCount(45);
    await search.click();
    await search.fill('Reviewer 44');
    await expect(page.locator('#agentListScroll .agent-list-item')).toHaveCount(1);
    await page.locator('#agentListScroll .agent-list-item[data-agent-id="agent-44"]').click();
    await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe('agent-44');
    await page.screenshot({ path: test.info().outputPath('docked.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('dashboard-mobile'))).toBe(true);
    const toggle = page.locator(fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(search).toBeVisible();
    await page.setViewportSize({ width, height: 914 });
    await expect(toggle).toBeHidden();
    await expect(search).toBeVisible();
    await page.evaluate(() => setMobileListExpanded(false, { skipBrowserHistory: true }));
    await expect(search).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.close();
  });
}
