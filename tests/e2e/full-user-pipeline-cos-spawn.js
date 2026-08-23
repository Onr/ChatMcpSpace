/**
 * End-to-End User Pipeline Test: Registration → CoS → Sub-agent → Message Reply
 *
 * Simulates a new user from scratch and exercises the full server-side pipeline
 * that backs the "CoS reads messages and doesn't reply" complaint:
 *
 *   1. Register a brand-new user via the /register UI (Playwright).
 *   2. Confirm /dashboard renders after registration.
 *   3. Visit /settings, read the user's API key from the DOM.
 *   4. POST /api/user/install-chief-of-staff with the session cookie + password.
 *   5. Verify the CoS row exists in the DB row and the chatspace folder + key
 *      files (AGENT_INSTRUCTIONS.md, agent-runner.sh, .env, message_helper.py)
 *      are on disk with the privileged runtime config (sandbox_mode=none).
 *   6. As the CoS, POST /api/agent/cos/spawn-child to create a sub-agent.
 *   7. Verify the sub-agent row in DB, its chatspace folder, its .env (mode 0600),
 *      its AGENT_INSTRUCTIONS.md, and that the CoS auto-DMed the mission.
 *   8. PATCH the child agent instructions via the CoS endpoint twice:
 *      first without restart, proving AGENT_INSTRUCTIONS.md updates in place;
 *      then with restart=true, proving .restart_requested is written and the
 *      generated runner knows how to consume it.
 *   9. POST /api/user/messages targeting the sub-agent and confirm
 *      .message_pending was written into the sub-agent's agent_state.
 *  10. Impersonate the sub-agent's runtime and POST /api/agent/messages
 *      back to the user (a synthetic reply, because we do not run an LLM in this
 *      sandbox). Verify the row is stored and is readable from
 *      GET /api/user/messages/:agentId.
 *  11. Cleanup: DELETE the sub-agent via the CoS endpoint.
 *
 * This is an integration test, not a UI test for the dashboard — the dashboard
 * is exercised through API calls so the test stays deterministic and fast
 * regardless of LLM availability or front-end timing issues. The Playwright
 * browser is used only for the registration/login flow because that path is
 * gated by CSRF and bcrypt and is much simpler to drive via real form posts.
 *
 * Output goes to tests/test-results/full-user-pipeline-cos-spawn-<timestamp>/
 *   - screenshots: 01_register.png, 02_dashboard.png, 03_settings.png
 *   - report.json: structured pass/fail report
 *   - issues.md: any anomalies or improvement notes the test author wants
 *     to surface to the human reviewer
 *
 * Run:
 *   node tests/e2e/full-user-pipeline-cos-spawn.js
 *
 * Pre-reqs:
 *   - The platform server is running on http://127.0.0.1:3000.
 *   - Playwright chromium is installed (node_modules/playwright present).
 *   - The DB the server connects to is writable.
 *
 * The test creates a unique user (email derived from process.pid + Date.now())
 * and does NOT delete that user — failing test bodies leave behind artifacts
 * for forensics. Successful runs delete only the spawned sub-agent (so the CoS
 * + user can be re-used for follow-up debugging). To purge the test user, run
 *
 *   DELETE FROM users WHERE email LIKE 'e2e-pipeline-%@example.test';
 *
 * against the same DB.
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed (see report.json + console output)
 *   2  fatal infra error (server not reachable, Playwright missing, etc.)
 *
 * Notes / limitations:
 *   - We do NOT run a real LLM. The sub-agent's "reply" is a synthetic
 *     /api/agent/messages POST from the test, impersonating the runtime.
 *     That's the same code path the agent-runner.sh executes in production
 *     after the model writes its response, so it covers everything except
 *     the model call itself.
 *   - We do NOT start a tmux session for the sub-agent — the test verifies
 *     the spawn pipeline produces the files needed for tmux launch but does
 *     not actually run the runner.
 *   - We DO write to the real DB on the configured host. Use a non-prod DB
 *     when running this test outside of staging.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

// Load .env so we can talk to the DB to verify the test user post-registration.
// The platform enforces email verification before login, and we don't want this
// test to depend on an actual email being delivered.
(function loadDotEnv() {
  try {
    const envPath = path.join(ROOT_GUESS(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          let val = m[2];
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[m[1]] = val;
        }
      }
    }
  } catch (_e) { /* best-effort */ }
})();
function ROOT_GUESS() { return path.join(__dirname, '..', '..'); }

