/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const source = dashboard.slice(dashboard.indexOf('function findCouncilGroupDropTarget('), dashboard.indexOf('function setupOrbitDragHandlers('));
function setup(response = { ok: true }) {
  const groups = [{ groupId: 'group-one', groupName: 'Work', memberIds: [] }, { groupId: 'other', memberIds: ['agent-one'] }];
  const fetcher = jest.fn().mockResolvedValue(response), render = jest.fn(), error = jest.fn();
  const api = new Function('currentGroups', 'currentAgentList', 'csrfFetch', 'updateAgentListUI', 'showSuccessMessage', 'showErrorMessage',
    'let cachedGroupPartition=null;\n' + source + ';return {addAgentToCouncilGroup,findCouncilGroupDropTarget};')(
    groups, [{ agentId: 'agent-one' }], fetcher, render, jest.fn(), error);
  return { ...api, groups, fetcher, render, error };
}
test('dropping into a group adds membership once and keeps existing group memberships', async () => {
  const api = setup();
  await Promise.all([api.addAgentToCouncilGroup('agent-one', 'group-one'), api.addAgentToCouncilGroup('agent-one', 'group-one')]);
  expect(api.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(api.fetcher.mock.calls[0][1].body)).toEqual({ agentIds: ['agent-one'] });
  expect(api.groups.map(group => group.memberIds)).toEqual([['agent-one'], ['agent-one']]);
});
test('failed updates do not change local memberships and can be retried', async () => {
  const api = setup({ ok: false, json: async () => ({ error: { message: 'Try again' } }) });
  await api.addAgentToCouncilGroup('agent-one', 'group-one');
  expect(api.groups[0].memberIds).toEqual([]); expect(api.error).toHaveBeenCalledWith('Try again');
  await api.addAgentToCouncilGroup('agent-one', 'group-one'); expect(api.fetcher).toHaveBeenCalledTimes(2);
});
test('only a visible group under the pointer is a valid drop target', () => {
  document.body.innerHTML = '<div class="group-seat" data-group-id="group-one"></div>';
  const element = document.querySelector('.group-seat');
  element.getBoundingClientRect = () => ({ left: 10, right: 60, top: 20, bottom: 70, width: 50, height: 50 });
  const api = setup(); expect(api.findCouncilGroupDropTarget(30, 40)).toBe(element);
  expect(api.findCouncilGroupDropTarget(5, 5)).toBeNull();
});
