#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:3000';
const LOGIN_EMAIL = process.env.DEMO_EMAIL || 'test3@gmail.com';
const LOGIN_PASSWORD = process.env.DEMO_PASSWORD || 'TestPassword123!';
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'demo-videos');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function weatherPayload() {
  return {
    type: 'rich_html',
    badge: 'Weather',
    title: 'Weather Report: Haifa & Beersheba',
    description: 'Interactive weather view with current conditions, comparison, and forecast.',
    css: `
      .wx-root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#dbeafe}
      .wx-tabs{display:flex;gap:8px;margin:10px 0 14px}
      .wx-tab{border:1px solid rgba(125,211,252,.35);background:#0f1f44;color:#bfdbfe;padding:8px 12px;border-radius:10px;font-weight:600;cursor:pointer}
      .wx-tab.rich-tab-active{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-color:transparent}
      .wx-pan{border:1px solid rgba(148,163,184,.25);border-radius:12px;background:rgba(15,23,42,.65);padding:12px}
      .wx-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .wx-card{border-radius:12px;padding:12px;background:linear-gradient(135deg,rgba(99,102,241,.75),rgba(124,58,237,.68));color:#eef2ff}
      .wx-city{font-size:26px;font-weight:800;margin-bottom:6px}
      .wx-temp{font-size:48px;font-weight:900;margin:2px 0 8px}
      .wx-row{display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.2);padding:7px 0;font-size:18px}
      .wx-table{width:100%;border-collapse:collapse}
      .wx-table th,.wx-table td{border:1px solid rgba(148,163,184,.25);padding:8px 10px;text-align:left}
      .wx-table th{background:rgba(51,65,85,.75);font-weight:700}
      .wx-green{color:#10b981;font-weight:700}
      .wx-red{color:#f87171;font-weight:700}
      .wx-forecast{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
      .wx-day{background:#e2e8f0;color:#0f172a;border-radius:12px;padding:12px;text-align:center;font-weight:700}
      .wx-btn{margin-top:12px;width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(56,189,248,.45);background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#ecfeff;font-weight:700;cursor:pointer}
      .rich-hidden{display:none !important}
    `,
    html: `
      <div class="wx-root">
        <div class="wx-tabs">
          <button class="wx-tab rich-tab-active" data-tab="wx-current" data-tab-group="wx">Current Weather</button>
          <button class="wx-tab" data-tab="wx-compare" data-tab-group="wx">Comparison</button>
          <button class="wx-tab" data-tab="wx-forecast" data-tab-group="wx">Extended Forecast</button>
        </div>

        <div id="wx-current" class="wx-pan rich-visible">
          <div class="wx-grid">
            <div class="wx-card">
              <div class="wx-city">Haifa</div>
              <div class="wx-temp">12°C</div>
              <div class="wx-row"><span>Condition</span><span>Patchy rain nearby</span></div>
              <div class="wx-row"><span>Wind</span><span>19 km/h NW</span></div>
              <div class="wx-row"><span>Humidity</span><span>51%</span></div>
              <div class="wx-row"><span>Feels Like</span><span>9°C</span></div>
            </div>
            <div class="wx-card">
              <div class="wx-city">Beersheba</div>
              <div class="wx-temp">10°C</div>
              <div class="wx-row"><span>Condition</span><span>Overcast</span></div>
              <div class="wx-row"><span>Wind</span><span>10 km/h NE</span></div>
              <div class="wx-row"><span>Humidity</span><span>96%</span></div>
              <div class="wx-row"><span>Feels Like</span><span>9°C</span></div>
            </div>
          </div>
        </div>

        <div id="wx-compare" class="wx-pan rich-hidden">
          <table class="wx-table">
            <thead><tr><th>Metric</th><th>Haifa</th><th>Beersheba</th><th>Difference</th></tr></thead>
            <tbody>
              <tr><td>Temperature</td><td>12°C</td><td>10°C</td><td class="wx-green">-2°C</td></tr>
              <tr><td>Humidity</td><td>51%</td><td>96%</td><td class="wx-red">+45%</td></tr>
              <tr><td>Wind Speed</td><td>19 km/h</td><td>10 km/h</td><td class="wx-green">-9 km/h</td></tr>
              <tr><td>Visibility</td><td>10 km</td><td>16 km</td><td class="wx-red">+6 km</td></tr>
            </tbody>
          </table>
        </div>

        <div id="wx-forecast" class="wx-pan rich-hidden">
          <div class="wx-forecast">
            <div class="wx-day">Tomorrow<br>13° / 11°<br>Sunny</div>
            <div class="wx-day">Day 2<br>13° / 10°<br>Patchy rain</div>
            <div class="wx-day">Day 3<br>14° / 10°<br>Patchy rain</div>
          </div>
        </div>

        <button class="wx-btn" data-send-message="Refresh weather data for Haifa and Beersheba with hourly breakdown.">Refresh Weather Data</button>
      </div>
    `
  };
}

