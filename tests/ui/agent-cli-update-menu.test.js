/** @jest-environment jsdom */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const functions = source.slice(source.indexOf('function showAgentCliUpdateBatchDialog('), source.indexOf('async function sendAgentUpdateConfirmation('));
let scope;
const outdated = (agentId, active = false) => ({ agentId, name: agentId, active, needsCliUpdate: true, latestCliVersion: '1.5.16', reportedCliVersion: '1.5.15' });
beforeEach(() => {
  document.body.innerHTML = `
    <div id="agentCliUpdateModal" class="hidden"><div id="agentCliUpdateList"></div>
    <p id="agentCliUpdateSummary"></p><input type="checkbox" id="agentCliUpdateSelectAll">
    <span id="agentCliUpdateSelectedCount"></span><button id="agentCliUpdateConfirmBtn"></button>
    <button id="agentCliUpdateCancelBtn"></button></div>
    <div id="floatingAgentMenu" data-agent-id="other"></div><div id="agentContextMenu"></div>
    <button id="updateAgentBtn"></button><button id="floatingUpdateAgentBtn"></button>`;
  const records = [outdated('selected'), outdated('other', true), { agentId: 'latest', needsCliUpdate: false }];
  scope = vm.createContext({ document, pendingAgentUpdateBatch: [], selectedAgentId: 'selected',
    isAgentActive: agent => agent.active,
    escapeHtml: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    findCachedAgentRecord: id => records.find(agent => agent.agentId === id),
    hideFloatingAgentMenu: jest.fn(), showErrorMessage: jest.fn(), queueAgentCliSelfUpdates: jest.fn() });
  vm.runInContext(functions, scope);
});
test('lists active agents first and starts with no agents selected', () => {
  scope.showAgentCliUpdateBatchDialog([outdated('z'), outdated('b', true), outdated('a', true)]);
  expect([...document.querySelectorAll('.agent-cli-update-checkbox')].map(el => el.value)).toEqual(['a', 'b', 'z']);
  expect(document.querySelectorAll(':checked')).toHaveLength(0);
  expect(document.getElementById('agentCliUpdateConfirmBtn').disabled).toBe(true);
  expect(document.getElementById('agentCliUpdateList').textContent).toContain('Inactive');
});
test('updates only explicitly checked agents, including inactive agents', () => {
  scope.setupAgentCliUpdateModal();
  scope.showAgentCliUpdateBatchDialog([outdated('a', true), outdated('b')]);
  const input = document.querySelector('input[value="b"]');
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.getElementById('agentCliUpdateSelectAll').indeterminate).toBe(true);
  document.getElementById('agentCliUpdateConfirmBtn').click();
  expect(scope.queueAgentCliSelfUpdates.mock.calls[0][0].map(agent => agent.agentId)).toEqual(['b']);
});
test('select all and dismiss work without sending unintended updates', () => {
  scope.setupAgentCliUpdateModal();
  scope.showAgentCliUpdateBatchDialog([outdated('a'), outdated('b')]);
  document.getElementById('agentCliUpdateSelectAll').click();
  expect(scope.getSelectedAgentCliUpdateAgents()).toHaveLength(2);
  document.getElementById('agentCliUpdateCancelBtn').click();
  expect(scope.queueAgentCliSelfUpdates).not.toHaveBeenCalled();
});
test('only outdated agents appear; menu update action targets its own agent', () => {
  scope.updateAgentCliMenuButton('updateAgentBtn', 'latest');
  expect(document.getElementById('updateAgentBtn').hidden).toBe(true);
  scope.updateAgentCliMenuButton('floatingUpdateAgentBtn', 'other');
  expect(document.getElementById('floatingUpdateAgentBtn').hidden).toBe(false);
  scope.setupAgentCliMenuButtons();
  document.getElementById('floatingUpdateAgentBtn').click();
  expect([...document.querySelectorAll('.agent-cli-update-checkbox')].map(el => el.value)).toEqual(['other']);
  expect(scope.showAgentCliUpdateBatchDialog([{ agentId: 'latest', needsCliUpdate: false }])).toBe(false);
});
test('agent names are escaped when rendered in the update popup', () => {
  scope.showAgentCliUpdateBatchDialog([{ ...outdated('a'), name: '<img src=x onerror=alert(1)>' }]);
  expect(document.querySelector('#agentCliUpdateList img')).toBeNull();
  expect(document.getElementById('agentCliUpdateList').textContent).toContain('<img');
});
