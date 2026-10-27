/** @jest-environment jsdom */
const fs = require('fs');
const read = name => fs.readFileSync(require('path').join(__dirname, '../../public/js', name), 'utf8');
let queued;
const rect = (left, top, width=40, height=40) => ({left,top,width,height});
const contexts = [
  {agentId:'remote', agentName:'Shared <agent>', conversationId:'room', mode:'shared', role:'participant', membershipStatus:'active'},
  {agentId:'a', agentName:'Mine', mode:'shared', role:'owner'}
];
beforeEach(() => {
  document.body.innerHTML = '<div id="councilCircle"><div class="agent-seat" data-agent-id="a"><div class="agent-avatar"></div></div><div class="group-seat" data-group-id="group"></div></div><div data-agent-id="b" style="display:none">hidden list row</div>';
  queued = [];
  window.requestAnimationFrame = jest.fn(fn => {queued.push(fn); return queued.length;});
  window.cancelAnimationFrame = jest.fn();
  window.__dashboardLoopPaused = true;
  window.fetch = jest.fn();
  document.getElementById('councilCircle').getBoundingClientRect = () => rect(0,0,400,400);
  document.querySelector('.agent-avatar').getBoundingClientRect = () => rect(180,0);
  document.querySelector('.group-seat').getBoundingClientRect = () => rect(180,360);
  window.eval(read('council-sharing.js'));
  window.eval(read('agentConnections.js'));
});
afterEach(() => {window.AgentConnections.destroy();window.CouncilSharing.destroy();});
function flush() {const frames=queued; queued=[];frames.forEach(fn=>fn());}
function setup() {
  window.CouncilSharing.updateOrbit([{agentId:'a'},{agentId:'b'}], [{groupId:'group', groupName:'Work', memberIds:['b','c']}], null);
  window.CouncilSharing.updateContexts(contexts);flush();
}
async function load(connections) {
  window.fetch.mockResolvedValue({ok:true,json:async()=>({connections,messages:[]})});
  await window.AgentConnections.refresh();
}
const connection = (a='a',b='b') => ({agent1Id:a,agent2Id:b,agent1Name:'One',agent2Name:'Two',messageCount:3,lastMessage:new Date().toISOString(),lastSenderId:a});
test('galaxy is one accessible button with a shared-out badge on the owned ball', () => {
  setup();
  expect(document.getElementById('sharedGalaxy').getAttribute('aria-label')).toContain('1 shared');
  expect(document.querySelectorAll('.agent-share-badge')).toHaveLength(1);
  window.CouncilSharing.updateContexts(contexts);flush();
  expect(document.querySelectorAll('#sharedGalaxy')).toHaveLength(1);
});
test('galaxy opens escaped names, traps focus, closes with Escape and restores focus', () => {
  setup();const trigger=document.getElementById('sharedGalaxy');trigger.focus();trigger.click();
  expect(document.querySelector('[role=dialog]').textContent).toContain('Shared <agent>');
  expect(document.querySelector('[role=dialog] agent')).toBeNull();
  const close=document.querySelector('.shared-galaxy-close');
  close.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
  expect(document.activeElement.className).toBe('shared-galaxy-agent');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  expect(document.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(trigger);
});
test('unchanged polling does not close the open picker', () => {
  setup();window.CouncilSharing.open();window.CouncilSharing.updateContexts(contexts);flush();
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
});
test('selecting a shared agent rechecks current access and opens its actual context', async () => {
  setup();window.CouncilSharing.open();
  window.fetch.mockResolvedValue({ok:true,json:async()=>contexts[0]});
  window.DashboardHelpers={selectChatContext:jest.fn().mockResolvedValue()};
  document.querySelector('.shared-galaxy-agent').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(window.DashboardHelpers.selectChatContext).toHaveBeenCalledWith(contexts[0]);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
test('revoked shared access shows an error without opening stale context', async () => {
  setup();window.CouncilSharing.open();window.fetch.mockResolvedValue({ok:false});
  window.DashboardHelpers={selectChatContext:jest.fn()};document.querySelector('.shared-galaxy-agent').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(window.DashboardHelpers.selectChatContext).not.toHaveBeenCalled();
  expect(document.querySelector('[role=status]').textContent).toContain('no longer available');
});
test('opposite nodes have finite curved geometry and use visible group instead of hidden list', async () => {
  setup();await load([connection()]);
  const path=document.querySelector('.a2a-link__flow');
  expect(path).not.toBeNull();expect(path.getAttribute('d')).not.toMatch(/NaN|Infinity/);
  expect(path.getAttribute('d')).toContain('200 380');
});
test('hidden members in the same group produce no misleading loop', async () => {
  setup();await load([connection('b','c')]);expect(document.querySelectorAll('.a2a-link')).toHaveLength(0);
});
test('messages across the same group pair aggregate into one trail', async () => {
  setup();await load([connection(),connection('a','c')]);
  expect(document.querySelectorAll('.a2a-link')).toHaveLength(1);
  expect(document.querySelector('.a2a-link title').textContent).toContain('6 messages');
});
test('last sender determines flow direction', async () => {
  setup();await load([{...connection(),lastSenderId:'b'}]);
  expect(document.querySelector('.a2a-link__flow').getAttribute('d')).toMatch(/^M 200 380/);
});
test('group zoom provides a gateway for an external group', () => {
  setup();window.CouncilSharing.updateConnections([connection('a','z')]);window.CouncilSharing.updateOrbit([], [{groupId:'group',groupName:'Work',memberIds:['a']},{groupId:'other',groupName:'Other',memberIds:['z']}], 'group');flush();
  expect(document.querySelector('.a2a-group-gateway').textContent).toBe('Other');
});
test('shared endpoints connect to galaxy, and revoked contexts remove it', async () => {
  setup();document.getElementById('sharedGalaxy').getBoundingClientRect=()=>rect(0,0,100,80);
  await load([connection('a','remote')]);expect(document.querySelectorAll('.a2a-link')).toHaveLength(1);
  window.CouncilSharing.updateContexts([]);flush();flush();
  expect(document.getElementById('sharedGalaxy').hidden).toBe(true);expect(document.querySelectorAll('.agent-share-badge')).toHaveLength(0);
});
test('motion respects reduced motion and fast mode without animation frame loops', () => {
  const css=fs.readFileSync(require('path').join(__dirname,'../../public/css/council-sharing.css'),'utf8');
  expect(css).toContain('prefers-reduced-motion:reduce');expect(css).toContain('body.dashboard-fast-mode');
  setup();flush();expect(queued).toHaveLength(0);
});
test('galaxy keyboard controls do not activate council navigation or delete shortcuts', () => {
  const source=read('dashboard.js');const start=source.indexOf('function setupKeyboardNavigation()');const end=source.indexOf('function setFocusArea(area)',start);
  let listener;const vm=require('vm');
  const scope={document:{addEventListener:(_event,fn)=>{listener=fn;}}};vm.createContext(scope);vm.runInContext(source.slice(start,end)+'\nsetupKeyboardNavigation();',scope);
  setup();const target=document.getElementById('sharedGalaxy');
  for(const key of ['Enter','ArrowRight','Delete','Tab']) expect(()=>listener({key,target})).not.toThrow();
});
test('agent chat shows queued offline status and refreshes to confirmed receipt', async () => {
  document.body.insertAdjacentHTML('beforeend', '<div id="agentChatsScroll"></div><div id="agentPanelHeader"></div><div id="conversationArea"></div><div id="agentInputBox"></div>');
  const conn = { ...connection(), pendingCount: 1 };
  const message = { messageId: 'task', senderId: 'a', recipientId: 'b', content: 'Please fix this error', timestamp: new Date().toISOString(), delivery: { state: 'pending', recipientOnline: false } };
  window.fetch.mockResolvedValue({ ok: true, json: async () => ({ connections: [conn], messages: [message] }) });
  await window.AgentConnections.refresh();
  expect(document.getElementById('agentChatsScroll').textContent).toContain('1 pending');
  document.querySelector('.agent-chat-item').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('conversationArea').textContent).toContain('Queued · recipient offline');
  const bubble = document.querySelector('[data-direct-message-id]');
  document.getElementById('conversationArea').scrollTop = 123;
  window.fetch.mockResolvedValue({ ok: true, json: async () => ({ connections: [{ ...conn, pendingCount: 0 }], messages: [{ ...message, delivery: { state: 'received', recipientOnline: true } }] }) });
  await window.AgentConnections.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('conversationArea').textContent).toContain('Received by agent');
  expect(document.getElementById('agentChatsScroll').textContent).not.toContain('pending');
  expect(document.querySelector('[data-direct-message-id]')).toBe(bubble);
  expect(document.getElementById('conversationArea').scrollTop).toBe(123);
});
