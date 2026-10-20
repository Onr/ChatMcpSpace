const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const template = fs.readFileSync(path.join(__dirname, '../../views/shared.ejs'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/shared-chat.js'), 'utf8');
const now = Date.parse('2026-10-04T20:00:00Z');
const seen = new Date(now - 1000).toISOString();
let dom;

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup(overrides = {}) {
  const state = {
    agents: [{ agentId: 'private-agent', name: 'Private Agent', lastSeenAt: seen },
      { agentId: 'shared-agent', name: 'Shared Agent', lastSeenAt: seen }],
    runtimes: [{ agent_id: 'shared-agent', agent_name: 'Shared Agent', last_seen_at: seen }],
    rooms: [], ...overrides
  };
  const html = state.legacyTemplate ? template.replace(/<form id="sharedCreate">[\s\S]*?<\/form>/,
    '<form id="sharedCreate"><label>Agent <select name="agentId" required></select></label><label>Conversation title <input name="title" required></label><button>Create</button><p>Only connected shared-capable runtimes appear. Stop the old listener before connecting the shared runner.</p></form>') : template;
  dom = new JSDOM(ejs.render(html, { csrfToken: 'csrf-token', assetUrl: require('../../src/utils/assetUrl').assetUrl }), {
    url: 'https://space.example/shared' + (state.search || ''), runScripts: 'outside-only'
  });
  dom.window.Date.now = () => now;
  dom.window.getStoredEncryptionKey = jest.fn().mockResolvedValue({});
  dom.window.SharedCrypto = { privateKey: jest.fn().mockResolvedValue({}), unwrap: jest.fn().mockResolvedValue({}) };
  dom.window.setInterval = jest.fn();
  dom.window.fetch = jest.fn(async (url, options = {}) => {
    if (url === '/api/user/agents') {
      if (state.agentError) return response({ error: { message: 'Catalogue unavailable' } }, 503);
      if (state.agentRequest) return state.agentRequest();
      return response({ agents: state.agents });
    }
    if (url === '/api/user/shared' && options.method === 'POST') {
      return state.createResponse || response({ error: { message: 'Connect a shared-capable runner first' } }, 409);
    }
    if (url === '/api/user/shared') return response({ userId: 'owner-id', rooms: state.rooms, agents: state.runtimes });
    if (url === '/api/user/shared/identity') return response({ private_key: 'wrapped-key' });
    if (url === '/api/user/shared/new-room') return response(state.roomContext || {
      room: { title: 'New chat', key_version: 1, member: { role: 'owner', status: 'pending' } },
      keys: [], members: [], guests: []
    });
    if (url === '/api/user/shared/new-room/messages?after=0' || url === '/api/user/shared/new-room/batches') return response([]);
    throw new Error(`Unexpected request ${url}`);
  });
  dom.window.eval(script);
  return state;
}

function element(id) { return dom.window.document.getElementById(id); }
function select() { return element('sharedCreate').elements.agentId; }
function createButton() { return element('sharedCreate').querySelector('button[type="submit"]'); }
function submit(id) {
  element(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}
function changeAgent(id) {
  select().value = id;
  select().dispatchEvent(new dom.window.Event('change'));
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}
async function unlock() {
  element('sharedUnlock').elements.displayName.value = 'Owner';
  submit('sharedUnlock');
  await settle();
  expect(element('sharedWorkspace').hidden).toBe(false);
}
function creations() {
  return dom.window.fetch.mock.calls.filter(([url, options]) => url === '/api/user/shared' && options?.method === 'POST');
}
afterEach(() => dom?.window.close());

test('shows all current owned agents and defaults to a connected shared runner', async () => {
  setup();
  await unlock();
  expect([...select().options].map(option => option.value)).toEqual(['private-agent', 'shared-agent']);
  expect(select().textContent).toContain('Private Agent');
  expect(select().textContent).toContain('Connect shared runner');
  expect(select().value).toBe('shared-agent');
  expect(element('sharedAgentStatus').textContent).toContain('Ready');
  expect(createButton().disabled).toBe(false);
  expect(select().getAttribute('aria-describedby')).toBe('sharedAgentStatus');
});

test('supports the previous form markup retained in the production view cache', async () => {
  setup({ legacyTemplate: true });
  await unlock();
  expect([...select().options].map(option => option.value)).toEqual(['private-agent', 'shared-agent']);
  expect(select().value).toBe('shared-agent');
  expect(createButton().disabled).toBe(false);
  expect(element('sharedAgentStatus').getAttribute('role')).toBe('status');
  expect(element('sharedCreate').textContent).not.toContain('Only connected shared-capable runtimes appear');
  element('sharedRefreshAgents').click();
  await settle();
  expect(createButton().disabled).toBe(false);
});

test('keeps ordinary online agents visible while refusing to create without a shared runner', async () => {
  setup({ runtimes: [] });
  await unlock();
  expect(select().options).toHaveLength(2);
  expect(select().disabled).toBe(false);
  expect(createButton().disabled).toBe(true);
  expect(element('sharedAgentStatus').textContent).toContain('Connect the shared runner');
  element('sharedCreate').elements.title.value = 'Attempt';
  submit('sharedCreate');
  await settle();
  expect(creations()).toHaveLength(0);
  expect(createButton().disabled).toBe(true);
});

test('shows an explicit empty state with a dashboard link when the account has no agents', async () => {
  setup({ agents: [], runtimes: [] });
  await unlock();
  expect(select().options).toHaveLength(1);
  expect(select().selectedOptions[0].textContent).toBe('No agents available');
  expect(select().disabled).toBe(true);
  expect(createButton().disabled).toBe(true);
  expect(element('sharedAgentStatus').textContent).toContain('dashboard');
  expect(element('sharedCreate').querySelector('a[href="/dashboard"]')).toBeTruthy();
});

test('marks stale or invalid shared heartbeats offline', async () => {
  setup({ runtimes: [
    { agent_id: 'private-agent', last_seen_at: new Date(now - 120000).toISOString() },
    { agent_id: 'shared-agent', last_seen_at: 'invalid' }
  ] });
  await unlock();
  expect(select().textContent).toContain('Shared runner offline');
  expect(createButton().disabled).toBe(true);
  expect(element('sharedAgentStatus').textContent).toContain('offline');
});

test('refuses to create when the selected runner expires between refreshes', async () => {
  setup();
  await unlock();
  dom.window.Date.now = () => now + 120000;
  submit('sharedCreate');
  await settle();
  expect(creations()).toHaveLength(0);
  expect(createButton().disabled).toBe(true);
});

test('ignores runtimes absent from the owned catalogue and renders names as text', async () => {
  setup({ agents: [{ agentId: 'private-agent', name: '<img src=x onerror=alert(1)>', lastSeenAt: seen }],
    runtimes: [{ agent_id: 'foreign-agent', agent_name: 'Other owner', last_seen_at: seen }] });
  await unlock();
  expect([...select().options].map(option => option.value)).toEqual(['private-agent']);
  expect(select().textContent).toContain('<img src=x onerror=alert(1)>');
  expect(select().querySelector('img')).toBeNull();
  expect(select().textContent).not.toContain('Other owner');
  expect(createButton().disabled).toBe(true);
});

test('preserves a valid selection on refresh and chooses a ready agent when it disappears', async () => {
  const state = setup();
  await unlock();
  changeAgent('private-agent');
  expect(createButton().disabled).toBe(true);
  element('sharedRefreshAgents').click();
  await settle();
  expect(select().value).toBe('private-agent');
  expect(createButton().disabled).toBe(true);
  state.agents = state.agents.filter(agent => agent.agentId !== 'private-agent');
  element('sharedRefreshAgents').click();
  await settle();
  expect(select().value).toBe('shared-agent');
  expect(createButton().disabled).toBe(false);
});

test('recovers from an agent catalogue failure without hiding existing conversations', async () => {
  const state = setup({ agentError: true,
    rooms: [{ id: 'existing-room', title: 'Existing chat', agent_name: 'Shared Agent', status: 'active' }] });
  await unlock();
  expect(element('sharedRooms').textContent).toContain('Existing chat');
  expect(select().selectedOptions[0].textContent).toBe('Agents unavailable');
  expect(element('sharedAgentStatus').textContent).toContain('Refresh agents');
  expect(createButton().disabled).toBe(true);
  expect(element('sharedError').textContent).toBe('');
  state.agentError = false;
  element('sharedRefreshAgents').click();
  await settle();
  expect(select().options).toHaveLength(2);
  expect(createButton().disabled).toBe(false);
});

test('keeps the picker enabled during refresh and notices a newly connected shared runner', async () => {
  const state = setup({ runtimes: [] });
  await unlock();
  let resolve;
  state.runtimes = [{ agent_id: 'private-agent', last_seen_at: seen }];
  state.agentRequest = () => new Promise(done => { resolve = done; });
  element('sharedRefreshAgents').click();
  await settle();
  expect(createButton().disabled).toBe(true);
  expect(select().disabled).toBe(false);
  expect(element('sharedAgentStatus').textContent).toContain('Updating');
  resolve(response({ agents: state.agents }));
  await settle();
  expect(select().value).toBe('private-agent');
  expect(createButton().disabled).toBe(false);
});

test('a late catalogue response cannot replace newer agent choices', async () => {
  const state = setup();
  await unlock();
  const requests = [];
  state.agentRequest = () => new Promise(resolve => requests.push(resolve));
  const poll = dom.window.setInterval.mock.calls[0][0]();
  element('sharedRefreshAgents').click();
  await settle();
  expect(requests).toHaveLength(2);
  requests[1](response({ agents: [{ agentId: 'shared-agent', name: 'Current name' }] }));
  await settle();
  expect(select().textContent).toContain('Current name');
  requests[0](response({ agents: [{ agentId: 'private-agent', name: 'Obsolete name' }] }));
  await poll;
  await settle();
  expect(select().textContent).toContain('Current name');
  expect(select().textContent).not.toContain('Obsolete name');
  expect(createButton().disabled).toBe(false);
});

test('background polling preserves option nodes, selection, focus and the expanded form', async () => {
  setup();
  await unlock();
  const picker = select();
  const options = [...picker.options];
  dom.window.document.querySelector('.chat-new-room').open = true;
  changeAgent('private-agent');
  picker.focus();
  const changes = new dom.window.MutationObserver(() => {});
  changes.observe(picker, { childList: true, subtree: true, attributes: true });
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect([...picker.options]).toEqual(options);
  expect(options.every(option => option.isConnected)).toBe(true);
  expect(changes.takeRecords()).toHaveLength(0);
  expect(picker.value).toBe('private-agent');
  expect(dom.window.document.activeElement).toBe(picker);
  expect(dom.window.document.querySelector('.chat-new-room').open).toBe(true);
  changes.disconnect();
});

test('a selection made while the catalogue request is pending wins over the old selection', async () => {
  const state = setup();
  await unlock();
  let resolve;
  state.agentRequest = () => new Promise(done => { resolve = done; });
  const polling = dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(select().disabled).toBe(false);
  changeAgent('private-agent');
  resolve(response({ agents: state.agents }));
  await polling;
  expect(select().value).toBe('private-agent');
});

test('a transient background failure keeps the open picker and disables creation until recovery', async () => {
  const state = setup();
  await unlock();
  const options = [...select().options];
  state.agentError = true;
  await dom.window.setInterval.mock.calls[0][0]();
  expect([...select().options]).toEqual(options);
  expect(select().disabled).toBe(false);
  expect(createButton().disabled).toBe(true);
  state.agentError = false;
  await dom.window.setInterval.mock.calls[0][0]();
  expect(createButton().disabled).toBe(false);
});

test('sharing from an agent icon expands the creation form and preselects that agent', async () => {
  setup({ search: '?agentId=private-agent' });
  await unlock();
  expect(select().value).toBe('private-agent');
  expect(dom.window.document.querySelector('.chat-new-room').open).toBe(true);
  await dom.window.setInterval.mock.calls[0][0]();
  expect(select().value).toBe('private-agent');
});

test('provider and recipient choices survive polls and reset when a participant loses access', async () => {
  const members = [
    { user_id: 'owner-id', display_name: 'Owner', role: 'owner', status: 'active' },
    { user_id: 'member-id', display_name: 'Collaborator', role: 'participant', status: 'active' }
  ];
  const profiles = [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: 'gpt' }];
  const state = setup({ createResponse: response({ id: 'new-room' }), roomContext: {
    room: { title: 'Team chat', key_version: 1, member: { role: 'owner', status: 'active' } },
    keys: [{ key_version: 1, wrapped_key: 'test-key' }], members, guests: [],
    runtime: { last_seen_at: seen, capabilities: { profiles } }
  } });
  await unlock();
  submit('sharedCreate');
  await settle();
  const profile = element('sharedProfile').elements.profile;
  const address = element('sharedComposer').elements.address;
  profile.value = JSON.stringify(profiles[1]);
  address.value = 'member-id';
  const profileOptions = [...profile.options], addressOptions = [...address.options];
  address.focus();
  await dom.window.setInterval.mock.calls[0][0]();
  expect([...profile.options]).toEqual(profileOptions);
  expect([...address.options]).toEqual(addressOptions);
  expect(profile.value).toBe(JSON.stringify(profiles[1]));
  expect(address.value).toBe('member-id');
  expect(dom.window.document.activeElement).toBe(address);
  state.roomContext.members = members.filter(member => member.user_id !== 'member-id');
  await dom.window.setInterval.mock.calls[0][0]();
  expect(address.value).toBe('');
  expect([...address.options].some(option => option.value === 'member-id')).toBe(false);
});

test('rejects a forged selection not present in the account catalogue', async () => {
  setup();
  await unlock();
  const forged = dom.window.document.createElement('option');
  forged.value = 'foreign-agent';
  select().append(forged);
  select().value = 'foreign-agent';
  submit('sharedCreate');
  await settle();
  expect(creations()).toHaveLength(0);
  expect(createButton().disabled).toBe(true);
});

test('creates with the chosen owned ready agent and retains server authorization errors', async () => {
  const state = setup();
  await unlock();
  element('sharedCreate').elements.title.value = 'New chat';
  submit('sharedCreate');
  await settle();
  expect(creations()).toHaveLength(1);
  expect(JSON.parse(creations()[0][1].body)).toEqual({ agentId: 'shared-agent', title: 'New chat' });
  expect(creations()[0][1].headers['x-csrf-token']).toBe('csrf-token');
  expect(element('sharedError').textContent).toBe('Connect a shared-capable runner first');
  expect(select().value).toBe('shared-agent');

  state.createResponse = response({ id: 'new-room' });
  submit('sharedCreate');
  await settle();
  expect(element('sharedTitle').textContent).toBe('New chat');
  expect(element('sharedError').textContent).toBe('');
});