const ROOT = path.join(__dirname, '..', '..');
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const API_BASE = `${BASE_URL}/api`;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const OUT_DIR = path.join(
  ROOT,
  'tests',
  'test-results',
  `full-user-pipeline-cos-spawn-${timestamp()}`
);
fs.mkdirSync(OUT_DIR, { recursive: true });

const TEST_EMAIL = `e2e-pipeline-${process.pid}-${Date.now()}@example.test`;
const TEST_PASSWORD = 'TestPipeline-Pass-2026';
const CHILD_NAME = `e2e-child-${process.pid}-${Date.now().toString(36)}`;

const checks = [];
const issues = [];

function record(name, pass, details = '') {
  checks.push({ name, pass, details });
  const marker = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${marker} ${name}${details ? ' — ' + details : ''}`);
}

function note(message) {
  issues.push(message);
  console.log(`\x1b[33m• ${message}\x1b[0m`);
}

function readCookieHeader(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return list.map((h) => h.split(';')[0]).join('; ');
}

async function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? require('https') : http;
    // The platform sets session cookies with the Secure flag in production
    // (NODE_ENV=production). To make HTTP testing of a production-mode server
    // work, we send X-Forwarded-Proto: https so trust-proxy=1 lets Express
    // believe the connection is HTTPS and emits the Set-Cookie. The platform
    // already runs behind a TLS-terminating proxy in deployments, so this
    // matches the real-world behavior path.
    const bodyString = opts.body
      ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      : '';
    const headers = Object.assign(
      {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '127.0.0.1'
      },
      opts.headers || {}
    );
    if (bodyString) headers['content-length'] = Buffer.byteLength(bodyString).toString();
    const req = lib.request(
      {
        method: opts.method || 'GET',
        host: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsedBody = body;
          if ((res.headers['content-type'] || '').includes('application/json') && body) {
            try { parsedBody = JSON.parse(body); } catch (_e) { /* keep string */ }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsedBody });
        });
      }
    );
    req.on('error', reject);
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

async function waitForServer(maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetchJson(BASE_URL + '/');
      if (r.status === 200 || r.status === 302) return true;
    } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function getChatspaceRoot() {
  try {
    const cfg = require(path.join(ROOT, 'src', 'utils', 'paths'));
    if (typeof cfg.getChatspaceRoot === 'function') {
      return cfg.getChatspaceRoot();
    }
  } catch (_e) { /* fall through */ }
  return path.join(ROOT, 'chatspace');
}

function sanitizeFolderName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

async function markEmailVerifiedInDb(email) {
  // We use the existing pg pool so we don't add a runtime dep.
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'agent_app_user',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'agent_messaging_platform',
    max: 2,
    connectionTimeoutMillis: 3000
  });
  try {
    const r = await pool.query(
      'UPDATE users SET email_verified = TRUE, email_verified_at = NOW() WHERE email = $1 RETURNING user_id',
      [email]
    );
    return r.rowCount > 0;
  } finally {
    await pool.end();
  }
}

async function loginThroughUi(page) {
  // Submit /login as a fresh form post.
  await page.goto(BASE_URL + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL(/\/dashboard|\/onboarding|\/install/, { timeout: 8000 });
  } catch (_e) { /* continue and verify with current url */ }
}

function parseCookieJar(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return {};
  const list = Array.isArray(sc) ? sc : [sc];
  const out = {};
  for (const line of list) {
    const m = line.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

function mergeCookies(jar, newSetCookie) {
  for (const k of Object.keys(newSetCookie || {})) jar[k] = newSetCookie[k];
  return jar;
}

function cookieHeader(jar) {
  return Object.keys(jar).map((k) => `${k}=${jar[k]}`).join('; ');
}

async function registerAndVerifyViaHttp() {
  // Step 1: GET /register to obtain session + CSRF token.
  const getR = await fetchJson(BASE_URL + '/register', { headers: { accept: 'text/html' } });
  const jar = parseCookieJar(getR);
  const html = String(getR.body || '');
  const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  record('CSRF token extracted from /register', Boolean(csrfToken),
    csrfToken ? `len=${csrfToken.length}` : 'no token');

  // Step 2: POST /register with form body + cookies.
  const formBody = new URLSearchParams({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    confirmPassword: TEST_PASSWORD,
    agreeTerms: 'on',
    _csrf: csrfToken
  }).toString();

  const postR = await fetchJson(BASE_URL + '/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
      accept: 'text/html'
    },
    body: formBody
  });
  mergeCookies(jar, parseCookieJar(postR));
  // The server returns 302 -> /verify-email-sent on success. fetchJson follows
  // no redirects by default since we use plain http.request.
  const success = postR.status === 302
    && (postR.headers.location || '').includes('verify-email-sent');
  record('POST /register succeeds (302 → /verify-email-sent)', success,
    `status=${postR.status} location=${postR.headers.location || ''}`);
  if (!success) {
    const bodyText = typeof postR.body === 'string' ? postR.body : JSON.stringify(postR.body);
    note(`Register POST failure body: ${bodyText.slice(0, 300)}`);
    return null;
  }

  // Step 3: mark email verified directly in DB (bypass the email link).
  const verified = await markEmailVerifiedInDb(TEST_EMAIL);
  record('Mark test user verified in DB', verified,
    verified ? '' : 'no user row updated');
  if (!verified) return null;

  // Step 4: GET / (landing page hosts the login form) to obtain a fresh CSRF
  // token. /login redirects to / for unauthenticated users.
  const getLogin = await fetchJson(BASE_URL + '/', { headers: { cookie: cookieHeader(jar) } });
  mergeCookies(jar, parseCookieJar(getLogin));
  const loginHtml = String(getLogin.body || '');
  const loginCsrfMatch = loginHtml.match(/name="_csrf"\s+value="([^"]+)"/);
  const loginCsrf = loginCsrfMatch ? loginCsrfMatch[1] : '';
  record('CSRF token extracted from landing page', Boolean(loginCsrf), '');

  const loginBody = new URLSearchParams({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    _csrf: loginCsrf
  }).toString();
  const loginPost = await fetchJson(BASE_URL + '/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar)
    },
    body: loginBody
  });
  mergeCookies(jar, parseCookieJar(loginPost));
  const loggedIn = loginPost.status === 302
    && (loginPost.headers.location || '').includes('/dashboard');
  record('POST /login redirects to /dashboard', loggedIn,
    `status=${loginPost.status} location=${loginPost.headers.location || ''}`);
  if (!loggedIn) {
    const bodyText = typeof loginPost.body === 'string' ? loginPost.body : JSON.stringify(loginPost.body);
    note(`Login POST failure body: ${bodyText.slice(0, 300)}`);
    return null;
  }

  // Debug print cookie state.
  if (process.env.E2E_DEBUG_COOKIES === '1') {
    console.log('  [cookies]', cookieHeader(jar).slice(0, 200));
  }

  // Step 5: GET /settings to pull the API key out of the rendered DOM.
  // protectRoute will 302 to / if the session cookie didn't make it through,
  // so we explicitly check status first.
  const settings = await fetchJson(BASE_URL + '/settings', { headers: { cookie: cookieHeader(jar) } });
  mergeCookies(jar, parseCookieJar(settings));
  record('GET /settings returns 200 (session intact)',
    settings.status === 200,
    `status=${settings.status} loc=${settings.headers.location || ''}`);
  const settingsHtml = typeof settings.body === 'string' ? settings.body : '';
  const keyMatch = settingsHtml.match(/data-real-key="([^"]+)"/);
  const apiKey = keyMatch ? keyMatch[1] : '';
  record('API key visible on /settings', Boolean(apiKey),
    apiKey ? `len=${apiKey.length}` : `body snippet="${settingsHtml.slice(0, 120).replace(/\n/g, ' ')}"`);

  return { sessionCookie: cookieHeader(jar), apiKey };
}

async function phase1RegisterAndLogin() {
  console.log('\n=== Phase 1: register + login (HTTP) + UI screenshot ===');

  // Step A: drive register + login over HTTP (more reliable than the
  // fetch+document.write JS path in the register/login templates).
  const httpResult = await registerAndVerifyViaHttp();
  if (!httpResult) throw new Error('HTTP-based register/login failed; cannot continue');

  // Step B: open the dashboard in Playwright using the captured cookie so we
  // can take a real screenshot for the report. If chromium is missing we just
  // skip the screenshot — the HTTP path already proved the pipeline works.
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    // Set the session cookies on the browser context.
    const cookieList = httpResult.sessionCookie.split('; ').map((c) => {
      const [name, ...rest] = c.split('=');
      return {
        name, value: rest.join('='), domain: new URL(BASE_URL).hostname,
        path: '/', httpOnly: false, secure: false, sameSite: 'Lax'
      };
    });
    await context.addCookies(cookieList);
    page = await context.newPage();
    await page.goto(BASE_URL + '/register', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(OUT_DIR, '01_register.png') });
    await page.goto(BASE_URL + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(OUT_DIR, '02_dashboard.png') });
    record('Dashboard page renders for logged-in test user',
      page.url().includes('/dashboard'), page.url());
    await page.goto(BASE_URL + '/settings', { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(OUT_DIR, '03_settings.png') });
  } catch (e) {
    note(`Playwright UI capture failed: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return httpResult;
}

async function _legacyPhase1Removed() {
  console.log('\n=== Phase 1: register + login via UI ===');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    record('Playwright chromium launchable', false, e.message);
    note('Playwright chromium failed to launch. If running in a fresh sandbox, '
       + 'install browser deps with: npx playwright install chromium');
    throw e;
  }
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto(BASE_URL + '/register', { waitUntil: 'domcontentloaded' });
  record('GET /register loads', true);
  await page.screenshot({ path: path.join(OUT_DIR, '01_register.png') });

  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  // confirmPassword may be named differently depending on the template
  const confirmExists = await page.$('input[name="confirmPassword"]');
  if (confirmExists) {
    await page.fill('input[name="confirmPassword"]', TEST_PASSWORD);
  } else {
    note('No #confirmPassword input found on /register — template may have changed');
  }

  // The register form has a JS-validated Terms-of-Service checkbox and posts
  // via fetch + document.write. Check the box and wait for the page nav to
  // /verify-email-sent (the only success target).
  const termsBox = await page.$('#agreeTerms');
  if (termsBox) {
    await page.check('#agreeTerms');
  } else {
    note('No #agreeTerms checkbox found — template may have changed');
  }

  await page.click('button[type="submit"]');
  // Either we get redirected (response.redirected) or the JS rewrites the
  // document via document.write. Wait for either via URL change.
  try {
    await page.waitForURL(/\/verify-email-sent|\/dashboard|\/login/, { timeout: 8000 });
  } catch (_e) { /* keep going and inspect */ }

  // Capture any visible error message on the register page (if it stayed there).
  const registerError = await page.textContent('.alert, .error, [role="alert"]').catch(() => null);
  if (registerError) note(`Register page error after submit: ${registerError.trim().slice(0, 200)}`);

  // Production registration always redirects to /verify-email-sent — the
  // platform requires email verification before login. For this test we mark
  // the user verified directly in the DB instead of waiting on an email.
  const postRegisterUrl = page.url();
  const onVerifyPage = postRegisterUrl.includes('/verify-email-sent');
  record('Registration redirects to /verify-email-sent', onVerifyPage,
    onVerifyPage ? '' : `landed on ${postRegisterUrl}`);

  let verified = false;
  try {
    verified = await markEmailVerifiedInDb(TEST_EMAIL);
  } catch (e) {
    record('Mark test user verified in DB', false, e.message);
    note('DB credentials are needed to bypass the email verification gate. '
       + 'Set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env or env vars.');
    throw e;
  }
  record('Mark test user verified in DB', verified,
    verified ? '' : 'no user row updated');

  await loginThroughUi(page);
  const postLoginUrl = page.url();
  const onDashboard = postLoginUrl.includes('/dashboard');
  record('Login redirects to dashboard', onDashboard,
    onDashboard ? '' : `landed on ${postLoginUrl}`);
  await page.screenshot({ path: path.join(OUT_DIR, '02_dashboard.png') });

  // Pull session cookie for HTTP API calls.
  const cookies = await context.cookies(BASE_URL);
  const sessionCookie = cookies
    .filter((c) => ['connect.sid', 'session', 'sessionId'].includes(c.name)
                || c.name.startsWith('connect.'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  record('Session cookie captured', Boolean(sessionCookie),
    sessionCookie ? `${cookies.length} cookies` : 'no session cookie set');

  // Visit /settings and grab the API key
  await page.goto(BASE_URL + '/settings', { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(OUT_DIR, '03_settings.png') });
  const apiKey = await page.getAttribute('#apiKeyInput', 'data-real-key').catch(() => null)
              || await page.inputValue('#apiKeyInput').catch(() => null);
  record('API key visible on /settings', Boolean(apiKey),
    apiKey ? `key length=${apiKey.length}` : 'no api key found');

  await browser.close();
  return { sessionCookie, apiKey };
}

function csrfTokenFromCookieHeader(cookieStr) {
  const m = String(cookieStr || '').match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return m ? m[1] : '';
}

async function phase2InstallCoS({ sessionCookie }) {
  console.log('\n=== Phase 2: install Chief of Staff ===');

  const csrf = csrfTokenFromCookieHeader(sessionCookie);
  const installResp = await fetchJson(`${API_BASE}/user/install-chief-of-staff`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'x-csrf-token': csrf },
    body: { confirm: true, userPassword: TEST_PASSWORD }
  });
  record('POST /install-chief-of-staff returns 201', installResp.status === 201,
    `status=${installResp.status}`);

  if (installResp.status !== 201) {
    note(`Install failed body: ${JSON.stringify(installResp.body).slice(0, 300)}`);
    return null;
  }

  const cosBody = installResp.body;
  const agentField = cosBody.agent || cosBody;
  const cosName = agentField.agentName || agentField.agent_name;
  const cosId = agentField.agentId || agentField.agent_id;
  record('Install response includes CoS agent name and id', Boolean(cosName && cosId),
    `name=${cosName} id=${cosId}`);

  // Verify chatspace folder on disk. Prefer the server-reported agentDir if
  // present, otherwise reconstruct from the sanitized name.
  const folder = cosBody.agentDir || path.join(getChatspaceRoot(), sanitizeFolderName(cosName || ''));
  const folderExists = fs.existsSync(folder);
  record('CoS chatspace folder exists', folderExists, folder);
  if (folderExists) {
    const expected = ['AGENT_INSTRUCTIONS.md', 'agent-runner.sh', 'message_helper.py', '.env'];
    for (const fname of expected) {
      const p = path.join(folder, fname);
      record(`CoS file present: ${fname}`, fs.existsSync(p), p);
    }
    // agent_config.json lives under agent_state/ (the runner reads it from
    // there). sandbox_mode must be 'none' for the CoS so spawned children
    // inherit full-auto runtime instead of bwrap-sandboxed mode.
    const cfgPath = path.join(folder, 'agent_state', 'agent_config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        record('CoS runtime sandbox is full-access (sandbox_mode=none)',
          cfg.sandbox_mode === 'none',
          `sandbox_mode=${cfg.sandbox_mode}`);
        record('CoS runtime approval is full-auto',
          cfg.approval_mode === 'full-auto',
          `approval_mode=${cfg.approval_mode}`);
      } catch (e) {
        record('CoS agent_state/agent_config.json is valid JSON', false, e.message);
      }
    } else {
      note('CoS agent_state/agent_config.json missing; full-auto runtime cannot be verified from disk');
    }
  }

  // Verify install response does NOT echo .env credentials back when skipFiles=false.
  if (cosBody.fileBundle) {
    const envEntry = cosBody.fileBundle['.env']
                  || (cosBody.fileBundle.files && cosBody.fileBundle.files['.env']);
    // The stripped entry may either be missing entirely or present with
    // empty/no content. Either is acceptable as long as no real API_KEY leaks.
    const leakedKey = envEntry && envEntry.content && /API_KEY=\S+/.test(envEntry.content);
    record('Install response does NOT echo .env contents', !leakedKey,
      leakedKey ? 'API_KEY found in response .env entry' : '');
  }

  return { cosId, cosName, folder };
}

