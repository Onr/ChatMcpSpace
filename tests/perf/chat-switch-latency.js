const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test3@gmail.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';
const MAX_AGENTS = Number(process.env.PERF_MAX_AGENTS || 5);
const ROUNDS_PER_VIEWPORT = Number(process.env.PERF_ROUNDS || 2);
const NAV_TIMEOUT_MS = Number(process.env.PERF_TIMEOUT_MS || 12000);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];
const MIN_AGENTS_FOR_BENCHMARK = 3;

const OUT_DIR = path.join('tests', 'test-results');
fs.mkdirSync(OUT_DIR, { recursive: true });

function tsStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function summarize(samples) {
  const values = samples.map((s) => s.durationMs).filter((v) => Number.isFinite(v));
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    minMs: sorted.length ? sorted[0] : null,
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    avgMs: values.length ? sum / values.length : null,
    p50Ms: quantile(sorted, 0.5),
    p90Ms: quantile(sorted, 0.9),
    p95Ms: quantile(sorted, 0.95)
  };
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

  await page.waitForFunction(() => window.location.pathname.includes('/dashboard'), null, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });
}

async function getAgents(page) {
  const agents = await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('.agent-list-item[data-agent-id]'));
    const seen = new Set();
    const result = [];
    for (const el of list) {
      const agentId = el.getAttribute('data-agent-id');
      const agentName = el.getAttribute('data-agent-name') || el.querySelector('.agent-list-item__name')?.textContent?.trim() || 'Unknown';
      if (agentId && !seen.has(agentId)) {
        seen.add(agentId);
        result.push({ agentId, agentName });
      }
    }
    return result;
  });
  return agents.slice(0, MAX_AGENTS);
}

async function getUserApiKey(page) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('#apiKeyInput', { timeout: NAV_TIMEOUT_MS });

  const apiKey = await page.evaluate(() => {
    const input = document.getElementById('apiKeyInput');
    return input?.dataset?.realKey || '';
  });

  if (!apiKey) {
    throw new Error('Unable to read API key from settings page');
  }
  return apiKey;
}

async function seedAgentViaApi(page, apiKey, agentName) {
  const created = await page.evaluate(async ({ apiKeyValue, name }) => {
    const response = await fetch('/api/agent/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKeyValue
      },
      body: JSON.stringify({
        agentName: name,
        content: `Perf benchmark seed message from ${name}`,
        priority: 0
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`seed failed (${response.status}): ${body.slice(0, 180)}`);
    }

    return true;
  }, { apiKeyValue: apiKey, name: agentName });

  return created === true;
}

async function ensureAgentPool(page, minimumCount) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector('.agent-list-item[data-agent-id], .agent-seat[data-agent-id]', { state: 'attached', timeout: NAV_TIMEOUT_MS });

  let agents = await getAgents(page);
  if (agents.length >= minimumCount) {
    return agents;
  }

  const apiKey = await getUserApiKey(page);
  const missing = minimumCount - agents.length;
  const stamp = Date.now();

  for (let i = 0; i < missing; i += 1) {
    const agentName = `PerfBot-${stamp}-${i + 1}`;
    await seedAgentViaApi(page, apiKey, agentName);
  }

  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(4500);
  agents = await getAgents(page);

  if (agents.length < minimumCount) {
    throw new Error(`Need at least ${minimumCount} agents for switch benchmark, found ${agents.length} after seeding`); 
  }

  return agents;
}

async function selectAgentAndMeasure(page, agent) {
  const start = Date.now();
  await page.evaluate((targetId) => {
    const item = document.querySelector(`.agent-list-item[data-agent-id="${targetId}"]`) || document.querySelector(`.agent-seat[data-agent-id="${targetId}"]`);
    if (!item) throw new Error(`Agent not found: ${targetId}`);
    item.click();
  }, agent.agentId);

  await page.waitForFunction(() => {
    const area = document.getElementById('conversationArea');
    if (!area || area.classList.contains('hidden')) return false;

    const text = (area.textContent || '').trim();
    if (text.includes('Loading messages...')) return false;

    if (area.querySelector('.message-bubble')) return true;
    if (text.includes('No messages yet. Send a first instruction below.')) return true;
    if (text.includes('Failed to load messages') || text.includes('Error loading messages')) return true;

    return false;
  }, null, { timeout: NAV_TIMEOUT_MS });

  const durationMs = Date.now() - start;
  return { durationMs };
}

