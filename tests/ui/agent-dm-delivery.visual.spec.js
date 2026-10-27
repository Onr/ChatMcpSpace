const { test, expect } = require('@playwright/test');
const path = require('path');
const root = path.join(__dirname, '../..');
for (const width of [390, 1280]) {
  test(`agent delivery receipts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const html = '<!doctype html><html><head></head><body><div id="councilCircle"></div><div id="agentChatsScroll"></div><div id="agentPanelHeader"></div><div id="conversationArea" style="height:360px;overflow:auto"></div><div id="agentInputBox"></div></body></html>';
    await page.route('https://dm.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://dm.test/');
    await page.addStyleTag({ path: path.join(root, 'public/css/tailwind.css') });
    await page.addStyleTag({ path: path.join(root, 'public/css/style.css') });
    await page.evaluate(() => { window.__dashboardLoopPaused = true; });
    await page.addScriptTag({ path: path.join(root, 'public/js/agentConnections.js') });
    const conn = { agent1Id: 'a', agent2Id: 'b', agent1Name: 'Research agent', agent2Name: 'Writing agent', messageCount: 2, pendingCount: 1, lastMessage: new Date().toISOString() };
    const messages = [
      { messageId: 'one', senderId: 'a', recipientId: 'b', content: 'Please check this error in the results.', timestamp: conn.lastMessage, delivery: { state: 'received', recipientOnline: true } },
      { messageId: 'two', senderId: 'a', recipientId: 'b', content: 'Write the results once your runner reconnects.', timestamp: conn.lastMessage, delivery: { state: 'pending', recipientOnline: false } }
    ];
    await page.route('**/api/user/agent-messages*', route => route.fulfill({ json: { connections: [conn], messages } }));
    await page.evaluate(() => window.AgentConnections.refresh());
    await expect(page.locator('#agentChatsScroll')).toContainText('1 pending');
    await page.locator('.agent-chat-item').click();
    await expect(page.getByRole('status').filter({ hasText: 'Queued · recipient offline' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Received by agent' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('delivery-offline.png') });
    const bubble = page.locator('[data-direct-message-id="two"]');
    await bubble.evaluate(node => { node.dataset.retained = 'yes'; });
    messages[1].delivery = { state: 'received', recipientOnline: true };
    conn.pendingCount = 0;
    await page.evaluate(() => window.AgentConnections.refresh());
    await expect(bubble).toHaveAttribute('data-retained', 'yes');
    await expect(bubble.getByRole('status')).toHaveText('Received by agent');
    await expect(page.locator('#agentChatsScroll')).not.toContainText('pending');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
