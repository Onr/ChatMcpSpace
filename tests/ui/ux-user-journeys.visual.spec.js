const { test, expect } = require('@playwright/test');
const express = require('express');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const dashboardSource = read('public/js/dashboard.js');
const keyboard = dashboardSource.slice(dashboardSource.indexOf('function setupKeyboardNavigation()'), dashboardSource.indexOf('function setFocusArea(area)'));
const menus = dashboardSource.slice(dashboardSource.indexOf('function bindMobileOverflowActionControls()'), dashboardSource.indexOf('function syncMobilePaperMenuChrome('));
let server, origin;
test.beforeAll(async () => {
  const app = express();
  app.use(express.static(path.join(root, 'public')));
  const locals = { agents: [], groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture', assetUrl: p => p,
    safeJsonForScript: JSON.stringify, currentPath: '/dashboard', user: { userId: 'fixture', email: 'ux@example.test' } };
  app.get('/dashboard', async (_req, res) => {
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    let html = await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, body });
    // Use actual templates and styles with just the keyboard/menu code under test;
    // synthetic fixtures do not connect agents or read a user's conversations.
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    res.send(html);
  });
  app.get('/', async (_req, res) => {
    const body = await ejs.renderFile(path.join(root, 'views/landing.ejs'), { ...locals, user: null, googleAuthEnabled: false });
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, user: null, body }));
  });
  app.get('/register', async (_req, res) => {
    const body = await ejs.renderFile(path.join(root, 'views/register.ejs'), { ...locals, user: null, error: null, email: '', invitationId: null, googleAuthEnabled: false });
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), { ...locals, user: null, body }));
  });
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

for (const width of [320, 390, 768, 1440]) {
  test(`registration explains valid passwords and recovers from errors at ${width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 850 });
    await page.goto(origin);
    await page.evaluate(() => scrollToAuth('register'));
    const form = page.locator('#registerForm');
    await expect(form.getByLabel('Email address', { exact: true })).toBeFocused();
    // Delayed startup scroll correction must not blur an opened form.
    await page.evaluate(() => enforceLandingTopPosition());
    await expect(form.getByLabel('Email address', { exact: true })).toBeFocused();
    await form.getByLabel('Email address', { exact: true }).fill('new-user@example.test');
    await form.getByLabel('Password', { exact: true }).fill('short123');
    expect(await form.getByLabel('Password', { exact: true }).evaluate(el => el.checkValidity())).toBe(false);
    await expect(page.locator('#registerPasswordHint')).toContainText('12–128');
    await form.getByLabel('Password', { exact: true }).fill('LongLettersOnly');
    expect(await form.getByLabel('Password', { exact: true }).evaluate(el => el.checkValidity())).toBe(false);
    await form.getByLabel('Password', { exact: true }).fill('Test-password123');
    expect(await form.getByLabel('Password', { exact: true }).evaluate(el => el.checkValidity())).toBe(true);
    await form.getByLabel('Confirm password', { exact: true }).fill('Different-pass123');
    await form.locator('#agreeTermsLanding').check();
    await form.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#authClientError')).toContainText('Passwords must match');
    await expect(page.locator('#authClientError')).toBeFocused();
    await form.getByLabel('Confirm password', { exact: true }).fill('Test-password123');
    let requests = 0;
    await page.route('**/register', route => { requests++; return route.abort('failed'); });
    await form.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#authClientError')).toContainText('Check your connection');
    const noticeBox = await page.locator('#authClientError').boundingBox();
    expect(noticeBox.y).toBeGreaterThanOrEqual(96);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(850);
    await expect(form.getByRole('button', { name: 'Create Account', exact: true })).toBeEnabled();
    await expect(form.getByLabel('Email address', { exact: true })).toHaveValue('new-user@example.test');
    expect(requests).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('registration.png') });
    expect(errors).toEqual([]);
  });

  test(`empty workspace setup and keyboard controls are reachable at ${width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 850 });
    await page.goto(`${origin}/dashboard`);
    await page.evaluate(() => document.body.classList.toggle('dashboard-mobile', innerWidth < 1024));
    await page.addScriptTag({ content: `${keyboard}\n${menus}\nsetupKeyboardNavigation(); bindMobileOverflowActionControls();` });
    // Native Tab/Shift+Tab work on links, including the first skip link.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mainContent')).toBeFocused();
    const welcome = page.locator('#agentPanelPlaceholder');
    for (const href of ['/for-agents', '/settings#cli-setup']) {
      const link = welcome.locator(`a[href="${href}"]`);
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(851);
    }
    const first = welcome.locator('a').first();
    await first.focus();
    await page.keyboard.press('Tab');
    await expect(welcome.locator('a').nth(1)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('workspace.png') });
    // Enter on a native link must follow that link, without opening a council chat.
    await page.route('**/for-agents', route => route.fulfill({ body: '<h1>Setup reached</h1>' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin}/for-agents`);
    expect(errors).toEqual([]);
  });
}

test('phone menu opens with Enter, closes with Escape and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/dashboard`);
  await page.addScriptTag({ content: `${keyboard}\n${menus}\nsetupKeyboardNavigation(); bindMobileOverflowActionControls();` });
  const toggle = page.locator('#mobileNavActionsToggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#navToggleButton').focus();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await expect(page.locator('#navToggleButton')).toBeHidden();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`Fast Mode setup cards remain tappable at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${origin}/dashboard`);
    await page.evaluate(() => document.body.classList.add('dashboard-mobile', 'dashboard-fast-mode'));
    if (viewport.width > viewport.height) {
      expect((await page.locator('.council-chamber').boundingBox()).width).toBe(0);
    }
    await page.screenshot({ path: test.info().outputPath('fast-mode-initial.png') });
    for (const link of await page.locator('.workspace-welcome__path').all()) {
      await link.scrollIntoViewIfNeeded();
      const metrics = await link.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: innerHeight, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), obscuring: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML.slice(0, 180) };
      });
      expect(metrics.top >= 0 && metrics.bottom <= metrics.height && metrics.hit, JSON.stringify(metrics)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('fast-mode-welcome.png') });
    await context.close();
  });
}