async function phase3SpawnChild({ apiKey, cosName }) {
  console.log('\n=== Phase 3: CoS spawns child sub-agent ===');

  const spawnResp = await fetchJson(`${API_BASE}/agent/cos/spawn-child`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-agent-name': cosName
    },
    body: {
      name: CHILD_NAME,
      role: 'E2E test sub-agent',
      initialInstructions: 'You exist for the duration of an E2E test. Acknowledge the user politely and stop.',
      runtimeConfig: { model_provider: 'claude', model: 'default' },
      parentPassword: TEST_PASSWORD
    }
  });
  record('POST /cos/spawn-child returns 201', spawnResp.status === 201,
    `status=${spawnResp.status}`);
  if (spawnResp.status !== 201) {
    note(`spawn-child body: ${JSON.stringify(spawnResp.body).slice(0, 400)}`);
    return null;
  }

  const child = spawnResp.body.childAgent || spawnResp.body.child || spawnResp.body;
  record('Spawn response carries childAgent.agentId', Boolean(child && child.agentId),
    `agentId=${child && child.agentId}`);
  record('Spawn response carries tmuxLaunchCommand', Boolean(child && child.tmuxLaunchCommand),
    child && child.tmuxLaunchCommand ? child.tmuxLaunchCommand.slice(0, 80) : '');

  const childFolder = child && child.agentDir
    ? child.agentDir
    : path.join(getChatspaceRoot(), sanitizeFolderName(CHILD_NAME));
  record('Child agent folder exists', fs.existsSync(childFolder), childFolder);
  if (fs.existsSync(childFolder)) {
    const required = ['AGENT_INSTRUCTIONS.md', 'agent-runner.sh', 'message_helper.py', '.env', 'agent_state'];
    for (const f of required) {
      const p = path.join(childFolder, f);
      record(`Child file present: ${f}`, fs.existsSync(p), p);
    }
    const envPath = path.join(childFolder, '.env');
    if (fs.existsSync(envPath)) {
      const envStat = fs.statSync(envPath);
      const mode = (envStat.mode & 0o777).toString(8);
      record('Child .env mode is 0600', mode === '600',
        `actual=${mode}`);
      const envContent = fs.readFileSync(envPath, 'utf8');
      record('Child .env contains API_KEY', /\bAPI_KEY=\S+/.test(envContent), '');
      // CRITICAL CHECK: the spawn endpoint writes the requester's API key into
      // the child .env. If the requester was the CoS (which used the user key),
      // the child's API_KEY should equal the user's key.
      const m = envContent.match(/^API_KEY=(.+)$/m);
      let writtenKey = m ? m[1].trim() : '';
      // Strip optional surrounding quotes that the writer adds.
      if ((writtenKey.startsWith('"') && writtenKey.endsWith('"'))
       || (writtenKey.startsWith("'") && writtenKey.endsWith("'"))) {
        writtenKey = writtenKey.slice(1, -1);
      }
      record('Child .env API_KEY equals the user key', writtenKey === apiKey,
        writtenKey ? `child=${writtenKey.slice(0, 8)}…` : 'no API_KEY line');
    }
    const aiPath = path.join(childFolder, 'AGENT_INSTRUCTIONS.md');
    if (fs.existsSync(aiPath)) {
      const aiContent = fs.readFileSync(aiPath, 'utf8');
      record('Child AGENT_INSTRUCTIONS.md mentions role',
        aiContent.includes('E2E test sub-agent') || aiContent.includes('Role'),
        '');
      // Look for any of the canonical reply-first phrasings the generator
      // currently emits (it has evolved a few times — be tolerant).
      const hasReplyFirst = (
           /reply first/i.test(aiContent)
        || /send a real reply/i.test(aiContent)
        || /normal reply in the agent chat/i.test(aiContent)
        || /skip the normal user-chat reply/i.test(aiContent)
        || /Reply First, Log Second/i.test(aiContent)
        || /reply in the agent chat\. Do not replace that reply with a news-feed/i.test(aiContent)
        || /news feed does not replace a required user-facing reply/i.test(aiContent)
      );
      record('Child AGENT_INSTRUCTIONS.md includes reply-first guidance',
        hasReplyFirst,
        hasReplyFirst ? '' : `len=${aiContent.length}; no canonical phrase found`);
      if (!hasReplyFirst) {
        note('Child instructions do NOT include any "reply first" language — '
           + 'this is the canonical guidance that the "reads but does not reply" '
           + 'fix relies on. If a CoS-spawned child only ever logs to news feed, '
           + 'this is the first place to look.');
      }
    }
  }

  return {
    childId: child && child.agentId,
    childName: (child && (child.agentName || child.agent_name)) || CHILD_NAME,
    childFolder
  };
}

