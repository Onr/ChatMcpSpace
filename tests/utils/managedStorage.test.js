const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { managedStorageDirectory } = require('../../scripts/shared-agent-runner');
const { loadState } = require('../../scripts/external-agent-bridge');

let root, project, home, file, env, stat;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-storage-'));
  project = path.join(root, 'mounted-project'); home = path.join(root, 'home');
  fs.mkdirSync(project); fs.mkdirSync(home);
  file = path.join(project, 'shared-agent.json');
  env = { CHATSPACE_BRIDGE_STATE: file };
  stat = fs.statSync.bind(fs);
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function emulateDrvFS(prefix = project) {
  jest.spyOn(fs, 'statSync').mockImplementation((candidate, ...args) => {
    const info = stat(candidate, ...args);
    if (String(candidate).startsWith(prefix)) info.mode |= 0o077;
    return info;
  });
}
function state() {
  return { version: 1, baseUrl: 'https://example.test', token: 'local-test-token', agentName: 'Existing',
    key: crypto.randomBytes(32).toString('base64'), pending: { phase: 'ready', id: 'pending-work' }, history: {} };
}
test('Linux state stays in place with the original workspace', () => {
  expect(managedStorageDirectory(env, { home })).toBe(project);
  expect(fs.readdirSync(project)).toEqual([]);
});
test('mounted-drive state moves intact to private home storage and remains stable on restart', () => {
  const original = state(); fs.writeFileSync(file, JSON.stringify(original)); emulateDrvFS();
  const destination = managedStorageDirectory(env, { home });
  expect(destination.startsWith(path.join(home, '.chatmcp', 'private-state'))).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
  expect(loadState(path.join(destination, 'shared-agent.json'))).toEqual(original);
  expect(stat(destination).mode & 0o077).toBe(0);
  expect(stat(path.join(destination, 'shared-agent.json')).mode & 0o077).toBe(0);
  expect(managedStorageDirectory(env, { home })).toBe(destination);
  expect(env.CHATSPACE_BRIDGE_STATE).toBe(file);
});
test('a new mounted-drive agent gets private storage before enrollment', () => {
  emulateDrvFS();
  expect(managedStorageDirectory(env, { home })).not.toBe(project);
  expect(fs.existsSync(file)).toBe(false);
});
test('cannot migrate an active listener, follow a symlink, or weaken permissions', () => {
  fs.writeFileSync(file, JSON.stringify(state())); fs.writeFileSync(`${file}.lock`, String(process.pid));
  emulateDrvFS();
  expect(() => managedStorageDirectory(env, { home })).toThrow('Stop the project bridge');
  expect(fs.existsSync(file)).toBe(true);
  fs.unlinkSync(`${file}.lock`);
  fs.rmSync(path.join(home, '.chatmcp'), { recursive: true });
  fs.symlinkSync(project, path.join(home, '.chatmcp'));
  expect(() => managedStorageDirectory(env, { home })).toThrow('owned by your user');
});
test('a home filesystem without private permissions fails safely without deleting state', () => {
  fs.writeFileSync(file, JSON.stringify(state())); emulateDrvFS(root);
  expect(() => managedStorageDirectory(env, { home })).toThrow('Linux home cannot protect');
  expect(fs.existsSync(file)).toBe(true);
});
test('conflicting states are preserved for explicit recovery', () => {
  const original = state(); fs.writeFileSync(file, JSON.stringify(original)); emulateDrvFS();
  const destination = managedStorageDirectory(env, { home });
  fs.writeFileSync(file, JSON.stringify({ ...original, token: 'different-token' }));
  expect(() => managedStorageDirectory(env, { home })).toThrow('conflicting states');
  expect(loadState(path.join(destination, 'shared-agent.json')).token).toBe(original.token);
  expect(fs.existsSync(file)).toBe(true);
});