function marketGeoPayload() {
  return {
    type: 'rich_html',
    badge: 'Market & Geo',
    title: 'Market + News + Geo Pulse',
    description: 'One panel combining live-looking market deltas, location risk, and breaking headlines.',
    css: `
      .mk-root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e2e8f0}
      .mk-tabs{display:flex;gap:8px;margin:8px 0 12px}
      .mk-tab{padding:7px 11px;border-radius:9px;background:#12243f;border:1px solid rgba(59,130,246,.35);color:#bfdbfe;font-weight:600;cursor:pointer}
      .mk-tab.rich-tab-active{background:linear-gradient(135deg,#0891b2,#2563eb);color:#fff;border-color:transparent}
      .mk-pan{border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(15,23,42,.65);padding:12px}
      .mk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .mk-card{border-radius:10px;padding:10px;background:linear-gradient(135deg,rgba(30,41,59,.95),rgba(15,23,42,.95));border:1px solid rgba(148,163,184,.25)}
      .mk-ticker{font-size:12px;color:#93c5fd;text-transform:uppercase;font-weight:700}
      .mk-price{font-size:26px;font-weight:900;margin:4px 0}
      .mk-up{color:#10b981;font-weight:700}
      .mk-down{color:#f87171;font-weight:700}
      .mk-news{display:flex;flex-direction:column;gap:8px}
      .mk-item{padding:9px;border-radius:9px;background:rgba(30,41,59,.85);border:1px solid rgba(148,163,184,.2)}
      .mk-item strong{display:block;color:#e0f2fe;font-size:13px}
      .mk-item span{color:#94a3b8;font-size:12px}
      .mk-locs{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .mk-loc{border-radius:10px;padding:10px;background:linear-gradient(135deg,rgba(6,78,59,.35),rgba(15,23,42,.85));border:1px solid rgba(45,212,191,.3)}
      .mk-loc h4{margin:0 0 5px;font-size:14px;color:#99f6e4}
      .mk-actions{display:flex;gap:8px;margin-top:10px}
      .mk-btn{flex:1;padding:9px 10px;border-radius:9px;background:linear-gradient(135deg,#1d4ed8,#2563eb);border:1px solid rgba(125,211,252,.35);color:#ecfeff;font-weight:700;cursor:pointer}
      .rich-hidden{display:none !important}
    `,
    html: `
      <div class="mk-root">
        <div class="mk-tabs">
          <button class="mk-tab rich-tab-active" data-tab="mk-overview" data-tab-group="mk">Overview</button>
          <button class="mk-tab" data-tab="mk-news" data-tab-group="mk">News</button>
          <button class="mk-tab" data-tab="mk-geo" data-tab-group="mk">Geo</button>
        </div>

        <div id="mk-overview" class="mk-pan rich-visible">
          <div class="mk-grid">
            <div class="mk-card"><div class="mk-ticker">AAPL</div><div class="mk-price">$219.14</div><div class="mk-up">+1.44%</div></div>
            <div class="mk-card"><div class="mk-ticker">NVDA</div><div class="mk-price">$941.77</div><div class="mk-up">+2.91%</div></div>
            <div class="mk-card"><div class="mk-ticker">BTC</div><div class="mk-price">$71,220</div><div class="mk-down">-0.63%</div></div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn" data-send-message="Prepare a risk-aware market summary with hedging options.">Generate Market Brief</button>
            <button class="mk-btn" data-tab="mk-news" data-tab-group="mk">Open News</button>
          </div>
        </div>

        <div id="mk-news" class="mk-pan rich-hidden">
          <div class="mk-news">
            <div class="mk-item"><strong>Fed guidance nudges tech higher</strong><span>Impact: Growth assets strengthen, volatility moderate.</span></div>
            <div class="mk-item"><strong>Cloud earnings beat estimates</strong><span>Impact: AI infra names outperform broad market.</span></div>
            <div class="mk-item"><strong>Shipping delays in Red Sea corridor</strong><span>Impact: Watch energy/logistics spreads and inflation sensitivity.</span></div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn" data-send-message="Create a 3-scenario watchlist from these headlines.">Turn Into Watchlist</button>
            <button class="mk-btn" data-tab="mk-geo" data-tab-group="mk">Open Geo Risk</button>
          </div>
        </div>

        <div id="mk-geo" class="mk-pan rich-hidden">
          <div class="mk-locs">
            <div class="mk-loc"><h4>Haifa Port</h4><div>Lat/Lon: 32.7940, 34.9896</div><div>Risk: Medium</div><div>Lead-time: +1.2 days</div></div>
            <div class="mk-loc"><h4>Rotterdam Hub</h4><div>Lat/Lon: 51.9244, 4.4777</div><div>Risk: Low</div><div>Lead-time: +0.3 days</div></div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn" data-send-message="Recommend routing changes based on current geo risk.">Route Recommendation</button>
            <button class="mk-btn" data-tab="mk-overview" data-tab-group="mk">Back To Overview</button>
          </div>
        </div>
      </div>
    `
  };
}