async function runViewport(context, viewport) {
  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  const result = {
    viewport,
    rounds: ROUNDS_PER_VIEWPORT,
    maxAgents: MAX_AGENTS,
    agents: [],
    samples: [],
    summary: null
  };

  await login(page);
  const minAgents = Math.min(Math.max(MIN_AGENTS_FOR_BENCHMARK, 2), MAX_AGENTS);
  const agents = await ensureAgentPool(page, minAgents);
  result.agents = agents;

  if (agents.length < 2) {
    throw new Error(`Need at least 2 agents for switch benchmark, found ${agents.length}`);
  }

  await selectAgentAndMeasure(page, agents[0]);

  for (let round = 1; round <= ROUNDS_PER_VIEWPORT; round += 1) {
    for (let i = 1; i < agents.length; i += 1) {
      const from = agents[i - 1];
      const to = agents[i];
      const measured = await selectAgentAndMeasure(page, to);
      result.samples.push({
        round,
        fromAgentId: from.agentId,
        fromAgentName: from.agentName,
        toAgentId: to.agentId,
        toAgentName: to.agentName,
        durationMs: measured.durationMs
      });
    }

    for (let i = agents.length - 2; i >= 0; i -= 1) {
      const from = agents[i + 1];
      const to = agents[i];
      const measured = await selectAgentAndMeasure(page, to);
      result.samples.push({
        round,
        fromAgentId: from.agentId,
        fromAgentName: from.agentName,
        toAgentId: to.agentId,
        toAgentName: to.agentName,
        durationMs: measured.durationMs
      });
    }
  }

  result.summary = summarize(result.samples);
  await page.close();
  return result;
}

function buildMarkdown(report, jsonPath) {
  const lines = [];
  lines.push('# Chat Switch Performance Report');
  lines.push('');
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- Base URL: ${report.baseUrl}`);
  lines.push(`- Login user: ${report.loginUser}`);
  lines.push(`- JSON data: \`${jsonPath}\``);
  lines.push('');

  if (report.error) {
    lines.push('## Status');
    lines.push('');
    lines.push(`- FAILED: ${report.error}`);
    lines.push('');
    return lines.join('\n');
  }

  for (const view of report.viewports) {
    lines.push(`## ${view.viewport.name} (${view.viewport.width}x${view.viewport.height})`);
    lines.push('');
    lines.push(`- Agents tested: ${view.agents.length}`);
    lines.push(`- Switch samples: ${view.summary.count}`);
    lines.push(`- Min: ${Math.round(view.summary.minMs)} ms`);
    lines.push(`- Avg: ${Math.round(view.summary.avgMs)} ms`);
    lines.push(`- P50: ${Math.round(view.summary.p50Ms)} ms`);
    lines.push(`- P90: ${Math.round(view.summary.p90Ms)} ms`);
    lines.push(`- P95: ${Math.round(view.summary.p95Ms)} ms`);
    lines.push(`- Max: ${Math.round(view.summary.maxMs)} ms`);
    lines.push('');
  }

  lines.push('## Re-run');
  lines.push('');
  lines.push('```bash');
  lines.push('node tests/perf/chat-switch-latency.js');
  lines.push('```');
  lines.push('');
  lines.push('Optional overrides:');
  lines.push('```bash');
  lines.push('BASE_URL=http://localhost:3000 TEST_EMAIL=test3@gmail.com TEST_PASSWORD=TestPassword123! PERF_ROUNDS=3 PERF_MAX_AGENTS=6 node tests/perf/chat-switch-latency.js');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

(async () => {
  const stamp = tsStamp();
  const jsonPath = path.join(OUT_DIR, `chat_switch_latency_${stamp}.json`);
  const mdPath = path.join('docs', `CHAT_SWITCH_PERF_REPORT_${stamp}.md`);

  const report = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    loginUser: TEST_EMAIL,
    roundsPerViewport: ROUNDS_PER_VIEWPORT,
    maxAgents: MAX_AGENTS,
    viewports: [],
    error: null
  };

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext();
      const viewResult = await runViewport(context, viewport);
      report.viewports.push(viewResult);
      await context.close();
    }
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    await browser.close();
  }

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync(mdPath, buildMarkdown(report, jsonPath));

  if (report.error) {
    console.error(`Performance benchmark failed: ${report.error}`);
    console.error(`Partial report: ${jsonPath}`);
    console.error(`Markdown report: ${mdPath}`);
    process.exit(1);
  }

  console.log('Chat switch latency benchmark completed.');
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);

  report.viewports.forEach((view) => {
    console.log(`\\n${view.viewport.name} (${view.viewport.width}x${view.viewport.height})`);
    console.log(`  samples=${view.summary.count} min=${Math.round(view.summary.minMs)}ms avg=${Math.round(view.summary.avgMs)}ms p95=${Math.round(view.summary.p95Ms)}ms max=${Math.round(view.summary.maxMs)}ms`);
  });
})();
