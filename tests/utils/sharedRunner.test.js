const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('../../public/js/shared-crypto');
const { RestrictedTaskFiles } = require('../../src/shared/restrictedExecutor');
const { actionDigest } = require('../../src/shared/boundActionBroker');
const {
  Bridge, open
} = require('../../scripts/external-agent-bridge');
const {
  SharedRunner,
  readApprovedExport
} = require('../../scripts/shared-agent-runner');
let dir, runner, invoke, room, user, batch, detail, messages, account, pair, key, outputStore, capacitySpy, storeSecuritySpy;
beforeAll(async () => {
  global.crypto = crypto.webcrypto;
  account = await C.newKey();
  pair = await C.identity(account, 'fixture');
}, 30000);
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-runner-test-'));
  outputStore = process.env.SHARED_TEST_OUTPUT_STORE || fs.mkdtempSync(path.join(os.tmpdir(), 'shared-output-store-fixture-'));
  if (!process.env.SHARED_TEST_OUTPUT_STORE) {
    const statfs = fs.statfsSync.bind(fs);
    capacitySpy = jest.spyOn(fs, 'statfsSync').mockImplementation(candidate => String(candidate).startsWith(outputStore) ?
      { type: 0x01021994, bsize: 4096, blocks: 4096, files: 128 } : statfs(candidate));
    // Protocol fixtures without a real tmpfs do not certify mount security.
    storeSecuritySpy = jest.spyOn(RestrictedTaskFiles.prototype, 'assertOutputStoreSecurity').mockImplementation(() => {});
  }
  room = crypto.randomUUID();
  user = crypto.randomUUID();
  key = await C.newKey();
  const state = {
    baseUrl: 'http://127.0.0.1:12345',
    agentName: 'Agent',
    agentId: crypto.randomUUID(),
    token: 'fixture',
    key: C.b64(await crypto.webcrypto.subtle.exportKey('raw', account)),
    history: {},
    pending: null
  };
  invoke = jest.fn(async () => JSON.stringify({
    replies: [{
      text: 'Done',
      toUserIds: [user]
    }]
  }));
  let fixtureAdmission;
  runner = new SharedRunner(new Bridge(state, {
    file: path.join(dir, 'state.json')
  }), [{
    provider: 'test',
    model: 'test',
    command: ['node', 'unused']
  }], {
    // This suite replaces the entire OS adapter. Its successful fixture has no
    // process/container and supplies explicit simulated absence evidence. Real
    // engine conformance is verified by the separate VM component.
    invoke: async (...args) => {
      const output = await invoke(...args);
      if (fixtureAdmission && !fixtureAdmission.receipt.engine) fixtureAdmission.confirmedEngineAbsence = true;
      return output;
    },
    supervisorRoot: path.join(dir, 'supervisor')
  });
  const acquire = runner.supervisor.acquire.bind(runner.supervisor);
  jest.spyOn(runner.supervisor, 'acquire').mockImplementation(options => (fixtureAdmission = acquire(options)));
  runner.privateKey = await C.privateKey(account, pair.privateKey, 'fixture');
  messages = [{
    id: crypto.randomUUID(),
    seq: 1,
    sender_user_id: user,
    sender_agent_id: null,
    key_version: 1,
    payload: await C.encrypt(key, {
      text: 'Work'
    }, room + ':1'),
    addressed_to: [],
    reply_to: [],
    kind: 'message'
  }];
  detail = {
    room: {
      id: room,
      key_version: 1
    },
    members: [{
      user_id: user,
      display_name: 'Alice',
      status: 'active'
    }],
    keys: [{
      key_version: 1,
      wrapped_key: await C.wrap(key, pair.publicKey)
    }]
  };
  batch = {
    ...detail,
    id: crypto.randomUUID(),
    messages,
    config: {}
  };
  const actionReplies = new Map();
  runner.api = jest.fn(async (route, body) => {
    if (route === `/tasks/${batch.id}/authorization`) return { authorized: true, state: 'running', deadlineAt: new Date(Date.now() + 10000).toISOString() };
    if (route === `/tasks/${batch.id}/actions`) {
      const { actionId, ...descriptor } = body;
      const action = { actionId, taskId: batch.id, digest: actionDigest(batch.context, descriptor), ...descriptor,
        approvalState: 'not_required', outcome: null, expiresAt: new Date(Date.now() + 10000).toISOString() };
      actionReplies.set(actionId, action); return action;
    }
    if (route.endsWith('/start')) {
      const action = actionReplies.get(route.split('/').at(-2));
      return { ...action, outcome: 'running', executionNonce: crypto.randomUUID() };
    }
    if (route.endsWith('/complete')) {
      const action = actionReplies.get(route.split('/').at(-2));
      return { ...action, ...body };
    }
    if (route === '/claim') return batch;
    if (route === `/batches/${batch.id}`) return {
      status: 'processing'
    };
    if (route === `/${room}`) return detail;
    if (route.includes('/messages?')) return messages;
    return {
      ok: true
    };
  });
});
afterEach(() => {
  capacitySpy?.mockRestore();
  capacitySpy = null;
  storeSecuritySpy?.mockRestore();
  storeSecuritySpy = null;
  fs.rmSync(dir, { recursive: true, force: true });
  if (!process.env.SHARED_TEST_OUTPUT_STORE) fs.rmSync(outputStore, { recursive: true, force: true });
});
test('agent acknowledges only claimed decrypted sources before invoking the provider', async () => {
  messages.push({ ...messages[0], id: crypto.randomUUID(), seq: 0 });
  batch.messages = [messages[0]];
  const baseInvoke = invoke.getMockImplementation();
  invoke.mockImplementation(async (...args) => {
    const receipt = runner.api.mock.calls.find(([route]) => route.endsWith('/read'));
    expect(receipt[1]).toEqual({ messageIds: [messages[0].id] });
    expect(JSON.parse(args[1][1].content).some(item => item.content.text === 'Work')).toBe(true);
    return baseInvoke(...args);
  });
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('optional agent receipt network failure still executes the turn exactly once', async () => {
  const base = runner.api;
  const warning = jest.spyOn(console, 'error').mockImplementation(() => {});
  runner.api = jest.fn(async (route, ...args) => {
    if (route.endsWith('/read')) throw new Error('Receipt network unavailable');
    return base(route, ...args);
  });
  try {
    expect(await runner.sharedTurn()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(runner.state.shared.pending).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('execution will continue'));
  } finally { warning.mockRestore(); }
});

test('unreadable ciphertext cannot produce a blue read receipt or invoke the provider', async () => {
  messages[0].payload.data = 'not-authentic-ciphertext';
  await expect(runner.sharedTurn()).rejects.toThrow();
  expect(runner.api.mock.calls.some(([route]) => route.endsWith('/read'))).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

test('delivery retry reuses encrypted output and never invokes the agent twice', async () => {
  const base = runner.api;
  let failed = false;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.includes('/finish') && !failed) {
      failed = true;
      throw new Error('Network lost');
    }
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow('Network lost');
  expect(runner.state.shared.pending.phase).toBe('ready');
  const saved = JSON.stringify(runner.state.shared.pending.deliveries);
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(runner.state.shared.pending).toBeNull();
  const delivered = runner.api.mock.calls.filter(c => c[0].includes('/finish'));
  expect(JSON.stringify(delivered[1][1].messages)).toBe(saved);
});
test('uncertain runtime execution is not automatically replayed', async () => {
  invoke.mockRejectedValueOnce(new Error('Timeout'));
  await expect(runner.sharedTurn()).rejects.toThrow('Timeout');
  expect(runner.state.shared.pending.phase).toBe('uncertain');
  await expect(runner.sharedTurn()).rejects.toThrow('manager review');
  expect(invoke).toHaveBeenCalledTimes(1);
});
test('claimed work survives restart while running work requires review', async () => {
  runner.state.shared.pending = {
    phase: 'running',
    batch
  };
  await expect(runner.sharedTurn()).rejects.toThrow('manager review');
  expect(invoke).not.toHaveBeenCalled();
  expect(runner.api).toHaveBeenCalledWith('/release', {
    executionId: batch.id,
    uncertain: true
  });
});
function approveFixtureContext(requester = { kind: 'user', id: user }) {
  runner.deviceId = 'device-context';
  runner.profiles[0].executor = 'rootless-podman';
  runner.profiles[0].image = 'fixture@sha256:' + 'a'.repeat(64);
  runner.profiles[0].argv = ['node', '/fixture'];
  runner.profiles[0].workspaceAlias = 'Website';
  runner.profiles[0].workspaceRoot = path.join(dir, 'workspace');
  runner.profiles[0].taskOutputStore = outputStore;
  batch.config = { model_provider: runner.profiles[0].provider, model: runner.profiles[0].model };
  fs.mkdirSync(runner.profiles[0].workspaceRoot, { recursive: true });
  batch.context = {
    contextVersion: 2,
    request: {
      taskId: batch.id,
      requester: {
        ...requester
      }
    },
    authorization: {
      grantId: 'grant-context',
      policyRevision: 4,
      deviceId: 'device-context',
      deviceEpoch: 1,
      workspaceAlias: 'Website',
      allowed: ['workspace.read', 'workspace.execute'],
      resources: ['Website'],
      destinations: [],
      requiresApproval: [],
      denied: [],
      budget: { maxRuntimeMs: 10000 }
    },
    execution: {
      executorId: 'device-context',
      workspaceAlias: 'Website',
      isolation: 'project-container',
      identityStatus: 'owner-approved'
    },
    conversation: { id: room }
  };
}
test('revoked authority before launch confirms no execution and never invokes the task', async () => {
  approveFixtureContext();
  const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => route.endsWith('/authorization') ?
    { authorized: false, state: 'cancellation_requested' } : base(route, ...args));
  expect(await runner.sharedTurn()).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  expect(runner.api).toHaveBeenCalledWith(`/tasks/${batch.id}/cancellation/confirm`, { confirmedStopped: true });
  expect(runner.state.shared.pending).toBeNull();
});
test('an unavailable authorization service prevents launch without falsely confirming cancellation', async () => {
  approveFixtureContext();
  const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => { if (route.endsWith('/authorization')) throw new Error('Authorization service unavailable'); return base(route, ...args); });
  await expect(runner.sharedTurn()).rejects.toThrow('Authorization service unavailable');
  expect(invoke).not.toHaveBeenCalled();
  expect(runner.api.mock.calls.some(([route]) => route.endsWith('/cancellation/confirm'))).toBe(false);
});
test('a server without a finite task deadline prevents launch', async () => {
  approveFixtureContext(); const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => route.endsWith('/authorization') ?
    { authorized: true, state: 'running' } : base(route, ...args));
  await expect(runner.sharedTurn()).rejects.toThrow('finite task deadline');
  expect(invoke).not.toHaveBeenCalled();
});
test('missing action support and a lost consumption reply never invoke or replay a command', async () => {
  approveFixtureContext(); const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => route.endsWith('/start') ? Promise.reject(Error('Start response lost')) : base(route, ...args));
  await expect(runner.sharedTurn()).rejects.toThrow('Start response lost');
  expect(runner.state.shared.pending.action.phase).toBe('start_pending');
  expect(invoke).not.toHaveBeenCalled();
  await expect(runner.sharedTurn()).rejects.toThrow('manager review');
  expect(invoke).not.toHaveBeenCalled();
});
test('an action receipt failure retries acknowledgement after restart without executing again', async () => {
  approveFixtureContext(); const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => route.endsWith('/complete') ? Promise.reject(Error('Receipt response lost')) : base(route, ...args));
  await expect(runner.sharedTurn()).rejects.toThrow('Receipt response lost');
  const saved = JSON.parse(fs.readFileSync(runner.bridge.file, 'utf8'));
  expect(saved.shared.pending.action.phase).toBe('receipt_pending');
  const recovered = new SharedRunner(new Bridge(saved, { file: runner.bridge.file }), runner.profiles,
    { invoke, supervisorRoot: path.join(dir, 'supervisor') });
  recovered.api = jest.fn(async (route, ...args) => base(route, ...args));
  await expect(recovered.sharedTurn()).rejects.toThrow('manager review');
  expect(recovered.state.shared.pending.action.phase).toBe('completed');
  expect(recovered.api.mock.calls.filter(([route]) => route.endsWith('/complete'))).toHaveLength(1);
  expect(invoke).toHaveBeenCalledTimes(1);
});
test('the coarse execution approval does not clear the original approval policy', async () => {
  approveFixtureContext(); batch.context.authorization.requiresApproval = ['workspace.execute'];
  await runner.sharedTurn();
  expect(invoke.mock.calls[0][4].authorization.requiresApproval).toEqual(['workspace.execute']);
  expect(runner.api.mock.calls.some(([route]) => route.endsWith('/start'))).toBe(true);
});
test('a failed stop acknowledgement is durable and retries after restart without rerunning', async () => {
  approveFixtureContext();
  const base = runner.api;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.endsWith('/authorization')) return { authorized: false, state: 'cancellation_requested' };
    if (route.endsWith('/cancellation/confirm')) throw new Error('Stop acknowledgement unavailable');
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow('Stop acknowledgement unavailable');
  expect(invoke).not.toHaveBeenCalled();
  const persisted = JSON.parse(fs.readFileSync(runner.bridge.file, 'utf8'));
  expect(persisted.shared.pending.phase).toBe('cancellation_pending');
  const recovered = new SharedRunner(new Bridge(persisted, { file: runner.bridge.file }), runner.profiles, {
    invoke,
    supervisorRoot: path.join(dir, 'supervisor')
  });
  recovered.api = jest.fn(async (route, ...args) => base(route, ...args));
  expect(await recovered.sharedTurn()).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  expect(recovered.api).toHaveBeenCalledWith(`/tasks/${batch.id}/cancellation/confirm`, { confirmedStopped: true });
  expect(recovered.state.shared.pending).toBeNull();
});
test('authorization watchdog aborts on revocation and stops polling after close', async () => {
  jest.useFakeTimers();
  try {
    const controller = new AbortController();
    runner.api = jest.fn().mockResolvedValueOnce({ authorized: true, state: 'running', deadlineAt: new Date(Date.now() + 10000).toISOString() })
      .mockResolvedValue({ authorized: false, state: 'cancellation_requested' });
    const watch = runner.taskAuthorizationWatch(batch.id, controller);
    await watch.check(); watch.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(controller.signal.aborted).toBe(true);
    expect(watch.cancellationPending).toBe(true);
    await watch.close();
    const calls = runner.api.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5000);
    expect(runner.api).toHaveBeenCalledTimes(calls);
  } finally { jest.useRealTimers(); }
});
test('the watchdog deadline includes approval waiting and cannot be extended by a later response', async () => {
  jest.useFakeTimers();
  try {
    const controller = new AbortController(), initial = Date.now();
    runner.api = jest.fn().mockResolvedValueOnce({ authorized: true, deadlineAt: new Date(initial + 2000).toISOString() })
      .mockResolvedValue({ authorized: true, deadlineAt: new Date(initial + 20000).toISOString() });
    const watch = runner.taskAuthorizationWatch(batch.id, controller);
    await watch.check(); watch.start();
    await jest.advanceTimersByTimeAsync(2000);
    expect(controller.signal.aborted).toBe(true); expect(controller.signal.reason.message).toMatch(/budget expired/);
    await watch.close(); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
test('sustained shared traffic admits a waiting private task on the next turn', async () => {
  runner.register = jest.fn().mockResolvedValue();
  runner.bridge.heartbeat = jest.fn().mockResolvedValue();
  runner.sharedTurn = jest.fn().mockResolvedValue(true);
  runner.bridge.poll = jest.fn(async () => { runner.state.pending = { phase: 'ready' }; });
  runner.bridge.completePending = jest.fn(async () => { runner.state.pending = null; });
  await runner.tick();
  expect(runner.sharedTurn).toHaveBeenCalledTimes(1);
  expect(runner.state.shared.lastTurnKind).toBe('shared');
  await runner.tick();
  expect(runner.sharedTurn).toHaveBeenCalledTimes(1);
  expect(runner.bridge.completePending).toHaveBeenCalledTimes(1);
  expect(runner.state.shared.lastTurnKind).toBe('private');
});

test('shared API backoff survives an HTML proxy error and never accepts invalid success JSON', async () => {
  runner.api = SharedRunner.prototype.api.bind(runner);
  runner.fetch = jest.fn().mockResolvedValueOnce(new Response('<html>retry</html>', { status: 503, headers: { 'retry-after': '20' } }))
    .mockResolvedValueOnce(new Response('<html>not a batch</html>', { status: 200 }));
  await expect(runner.api('/runtime', {})).rejects.toMatchObject({ status: 503, retryMs: 20000 });
  await expect(runner.api('/claim', {})).rejects.toThrow('invalid response');
  expect(runner.state.shared.pending).toBeNull();
});

test('private reply requests carry their exact current execution lease and shared requests cannot reuse a released lease', async () => {
  const executionId = crypto.randomUUID();
  runner.state.shared.privateExecution = executionId;
  runner.fetch = jest.fn(async () => new Response('{}', { status: 200 }));
  await runner.bridge.api('/messages', { clientMessageId: crypto.randomUUID(), encrypted: true, content: 'fixture ciphertext' });
  expect(runner.fetch.mock.calls[0][1].headers).toMatchObject({
    'x-shared-runtime': runner.runtimeId, 'x-shared-private-execution': executionId
  });
  runner.state.shared.privateExecution = null;
  await runner.bridge.api('/responses?markRead=false');
  expect(runner.fetch.mock.calls[1][1].headers).not.toHaveProperty('x-shared-private-execution');
});

test('provider failures retain bounded local diagnostics without exposing them in the shared error', async () => {
  runner.invokeOverride = null;
  const marker = 'private-provider-diagnostic-canary';
  const profile = { provider: 'test', model: 'test', command: [process.execPath, '-e',
    `process.stderr.write('x'.repeat(70000)+'${marker}');process.exit(2);`] };
  let error;
  try { await runner.invoke(profile, [{ role: 'user', content: 'Connectivity test' }], 'private'); }
  catch (caught) { error = caught; }
  expect(error.message).toBe('Provider execution did not complete successfully');
  expect(error.message).not.toContain(marker);
  expect(error.diagnosticsFile).toBeTruthy();
  expect(fs.readFileSync(error.diagnosticsFile, 'utf8')).toContain(marker);
  expect(fs.statSync(error.diagnosticsFile).size).toBeLessThanOrEqual(64000);
  expect(fs.statSync(error.diagnosticsFile).mode & 0o777).toBe(0o600);
});
test('shared prompt includes sender identity but no private transcript', async () => {
  runner.state.history.user = 'PRIVATE HISTORY';
  approveFixtureContext();
  await runner.sharedTurn();
  const prompts = invoke.mock.calls[0][1];
  expect(JSON.stringify(prompts)).toContain(user);
  expect(JSON.stringify(prompts)).toContain('grant-context');
  expect(JSON.stringify(prompts)).toContain('device-context');
  expect(JSON.stringify(prompts)).not.toContain('PRIVATE HISTORY');
  expect(invoke.mock.calls[0][2]).toBe(room);
  expect(invoke.mock.calls[0][4]).toBe(batch.context);
});

test('protocol 2 cannot route shared work through a host command or a test override', async () => {
  runner.protocolVersion = 2;
  await expect(runner.invoke(runner.profiles[0], [], room, undefined, { contextVersion: 2 })).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
  await expect(runner.invoke(runner.profiles[0], [], room)).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
});

test('protocol 2 preserves private profile invocation', async () => {
  runner.protocolVersion = 2;
  await runner.invoke(runner.profiles[0], [], 'private');
  expect(invoke).toHaveBeenCalledTimes(1);
});

test.each([
  ['unapproved provider', { model_provider: 'other-provider', model: 'test' }],
  ['unapproved model', { model_provider: 'test', model: 'other-model' }],
  ['unresolved default model', { model_provider: 'test', model: 'default' }],
  ['missing provider', { model: 'test' }],
  ['missing model', { model_provider: 'test' }],
  ['missing configuration', null]
])('restricted shared work refuses %s without falling back or invoking', async (_, config) => {
  approveFixtureContext();
  batch.config = config;
  await expect(runner.sharedTurn()).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
  expect(runner.api).not.toHaveBeenCalledWith('/' + room);
  expect(runner.api).toHaveBeenCalledWith('/release', { executionId: batch.id, uncertain: true });
  expect(runner.state.shared.pending.phase).toBe('uncertain');
});

test('restricted shared work refuses ambiguous profiles for the same provider and model', async () => {
  approveFixtureContext();
  runner.profiles.push({ ...runner.profiles[0], argv: ['different-owner-program'] });
  await expect(runner.sharedTurn()).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
});

test('restricted shared work invokes the exact approved profile even when it is not first', async () => {
  approveFixtureContext();
  const selected = runner.profiles[0];
  runner.profiles.unshift({ ...selected, model: 'another-approved-model' });
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][0]).toEqual({ ...selected, environment: {} });
});

test.each(['antigravity', 'codex', 'claude', 'gemini', 'custom-provider'])('shared selection and approval preserve the configured %s provider', async provider => {
  approveFixtureContext();
  const selected = runner.profiles[0];
  selected.provider = provider;
  selected.model = 'owner-selected-fixture-model';
  batch.config = { model_provider: provider, model: selected.model };
  runner.profiles.unshift({ ...selected, provider: 'unselected-provider', model: selected.model });
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][0]).toMatchObject({ provider, model: selected.model });
  const proposal = runner.api.mock.calls.find(([route]) => route.endsWith('/actions'))[1];
  expect(proposal.parameters).toMatchObject({ provider, model: selected.model, image: selected.image });
  expect(runner.api.mock.calls.filter(([route]) => route.endsWith('/start'))).toHaveLength(1);
  expect(runner.api.mock.calls.find(([route]) => route.endsWith('/complete'))[1].receipt.confirmedStopped).toBe(true);
});

