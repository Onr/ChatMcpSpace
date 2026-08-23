/**
 * Mobile UI Playwright Screenshot & Analysis Tests
 * 
 * Captures screenshots at mobile viewport sizes and verifies:
 * - Chat area is scrollable without triggering page scroll
 * - Agent list toggle button is visible
 * - Agent list opens as overlay
 * - Layout doesn't break at common mobile sizes
 * 
 * Run: npx playwright test tests/ui/mobile-screenshots.spec.js
 * Requires: the app running on localhost:3000
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(__dirname, '../../tmp/mobile-screenshots');

// Common mobile viewports
const MOBILE_VIEWPORTS = [
  { name: 'iPhone-SE', width: 375, height: 667 },
  { name: 'iPhone-14', width: 390, height: 844 },
  { name: 'iPhone-14-Pro-Max', width: 430, height: 932 },
  { name: 'Pixel-7', width: 412, height: 915 },
  { name: 'iPad-Mini', width: 768, height: 1024 },
];

test.describe('Mobile UI Layout', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
  });

  for (const vp of MOBILE_VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height}) - layout renders correctly`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.width < 768,
        hasTouch: true,
      });
      const page = await context.newPage();

      try {
        await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        test.skip(true, 'Server not running');
        return;
      }

      // Screenshot: initial state
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${vp.name}-initial.png`),
        fullPage: false,
      });

      // Verify dashboardRoot exists and fills viewport
      const root = await page.$('#dashboardRoot');
      expect(root).not.toBeNull();
      const rootBox = await root.boundingBox();
      expect(rootBox.height).toBeGreaterThan(vp.height * 0.8);

      // Verify collapse button is visible on mobile
      if (vp.width < 1279) {
        const collapseBtn = await page.$('#collapseMobileListBtn');
        expect(collapseBtn).not.toBeNull();
        const btnBox = await collapseBtn.boundingBox();
        expect(btnBox).not.toBeNull(); // visible = has a bounding box
        expect(btnBox.width).toBeGreaterThan(0);
        expect(btnBox.height).toBeGreaterThan(0);

        // Click to expand agent list
        await collapseBtn.click();
        await page.waitForTimeout(500);

        // Screenshot: agent list expanded
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${vp.name}-agent-list-open.png`),
          fullPage: false,
        });

        // Verify agent list panel is visible
        const panel = await page.$('#agentListPanel');
        const panelExpanded = await panel.evaluate(el => el.classList.contains('mobile-expanded'));
        expect(panelExpanded).toBe(true);

        // Verify agent list doesn't push conversation off screen
        const convArea = await page.$('#conversationArea');
        if (convArea) {
          const convBox = await convArea.boundingBox();
          // Conversation area should still be within viewport
          expect(convBox.y + convBox.height).toBeLessThanOrEqual(vp.height + 10);
        }

        // Click to collapse
        await collapseBtn.click();
        await page.waitForTimeout(500);

        // Screenshot: agent list collapsed
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${vp.name}-agent-list-closed.png`),
          fullPage: false,
        });
      }

      // Verify page doesn't scroll (body should not be scrollable)
      const bodyScrollable = await page.evaluate(() => {
        return document.body.scrollHeight > document.body.clientHeight;
      });
      // On mobile, body should not be scrollable (our fix sets overflow: hidden)
      if (vp.width < 1279) {
        // body.scrollHeight might still be > clientHeight if there's content,
        // but the key is overflow: hidden prevents scrolling
        const bodyOverflow = await page.evaluate(() => {
          return window.getComputedStyle(document.body).overflow;
        });
        expect(bodyOverflow).toBe('hidden');
      }

      await context.close();
    });
  }

  test('Chat scroll does not propagate to page', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      test.skip(true, 'Server not running');
      return;
    }

    // Check that conversationArea has overscroll-behavior: contain
    const convArea = await page.$('#conversationArea');
    if (convArea) {
      const overscrollBehavior = await convArea.evaluate(el => {
        return window.getComputedStyle(el).overscrollBehavior;
      });
      expect(overscrollBehavior).toBe('contain');
    }

    await context.close();
  });
});
