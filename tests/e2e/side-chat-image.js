const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test3@gmail.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';

const NAV_TIMEOUT = 10000;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const stamp = timestamp();
  const outDir = path.join(__dirname, '..', 'test-results', `side-chat-image-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // 1. Login
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForSelector('#loginEmail');
    await page.fill('#loginEmail', TEST_EMAIL);
    await page.fill('#loginPassword', TEST_PASSWORD);
    await page.click('#loginTab');
    await page.waitForURL('**/dashboard**');
    
    // Wait for agents
    await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached' });
    
    // Create an agent if none exist
    const agents = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.agent-seat[data-agent-id]')).map(el => ({
            id: el.getAttribute('data-agent-id'),
            name: el.getAttribute('data-agent-name')
        }));
    });
    
    if (agents.length === 0) {
        throw new Error('No agents available for testing.');
    }

    const agent = agents[0];
    
    // 2. Open side panel
    await page.evaluate((ag) => {
        window.MultiChatManager.openSidePanel(ag.id, ag.name, {});
    }, agent);
    
    await page.waitForTimeout(1000);
    
    const screenshotPath = path.join(outDir, '01-side-chat-opened.png');
    await page.screenshot({ path: screenshotPath });
    console.log('Saved screenshot:', screenshotPath);

    // 3. Setup Mock Clipboard inside a side-chat tile's textarea
    const tileSelector = `.chat-tile[data-agent-id="${agent.id}"]`;
    await page.waitForSelector(`${tileSelector} .chat-tile__textarea`);
    
    // Add a single fake image file to the input manually as Playwright struggles with clipboard paste of files natively
    const testImagePath = path.join(outDir, 'dummy.png');
    fs.writeFileSync(testImagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); // 1x1 png
    
    const fileInput = await page.$(`${tileSelector} .chat-tile__image-input`);
    await fileInput.setInputFiles(testImagePath);
    
    await page.waitForTimeout(500);
    
    const previewScreenshot = path.join(outDir, '02-image-previewing.png');
    await page.screenshot({ path: previewScreenshot });
    console.log('Saved screenshot:', previewScreenshot);

    const checkPreview = await page.evaluate((id) => {
        const p = document.querySelector(`.chat-tile[data-agent-id="${id}"] .chat-tile__image-preview-area`);
        return p && !p.classList.contains('hidden');
    }, agent.id);
    
    if (!checkPreview) throw new Error("Image preview did not appear!");
    console.log("PASS: Image was added to side chat and preview rendered.");

    // Enter some text
    await page.fill(`${tileSelector} .chat-tile__textarea`, 'Here is my test image!');

    // Take final screenshot
    const readyToSendScreenshot = path.join(outDir, '03-ready-to-send.png');
    await page.screenshot({ path: readyToSendScreenshot });
    console.log('Saved screenshot:', readyToSendScreenshot);
    console.log("TEST SUCCESSFUL");
    process.exitCode = 0;
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
