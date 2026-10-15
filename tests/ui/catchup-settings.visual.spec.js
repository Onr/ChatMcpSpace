const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const styles = read('public/css/tailwind.css') + '\n' + read('public/css/style.css');
const settings = read('public/js/settings.js');

for (const width of [390, 1280]) {
  test(`settings MCP copy, Pi setup, and folded usage work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const html = await ejs.renderFile(path.join(root, 'views/settings.ejs'), {
      success: null, apiKey: 'fixture-key', baseUrl: 'https://chat.example', defaultAgentName: 'Fixture',
      csrfToken: 'fixture', cspNonce: 'fixture', user: { email: 'fixture@example.test' },
      safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
    });
    const dom = new JSDOM(html); dom.window.document.querySelectorAll('script').forEach(node => node.remove());
    const content = dom.window.document.body.innerHTML; dom.window.close();
    await page.setContent(`<style>${styles}</style>${content}`);
    const start = settings.indexOf('async function copyMcpAddress(');
    const copy = settings.slice(start, settings.indexOf("document.addEventListener('DOMContentLoaded'", start));
    await page.addScriptTag({ content: `
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedAddress = value; } } });
      ${copy}
      document.getElementById('copyMcpAddress').onclick = copyMcpAddress;
      function escapeHtml(value) { const node=document.createElement('span'); node.textContent=value; return node.innerHTML; }
      ${settings.slice(settings.indexOf('function usageLimitBarColor('))}
      renderUsageLimits({ account: { limits: [] }, agents: Array.from({length:30}, (_, index) => ({agentName:'Agent '+index,limits:[]})) });
      document.getElementById('usageLimitsContent').classList.remove('hidden');
      document.getElementById('usageLimitsLoading').classList.add('hidden');
    ` });
    await page.addScriptTag({ path: path.join(root, 'public/js/external-agent-setup.js') });
    await page.locator('#externalAgentProvider').selectOption('pi');
    await expect(page.locator('#externalAgentName')).toHaveValue('Pi');
    await expect(page.locator('#externalAgentSetupPrompt')).toHaveValue(/native Pi runner/);
    await page.locator('#copyMcpAddress').click();
    expect(await page.evaluate(() => window.copiedAddress)).toBe('https://chat.example/mcp');
    await expect(page.locator('#usageLimitsDetails')).not.toHaveAttribute('open');
    await page.locator('#usageLimitsDetails > summary').click();
    await expect(page.locator('#usageLimitsAgents details').first()).not.toHaveAttribute('open');
    expect(await page.locator('#usageLimitsContent').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`settings-${width}.png`), fullPage: false });
  });
}

test('quoted reply selection, cancellation, and original-message navigation work in the browser', async ({ page }) => {
  await page.setContent(`<style>${styles}</style><div id="transcript"><article data-message-id="original"><div class="message-bubble"><div class="message-content">Original</div><div class="message-utilities"></div></div></article></div><div><div><textarea id="userMessageInput"></textarea></div></div>`);
  await page.addScriptTag({ path: path.join(root, 'public/js/message-replies.js') });
  await page.evaluate(() => {
    MessageReplies.decorate(document.querySelector('article'), { messageId: 'original', type: 'agent_message', content: 'Original message', senderName: 'Mira' }, 'room', true);
  });
  await page.getByRole('button', { name: 'Reply to this message' }).click();
  await expect(page.locator('#messageReplyDraft')).toContainText('Original message');
  await page.getByRole('button', { name: 'Cancel reply' }).click();
  await expect(page.locator('#messageReplyDraft')).toHaveCount(0);
});

test('an actual Council Chamber pointer drop adds the agent to the target group', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await page.setContent(`<style>${styles} #agentSeats{position:relative;width:400px;height:360px;margin:40px}.agent-seat,.group-seat{position:absolute;width:60px;height:60px;touch-action:none}</style>
    <div id="agentSeats"><div class="agent-seat" data-agent-id="agent-one" style="left:40px;top:80px">Agent</div><div class="group-seat" data-group-id="group-one" style="left:260px;top:80px">Work</div></div>`);
  const dashboard = read('public/js/dashboard.js');
  const handlers = dashboard.slice(dashboard.indexOf('function findCouncilGroupDropTarget('), dashboard.indexOf('function setupSidebarDragHandlers('));
  await page.addScriptTag({ content: `
    let currentGroups=[{groupId:'group-one',groupName:'Work',memberIds:[]}], currentAgentList=[{agentId:'agent-one'}];
    let cachedGroupPartition=null, orbitDragHandlersInitialized=false, orbitDragState=null, orbitDragFrame=null, suppressSeatClickUntil=0;
    const ORBIT_DRAG_THRESHOLD=6, ORBIT_CONFIG={ringRadii:{idle:35}};
    function getOrbitContainerRect(){return document.getElementById('agentSeats').getBoundingClientRect();}
    function updateAgentListUI(){} function showSuccessMessage(){window.groupAdded=true;} function showErrorMessage(value){throw Error(value);}
    async function csrfFetch(url,options){window.groupRequest={url,body:JSON.parse(options.body)};return {ok:true};}
    ${handlers}
    setupOrbitDragHandlers();
  ` });
  const agent = await page.locator('.agent-seat').boundingBox();
  const group = await page.locator('.group-seat').boundingBox();
  await page.mouse.move(agent.x + 30, agent.y + 30); await page.mouse.down();
  await page.mouse.move(group.x + 30, group.y + 30, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.groupAdded)).toBe(true);
  expect(await page.evaluate(() => window.groupRequest.body)).toEqual({ agentIds: ['agent-one'] });
});
