const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const root = process.env.FEEDBACK_FIX_ROOT || path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/js/dashboard.js');
const menuCode = source.slice(source.indexOf('function setupCopyButtons()'), source.indexOf('function setupDeleteConfirmationModal()'));
const statsCode = source.slice(source.indexOf('function getAgentMenuStatsSections('), source.indexOf('async function openFloatingAgentMenuForAgent('));
const id = '11111111-1111-4111-8111-111111111111';

for (const width of [390, 1280]) {
  test(`agent name menu opens optional identity, existing details, and sharing at ${width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 850 });
    const previousSharing = process.env.FEATURE_SHARED_CONVERSATIONS;
    const previousInPlace = process.env.FEATURE_IN_PLACE_AGENT_SHARING;
    process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
    process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
    let html;
    try {
      html = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), { agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
        csrfToken: 'fixture', cspNonce: 'fixture', assetUrl: p => p, safeJsonForScript: JSON.stringify,
        user: { userId: 'fixture', email: 'fixture@example.test' }, currentPath: '/dashboard' });
    } finally {
      if (previousSharing === undefined) delete process.env.FEATURE_SHARED_CONVERSATIONS; else process.env.FEATURE_SHARED_CONVERSATIONS = previousSharing;
      if (previousInPlace === undefined) delete process.env.FEATURE_IN_PLACE_AGENT_SHARING; else process.env.FEATURE_IN_PLACE_AGENT_SHARING = previousInPlace;
    }
    await page.route('https://feedback-menu.test/**', route => {
      const url = route.request().url();
      const document = { displayName: '', avatar: '', role: '', purpose: '', workspace: '', preferences: '', boundaries: '', instructions: '', references: '', goals: [], activeGoalId: null };
      const json = url.endsWith('/brief') ? { agentId: id, agentName: 'Existing agent', revision: 0, document, policy: { enabled: false }, state: {}, permissions: { editIdentity: true } }
        : url.endsWith('/lineage') ? { lastPollAt: new Date().toISOString(), parent: null, children: [] }
        : url.endsWith('/details') ? { machineName: 'Existing computer', projectPath: '/existing/project' } : {};
      return url.endsWith('/') ? route.fulfill({ contentType: 'text/html', body: '<html></html>' }) : route.fulfill({ json });
    });
    await page.goto('https://feedback-menu.test/');
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    await page.evaluate(() => {
      const header = document.getElementById('agentHeaderInfo');
      const menu = document.getElementById('agentContextMenu');
      const floating = document.getElementById('floatingAgentMenu');
      document.body.replaceChildren(header, menu, floating);
      header.style.cssText = 'margin:20px;width:260px';
      document.getElementById('selectedAgentName').textContent = 'Existing agent';
    });
    for (const css of ['tailwind', 'style', 'agent-actions', 'agent-brief']) await page.addStyleTag({ content: read(`public/css/${css}.css`) });
    await page.addScriptTag({ content: `
      let selectedAgentId = '${id}', selectedAgentName = 'Existing agent', selectedAgentType = 'standard';
      let activeAgentStatsRequestToken = 0;
      const conversationCache = new Map([['${id}', [{content:'Hello'}, {content:'Reply'}]]]);
      const setupAgentCliMenuButtons = () => {}, updateAgentCliMenuButton = () => {}, renderAgentGroupMembership = () => {};
      const hideFloatingAgentMenu = () => document.getElementById('floatingAgentMenu').classList.add('hidden');
      const resolveAgentStatsMetadata = () => ({ lastHeartbeat: new Date().toISOString() });
      const formatRelativeTime = () => 'Just now';
      const findCachedAgentRecord = () => ({name: 'Existing agent'});
      const showErrorMessage = message => { throw new Error(message); };
      window.AgentChatSharing = {openForAgent: async (agentId, name) => { window.sharedAgent = {agentId, name}; }};
      ${statsCode}\n${menuCode}
      window.DashboardHelpers = {
        getSelectedAgentForActions: () => ({agentId: selectedAgentId}),
        loadAgentActionStats: (agentId, target) => refreshAgentActionStats(agentId, {}, {force:true, targetMenus:[target]})
      };
      setupCopyButtons();` });
    await page.addScriptTag({ content: read('public/js/agent-actions-ui.js') });
    await page.addScriptTag({ content: read('public/js/agent-brief.js') });
    await expect(page.locator('#agentBriefRoot')).toBeHidden();
    await page.locator('#selectedAgentName').click();
    await expect(page.locator('#agentContextMenu')).toBeVisible();
    await page.locator('#agentContextMenu [data-open-agent-brief]').click();
    await expect(page.locator('#agentBriefRoot')).toBeVisible();
    await expect(page.locator('#agentContextMenu')).toBeHidden();
    await expect(page.locator('.agent-brief-connected')).toContainText('Existing agent');
    await expect(page.locator('[data-agent-stat="message-count"]').last()).toHaveText('2');
    await expect(page.locator('.agent-brief-connected')).toContainText('/existing/project');
    await expect(page.locator('#brief-displayName')).toHaveAttribute('placeholder', 'Existing agent');
    await expect(page.locator('#agentBriefSave')).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`identity-${width}.png`)});
    await page.locator('.agent-brief-header [data-brief-close]').click();
    await page.locator('#selectedAgentName').click();
    await page.locator('#shareAgentFromContextMenu').click();
    expect(await page.evaluate(() => window.sharedAgent)).toEqual({agentId:id, name:'Existing agent'});
    // The floating menu has its own target, even when the chat selection differs.
    await page.evaluate(id => { selectedAgentId = 'other-agent'; window.AgentActionsUI.position({left:20, top:20, bottom:60}, id, {name:'Existing agent'}); }, id);
    await page.locator('#floatingAgentMenu [data-open-agent-brief]').click();
    await expect(page.locator('#agentBriefRoot')).toBeVisible();
    await expect(page.locator('#agentBriefTitle')).toHaveText('Existing agent');
    await expect(page.locator('#floatingAgentMenu')).toBeHidden();
    expect(errors).toEqual([]);
  });
}