test('saved restricted results stay held when their exact profile is unavailable', async () => {
  approveFixtureContext();
  const selected = runner.profiles[0];
  const base = runner.api;
  let unavailable = true;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.includes('/finish') && unavailable) throw new Error('Delivery temporarily unavailable');
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow('Delivery temporarily unavailable');
  const saved = runner.state.shared.pending.output;
  runner.profiles = [{ ...selected, model: 'replacement-model' }];
  runner.api.mockClear();
  unavailable = false;
  await expect(runner.sharedTurn()).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(runner.state.shared.pending.phase).toBe('ready');
  expect(runner.state.shared.pending.output).toBe(saved);
  expect(runner.api.mock.calls.some(([route]) => route.includes('/finish') || route.endsWith('/files'))).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
  runner.profiles.push(selected);
  await runner.sharedTurn();
  expect(runner.state.shared.pending).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('protocol 2 still preserves private default-profile behavior for unmatched settings', async () => {
  runner.protocolVersion = 2;
  const selected = runner.profile({ model_provider: 'other-provider', model: 'other-model' });
  await runner.invoke(selected, [], 'private');
  expect(invoke.mock.calls[0][0]).toBe(runner.profiles[0]);
});

test('rejects a restricted workspace containing connector credentials before invocation', async () => {
  approveFixtureContext();
  runner.profiles[0].workspaceRoot = dir;
  await expect(runner.sharedTurn()).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
});

test('detects private attachment overlap through a parent symlink', async () => {
  approveFixtureContext();
  const alias = path.join(dir, 'private-alias');
  fs.symlinkSync(runner.profiles[0].workspaceRoot, alias);
  runner.bridge.attachmentDir = path.join(alias, 'attachments');
  await expect(runner.invoke(runner.profiles[0], [], room, undefined, batch.context)).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
});

test('rejects an owner profile file mounted in the shared workspace', async () => {
  approveFixtureContext();
  runner.profileConfigPath = path.join(runner.profiles[0].workspaceRoot, 'owner-profiles.json');
  fs.writeFileSync(runner.profileConfigPath, '{"fakePrivateSetting":"fixture"}');
  await expect(runner.invoke(runner.profiles[0], [], room, undefined, batch.context)).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
});
test('key rotation re-encrypts saved result without rerunning work', async () => {
  const base = runner.api;
  let failed = false;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.includes('/finish') && !failed) {
      failed = true;
      throw new Error('Key rotated');
    }
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow();
  const replacement = await C.newKey();
  detail.room.key_version = 2;
  detail.keys.push({
    key_version: 2,
    wrapped_key: await C.wrap(replacement, pair.publicKey)
  });
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  const delivery = runner.api.mock.calls.filter(c => c[0].includes('/finish')).at(-1)[1].messages[0];
  expect(delivery.keyVersion).toBe(2);
  expect((await C.decrypt(replacement, delivery.payload, room + ':2')).text).toBe('Done');
});
test('actual managed subprocess receives only supplied context and preserves chosen profile', async () => {
  runner.invokeOverride = null;
  const output = await runner.invoke({
    provider: 'test',
    model: 'model-a',
    managedRunner: true,
    command: [process.execPath, '-e', "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input:s,shared:process.env.CHATSPACE_SHARED_TURN,model:process.env.CHATSPACE_SHARED_MODEL})))"]
  }, [{
    role: 'user',
    content: 'Shared request'
  }], room);
  const parsed = JSON.parse(output);
  expect(parsed.input).toBe('user: Shared request');
  expect(parsed.shared).toBe('1');
  expect(parsed.model).toBe('model-a');
});
test('shared output accepts only an approved regular file and uses the runtime identity on upload', async () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir, {
    mode: 0o700
  });
  const outputPath = path.join(exportDir, 'report.txt');
  fs.writeFileSync(outputPath, 'approved output', {
    mode: 0o600
  });
  runner.profiles[0].exportDir = exportDir;
  runner.fetch = jest.fn(async () => new Response('{}', {
    status: 200
  }));
  invoke.mockResolvedValueOnce(JSON.stringify({
    replies: [{
      text: 'Attached',
      files: [{
        path: outputPath,
        name: 'report.txt',
        type: 'text/plain'
      }]
    }]
  }));
  await runner.sharedTurn();
  expect(runner.fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/agent/shared/${room}/files`), expect.objectContaining({
    headers: expect.objectContaining({
      'x-shared-runtime': runner.runtimeId
    })
  }));
});
test('shared output rejects outside-root, symlink and replacement paths', async () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir, {
    mode: 0o700
  });
  const outside = path.join(dir, 'private.txt');
  const approved = path.join(exportDir, 'approved.txt');
  fs.writeFileSync(outside, 'private', {
    mode: 0o600
  });
  fs.writeFileSync(approved, 'approved', {
    mode: 0o600
  });
  expect(() => readApprovedExport(outside, exportDir)).toThrow('outside the approved export directory');
  const link = path.join(exportDir, 'link.txt');
  fs.symlinkSync(outside, link);
  expect(() => readApprovedExport(link, exportDir)).toThrow('regular file');
  expect(() => readApprovedExport(approved, exportDir, {
    beforeOpen: () => {
      fs.renameSync(approved, path.join(exportDir, 'original.txt'));
      fs.writeFileSync(approved, 'replacement', {
        mode: 0o600
      });
    }
  })).toThrow('changed while opening');
});
test('shared export reads cannot follow a replaced parent directory', () => {
  const exportDir = path.join(dir, 'exports');
  const privateDir = path.join(dir, 'private');
  fs.mkdirSync(exportDir, { mode: 0o700 });
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const approved = path.join(exportDir, 'report.txt');
  fs.writeFileSync(approved, 'approved artifact');
  fs.writeFileSync(path.join(privateDir, 'report.txt'), 'private fixture data');
  const lstat = fs.lstatSync.bind(fs);
  let replaced = false;
  const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((candidate, options) => {
    if (!replaced && String(candidate).endsWith('/report.txt')) {
      replaced = true;
      fs.renameSync(exportDir, path.join(dir, 'original-exports'));
      fs.symlinkSync(privateDir, exportDir);
    }
    return lstat(candidate, options);
  });
  try {
    expect(readApprovedExport(approved, exportDir).toString()).toBe('approved artifact');
    expect(replaced).toBe(true);
  } finally { spy.mockRestore(); }
});
test('shared export rejects root replacement before its directory handle opens', () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir, { mode: 0o700 });
  const approved = path.join(exportDir, 'report.txt');
  fs.writeFileSync(approved, 'approved artifact');
  const open = fs.openSync.bind(fs);
  let replaced = false;
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
    if (!replaced && candidate === exportDir) {
      replaced = true;
      fs.renameSync(exportDir, path.join(dir, 'original-exports'));
      fs.mkdirSync(exportDir);
      fs.writeFileSync(approved, 'replacement fixture data');
    }
    return open(candidate, flags, mode);
  });
  try {
    expect(() => readApprovedExport(approved, exportDir)).toThrow('directory changed while opening');
    expect(replaced).toBe(true);
  } finally { spy.mockRestore(); }
});
test('shared export capture bounds bytes read if a file grows after its size check', () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir);
  const approved = path.join(exportDir, 'report.txt');
  fs.writeFileSync(approved, 'approved artifact');
  const fstat = fs.fstatSync.bind(fs);
  const read = fs.readSync.bind(fs);
  const readFile = fs.readFileSync.bind(fs);
  let grew = false, readBytes = 0, readFileBytes = 0;
  const statSpy = jest.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const stat = fstat(fd, options);
    if (!grew && stat.isFile()) {
      grew = true;
      // Real sparse-file growth at the point a concurrent writer could append.
      fs.truncateSync(approved, 20_000_002);
    }
    return stat;
  });
  const readSpy = jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const length = read(...args);
    readBytes += length;
    return length;
  });
  const readFileSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    const bytes = readFile(...args);
    if (typeof args[0] === 'number') readFileBytes += bytes.length;
    return bytes;
  });
  try {
    expect(() => readApprovedExport(approved, exportDir)).toThrow(/changed while reading|exceeds 20 MB/);
    expect(grew).toBe(true);
    expect(Math.max(readBytes, readFileBytes)).toBeGreaterThan(0);
    expect(Math.max(readBytes, readFileBytes)).toBeLessThanOrEqual(20_000_001);
  } finally {
    statSpy.mockRestore();
    readSpy.mockRestore();
    readFileSpy.mockRestore();
  }
});
test('shared export rejects a same-inode rewrite with unchanged length', () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir);
  const approved = path.join(exportDir, 'report.txt');
  fs.writeFileSync(approved, 'approved artifact');
  const fstat = fs.fstatSync.bind(fs);
  let rewritten = false;
  const spy = jest.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const stat = fstat(fd, options);
    if (!rewritten && stat.isFile()) {
      rewritten = true;
      fs.writeFileSync(approved, 'modified artifact');
      // A deterministic timestamp change avoids depending on clock granularity.
      const timestamp = new Date(stat.mtimeMs + 2000);
      fs.utimesSync(approved, timestamp, timestamp);
    }
    return stat;
  });
  try {
    expect(() => readApprovedExport(approved, exportDir)).toThrow('changed while reading');
    expect(rewritten).toBe(true);
  } finally { spy.mockRestore(); }
});
test('shared export preserves an unchanged file at the exact byte limit', () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir);
  const approved = path.join(exportDir, 'report.txt');
  const expected = Buffer.alloc(20_000_000, 'x');
  fs.writeFileSync(approved, expected);
  expect(readApprovedExport(approved, exportDir).equals(expected)).toBe(true);
});
test('a regular-file replacement with a pipe cannot block publication', () => {
  const exportDir = path.join(dir, 'exports');
  fs.mkdirSync(exportDir);
  const approved = path.join(exportDir, 'report.txt');
  fs.writeFileSync(approved, 'approved artifact');
  const script = `
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    const { readApprovedExport } = require(process.argv[1]);
    try {
      readApprovedExport(process.argv[2], process.argv[3], { beforeOpen: () => {
        fs.renameSync(process.argv[2], process.argv[2] + '.original');
        execFileSync('mkfifo', [process.argv[2]]);
      }});
      process.exitCode = 1;
    } catch (error) { process.stdout.write(error.message); }
  `;
  const result = require('child_process').execFileSync(process.execPath,
    ['-e', script, require.resolve('../../scripts/shared-agent-runner'), approved, exportDir], { timeout: 3000, encoding: 'utf8' });
  expect(result).toContain('changed while opening');
});
test('external adapter uses isolated session identity and never transmits ChatMcpSpace credentials', async () => {
  runner.invokeOverride = null;
  runner.agentId = 'agent-id';
  process.env.SHARED_FIXTURE_KEY = 'runtime-key';
  runner.fetch = jest.fn(async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: 'Done'
      }
    }]
  }), {
    status: 200
  }));
  const result = await runner.invoke({
    provider: 'fixture',
    model: 'test',
    url: 'http://127.0.0.1:1234/v1',
    sessionField: 'conversation_id',
    apiKeyEnv: 'SHARED_FIXTURE_KEY'
  }, [{
    role: 'user',
    content: 'Hi'
  }], room);
  expect(result).toBe('Done');
  const options = runner.fetch.mock.calls[0][1];
  expect(JSON.parse(options.body).conversation_id).toBe('agent-id:' + room);
  expect(options.headers.Authorization).toBe('Bearer runtime-key');
  expect(options.body).not.toContain(runner.state.key);
  delete process.env.SHARED_FIXTURE_KEY;
});
test('AES content is bound to conversation and version; another private key cannot unwrap', async () => {
  const encrypted = await C.encrypt(key, {
    text: 'Secret'
  }, room + ':1');
  await expect(C.decrypt(key, encrypted, 'other:1')).rejects.toThrow();
  const other = await C.identity(account, 'other'),
    privateKey = await C.privateKey(account, other.privateKey, 'other');
  await expect(C.unwrap(await C.wrap(key, pair.publicKey), privateKey)).rejects.toThrow();
});
test('HTTP adapter sessions cannot carry owner-only context into another shared task', async () => {
  runner.invokeOverride = null;
  runner.executionMode = 'trusted';
  process.env.SHARED_FIXTURE_KEY = 'runtime-key';
  runner.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), { status: 200 }));
  const profile = { provider: 'fixture', model: 'test', url: 'http://127.0.0.1:1234/v1', sessionField: 'conversation_id', apiKeyEnv: 'SHARED_FIXTURE_KEY' };
  try {
    for (const kind of ['user', 'guest']) {
      const taskId = crypto.randomUUID();
      const context = { contextVersion: 2, request: { taskId, requester: { kind, id: crypto.randomUUID() } },
        execution: { mode: 'trusted', connectorId: runner.runtimeId }, conversation: { id: room } };
      runner.state.shared.pending = { batch: { id: taskId } };
      await runner.invoke(profile, [{ role: 'user', content: 'Scoped transcript' }], room, undefined, context);
    }
    const sessions = runner.fetch.mock.calls.map(call => JSON.parse(call[1].body).conversation_id);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(sessions.every(session => session.startsWith(`${runner.agentId}:${room}:task:`))).toBe(true);
  } finally { delete process.env.SHARED_FIXTURE_KEY; }
});
test('generated managed runner uses existing permission flags and supplied transcript without polling private history', () => {
  const {
    generateAgentRunner
  } = require('../../src/utils/apiGuideGenerator');
  const {
    spawnSync
  } = require('child_process');
  const bin = path.join(dir, 'bin'),
    state = path.join(dir, 'agent_state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'allowed_permissions.json'), JSON.stringify({
    claude: {
      '--dangerously-skip-permissions': true,
      '--permission-mode': ['bypassPermissions']
    }
  }));
  fs.writeFileSync(path.join(state, 'agent_config.json'), JSON.stringify({
    model_provider: 'claude',
    model: 'existing',
    approval_mode: 'full-auto',
    sandbox_mode: 'none',
    project_path: dir
  }));
  fs.writeFileSync(path.join(state, 'agent_summary.md'), 'PRIVATE HISTORY MUST NOT BE USED');
  fs.writeFileSync(path.join(dir, 'runner.sh'), generateAgentRunner());
  const resultEnvelope = JSON.stringify({ type: 'result', is_error: false,
    result: JSON.stringify({ replies: [{ text: 'Managed result' }] }) });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_ARGS"\ncat > "$TEST_INPUT"\nprintf \'%s\\n\' \'' + resultEnvelope + '\'\n', {
    mode: 0o700
  });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_REQUESTS"\nprintf \'%s\' \'{"stopRequested":false}\'\n', {
    mode: 0o700
  });
  const result = spawnSync('bash', [path.join(dir, 'runner.sh')], {
    input: 'Shared transcript only',
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      CHATSPACE_SHARED_TURN: '1',
      CHATSPACE_SHARED_PROVIDER: 'claude',
      CHATSPACE_SHARED_MODEL: 'selected',
      TEST_ARGS: path.join(dir, 'args'),
      TEST_INPUT: path.join(dir, 'input'),
      TEST_REQUESTS: path.join(dir, 'requests'),
      API_BASE: 'http://127.0.0.1:1/api',
      API_KEY: 'fixture',
      AGENT_NAME: 'Fixture'
    }
  });
  if (result.status !== 0) throw new Error('Generated runner failed: ' + result.stderr + result.stdout);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Managed result');
  expect(JSON.parse(result.stdout)).toEqual({ replies: [{ text: 'Managed result' }] });
  expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('--dangerously-skip-permissions');
  expect(fs.readFileSync(path.join(dir, 'args'), 'utf8')).toContain('selected');
  expect(fs.readFileSync(path.join(dir, 'input'), 'utf8')).toBe('Shared transcript only\n');
  const requests = fs.existsSync(path.join(dir, 'requests')) ? fs.readFileSync(path.join(dir, 'requests'), 'utf8') : '';
  expect(requests).toBe('');
  fs.unlinkSync(path.join(dir, 'args'));
  const denied = spawnSync('bash', [path.join(dir, 'runner.sh')], {
    input: 'Shared transcript only', encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, CHATSPACE_SHARED_TURN: '1',
      CHATSPACE_SHARED_PROVIDER: 'gemini', CHATSPACE_SHARED_MODEL: 'selected',
      TEST_ARGS: path.join(dir, 'args'), TEST_INPUT: path.join(dir, 'input'), TEST_REQUESTS: path.join(dir, 'requests'),
      API_BASE: 'http://127.0.0.1:1/api', API_KEY: 'fixture', AGENT_NAME: 'Fixture' }
  });
  expect(denied.status).toBe(1);
  expect(denied.stderr).toContain('Selected shared provider');
  expect(fs.existsSync(path.join(dir, 'args'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(state, 'agent_config.json'))).model_provider).toBe('claude');
}, 20000);
function loadDownloadBundle() {
  const {
    generateSharedRunnerBundle
  } = require('../../src/shared/bundle');
  const vm = require('vm');
  const module = {
    exports: {}
  };
  vm.runInNewContext(generateSharedRunnerBundle().replace(/^#!.*\n/, ''), {
    require,
    module,
    global: globalThis,
    globalThis,
    Buffer,
    console,
    process,
    AbortSignal,
    Response,
    fetch,
    setTimeout,
    clearTimeout
  });
  return module.exports;
}
test('download bundle loads without repository-relative dependencies', () => {
  expect(typeof loadDownloadBundle().SharedRunner).toBe('function');
});
test('downloaded runner enforces the exact restricted profile before invoking or reading history', async () => {
  approveFixtureContext();
  const previous = runner;
  const DownloadedRunner = loadDownloadBundle().SharedRunner;
  const profiles = previous.profiles.map(profile => ({ ...profile,
    image: 'registry.example.test/shared-fixture@sha256:' + '1'.repeat(64), argv: ['node', 'unused'] }));
  runner = new DownloadedRunner(previous.bridge, profiles, {
    protocolVersion: 2, deviceId: previous.deviceId, invoke,
    supervisorRoot: path.join(dir, 'downloaded-supervisor')
  });
  runner.api = previous.api;
  batch.config.model = 'unapproved-model';
  await expect(runner.sharedTurn()).rejects.toMatchObject({ code: 'RESTRICTED_EXECUTOR_UNAVAILABLE' });
  expect(invoke).not.toHaveBeenCalled();
  expect(runner.api).not.toHaveBeenCalledWith('/' + room);
});
test('messages arriving after the claimed batch are excluded from its transcript', async () => {
  messages.push({
    ...messages[0],
    id: crypto.randomUUID(),
    seq: 2,
    payload: await C.encrypt(key, {
      text: 'FUTURE TURN'
    }, room + ':1')
  });
  batch.messages = [messages[0]];
  await runner.sharedTurn();
  expect(JSON.stringify(invoke.mock.calls[0][1])).not.toContain('FUTURE TURN');
});
test.each(['answered', 'retry', 'skipped'])('resolved %s batch clears journal without replay', async status => {
  runner.state.shared.pending = {
    phase: 'running',
    batch
  };
  runner.api.mockImplementation(async () => ({
    status
  }));
  await runner.sharedTurn();
  expect(runner.state.shared.pending).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
test('runtime identity conflict preserves uncertain journal', async () => {
  runner.state.shared.pending = {
    phase: 'uncertain',
    batch
  };
  runner.api.mockRejectedValue(Object.assign(new Error('Runtime identity mismatch'), {
    status: 409
  }));
  await expect(runner.sharedTurn()).rejects.toThrow('identity mismatch');
  expect(runner.state.shared.pending.phase).toBe('uncertain');
  expect(invoke).not.toHaveBeenCalled();
});
test('adopting an approved runtime preserves journal and failed adoption preserves identity', async () => {
  const old = runner.runtimeId;
  runner.state.shared.pending = {
    phase: 'uncertain',
    batch
  };
  runner.api.mockRejectedValueOnce(new Error('Owner has not reset runtime'));
  await expect(runner.adoptRuntime(crypto.randomUUID())).rejects.toThrow('Owner has not reset');
  expect(runner.runtimeId).toBe(old);
  expect(runner.state.shared.runtimeId).toBe(old);
  const next = crypto.randomUUID();
  await runner.adoptRuntime(next);
  expect(runner.state.shared.runtimeId).toBe(next);
  expect(runner.state.shared.pending.phase).toBe('uncertain');
});

test('protocol 2 preserves guest sender and addressed result identities', async () => {
  const guestId = crypto.randomUUID();
  approveFixtureContext({ kind: 'guest', id: guestId });
  messages[0].sender_user_id = null;
  messages[0].sender_guest_id = guestId;
  messages[0].addressed_to_principals = [{ kind: 'user', id: user }];
  detail.guests = [{ guest_id: guestId, display_name: 'Guest requester', status: 'active' }];
  invoke.mockResolvedValue(JSON.stringify({ replies: [{ kind: 'question', text: 'Guest decision?', toPrincipals: [{ kind: 'guest', id: guestId }] }] }));
  await runner.sharedTurn();
  const transcript = JSON.parse(invoke.mock.calls[0][1][1].content);
  expect(transcript[0]).toMatchObject({ sender: { kind: 'guest', id: guestId }, fromGuestId: guestId, name: 'Guest requester',
    addressedToPrincipals: [{ kind: 'user', id: user }] });
  const delivery = runner.api.mock.calls.find(call => call[0].endsWith('/finish'))[1].messages[0];
  expect(delivery).toMatchObject({ kind: 'question', addressedTo: [], addressedToPrincipals: [{ kind: 'guest', id: guestId }] });
});

test('invalid or legacy typed reply recipients cannot become public replies', () => {
  const output = recipients => JSON.stringify({ replies: [{ text: 'Scoped reply', toPrincipals: recipients }] });
  expect(() => runner.parseOutput(output([{ kind: 'guest', id: user }]), batch)).toThrow(/protocol 2/i);
  approveFixtureContext();
  for (const recipients of [null, 'everyone', [{ kind: 'agent', id: user }], [{ kind: 'guest', id: 'invalid' }]]) {
    expect(() => runner.parseOutput(output(recipients), batch)).toThrow(/recipient/i);
  }
});

test('reply audiences support owner-only, owner plus selected guests, and everyone without widening malformed recipients', () => {
  const guest = crypto.randomUUID();
  approveFixtureContext();
  for (const audience of [{ mode: 'owner' }, { mode: 'all' }, { mode: 'selected', principals: [{ kind: 'guest', id: guest }] }]) {
    expect(runner.parseOutput(JSON.stringify({ replies: [{ text: 'Delivery choice', audience }] }), batch)[0].audience).toEqual(audience);
  }
  for (const audience of [null, { mode: 'public' }, { mode: 'selected', principals: [] }, { mode: 'owner', principals: [{ kind: 'guest', id: guest }] }, { mode: 'selected', principals: [{ kind: 'guest', id: 'bad' }] }]) {
    expect(() => runner.parseOutput(JSON.stringify({ replies: [{ text: 'Private result', audience }] }), batch)).toThrow(/audience/i);
  }
  expect(() => runner.parseOutput('{"replies":[{"text":"Private result","audience":', batch)).toThrow(/recipients/i);
  expect(() => runner.parseOutput('{"text":"Private result","audience":{"mode":"owner"}}', batch)).toThrow(/recipients/i);
  for (const toUserIds of ['owner', [null], ['bad']]) expect(() => runner.parseOutput(JSON.stringify({ replies: [{ text: 'Private result', toUserIds }] }), batch)).toThrow(/recipients/i);
});

test('a malformed completed reply stays encrypted for recovery without repeating provider actions', async () => {
  const output = '{"replies":[{"text":"Completed private result","audience":';
  invoke.mockResolvedValue(output);
  await expect(runner.sharedTurn()).rejects.toThrow(/recipients/i);
  const pending = JSON.parse(fs.readFileSync(runner.bridge.file, 'utf8')).shared.pending;
  expect(pending.phase).toBe('uncertain');
  expect(open(pending.rawOutput, runner.state.key)).toBe(output);
  expect(JSON.stringify(pending.rawOutput)).not.toContain('Completed private result');
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(runner.api.mock.calls.some(([route]) => route.endsWith('/finish'))).toBe(false);
  await expect(runner.sharedTurn()).rejects.toThrow(/review/i);
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('provider explanations around a single fenced result preserve its audience and reject competing recipients', () => {
  approveFixtureContext();
  const result = JSON.stringify({ replies: [{ text: 'Only the owner receives this', audience: { mode: 'owner' } }] }, null, 2);
  for (const output of [`Here is the result.\n\n\`\`\`json\n${result}\n\`\`\`\nDone.`, ` \n\`\`\`JSON\n${result}\n\`\`\`\n `]) {
    expect(runner.parseOutput(output, batch)[0]).toMatchObject({ text: 'Only the owner receives this', audience: { mode: 'owner' } });
  }
  for (const output of [`"audience":{"mode":"all"}\n\`\`\`json\n${result}\n\`\`\``,
    `\`\`\`json\n${result}\n\`\`\`\n\`\`\`json\n${result}\n\`\`\``,
    `Here is the result.\n\`\`\`json\n{"replies":[{"text":"Private","audience":\n\`\`\``]) {
    expect(() => runner.parseOutput(output, batch)).toThrow(/recipients/i);
  }
});