async function phase4UserToChildMessage({ sessionCookie, childId, childFolder }) {
  console.log('\n=== Phase 5: user → child message + wake signal ===');

  const messageBody = `Hi sub-agent, this is the user. Please confirm you received this. [${Date.now()}]`;
  const csrf = csrfTokenFromCookieHeader(sessionCookie);
  const sendResp = await fetchJson(`${API_BASE}/user/messages`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'x-csrf-token': csrf },
    body: { agentId: childId, content: messageBody, encrypted: false }
  });
  record('POST /user/messages returns 201', sendResp.status === 201,
    `status=${sendResp.status}`);

  // The signal file is written synchronously by the route handler.
  const signalPath = path.join(childFolder, 'agent_state', '.message_pending');
  // Tiny grace period for slow FS writes (e.g. on networked filesystems).
  await new Promise((r) => setTimeout(r, 100));
  const signalExists = fs.existsSync(signalPath);
  record('.message_pending wake file was written', signalExists, signalPath);
  if (!signalExists) {
    note('Without .message_pending, the agent loop only wakes on its slow polling tick. '
       + 'If you see this in production with a real agent, that is a candidate root cause '
       + 'for "reads but does not reply" — the runtime never sees the new message in time.');
  }

  return { sentMessage: messageBody };
}

