const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const root = process.env.SHARING_FIX_ROOT || path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/js/dashboard.js');
const menuCode = source.slice(source.indexOf('function setupCopyButtons()'), source.indexOf('function setupDeleteConfirmationModal()'));
const id = '11111111-1111-4111-8111-111111111111';
for (const width of [390, 1280]) {
  test(`sharing opens from the agent name and persists its switch at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const flagNames = ['FEATURE_SHARED_CONVERSATIONS', 'FEATURE_IN_PLACE_AGENT_SHARING', 'FEATURE_GUEST_SHARING'];
    const previous = flagNames.map(name => process.env[name]);
    flagNames.forEach(name => process.env[name] = 'true');
    let html;
    try { html = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), { agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
      csrfToken: 'fixture', cspNonce: 'fixture', assetUrl: p => p, safeJsonForScript: JSON.stringify,
      user: { userId: 'fixture', email: 'fixture@example.test' } });
    } finally { flagNames.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }); }
    let enabled = true, rejectNext = false, createdShare = null, approved = null, savedLimits = null, accountApproved = null;
    await page.route('https://sharing-switch.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
      if (url.pathname.endsWith('/sharing')) {
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 503, json: { error: { message: 'Please retry saving sharing.' } } }); }
        enabled = route.request().postDataJSON().enabled;
        return route.fulfill({ json: { enabled } });
      }
      if (url.pathname.endsWith('/guest-shares') && route.request().method() === 'POST') {
        createdShare = route.request().postDataJSON();
        return route.fulfill({ json: { shareId: 'share-1', linkSecret: 'fixture-secret' } });
      }
      if (url.pathname.endsWith('/guest-shares/share-1') && route.request().method() === 'PATCH') {
        savedLimits = route.request().postDataJSON();
        return route.fulfill({ json: { shareId: 'share-1', expires_at: null, max_messages: savedLimits.maxMessages } });
      }
      if (url.pathname.includes('/access-requests/') && url.pathname.endsWith('/approve')) { accountApproved = url.pathname; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname.endsWith('/approve')) { approved = url.pathname; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname.endsWith('/invitations') || url.pathname.endsWith('/guest-shares')) return route.fulfill({ json: [] });
      return route.fulfill({ json: { room: { sharing_enabled: enabled }, members: [], guests: [],
        guestRequests: approved ? [] : [{ guest_id: 'guest-1', display_name: 'Dana', status: 'pending', request_note: 'From the studio' }],
        accountRequests: accountApproved ? [] : [{ request_id: 'request-1', user_id: 'user-2', display_name: 'Lee', email: 'lee@example.test', note: 'Teammate' }] } });
    });
    await page.goto('https://sharing-switch.test/');
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    await page.evaluate(() => {
      const ids = ['agentHeaderInfo', 'agentContextMenu', 'floatingAgentMenu', 'shareExistingChatDialog', 'headerShareExistingChatBtn'];
      const nodes = ids.map(id => document.getElementById(id));
      document.body.replaceChildren(...nodes);
      document.getElementById('agentHeaderInfo').style.cssText = 'margin:20px;width:260px';
      document.getElementById('selectedAgentName').textContent = 'Mira';
    });
    for (const css of ['tailwind', 'style', 'agent-actions', 'in-place-sharing']) await page.addStyleTag({ content: read(`public/css/${css}.css`) });
    await page.addScriptTag({ content: `
      let selectedAgentId = '${id}', selectedAgentName = 'Mira', selectedAgentType = 'standard';
      const setupAgentCliMenuButtons = () => {}, updateAgentCliMenuButton = () => {}, refreshAgentActionStats = () => {}, resolveAgentStatsMetadata = () => ({});
      const hideFloatingAgentMenu = () => document.getElementById('floatingAgentMenu').classList.add('hidden');
      const findCachedAgentRecord = () => ({name:'Mira'}), showErrorMessage = message => { throw new Error(message); };
      window.DashboardHelpers = { getSelectedAgentIdentity: () => ({agentId:selectedAgentId, conversationId:'${id}', agentName:'Mira', mode:'shared', role:'owner'}) };
      ${menuCode}\nsetupCopyButtons();` });
    await page.addScriptTag({ content: read('public/js/agent-actions-ui.js') });
    await page.addScriptTag({ content: read('public/js/chat-history-import.js') });
    await page.locator('#selectedAgentName').click();
    await expect(page.locator('#shareAgentFromContextMenu')).toBeInViewport();
    await page.locator('#shareAgentFromContextMenu').click();
    const toggle = page.getByRole('switch', { name: 'Agent sharing' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();
    rejectNext = true;
    await toggle.click();
    await expect(page.locator('#shareExistingChatStatus')).toContainText('Please retry');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#shareExistingChatInvites')).toBeHidden();
    await expect(page.locator('#shareGuestControls')).toBeHidden();
    await page.locator('#shareExistingChatClose').click();
    await page.locator('#selectedAgentName').click();
    await page.locator('#shareAgentFromContextMenu').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath(`sharing-off-${width}.png`) });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#shareExistingChatInvites')).toBeVisible();
    await expect(page.locator('#shareGuestControls')).toBeVisible();
    await expect(page.locator('#shareLinkSend')).toBeVisible();
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copied = value; } } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared = data; } }); });
    await expect(page.locator('#shareInviteList')).toContainText('From the studio');
    await expect(page.locator('#shareInviteList')).toContainText('Lee (lee@example.test) · Asks to join with an account');
    await expect(page.locator('#shareInviteList')).toContainText('Teammate');
    await page.getByRole('button', { name: 'Approve Lee (lee@example.test)' }).click();
    await expect(page.getByRole('button', { name: 'Approve Lee (lee@example.test)' })).toHaveCount(0);
    expect(accountApproved).toMatch(/\/access-requests\/request-1\/approve$/);
    await page.getByRole('button', { name: 'Approve Dana' }).click();
    await expect(page.getByRole('button', { name: 'Approve Dana' })).toHaveCount(0);
    expect(approved).toMatch(/\/guests\/guest-1\/approve$/);
    // With no requests waiting, Copy link is visible without scrolling.
    await expect(page.locator('#shareLinkCopy')).toBeInViewport();
    await expect(page.locator('#shareGuestExpiresAtLabel')).toBeHidden();
    await page.locator('#shareGuestExpiryPreset').selectOption({ label: 'Until a date…' });
    await expect(page.locator('#shareGuestExpiresAtLabel')).toBeVisible();
    await page.locator('#shareGuestExpiryPreset').selectOption({ label: '1 day' });
    await page.locator('#shareGuestMaxMessages').fill('5');
    await page.locator('#shareGuestAccessMode').selectOption('request');
    await expect(page.locator('#shareGuestLimitsSave')).toBeHidden();
    await page.locator('#shareLinkCopy').click();
    await expect(page.locator('#shareGuestLinkStatus')).toContainText('Link copied');
    expect(createdShare.maxMessages).toBe(5);
    expect(createdShare.accessMode).toBe('request');
    await expect(page.locator('#shareLinkQuickHint')).toContainText('asked to send you a request');
    expect(Math.abs(new Date(createdShare.expiresAt).getTime() - Date.now() - 86400000)).toBeLessThan(60000);
    await expect(page.locator('#shareGuestLimitsSave')).toBeVisible();
    await page.locator('#shareGuestExpiryPreset').selectOption({ label: 'No time limit' });
    await page.locator('#shareGuestMaxMessages').fill('20');
    await page.locator('#shareGuestLimitsSave').click();
    await expect(page.locator('#shareGuestLimitsStatus')).toContainText('20 messages per guest');
    expect(savedLimits).toEqual({ expiresAt: null, maxMessages: 20, accessMode: 'request' });
    expect(await page.evaluate(() => window.__copied)).toBe('https://sharing-switch.test/guest#fixture-secret');
    await page.locator('#shareLinkSend').click();
    await expect(page.locator('#shareGuestLinkStatus')).toContainText('Link sent');
    expect(await page.evaluate(() => window.__shared)).toMatchObject({ url: 'https://sharing-switch.test/guest#fixture-secret', title: 'Join Mira on ChatMCP' });
    await page.screenshot({ path: test.info().outputPath(`sharing-link-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