async function moveMouseToSelector(page, selector, opts = {}) {
  const steps = opts.steps || 48;
  const settleMs = opts.settleMs || 120;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error('Missing bounding box');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps });
      await page.waitForTimeout(settleMs);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await page.waitForTimeout(140);
    }
  }
}

async function clickWithPause(page, pauseMs = 110) {
  await page.mouse.down();
  await page.waitForTimeout(Math.max(70, pauseMs));
  await page.mouse.up();
}

async function ensureLoggedIn(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  if (page.url().includes('/dashboard')) {
    await page.waitForSelector('#dashboardRoot', { timeout: 20000 });
    return;
  }

  await page.waitForSelector('#loginEmail', { timeout: 20000 });
  await page.fill('#loginEmail', LOGIN_EMAIL);
  await page.fill('#loginPassword', LOGIN_PASSWORD);
  await page.keyboard.press('Enter');

  await page.waitForURL('**/dashboard**', { timeout: 45000 });
  await page.waitForSelector('#dashboardRoot', { timeout: 20000 });
}

async function getAgentTriplet(page) {
  const triplet = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.agent-list-item[data-agent-id]')]
      .filter((el) => el.offsetParent !== null)
      .slice(0, 3)
      .map((el) => ({
        id: el.getAttribute('data-agent-id'),
        name: el.getAttribute('data-agent-name') || 'Agent'
      }));
    return rows;
  });

  if (!Array.isArray(triplet) || triplet.length < 3) {
    throw new Error('Need at least 3 visible agents in the list to demonstrate multichat.');
  }

  return triplet;
}

