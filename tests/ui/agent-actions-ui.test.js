const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');

const partial = fs.readFileSync(path.join(__dirname, '../../views/partials/agent-actions.ejs'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/agent-actions-ui.js'), 'utf8');
let dom;
const flags = { shared: process.env.FEATURE_SHARED_CONVERSATIONS, guest: process.env.FEATURE_GUEST_SHARING, inPlace: process.env.FEATURE_IN_PLACE_AGENT_SHARING };
afterEach(() => {
  dom?.window.close();
  for (const [key, value] of [['FEATURE_SHARED_CONVERSATIONS', flags.shared], ['FEATURE_GUEST_SHARING', flags.guest], ['FEATURE_IN_PLACE_AGENT_SHARING', flags.inPlace]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function setup({ guest = true, shared = true, inPlace = false } = {}) {
  process.env.FEATURE_IN_PLACE_AGENT_SHARING = String(inPlace);
  process.env.FEATURE_SHARED_CONVERSATIONS = String(shared);
  process.env.FEATURE_GUEST_SHARING = String(guest);
  dom = new JSDOM(ejs.render(partial) + `<div id="dashboardRoot">
    <div class="agent-list-item" data-agent-id="agent-one" data-agent-name="Design Agent"><div class="agent-list-item__avatar">DA</div></div>
    <div class="agent-seat" data-agent-id="agent-two" data-agent-name="Other Agent"><div class="agent-avatar">OA</div></div>
  </div>`, { url: 'https://space.example/dashboard', runScripts: 'outside-only' });
  const menu = dom.window.document.getElementById('floatingAgentMenu');
  menu.getBoundingClientRect = () => ({ width: 304, height: 360 });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  dom.window.eval(script);
  dom.window.DashboardHelpers = {
    openAgentActionsMenu: jest.fn(async (id, name, metadata, anchor) => dom.window.AgentActionsUI.position(anchor.getBoundingClientRect(), id, { name })),
    hideAgentActionsMenu: jest.fn()
  };
  return menu;
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

test('pressing a sidebar icon opens actions for that agent without firing the row click', async () => {
  const menu = setup();
  const icon = dom.window.document.querySelector('.agent-list-item__avatar');
  const rowClick = jest.fn();
  icon.parentElement.addEventListener('click', rowClick);
  icon.click();
  await settle();
  expect(rowClick).not.toHaveBeenCalled();
  expect(menu.classList.contains('hidden')).toBe(false);
  expect(menu.dataset.agentId).toBe('agent-one');
  expect(dom.window.document.getElementById('floatingShareAgentBtn').hidden).toBe(false);
  expect(icon.getAttribute('aria-label')).toBe('Actions for Design Agent');
});

test('sharing is bound to the pressed icon and presents both entry paths', async () => {
  const menu = setup();
  dom.window.document.querySelector('.agent-avatar').click();
  await settle();
  dom.window.document.getElementById('floatingShareAgentBtn').click();
  expect(menu.classList.contains('hidden')).toBe(true);
  expect(dom.window.document.getElementById('agentShareDialog').open).toBe(true);
  expect(dom.window.document.getElementById('agentShareName').textContent).toBe('Other Agent');
  expect(dom.window.document.getElementById('agentShareChatLink').getAttribute('href')).toBe('/shared?agentId=agent-two');
  expect(dom.window.document.getElementById('agentShareGuestLink').getAttribute('href')).toBe('/guest-sharing?agentId=agent-two');
});

test('in-place icon sharing opens the ordinary conversation panel and omits the old sharing chooser', async () => {
  const menu = setup({ inPlace: true });
  const panel = dom.window.document.createElement('div');
  panel.id = 'shareExistingChatDialog';
  dom.window.document.body.append(panel);
  const openForAgent = jest.fn();
  dom.window.AgentChatSharing = { openForAgent };
  dom.window.document.querySelector('.agent-avatar').click();
  await settle();
  dom.window.document.getElementById('floatingShareAgentBtn').click();
  await settle();
  expect(openForAgent).toHaveBeenCalledWith('agent-two', 'Other Agent');
  expect(menu.classList.contains('hidden')).toBe(true);
  expect(dom.window.document.getElementById('agentShareDialog')).toBeNull();
});

test('keyboard entry, Escape and dialog close return focus to the icon', async () => {
  const menu = setup();
  const icon = dom.window.document.querySelector('.agent-list-item__avatar');
  icon.focus();
  icon.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(menu.contains(dom.window.document.activeElement)).toBe(true);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menu.classList.contains('hidden')).toBe(true);
  expect(dom.window.document.activeElement).toBe(icon);
  icon.click();
  await settle();
  dom.window.document.getElementById('floatingShareAgentBtn').click();
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(dom.window.document.getElementById('agentShareDialog').open).toBe(false);
  expect(dom.window.document.activeElement).toBe(icon);
});

test('icons inserted by a background refresh remain accessible and open the menu', async () => {
  const menu = setup();
  dom.window.document.getElementById('dashboardRoot').innerHTML = '<div class="agent-list-item" data-agent-id="fresh-agent" data-agent-name="Fresh Agent"><div class="agent-list-item__avatar">FA</div></div>';
  await settle();
  const icon = dom.window.document.querySelector('.agent-list-item__avatar');
  expect(icon.tabIndex).toBe(0);
  icon.click();
  await settle();
  expect(menu.dataset.agentId).toBe('fresh-agent');
});

test('measured menu dimensions keep it inside a narrow viewport', () => {
  const menu = setup();
  Object.defineProperty(dom.window, 'innerWidth', { value: 320 });
  Object.defineProperty(dom.window, 'innerHeight', { value: 480 });
  dom.window.AgentActionsUI.position({ left: 295, bottom: 450, top: 400 }, 'agent-one');
  expect(menu.style.maxWidth).toBe('296px');
  expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
  expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(12);
  expect(parseFloat(menu.style.top) + 360).toBeLessThanOrEqual(468);
});

test('feature flags and non-shareable agent types hide unavailable sharing paths', () => {
  setup({ guest: false });
  expect(dom.window.document.getElementById('agentShareGuestLink')).toBeNull();
  dom.window.AgentActionsUI.position({ left: 0, top: 0, bottom: 0 }, 'news-agent', { shareable: false });
  expect(dom.window.document.getElementById('floatingShareAgentBtn').hidden).toBe(true);
  dom.window.close();
  setup({ shared: false });
  expect(dom.window.document.getElementById('floatingShareAgentBtn')).toBeNull();
  expect(dom.window.document.getElementById('agentShareDialog')).toBeNull();
});
