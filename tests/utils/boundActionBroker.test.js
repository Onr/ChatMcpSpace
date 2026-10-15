const crypto = require('crypto');
const { BoundActionBroker, actionDigest, hash } = require('../../src/shared/boundActionBroker');

let context, record, persist, api, execute, controller, broker, reply;
const descriptor = () => ({ name: 'workspace.execute', resource: 'Fixture', destination: null,
  parameters: { argv: ['node', 'fixture.js'], stdinSha256: hash('invented input'), maxRuntimeMs: 10000, readOnly: true } });
beforeEach(() => {
  context = { request: { taskId: crypto.randomUUID() }, execution: { executorId: crypto.randomUUID() },
    authorization: { grantId: crypto.randomUUID(), policyRevision: 3, deviceEpoch: 2 } };
  record = {}; persist = jest.fn(); controller = new AbortController();
  execute = jest.fn(async () => 'fixture output');
  api = jest.fn(async (route, body) => {
    if (route.endsWith('/actions')) {
      const { actionId, ...action } = body;
      reply = { actionId, taskId: context.request.taskId, digest: actionDigest(context, action), ...action,
        approvalState: 'not_required', outcome: null, expiresAt: new Date(Date.now() + 10000).toISOString() };
      return reply;
    }
    if (route.endsWith('/start')) return { ...reply, outcome: 'running', executionNonce: crypto.randomUUID() };
    if (route.endsWith('/complete')) return { ...reply, ...body };
    throw Error('Unexpected fixture API request');
  });
  broker = new BoundActionBroker({ context, record, persist, api, signal: controller.signal, confirmedStopped: () => true });
});

test('records consumption before execution and confirms an exact retained output receipt', async () => {
  execute.mockImplementation(async () => {
    expect(record.phase).toBe('executing');
    expect(api.mock.calls.filter(([route]) => route.endsWith('/start'))).toHaveLength(1);
    return 'fixture output';
  });
  expect(await broker.run(descriptor(), execute)).toBe('fixture output');
  expect(record).toMatchObject({ phase: 'completed', completion: { outcome: 'succeeded',
    receipt: { confirmedStopped: true, outputHash: hash('fixture output') } } });
  expect(execute).toHaveBeenCalledTimes(1);
});

