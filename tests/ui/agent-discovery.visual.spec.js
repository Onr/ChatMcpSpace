const { test, expect } = require('@playwright/test');
const express = require('express');
const path = require('path');
const root = path.join(__dirname, '../..');
const routes = require('../../src/routes/agentDiscoveryRoutes');

let server;
let baseUrl;
let previousBaseUrl;

test.beforeAll(async () => {
  previousBaseUrl = process.env.BASE_URL;
  const app = express();
  app.set('views', path.join(root, 'views'));
  app.set('view engine', 'ejs');
  app.locals.assetUrl = url => url;
  app.use(express.static(path.join(root, 'public')));
  app.get('/', (_req, res) => res.render('landing', { cspNonce: 'test-nonce', csrfToken: 'fixture-token', user: null, googleAuthEnabled: false }));
  app.use(routes);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = baseUrl;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (previousBaseUrl === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = previousBaseUrl;
});

for (const width of [320, 390, 768, 1280]) {
  test(`a visiting user can find and copy agent setup at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 850 });
    // The real homepage exposes the new entry point even without signing in.
    await page.goto(baseUrl);
    await page.getByRole('link', { name: 'Send it here to guide your setup' }).click();
    await expect(page).toHaveURL(`${baseUrl}/for-agents`);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async value => { window.copiedRequest = value; } },
    }));
    await page.getByRole('button', { name: 'Copy connection request' }).click();
    await expect(page.getByRole('status')).toContainText('Copied');
    expect(await page.evaluate(() => window.copiedRequest)).toContain(`${baseUrl}/agent-setup.md`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const button = await page.getByRole('button', { name: 'Copy connection request' }).boundingBox();
    expect(button.height).toBeGreaterThanOrEqual(44);
    // The fallback selects the complete public request when copying is denied.
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await page.getByRole('button', { name: 'Copy connection request' }).click();
    await expect(page.getByRole('status')).toContainText('highlighted');
    await expect(page.getByLabel('Connection request')).toBeFocused();
    expect(await page.getByLabel('Connection request').evaluate(el => el.selectionEnd === el.value.length)).toBe(true);
    await page.getByRole('heading', { name: 'For visiting agents' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('link', { name: 'Discovery JSON' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`agent-setup-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
