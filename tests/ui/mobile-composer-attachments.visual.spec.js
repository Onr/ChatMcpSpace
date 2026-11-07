const { test, expect } = require('@playwright/test');
const express = require('express');
const ejs = require('ejs');
const multer = require('multer');
const path = require('path');
const root = path.join(__dirname, '../..');
const { assetUrl } = require(path.join(root, 'src/utils/assetUrl'));
const DeviceBadge = require(path.join(root, 'public/js/device-badge'));
const { safeJsonForScript } = require(path.join(root, 'src/utils/safeJsonHelper'));

const salt = 'c2FsdHNhbHRzYWx0c2FsdA==';
const storedKey = Buffer.alloc(32, 7).toString('base64');
const names = ['AgentsMCPspace', 'Local News - AWS_c1', 'chatmcp-test-agent', 'notes-onro-1', 'Reviewer Bot', 'Grok Bot'];
const agents = names.map((name, i) => ({ agentId: `agent-${i}`, name, agentType: 'standard', position: i + 1,
  highestPriority: 'low', lastMessagePriority: 'low', unreadCount: 0, marbleSvg: '' }));
const androidChrome = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
const uploads = [];
let server, origin;

test.beforeAll(async () => {
  const app = express();
  app.use(express.static(path.join(root, 'public')));
  app.get('/dashboard', async (_req, res) => {
    const locals = { agents, groups: [], encryptionSalt: salt, isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
      assetUrl, DeviceBadge, safeJsonForScript, currentPath: '/dashboard', user: { userId: 'fixture', email: 'fixture@example.test' } };
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body }));
  });
  app.get('/api/user/agents', (_req, res) => res.json({ agents, groups: [] }));
  app.get('/api/user/messages/:agentId', (_req, res) => res.json({ messages: [], hasMore: false }));
  app.get('/dashboard/config', (_req, res) => res.json({}));
  app.post('/api/user/attachments', multer().single('file'), (req, res) => {
    uploads.push(req.body);
    res.status(201).json({ attachment: { attachmentId: `attachment-${uploads.length}` } });
  });
  app.use('/api', (_req, res) => res.json([]));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
test.beforeEach(() => { uploads.length = 0; });

async function openDashboard(browser, { withKey = true, fast = false, viewport = { width: 412, height: 800 } } = {}) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, userAgent: androidChrome });
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.addInitScript(({ withKey, fast, salt, storedKey }) => {
    localStorage.setItem('cos_modal_dismissed_at', new Date().toISOString());
    if (withKey) localStorage.setItem(`encryptionKey:${salt}`, storedKey);
    if (fast) localStorage.setItem('dashboardFastMode', '1');
  }, { withKey, fast, salt, storedKey });
  await page.goto(origin + '/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.dashboardReady);
  return { context, page };
}

async function selectAgent(page) {
  await page.evaluate(() => {
    document.querySelectorAll('#decryptionPasswordModal').forEach(modal => modal.classList.add('hidden'));
    document.querySelector('#agentListScroll .agent-list-item[data-agent-id="agent-0"]').click();
  });
  await expect.poll(() => page.evaluate(() => window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe('agent-0');
}

async function tapCentre(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

// Playwright fills in a MIME type from the extension, so build the File in the
// page to get the empty file.type some Android pickers really hand back.
async function pickFile(page, inputId, { name, type = '', size = 8 }) {
  await page.evaluate(({ inputId, name, type, size }) => {
    const input = document.getElementById(inputId);
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(size)], name, { type }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { inputId, name, type, size });
}

const pending = page => page.evaluate(() => pendingImages.map(entry => ({ status: entry.status, error: entry.error,
  preview: Boolean(entry.previewUrl) })));

test('attach buttons work once a stored key has loaded at startup', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  await selectAgent(page);
  for (const label of ['#imageUploadLabel', '#generalFileUploadLabel']) {
    await expect(page.locator(label)).not.toHaveClass(/(^|\s)disabled(\s|$)/);
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 });
    await tapCentre(page, label);
    await chooser;
  }
  await context.close();
});

test('attach buttons explain a missing key and recover after unlocking', async ({ browser }) => {
  const { context, page } = await openDashboard(browser, { withKey: false });
  await selectAgent(page);
  await tapCentre(page, '#imageUploadLabel');
  await expect(page.locator('#decryptionPasswordModal')).toBeVisible();
  await expect(page.locator('#userMessageInput')).not.toBeFocused();
  await page.fill('#decryptionPasswordInput', 'correct horse');
  await page.click('#decryptionSubmitBtn');
  await expect(page.locator('#decryptionPasswordModal')).toBeHidden({ timeout: 20000 });
  await expect(page.locator('#imageUploadLabel')).not.toHaveClass(/(^|\s)disabled(\s|$)/);
  const chooser = page.waitForEvent('filechooser', { timeout: 3000 });
  await tapCentre(page, '#imageUploadLabel');
  await chooser;
  await context.close();
});

