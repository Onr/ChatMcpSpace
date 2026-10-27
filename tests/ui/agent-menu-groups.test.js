/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const between = (start, end) => dashboard.slice(dashboard.indexOf(start), dashboard.indexOf(end));
const source = between('async function removeAgentFromGroup(', 'function hideGroupManagementMenu(') +
  between('const pendingCouncilGroupAdds', 'function setupOrbitDragHandlers(');

function setup(fetchResponse = { ok: true }) {
  document.body.innerHTML = '<div id="agentContextMenu"><div class="agent-menu-groups" data-agent-groups></div></div>' +
    '<div id="floatingAgentMenu"><div class="agent-menu-groups" data-agent-groups></div></div>';
  if (!global.CSS) global.CSS = { escape: value => String(value) };
  const groups = [
    { groupId: 'g-work', groupName: 'Work', memberIds: ['agent-one'] },
    { groupId: 'g-ops', groupName: 'Ops <b>"x', memberIds: [] }
  ];
  const agents = [{ agentId: 'agent-one', name: 'One' }];
  const fetcher = jest.fn().mockResolvedValue(fetchResponse);
  const success = jest.fn(), error = jest.fn(), createModal = jest.fn();
  const escapeHtml = (text) => { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; };
  const api = new Function('currentGroups', 'currentAgentList', 'csrfFetch', 'updateAgentListUI', 'showSuccessMessage',
    'showErrorMessage', 'escapeHtml', 'findCachedAgentRecord', 'hideFloatingAgentMenu', 'showCreateGroupModal', 'exitGroupView',
    'let cachedGroupPartition=null; let activeGroupId=null;\n' + source +
    ';return {renderAgentGroupMembership,toggleAgentGroupMembership,setupAgentGroupMembershipSections};')(
    groups, agents, fetcher, jest.fn(), success, error, escapeHtml,
    id => agents.find(agent => agent.agentId === id) || null, jest.fn(), createModal, jest.fn());
  api.setupAgentGroupMembershipSections();
  return { ...api, groups, fetcher, success, error, createModal };
}

const items = () => [...document.querySelectorAll('#agentContextMenu [data-agent-group-toggle]')];

test('menu lists every group with the agent membership checked', () => {
  const api = setup();
  api.renderAgentGroupMembership('agent-one');
  expect(document.querySelector('#agentContextMenu .agent-menu-groups__summary').textContent).toBe('In Work');
  expect(items().map(btn => [btn.getAttribute('data-agent-group-toggle'), btn.getAttribute('aria-checked')]))
    .toEqual([['g-ops', 'false'], ['g-work', 'true']]);
  expect(document.querySelector('#agentContextMenu b')).toBeNull();
  expect(items()[0].title).toBe('Add to Ops <b>"x');
  expect(document.querySelectorAll('#floatingAgentMenu [data-agent-group-toggle]')).toHaveLength(2);
});

test('clicking an unchecked group adds the agent; clicking a checked group removes it', async () => {
  const api = setup();
  api.renderAgentGroupMembership('agent-one');
  await api.toggleAgentGroupMembership('agent-one', 'g-ops');
  expect(api.fetcher.mock.calls[0][0]).toBe('/api/user/groups/g-ops/members');
  expect(api.groups[1].memberIds).toEqual(['agent-one']);
  await api.toggleAgentGroupMembership('agent-one', 'g-work');
  expect(api.fetcher.mock.calls[1][0]).toBe('/api/user/groups/g-work/members/agent-one');
  expect(api.fetcher.mock.calls[1][1].method).toBe('DELETE');
  expect(api.groups[0].memberIds).toEqual([]);
  expect(document.querySelector('#agentContextMenu .agent-menu-groups__summary').textContent).toBe('In Ops <b>"x');
});

test('a failed removal keeps the membership and shows an error', async () => {
  const api = setup({ ok: false, status: 500 });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  api.renderAgentGroupMembership('agent-one');
  await api.toggleAgentGroupMembership('agent-one', 'g-work');
  expect(api.groups[0].memberIds).toEqual(['agent-one']);
  expect(api.error).toHaveBeenCalled();
  expect(api.success).not.toHaveBeenCalled();
});

test('clicks inside the section do not bubble to the outside-click handlers', () => {
  const api = setup();
  api.renderAgentGroupMembership('agent-one');
  const outside = jest.fn();
  document.addEventListener('click', outside);
  items()[0].click();
  expect(outside).not.toHaveBeenCalled();
  document.removeEventListener('click', outside);
});

test('with no groups the menu offers to create one', () => {
  const api = setup();
  api.groups.length = 0;
  api.renderAgentGroupMembership('agent-one');
  expect(document.querySelector('#agentContextMenu .agent-menu-groups__summary').textContent).toBe('Not in any group');
  document.querySelector('#agentContextMenu [data-agent-group-create]').click();
  expect(api.createModal).toHaveBeenCalled();
});

test('the groups section is the last item in both agent menus', () => {
  const views = path.join(__dirname, '../../views');
  const lastChildClass = (file, menuId) => {
    const html = fs.readFileSync(path.join(views, file), 'utf8').replace(/<%[\s\S]*?%>/g, '');
    document.body.innerHTML = html;
    return document.getElementById(menuId).lastElementChild.className;
  };
  expect(lastChildClass('dashboard.ejs', 'agentContextMenu')).toBe('agent-menu-groups');
  expect(lastChildClass('partials/agent-actions.ejs', 'floatingAgentMenu')).toBe('agent-menu-groups');
});
