const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const dashboard = read('public/js/dashboard.js');
for (const width of [390, 1280]) {
  test(`shared message identity and tap/keyboard visibility hints stay inside bubbles at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.setContent(`<style>${read('public/css/tailwind.css')}\n${read('public/css/style.css')}\n${read('public/css/in-place-sharing.css')}</style><main id="conversationArea" style="padding:16px;max-width:720px;margin:auto"></main>`);
    await page.evaluate(() => {
      window.escapeHtml = text => { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
      Object.assign(window, { renderMessageMarkdown: window.escapeHtml, formatTimestamp: () => '12:00',
        buildUserMessageReadIndicator: () => '', parseNewsMessage: () => null, selectedAgentType: 'standard',
        attachMessageTtsButton: () => {}, attachMessageInfoButton: () => {}, attachRunCommandTimestamp: () => {} });
    });
    await page.addScriptTag({ content: dashboard.slice(dashboard.indexOf('function renderSharedMessageInfo('), dashboard.indexOf('function attachRunCommandTimestamp(')) });
    await page.evaluate(() => {
      for (const message of [
        { messageId: 'you', type: 'user_message', senderName: 'You', sharedSenderKind: 'owner', sharedAudienceMode: 'all', sharedAudienceLabel: 'Everyone' },
        { messageId: 'guest', type: 'user_message', senderName: 'Alex <guest>', sharedSenderKind: 'guest', sharedAudienceMode: 'all', sharedAudienceLabel: 'Everyone' },
        { messageId: 'reply', type: 'agent_message', agentName: 'Project agent', sharedAudienceMode: 'selected', sharedAudienceLabel: 'Owner + Alex <guest>' }
      ]) document.getElementById('conversationArea').append(createMessageElement({ ...message, content: 'Here is the project update.' }));
    });
    const bubble = page.locator('[data-message-id="you"] .message-bubble');
    await expect(bubble).toContainText('You');
    const summary = bubble.locator('summary');
    await summary.click();
    await expect(bubble.locator('.shared-message-visibility-hint')).toBeVisible();
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(bubble.locator('.shared-message-visibility-hint')).toBeHidden();
    expect(await page.locator('.shared-message-audience').evaluateAll(elements => elements.every(el => {
      const parent = el.closest('.message-bubble').getBoundingClientRect(), rect = el.getBoundingClientRect();
      return rect.left >= parent.left && rect.right <= parent.right;
    }))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`feedback-shared-bubbles-${width}.png`) });
  });
}
test('feedback shortcut hint is visible and Ctrl+Enter sends exactly one request', async ({ page }) => {
  await page.route('https://feedback.example/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('https://feedback.example/');
  const button = read('views/layout.ejs').match(/<button id="feedbackSendBtn"[\s\S]*?<\/button>/)[0];
  await page.setContent(`<style>${read('public/css/style.css')}</style><button id="feedbackTriggerBtn">Feedback</button><div id="feedbackPanel" class="feedback-panel is-open"><textarea id="feedbackTextarea"></textarea>${button}<button id="feedbackLoveBtn">Love</button></div>`);
  await page.evaluate(() => { window.feedbackRequests = []; window.fetch = async (url, options) => { window.feedbackRequests.push(url); return new Promise(() => {}); }; });
  await page.addScriptTag({ content: read('public/js/feedback.js') + '\ninitializeFeedbackWidget();' });
  await expect(page.locator('.feedback-send-shortcut')).toBeVisible();
  await page.locator('#feedbackTextarea').fill('Please keep the setup simple');
  await page.locator('#feedbackTextarea').press('Control+Enter');
  await page.locator('#feedbackTextarea').press('Control+Enter');
  expect(await page.evaluate(() => window.feedbackRequests)).toEqual(['/api/user/feedback']);
});

test('dragging in a squashed orbit with group slots reorders immediately while saving is slow', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.setContent(`<style>#orbit{position:relative;width:600px;height:300px;margin:100px}.agent-seat{position:absolute;width:40px;height:40px;transform:translate(-50%,-50%);background:teal;touch-action:none}</style><div id="orbit"><div id="agentSeats"></div></div>`);
  const build = dashboard.slice(dashboard.indexOf('function buildOrbitLayout('), dashboard.indexOf('/**\n * Render agent seat HTML'));
  const drag = dashboard.slice(dashboard.indexOf('function findCouncilGroupDropTarget('), dashboard.indexOf('function setupSidebarDragHandlers('));
  const saveStart = dashboard.indexOf('function applyOrbitPositionUpdates(');
  const save = dashboard.slice(saveStart, dashboard.indexOf('\n/**', saveStart));
  await page.evaluate(() => {
    Object.assign(window, {
      orbitDragState: null, orbitDragFrame: null, orbitDragHandlersInitialized: false, ORBIT_DRAG_THRESHOLD: 5,
      suppressSeatClickUntil: 0, currentGroups: [], currentOrbitLayout: null, cachedGroupPartition: null,
      ORBIT_CONFIG: { ringRadii: { idle: 40 }, ringIndex: { idle: 0 } },
      currentAgentList: ['a', 'group-member-1', 'b', 'group-member-2', 'c'].map((agentId, index) => ({ agentId, position: index + 1, hiddenInGroup: agentId.startsWith('group-member') })),
      orbitPositionSave: Promise.resolve(), orbitPositionRevision: 0, pendingOrbitPositions: new Map(), confirmedOrbitPositions: new Map(), agentListCache: {},
      getOrbitRingKey: () => 'idle', getOrbitSquashValue: () => .65,
      getOrbitContainerRect: () => document.getElementById('orbit').getBoundingClientRect(),
      projectOrbitPoint: (angle, radius) => ({ x: 50 + radius * Math.cos(angle * Math.PI / 180), y: 50 + radius * Math.sin(angle * Math.PI / 180) * .65 }),
      showErrorMessage: message => { throw new Error(message); },
      csrfFetch: () => new Promise(resolve => { window.finishSave = () => resolve({ ok: true }); })
    });
  });
  await page.addScriptTag({ content: `${build}\n${drag}\n${save}` });
  await page.evaluate(() => {
    window.updateAgentListUI = agents => {
      const visible = agents.filter(agent => !agent.hiddenInGroup);
      currentOrbitLayout = buildOrbitLayout(visible, 5); // Three agents plus two group slots.
      document.getElementById('agentSeats').innerHTML = visible.map(agent => {
        const point = currentOrbitLayout.layout.get(agent.agentId);
        return `<div class="agent-seat" data-agent-id="${agent.agentId}" style="left:${point.x}%;top:${point.y}%">${agent.agentId}</div>`;
      }).join('');
    };
    updateAgentListUI(currentAgentList); setupOrbitDragHandlers();
  });
  const from = await page.locator('[data-agent-id="a"]').boundingBox();
  const to = await page.locator('[data-agent-id="c"]').boundingBox();
  await page.mouse.move(from.x + 20, from.y + 20); await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + 20, { steps: 5 }); await page.mouse.up();
  expect(await page.evaluate(() => currentOrbitLayout.order)).toEqual(['b', 'c', 'a']);
  expect(await page.evaluate(() => currentAgentList.map(agent => [agent.agentId, agent.position]))).toEqual([
    ['a', 5], ['group-member-1', 2], ['b', 1], ['group-member-2', 4], ['c', 3]
  ]);
  expect(await page.evaluate(() => pendingOrbitPositions.size)).toBe(3);
  await page.evaluate(async () => { finishSave(); await orbitPositionSave; });
  expect(await page.evaluate(() => pendingOrbitPositions.size)).toBe(0);
});
