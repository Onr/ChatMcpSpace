/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const source = dashboard.slice(dashboard.indexOf('function lastChatStorageKey()'), dashboard.indexOf('\n/**\n * ============================================\n * Main Interactive Space', dashboard.indexOf('function lastChatStorageKey()')));
const key = 'dashboard_last_agent_id:viewer';
const room = { agentId: 'shared-agent', conversationId: 'room', mode: 'shared', role: 'participant' };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function mount() {
  document.body.innerHTML = '<div id="dashboardRoot" data-user-id="viewer"></div>';
  window.history.replaceState({ navigation: 'preserve' }, '', '/dashboard');
  localStorage.clear();
  const scope = {
    document, window, localStorage, URL, URLSearchParams, console, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, EMBEDDED_PREVIEW_MODE: false, LAST_AGENT_STORAGE_KEY: 'dashboard_last_agent_id',
    lastAgentRestorationAttempted: false, dashboardAgentRestorationReady: false, sharedChatSelectionRequest: 0,
    signalDashboardReadyWhenInitialized: jest.fn(), currentAgentList: [{ agentId: 'private-agent', name: 'Personal', agentType: 'news_feed' }],
    selectAgent: jest.fn().mockResolvedValue(undefined),
    fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => room })
  };
  window.InPlaceChat = {};
  window.DashboardHelpers = { selectChatContext: jest.fn().mockResolvedValue(undefined) };
  vm.runInNewContext(source, scope);
  return scope;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('switching from shared to private clears the stale shared URL and retains browser state and unrelated parameters', () => {
  const scope = mount();
  window.history.replaceState({ navigation: 'preserve' }, '', '/dashboard?conversationId=old&invitationId=stale&tab=chats#latest');
  scope.rememberLastChat('private-agent', null);
  expect(window.location.href).toMatch(/\/dashboard\?tab=chats#latest$/);
  expect(window.history.state).toEqual({ navigation: 'preserve' });
  expect(JSON.parse(localStorage.getItem(key))).toEqual({ agentId: 'private-agent', conversationId: null });
});
test('switching between shared chats remembers the conversation, including for agents absent from the private list', () => {
  const scope = mount();
  scope.rememberLastChat(room.agentId, room);
  expect(window.location.search).toBe('?conversationId=room');
  scope.rememberLastChat(room.agentId, { ...room, conversationId: 'second-room' });
  expect(JSON.parse(localStorage.getItem(key))).toEqual({ agentId: room.agentId, conversationId: 'second-room' });
  expect(window.location.search).toBe('?conversationId=second-room');
});
test('private restoration preserves the real agent name and bypasses side panels', async () => {
  const scope = mount();
  localStorage.setItem(key, JSON.stringify({ agentId: 'private-agent', conversationId: null }));
  scope.setupLastAgentRestoration();
  jest.advanceTimersByTime(500); await settle();
  expect(scope.selectAgent).toHaveBeenCalledWith('private-agent', 'Personal', expect.objectContaining({ forceMainSelection: true, agentType: 'news_feed' }));
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('a shared conversation restores from the dashboard URL without any private agents', async () => {
  const scope = mount(); scope.currentAgentList = [];
  localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  scope.setupLastAgentRestoration(); await settle();
  expect(scope.fetch).toHaveBeenCalledWith('/api/user/chat-threads/room', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  expect(window.DashboardHelpers.selectChatContext).toHaveBeenCalledWith(room);
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test.each(['conversationId=direct-room', 'invitationId=direct-invite'])('an explicit %s takes precedence over saved chats', async query => {
  const scope = mount();
  localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  window.history.replaceState({}, '', '/dashboard?' + query);
  scope.setupLastAgentRestoration(); jest.advanceTimersByTime(6000); await settle();
  expect(scope.fetch).not.toHaveBeenCalled(); expect(scope.selectAgent).not.toHaveBeenCalled();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('a manual selection before the private list arrives cancels restoration', async () => {
  const scope = mount();
  localStorage.setItem(key, JSON.stringify({ agentId: 'private-agent' }));
  scope.setupLastAgentRestoration(); scope.sharedChatSelectionRequest++;
  jest.advanceTimersByTime(500); await settle();
  expect(scope.selectAgent).not.toHaveBeenCalled();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('a manual selection during a shared lookup cannot be replaced by its late response', async () => {
  const scope = mount(); let release;
  scope.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  scope.setupLastAgentRestoration(); scope.sharedChatSelectionRequest++;
  release({ ok: true, json: async () => room }); await settle();
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('an unresponsive shared lookup times out and completes startup', async () => {
  const scope = mount();
  scope.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  scope.setupLastAgentRestoration();
  jest.advanceTimersByTime(15000); await settle();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
test.each([403, 404, 503])('inaccessible or temporarily unavailable shared chats leave the picker usable (%s)', async status => {
  const scope = mount(); scope.fetch.mockResolvedValue({ ok: false, status });
  localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  scope.setupLastAgentRestoration(); await settle();
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test.each(['{broken', 'null'])('invalid saved data does not block startup (%s)', value => {
  const scope = mount(); localStorage.setItem(key, value);
  expect(() => scope.setupLastAgentRestoration()).not.toThrow();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('browser storage denial does not block switching or startup', () => {
  const scope = mount(); scope.localStorage = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); } };
  expect(() => scope.rememberLastChat(room.agentId, room)).not.toThrow();
  expect(window.location.search).toBe('?conversationId=room');
  expect(() => scope.setupLastAgentRestoration()).not.toThrow();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('another account does not restore the previous account shared conversation', async () => {
  const scope = mount(); localStorage.setItem(key, JSON.stringify({ agentId: room.agentId, conversationId: room.conversationId }));
  document.getElementById('dashboardRoot').dataset.userId = 'other-account';
  scope.setupLastAgentRestoration(); jest.advanceTimersByTime(6000); await settle();
  expect(scope.fetch).not.toHaveBeenCalled(); expect(scope.selectAgent).not.toHaveBeenCalled();
  expect(scope.dashboardAgentRestorationReady).toBe(true);
});
test('legacy private-agent memory migrates through selection; removed agents are skipped', async () => {
  const scope = mount(); localStorage.setItem('dashboard_last_agent_id', 'private-agent');
  scope.setupLastAgentRestoration(); jest.advanceTimersByTime(500); await settle();
  expect(scope.selectAgent).toHaveBeenCalledTimes(1);
  scope.lastAgentRestorationAttempted = false; scope.selectAgent.mockClear(); scope.currentAgentList = [];
  scope.setupLastAgentRestoration(); jest.advanceTimersByTime(6000); await settle();
  expect(scope.selectAgent).not.toHaveBeenCalled(); expect(scope.dashboardAgentRestorationReady).toBe(true);
});
