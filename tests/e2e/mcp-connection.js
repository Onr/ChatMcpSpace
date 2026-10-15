/**
 * Live browser acceptance test for ChatMCP's part of an MCP connection.
 * Uses reserved-domain test accounts, then removes its accounts and grants.
 * The callback is a verification client, not the Gemini application.
 * Run: LIVE_MCP_VERIFY=1 node tests/e2e/mcp-connection.js
 */
require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const bcrypt = require('bcrypt');
const { chromium } = require('playwright');

if (process.env.LIVE_MCP_VERIFY !== '1') {
  throw new Error('Set LIVE_MCP_VERIFY=1 to create and clean up live test fixtures.');
}
const { query, closePool } = require('../../src/db/connection');
const base = new URL(process.env.BASE_URL).origin;
let callback;
let callbackServer;
let finalCallbackServer;
const suffix = crypto.randomBytes(8).toString('hex');
const userId = crypto.randomUUID();
const agentId = crypto.randomUUID();
const email = `mcp-browser-${suffix}@example.invalid`;
const password = crypto.randomBytes(32).toString('base64url');
const artifacts = path.resolve(__dirname, '../../test-results/mcp-verification');
let browser;
let context;
let clientId;
const browserErrors = [];

async function post(endpoint, values, json = false) {
  const response = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(values) : new URLSearchParams(values),
    signal: AbortSignal.timeout(20000)
  });
  assert.notEqual(response.status, 429, `Unexpected rate limit on ${endpoint}`);
  return response;
}