test('guest execution excludes owner-only history and forwards its selected audience to the server', async () => {
  const guest = crypto.randomUUID();
  approveFixtureContext({ kind: 'guest', id: guest });
  messages[0].sender_user_id = null;
  messages[0].sender_guest_id = guest;
  batch.messages = [messages[0]];
  messages.unshift({ ...messages[0], id: crypto.randomUUID(), seq: 0, sender_guest_id: null, sender_agent_id: runner.state.agentId,
    recipient_principals: [{ kind: 'user', id: user }], payload: await C.encrypt(key, { text: 'Owner-only secret' }, room + ':1') });
  detail.guests = [{ guest_id: guest, status: 'active' }];
  const audience = { mode: 'selected', principals: [{ kind: 'guest', id: guest }] };
  invoke.mockResolvedValue(JSON.stringify({ replies: [{ text: 'Scoped result', audience }] }));
  await runner.sharedTurn();
  expect(invoke.mock.calls[0][1][0].content).toContain('The owner always receives every reply');
  expect(invoke.mock.calls[0][1][1].content).not.toContain('Owner-only secret');
  expect(runner.api.mock.calls.find(call => call[0].endsWith('/finish'))[1].messages[0].audience).toEqual(audience);
});

test('removed typed recipient holds the result instead of making it public', async () => {
  const guestId = crypto.randomUUID();
  approveFixtureContext();
  detail.guests = [{ guest_id: guestId, status: 'active' }];
  invoke.mockImplementation(async () => {
    detail.guests = [];
    return JSON.stringify({ replies: [{ text: 'Scoped reply', toPrincipals: [{ kind: 'guest', id: guestId }] }] });
  });
  await expect(runner.sharedTurn()).rejects.toThrow(/recipient.*active/i);
  expect(runner.state.shared.pending.phase).toBe('ready');
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(runner.api.mock.calls.some(call => call[0].endsWith('/finish'))).toBe(false);
});