test('waits for the owner decision without executing or accepting a requester boolean', async () => {
  const base = api; let proposals = 0;
  broker.api = jest.fn(async (route, body) => {
    const result = await base(route, body);
    if (route.endsWith('/actions')) return { ...result, approved: true, approvalState: ++proposals === 1 ? 'pending' : 'approved' };
    return { ...result, approvalState: 'approved' };
  });
  broker.wait = jest.fn(async () => { expect(execute).not.toHaveBeenCalled(); expect(record.phase).toBe('waiting_for_approval'); });
  await broker.run(descriptor(), execute);
  const bodies = broker.api.mock.calls.filter(([route]) => route.endsWith('/actions')).map(([, body]) => body);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each(['denied', 'revoked'])('%s approval never executes', async approvalState => {
  const base = api; broker.api = async (route, body) => ({ ...await base(route, body), approvalState });
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('denied or revoked');
  expect(execute).not.toHaveBeenCalled();
});

test.each(['actionId', 'taskId', 'digest', 'name', 'resource', 'destination'])('changed %s cannot authorize a launch', async field => {
  const base = api; broker.api = async (route, body) => ({ ...await base(route, body), [field]: 'changed' });
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('does not match');
  expect(execute).not.toHaveBeenCalled();
});

test('expired action and cancellation during approval prevent consumption', async () => {
  const base = api;
  broker.api = async (route, body) => ({ ...await base(route, body), expiresAt: new Date(Date.now() - 1).toISOString() });
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('expired');
  expect(execute).not.toHaveBeenCalled();
  record = {}; broker.record = record; broker.api = async (route, body) => ({ ...await base(route, body), approvalState: 'pending' });
  broker.wait = async () => controller.abort(Error('Revoked while waiting'));
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('Revoked while waiting');
  expect(api.mock.calls.some(([route]) => route.endsWith('/start'))).toBe(false);
});

test('a lost start reply preserves intent and cannot launch or replay after restart', async () => {
  const base = api;
  broker.api = async (route, body) => {
    if (route.endsWith('/start')) { expect(record.phase).toBe('start_pending'); throw Error('Start reply lost'); }
    return base(route, body);
  };
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('Start reply lost');
  const restored = new BoundActionBroker({ context, record: JSON.parse(JSON.stringify(record)), persist, api,
    signal: controller.signal, confirmedStopped: () => true });
  await expect(restored.run(descriptor(), execute)).rejects.toThrow('cannot be replayed');
  expect(execute).not.toHaveBeenCalled();
});

test.each([null, 'forged-nonce'])('missing or malformed execution nonce %s never launches', async executionNonce => {
  const base = api;
  broker.api = async (route, body) => {
    const result = await base(route, body);
    return route.endsWith('/start') ? { ...result, executionNonce } : result;
  };
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('start was not confirmed');
  expect(execute).not.toHaveBeenCalled();
});

test('original parameter mutation during approval cannot change the recorded action', async () => {
  const action = descriptor(), base = api;
  broker.api = async (route, body) => { action.parameters.argv[0] = 'changed'; return base(route, body); };
  await broker.run(action, execute);
  expect(record.descriptor.parameters.argv).toEqual(['node', 'fixture.js']);
});

test.each([true, false])('execution error retains stopped=%s without guessing absence from error properties', async stopped => {
  broker.confirmedStopped = () => stopped;
  execute.mockRejectedValue(Object.assign(Error('Execution failed'), { cleanupConfirmed: true }));
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('Execution failed');
  expect(record.completion).toMatchObject({ outcome: stopped ? 'failed' : 'outcome_uncertain', receipt: { confirmedStopped: stopped } });
  expect(execute).toHaveBeenCalledTimes(1);
});

test.each([false, undefined, Promise.resolve(true)])('returned output is held when stop evidence is %s', async stopped => {
  broker.confirmedStopped = () => stopped;
  await expect(broker.run(descriptor(), execute)).rejects.toMatchObject({ code: 'RESTRICTED_CANCEL_UNCERTAIN' });
  expect(record).toMatchObject({ phase: 'completed', completion: {
    outcome: 'outcome_uncertain', receipt: { confirmedStopped: false, outputHash: hash('fixture output') }
  } });
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('cannot be replayed');
  expect(execute).toHaveBeenCalledTimes(1);
});

test('a failed stop observer still retains and acknowledges an uncertain receipt', async () => {
  broker.confirmedStopped = () => { throw Error('Stop observer unavailable'); };
  await expect(broker.run(descriptor(), execute)).rejects.toMatchObject({ code: 'RESTRICTED_CANCEL_UNCERTAIN' });
  expect(record).toMatchObject({ phase: 'completed', completion: {
    outcome: 'outcome_uncertain', receipt: { confirmedStopped: false }
  } });
  expect(api.mock.calls.filter(([route]) => route.endsWith('/complete'))).toHaveLength(1);
});

test('completion transport failure replays only the same receipt after restart and expiry', async () => {
  const base = api;
  broker.api = async (route, body) => { if (route.endsWith('/complete')) throw Error('Receipt reply lost'); return base(route, body); };
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('Receipt reply lost');
  expect(record.phase).toBe('receipt_pending');
  const restoredRecord = JSON.parse(JSON.stringify(record));
  const recoveredApi = jest.fn(async (route, body) => ({ ...await base(route, body), expiresAt: new Date(Date.now() - 1).toISOString() }));
  const recovered = new BoundActionBroker({ context, record: restoredRecord, persist, api: recoveredApi });
  await recovered.flushReceipt();
  expect(restoredRecord.phase).toBe('completed'); expect(execute).toHaveBeenCalledTimes(1);
  expect(recoveredApi.mock.calls).toEqual([[`/tasks/${context.request.taskId}/actions/${record.actionId}/complete`, record.completion]]);
});

test.each(['executionNonce', 'digest', 'outcome', 'receipt'])('changed completion %s preserves the pending receipt', async field => {
  const base = api;
  broker.api = async (route, body) => {
    const result = await base(route, body);
    return route.endsWith('/complete') ? { ...result, [field]: field === 'receipt' ? {} : 'changed' } : result;
  };
  await expect(broker.run(descriptor(), execute)).rejects.toThrow('does not match the retained outcome');
  expect(record.phase).toBe('receipt_pending'); expect(execute).toHaveBeenCalledTimes(1);
});
