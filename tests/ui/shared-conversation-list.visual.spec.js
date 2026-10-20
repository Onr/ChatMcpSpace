const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { assetUrl } = require('../../src/utils/assetUrl');
const renderTemplate = (file, data = {}) => ejs.renderFile(file, { assetUrl, ...data });
const { JSDOM } = require('jsdom');

const project = path.join(__dirname, '../..');
const styles = fs.readFileSync(path.join(project, 'public/css/tailwind.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(project, 'public/css/style.css'), 'utf8') + '\n' +
  fs.readFileSync(path.join(project, 'public/css/in-place-sharing.css'), 'utf8');
const transport = path.join(project, 'public/js/in-place-chat.js');
const dashboard = fs.readFileSync(path.join(project, 'public/js/dashboard.js'), 'utf8');
const listHandlers = dashboard.match(/function setupAgentListHandlers\(\) \{[\s\S]*?\n\}/)[0];
const contexts = [
  { conversationId: 'shared-one', agentId: 'shared-agent', agentName: 'AgentsMCPspace', ownerId: 'owner',
    mode: 'shared', state: 'shared', role: 'participant', membershipStatus: 'active', capabilities: { read: true, send: true } },
  { conversationId: 'shared-two', agentId: 'second-agent', agentName: 'Product research and design conversation with a very long agent name', ownerId: 'owner',
    mode: 'shared', state: 'shared', role: 'participant', membershipStatus: 'active', capabilities: { read: true, send: true } }
];

async function mount(page) {
  process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  const html = await renderTemplate(path.join(project, 'views/dashboard.ejs'), {
    agents: ['Personal Agent', 'Notes Agent'].map((name, i) => ({ agentId: `own-${i}`, name, position: i,
      highestPriority: 'low', unreadCount: 0, marbleSvg: '' })),
    groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
    user: { userId: 'invitee', email: 'invitee@example.test' },
    safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
  });
  const dom = new JSDOM(html);
  const picker = dom.window.document.getElementById('agentListPanel').outerHTML;
  dom.window.close();
  await page.route('http://127.0.0.1/sharing-visual-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://127.0.0.1/sharing-visual-fixture');
  await page.route('**/api/user/chat-threads', route => route.fulfill({ json: contexts }));
  await page.route('**/api/user/chat-threads/invitations/incoming', route => route.fulfill({ json: [] }));
  await page.route('**/api/user/chat-threads/shared-one', route => route.fulfill({ json: contexts[0] }));
  await page.route('**/api/user/shared/shared-one', route => route.fulfill({ json: { room: { owner_id: 'owner' }, members: [] } }));
  await page.setContent(`<!doctype html><html><head><style>${styles}
    * { box-sizing: border-box; } body { margin: 0; padding: 20px; background: #080d19; font-family: Arial, sans-serif; }
    .flex { display: flex; } .flex-1 { flex: 1 1 0%; } .min-w-0 { min-width: 0; } .items-center { align-items: center; }
    .hidden { display: none !important; } .p-2 { padding: 8px; } .visual-council { width: min(620px, 100%); height: 390px; margin: auto;
      overflow: hidden; border: 1px solid #ffffff20; border-radius: 22px; background: #0b1020; }
    .visual-heading { padding: 16px 20px; color: #e2e8f0; font-size: 18px; font-weight: 600; }
    .visual-council > #agentListPanel { position: static; width: 100%; height: calc(100% - 54px); max-height: none;
      opacity: 1; pointer-events: auto; display: flex; }
    #agentListSearchInput { width: 100%; }
    </style></head><body><div id="dashboardRoot" data-user-id="invitee"><section class="visual-council">
    <header class="visual-heading">Your conversations</header>${picker}</section>
    <section id="visualSelectedChat" aria-live="polite"></section></div></body></html>`);
  await page.evaluate(() => {
    window.dashboardReady = true;
    window.regularOpenCalls = [];
    window.pickerCloseCount = 0;
    window.setMobileListExpanded = expanded => { if (!expanded) window.pickerCloseCount += 1; };
    window.getAgentMetadataFromElement = () => ({});
    window.shouldSelectIntoSidePanel = () => false;
    window.openAgentWithFeedback = id => window.regularOpenCalls.push(id);
    window.hideFloatingAgentMenu = () => {};
    window.DashboardHelpers = {
      getSelectedAgentIdentity: () => window.InPlaceChat?.getContext(),
      selectChatContext: async context => {
        window.InPlaceChat.setContext(context);
        document.getElementById('visualSelectedChat').textContent = context.agentName;
      }
    };
  });
  await page.addScriptTag({ path: transport });
  await page.evaluate(() => window.InPlaceChat.refreshList());
  await page.addScriptTag({ content: listHandlers });
  // Dashboard polling rebinds regular agent handlers after shared rows exist.
  // The shared card must remain outside that private-agent handler namespace.
  await page.evaluate(() => { setupAgentListHandlers(); setupAgentListHandlers(); });
}

for (const width of [390, 688, 1280]) {
  test(`shared conversations stay readable and open after dashboard refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page);
    const button = page.locator('[data-shared-conversation-id="shared-one"]');
    await expect(button).toBeVisible();
    const leave = page.getByRole('button', { name: 'Leave AgentsMCPspace', exact: true });
    const buttonBox = await button.boundingBox(), leaveBox = await leave.boundingBox();
    fs.mkdirSync(path.join(project, 'tmp/shared-conversations'), { recursive: true });
    await page.locator('.visual-council').screenshot({ path: path.join(project, `tmp/shared-conversations/shared-picker-${width}.png`) });
    expect(buttonBox.width).toBeGreaterThan(160);
    expect(buttonBox.height).toBeLessThanOrEqual(90);
    expect(leaveBox.width).toBeLessThan(80);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(leaveBox.x + 1);
    const name = page.locator('.shared-conversation-name').first();
    await expect(name).toHaveText('AgentsMCPspace');
    expect((await name.boundingBox()).height).toBeLessThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.visual-council')).toHaveScreenshot(`shared-picker-${width}.png`, { animations: 'disabled' });
    await button.click();
    await expect(page.locator('#visualSelectedChat')).toHaveText('AgentsMCPspace');
    expect(await page.evaluate(() => window.regularOpenCalls)).toEqual([]);
    await expect(button).toHaveAttribute('aria-current', 'true');
    if (width < 768) await expect.poll(() => page.evaluate(() => window.pickerCloseCount)).toBe(1);
    await page.evaluate(() => window.InPlaceChat.refreshList());
    await expect(button).toHaveAttribute('aria-current', 'true');
    await button.click();
    if (width < 768) await expect.poll(() => page.evaluate(() => window.pickerCloseCount)).toBe(2);
  });
}

test('many shared chats scroll while regular chats remain available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount(page);
  await page.unroute('**/api/user/chat-threads');
  await page.route('**/api/user/chat-threads', route => route.fulfill({ json: Array.from({ length: 12 }, (_, i) => ({ ...contexts[0], conversationId: `room-${i}`, agentName: `Shared agent ${i + 1}` })) }));
  await page.evaluate(() => window.InPlaceChat.refreshList());
  const metrics = await page.locator('#sharedConversationSection').evaluate(section => ({
    height: section.clientHeight, scrollHeight: section.scrollHeight,
    regularHeight: document.getElementById('agentListScroll').clientHeight
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
  expect(metrics.height).toBeLessThanOrEqual(240);
  expect(metrics.regularHeight).toBeGreaterThan(80);
  await page.getByRole('button', { name: 'Open Shared agent 12 shared conversation', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Open Shared agent 12 shared conversation', exact: true })).toBeInViewport();
});
