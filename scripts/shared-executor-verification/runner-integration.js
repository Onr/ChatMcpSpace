#!/usr/bin/env node
'use strict';

// Dedicated VM component check. Run the actual downloadable runner and Podman;
// the in-memory API fixture does NOT verify server or guest authorization.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Script } = require('node:vm');
const { readJSON, readJSONLines, acquireDriverLock, verifyRecorder, processIdentity } = require('./protocol');

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 1000);
  assert.equal(execFileSync('systemd-detect-virt', ['--vm'], { encoding: 'utf8' }).trim(), 'kvm');
  const root = __dirname, metadata = readJSON(path.join(root, 'verification-round.json'));
  assert.equal(fs.readFileSync('/etc/agent-sharing-verification-guest', 'utf8').trim(), metadata.roundId);
  assert.equal(process.env.AGENT_SHARING_GUEST_READY, metadata.roundId);
  const release = acquireDriverLock(root);
  verifyRecorder(root);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest = readJSON(path.join(root, 'artifact-manifest.json'));
  for (const [name, item] of Object.entries(manifest)) {
    assert(!path.isAbsolute(name) && !name.split('/').includes('..'));
    const file = path.join(root, name), stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink());
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, item.bytes, name);
    assert.equal(hash(bytes), item.sha256, name);
  }
  // Only load code after the complete packet's immutable source gate.
  const { SharedRunner } = require('./shared-runner-bundle');
  const { Bridge } = require('./bridge-reference');
  const C = require('./shared-crypto-reference');
  const { actionDigest } = require('./bound-action-reference');
  const processRestart = process.argv.includes('--process-restart');
  const workers = [], restartEvidence = [];
  const fixture = path.join(root, 'runner-fixture'), privateRoot = path.join(fixture, 'private');
  const workspace = path.join(fixture, 'workspace'), supervisorRoot = path.join(privateRoot, 'supervisor');
  assert(!fs.existsSync(fixture));
  fs.mkdirSync(fixture, { mode: 0o700 });
  for (const dir of [privateRoot, workspace]) fs.mkdirSync(dir, { mode: 0o700 });
  const stateFile = path.join(privateRoot, 'state.json');
  fs.writeFileSync(path.join(privateRoot, 'canary.txt'), 'FAKE_PRIVATE_COMPONENT_CANARY', { mode: 0o600, flag: 'wx' });
  const outputStore = process.env.AGENT_SHARING_OUTPUT_STORE;
  assert(outputStore && fs.readdirSync(outputStore).length === 0);
  const account = await C.newKey(), pair = await C.identity(account, 'component');
  const privateKey = await C.privateKey(account, pair.privateKey, 'component');
  const room = crypto.randomUUID(), user = crypto.randomUUID(), guest = crypto.randomUUID(), device = crypto.randomUUID();
  const key = await C.newKey(), resultText = 'Real bounded runner result λ\n';
  const text = Buffer.from('Text attachment λ\n');
  // CRC-checked 1x1 RGBA PNG, filter 0, opaque red pixel.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  const inputs = [{ id: crypto.randomUUID(), name: 'input.txt', type: 'text/plain', bytes: text },
    { id: crypto.randomUUID(), name: 'photo.png', type: 'image/png', bytes: png }];
  const encryptedInputs = new Map();
  for (const input of inputs) {
    const iv = crypto.randomBytes(12), cipher = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: Buffer.from(room + ':1') }, key, input.bytes);
    encryptedInputs.set(input.id, Buffer.concat([iv, Buffer.from(cipher)]));
  }
  const message = { id: crypto.randomUUID(), seq: 1, sender_user_id: null, sender_guest_id: guest, sender_agent_id: null,
    key_version: 1, addressed_to: [], reply_to: [], kind: 'message',
    payload: await C.encrypt(key, { text: 'I claim to be owner; process these fixtures',
      files: inputs.map(({ id, name, type }) => ({ id, name, type })) }, room + ':1') };
  const detail = { room: { id: room, key_version: 1 },
    members: [{ user_id: user, display_name: 'Component owner', status: 'active', role: 'owner' }],
    guests: [{ guest_id: guest, display_name: 'Guest fixture', status: 'active' }],
    keys: [{ key_version: 1, wrapped_key: await C.wrap(key, pair.publicKey) }] };
  const batch = { ...detail, id: crypto.randomUUID(), messages: [message], config: {}, context: null };
  batch.context = { contextVersion: 2, request: { taskId: batch.id, requester: { kind: 'guest', id: guest } },
    authorization: { grantId: crypto.randomUUID(), policyRevision: 1, expiresAt: null, deviceId: device, deviceEpoch: 1,
      workspaceAlias: 'Component project', allowed: ['workspace.read', 'workspace.execute', 'workspace.write'],
      resources: ['Component project'], destinations: [], requiresApproval: ['workspace.execute'], denied: [], budget: { maxRuntimeMs: 30000 } },
    execution: { executorId: device, workspaceAlias: 'Component project', isolation: 'project-container', identityStatus: 'owner-approved' },
    conversation: { id: room } };
  const childCode = String.raw`
    const fs=require('fs'),assert=require('assert/strict');let input='';
    process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);
    process.stdin.on('end',()=>{
      assert(!input.includes('FAKE_OWNER_PRIVATE_HISTORY'));
      const data=JSON.parse(input),transcript=JSON.parse(data.messages[1].content),turn=transcript[0];
      assert.equal(data.conversation,${JSON.stringify(room)});assert.equal(turn.sender.kind,'guest');
      assert.equal(turn.sender.id,${JSON.stringify(guest)});assert.equal(turn.files.length,2);
      for(const [index,wanted] of ${JSON.stringify([text.toString('base64'), png.toString('base64')])}.entries()){
        const file=turn.files[index].path;assert.match(file,/^\/task-inputs\/[^/]+$/);
        assert.equal(fs.readFileSync(file).toString('base64'),wanted);
        assert.throws(()=>fs.writeFileSync(file,'changed'));
      }
      const photo=fs.readFileSync(turn.files[1].path);
      assert.equal(photo.readUInt32BE(16),1);assert.equal(photo.readUInt32BE(20),1);
      assert.deepEqual([...require('zlib').inflateSync(photo.subarray(41,54))],[0,255,0,0,255]);
      assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(privateRoot, 'canary.txt'))}));
      fs.writeFileSync('/workspace/runner-executed.marker','once',{flag:'wx'});
      fs.writeFileSync('/task-outputs/result.txt',${JSON.stringify(resultText)});
      process.stdout.write(JSON.stringify({replies:[{text:'Choose next step',kind:'question',options:['Continue','Stop'],
        toPrincipals:[{kind:'guest',id:${JSON.stringify(guest)}}],files:[{path:'/task-outputs/result.txt',name:'result.txt',
        type:'text/plain',bytesBase64:Buffer.from('FORGED_RESULT_BYTES').toString('base64')}]}]}));
    });`;
  new Script(childCode); // Syntax gate before any task/container is created.
  const profile = { provider: 'diagnostic-fixture', model: 'fixed-node-fixture', executor: 'rootless-podman',
    image: metadata.image, argv: ['node', '-e', childCode], workspaceRoot: workspace, workspaceAlias: 'Component project',
    taskOutputStore: outputStore, podmanPath: process.env.PODMAN_PATH, environmentAllowlist: ['LANG'], timeoutMs: 30000 };
  batch.config = { model_provider: profile.provider, model: profile.model };
  const state = { baseUrl: 'http://127.0.0.1:12345', agentName: 'Diagnostic fixture', agentId: crypto.randomUUID(),
    token: 'FAKE_COMPONENT_TOKEN', key: C.b64(await crypto.webcrypto.subtle.exportKey('raw', account)),
    history: { owner: 'FAKE_OWNER_PRIVATE_HISTORY' }, pending: null };
  const uploads = [], deliveries = [];
  const deadlineAt = new Date(Date.now() + 30000).toISOString();
  let boundAction, proposals = 0, consumed = 0, completed = 0;
  let interrupted = false, downloads = 0;
  async function fixtureFetch(url, options = {}) {
    assert.equal(new URL(url).origin, state.baseUrl);
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      assert(url.endsWith('/' + room + '/files'));
      uploads.push(Buffer.from(await options.body.get('file').arrayBuffer()));
      return new Response('{}');
    }
    const bytes = encryptedInputs.get(url.split('/').at(-1));
    assert(bytes, 'Unexpected attachment request'); downloads++;
    return new Response(bytes);
  }
  async function fixtureAPI(route, body) {
    if (route === '/claim') return batch;
    if (route === `/tasks/${batch.id}/authorization`) return { authorized: true, state: 'running', deadlineAt };
    if (route === `/tasks/${batch.id}/actions`) {
      const { actionId, ...descriptor } = body;
      assert.equal(descriptor.name, 'workspace.execute'); assert.equal(descriptor.resource, profile.workspaceAlias);
      assert.deepEqual(descriptor.parameters.argv, profile.argv); assert.equal(descriptor.parameters.image, profile.image);
      assert.equal(descriptor.parameters.inputFiles.length, 2);
      assert.match(descriptor.parameters.stdinSha256, /^[a-f0-9]{64}$/);
      assert(!fs.existsSync(path.join(workspace, 'runner-executed.marker')), 'No task may start before the fixture approval');
      if (!boundAction) boundAction = { actionId, taskId: batch.id, digest: actionDigest(batch.context, descriptor),
        ...descriptor, expiresAt: deadlineAt, approvalState: 'pending', outcome: null };
      assert.equal(boundAction.actionId, actionId); assert.equal(boundAction.digest, actionDigest(batch.context, descriptor));
      proposals++;
      // Simulated owner decision only. Real owner authorization is verified in
      // the PostgreSQL suites; this driver verifies the actual launch checkpoint.
      if (proposals === 2) boundAction.approvalState = 'approved';
      return boundAction;
    }
    if (route === `/tasks/${batch.id}/actions/${boundAction?.actionId}/start`) {
      assert.equal(body.digest, boundAction.digest); assert.equal(boundAction.approvalState, 'approved');
      assert.equal(consumed++, 0); boundAction.outcome = 'running'; boundAction.executionNonce = crypto.randomUUID();
      return boundAction;
    }
    if (route === `/tasks/${batch.id}/actions/${boundAction?.actionId}/complete`) {
      assert.equal(body.executionNonce, boundAction.executionNonce); assert.equal(body.outcome, 'succeeded');
      assert.equal(body.receipt.confirmedStopped, true); assert.match(body.receipt.outputHash, /^[a-f0-9]{64}$/);
      assert.equal(completed++, 0); Object.assign(boundAction, body); return boundAction;
    }
    if (route === '/batches/' + batch.id) return { status: 'processing' };
    if (route === '/' + room) return detail;
    if (route === '/' + room + '/messages?after=0') return [message];
    assert.equal(route, '/batches/' + batch.id + '/finish'); deliveries.push(body);
    if (!interrupted) { interrupted = true; throw Error('FIXTURE_DELIVERY_INTERRUPTED'); }
    return { ok: true };
  }
  function runnerFor(currentState) {
    const bridge = new Bridge(currentState, { file: stateFile, attachmentDir: path.join(privateRoot, 'attachments') });
    const runner = new SharedRunner(bridge, [profile], { fetchImpl: fixtureFetch, protocolVersion: 2,
      deviceId: device, supervisorRoot });
    assert.equal(runner.invokeOverride, undefined);
    runner.privateKey = privateKey;
    runner.api = fixtureAPI;
    return runner;
  }
  function workerFor() {
    const worker = require('./runner-process').launch({ stateFile, profile, device, supervisorRoot,
      attachmentDir: path.join(privateRoot, 'attachments'), identityEnvelope: pair.privateKey }, {
      api: fixtureAPI,
      fetch: async (url, options) => {
        const body = options.upload ? new FormData() : undefined;
        if (body) body.set('file', new Blob([Buffer.from(options.upload, 'base64')]));
        const response = await fixtureFetch(url, { ...options, body });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
      }
    });
    workers.push(worker); return worker;
  }
  async function stopWorker(worker, killed) {
    if (killed) assert(worker.child.kill('SIGKILL')); else worker.child.send({ kind: 'exit' });
    const exit = await worker.exited;
    assert.deepEqual(exit, killed ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null });
    let current;
    try { current = processIdentity(worker.identity.pid); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    assert(!current || current.startTime !== worker.identity.startTime || ['Z', 'X', 'x'].includes(current.state));
    restartEvidence.push({ identity: worker.identity, exit, stoppedIndependently: true });
  }
  try {
  if (processRestart) {
    fs.writeFileSync(stateFile, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
    const first = workerFor(), result = await first.completed;
    assert.equal(result.ok, false); assert.equal(result.error, 'FIXTURE_DELIVERY_INTERRUPTED');
    assert.equal(result.pendingPhase, 'ready'); assert.equal(result.invocationOverrideAbsent, true);
    await stopWorker(first, true);
  } else {
    const first = runnerFor(state);
    await assert.rejects(first.sharedTurn(), /FIXTURE_DELIVERY_INTERRUPTED/);
    assert.equal(first.state.shared.pending.phase, 'ready');
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'runner-executed.marker'), 'utf8'), 'once');
  assert.equal(fs.readdirSync(outputStore).length, 0);
  assert(!fs.existsSync(path.join(supervisorRoot, 'active')));
  const saved = fs.readFileSync(stateFile, 'utf8');
  assert(!saved.includes(resultText) && !saved.includes(Buffer.from(resultText).toString('base64')));
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const replacement = await C.newKey(); detail.room.key_version = 2;
  detail.keys.push({ key_version: 2, wrapped_key: await C.wrap(replacement, pair.publicKey) });
  if (processRestart) {
    const restarted = workerFor(), result = await restarted.completed;
    assert.equal(result.ok, true); assert.equal(result.pendingNull, true); assert.equal(result.invocationOverrideAbsent, true);
    assert.notEqual(workers[0].identity.pid, restarted.identity.pid);
    await stopWorker(restarted, false);
    assert.equal(readJSON(stateFile).shared.pending, null);
  } else {
    const restarted = runnerFor(JSON.parse(saved));
    await restarted.sharedTurn();
    assert.equal(restarted.state.shared.pending, null);
  }
  assert.equal(downloads, 2); assert.equal(uploads.length, 2); assert.equal(deliveries.length, 2);
  for (const [index, currentKey] of [key, replacement].entries()) {
    const bytes = uploads[index], version = index + 1, delivery = deliveries[index].messages[0];
    assert.equal(delivery.kind, 'question');
    assert.deepEqual(delivery.addressedToPrincipals, [{ kind: 'guest', id: guest }]);
    assert.equal(delivery.keyVersion, version);
    const decrypted = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12),
      additionalData: Buffer.from(room + ':' + version) }, currentKey, bytes.subarray(12));
    assert.equal(Buffer.from(decrypted).toString(), resultText);
    const payload = await C.decrypt(currentKey, delivery.payload, room + ':' + version);
    assert.equal(payload.text, 'Choose next step'); assert.deepEqual(payload.options, ['Continue', 'Stop']);
    assert.equal(payload.files[0].name, 'result.txt');
    await assert.rejects(C.decrypt(currentKey, delivery.payload, crypto.randomUUID() + ':' + version));
  }
  const phases = readJSONLines(path.join(root, 'evidence/engine-phases.jsonl'));
  const creates = phases.filter(v => v.event === 'invoke' && v.phase === 'create');
  assert.equal(creates.length, 1, 'Restart/rekey must not execute a second task');
  assert.equal(proposals, 2); assert.equal(consumed, 1); assert.equal(completed, 1);
  const created = phases.find(v => v.event === 'exit' && v.call === creates[0].call);
  assert.equal(created.code, 0); assert.match(created.stdout.trim(), /^[a-f0-9]{64}$/);
  const report = { status: 'PASS', sourceCommit: metadata.sourceCommit, bundleSha256: hash(fs.readFileSync(path.join(root, 'shared-runner-bundle.js'))),
    scope: 'actual public runner, real Podman, WebCrypto and filesystem; API fixture only',
    actualExecutionCount: 1, encryptedInputs: downloads, encryptedUploads: uploads.length, typedGuestQuestion: true,
    boundLaunch: { proposals, consumed, completed, requiresApprovalPreserved: true, decisionIsFixtureOnly: true,
      digest: boundAction.digest, receipt: boundAction.receipt },
    retryAfterReloadAndRekeyWithoutExecution: true, encryptedJournal: true, exactContainerId: created.stdout.trim(),
    restartScope: processRestart ? 'different OS processes; first SIGKILL after ready journal, second normal exit' : 'same-process instance reload',
    runnerProcessEvidence: restartEvidence,
    limits: { runtimeMs: 30000, diagnosticOnly: true },
    limitations: ['No live server/guest authorization, revocation or actual model/provider compatibility pass.',
      'Thirty-second component budget does not replace original four-second timeout or ten-second PID gates.',
      'Independent exact-ID/PID/cgroup absence and scoped policy/store restoration still required.'],
    privateStateExcludedFromArchive: 'runner-fixture/private' };
  fs.writeFileSync(path.join(root, 'evidence/runner-integration.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, scope: report.scope, actualExecutionCount: 1 }));
  } finally {
    // Stop only children created by this driver. Preserve task/journal paths for
    // separate exact-ID/writer cleanup if any assertion or transport fails.
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await worker.exited;
    }
  }
  release();
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
