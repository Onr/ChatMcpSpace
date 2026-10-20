const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { assetUrl } = require('../../src/utils/assetUrl');
const renderTemplate = (file, data = {}) => ejs.renderFile(file, { assetUrl, ...data });
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '../..');
const styles = ['tailwind.css', 'style.css', 'in-place-sharing.css']
  .map(file => fs.readFileSync(path.join(root, 'public/css', file), 'utf8')).join('\n');

for (const width of [390, 1280]) {
  test(`agent name menu stays above messages and accepts clicks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const html = await renderTemplate(path.join(root, 'views/dashboard.ejs'), {
      agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false,
      csrfToken: 'fixture', cspNonce: 'fixture',
      user: { userId: 'fixture', email: 'fixture@example.test' },
      safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
    });
    const dom = new JSDOM(html);
    const header = dom.window.document.getElementById('agentPanelHeader');
    header.classList.remove('hidden');
    header.querySelector('#selectedAgentName').textContent = 'AgentsMCPspace';
    const markup = header.outerHTML;
    dom.window.close();
    await page.setContent(`<style>${styles}</style>
      <aside class="glass-panel flex flex-col" style="height:850px;max-width:700px">
        ${markup}
        <div id="conversationArea" class="flex-1 overflow-y-auto p-5">
          <div class="message-bubble" style="height:650px">A long message behind the menu</div>
        </div>
      </aside>`);
    // Use the dashboard's real toggle handler; avoid API calls in this layout fixture.
    const dashboard = fs.readFileSync(path.join(root, 'public/js/dashboard.js'), 'utf8');
    const setup = dashboard.match(/function setupCopyButtons\(\) \{[\s\S]*?\n\}/)[0];
    await page.addScriptTag({ content: `
      let selectedAgentId = null;
      function hideFloatingAgentMenu() {}
      ${setup}
      setupCopyButtons();
      document.getElementById('clearConversationBtn').addEventListener('click', () => {
        document.body.dataset.menuClicked = 'true';
      });
    ` });
    await page.locator('#selectedAgentName').click();
    const button = page.locator('#clearConversationBtn');
    const onTop = () => button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    // Reproduce the old cascade: panel children all had z-index: 1.
    await page.locator('#agentPanelHeader').evaluate(element => { element.style.zIndex = '1'; });
    expect(await onTop()).toBe(false);
    await page.locator('#agentPanelHeader').evaluate(element => { element.style.removeProperty('z-index'); });
    expect(await onTop()).toBe(true);
    await button.click();
    await expect(page.locator('body')).toHaveAttribute('data-menu-clicked', 'true');
  });
}