test('removing a legacy addressed user never widens their private reply to everyone', async () => {
  invoke.mockImplementation(async () => {
    detail.members = [];
    return JSON.stringify({ replies: [{ text: 'Private reply', toUserIds: [user] }] });
  });
  await expect(runner.sharedTurn()).rejects.toThrow(/recipient.*active/i);
  expect(runner.state.shared.pending.phase).toBe('ready');
  expect(runner.api.mock.calls.some(call => call[0].endsWith('/finish'))).toBe(false);
});

test('restricted attachments use task paths and encrypted results survive restart and rekey without plaintext files', async () => {
  approveFixtureContext();
  const iv = crypto.randomBytes(12);
  const cipher = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(room + ':1') }, key, Buffer.from('guest attachment'));
  const inputFile = { id: crypto.randomUUID(), name: 'photo.txt', type: 'text/plain' };
  messages[0].payload = await C.encrypt(key, { text: 'Process the file', files: [inputFile] }, room + ':1');
  const uploads = [];
  runner.fetch = jest.fn(async (url, options = {}) => {
    if (options.method === 'POST') {
      uploads.push(Buffer.from(await options.body.get('file').arrayBuffer()));
      return new Response('{}');
    }
    return new Response(Buffer.concat([iv, Buffer.from(cipher)]));
  });
  let taskRoot;
  invoke.mockImplementation(async (_, prompts, __, ___, ____, taskFiles) => {
    const transcript = JSON.parse(prompts[1].content);
    expect(transcript[0].files[0].path).toMatch(/^\/task-inputs\//);
    expect(JSON.stringify(prompts)).not.toContain(dir);
    taskRoot = taskFiles.root;
    expect(fs.readFileSync(path.join(taskFiles.inputRoot, path.posix.basename(transcript[0].files[0].path)), 'utf8')).toBe('guest attachment');
    fs.writeFileSync(path.join(taskFiles.outputRoot, 'report.txt'), 'original result');
    return JSON.stringify({ replies: [{ text: 'Done', files: [{ path: '/task-outputs/report.txt', name: 'report.txt', type: 'text/plain', bytesBase64: Buffer.from('untrusted forged bytes').toString('base64') }] }] });
  });
  const base = runner.api;
  let failed = false;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.includes('/finish') && !failed) { failed = true; throw new Error('Network lost'); }
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow('Network lost');
  expect(fs.existsSync(taskRoot)).toBe(false);
  expect(JSON.stringify(runner.state)).not.toContain('original result');
  // Reload the encrypted journal, rather than retaining an in-memory artifact.
  runner.state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  runner.bridge.state = runner.state;
  const replacement = await C.newKey();
  detail.room.key_version = 2;
  detail.keys.push({ key_version: 2, wrapped_key: await C.wrap(replacement, pair.publicKey) });
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(uploads).toHaveLength(2);
  for (const [index, currentKey] of [key, replacement].entries()) {
    const bytes = uploads[index];
    const plaintext = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: Buffer.from(room + ':' + (index + 1)) }, currentKey, bytes.subarray(12));
    expect(Buffer.from(plaintext).toString()).toBe('original result');
  }
});

