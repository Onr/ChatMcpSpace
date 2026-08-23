const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test3@gmail.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';

const VIEWPORTS = [
  { name: 'desktop_1280', width: 1280, height: 900 },
  { name: 'desktop_1440', width: 1440, height: 900 },
  { name: 'desktop_1920', width: 1920, height: 1080 }
];

const PANEL_COUNTS = [1, 2, 3, 4, 5];
const MIN_TILE_WIDTH = 340;
const COUNCIL_MAX_WIDTH_EXPECTED = 900;
const NAV_TIMEOUT_MS = Number(process.env.UI_TEST_TIMEOUT_MS || 15000);

function tsStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function login(page) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  if (page.url().includes('/dashboard')) {
    await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });
    return;
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('#loginEmail', { timeout: NAV_TIMEOUT_MS });
  await page.fill('#loginEmail', TEST_EMAIL);
  await page.fill('#loginPassword', TEST_PASSWORD);
  await page.click('#loginTab');
  await page.waitForURL('**/dashboard**', { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });
}

async function getAgents(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const agents = [];
    const elements = Array.from(document.querySelectorAll('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]'));

    for (const el of elements) {
      const agentId = el.getAttribute('data-agent-id');
      if (!agentId || seen.has(agentId)) continue;
      seen.add(agentId);

      const agentName = el.getAttribute('data-agent-name')
        || el.querySelector('.agent-list-item__name')?.textContent?.trim()
        || el.querySelector('.agent-name')?.textContent?.trim()
        || agentId;
      const externalProvider = el.getAttribute('data-agent-external-provider') || '';

      agents.push({
        agentId,
        agentName,
        metadata: { externalProvider }
      });
    }

    return agents;
  });
}

async function getUserApiKey(page) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('#apiKeyInput', { timeout: NAV_TIMEOUT_MS });
  return page.evaluate(() => {
    const input = document.getElementById('apiKeyInput');
    return input?.dataset?.realKey || '';
  });
}

async function seedAgentViaApi(page, apiKey, agentName) {
  return page.evaluate(async ({ apiKeyValue, name }) => {
    const response = await fetch('/api/agent/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKeyValue
      },
      body: JSON.stringify({
        agentName: name,
        content: `UI layout test seed for ${name}`,
        priority: 0
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`seed failed (${response.status}): ${body.slice(0, 180)}`);
    }

    return true;
  }, { apiKeyValue: apiKey, name: agentName });
}

async function ensureAgentPool(page, minAgents) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });

  let agents = await getAgents(page);
  if (agents.length >= minAgents) return agents;

  const apiKey = await getUserApiKey(page);
  if (!apiKey) {
    throw new Error('Unable to read API key from settings page for seeding missing agents.');
  }

  const missing = minAgents - agents.length;
  const suffix = Date.now();
  for (let i = 0; i < missing; i += 1) {
    await seedAgentViaApi(page, apiKey, `UI-LAYOUT-${suffix}-${i + 1}`);
  }

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(4000);
  agents = await getAgents(page);

  if (agents.length < minAgents) {
    throw new Error(`Need at least ${minAgents} agents; found ${agents.length} after seeding.`);
  }

  return agents;
}

async function clearOpenPanels(page) {
  await page.evaluate(() => {
    const closeButtons = Array.from(document.querySelectorAll('.chat-tile__close-btn'));
    closeButtons.forEach((btn) => btn.click());
  });
  await page.waitForTimeout(350);
}

async function openPanels(page, agents, count) {
  await page.evaluate(({ selectedAgents }) => {
    if (!window.MultiChatManager || typeof window.MultiChatManager.openSidePanel !== 'function') {
      throw new Error('window.MultiChatManager.openSidePanel is unavailable');
    }
    for (const agent of selectedAgents) {
      window.MultiChatManager.openSidePanel(agent.agentId, agent.agentName, agent.metadata || {});
    }
  }, { selectedAgents: agents.slice(0, count) });
  await page.waitForTimeout(650);
}

async function collectLayoutMetrics(page) {
  return page.evaluate(() => {
    const chamberEl = document.querySelector('.council-chamber');
    const container = document.getElementById('multiChatContainer');
    const tiles = Array.from(document.querySelectorAll('#multiChatContainer .chat-tile'));

    const chamberWidth = chamberEl ? Math.round(chamberEl.getBoundingClientRect().width) : 0;
    const containerRect = container ? container.getBoundingClientRect() : null;
    // Use layout widths/tops (offset*) so transient transform animations do not skew metrics.
    const tileWidths = tiles.map((tile) => tile.offsetWidth);
    const tileTops = tiles.map((tile) => tile.offsetTop);
    const topSpread = tileTops.length ? Math.max(...tileTops) - Math.min(...tileTops) : 0;
    const panelsSideBySide = topSpread <= 4;

    return {
      chamberWidth,
      panelCount: tiles.length,
      tileWidths,
      minTileWidth: tileWidths.length ? Math.min(...tileWidths) : 0,
      maxTileWidth: tileWidths.length ? Math.max(...tileWidths) : 0,
      avgTileWidth: tileWidths.length ? Math.round(tileWidths.reduce((a, b) => a + b, 0) / tileWidths.length) : 0,
      panelsSideBySide,
      hasHorizontalScroll: !!(container && container.scrollWidth > container.clientWidth + 1),
      containerClientWidth: container ? Math.round(container.clientWidth) : 0,
      containerScrollWidth: container ? Math.round(container.scrollWidth) : 0,
      containerRight: containerRect ? Math.round(containerRect.right) : 0
    };
  });
}