async function injectRichPanels(page, mainAgentId, tileAId, tileBId) {
  const wx = weatherPayload();
  const mk = marketGeoPayload();
  const geo = {
    ...marketGeoPayload(),
    title: 'Ops Geo Routing Board',
    badge: 'Geo Ops'
  };

  await page.evaluate(({ wx, mk, geo, mainAgentId, tileAId, tileBId }) => {
    const renderPayloadInto = (contentEl, titleEl, chevronEl, payload) => {
      if (!contentEl || !window.RichRendering?.renderRichContent) return false;

      contentEl.innerHTML = '';
      const rendered = window.RichRendering.renderRichContent(payload, window.RichRendering.sendFormResponse);
      contentEl.appendChild(rendered);
      contentEl.classList.remove('hidden');
      if (chevronEl) chevronEl.classList.add('rotate-180');
      if (titleEl) titleEl.textContent = payload.title || payload.badge || 'Agent Space';
      return true;
    };

    // Main panel
    if (window._lastSelectedAgentId !== mainAgentId) {
      const item = document.querySelector(`.agent-list-item[data-agent-id="${CSS.escape(mainAgentId)}"]`) ||
        document.querySelector(`.agent-seat[data-agent-id="${CSS.escape(mainAgentId)}"]`);
      if (item) item.click();
    }

    const mainContent = document.getElementById('mainInteractiveContent');
    const mainTitle = document.getElementById('mainInteractiveTitle');
    const mainChevron = document.getElementById('mainInteractiveChevron');
    renderPayloadInto(mainContent, mainTitle, mainChevron, wx);

    // Side tiles
    const tileA = document.querySelector(`.chat-tile[data-agent-id="${CSS.escape(tileAId)}"]`);
    if (tileA) {
      const content = tileA.querySelector('.chat-tile__interactive-content');
      const title = tileA.querySelector('.chat-tile__interactive-title');
      const chev = tileA.querySelector('.chat-tile__interactive-chevron');
      renderPayloadInto(content, title, chev, mk);
    }

    const tileB = document.querySelector(`.chat-tile[data-agent-id="${CSS.escape(tileBId)}"]`);
    if (tileB) {
      const content = tileB.querySelector('.chat-tile__interactive-content');
      const title = tileB.querySelector('.chat-tile__interactive-title');
      const chev = tileB.querySelector('.chat-tile__interactive-chevron');
      renderPayloadInto(content, title, chev, geo);
    }
  }, { wx, mk, geo, mainAgentId, tileAId, tileBId });
}

function transcodeTo60Fps(inputWebm, outPrefix) {
  const outMp4 = `${outPrefix}-60fps.mp4`;
  const outWebm = `${outPrefix}-60fps.webm`;

  execSync(
    `ffmpeg -y -i "${inputWebm}" -vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${outMp4}"`,
    { stdio: 'ignore' }
  );

  execSync(
    `ffmpeg -y -i "${inputWebm}" -vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1" -c:v libvpx-vp9 -crf 32 -b:v 0 "${outWebm}"`,
    { stdio: 'ignore' }
  );

  return { outMp4, outWebm };
}

