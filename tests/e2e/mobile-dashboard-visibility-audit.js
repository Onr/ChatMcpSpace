#!/usr/bin/env node

/**
 * Mobile dashboard visibility audit for agents.
 *
 * Purpose:
 * - Capture screenshots of the mobile dashboard states that commonly regress.
 * - Verify the necessary controls are visible: agent list toggle, selected agent,
 *   message textarea, model/provider button, stop button, send button, and
 *   provider/model sheet.
 * - Produce a Markdown report with pass/fail notes and recommendations.
 * - Clean artifacts when requested.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   TEST_USER_EMAIL=user@example.com TEST_USER_PASSWORD='...' \
 *   node tests/e2e/mobile-dashboard-visibility-audit.js
 *
 * Optional:
 *   MOBILE_AUDIT_AUTH_STATE=/path/to/playwright-storage-state.json
 *   MOBILE_AUDIT_OUT_DIR=tmp/mobile-dashboard-visibility-audit
 *   node tests/e2e/mobile-dashboard-visibility-audit.js --keep-artifacts
 *   node tests/e2e/mobile-dashboard-visibility-audit.js --cleanup-only
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const OUT_DIR = path.resolve(process.env.MOBILE_AUDIT_OUT_DIR || 'tmp/mobile-dashboard-visibility-audit');
const KEEP_ARTIFACTS = process.argv.includes('--keep-artifacts');
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');

const VIEWPORTS = [
  { name: 'chrome-small', width: 360, height: 640 },
  { name: 'chrome-common', width: 390, height: 844 },
  { name: 'chrome-tall', width: 412, height: 915 },
];

const REQUIRED_VISIBLE_WHEN_AGENT_SELECTED = [
  { name: 'message composer', selector: '#messageInputArea' },
  { name: 'message textarea', selector: '#userMessageInput' },
  { name: 'model/provider button', selector: '#agentConfigBtn' },
  { name: 'stop button', selector: '#agentStopBtn' },
  { name: 'send button', selector: '#userMessageSend' },
];

function ensureCleanDir() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeReport(lines) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, 'report.md');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return reportPath;
}

async function maybeLogin(page) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  if (await page.locator('#dashboardRoot').count()) return;

  const authState = process.env.MOBILE_AUDIT_AUTH_STATE;
  if (authState) {
    throw new Error(`Auth state was loaded from ${authState}, but /dashboard did not render #dashboardRoot.`);
  }

  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error([
      'Dashboard is not authenticated.',
      'Provide MOBILE_AUDIT_AUTH_STATE or TEST_USER_EMAIL and TEST_USER_PASSWORD.',
      'Example: TEST_USER_EMAIL=me@example.com TEST_USER_PASSWORD=... node tests/e2e/mobile-dashboard-visibility-audit.js',
    ].join(' '));
  }

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
  await emailInput.fill(email);
  await passwordInput.fill(password);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    passwordInput.press('Enter'),
  ]).catch(async () => {
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForLoadState('domcontentloaded');
  });
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('#dashboardRoot').waitFor({ timeout: 10000 });
}

async function capture(page, name, lines) {
  const screenshot = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  lines.push(`- Screenshot: \`${path.relative(process.cwd(), screenshot)}\``);
}

async function isVisibleInViewport(page, selector) {
  return page.locator(selector).first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || '1') > 0.01 &&
      rect.width > 0 &&
      rect.height > 0;
    const inViewport = rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    return {
      visible,
      inViewport,
      rect: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
  });
}

async function checkVisible(page, label, selector, lines, failures) {
  const count = await page.locator(selector).count();
  if (!count) {
    failures.push(`${label}: missing selector ${selector}`);
    lines.push(`  - FAIL ${label}: missing \`${selector}\``);
    return;
  }
  const result = await isVisibleInViewport(page, selector);
  if (!result.visible || !result.inViewport) {
    failures.push(`${label}: not visible in viewport (${JSON.stringify(result.rect)})`);
    lines.push(`  - FAIL ${label}: outside viewport or hidden, rect=${JSON.stringify(result.rect)}`);
    return;
  }
  lines.push(`  - PASS ${label}: visible, rect=${JSON.stringify(result.rect)}`);
}

async function selectFirstAgentIfPossible(page, lines) {
  const item = page.locator('.agent-list-item[data-agent-id]:not([data-agent-id="__ALL__"])').first();
  if (!(await item.count())) {
    lines.push('- No selectable agent found; composer-specific checks were skipped.');
    return false;
  }
  await item.click();
  await page.waitForTimeout(600);
  await page.locator('#messageInputArea').waitFor({ timeout: 5000 });
  return true;
}

async function runViewport(browser, viewport, reportLines, allFailures) {
  const contextOptions = {
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  };
  if (process.env.MOBILE_AUDIT_AUTH_STATE) {
    contextOptions.storageState = process.env.MOBILE_AUDIT_AUTH_STATE;
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const failures = [];

  reportLines.push(`\n## ${viewport.name} (${viewport.width}x${viewport.height})`);
  await maybeLogin(page);
  await page.waitForTimeout(800);
  await capture(page, `${viewport.name}-initial`, reportLines);
  await checkVisible(page, 'dashboard root', '#dashboardRoot', reportLines, failures);
  await checkVisible(page, 'agent list toggle', '#collapseMobileListBtn', reportLines, failures);

  const hasAgent = await selectFirstAgentIfPossible(page, reportLines);
  if (hasAgent) {
    await page.locator('#userMessageInput').fill('Mobile visibility audit draft');
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, `${viewport.name}-composer`, reportLines);
    for (const item of REQUIRED_VISIBLE_WHEN_AGENT_SELECTED) {
      await checkVisible(page, item.name, item.selector, reportLines, failures);
    }

    await page.locator('#agentConfigBtn').click();
    await page.waitForTimeout(400);
    await capture(page, `${viewport.name}-provider-sheet`, reportLines);
    await checkVisible(page, 'provider/model sheet', '#agentConfigDropdown', reportLines, failures);
    await checkVisible(page, 'provider selector', '#configProvider', reportLines, failures);
    await checkVisible(page, 'model selector', '#configModel', reportLines, failures);
  }

  const toggle = page.locator('#collapseMobileListBtn').first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(400);
    await capture(page, `${viewport.name}-agent-list-open`, reportLines);
    await checkVisible(page, 'expanded agent list', '#agentListPanel.mobile-expanded', reportLines, failures);
  }

  if (failures.length) {
    reportLines.push('\n### Failures');
    failures.forEach((failure) => reportLines.push(`- ${failure}`));
    allFailures.push(...failures.map((failure) => `${viewport.name}: ${failure}`));
  } else {
    reportLines.push('\n### Result');
    reportLines.push('- PASS: required mobile controls are visible in this viewport.');
  }

  await context.close();
}

async function main() {
  if (CLEANUP_ONLY) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    console.log(`Removed ${OUT_DIR}`);
    return;
  }

  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch (error) {
    throw new Error([
      'Missing @playwright/test. Run `npm install` and `npx playwright install chromium`,',
      'then retry `npm run test:e2e:mobile-visibility-audit`.',
      `Original error: ${error.message}`,
    ].join(' '));
  }

  ensureCleanDir();
  const reportLines = [
    '# Mobile Dashboard Visibility Audit',
    '',
    `Base URL: ${BASE_URL}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Expected visible elements:',
    '- Dashboard root and mobile agent-list toggle.',
    '- After selecting an agent: message textarea, model/provider button, stop button, and send button.',
    '- After opening model settings: provider selector and model selector.',
    '- Expanded paper/agent list should be visible without hiding the composer controls.',
  ];
  const failures = [];
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      await runViewport(browser, viewport, reportLines, failures);
    }
  } finally {
    await browser.close();
  }

  reportLines.push('\n## Recommendations For Agents');
  if (failures.length) {
    reportLines.push('- Inspect the failing screenshots first, then compare the reported rectangles against the viewport height.');
    reportLines.push('- Prefer reducing mobile chrome height or making action controls sticky before increasing global z-indexes.');
    reportLines.push('- Re-run this audit after each CSS/JS change until all required controls pass.');
  } else {
    reportLines.push('- No required-control visibility failures were detected.');
    reportLines.push('- Review screenshots for visual polish: cramped spacing, clipped text, or provider sheet overlap.');
  }
  reportLines.push('- Clean artifacts with `node tests/e2e/mobile-dashboard-visibility-audit.js --cleanup-only`.');

  const reportPath = writeReport(reportLines);
  console.log(`Report written to ${reportPath}`);
  if (!KEEP_ARTIFACTS) {
    console.log('Artifacts kept for review. Pass --cleanup-only after reviewing to remove them.');
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