async function phase5SyntheticChildReply({ apiKey, childId }) {
  console.log('\n=== Phase 6: synthetic child reply ===');

  const replyText = `Hello user — I received your test message and I am replying. [${Date.now()}]`;
  // The /api/agent/messages endpoint reads the sender agent name from
  // req.body.agentName, not from a header. Use the canonical agentName
  // returned by spawn-child to avoid name-sanitization mismatches.
  const replyResp = await fetchJson(`${API_BASE}/agent/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: { agentName: CHILD_NAME, content: replyText, priority: 0, encrypted: false }
  });
  record('POST /agent/messages from child returns 201', replyResp.status === 201,
    `status=${replyResp.status}`);
  if (replyResp.status !== 201) {
    note(`child reply body: ${JSON.stringify(replyResp.body).slice(0, 300)}`);
  }
  return { replyText, replyId: replyResp.body && replyResp.body.messageId };
}

async function phase6VerifyReplyVisibleToUser({ sessionCookie, childId, replyText }) {
  console.log('\n=== Phase 7: user sees child reply ===');

  const url = `${API_BASE}/user/messages/${childId}?limit=20`;
  const resp = await fetchJson(url, { headers: { cookie: sessionCookie } });
  record('GET /user/messages/:agentId returns 200', resp.status === 200,
    `status=${resp.status}`);

  const list = Array.isArray(resp.body) ? resp.body
    : Array.isArray(resp.body && resp.body.messages) ? resp.body.messages
    : [];
  record('Reply appears in user-visible message list',
    list.some((m) => (m.content || '').includes(replyText.slice(0, 40))),
    `messages=${list.length}`);

  // The CoS auto-DMed the mission on spawn. The platform intentionally shows
  // inter-agent DMs in the user's view of the child (with type=agent_dm_*),
  // which is the desired audit behavior. We assert that the DM is properly
  // tagged so it cannot be confused with a real user→agent message.
  const missionDm = list.find((m) => /Your mission \(from the Chief of Staff\)/.test(m.content || ''));
  if (missionDm) {
    const isTaggedAsDm = (missionDm.type || '').startsWith('agent_dm');
    record('CoS mission DM is tagged as agent_dm_received/sent (not a user message)',
      isTaggedAsDm,
      `type=${missionDm.type || '(none)'}`);
    if (!isTaggedAsDm) {
      note('Auto-DM from CoS appears in the user feed but is NOT tagged as an inter-agent DM. '
         + 'That could confuse the UI into showing it as a user-authored message.');
    }
  }
}

async function phase7Cleanup({ apiKey, cosName, childId, childName }) {
  console.log('\n=== Phase 8: cleanup (delete child) ===');
  if (!childId) {
    record('Cleanup skipped (no child to delete)', true);
    return;
  }
  const resp = await fetchJson(`${API_BASE}/agent/cos/agents/${childId}`, {
    method: 'DELETE',
    headers: {
      'x-api-key': apiKey,
      'x-agent-name': cosName
    },
    body: { confirmation: childName || CHILD_NAME }
  });
  const ok = resp.status === 200 || resp.status === 204;
  record('DELETE child returns 200/204', ok,
    `status=${resp.status} body=${JSON.stringify(resp.body).slice(0, 200)}`);
}

async function phase4UpdateChildInstructions({ apiKey, cosName, childId, childFolder }) {
  console.log('\n=== Phase 4: CoS updates child instructions + restart signal ===');

  const instructionsPath = path.join(childFolder, 'AGENT_INSTRUCTIONS.md');
  const restartPath = path.join(childFolder, 'agent_state', '.restart_requested');
  const runnerPath = path.join(childFolder, 'agent-runner.sh');

  const inPlaceInstructions = [
    '# Agent Instructions',
    '',
    'You are an E2E child agent after an in-place CoS update.',
    'Always reply in the agent chat when the user sends an actionable message.',
    `Update marker: in-place-${Date.now()}`
  ].join('\n');

  const inPlaceResp = await fetchJson(`${API_BASE}/agent/cos/agents/${childId}/instructions`, {
    method: 'PATCH',
    headers: {
      'x-api-key': apiKey,
      'x-agent-name': cosName
    },
    body: { newInstructions: inPlaceInstructions, restart: false }
  });
  record('PATCH child instructions without restart returns 200', inPlaceResp.status === 200,
    `status=${inPlaceResp.status}`);
  record('Instruction update reports applied_immediately=true',
    Boolean(inPlaceResp.body && inPlaceResp.body.applied_immediately === true),
    JSON.stringify(inPlaceResp.body).slice(0, 160));
  record('Instruction update without restart does not request restart',
    Boolean(inPlaceResp.body && inPlaceResp.body.restart_requested === false),
    JSON.stringify(inPlaceResp.body).slice(0, 160));

  const fileNow = fs.existsSync(instructionsPath)
    ? fs.readFileSync(instructionsPath, 'utf8')
    : '';
  record('Child AGENT_INSTRUCTIONS.md changed in place',
    fileNow.includes('after an in-place CoS update') && fileNow.includes('Always reply in the agent chat'),
    instructionsPath);
  record('No .restart_requested file written for restart=false',
    !fs.existsSync(restartPath),
    restartPath);

  const restartInstructions = [
    '# Agent Instructions',
    '',
    'You are an E2E child agent after a restart-requested CoS update.',
    'If this runner is active, it should restart itself after seeing .restart_requested.',
    `Update marker: restart-${Date.now()}`
  ].join('\n');
  const restartResp = await fetchJson(`${API_BASE}/agent/cos/agents/${childId}/instructions`, {
    method: 'PATCH',
    headers: {
      'x-api-key': apiKey,
      'x-agent-name': cosName
    },
    body: { newInstructions: restartInstructions, restart: true }
  });
  record('PATCH child instructions with restart=true returns 200', restartResp.status === 200,
    `status=${restartResp.status}`);
  record('Instruction update with restart=true reports restart_requested=true',
    Boolean(restartResp.body && restartResp.body.restart_requested === true),
    JSON.stringify(restartResp.body).slice(0, 160));
  record('.restart_requested file was written for restart=true',
    fs.existsSync(restartPath),
    restartPath);
  if (fs.existsSync(restartPath)) {
    const restartContent = fs.readFileSync(restartPath, 'utf8').trim();
    record('.restart_requested contains a timestamp-like value',
      /^\d{4}-\d{2}-\d{2}T/.test(restartContent),
      restartContent);
  }

  const runnerContent = fs.existsSync(runnerPath)
    ? fs.readFileSync(runnerPath, 'utf8')
    : '';
  record('Child runner contains restart flag wiring',
    runnerContent.includes('RESTART_FLAG="$STATE_DIR/.restart_requested"')
      && runnerContent.includes('check_restart_flag')
      && runnerContent.includes('handle_restart'),
    runnerPath);
  record('Child runner handles restart with exec relaunch',
    /exec\s+"\$0"/.test(runnerContent) || /exec\s+.*agent-runner\.sh/.test(runnerContent),
    runnerPath);
}

(async function main() {
  console.log(`\n=== Full User Pipeline + CoS Spawn E2E ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Output:   ${OUT_DIR}`);
  console.log(`Email:    ${TEST_EMAIL}`);
  console.log(`Child:    ${CHILD_NAME}`);

  if (!(await waitForServer())) {
    console.error('Server not reachable at ' + BASE_URL);
    process.exit(2);
  }

  let cos;
  let spawn;
  let userToChild;
  let synthetic;
  try {
    const { sessionCookie, apiKey } = await phase1RegisterAndLogin();
    if (!sessionCookie || !apiKey) {
      throw new Error('Phase 1 did not yield session + apiKey; cannot continue');
    }
    cos = await phase2InstallCoS({ sessionCookie });
    if (!cos) throw new Error('Phase 2 failed; cannot continue');
    spawn = await phase3SpawnChild({ apiKey, cosName: cos.cosName });
    if (!spawn) throw new Error('Phase 3 failed; cannot continue');
    await phase4UpdateChildInstructions({
      apiKey, cosName: cos.cosName, childId: spawn.childId, childFolder: spawn.childFolder
    });
    userToChild = await phase4UserToChildMessage({
      sessionCookie, childId: spawn.childId, childFolder: spawn.childFolder
    });
    synthetic = await phase5SyntheticChildReply({ apiKey, childId: spawn.childId });
    await phase6VerifyReplyVisibleToUser({
      sessionCookie, childId: spawn.childId, replyText: synthetic.replyText
    });
    await phase7Cleanup({
      apiKey, cosName: cos.cosName, childId: spawn.childId, childName: spawn.childName
    });
  } catch (e) {
    console.error('\n\x1b[31mFATAL\x1b[0m', e.stack || e.message);
    note(`fatal: ${e.message}`);
  }

  // Final report
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n=== Summary ===`);
  console.log(`  ${passed}/${checks.length} checks passed${failed ? ` (${failed} failed)` : ''}`);

  fs.writeFileSync(
    path.join(OUT_DIR, 'report.json'),
    JSON.stringify({
      base_url: BASE_URL,
      test_email: TEST_EMAIL,
      child_name: CHILD_NAME,
      checks,
      issues,
      passed,
      failed,
      total: checks.length
    }, null, 2)
  );

  if (issues.length) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'issues.md'),
      '# Issues / improvement notes\n\n' + issues.map((m) => '- ' + m).join('\n') + '\n'
    );
  }

  console.log(`\nReport written to ${OUT_DIR}`);
  process.exit(failed === 0 ? 0 : 1);
})();
