const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const stylesheet = fs.readFileSync(path.join(__dirname, '../../public/css/tailwind.css'), 'utf8');

for (const width of [390, 1280]) {
  test(`CSS upgrade preserves legacy spacing, grids, forms, and heading sizes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(`<style>${stylesheet}</style>
      <div id="spacing" class="space-y-4" style="border:1px solid;width:300px">
        <div id="first" style="height:20px;margin-top:8px">First</div>
        <div hidden>Hidden</div>
        <div id="last" style="height:20px">Last</div>
      </div>
      <div class="grid grid-cols-[35fr,65fr]" style="width:1000px"><div id="left">Left</div><div id="right">Right</div></div>
      <div class="grid lg:grid-cols-[45fr,55fr]" style="width:1000px"><div id="responsive">Responsive</div><div>Second</div></div>
      <h1 id="heading" class="text-5xl sm:text-6xl md:text-7xl leading-tight sm:leading-none">Heading</h1>
      <div id="fixed" class="flex-shrink-0 shadow-sm text-slate-100 rounded-lg">Fixed item</div>
      <input id="field" class="border p-3 focus:outline-none focus:ring-2" aria-label="Test field">
    `);

    const first = await page.locator('#first').boundingBox();
    const last = await page.locator('#last').boundingBox();
    expect(last.y - first.y - first.height).toBe(16);
    expect(await page.locator('#first').evaluate(node => getComputedStyle(node).marginTop)).toBe('8px');
    expect((await page.locator('#left').boundingBox()).width).toBe(350);
    expect((await page.locator('#right').boundingBox()).width).toBe(650);
    expect((await page.locator('#responsive').boundingBox()).width).toBe(width >= 1024 ? 450 : 1000);
    await expect(page.locator('#heading')).toHaveCSS('font-size', width >= 768 ? '72px' : '48px');
    await expect(page.locator('#heading')).toHaveCSS('line-height', width >= 768 ? '72px' : '60px');
    await expect(page.locator('#fixed')).toHaveCSS('flex-shrink', '0');
    await expect(page.locator('#fixed')).toHaveCSS('color', 'rgb(241, 245, 249)');
    await expect(page.locator('#fixed')).toHaveCSS('border-radius', '8px');

    await page.locator('#field').fill('Typing still works');
    await expect(page.locator('#field')).toHaveValue('Typing still works');
    await expect(page.locator('#field')).toHaveCSS('outline-style', 'solid');
    await expect(page.locator('#field')).toHaveCSS('outline-width', '2px');
    await expect(page.locator('#field')).toHaveCSS('padding', '12px');
  });
}
