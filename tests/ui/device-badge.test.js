/** @jest-environment jsdom */
const DeviceBadge = require('../../public/js/device-badge');
const { normalizeDevice } = require('../../src/utils/agentDevice');
const crypto = require('crypto');
const device = name => ({ id: crypto.createHash('sha256').update(name).digest('hex'), name });

test('agents sharing a device get identical stable icons across renderings', () => {
  const first = DeviceBadge.render(device('office'));
  expect(DeviceBadge.render({ ...device('office') })).toBe(first);
  expect(DeviceBadge.render(device('laptop'))).not.toBe(first);
  document.body.innerHTML = first;
  expect(document.querySelector('.agent-device-badge').title).toBe('Device: office');
  expect(document.querySelectorAll('svg rect')).toHaveLength(25);
});

test('device labels are escaped and cached icons do not cache stale names', () => {
  const original = device('office');
  DeviceBadge.render(original);
  document.body.innerHTML = DeviceBadge.render({ ...original, name: '"><img src=x onerror=alert(1)>' });
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.agent-device-badge').getAttribute('aria-label')).toContain('<img');
  expect(document.querySelector('.agent-device-badge').title).not.toBe('Device: office');
});

test.each([null, {}, { id: 'bad', name: 'unverified' }])('unknown devices show an honest placeholder (%p)', value => {
  document.body.innerHTML = DeviceBadge.render(value);
  expect(document.querySelector('.agent-device-badge').title).toBe('Device not reported');
  expect(document.querySelector('svg')).toBeNull();
});

test('metadata validation bounds names, strips control characters, rejects malformed fingerprints', () => {
  expect(normalizeDevice({ ...device('office'), name: ' \u0000office\n ' })).toEqual(device('office'));
  expect(normalizeDevice({ ...device('office'), name: 'x'.repeat(1000) }).name).toHaveLength(128);
  expect(normalizeDevice({ ...device('office'), id: '<svg>' })).toBeNull();
  expect(normalizeDevice({ ...device('office'), name: '   ' })).toBeNull();
});

test('generated native runner reports the same fingerprint as the Node bridge', () => {
  const { generateAgentRunner } = require('../../src/utils/apiGuideGenerator');
  const source = generateAgentRunner();
  const start = source.indexOf('send_working_heartbeat() {');
  const end = source.indexOf('\n# Run CLI command', start);
  const script = source.slice(start, end);
  const capture = require('path').join(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'device-test-')), 'payload');
  const result = require('child_process').spawnSync('bash', ['-c', `${script}\nAPI_BASE=http://example.test API_KEY=test AGENT_NAME=test WORKING_HEARTBEAT_NOTE=test\ncurl() { printf '%s\\n' "$*" > "${capture}"; printf '{"stopRequested":false}'; }\nsend_working_heartbeat false`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  const captured = require('fs').readFileSync(capture, 'utf8');
  require('fs').rmSync(require('path').dirname(capture), { recursive: true });
  const payload = JSON.parse(captured.slice(captured.indexOf('{')).trim());
  let identity = require('os').hostname();
  try { identity = require('fs').readFileSync('/etc/machine-id', 'utf8').trim() || identity; } catch (_) {}
  expect(payload.device).toEqual({ id: crypto.createHash('sha256').update(identity).digest('hex'), name: require('os').hostname() });
});

test('server-rendered agent balls include device badges and load the renderer before dashboard code', async () => {
  const ejs = require('ejs');
  const html = await ejs.renderFile(require('path').join(__dirname, '../../views/dashboard.ejs'), {
    DeviceBadge, agents: [{ agentId: 'device-fixture', name: 'Device Fixture', device: device('office'),
      position: 1, highestPriority: 'low', lastMessagePriority: 'low', unreadCount: 0, marbleSvg: '' }],
    groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'test', cspNonce: 'test',
    assetUrl: value => value, safeJsonForScript: require('../../src/utils/safeJsonHelper').safeJsonForScript
  });
  document.body.innerHTML = html;
  expect(document.querySelector('.agent-avatar .agent-device-badge').title).toBe('Device: office');
  expect(html.indexOf('/js/device-badge.js')).toBeLessThan(html.indexOf('/js/dashboard.js'));
});