test.each(['/workspace/private.txt', '/task-inputs/file.txt', '/task-outputs/../private.txt',
  '/task-outputs/.', '/task-outputs/..', '/task-outputs/result.txt/', '/task-outputs//result.txt'
])('restricted output %s cannot request an arbitrary host export', async outputPath => {
  approveFixtureContext();
  runner.fetch = jest.fn();
  invoke.mockResolvedValue(JSON.stringify({ replies: [{ text: 'Leak', files: [{ path: outputPath }] }] }));
  await expect(runner.sharedTurn()).rejects.toThrow(/task output directory/);
  expect(runner.fetch).not.toHaveBeenCalled();
});

test('restricted result symlinks are rejected and the task files are removed', async () => {
  approveFixtureContext();
  const privateFile = path.join(dir, 'private.txt');
  fs.writeFileSync(privateFile, 'private fixture');
  let taskRoot;
  invoke.mockImplementation(async (_, __, ___, ____, _____, taskFiles) => {
    taskRoot = taskFiles.root;
    fs.symlinkSync(privateFile, path.join(taskFiles.outputRoot, 'result.txt'));
    return JSON.stringify({ replies: [{ text: 'Leak', files: [{ path: '/task-outputs/result.txt' }] }] });
  });
  await expect(runner.sharedTurn()).rejects.toThrow('regular file');
  expect(fs.existsSync(taskRoot)).toBe(false);
  expect(fs.readFileSync(privateFile, 'utf8')).toBe('private fixture');
});

