const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../../public/css/style.css'), 'utf8');

function composerMarkup({ hidden = false } = {}) {
  return `
    <!doctype html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
        <style>
          .hidden { display: none !important; }
          .space-y-3 > :not([hidden]) ~ :not([hidden]) {
            margin-top: 0.75rem;
          }
          body, main, p { margin: 0; }
          ${css}
        </style>
      </head>
      <body data-agent-selected="true">
        <main>
          <div id="dashboardRoot">
            <div class="grid dashboard-main-grid">
              <section class="council-chamber">
                <div id="mobileHeader">Mobile Header</div>
              </section>
              <div id="multiChatContainer">
                <aside class="glass-panel chat-tile--main">
                  <div id="agentPanelHeader">Agent Header</div>
                  <div id="conversationArea">
                    ${Array.from({ length: 24 }, (_, i) => `<p>Message ${i + 1}</p>`).join('')}
                  </div>
                  <div id="messageInputArea" class="${hidden ? 'hidden' : ''}">
                    <div id="mobileAgentStatusStrip" class="mobile-agent-status-strip" aria-live="polite">
                      <span class="mobile-agent-status-strip__item mobile-agent-status-strip__item--strong">
                        <span class="mobile-agent-status-strip__label">Provider</span>
                        <span id="mobileConfigProvider">Codex</span>
                      </span>
                      <span class="mobile-agent-status-strip__item">
                        <span class="mobile-agent-status-strip__label">Model</span>
                        <span id="mobileConfigModel">GPT-5</span>
                      </span>
                      <span class="mobile-agent-status-strip__item">
                        <span class="mobile-agent-status-strip__label">Mode</span>
                        <span id="mobileConfigMode">Full auto</span>
                      </span>
                    </div>
                    <form id="userMessageForm" class="space-y-3">
                      <div id="imagePreviewArea" class="hidden"></div>
                      <div class="relative">
                        <textarea id="userMessageInput">Draft message</textarea>
                        <label id="generalFileUploadLabel" for="generalFileInput">F</label>
                        <input id="generalFileInput" type="file" />
                        <label id="imageUploadLabel" for="imageFileInput">I</label>
                        <input id="imageFileInput" type="file" />
                      </div>
                      <div class="composer-action-row">
                        <p>Ctrl+Enter to send</p>
                        <div class="composer-controls">
                          <div id="agentConfigContainer">
                            <button id="agentConfigBtn" type="button">Model</button>
                          </div>
                          <button id="agentStopBtn" type="button"><span>Stop</span></button>
                          <button id="userMessageSend" type="submit">Send</button>
                        </div>
                      </div>
                    </form>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  `;
}

test.describe('mobile composer visual layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test('keeps the composer and all action buttons visible and aligned', async ({ page }) => {
    await page.setContent(composerMarkup());

    const inputArea = page.locator('#messageInputArea');
    await expect(inputArea).toBeVisible();

    const inputBox = await inputArea.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(844);
    expect(inputBox.height).toBeGreaterThan(70);

    const controls = [
      page.locator('#agentConfigBtn'),
      page.locator('#agentStopBtn'),
      page.locator('#generalFileUploadLabel'),
      page.locator('#imageUploadLabel'),
      page.locator('#userMessageSend'),
    ];
    const boxes = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box);
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }

    const firstCenterY = boxes[0].y + boxes[0].height / 2;
    for (const box of boxes.slice(1)) {
      const centerY = box.y + box.height / 2;
      expect(Math.abs(centerY - firstCenterY)).toBeLessThanOrEqual(5);
      expect(Math.abs(box.height - boxes[0].height)).toBeLessThanOrEqual(3);
    }

    const textBox = await page.locator('#userMessageInput').boundingBox();
    expect(textBox).not.toBeNull();
    for (const box of boxes) {
      const bottomInset = textBox.y + textBox.height - (box.y + box.height);
      expect(bottomInset).toBeGreaterThanOrEqual(5);
      expect(bottomInset).toBeLessThanOrEqual(11);
      expect(box.x).toBeGreaterThan(textBox.x + 4);
      expect(box.x + box.width).toBeLessThan(textBox.x + textBox.width - 1);
    }
  });

  test('keeps Send aligned with attachment controls after removing the schedule button', async ({ page }) => {
    await page.setContent(composerMarkup());

    const sendBox = await page.locator('#userMessageSend').boundingBox();
    const fileBox = await page.locator('#generalFileUploadLabel').boundingBox();
    const imageBox = await page.locator('#imageUploadLabel').boundingBox();
    expect(sendBox).not.toBeNull();
    expect(fileBox).not.toBeNull();
    expect(imageBox).not.toBeNull();
    expect(Math.abs(sendBox.y - fileBox.y)).toBeLessThanOrEqual(3);
    expect(Math.abs(sendBox.y - imageBox.y)).toBeLessThanOrEqual(3);
    await expect(page.locator('#scheduledMessagesBtn')).toHaveCount(0);
  });

  test('CSS selected-agent failsafe shows the composer even if hidden class is re-added', async ({ page }) => {
    await page.setContent(composerMarkup({ hidden: true }));

    const inputArea = page.locator('#messageInputArea');
    await expect(inputArea).toBeVisible();
    const inputBox = await inputArea.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(844);
  });

  test('keeps the mobile model status strip tight to the text box', async ({ page }) => {
    await page.setContent(composerMarkup());

    const stripBox = await page.locator('#mobileAgentStatusStrip').boundingBox();
    const textBox = await page.locator('#userMessageInput').boundingBox();
    expect(stripBox).not.toBeNull();
    expect(textBox).not.toBeNull();

    const gap = textBox.y - (stripBox.y + stripBox.height);
    expect(gap).toBeLessThanOrEqual(1);
    expect(gap).toBeGreaterThanOrEqual(-8);
    expect(stripBox.height).toBeLessThanOrEqual(26);
  });
});
