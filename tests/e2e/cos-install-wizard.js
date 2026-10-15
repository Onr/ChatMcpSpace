/**
 * E2E test for the Chief of Staff install modal.
 *
 * What it verifies:
 *   1. Modal renders hidden by default.
 *   2. On a fresh user (status.installed = false), the auto-show logic opens it.
 *   3. The primary "install on your computer" path shows both terminal commands,
 *      filled in from `status.setup` so the URL matches the serving host.
 *   4. The server-host install lives behind the advanced disclosure, and its
 *      submit button POSTs to /api/user/install-chief-of-staff with
 *      { confirm:true, userPassword }.
 *   5. On a 201 success response, the bootstrap command is rendered inside
 *      `#cosInstallBootstrap` and `#cosInstallSuccess` becomes visible.
 *   6. The "Maybe later" dismiss persists `cos_modal_dismissed_at` in localStorage.
 *
 * Run:
 *   node tests/e2e/cos-install-wizard.js
 *
 * Output:
 *   tests/test-results/cos-install-wizard-<timestamp>/
 *     - 01_initial.png
 *     - 02_after_submit.png
 *     - 03_after_dismiss.png
 *     - report.json
 */

const { chromium } = require('playwright');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const MODAL_EJS = path.join(ROOT, 'views', 'partials', 'cos-install-modal.ejs');
const INSTALL_JS = path.join(ROOT, 'public', 'js', 'cos-install.js');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const OUT_DIR = path.join(ROOT, 'tests', 'test-results', `cos-install-wizard-${timestamp()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const checks = [];
function record(name, pass, details = '') {
  checks.push({ name, pass, details });
  console.log(`${pass ? '✓' : '✗'} ${name}${details ? ' — ' + details : ''}`);
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
}

(async () => {
  const modalHtml = ejs.render(fs.readFileSync(MODAL_EJS, 'utf8'));
  const installJs = fs.readFileSync(INSTALL_JS, 'utf8');

  // Tiny local HTTP server so the page URL resolves and fetch() works.
  let installResponse = {
    success: true,
    agent: { agentId: 'cos-uuid', agentName: 'Chief of Staff', isChiefOfStaff: true },
    bootstrap: {
      command: 'cd /home/ubuntu/projects/AgentsMCPspace/chatspace/chief-of-staff && tmux new-session -d -s "chief-of-staff" "./agent-runner.sh" && tmux attach -t "chief-of-staff"',
      agentDir: '/home/ubuntu/projects/AgentsMCPspace/chatspace/chief-of-staff',
      tmuxSessionName: 'chief-of-staff',
      notes: []
    }
  };

  const pageBody = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body { background: #020617; color: #e2e8f0; font-family: sans-serif; }
    .hidden { display: none !important; }
    .fixed { position: fixed; }
    .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
    .min-h-screen { min-height: 100vh; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .justify-center { justify-content: center; }
    .flex-col { flex-direction: column; }
    .max-w-2xl { max-width: 42rem; }
    .w-full { width: 100%; }
    .relative { position: relative; }
    .bg-slate-900 { background-color: #0f172a; }
    .bg-slate-950 { background-color: #020617; }
    .rounded-2xl, .rounded-xl, .rounded-lg { border-radius: 8px; }
    .px-6, .px-3, .px-4 { padding-left: 16px; padding-right: 16px; }
    .py-5, .py-3, .py-2, .py-4 { padding-top: 8px; padding-bottom: 8px; }
    .gap-3, .gap-4, .gap-2 { gap: 8px; }
    .text-sm, .text-xs, .text-\[11px\] { font-size: 12px; }
    button { padding: 8px 16px; cursor: pointer; }
    input { padding: 8px; color: black; }
    pre { white-space: pre-wrap; word-break: break-all; }
  </style></head>
  <body><div id="cosFirstRunRoot" hidden></div>${modalHtml}
  <script>window.csrfToken = 'test-csrf';</script>
  <script>${installJs}</script>
  </body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pageBody);
    } else if (req.url === '/api/user/install-chief-of-staff/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        installed: false,
        setup: {
          setupCommand: 'curl -sL https://example.test/setup | bash',
          localCosCommand: 'bash agent-cli.sh --local-cos',
          apiKeyUrl: 'https://example.test/settings'
        }
      }));
    } else if (req.url === '/api/user/install-chief-of-staff' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (!json || json.confirm !== true || !json.userPassword) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'bad request' } }));
            return;
          }
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(installResponse));
        } catch (e) {
          res.writeHead(500); res.end();
        }
      });
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  const context = await browser.newContext({
    // Tall on purpose: this harness page ships only a stub stylesheet, so the
    // modal cannot scroll the way it does under Tailwind. Everything has to fit
    // on screen for clicks to land.
    viewport: { width: 900, height: 1800 }
  });
  const page = await context.newPage();
  page.on('console', (msg) => console.log(`[page:${msg.type()}]`, msg.text()));
  page.on('pageerror', (err) => console.log(`[page:error]`, err.message));
  await page.goto(baseUrl + '/', { waitUntil: 'load' });

  // Endpoints are served by the local http server above.

  // The page already loaded above. Give the JS a tick to call /status and open
  // the modal.
  await page.waitForTimeout(300);

  // ── 1. Modal exists in the DOM ─────────────────────────────────────────
  const modalExists = await page.$('#cosInstallModal');
  record('Modal node renders in the DOM', Boolean(modalExists));

  // ── 2. Auto-show fired (because status.installed = false and no dismissed flag)
  const isVisible = await page.isVisible('#cosInstallModal');
  record('Modal is auto-opened on first run', isVisible);

  await shoot(page, '01_initial');

  // ── 3. Primary path: the two terminal commands, resolved from status.setup ──
  const setupCmd = await page.textContent('#cosSetupCommand');
  record('Setup (download CLI) command is shown', setupCmd === 'curl -sL https://example.test/setup | bash', setupCmd);

  const localCosCmd = await page.textContent('#cosLocalCosCommand');
  record('--local-cos install command is shown', localCosCmd === 'bash agent-cli.sh --local-cos', localCosCmd);

  const apiKeyHref = await page.getAttribute('#cosApiKeyLink', 'href');
  record('API key link points at settings', apiKeyHref === 'https://example.test/settings', apiKeyHref);

  // Both commands are readable without expanding anything.
  record('Both commands are visible without interaction',
    (await page.isVisible('#cosSetupCommand')) && (await page.isVisible('#cosLocalCosCommand')));

  // ── 4. Server-host install sits behind the advanced disclosure ─────────
  const pwdHiddenWhileCollapsed = !(await page.isVisible('#cosInstallPassword'));
  record('Server-host form is collapsed by default', pwdHiddenWhileCollapsed);

  // force: same reason the submit click below uses it — this harness page has
  // no Tailwind, so the modal renders taller than the viewport.
  await page.locator('#cosServerInstallDetails summary').click({ force: true });
  await page.waitForSelector('#cosInstallPassword', { state: 'visible', timeout: 5000 });

  // ── 5. Fill password + submit ──────────────────────────────────────────
  await page.fill('#cosInstallPassword', 'test-password');
  await page.locator('#cosInstallSubmit').scrollIntoViewIfNeeded();
  await page.click('#cosInstallSubmit', { force: true });
  await page.waitForSelector('#cosInstallSuccess:not(.hidden)', { timeout: 5000 });

  const bootstrapText = await page.textContent('#cosInstallBootstrap');
  record('Bootstrap command was rendered', Boolean(bootstrapText) && bootstrapText.includes('tmux'),
    bootstrapText ? bootstrapText.slice(0, 80) + '…' : '');

  const submitDisabled = await page.isDisabled('#cosInstallSubmit');
  record('Submit button disabled after install', submitDisabled);

  await shoot(page, '02_after_submit');

  // ── 6. Reload the page to test the dismiss flow ────────────────────────
  await page.evaluate(() => localStorage.removeItem('cos_modal_dismissed_at'));
  await page.goto(baseUrl + '/?reload=1', { waitUntil: 'load' });
  await page.waitForTimeout(300);

  // Find the "Maybe later" button specifically (the modal has 3 dismiss handles:
  // backdrop, close-X icon, and the Maybe-later footer button — we want the last).
  const maybeLater = page.locator('button[data-cos-dismiss]:has-text("Maybe later")').first();
  if (await maybeLater.count() > 0) {
    await maybeLater.click({ force: true });
    await page.waitForTimeout(200);
    const stillVisible = await page.isVisible('#cosInstallModal');
    record('Maybe-later closes the modal', !stillVisible);
    const dismissedAt = await page.evaluate(() => localStorage.getItem('cos_modal_dismissed_at'));
    record('Maybe-later persists dismissed timestamp', Boolean(dismissedAt));
  } else {
    record('Dismiss button found', false, 'no Maybe-later button');
  }
  await shoot(page, '03_after_dismiss');

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  const pass = checks.every((c) => c.pass);
  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({ pass, checks }, null, 2)
  );

  console.log(`\nResults written to ${OUT_DIR}`);
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('E2E script crashed:', err);
  process.exit(2);
});
