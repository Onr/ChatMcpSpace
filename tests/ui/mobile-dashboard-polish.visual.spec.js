const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('public/js/dashboard.js');
const functions = source.slice(source.indexOf('function bindMobileListToggleControls()'), source.indexOf('function bindMobileOverflowActionControls()')) +
  source.slice(source.indexOf('function syncMobilePaperMenuChrome('), source.indexOf('function isDockAgentOutsideViewport('));

async function render() {
  const locals = { agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
    csrfToken: 'fixture', cspNonce: 'fixture', assetUrl: p => p, safeJsonForScript: JSON.stringify,
    user: { userId: 'fixture', displayName: 'Mobile test', email: 'fixture@example.test' }, currentPath: '/dashboard' };
  const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
  let html = await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body });
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  return html.replace('</head>', `<style>${['tailwind', 'style', 'agent-actions'].map(f => read(`public/css/${f}.css`)).join('\n')}</style></head>`);
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
      for (const selector of [fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn', '#userMessageSend', '#agentStopBtn']) {
        const box = await page.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      }
      if (!fast) {
        const bounds = await page.locator('#mobileStatsToggle > .grid > *').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right}; }));
        expect(bounds[0].left).toBeGreaterThanOrEqual(0);
        expect(bounds[0].right).toBeLessThanOrEqual(bounds[1].left);
        expect(bounds[1].right).toBeLessThanOrEqual(bounds[2].left);
        expect(bounds[2].right).toBeLessThanOrEqual(viewport.width);
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