for (const inputId of ['imageFileInput', 'generalFileInput']) {
  test(`HEIC photos send through ${inputId}`, async ({ browser }) => {
    const { context, page } = await openDashboard(browser);
    await selectAgent(page);
    await pickFile(page, inputId, { name: 'IMG_0001.heic', type: 'image/heic' });
    expect(await pending(page)).toEqual([expect.objectContaining({ preview: false })]);
    await expect(page.locator('#imagePreviewContainer img')).toHaveCount(0);
    await expect(page.locator('#imagePreviewContainer .file-preview-item')).toHaveCount(1);
    await page.evaluate(() => uploadAllImages());
    expect(await pending(page)).toEqual([expect.objectContaining({ status: 'success', error: null })]);
    expect(uploads).toEqual([expect.objectContaining({ contentType: 'image/heic' })]);
    await context.close();
  });
}

test('photos with an empty browser type are accepted and typed from the name', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  await selectAgent(page);
  await pickFile(page, 'imageFileInput', { name: 'PXL_20261107.jpg' });
  await pickFile(page, 'imageFileInput', { name: 'content-1234' });
  expect(await pending(page)).toHaveLength(2);
  await page.evaluate(() => { for (const entry of pendingImages) entry.previewUrl = null; uploadAllImages(); });
  await expect.poll(() => uploads.map(body => body.contentType)).toEqual(['image/jpeg', 'application/octet-stream']);
  await context.close();
});

test('pasted images use the normal size limit and any image type', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  await selectAgent(page);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(6 * 1000 * 1000)], 'keyboard.bmp', { type: 'image/bmp' }));
    document.getElementById('userMessageInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  expect(await pending(page)).toHaveLength(1);
  await context.close();
});

test('the browser size limit matches the server limit', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  await selectAgent(page);
  await pickFile(page, 'generalFileInput', { name: 'over.zip', type: 'application/zip', size: 20 * 1000 * 1000 + 1 });
  await pickFile(page, 'generalFileInput', { name: 'fits.zip', type: 'application/zip', size: 20 * 1000 * 1000 });
  expect(await pending(page)).toHaveLength(1);
  await context.close();
});

test('sent photos the browser cannot display show as a file card', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  const rendered = await page.evaluate(() => [
    { contentType: 'image/heic', fileName: 'IMG.heic' },
    { contentType: 'image/png', fileName: 'shot.png' }
  ].map(attachment => {
    const item = createAttachmentElement(attachment, 'blob:fixture', 'message-1');
    return { image: item.querySelectorAll('img').length, card: item.querySelectorAll('.message-attachment-file').length };
  }));
  expect(rendered).toEqual([{ image: 0, card: 1 }, { image: 1, card: 0 }]);
  await context.close();
});

for (const fast of [false, true]) {
  test(`open agent list has a visible edge and hides the chat, fast=${fast}`, async ({ browser }) => {
    const { context, page } = await openDashboard(browser, { fast });
    await selectAgent(page);
    await page.locator(fast ? '#fastModeChatListToggle' : '#collapseMobileListBtn').click();
    const panel = page.locator('#agentListPanel');
    await expect(panel).toHaveClass(/mobile-expanded/);
    const alpha = color => { const parts = color.match(/[\d.]+/g).map(Number); return parts.length > 3 ? parts[3] : 1; };
    const style = await panel.evaluate(el => { const s = getComputedStyle(el), h = getComputedStyle(el.querySelector('.agent-list-header'));
      return { width: parseFloat(s.borderBottomWidth), line: s.borderBottomColor, background: s.backgroundColor, header: h.borderBottomColor }; });
    expect(style.width).toBeGreaterThanOrEqual(2);
    expect(alpha(style.line)).toBeGreaterThanOrEqual(0.5);
    expect(alpha(style.background)).toBe(1);
    expect(alpha(style.header)).toBeGreaterThanOrEqual(0.3);
    await page.waitForTimeout(450);
    await page.screenshot({ path: test.info().outputPath('open-list.png') });
    await context.close();
  });
}

test('agent search forgives typos and ranks the best match first', async ({ browser }) => {
  const { context, page } = await openDashboard(browser);
  await selectAgent(page);
  await page.locator('#collapseMobileListBtn').click();
  const search = page.locator('#agentListSearchInput');
  const shown = () => page.locator('#agentListScroll .agent-list-item').evaluateAll(items => items.map(item => item.dataset.agentName));
  await search.click();
  await search.fill('agnets');
  await expect.poll(shown).toEqual(['AgentsMCPspace']);
  await search.fill('gork');
  await expect.poll(shown).toEqual(['Grok Bot']);
  await search.fill('notes onro');
  await expect.poll(shown).toEqual(['notes-onro-1']);
  await search.fill('zzzz');
  await expect.poll(shown).toEqual([]);
  await context.close();
});
