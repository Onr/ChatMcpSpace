const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

for (const width of [390, 1280]) {
  test(`Windows copy steps, OS override and keyboard closing work at ${width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 850 });
    await page.setContent(`<style>${read('public/css/tailwind.css')}\n${read('public/css/style.css')}</style>
      <button id="navCopySetupButton" onclick="copyMainCLIScript(this)">Setup Script</button>
      <button id="windowsSetup" data-open-agent-setup data-setup-base-url="https://chat.example" data-setup-os="windows">Windows setup</button>
      <button id="cosSetup" data-open-agent-setup data-setup-base-url="https://chat.example" data-setup-os="windows" data-setup-cos="true">Chief of Staff setup</button>
      ${read('views/partials/agent-setup-dialog.ejs')}`);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedSetup = text; } }, configurable: true });
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    });
    await page.addScriptTag({ path: path.join(root, 'public/js/setup-platform.js') });
    await page.addScriptTag({ path: path.join(root, 'public/js/setup-script.js') });
    // Test uses about:blank; use a public, non-secret server address explicitly.
    await page.evaluate(() => {
      const open = ChatMCPSetup.open;
      ChatMCPSetup.open = options => open({ baseUrl: 'https://chat.example', ...options });
    });
    await page.locator('#navCopySetupButton').click();
    const dialog = page.locator('#agentSetupDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-setup-platform]')).toHaveValue('windows');
    const sections = dialog.locator('[data-setup-steps] section');
    await expect(sections).toHaveCount(1);
    await sections.first().getByRole('button').click();
    expect(await page.evaluate(() => window.copiedSetup)).toContain("-Uri 'https://chat.example/setup.ps1'");
    await expect(dialog.getByRole('status')).toContainText('PowerShell');
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await dialog.locator('section textarea').evaluateAll(nodes => nodes.every(el => el.scrollHeight <= el.clientHeight + 2))).toBe(true);
    const diagnostics = dialog.locator('details').filter({ hasText: 'Installation failed?' });
    await diagnostics.locator('summary').click();
    await expect(diagnostics.locator('textarea')).toBeVisible();
    expect(await diagnostics.locator('textarea').inputValue()).toContain('windows-cli.ps1" doctor');
    expect(await diagnostics.locator('textarea').evaluate(el => el.scrollHeight <= el.clientHeight + 2)).toBe(true);
    await diagnostics.locator('summary').click();
    await expect(dialog.locator('[data-setup-windows-note]')).toContainText('automatically installs Node.js');
    await expect(sections.first()).toContainText('missing or too old');
    await expect(dialog.locator('details')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath(`windows-setup-${width}.png`) });
    await dialog.getByRole('button', { name: 'Linux / macOS', exact: true }).click();
    await expect(sections).toHaveCount(1);
    await sections.first().getByRole('button').click();
    expect(await page.evaluate(() => window.copiedSetup)).toBe("curl -fsSL 'https://chat.example/setup' | bash");
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('#navCopySetupButton')).toBeFocused();
    await page.locator('#cosSetup').click();
    await expect(sections).toHaveCount(1);
    await expect(dialog.locator('[data-setup-cos-note]')).toBeVisible();
    await sections.last().getByRole('button').click();
    expect(await page.evaluate(() => window.copiedSetup)).toContain('/setup.ps1');
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
    await sections.last().getByRole('button').click();
    await expect(dialog.getByRole('status')).toContainText('Copy the selected command');
    expect(errors).toEqual([]);
  });
}