function runViewportChecks(scenarios) {
  const checks = [];

  const councilCapped = scenarios.every((s) => s.metrics.chamberWidth > 0 && s.metrics.chamberWidth <= COUNCIL_MAX_WIDTH_EXPECTED);
  checks.push({
    name: 'Council chamber width is capped',
    passed: councilCapped,
    details: scenarios.map((s) => `count=${s.count}: ${s.metrics.chamberWidth}px`).join(' | ')
  });

  const sideBySide = scenarios.every((s) => s.metrics.panelsSideBySide);
  checks.push({
    name: 'Panels remain side-by-side',
    passed: sideBySide,
    details: scenarios.map((s) => `count=${s.count}: ${s.metrics.panelsSideBySide}`).join(' | ')
  });

  const minWidthRespected = scenarios.every((s) => s.metrics.tileWidths.every((w) => w >= MIN_TILE_WIDTH - 2));
  checks.push({
    name: 'Tiles do not shrink below minimum width',
    passed: minWidthRespected,
    details: scenarios.map((s) => `count=${s.count}: [${s.metrics.tileWidths.join(', ')}]`).join(' | ')
  });

  let shrinkingOk = true;
  for (let i = 1; i < scenarios.length; i += 1) {
    const prev = scenarios[i - 1].metrics.avgTileWidth;
    const curr = scenarios[i].metrics.avgTileWidth;
    if (curr > prev + 2) {
      shrinkingOk = false;
      break;
    }
  }
  checks.push({
    name: 'Tile widths shrink as panel count increases',
    passed: shrinkingOk,
    details: scenarios.map((s) => `count=${s.count}: avg=${s.metrics.avgTileWidth}px`).join(' | ')
  });

  const firstAtMin = scenarios.find((s) => s.metrics.minTileWidth <= MIN_TILE_WIDTH + 2);
  let overflowAfterMin = true;
  let overflowDetails = 'minimum width not reached in this viewport';

  if (firstAtMin) {
    const subsequent = scenarios.filter((s) => s.count > firstAtMin.count);
    overflowAfterMin = subsequent.length === 0 || subsequent.some((s) => s.metrics.hasHorizontalScroll);
    overflowDetails = `first min at count=${firstAtMin.count}; later overflow=${subsequent.map((s) => `${s.count}:${s.metrics.hasHorizontalScroll}`).join(', ') || 'n/a'}`;
  }

  checks.push({
    name: 'Horizontal scroll appears after minimum width is reached',
    passed: overflowAfterMin,
    details: overflowDetails
  });

  return checks;
}

async function runViewportScenario(page, viewport, outDir, agents) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(700);
  await page.addStyleTag({
    content: '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;}'
  });

  const maxCount = Math.min(PANEL_COUNTS[PANEL_COUNTS.length - 1], agents.length);
  const counts = PANEL_COUNTS.filter((n) => n <= maxCount);
  const scenarios = [];

  for (const count of counts) {
    await clearOpenPanels(page);
    await openPanels(page, agents, count);
    await page.waitForTimeout(250);
    const metrics = await collectLayoutMetrics(page);

    const screenshotPath = path.join(outDir, `${viewport.name}_panels_${count}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' });

    scenarios.push({
      count,
      screenshot: screenshotPath,
      metrics
    });
  }

  await clearOpenPanels(page);
  return {
    viewport,
    scenarios,
    checks: runViewportChecks(scenarios)
  };
}

async function main() {
  const stamp = tsStamp();
  const outDir = path.join('tests', 'test-results', `multi-chat-responsive-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.route('**/fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**/fonts.gstatic.com/**', (route) => route.abort());

  const result = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    outputDir: outDir,
    viewports: [],
    summary: {
      passed: 0,
      failed: 0,
      totalChecks: 0
    }
  };

  try {
    await login(page);
    const agents = await ensureAgentPool(page, Math.max(...PANEL_COUNTS));

    for (const viewport of VIEWPORTS) {
      const viewportResult = await runViewportScenario(page, viewport, outDir, agents);
      result.viewports.push(viewportResult);
    }

    const allChecks = result.viewports.flatMap((v) => v.checks);
    result.summary.totalChecks = allChecks.length;
    result.summary.passed = allChecks.filter((c) => c.passed).length;
    result.summary.failed = allChecks.filter((c) => !c.passed).length;
    result.completedAt = new Date().toISOString();
  } catch (error) {
    result.error = error.message;
    result.completedAt = new Date().toISOString();
  } finally {
    await browser.close();
  }

  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(JSON.stringify({
    reportPath,
    outputDir: outDir,
    summary: result.summary,
    error: result.error || null
  }, null, 2));

  if (result.error || result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Fatal test failure:', error);
  process.exit(1);
});