test('unconfirmed container cancellation retains task files for executor review', async () => {
  approveFixtureContext();
  let files;
  invoke.mockImplementation(async (_, __, ___, ____, _____, taskFiles) => {
    files = taskFiles;
    throw Object.assign(new Error('Removal not confirmed'), { code: 'RESTRICTED_CANCELLATION_UNCONFIRMED',
      containerId: 'a'.repeat(64), containerName: 'chatspace-task-' + batch.id, retainedEngineConfiguration: '/tmp/fixture-engine-config' });
  });
  try {
    await expect(runner.sharedTurn()).rejects.toThrow('Removal not confirmed');
    expect(runner.state.shared.pending).toMatchObject({ phase: 'uncertain', taskFilesRoot: files.root, taskOutputsRoot: files.outputRoot });
    expect(fs.existsSync(files.root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(runner.supervisor.root, 'active/receipt.json'))).state).toBe('review_required');
    expect(JSON.parse(fs.readFileSync(runner.bridge.file)).shared.retainedExecutions).toEqual([expect.objectContaining({
      taskId: batch.id, containerId: 'a'.repeat(64), engineConfiguration: '/tmp/fixture-engine-config',
      taskFilesRoot: files.root, taskOutputsRoot: files.outputRoot
    })]);
    await expect(runner.sharedTurn()).rejects.toThrow('manager review');
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { files?.cleanup(); }
});