async function main() {
  ensureDir(OUTPUT_DIR);

  const runId = timestamp();
  const recordingDir = path.join(OUTPUT_DIR, `raw-${runId}`);
  ensureDir(recordingDir);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: recordingDir,
      size: { width: 1920, height: 1080 }
    }
  });

  const page = await context.newPage();
  const video = page.video();

  try {
    await ensureLoggedIn(page);
    await page.waitForTimeout(1400);

    const [mainAgent, tileA, tileB] = await getAgentTriplet(page);

    // Select main agent with smooth mouse motion.
    const mainItemSelector = `.agent-list-item[data-agent-id="${mainAgent.id}"]`;
    await moveMouseToSelector(page, mainItemSelector, { steps: 58, settleMs: 140 });
    await clickWithPause(page, 110);
    await page.waitForTimeout(700);

    // Open two multi-chat side panels (one for each additional agent).
    const pinASelector = `.agent-list-pin-btn[data-agent-id="${tileA.id}"]`;
    await moveMouseToSelector(page, pinASelector, { steps: 44, settleMs: 130 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(500);

    const pinBSelector = `.agent-list-pin-btn[data-agent-id="${tileB.id}"]`;
    await moveMouseToSelector(page, pinBSelector, { steps: 44, settleMs: 130 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(900);

    await page.waitForSelector(`.chat-tile[data-agent-id="${tileA.id}"]`, { timeout: 15000 });
    await page.waitForSelector(`.chat-tile[data-agent-id="${tileB.id}"]`, { timeout: 15000 });

    // Inject rich content payloads into all three Agent Spaces.
    await injectRichPanels(page, mainAgent.id, tileA.id, tileB.id);
    await page.waitForTimeout(900);

    // Main weather interactions.
    await moveMouseToSelector(page, '#mainInteractiveContent [data-tab="wx-compare"]', { steps: 38, settleMs: 120 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(600);

    await moveMouseToSelector(page, '#mainInteractiveContent [data-tab="wx-forecast"]', { steps: 38, settleMs: 120 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(700);

    // Interact with first side tile market/news/geo tabs.
    await moveMouseToSelector(page, `.chat-tile[data-agent-id="${tileA.id}"] .chat-tile__interactive-content [data-tab="mk-news"]`, { steps: 34, settleMs: 100 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(500);

    await moveMouseToSelector(page, `.chat-tile[data-agent-id="${tileA.id}"] .chat-tile__interactive-content [data-tab="mk-geo"]`, { steps: 34, settleMs: 100 });
    await clickWithPause(page, 100);
    await page.waitForTimeout(700);

    // Expand main Agent Space into popup and close to show depth.
    const mainExpand = page.locator('#mainInteractiveSizeBtn');
    await moveMouseToSelector(page, '#mainInteractiveSizeBtn', { steps: 40, settleMs: 120 });
    await clickWithPause(page, 100);
    await page.waitForSelector('.rich-content-popup-overlay', { timeout: 8000 });
    await page.waitForTimeout(750);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rich-content-popup-overlay', { state: 'detached', timeout: 8000 });

    // Smooth finale pan across both side chats and main panel.
    await page.mouse.move(300, 250, { steps: 70 });
    await page.waitForTimeout(260);
    await page.mouse.move(1100, 310, { steps: 70 });
    await page.waitForTimeout(260);
    await page.mouse.move(1650, 260, { steps: 70 });
    await page.waitForTimeout(1200);

    const rawOut = path.join(OUTPUT_DIR, `agent-space-multichat-rich-demo-${runId}.webm`);

    await context.close();
    await video.saveAs(rawOut);
    await browser.close();

    const { outMp4, outWebm } = transcodeTo60Fps(rawOut, path.join(OUTPUT_DIR, `agent-space-multichat-rich-demo-${runId}`));

    console.log(`RAW_VIDEO_PATH=${rawOut}`);
    console.log(`SMOOTH_MP4_PATH=${outMp4}`);
    console.log(`SMOOTH_WEBM_PATH=${outWebm}`);
    console.log(`RAW_VIDEO_SIZE_BYTES=${fs.statSync(rawOut).size}`);
    console.log(`SMOOTH_MP4_SIZE_BYTES=${fs.statSync(outMp4).size}`);
    console.log(`SMOOTH_WEBM_SIZE_BYTES=${fs.statSync(outWebm).size}`);
  } catch (error) {
    try {
      const errorShot = path.join(OUTPUT_DIR, `agent-space-multichat-rich-demo-error-${runId}.png`);
      await page.screenshot({ path: errorShot, fullPage: true, timeout: 20000 });
      console.error(`ERROR_SCREENSHOT=${errorShot}`);
    } catch (_) {
      // ignore
    }

    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error('Demo generation failed:', error.message);
  process.exit(1);
});
