#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:3000';
const LOGIN_EMAIL = process.env.DEMO_EMAIL || 'test3@gmail.com';
const LOGIN_PASSWORD = process.env.DEMO_PASSWORD || 'TestPassword123!';
const TARGET_AGENT_NAME = process.env.DEMO_AGENT_NAME || 'DeployBot';
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'demo-videos');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function attachSimulatedCursor(context) {
  await context.addInitScript(() => {
    const installCursor = () => {
      if (document.getElementById('simulatedDemoCursor')) return;

      const style = document.createElement('style');
      style.textContent = `
        #simulatedDemoCursor {
          position: fixed;
          width: 16px;
          height: 16px;
          border-radius: 9999px;
          border: 2px solid rgba(16, 185, 129, 0.95);
          background: rgba(16, 185, 129, 0.25);
          box-shadow: 0 0 0 8px rgba(16, 185, 129, 0.08);
          pointer-events: none;
          z-index: 2147483647;
          transform: translate(-50%, -50%);
          transition: box-shadow 120ms ease, transform 120ms ease;
        }
        #simulatedDemoCursor.simulatedDemoCursor--click {
          box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.45);
          transform: translate(-50%, -50%) scale(0.9);
        }
      `;
      document.head.appendChild(style);

      const cursor = document.createElement('div');
      cursor.id = 'simulatedDemoCursor';
      cursor.style.left = '24px';
      cursor.style.top = '24px';
      document.body.appendChild(cursor);

      window.addEventListener('mousemove', (event) => {
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      }, { passive: true });

      window.addEventListener('mousedown', () => {
        cursor.classList.add('simulatedDemoCursor--click');
      });

      window.addEventListener('mouseup', () => {
        cursor.classList.remove('simulatedDemoCursor--click');
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installCursor, { once: true });
    } else {
      installCursor();
    }
  });
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const all = page.locator(selector);
    const count = await all.count();
    if (count > 0) {
      for (let i = 0; i < count; i += 1) {
        const candidate = all.nth(i);
        if (await candidate.isVisible()) {
          return candidate;
        }
      }
      return all.first();
    }
  }
  throw new Error(`Could not find any selector: ${selectors.join(', ')}`);
}

async function moveMouseToLocator(page, locator, options = {}) {
  const steps = options.steps || 36;
  const settleMs = options.settleMs || 120;

  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Target element has no bounding box.');

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps });
  await page.waitForTimeout(settleMs);
}

async function clickWithPause(page, pauseMs = 120) {
  await page.mouse.down();
  await page.waitForTimeout(Math.max(60, pauseMs));
  await page.mouse.up();
}

async function main() {
  ensureDir(OUTPUT_DIR);

  const runId = timestamp();
  const recordingDir = path.join(OUTPUT_DIR, `raw-${runId}`);
  ensureDir(recordingDir);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: recordingDir,
      size: { width: 1440, height: 900 }
    }
  });

  await attachSimulatedCursor(context);

  const page = await context.newPage();
  const video = page.video();

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 45000 });
    if (!page.url().includes('/dashboard')) {
      await page.waitForSelector('#loginEmail', { timeout: 15000 });
      await page.fill('#loginEmail', LOGIN_EMAIL);
      await page.fill('#loginPassword', LOGIN_PASSWORD);
      const loginSubmit = page.locator('#loginTab');
      await moveMouseToLocator(page, loginSubmit, { steps: 28, settleMs: 90 });
      await clickWithPause(page, 100);
      await page.waitForURL('**/dashboard**', { timeout: 45000 });
    }
    await page.waitForTimeout(1600);

    const agentTarget = await firstVisibleLocator(page, [
      `.agent-list-item[data-agent-name="${TARGET_AGENT_NAME}"]`,
      `.agent-seat[data-agent-name="${TARGET_AGENT_NAME}"]`,
      `[data-agent-name="${TARGET_AGENT_NAME}"]`
    ]);

    await moveMouseToLocator(page, agentTarget, { steps: 46, settleMs: 150 });
    await clickWithPause(page, 120);
    await page.waitForTimeout(1800);

    await page.waitForSelector('#mainInteractiveContent .rich-content-wrapper', { timeout: 15000 });

    const toggleBtn = page.locator('#mainInteractiveToggle');
    await moveMouseToLocator(page, toggleBtn, { steps: 30, settleMs: 110 });
    await clickWithPause(page, 110);
    await page.waitForTimeout(380);
    await clickWithPause(page, 110);
    await page.waitForTimeout(500);

    const expandBtn = page.locator('#mainInteractiveSizeBtn');
    await moveMouseToLocator(page, expandBtn, { steps: 30, settleMs: 110 });
    await clickWithPause(page, 110);
    await page.waitForSelector('.rich-content-popup-overlay', { timeout: 8000 });
    await page.waitForTimeout(700);

    await page.mouse.move(118, 96, { steps: 24 });
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'detached', timeout: 8000 });

    await page.waitForTimeout(1400);

    const finalVideoPath = path.join(OUTPUT_DIR, `agent-space-html-message-demo-${runId}.webm`);

    await context.close();
    await video.saveAs(finalVideoPath);
    await browser.close();

    const sizeBytes = fs.statSync(finalVideoPath).size;
    console.log(`VIDEO_PATH=${finalVideoPath}`);
    console.log(`VIDEO_SIZE_BYTES=${sizeBytes}`);
  } catch (error) {
    try {
      const errorShot = path.join(OUTPUT_DIR, `agent-space-html-message-demo-error-${runId}.png`);
      await page.screenshot({ path: errorShot, fullPage: true, timeout: 15000 });
      console.error(`ERROR_SCREENSHOT=${errorShot}`);
    } catch (_) {
      // Ignore secondary screenshot failures.
    }

    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error('Demo video generation failed:', error.message);
  process.exit(1);
});
