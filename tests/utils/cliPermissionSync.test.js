const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { generateMainCLIScript } = require('../../src/utils/apiGuideGenerator');

const source = generateMainCLIScript('fixture-key', 'http://fixture.invalid');
const sync = source.match(/^sync_runtime_permissions\(\) \{[\s\S]*?^\}/m)[0];

it.each([
  [200, null],
  [401, "owner's API key"],
  [403, "owner's API key"],
  [404, 'Update the server'],
  [429, 'Server is busy'],
  [500, 'Check server logs'],
  [400, 'Invalid fixture permissions'],
])('permission sync handles HTTP %s and keeps local settings available for retry', async (status, message) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-permissions-'));
  const config = path.join(dir, 'config.json'), allowed = path.join(dir, 'allowed.json');
  fs.writeFileSync(config, JSON.stringify({ model_provider: 'codex' }));
  fs.writeFileSync(allowed, JSON.stringify({ codex: {} }));
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { key: req.headers['x-api-key'], body: JSON.parse(body) };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid fixture permissions' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const harness = `set -euo pipefail
      print_error() { printf '%s\\n' "$1"; }
      print_info() { printf '%s\\n' "$1"; }
      ${sync}
      sync_runtime_permissions 'Agent With Spaces' "$1" "$2"
    `;
    const result = await new Promise(resolve => execFile('bash', ['-c', harness, 'fixture', config, allowed], {
      env: { ...process.env, TMPDIR: dir, API_KEY: 'fixture-key', API_BASE: `http://127.0.0.1:${server.address().port}/api` },
    }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));
    expect(received).toEqual({ key: 'fixture-key', body: { agentName: 'Agent With Spaces', config: { model_provider: 'codex' }, allowedPermissions: { codex: {} } } });
    expect(result.code).toBe(status === 200 ? 0 : 1);
    if (message) {
      expect(result.stdout).toContain(message);
      expect(result.stdout).toContain('continue the same agent to retry');
    } else expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.readdirSync(dir).sort()).toEqual(['allowed.json', 'config.json']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('reports a connection failure and preserves the grant for retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-permissions-network-'));
  const config = path.join(dir, 'config.json'), allowed = path.join(dir, 'allowed.json');
  fs.writeFileSync(config, '{}'); fs.writeFileSync(allowed, '{"codex":{}}');
  const server = http.createServer((req, res) => res.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise(resolve => execFile('bash', ['-c', `
      set -euo pipefail
      print_error() { printf '%s\\n' "$1"; }
      print_info() { printf '%s\\n' "$1"; }
      ${sync}
      sync_runtime_permissions Fixture "$1" "$2"
    `, 'fixture', config, allowed], {
      env: { ...process.env, TMPDIR: dir, API_KEY: 'fixture-key', API_BASE: `http://127.0.0.1:${server.address().port}/api` },
    }, (error, stdout) => resolve({ code: error?.code || 0, stdout })));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Check your connection and server URL');
    expect(result.stdout).toContain('continue the same agent to retry');
    expect(fs.readdirSync(dir).sort()).toEqual(['allowed.json', 'config.json']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
