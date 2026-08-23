/**
 * E2E Screenshot Test for Rich Agent Rendering
 * 
 * This script:
 * 1. Logs in as test3@gmail.com
 * 2. Navigates to the DeployBot agent
 * 3. Takes screenshots of rich HTML form messages (collapsed + expanded)
 * 
 * Run: node tests/e2e/rich-rendering-screenshot.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'tmp', 'screenshots-rich-rendering');
const TEST_EMAIL = 'test3@gmail.com';
const TEST_PASSWORD = 'TestPassword123!';
const AGENT_NAME = 'DeployBot';

// Ensure screenshot directory exists
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function saveScreenshot(page, name, options = {}) {
  const filename = `${name}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: false, timeout: 15000, animations: 'disabled', ...options });
    console.log(`  📸 Screenshot saved: ${filepath}`);
  } catch (e) {
    console.log(`  ⚠️ Screenshot ${name} failed: ${e.message.split('\n')[0]}`);
  }
  return filepath;
}

async function main() {
  console.log('🚀 Rich Rendering E2E Screenshot Test\n');
  console.log(`Screenshots will be saved to: ${SCREENSHOT_DIR}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
      '--disable-font-subpixel-positioning'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Block external font requests to prevent timeout
  await page.route('**/*.woff2', route => route.abort());
  await page.route('**/*.woff', route => route.abort());
  await page.route('**/fonts.googleapis.com/**', route => route.abort());
  await page.route('**/fonts.gstatic.com/**', route => route.abort());

  // Inject CSS to disable all animations (prevents screenshot timeouts from infinite animations)
  await context.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });

  try {
    // ─── Step 1: Login ───────────────────────────────────────────────────
    console.log('Step 1: Logging in...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await saveScreenshot(page, '01-landing-page');

    // Fill login form
    await page.fill('#loginEmail', TEST_EMAIL);
    await page.fill('#loginPassword', TEST_PASSWORD);
    await saveScreenshot(page, '02-login-filled');

    // Submit login
    await page.click('#loginTab');
    await page.waitForURL('**/dashboard**', { timeout: 10000 });
    console.log('  ✅ Logged in successfully');

    // Wait for dashboard to load agents
    await page.waitForTimeout(2000);
    await saveScreenshot(page, '03-dashboard-loaded');

    // ─── Step 2: Click on DeployBot agent ────────────────────────────────
    console.log(`\nStep 2: Selecting "${AGENT_NAME}" agent...`);

    // The dashboard uses a dock/grid layout; agents may not be "visible" in Playwright's strict sense.
    // Use JavaScript evaluation to find and click the agent.
    const agentClicked = await page.evaluate((name) => {
      // Try multiple selectors - dock layout, list layout, seat layout
      const selectors = [
        `[data-agent-name="${name}"]`,
        `.agent-list-item[data-agent-name="${name}"]`,
        `.dock-agent[data-agent-name="${name}"]`,
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.click();
          return { found: true, selector: sel, className: el.className };
        }
      }
      // List all available agents for debug
      const all = document.querySelectorAll('[data-agent-name]');
      const names = Array.from(all).map(e => e.getAttribute('data-agent-name'));
      return { found: false, availableAgents: names };
    }, AGENT_NAME);

    console.log('  Agent click result:', JSON.stringify(agentClicked));

    if (!agentClicked.found) {
      throw new Error('Could not find DeployBot agent. Available: ' + JSON.stringify(agentClicked.availableAgents));
    }

    console.log('  ✅ Agent selected');
    await page.waitForTimeout(2000); // Wait for messages to load
    await saveScreenshot(page, '04-agent-selected-messages');

    // ─── Step 3: Screenshot the rich content (collapsed state) ───────────
    console.log('\nStep 3: Capturing rich content (collapsed state)...');

    // Wait for rich content elements to appear
    const richContentSelector = '.rich-content-wrapper';
    await page.waitForSelector(richContentSelector, { timeout: 10000 }).catch(() => {
      console.log('  ⚠️ No .rich-content-wrapper found, checking raw messages...');
    });

    const richContentCount = await page.locator(richContentSelector).count();
    console.log(`  Found ${richContentCount} rich content wrapper(s)`);

    if (richContentCount > 0) {
      // Screenshot the first rich content. The outer Agent Space panel now owns
      // fold/unfold, so the rich content itself renders directly.
      const firstRich = page.locator(richContentSelector).first();
      await firstRich.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await saveScreenshot(page, '05-rich-content-visible');

      // Also capture just the rich content element
      await firstRich.screenshot({ path: path.join(SCREENSHOT_DIR, '05b-rich-element-visible.png'), timeout: 10000 }).catch(e => console.log('  ⚠️ Element screenshot failed:', e.message.split('\n')[0]));
      console.log(`  📸 Element screenshot: 05b-rich-element-visible.png`);

      // ─── Step 4: Interact with the form ────────────────────────────────
      console.log('\nStep 4: Interacting with the form...');

      // Try to select an option in the dropdown (use JS to avoid click interception)
      const selectEl = firstRich.locator('select').first();
      if (await selectEl.count() > 0) {
        await selectEl.evaluate(el => { el.value = 'canary'; el.dispatchEvent(new Event('change')); });
        console.log('  ✅ Changed dropdown to Canary');
      }

      // Try to fill in the textarea (use JS to avoid click interception)
      const textareaEl = firstRich.locator('textarea').first();
      if (await textareaEl.count() > 0) {
        await textareaEl.evaluate(el => { el.value = 'Looks good to deploy! All tests passing.'; });
        console.log('  ✅ Filled textarea');
      }

      // Uncheck a checkbox (use JS click to avoid element interception issues)
      const checkboxes = firstRich.locator('input[type="checkbox"]');
      const checkboxCount = await checkboxes.count();
      if (checkboxCount > 0) {
        await checkboxes.first().evaluate(el => el.checked = false);
        console.log('  ✅ Unchecked first checkbox');
      }

      await page.waitForTimeout(300);
      await saveScreenshot(page, '07-rich-form-interacted');

      // Element screenshot of interacted form
      await firstRich.screenshot({ path: path.join(SCREENSHOT_DIR, '07b-rich-form-interacted-element.png'), timeout: 10000 }).catch(e => console.log('  ⚠️ Element screenshot failed:', e.message.split('\n')[0]));
      console.log(`  📸 Element screenshot: 07b-rich-form-interacted-element.png`);
      // ─── Step 5: Screenshot the second message too ────────────────────
      if (richContentCount > 1) {
        console.log('\nStep 5: Capturing second rich message...');
        const secondRich = page.locator(richContentSelector).nth(1);
        await secondRich.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);

        await secondRich.screenshot({ path: path.join(SCREENSHOT_DIR, '08-second-rich-visible.png'), timeout: 10000 }).catch(e => console.log('  ⚠️ Element screenshot failed:', e.message.split('\n')[0]));
        console.log(`  📸 Element screenshot: 08-second-rich-visible.png`);
      }

    } else {
      console.log('  ⚠️ No rich content wrappers found');
      console.log('  Checking what messages look like...');

      // Debug: check message content
      const messageInfo = await page.evaluate(() => {
        const messages = document.querySelectorAll('.message, .chat-message, [class*="message"]');
        return Array.from(messages).slice(-5).map(m => ({
          className: m.className,
          textSnippet: (m.textContent || '').substring(0, 200),
          hasRichContent: m.querySelector('.rich-content-wrapper') !== null
        }));
      });
      console.log('  Last messages:', JSON.stringify(messageInfo, null, 2));
      await saveScreenshot(page, '05-no-rich-content-debug');
    }

    // ─── Step 7: Full page screenshot ────────────────────────────────────
    console.log('\nStep 7: Full page final screenshot...');
    await saveScreenshot(page, '09-final-full-page');

    console.log('\n✅ All screenshots captured successfully!');
    console.log(`\n📁 Screenshots directory: ${SCREENSHOT_DIR}`);
    console.log(`   Total files: ${fs.readdirSync(SCREENSHOT_DIR).length}`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    await saveScreenshot(page, 'ERROR-screenshot').catch(() => { });

    // Debug info
    const currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);
    const pageContent = await page.content();
    const errorSnippet = pageContent.substring(0, 500);
    console.log(`  Page content snippet: ${errorSnippet}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