for (const width of [390, 1280]) test(`direct registration keeps validation and error recovery consistent at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 850 });
  await page.goto(`${origin}/register`);
  await page.getByLabel('Email address', { exact: true }).fill('invitee@example.test');
  await page.getByLabel('Password', { exact: true }).fill('LettersOnlyPassword');
  expect(await page.getByLabel('Password', { exact: true }).evaluate(el => el.checkValidity())).toBe(false);
  await page.getByLabel('Password', { exact: true }).fill('Test-password123');
  await page.getByLabel('Confirm Password', { exact: true }).fill('Different-pass123');
  await page.locator('#agreeTerms').check();
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#registrationClientError')).toContainText('Passwords do not match');
  await page.getByLabel('Confirm Password', { exact: true }).fill('Test-password123');
  await page.route('**/register', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#registrationClientError')).toContainText('Check your connection');
  await expect(page.getByRole('button', { name: 'Create Account', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('invitee@example.test');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('layout initialization delegates both menus before asynchronous dashboard startup completes', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/dashboard`);
  await page.addScriptTag({ content: menus });
  const sharedInitializer = [...read('views/layout.ejs').replace(/<%= cspNonce %>/g, 'fixture').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).find(script => script.includes('function initSharedMobileNavActions()'));
  await page.addScriptTag({ content: sharedInitializer });
  const council = page.locator('#mobileCouncilActionsToggle');
  await council.click();
  await expect(council).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(council).toHaveAttribute('aria-expanded', 'false');
  await expect(council).toBeFocused();
  const nav = page.locator('#mobileNavActionsToggle');
  await nav.click();
  await expect(nav).toHaveAttribute('aria-expanded', 'true');
  // Repeating late dashboard initialization must not register a second handler.
  await page.evaluate(() => bindMobileOverflowActionControls());
  await nav.click();
  await expect(nav).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});
