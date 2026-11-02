/**
 * @jest-environment jsdom
 */
const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const source = dashboard.slice(dashboard.indexOf('function renderAgentLineageStat('), dashboard.indexOf('function formatAgentStatsHeartbeat('));
const templates = ['../../views/dashboard.ejs', '../../views/partials/agent-actions.ejs']
  .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'));

function setup(agents = []) {
  const selectAgent = jest.fn(), hideFloatingAgentMenu = jest.fn();
  const api = new Function('selectAgent', 'hideFloatingAgentMenu', 'findCachedAgentRecord', 'getChatNavigationMetadata',
    source + ';return { renderAgentLineageStat };')(
    selectAgent, hideFloatingAgentMenu, id => agents.find(agent => agent.agentId === id) || null, agent => ({ agentType: agent.agentType }));
  document.body.innerHTML = `<div id="agentContextMenu"><div class="agent-menu-stats">
    <div data-agent-lineage-row hidden><span data-agent-stat="parent">—</span></div>
    <div data-agent-lineage-row hidden><span data-agent-stat="children">—</span></div></div></div>`;
  return { ...api, selectAgent, hideFloatingAgentMenu,
    parent: document.querySelector('[data-agent-stat="parent"]'), children: document.querySelector('[data-agent-stat="children"]') };
}

test('both agent menus have Created by and Child agents rows, hidden by default', () => {
  for (const html of templates) {
    expect(html).toMatch(/data-agent-lineage-row hidden><span[^>]*>Created by<\/span><span[^>]*data-agent-stat="parent"/);
    expect(html).toMatch(/data-agent-lineage-row hidden><span[^>]*>Child agents<\/span><span[^>]*data-agent-stat="children"/);
  }
});

test('shows the parent and children as links that open their chats', () => {
  const api = setup([{ agentId: 'child-1', name: 'Child One', agentType: 'standard' }]);
  api.renderAgentLineageStat(api.parent, [{ agentId: 'parent-1', agentName: 'Parent' }]);
  api.renderAgentLineageStat(api.children, [{ agentId: 'child-1', agentName: 'Child One' }, { agentId: 'child-2', agentName: '<b>Two</b>' }]);

  expect(api.parent.closest('[data-agent-lineage-row]').hidden).toBe(false);
  expect(api.children.textContent).toBe('Child One, <b>Two</b>');
  expect(api.children.querySelector('b')).toBeNull();

  api.children.querySelector('button').click();
  expect(api.hideFloatingAgentMenu).toHaveBeenCalled();
  expect(document.getElementById('agentContextMenu').classList.contains('hidden')).toBe(true);
  expect(api.selectAgent).toHaveBeenCalledWith('child-1', 'Child One', { agentType: 'standard' });

  api.parent.querySelector('button').click();
  expect(api.selectAgent).toHaveBeenLastCalledWith('parent-1', 'Parent', { forceMainSelection: true });
});

test('keeps rows hidden for agents without lineage and while loading', () => {
  const api = setup();
  api.renderAgentLineageStat(api.parent, '...');
  expect(api.parent.closest('[data-agent-lineage-row]').hidden).toBe(true);
  api.renderAgentLineageStat(api.parent, []);
  api.renderAgentLineageStat(api.children, []);
  expect(api.parent.closest('[data-agent-lineage-row]').hidden).toBe(true);
  expect(api.children.closest('[data-agent-lineage-row]').hidden).toBe(true);
});
