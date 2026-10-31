const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/js/dashboard.js');
const functions = source.match(/function isAgentListDocked\(\) \{[\s\S]*?\n\}/)[0] + '\n' + source.slice(source.indexOf('function bindMobileListToggleControls()'), source.indexOf('function bindMobileOverflowActionControls()')) +
  source.slice(source.indexOf('function syncMobilePaperMenuChrome('), source.indexOf('function isDockAgentOutsideViewport('));

async function render(sharing = false) {
  const originalSharing = process.env.FEATURE_SHARED_CONVERSATIONS;
  const originalInPlace = process.env.FEATURE_IN_PLACE_AGENT_SHARING;
  if (sharing) {
    process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
    process.env.FEATURE_IN_PLACE_AGENT_SHARING = 'true';
  }
  const locals = { agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
    csrfToken: 'fixture', cspNonce: 'fixture', assetUrl: p => p, safeJsonForScript: JSON.stringify,
    user: { userId: 'fixture', displayName: 'Mobile test', email: 'fixture@example.test' }, currentPath: '/dashboard' };
  let body;
  try {
    body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
  } finally {
    if (originalSharing === undefined) delete process.env.FEATURE_SHARED_CONVERSATIONS;
    else process.env.FEATURE_SHARED_CONVERSATIONS = originalSharing;
    if (originalInPlace === undefined) delete process.env.FEATURE_IN_PLACE_AGENT_SHARING;
    else process.env.FEATURE_IN_PLACE_AGENT_SHARING = originalInPlace;
  }
  let html = await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body });
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  return html.replace('</head>', `<style>${['tailwind', 'style', 'agent-actions', 'in-place-sharing', 'recent-chats'].map(f => read(`public/css/${f}.css`)).join('\n')}</style></head>`);
}

for (const viewport of [{width:320,height:568}, {width:390,height:844}, {width:768,height:1024}, {width:844,height:390}]) {
  for (const fast of [false, true]) {
    test(`dashboard controls fit ${viewport.width}x${viewport.height}, fast=${fast}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      await page.setContent(await render());
      await page.evaluate(fast => {
        document.body.classList.add('dashboard-mobile');
        document.body.classList.toggle('dashboard-fast-mode', fast);
        document.body.dataset.agentSelected = 'true';
        for (const id of ['agentPanelHeader', 'messageInputArea']) document.getElementById(id).classList.remove('hidden');
        document.getElementById('agentPanelPlaceholder').classList.add('hidden');
        document.getElementById('selectedAgentName').textContent = 'LongAgentNameWithoutSpaces'.repeat(8);
        document.getElementById('statsTotal').textContent = '1234';
        document.getElementById('statsActive').textContent = '567';
        document.getElementById('agentListScroll').innerHTML = Array.from({length:30}, (_, i) => `<div class="agent-list-item">Agent ${i}</div>`).join('');
      }, fast);
      await page.addScriptTag({ content: `
        const selectedAgentId = 'fixture', currentAgentList = [], activeGroupId = null;
        const isDashboardFastModeActive = () => document.body.classList.contains('dashboard-fast-mode');
        const writeMobileBrowserNavigationState = () => {}, getMobileBrowserNavigationState = () => null;
        const handlingMobileBrowserNavigation = false;
        const setMobileChromeCollapsed = () => {}, clearCollapsedFastModeAgentListPanel = () => {};
        const clearAgentListSearch = () => {}, updateAgentListPanel = () => {};
        ${functions}
        bindMobileListToggleControls();` });
      const toggle = page.locator(fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn');
      await expect(toggle.locator('svg circle')).toHaveCount(11);
      const docked = viewport.width >= 768 && viewport.height >= 601;
      const controls = ['#userMessageSend', '#agentStopBtn'];
      if (!docked) controls.push(fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn');
      for (const selector of controls) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      if (!fast && !docked) {
        const bounds = await page.locator('#mobileStatsToggle > .grid > *').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right}; }));
        expect(bounds[0].left).toBeGreaterThanOrEqual(0);
        expect(bounds[0].right).toBeLessThanOrEqual(bounds[1].left);
        expect(bounds[1].right).toBeLessThanOrEqual(bounds[2].left);
        expect(bounds[2].right).toBeLessThanOrEqual(viewport.width);
      }
      if (docked) {
        await expect(toggle).toBeHidden();
        await expect(page.locator('#agentListSearchInput')).toBeVisible();
        expect(await page.locator('#agentListScroll').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await context.close();
        return;
      }
      await toggle.tap();
      await expect(page.locator('#agentListPanel')).toHaveClass(/mobile-expanded/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#agentListPanel .agent-list-title').first()).toBeVisible();
      await expect(page.locator('#agentListSearchInput')).toBeVisible();
      expect(await page.locator('#agentListScroll').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await page.screenshot({path: test.info().outputPath('list-open.png')});
      await page.evaluate(() => setMobileListExpanded(false, {skipBrowserHistory:true}));
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await context.close();
    });
  }
}


for (const viewport of [{width:320,height:568}, {width:390,height:844}, {width:844,height:390}]) {
  for (const fast of [false, true]) {
    for (const sharedCount of [1, 12]) {
      test(`shared and owned agents remain reachable ${viewport.width}x${viewport.height}, fast=${fast}, shared=${sharedCount}`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, isMobile:true, hasTouch:true });
        const page = await context.newPage();
        await page.setContent(await render(true));
        await page.evaluate(({fast, sharedCount}) => {
          document.body.classList.add('dashboard-mobile', 'mobile-list-expanded');
          document.body.classList.toggle('dashboard-fast-mode', fast);
          document.querySelector('.council-chamber').classList.add('mobile-agent-list-open');
          document.getElementById('agentListPanel').classList.add('mobile-expanded');
          document.getElementById('sharedConversationSection').hidden = false;
          document.getElementById('sharedConversationCount').textContent = sharedCount;
          document.getElementById('incomingSharingInvitations').innerHTML = '<button style="min-height:44px">Accept invitation</button>';
          document.getElementById('sharedConversationList').innerHTML = Array.from({length:sharedCount}, (_, i) => `<div class="shared-conversation-row"><button class="shared-conversation-open" id="shared-${i}"><span class="shared-conversation-avatar">HC</span><span class="shared-conversation-info"><span class="shared-conversation-name">HC-2L43D44-long-shared-agent-name-${i}</span><span class="shared-conversation-status">Chat together</span></span><span class="shared-conversation-arrow">›</span></button><button class="shared-conversation-leave">Leave</button></div>`).join('');
          document.getElementById('agentListScroll').innerHTML = Array.from({length:30}, (_, i) => `<button class="agent-list-item" style="width:100%;min-height:64px" id="owned-${i}">Personal agent ${i}</button>`).join('');
          document.getElementById('agentListPanel').addEventListener('click', event => {
            document.body.dataset.clicked = event.target.closest('button')?.id || '';
          });
        }, {fast, sharedCount});
        const panel = page.locator('#agentListPanel');
        await expect(panel).toBeVisible();
        expect(await panel.evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
        for (const id of ['shared-0', `shared-${sharedCount - 1}`, 'owned-0', 'owned-29']) {
          const button = page.locator(`#${id}`);
          await button.scrollIntoViewIfNeeded();
          const reachable = await button.evaluate(el => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight &&
              el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          });
          expect(reachable).toBe(true);
          await button.tap();
          await expect(page.locator('body')).toHaveAttribute('data-clicked', id);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({path:test.info().outputPath('shared-list-open.png')});
        await context.close();
      });
    }
  }
}