test('supervisor admission prevents copying attachments or invoking a second restricted task', async () => {
  approveFixtureContext();
  const held = runner.supervisor.acquire(crypto.randomUUID());
  messages[0].files = [{ id: crypto.randomUUID(), type: 'text/plain' }];
  try {
    await expect(runner.sharedTurn()).rejects.toThrow('supervisor review');
    expect(invoke).not.toHaveBeenCalled();
    expect(runner.api.mock.calls.some(([route]) => route.includes('/files/'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runner.supervisor.root, 'active/receipt.json'))).taskId).toBe(held.taskId);
  } finally { held.stopped(); held.release(); }
});

test('an execution error with unknown cleanup retains global admission and staged paths', async () => {
  approveFixtureContext(); let files;
  invoke.mockImplementation(async (_, __, ___, ____, _____, taskFiles) => { files = taskFiles; throw Error('Engine transport disappeared'); });
  try {
    await expect(runner.sharedTurn()).rejects.toThrow('Engine transport disappeared');
    expect(fs.existsSync(files.root)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(path.join(runner.supervisor.root, 'active/receipt.json')));
    expect(receipt).toMatchObject({ taskId: batch.id, state: 'review_required' });
    expect(runner.state.shared.retainedExecutions[0].supervisorRoot).toBe(runner.supervisor.root);
    expect(() => runner.supervisor.acquire(crypto.randomUUID())).toThrow('supervisor review');
  } finally { files?.cleanup(); }
});

test('a confirmed exact-ID journal releases admission after task failure without retrying execution', async () => {
  approveFixtureContext();
  invoke.mockImplementation(async (_, __, ___, ____, _____, taskFiles, journal) => {
    const config=path.join(dir,'engine-config');fs.mkdirSync(config,{mode:0o700});
    const s=fs.statSync(config,{bigint:true}),cid='b'.repeat(64);
    await journal.record({phase:'creating',containerName:'chatspace-task-'+crypto.randomUUID(),image:'sha256:'+'a'.repeat(64),podmanPath:'/usr/bin/podman',
      configuration:{path:config,dev:String(s.dev),ino:String(s.ino)}});
    fs.writeFileSync(journal.cidFile,cid,{mode:0o600});const f=fs.statSync(journal.cidFile,{bigint:true});
    await journal.record({phase:'created',containerId:cid,cidFile:{path:journal.cidFile,dev:String(f.dev),ino:String(f.ino)}});
    await journal.record({phase:'absent',containerId:cid});
    throw Error('Task timed out after confirmed removal');
  });
  await expect(runner.sharedTurn()).rejects.toThrow('confirmed removal');
  expect(fs.existsSync(path.join(runner.supervisor.root,'active'))).toBe(false);
  expect(runner.state.shared.pending.phase).toBe('uncertain');
  expect(runner.state.shared.retainedExecutions).toBeUndefined();
  await expect(runner.sharedTurn()).rejects.toThrow('manager review');expect(invoke).toHaveBeenCalledTimes(1);
});
test('an error-supplied cleanup flag cannot release private task admission', async () => {
  approveFixtureContext();let files;
  invoke.mockImplementation(async (_, __, ___, ____, _____, taskFiles)=>{files=taskFiles;throw Object.assign(Error('Untrusted proof'),{cleanupConfirmed:true});});
  try {
    await expect(runner.sharedTurn()).rejects.toThrow('Untrusted proof');
    expect(fs.existsSync(files.root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(runner.supervisor.root,'active/receipt.json'))).state).toBe('review_required');
  } finally {files?.cleanup();}
});

