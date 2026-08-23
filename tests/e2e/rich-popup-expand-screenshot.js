/**
 * E2E Screenshot + Behavior Test for Interactive Content Expand Popup
 *
 * Verifies:
 * 1) Expand opens a near-fullscreen popup overlay
 * 2) Backdrop click closes popup and restores content
 * 3) Escape closes popup
 * 4) Collapsing the panel while popup is open closes popup
 *
 * Run:
 *   node tests/e2e/rich-popup-expand-screenshot.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RICH_JS_PATH = path.join(ROOT, 'public', 'js', 'rich-rendering.js');
const RICH_CSS_PATH = path.join(ROOT, 'public', 'css', 'rich-rendering.css');
const OUT_DIR = path.join(ROOT, 'tests', 'test-results', `rich-popup-expand-${timestamp()}`);

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function saveScreenshot(page, name) {
  const out = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: out, fullPage: false, animations: 'disabled', timeout: 15000 });
  return out;
}

function assertCheck(checks, name, pass, details) {
  checks.push({ name, pass, details });
  if (!pass) {
    throw new Error(`${name} failed: ${details}`);
  }
}

async function main() {
  ensureDir(OUT_DIR);

  const richJs = fs.readFileSync(RICH_JS_PATH, 'utf8');
  const richCss = fs.readFileSync(RICH_CSS_PATH, 'utf8');
  const checks = [];
  const screenshots = [];

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.setContent(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Rich Popup Expand Fixture</title>
        <style>
          * { animation: none !important; transition: none !important; }
          body { margin: 0; font-family: Arial, sans-serif; background: #0b1220; color: #e2e8f0; }
          .hidden { display: none !important; }
          .fixture-shell { padding: 18px; height: 100vh; box-sizing: border-box; }
          .fixture-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
          .fixture-btn {
            border: 1px solid #334155;
            background: #1e293b;
            color: #e2e8f0;
            border-radius: 8px;
            padding: 6px 10px;
            font-size: 13px;
            cursor: pointer;
          }
          .fixture-status {
            margin-left: 4px;
            font-size: 12px;
            color: #94a3b8;
          }
          #mainInteractiveContent {
            max-height: 62vh;
            overflow: auto;
            border: 1px solid rgba(148,163,184,0.2);
            border-radius: 10px;
            background: rgba(15,23,42,0.75);
          }
        </style>
      </head>
      <body>
        <div class="fixture-shell">
          <div class="fixture-controls">
            <button id="expandBtn" class="fixture-btn">Expand</button>
            <button id="collapseBtn" class="fixture-btn">Collapse</button>
            <button id="uncollapseBtn" class="fixture-btn">Uncollapse</button>
            <span id="statusText" class="fixture-status">popup: closed</span>
          </div>
          <div id="mainInteractiveContent" class="rich-content-body">
            <div class="rich-content-wrapper">
              <div class="rich-content-badge"><span>Interactive Content</span></div>
              <div class="rich-content-header">
                <div class="rich-content-title-row">
                  <h4 class="rich-content-title">Fixture Agent Space</h4>
                </div>
                <p class="rich-content-description">Fixture content for popup expand tests.</p>
              </div>
              <div class="rich-content-body">
                <div style="padding: 12px;">
                  <h3>Release Dashboard</h3>
                  <p>This is a deterministic fixture used for popup screenshot tests.</p>
                  <table>
                    <thead><tr><th>Service</th><th>Status</th><th>Latency</th></tr></thead>
                    <tbody>
                      <tr><td>api</td><td>healthy</td><td>112ms</td></tr>
                      <tr><td>worker</td><td>healthy</td><td>98ms</td></tr>
                      <tr><td>scheduler</td><td>degraded</td><td>310ms</td></tr>
                    </tbody>
                  </table>
                  <p style="margin-top: 14px;">Extra content for scrolling and viewport coverage.</p>
                  <p style="height: 520px; margin: 0; display: flex; align-items: center;">End of content block.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `, { waitUntil: 'domcontentloaded' });

    await page.addStyleTag({ content: richCss });
    await page.addScriptTag({ content: richJs });

    await page.evaluate(() => {
      const content = document.getElementById('mainInteractiveContent');
      const expandBtn = document.getElementById('expandBtn');
      const collapseBtn = document.getElementById('collapseBtn');
      const uncollapseBtn = document.getElementById('uncollapseBtn');
      const statusText = document.getElementById('statusText');

      const setState = (open) => {
        if (statusText) statusText.textContent = `popup: ${open ? 'open' : 'closed'}`;
        if (expandBtn) expandBtn.dataset.popupOpen = String(open);
      };

      if (expandBtn && content && window.RichRendering) {
        expandBtn.addEventListener('click', () => {
          const open = window.RichRendering.toggleInteractiveContentPopup({
            sourceContentEl: content,
            title: 'Fixture Agent Space',
            onStateChange: setState
          });
          setState(open);
        });
      }

      if (collapseBtn && content && window.RichRendering) {
        collapseBtn.addEventListener('click', () => {
          content.classList.add('hidden');
          const closed = window.RichRendering.closeInteractiveContentPopupFor(content);
          if (closed) setState(false);
        });
      }

      if (uncollapseBtn && content) {
        uncollapseBtn.addEventListener('click', () => {
          content.classList.remove('hidden');
        });
      }
    });

    screenshots.push(await saveScreenshot(page, '01-inline-initial'));

    // 1) Expand opens popup overlay
    await page.click('#expandBtn');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'visible', timeout: 5000 });
    const openState = await page.evaluate(() => {
      const source = document.getElementById('mainInteractiveContent');
      return {
        overlay: !!document.querySelector('.rich-content-popup-overlay'),
        bodyLocked: document.body.classList.contains('rich-popup-open'),
        sourceHasContent: !!source.querySelector('.rich-content-wrapper'),
        popupHasContent: !!document.querySelector('.rich-content-popup-body .rich-content-wrapper')
      };
    });
    assertCheck(
      checks,
      'Expand opens popup overlay and moves content',
      openState.overlay && openState.bodyLocked && !openState.sourceHasContent && openState.popupHasContent,
      JSON.stringify(openState)
    );
    screenshots.push(await saveScreenshot(page, '02-popup-open'));

    // 2) Backdrop click closes popup
    await page.locator('.rich-content-popup-overlay').click({ position: { x: 6, y: 6 }, force: true });
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'detached', timeout: 5000 });
    const backdropCloseState = await page.evaluate(() => {
      const source = document.getElementById('mainInteractiveContent');
      return {
        overlay: !!document.querySelector('.rich-content-popup-overlay'),
        bodyLocked: document.body.classList.contains('rich-popup-open'),
        sourceHasContent: !!source.querySelector('.rich-content-wrapper')
      };
    });
    assertCheck(
      checks,
      'Backdrop click closes popup and restores content',
      !backdropCloseState.overlay && !backdropCloseState.bodyLocked && backdropCloseState.sourceHasContent,
      JSON.stringify(backdropCloseState)
    );
    screenshots.push(await saveScreenshot(page, '03-popup-closed-by-backdrop'));

    // 3) Escape closes popup
    await page.click('#expandBtn');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'visible', timeout: 5000 });
    screenshots.push(await saveScreenshot(page, '04-popup-open-before-escape'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'detached', timeout: 5000 });
    const escapeCloseState = await page.evaluate(() => {
      const source = document.getElementById('mainInteractiveContent');
      return {
        overlay: !!document.querySelector('.rich-content-popup-overlay'),
        sourceHasContent: !!source.querySelector('.rich-content-wrapper')
      };
    });
    assertCheck(
      checks,
      'Escape closes popup and restores content',
      !escapeCloseState.overlay && escapeCloseState.sourceHasContent,
      JSON.stringify(escapeCloseState)
    );
    screenshots.push(await saveScreenshot(page, '05-popup-closed-by-escape'));

    // 4) Collapse while popup open closes popup
    await page.click('#uncollapseBtn');
    await page.click('#expandBtn');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'visible', timeout: 5000 });
    // Collapse is triggered programmatically here because the popup overlay
    // intentionally covers the background controls.
    await page.evaluate(() => {
      const collapseBtn = document.getElementById('collapseBtn');
      if (collapseBtn) collapseBtn.click();
    });
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'detached', timeout: 5000 });
    const collapseState = await page.evaluate(() => {
      const source = document.getElementById('mainInteractiveContent');
      return {
        overlay: !!document.querySelector('.rich-content-popup-overlay'),
        hidden: source.classList.contains('hidden'),
        sourceHasContent: !!source.querySelector('.rich-content-wrapper')
      };
    });
    assertCheck(
      checks,
      'Collapse closes popup and leaves source collapsed',
      !collapseState.overlay && collapseState.hidden && collapseState.sourceHasContent,
      JSON.stringify(collapseState)
    );
    screenshots.push(await saveScreenshot(page, '06-collapsed-while-popup-open'));

    const reportPath = path.join(OUT_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      ok: true,
      checks,
      screenshots
    }, null, 2));

    console.log(`PASS rich popup screenshot test`);
    console.log(`Screenshots: ${OUT_DIR}`);
    console.log(`Report: ${reportPath}`);
  } catch (error) {
    const failShot = path.join(OUT_DIR, 'ERROR-state.png');
    try {
      await page.screenshot({ path: failShot, fullPage: true, animations: 'disabled', timeout: 15000 });
    } catch (_) {
      // Ignore screenshot-on-failure errors.
    }

    const reportPath = path.join(OUT_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      ok: false,
      error: error.message,
      checks,
      screenshots
    }, null, 2));

    console.error(`FAIL rich popup screenshot test: ${error.message}`);
    console.error(`Artifacts: ${OUT_DIR}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
