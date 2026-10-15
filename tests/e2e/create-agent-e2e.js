/**
 * E2E: creating a new agent the way `curl -sL https://chatmcp.space/setup | bash` does.
 *
 * Why this exists
 * ---------------
 * On 2026-09-04 a brand-new agent could not start: its very first introduction
 * message came back as `DATABASE_ERROR: Failed to complete message creation`
 * (see docs/INCIDENT_2026-09-04_NEW_AGENT_STARTUP.md). Nothing in the suite
 * covered that path end to end — agent creation is *implicit*, it happens
 * inside the first POST /api/agent/messages, so a broken first message means a
 * user can never onboard an agent at all.
 *
 * What it covers
 * --------------
 *   1. GET /setup             — the public bootstrap installer is served, is
 *                               valid bash, and points at /api/agent/cli-script.
 *   2. GET /api/agent/cli-script with X-API-Key — the per-user second stage is
 *                               served, is valid bash, carries the intact
 *                               X-Script-SHA256 integrity header, and still
 *                               contains the first-run introduction logic.
 *   3. The agent does not exist yet (history returns AGENT_NOT_FOUND).
 *   4. POST /api/agent/messages with a new agentName + UUID clientMessageId —
 *                               201, and the agent row is auto-created. This is
 *                               the exact call that regressed. Repeated without
 *                               clientMessageId, because the route short-circuits
 *                               on that field and older agents omit it.
 *   5. Replaying the same clientMessageId is idempotent (200, same messageId,
 *                               no duplicate row).
 *   6. A malformed clientMessageId is a clean 400, not a 500.
 *   7. The introduction is readable back through the endpoints the runner
 *      polls (/messages/history, /messages/latest, /responses).
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It does not pipe /setup into bash. That installer sudo-installs `gum`, writes
 * $HOME/.chatmcp and edits shell rc files, and it prompts for an API key — none
 * of which belongs in a test run. Instead it fetches both stages, syntax-checks
 * them, and then makes the same HTTP calls the generated runner makes.
 *
 * It also asserts against the *generated* script from the live endpoint, never
 * against the checked-in agent-cli.sh snapshot, which is a stale artifact.
 *
 * Run:
 *   node tests/e2e/create-agent-e2e.js
 *   E2E_BASE_URL=http://127.0.0.1:3000 node tests/e2e/create-agent-e2e.js
 *
 * Pre-reqs:
 *   - The platform server is running (default http://127.0.0.1:3000).
 *   - The DB in .env is writable (the test creates and then deletes its own user).
 *
 * Side effects: creates one throwaway user + agent + messages and deletes them
 * in a finally block. Nothing else in the DB is touched.
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 *   2  fatal infra error (server unreachable, DB down)
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// Deliberately NOT process.env.BASE_URL — that is the public production URL in
// .env, and this test writes rows. Point it elsewhere only via E2E_BASE_URL.
const BASE_URL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

const RUN_ID = timestamp();
const OUT_DIR = path.join(ROOT, 'tests', 'test-results', `create-agent-e2e-${RUN_ID}`);

const checks = [];
function record(name, pass, details = '') {
  checks.push({ name, pass, details });
  console.log(`${pass ? '  PASS' : '  FAIL'}: ${name}${details ? ' — ' + details : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Syntax-check a bash script without executing a single line of it. */