async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    // Use a real loopback OAuth client. Browser redirect requests must reach
    // a listening server rather than relying on interception of a fake domain.
    finalCallbackServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><head><title>MCP verification client</title></head><body><h1>Returned to verification client</h1><p>This is a test client, not Gemini.</p></body></html>');
    });
    await new Promise((resolve, reject) => {
      finalCallbackServer.once('error', reject);
      finalCallbackServer.listen(0, '127.0.0.1', resolve);
    });
    // Model a provider callback which redirects again to a different origin.
    callbackServer = http.createServer((request, response) => {
      const queryString = new URL(request.url, 'http://127.0.0.1').search;
      response.writeHead(302, {
        Location: `http://127.0.0.1:${finalCallbackServer.address().port}/connected${queryString}`,
        'Cache-Control': 'no-store'
      });
      response.end();
    });
    await new Promise((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(0, '127.0.0.1', resolve);
    });
    callback = `http://127.0.0.1:${callbackServer.address().port}/mcp-browser-callback`;
    await query(`INSERT INTO users
      (user_id,email,password_hash,api_key,script_token,encryption_salt,email_verified,email_verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,CURRENT_TIMESTAMP)`,
    [userId, email, await bcrypt.hash(password, 10), crypto.randomUUID(),
      crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]);
    await query('INSERT INTO agents (agent_id,user_id,agent_name,position) VALUES ($1,$2,$3,1)',
      [agentId, userId, 'Browser verification agent']);
    const registration = await post('/oauth/register', {
      client_name: 'Browser verification client', redirect_uris: [callback]
    }, true);
    assert.equal(registration.status, 201, 'client registration');
    clientId = (await registration.json()).client_id;
    // Match Gemini's observed 1,078-character opaque state without recording it.
    const state = crypto.randomBytes(539).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const authorization = base + '/oauth/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: callback,
      scope: 'agents.read', resource: base + '/mcp', state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = browserErrors;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/oauth/') && response.status() === 429) {
        errors.push('Unexpected OAuth rate limit during the browser connection flow');
      }
      if (new URL(response.url()).pathname === '/oauth/authorize/consent') {
        console.log('Consent response status:', response.status());
      }
    });
    page.on('requestfailed', request => {
      if (request.url().startsWith(callback)) {
        console.log('Callback navigation failure:', request.failure()?.errorText);
      }
    });
    page.on('console', message => {
      if (message.type() === 'error' && /form-action|Content Security Policy/i.test(message.text())) {
        const safeMessage = message.text().replace(/https?:\/\/[^\s)]+/g, '[URL]');
        errors.push(safeMessage);
        console.log('Browser policy diagnostic:', safeMessage);
      }
    });

    await page.goto(base + '/mcp-guide', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Connect Gemini to ChatMCP' }).waitFor();
    assert.ok(await page.getByText(base + '/mcp', { exact: true }).isVisible());
    await page.screenshot({ path: path.join(artifacts, '01-guide.png'), fullPage: true });
    console.log('PASS visible connection guide and exact MCP URL');

    await page.goto(authorization, { waitUntil: 'domcontentloaded' });
    await page.locator('#loginEmail').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(artifacts, '02-sign-in.png'), fullPage: true });
    await page.locator('#loginEmail').fill(email);
    await page.locator('#loginPassword').fill(password);
    await page.locator('#loginTab').click();
    await page.getByRole('heading', { name: 'Connect Browser verification client to ChatMCP' })
      .waitFor({ timeout: 25000 });
    assert.ok(await page.getByText('It cannot read chat messages or access encryption keys.').isVisible());
    await page.screenshot({ path: path.join(artifacts, '03-consent.png'), fullPage: true });
    console.log('PASS visible password sign-in returns automatically to consent');

    await page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await page.getByRole('heading', { name: 'Returned to verification client' }).waitFor();
    const returned = new URL(page.url());
    assert.equal(returned.searchParams.get('state'), state);
    const code = returned.searchParams.get('code');
    assert.ok(code);
    console.log('PASS Allow access returns to the registered client');
    console.log('PASS provider callback redirect to a second origin');

    const exchange = await post('/oauth/token', {
      grant_type: 'authorization_code', client_id: clientId, code,
      redirect_uri: callback, code_verifier: verifier, resource: base + '/mcp'
    });
    assert.equal(exchange.status, 200, 'PKCE token exchange');
    const token = (await exchange.json()).access_token;
    const result = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }),
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.deepEqual(body.result.structuredContent.agents, [{ id: agentId, name: 'Browser verification agent' }]);
    console.log('PASS browser-approved access invokes list_agents');
    await page.setContent('<!doctype html><html><head><title>Verification result</title></head><body style="font:20px system-ui;padding:40px"><h1>Connection verified</h1><p>Live ChatMCP sign-in and consent completed successfully.</p><p>Tool: list_agents</p><p>Result: Browser verification agent</p><p>This is the verification client; Gemini itself has not been tested.</p></body></html>');
    await page.screenshot({ path: path.join(artifacts, '04-verification-client-result.png'), fullPage: true });

    const response = await page.goto(authorization, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, 'consent for cancellation');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('heading', { name: 'Returned to verification client' }).waitFor();
    const denied = new URL(page.url());
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('code'), null);
    console.log('PASS Cancel denies connection without issuing an authorization code');
    assert.deepEqual(errors, [], 'browser JavaScript exceptions');
    console.log('PASS no browser JavaScript exceptions');
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({
      status: 'passed', completedAt: new Date().toISOString(),
      scope: 'Live ChatMCP browser flow with verification client; Gemini UI unverified',
      steps: ['guide', 'password sign-in', 'consent', 'callback with cross-origin redirect', 'list_agents', 'cancel'],
      javascriptErrors: errors
    }, null, 2));
  } finally {
    if (context) await context.request.get(base + '/logout').catch(() => {});
    if (browser) await browser.close();
    if (callbackServer) await new Promise(resolve => callbackServer.close(resolve));
    if (finalCallbackServer) await new Promise(resolve => finalCallbackServer.close(resolve));
    if (clientId) await query('DELETE FROM mcp_oauth_clients WHERE client_id=$1 AND client_name=$2', [clientId, 'Browser verification client']);
    await query('DELETE FROM users WHERE user_id=$1 AND email=$2', [userId, email]);
    await closePool();
    console.log('CLEANUP test account, agent, client, grants, tokens, and session removed');
  }
}

run().catch(error => {
  // Browser errors can contain navigation URLs carrying OAuth credentials.
  console.error('BROWSER VERIFICATION FAILED:', error.message.replace(/https?:\/\/[^\s)]+/g, '[URL]'));
  if (browserErrors.length) console.error('Browser diagnostics:', JSON.stringify(browserErrors));
  process.exitCode = 1;
});
