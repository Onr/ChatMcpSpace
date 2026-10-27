/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
function context() {
  const replies = [];
  const scope = {
    currentAgentList: [{ agentId: 'a', position: 1 }, { agentId: 'b', position: 2 }],
    orbitPositionRevision: 0, orbitPositionSave: Promise.resolve(),
    pendingOrbitPositions: new Map(), confirmedOrbitPositions: new Map(), agentListCache: {}, cachedGroupPartition: {},
    window: { csrfToken: 'csrf' }, updateAgentListUI: jest.fn(), showErrorMessage: jest.fn(),
    csrfFetch: jest.fn(() => new Promise(resolve => replies.push(resolve))),
    Date, console
  };
  vm.createContext(scope);
  const start = source.indexOf('function applyOrbitPositionUpdates(');
  vm.runInContext(source.slice(start, source.indexOf('\n/**', start)), scope);
  return { scope, replies };
}
const order = (a, b) => [{ agentId: 'a', position: a }, { agentId: 'b', position: b }];
test('drag reorder is immediate and consecutive saves are serialized', async () => {
  const { scope, replies } = context();
  const first = scope.applyOrbitPositionUpdates(order(2, 1));
  expect(scope.currentAgentList).toEqual(order(2, 1));
  await Promise.resolve();
  const second = scope.applyOrbitPositionUpdates(order(1, 2));
  expect(scope.currentAgentList).toEqual(order(1, 2));
  expect(scope.csrfFetch).toHaveBeenCalledTimes(1);
  replies.shift()({ ok: true }); await first; await Promise.resolve();
  expect(scope.csrfFetch).toHaveBeenCalledTimes(2);
  expect(scope.currentAgentList).toEqual(order(1, 2));
  replies.shift()({ ok: true }); await second;
  expect(scope.pendingOrbitPositions.size).toBe(0);
});
test('two rejected saves restore the last confirmed order and leave the next drag usable', async () => {
  const { scope, replies } = context();
  const first = scope.applyOrbitPositionUpdates(order(2, 1)); await Promise.resolve();
  const second = scope.applyOrbitPositionUpdates(order(3, 4));
  const fail = { ok: false, json: async () => ({ error: { message: 'Save failed' } }) };
  replies.shift()(fail); await first; await Promise.resolve();
  replies.shift()(fail); await second;
  expect(scope.currentAgentList).toEqual(order(1, 2));
  const third = scope.applyOrbitPositionUpdates(order(2, 1)); await Promise.resolve();
  replies.shift()({ ok: true }); await third;
  expect(scope.currentAgentList).toEqual(order(2, 1));
});
test('a stale agent poll cannot overwrite a pending or just-saved drag', async () => {
  const { scope, replies } = context();
  const save = scope.applyOrbitPositionUpdates(order(2, 1));
  const start = source.indexOf('    const agents = data.agents || [];');
  const merge = source.slice(start, source.indexOf('    agentPollNextDelayMs =', start));
  scope.data = { agents: order(1, 2) }; scope.positionRevision = 0; scope.positionsWerePending = true;
  vm.runInContext(`{ ${merge} result = agents; }`, scope);
  expect(scope.result).toEqual(order(2, 1));
  await Promise.resolve(); replies.shift()({ ok: true }); await save;
  scope.data = { agents: order(1, 2) };
  vm.runInContext(`{ ${merge} result = agents; }`, scope);
  expect(scope.result).toEqual(order(2, 1));
});