function bashSyntaxOk(source, label) {
  const file = path.join(os.tmpdir(), `create-agent-e2e-${process.pid}-${label}.sh`);
  fs.writeFileSync(file, source);
  try {
    const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    return { ok: result.status === 0, stderr: (result.stderr || '').trim() };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function req(method, urlPath, { apiKey, agentName, body, accept } = {}) {
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (agentName) headers['X-Agent-Name'] = agentName;
  if (accept) headers.Accept = accept;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, e.g. a shell script */ }
  return { status: res.status, headers: res.headers, text, json };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Unique per run so repeated runs never collide, and so a leftover row from a
  // crashed run is obvious about where it came from.
  const unique = `${process.pid}-${Date.now()}`;
  const testEmail = `e2e-create-agent-${unique}@example.test`;
  const testPassword = `E2e-${crypto.randomBytes(9).toString('hex')}!`;
  const agentName = `e2e-create-agent-${unique}`;
  const introContent = `Hello! I am ${agentName} and I am ready to assist you. What would you like me to help with?`;
  const clientMessageId = crypto.randomUUID();

  let db = null;
  let user = null;

  try {
    // ── 0. Preflight ────────────────────────────────────────────────────────
    section('Preflight');
    try {
      const ping = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
      console.log(`  server at ${BASE_URL} responded ${ping.status}`);
    } catch (err) {
      console.error(`\nFATAL: server not reachable at ${BASE_URL}: ${err.message}`);
      console.error('Start it first (scripts/start_server.sh) or set E2E_BASE_URL.');
      process.exit(2);
    }

    db = require(path.join(ROOT, 'src', 'db', 'connection'));
    const { registerUser } = require(path.join(ROOT, 'src', 'services', 'authService'));

    // ── 1. Public bootstrap installer ───────────────────────────────────────
    section('1. GET /setup (public bootstrap)');
    const setup = await req('GET', '/setup');
    record('/setup returns 200', setup.status === 200, `status ${setup.status}`);
    const setupSyntax = bashSyntaxOk(setup.text, 'setup');
    record('/setup body is valid bash', setupSyntax.ok, setupSyntax.stderr);
    record('/setup starts with a shebang', setup.text.startsWith('#!/bin/bash'),
      setup.text.slice(0, 40).split('\n')[0]);
    record('/setup fetches the per-user CLI script', setup.text.includes('/api/agent/cli-script'));
    record('/setup sends the API key as X-API-Key', /X-API-Key/i.test(setup.text));

    // ── 2. A real user, the way registration makes one ──────────────────────
    section('2. Provision a throwaway user');
    user = await registerUser(testEmail, testPassword);
    record('user created with an API key', Boolean(user && user.apiKey), user ? user.email : 'none');
    const apiKey = user.apiKey;

    // ── 3. Per-user second-stage script ─────────────────────────────────────
    section('3. GET /api/agent/cli-script (per-user second stage)');
    const cli = await req('GET', '/api/agent/cli-script', { apiKey });
    record('cli-script returns 200', cli.status === 200, `status ${cli.status}`);
    const cliSyntax = bashSyntaxOk(cli.text, 'cli');
    record('cli-script is valid bash', cliSyntax.ok, cliSyntax.stderr);
    record('cli-script is personalised with the caller API key', cli.text.includes(apiKey));

    const sha = crypto.createHash('sha256').update(cli.text, 'utf8').digest('hex');
    const advertisedSha = cli.headers.get('x-script-sha256');
    record('X-Script-SHA256 matches the delivered body', advertisedSha === sha,
      advertisedSha ? `header ${advertisedSha.slice(0, 12)}… body ${sha.slice(0, 12)}…` : 'header missing');

    // The regressed path in script form: a fresh agent sends an intro and does
    // NOT launch the model until a real user message arrives.
    record('cli-script contains the first-run introduction branch',
      cli.text.includes('First run detected'));
    record('cli-script ships message_helper.py',
      cli.text.includes('message_helper.py'));

    // ── 4. The agent does not exist yet ─────────────────────────────────────
    section('4. Agent does not exist before the first message');
    const before = await req('GET', `/api/agent/messages/history?agentName=${encodeURIComponent(agentName)}`, { apiKey });
    record('history for an unknown agent is 404 AGENT_NOT_FOUND',
      before.status === 404 && before.json && before.json.error && before.json.error.code === 'AGENT_NOT_FOUND',
      `status ${before.status}`);

    // ── 5. The first introduction message creates the agent ─────────────────
    section('5. POST /api/agent/messages — first introduction (creates the agent)');
    const intro = await req('POST', '/api/agent/messages', {
      apiKey,
      agentName,
      body: { agentName, content: introContent, priority: 0, clientMessageId }
    });
    record('first introduction message returns 201', intro.status === 201,
      `status ${intro.status} ${intro.text.slice(0, 200)}`);
    record('response carries a messageId', Boolean(intro.json && intro.json.messageId),
      intro.json ? String(intro.json.messageId) : 'none');
    record('no DATABASE_ERROR on the first message',
      !(intro.json && intro.json.error && intro.json.error.code === 'DATABASE_ERROR'),
      intro.json && intro.json.error ? intro.json.error.code : 'none');

    const agentRow = await db.query(
      'SELECT agent_id, agent_name, agent_type FROM agents WHERE user_id = $1 AND agent_name = $2',
      [user.userId, agentName]
    );
    record('agent row was auto-created in the DB', agentRow.rows.length === 1,
      agentRow.rows.length ? agentRow.rows[0].agent_id : 'no row');

    // A second brand-new agent, this time with no clientMessageId at all. The
    // route short-circuits `clientMessageId !== undefined && !isValidUUID(...)`,
    // so the field's presence decides whether isValidUUID is even reached — the
    // exact call that was missing an import during the incident. Current
    // message_helper.py always sends the field (it falls back to a local
    // uuid4), but agents installed before idempotency landed do not, so both
    // branches need to stay alive.
    const legacyAgentName = `${agentName}-legacy`;
    const legacyIntro = await req('POST', '/api/agent/messages', {
      apiKey,
      agentName: legacyAgentName,
      body: { agentName: legacyAgentName, content: introContent, priority: 0 }
    });
    record('introduction without clientMessageId returns 201', legacyIntro.status === 201,
      `status ${legacyIntro.status} ${legacyIntro.text.slice(0, 200)}`);
    const legacyRow = await db.query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [user.userId, legacyAgentName]
    );
    record('agent without clientMessageId was auto-created', legacyRow.rows.length === 1,
      legacyRow.rows.length ? legacyRow.rows[0].agent_id : 'no row');

    // ── 6. Idempotency ──────────────────────────────────────────────────────
    section('6. Replaying the same clientMessageId');
    const replay = await req('POST', '/api/agent/messages', {
      apiKey,
      agentName,
      body: { agentName, content: introContent, priority: 0, clientMessageId }
    });
    record('replay returns 200 (not a second 201)', replay.status === 200, `status ${replay.status}`);
    record('replay is flagged idempotent', Boolean(replay.json && replay.json.idempotent));
    record('replay returns the original messageId',
      Boolean(intro.json && replay.json && replay.json.messageId === intro.json.messageId));

    if (agentRow.rows.length === 1) {
      const dupes = await db.query(
        'SELECT COUNT(*)::int AS n FROM messages WHERE agent_id = $1 AND client_message_id = $2',
        [agentRow.rows[0].agent_id, clientMessageId]
      );
      record('exactly one row stored for the replayed id', dupes.rows[0].n === 1, `rows: ${dupes.rows[0].n}`);
    }

    // ── 7. Malformed idempotency key is a validation error, not a 500 ───────
    section('7. Malformed clientMessageId');
    const bad = await req('POST', '/api/agent/messages', {
      apiKey,
      agentName,
      body: { agentName, content: 'malformed idempotency key', priority: 0, clientMessageId: 'not-a-uuid' }
    });
    record('malformed clientMessageId returns 400', bad.status === 400, `status ${bad.status}`);
    record('malformed clientMessageId is not a 5xx', bad.status < 500, `status ${bad.status}`);

    // ── 8. The runner can read its own introduction back ────────────────────
    section('8. Introduction is readable through the runner poll endpoints');
    const history = await req('GET', `/api/agent/messages/history?agentName=${encodeURIComponent(agentName)}`, { apiKey });
    record('history returns 200 after creation', history.status === 200, `status ${history.status}`);
    const historyText = history.text || '';
    record('history contains the introduction', historyText.includes(introContent));

    const latest = await req('GET', `/api/agent/messages/latest?agentName=${encodeURIComponent(agentName)}`, { apiKey });
    record('latest returns 200', latest.status === 200, `status ${latest.status}`);

    const responses = await req('GET', '/api/agent/responses', { apiKey, agentName });
    record('responses poll returns 200 for the new agent', responses.status === 200, `status ${responses.status}`);

  } catch (err) {
    record('unexpected exception', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    console.error(err);
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    section('Cleanup');
    if (db && user && user.userId) {
      try {
        // agents/messages cascade from users (see src/db/schema.sql).
        await db.query('DELETE FROM users WHERE user_id = $1', [user.userId]);
        console.log(`  removed test user ${user.email}`);
      } catch (err) {
        console.error(`  WARNING: failed to remove test user ${user.email}: ${err.message}`);
        console.error(`  clean up manually: DELETE FROM users WHERE email = '${testEmail}';`);
      }
    }
    if (db && db.closePool) {
      try { await db.closePool(); } catch { /* pool may already be closed */ }
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const exitCode = failed.length === 0 ? 0 : 1;
  const summary = `${checks.length - failed.length}/${checks.length} checks passed`;

  const report = {
    suite: 'e2e:create-agent',
    runId: RUN_ID,
    ranAtUtc: new Date().toISOString(),
    baseUrl: BASE_URL,
    agentName,
    passed: checks.length - failed.length,
    total: checks.length,
    exitCode,
    checks
  };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`\n${summary}`);
  if (failed.length) {
    console.log('Failed checks:');
    failed.forEach((c) => console.log(`  - ${c.name}${c.details ? ' — ' + c.details : ''}`));
  }
  console.log(`Report: ${path.relative(ROOT, path.join(OUT_DIR, 'report.json'))}`);

  // Record the run so docs/TEST_RUN_LOG.md shows when this last worked.
  spawnSync(path.join(ROOT, 'scripts', 'log_test_run.sh'),
    ['e2e:create-agent', String(exitCode), summary],
    { stdio: 'inherit' });

  process.exit(exitCode);
})();