test('delivery retry after confirmed restricted completion releases admission without rerunning', async () => {
  approveFixtureContext(); const base = runner.api; let failed = false;
  runner.api = jest.fn(async (route, ...args) => {
    if (route.includes('/finish') && !failed) { failed = true; throw Error('Delivery interrupted'); }
    return base(route, ...args);
  });
  await expect(runner.sharedTurn()).rejects.toThrow('Delivery interrupted');
  expect(runner.state.shared.pending.phase).toBe('ready');
  expect(fs.existsSync(path.join(runner.supervisor.root, 'active'))).toBe(false);
  await runner.sharedTurn(); expect(invoke).toHaveBeenCalledTimes(1);
});

test('supervisor journals cannot be placed inside a restricted workspace', async () => {
  approveFixtureContext(); runner.supervisor.root = path.join(runner.profiles[0].workspaceRoot, 'supervisor');
  await expect(runner.sharedTurn()).rejects.toThrow('exclude connector credentials');
  expect(invoke).not.toHaveBeenCalled();
  expect(fs.existsSync(runner.supervisor.root)).toBe(false);
});

test('retained execution uncertainty blocks restricted work after restart but keeps legacy private work', async () => {
  approveFixtureContext();
  runner.state.shared.retainedExecutions = [{ taskId: batch.id, containerId: 'a'.repeat(64) }];
  runner.bridge.persist();
  const restored = new SharedRunner(new Bridge(JSON.parse(fs.readFileSync(runner.bridge.file)), {file: runner.bridge.file}),
    [{...runner.profiles[0], image: 'example.test/runner@sha256:' + 'a'.repeat(64), argv: ['node', 'unused']}], {invoke, deviceId: runner.deviceId});
  restored.state.shared.pending = null;
  await expect(restored.invoke(restored.profiles[0], [], room, undefined, batch.context)).rejects.toThrow('executor review');
  expect(invoke).not.toHaveBeenCalled();
  await restored.invoke({ provider: 'legacy', model: 'private', command: ['node', 'unused'] }, [], 'private');
  expect(invoke).toHaveBeenCalledTimes(1);
});

function trustFixtureContext() {
  runner.protocolVersion = 2;
  runner.executionMode = 'trusted';
  batch.context = { contextVersion: 2, conversation: { id: room },
    request: { taskId: batch.id, requester: { kind: 'user', id: user } },
    execution: { mode: 'trusted', connectorId: runner.runtimeId, isolation: 'owner-trusted' },
    authorization: { mode: 'trusted', grantId: null } };
  batch.config = { model_provider: runner.profiles[0].provider, model: runner.profiles[0].model };
}

test('trusted sharing calls the normal provider with sender metadata and no sandbox action', async () => {
  trustFixtureContext();
  await runner.sharedTurn();
  expect(invoke).toHaveBeenCalledTimes(1);
  const transcript = invoke.mock.calls[0][1];
  expect(transcript[0].content).toContain('trusted collaborators');
  const input = JSON.parse(transcript[1].content);
  expect(input[0]).toMatchObject({ name: 'Alice', sender: { kind: 'user', id: user }, content: { text: 'Work' } });
  expect(runner.supervisor.acquire).not.toHaveBeenCalled();
  expect(runner.api.mock.calls.some(([route]) => route.includes('/actions'))).toBe(false);
  expect(runner.state.shared.pending).toBeNull();
});

test.each(['codex', 'claude', 'gemini', 'antigravity', 'custom'])('trusted %s profile uses the existing argv provider and selected model', async provider => {
  runner.profiles[0] = { provider, model: 'owner-choice', managedRunner: true,
    command: [process.execPath, '-e', `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({replies:[{text:JSON.stringify({provider:process.env.CHATSPACE_SHARED_PROVIDER,model:process.env.CHATSPACE_SHARED_MODEL,input})}]})));`] };
  runner.invokeOverride = null;
  runner.state.history = { user: require('../../scripts/external-agent-bridge').seal('private history canary', runner.state.key) };
  trustFixtureContext();
  await runner.sharedTurn();
  const [, body] = runner.api.mock.calls.find(([route]) => route.endsWith('/finish'));
  const reply = await C.decrypt(key, body.messages[0].payload, `${room}:1`);
  const observed = JSON.parse(reply.text);
  expect(observed).toMatchObject({ provider, model: 'owner-choice' });
  expect(observed.input).toContain('trusted collaborators');
  expect(observed.input).toContain('Alice');
  expect(observed.input).toContain(user);
  expect(observed.input).not.toContain('private history canary');
});

test('trusted mode registers protocol 2 without a container device', async () => {
  trustFixtureContext();
  await runner.register();
  expect(runner.api).toHaveBeenCalledWith('/runtime', expect.objectContaining({ protocol: 2, executionMode: 'trusted' }));
  expect(runner.api.mock.calls.find(([route]) => route === '/runtime')[1]).not.toHaveProperty('deviceId');
});

test('a restricted runner cannot silently consume trusted-mode work', async () => {
  trustFixtureContext();
  runner.executionMode = 'restricted';
  await expect(runner.sharedTurn()).rejects.toThrow('does not match');
  expect(invoke).not.toHaveBeenCalled();
});

test('managed trusted sharing follows owner-selected providers with the same executable', () => {
  trustFixtureContext();
  runner.profiles[0] = { provider: 'antigravity', model: 'test', managedRunner: true, followAgentConfig: true,
    command: ['bash', '/owner/agent-runner.sh'], cwd: '/owner/project' };
  batch.config = { model_provider: 'codex', model: 'owner-selected' };
  expect(runner.sharedProfile(batch)).toEqual({ ...runner.profiles[0], provider: 'codex', model: 'owner-selected', runConfig: batch.config });
  expect(runner.profile(batch.config)).toEqual(runner.sharedProfile(batch));
  runner.executionMode = 'restricted';
  expect(runner.managedProfile(batch.config)).toBeNull();
});

test('managed setup writes one owner-controlled normal-runner profile', () => {
  const { prepareManagedProfile } = require('../../scripts/shared-agent-runner');
  const managed = path.join(dir, 'agent-runner.sh');
  fs.writeFileSync(managed, '#!/bin/bash\n');
  const env = { CHATSPACE_SHARED_MANAGED_RUNNER: managed, CHATSPACE_SHARED_PROJECT: dir,
    CHATSPACE_SHARED_PROFILES: path.join(dir, 'profiles.json'), CHATSPACE_SHARED_EXPORT_DIR: path.join(dir, 'exports'),
    CHATSPACE_SHARED_PROVIDER: 'antigravity', CHATSPACE_SHARED_MODEL: 'owner-model' };
  const profiles = prepareManagedProfile(env);
  expect(profiles[0]).toMatchObject({ command: ['bash', managed], cwd: dir, managedRunner: true, followAgentConfig: true });
  expect(JSON.parse(fs.readFileSync(env.CHATSPACE_SHARED_PROFILES))).toEqual(profiles);
  expect(fs.statSync(env.CHATSPACE_SHARED_PROFILES).mode & 0o077).toBe(0);
  expect(() => prepareManagedProfile({ ...env, CHATSPACE_SHARED_MANAGED_RUNNER: 'relative.sh' })).toThrow('Managed sharing requires');
});

test('generated runner hands off to one trusted listener without starting a provider', () => {
  const { spawnSync } = require('child_process');
  const { generateAgentRunner } = require('../../src/utils/apiGuideGenerator');
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'agent_state');
  fs.mkdirSync(bin); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'agent_config.json'), JSON.stringify({ model_provider: 'claude', model: 'owner-selected',
    approval_mode: 'full-auto', sandbox_mode: 'none', project_path: dir }));
  const managed = path.join(dir, 'runner.sh');
  fs.writeFileSync(managed, generateAgentRunner());
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
case "$*" in
  *sharing-status*) printf '%s' '{"enabled":true}' ;;
  *shared-runner.js*) while [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then printf '%s' '// fixture bundle' > "$2"; break; fi; shift; done ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash
if [ "$1" = '--check' ]; then exit 0; fi
printf '%s\\n' "$2" "$CHATSPACE_SHARED_MANAGED_RUNNER" "$CHATSPACE_SHARED_PROVIDER" "$CHATSPACE_SHARED_MODEL" "$CHATSPACE_SHARED_EXECUTION_MODE"
`, { mode: 0o700 });
  const result = spawnSync('bash', [managed], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, CHATSPACE_SHARED_TURN: '0',
      CHATSPACE_TRUSTED_SHARING: '1', API_BASE: 'http://127.0.0.1:1/api', API_KEY: 'fixture', AGENT_NAME: 'Fixture' } });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`run-managed\n${managed}\nclaude\nowner-selected\ntrusted`);
  expect(fs.existsSync(path.join(state, 'shared-runner.js'))).toBe(true);
});
