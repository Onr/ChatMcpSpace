/** @jest-environment jsdom */
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../../public/js/recent-chats.js'), 'utf8');
const agents = ['a', 'b', 'c', 'd'].map(agentId => ({agentId, name: `Agent ${agentId}`, agentType: 'standard'}));
const shared = {agentId: 'a', conversationId: 'room', agentName: 'Team A', mode: 'shared', role: 'participant'};
const key = 'dashboard_recent_chats:viewer';
function boot() {
  document.body.innerHTML = '<div id="dashboardRoot" data-user-id="viewer"></div><nav id="recentChats" hidden></nav>';
  window.DashboardHelpers = {getChatSelectionVersion: jest.fn(() => 1), selectChatContext: jest.fn(async () => {})};
  window.selectAgent = jest.fn(async () => {}); window.showError = jest.fn();
  window.fetch = jest.fn(async () => ({ok: true, json: async () => shared}));
  vm.runInNewContext(source, {window, document, AbortController, setTimeout, clearTimeout});
  window.RecentChats.updateAgents(agents); window.RecentChats.updateContexts([shared]);
  return window.RecentChats;
}
const buttons = () => [...document.querySelectorAll('#recentChats button')];
const saved = () => JSON.parse(localStorage.getItem(key));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => { localStorage.clear(); });
test('keeps the three most recently opened distinct chats in order and highlights the current one', () => {
  const recents = boot();
  for (const id of ['a', 'b', 'c', 'd', 'b']) recents.remember(id);
  expect(saved().map(e => e.agentId)).toEqual(['b', 'd', 'c']);
  expect(buttons().map(b => b.querySelector('.recent-chat__name').textContent)).toEqual(['Agent b', 'Agent d', 'Agent c']);
  expect(buttons().map(b => b.dataset.recencyRank)).toEqual(['1', '2', '3']);
  expect(buttons()[0].getAttribute('aria-current')).toBe('page');
  expect(document.querySelectorAll('#recentChats .recent-chat--empty')).toHaveLength(0);
  recents.remember('__ALL__'); expect(saved()).toHaveLength(3);
  expect(document.querySelector('#recentChats [aria-current]')).toBeNull();
});
test('restores history using current names, stores identifiers only, and removes unavailable private entries from view', () => {
  let recents = boot(); recents.remember('a'); recents.remember('b');
  expect(saved()[0]).toEqual({agentId: 'b', conversationId: null});
  recents = boot();
  expect(buttons()).toHaveLength(2);
  expect(document.querySelectorAll('#recentChats .recent-chat--empty')).toHaveLength(1);
  recents.updateAgents([{...agents[0], name: 'Renamed'}]);
  expect(buttons()).toHaveLength(1); expect(buttons()[0].title).toContain('Renamed');
  expect(document.querySelectorAll('#recentChats .recent-chat--empty')).toHaveLength(2);
});
test('keeps shared and personal chats for the same agent separate and opens them through the correct route', async () => {
  const recents = boot(); recents.remember('a'); recents.remember('a', shared);
  expect(buttons()).toHaveLength(2);
  buttons()[0].click(); await settle();
  expect(window.fetch).toHaveBeenCalledWith('/api/user/chat-threads/room', expect.objectContaining({cache:'no-store'}));
  expect(window.DashboardHelpers.selectChatContext).toHaveBeenCalledWith(shared);
  buttons()[1].click(); await settle();
  expect(window.selectAgent).toHaveBeenCalledWith('a', 'Agent a', expect.objectContaining({forceMainSelection: true}));
});
test.each([403,404,503])('handles shared lookup failure (%s) without opening the wrong chat', async status => {
  const recents = boot(); recents.remember('a', shared);
  window.fetch.mockResolvedValue({ok:false,status}); buttons()[0].click(); await settle();
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
  expect(window.showError).toHaveBeenCalled();
  expect(buttons()).toHaveLength(status === 503 ? 1 : 0);
  if (status === 503) expect(buttons()[0].disabled).toBe(false);
});
test('a late shared response cannot override a newer manual chat selection', async () => {
  const recents = boot(); recents.remember('a', shared); let release;
  window.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  buttons()[0].click(); window.DashboardHelpers.getChatSelectionVersion.mockReturnValue(2);
  release({ok:true,json:async()=>shared}); await settle();
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
});
test('a stalled shared lookup times out and allows retry without losing the shortcut', async () => {
  jest.useFakeTimers();
  try {
    const recents = boot(); recents.remember('a', shared);
    window.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), {name:'AbortError'})));
    }));
    buttons()[0].click(); expect(buttons()[0].disabled).toBe(true);
    jest.advanceTimersByTime(15000); await settle();
    expect(buttons()[0].disabled).toBe(false);
    expect(window.showError).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
test('another account cannot see saved chat history', () => {
  const recents = boot(); recents.remember('a');
  document.getElementById('dashboardRoot').dataset.userId = 'other'; recents.updateAgents(agents);
  expect(buttons()).toHaveLength(0);
});
test.each(['null', '{bad', '{}', '[null,{}, {"agentId":"__ALL__"}]'])('invalid history is ignored (%s)', raw => {
  localStorage.setItem(key, raw); boot(); expect(buttons()).toHaveLength(0);
});
test('chat names render as text and unchanged refreshes preserve focus', () => {
  const recents = boot(); recents.remember('a');
  recents.updateAgents([{...agents[0],name:'<img src=x onerror=alert(1)>'}]);
  buttons()[0].focus(); const first = buttons()[0]; recents.updateAgents([{...agents[0],name:'<img src=x onerror=alert(1)>'}]);
  expect(document.activeElement).toBe(first); expect(document.querySelector('#recentChats img')).toBeNull();
});
test('denied storage still allows a usable in-memory list', () => {
  const get = jest.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('Denied');});
  const set = jest.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Denied');});
  try { const recents = boot(); recents.remember('a'); expect(buttons()).toHaveLength(1); }
  finally { get.mockRestore(); set.mockRestore(); }
});
