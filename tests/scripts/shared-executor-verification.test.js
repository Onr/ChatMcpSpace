const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn } = require('child_process');
const { publishJSON, readJSON, waitForJSON, readJSONLines, phaseReader, processIdentity, acquireDriverLock, verifyRecorder, requiredResultsExitCode, readCgroupSample } = require('../../scripts/shared-executor-verification/protocol');
const { taskContainerIds } = require('../../scripts/shared-executor-verification/task-files-cleanup');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-harness-protocol-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('required evidence exits unsuccessfully for the observed 17-pass/one-blocked timeout round', () => {
  const records = Array.from({ length: 17 }, () => ({ status: 'PASS' }));
  records.push({ status: 'BLOCKED', subcase: 'exact identity descendants stopped timeout' });
  expect(requiredResultsExitCode(records, 18)).toBe(1);
  // Classification is retained; the aggregator does not relabel it as a pass or failure.
  expect(records.at(-1).status).toBe('BLOCKED');
  records[17] = { status: 'PASS' };
  expect(requiredResultsExitCode(records, 18)).toBe(0);
});

test.each(['FAIL', 'BLOCKED', 'SKIPPED', 'UNVERIFIED', 'UNKNOWN', undefined, null])('a required %s result cannot yield a successful exit', status => {
  expect(requiredResultsExitCode([{ status }], 1)).toBe(1);
});

test.each([[], [null], ['PASS'], [[]], [{ status: 'PASS' }, { status: 'PASS' }], undefined])('missing, malformed or extra required evidence fails closed: %j', records => {
  expect(requiredResultsExitCode(records, 1)).toBe(1);
});

test.each([0, -1, 1.5, undefined, NaN])('an invalid required evidence count %s cannot pass', count => {
  expect(requiredResultsExitCode([{ status: 'PASS' }], count)).toBe(1);
});

test('sparse results and inherited statuses cannot fill a missing evidence record', () => {
  expect(requiredResultsExitCode(new Array(1), 1)).toBe(1);
  expect(requiredResultsExitCode([Object.create({ status: 'PASS' })], 1)).toBe(1);
});

test('complete JSON publication waits for temporary link cleanup without dropping mutation checks', async () => {
  const temporary = path.join(root, 'publication.tmp'), file = path.join(root, 'ready.json');
  fs.writeFileSync(temporary, '{"ready":true}', { mode: 0o600 });
  fs.linkSync(temporary, file);
  expect(() => readJSON(file)).toThrow(expect.objectContaining({ code: 'HARNESS_PUBLICATION_PENDING' }));
  const waiting = waitForJSON(file, 1000);
  fs.unlinkSync(temporary);
  await expect(waiting).resolves.toEqual({ ready: true });
});

test('unfinished publication remains blocked and a completed document mutation is never retried as success', async () => {
  const temporary = path.join(root, 'publication.tmp'), file = path.join(root, 'ready.json');
  fs.writeFileSync(temporary, '{"ready":true}', { mode: 0o600 }); fs.linkSync(temporary, file);
  await expect(waitForJSON(file, 10)).rejects.toHaveProperty('code', 'HARNESS_BARRIER_TIMEOUT');
  fs.unlinkSync(temporary);
  const read = fs.readSync;
  const spy = jest.spyOn(fs, 'readSync').mockImplementationOnce((...args) => {
    const count = read(...args); fs.writeFileSync(file, '{"ready":false}'); return count;
  });
  try { await expect(waitForJSON(file)).rejects.toThrow('changed during read'); }
  finally { spy.mockRestore(); }
});

test('a disappearing cgroup preserves partial samples and never asserts writer stoppage', () => {
  fs.writeFileSync(path.join(root, 'pids.current'), '8\n');
  fs.writeFileSync(path.join(root, 'pids.events'), 'max 2\n');
  const result = readCgroupSample(root, { elapsedMs: 100 });
  expect(result).toEqual({ elapsedMs: 100, 'pids.current': '8', 'pids.events': 'max 2', observationEnded: { file: 'memory.events', code: 'ENOENT' } });
  expect(result).not.toHaveProperty('workloadStopped');
});

test.each(['ENODEV', 'EACCES', 'EIO'])('kernel observation %s is preserved or fails closed', code => {
  const read = fs.readFileSync;
  const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (file === path.join(root, 'pids.current')) throw Object.assign(Error('controlled read failure'), { code });
    return read(file, ...args);
  });
  try {
    if (code === 'ENODEV') expect(readCgroupSample(root, {})).toEqual({ observationEnded: { file: 'pids.current', code } });
    else expect(() => readCgroupSample(root, {})).toThrow(expect.objectContaining({ code }));
  } finally { spy.mockRestore(); }
});

test('a reader never sees the partial writer document before atomic publication', async () => {
  const writer = path.join(root, 'writer.js');
  fs.writeFileSync(writer, `
    const fs=require('fs'),file=process.argv[2],temporary=file+'.partial';
    const fd=fs.openSync(temporary,'wx',0o600);
    fs.writeSync(fd,'{"phase":');
    process.send('partial');
    process.on('message',()=>{
      fs.writeSync(fd,'"create","where":"after"}\\n');fs.closeSync(fd);
      fs.linkSync(temporary,file);fs.unlinkSync(temporary);process.disconnect();
    });
  `);
  const file = path.join(root, 'ready.json');
  const child = fork(writer, [file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise(resolve => child.once('message', resolve));
    expect(fs.existsSync(file)).toBe(false);
    const waiting = waitForJSON(file);
    child.send('publish');
    await expect(waiting).resolves.toEqual({ phase: 'create', where: 'after' });
    expect(await exited).toBe(0);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('a second driver cannot replace an active control document', () => {
  const file = path.join(root, 'control.json');
  publishJSON(file, { owner: 'first' });
  expect(() => publishJSON(file, { owner: 'second' })).toThrow(/EEXIST/);
  expect(readJSON(file)).toEqual({ owner: 'first' });
  expect(fs.readdirSync(root)).toEqual(['control.json']);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('result updates replace complete private documents and reject symlinks', () => {
  const file = path.join(root, 'result.json');
  publishJSON(file, { result: 'first' }, { replace: true });
  publishJSON(file, { result: 'last' }, { replace: true });
  expect(readJSON(file)).toEqual({ result: 'last' });
  const link = path.join(root, 'link.json');
  fs.symlinkSync(file, link);
  expect(() => readJSON(link)).toThrow();
  expect(() => publishJSON(link, {}, { replace: true })).toThrow('privately owned');
  expect(readJSON(file)).toEqual({ result: 'last' });
});

test('malformed and oversized barrier documents fail rather than pretending to wait', async () => {
  const file = path.join(root, 'ready.json');
  fs.writeFileSync(file, '{');
  await expect(waitForJSON(file, 100)).rejects.toBeInstanceOf(SyntaxError);
  fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 1));
  expect(() => readJSON(file)).toThrow('bounded regular file');
  await expect(waitForJSON(path.join(root, 'missing'), 10)).rejects.toHaveProperty('code', 'HARNESS_BARRIER_TIMEOUT');
});

test('JSONL readers tolerate an unfinished append but reject a malformed complete record', () => {
  const file = path.join(root, 'phases.jsonl');
  fs.writeFileSync(file, '{"phase":"create"}\n{"phase":');
  expect(readJSONLines(file)).toEqual([{ phase: 'create' }]);
  fs.appendFileSync(file, '"init"}\n');
  expect(readJSONLines(file)).toEqual([{ phase: 'create' }, { phase: 'init' }]);
  fs.appendFileSync(file, '{bad}\n');
  expect(() => readJSONLines(file)).toThrow();
});

test('incremental phase reads retain partial UTF-8 records and reject inode replacement', () => {
  const file = path.join(root, 'phases.jsonl');
  const read = phaseReader(file);
  expect(read()).toEqual([]);
  const bytes = Buffer.from('{"phase":"λ"}\n');
  const split = bytes.indexOf(Buffer.from('λ')) + 1;
  fs.writeFileSync(file, bytes.subarray(0, split));
  expect(read()).toEqual([]);
  fs.appendFileSync(file, bytes.subarray(split));
  expect(read()).toEqual([{ phase: 'λ' }]);
  expect(read()).toEqual([]);
  fs.renameSync(file, file + '.old');
  fs.writeFileSync(file, '{"phase":"replacement"}\n');
  expect(() => read()).toThrow('changed identity');
});

test('incremental phase reads reject truncation and process observations use exact start time', () => {
  const file = path.join(root, 'phases.jsonl');
  fs.writeFileSync(file, '{"phase":"start"}\n');
  const read = phaseReader(file);
  expect(read()).toEqual([{ phase: 'start' }]);
  fs.truncateSync(file, 0);
  expect(() => read()).toThrow('changed identity');
  const first = processIdentity(process.pid);
  expect(first.pid).toBe(process.pid);
  expect(first.startTime).toMatch(/^[1-9][0-9]*$/);
  expect(processIdentity(process.pid).startTime).toBe(first.startTime);
  expect(() => processIdentity(1)).toThrow('Invalid observed process');
});

test('cleanup resolves only exact task volume IDs and retains unknown or failed create identities', () => {
  const files = { inputRoot: '/private-input', outputRoot: '/bounded-output' };
  const own = { event: 'invoke', phase: 'create', call: 'own', argv: ['create', '--volume', files.inputRoot + ':/task-inputs:ro,nosuid,nodev,noexec'] };
  const other = { event: 'invoke', phase: 'create', call: 'other', argv: ['create', '--volume', '/unrelated:/workspace:rw', files.inputRoot + ':/task-inputs:ro,nosuid,nodev,noexec'] };
  const exit = { event: 'exit', call: 'own', code: 0, stdout: 'a'.repeat(64) + '\n' };
  expect(taskContainerIds(files, [own, exit, other])).toEqual(['a'.repeat(64)]);
  expect(taskContainerIds(files, [other])).toEqual([]);
  expect(() => taskContainerIds(files, [own])).toThrow('identity is unknown');
  expect(() => taskContainerIds(files, [own, { ...exit, stdout: 'partial' }])).toThrow('identity is unknown');
  expect(() => taskContainerIds(files, [own, { ...exit, code: 1 }])).toThrow('identity is unknown');
});

test('only one driver owns a private round and release refuses a replaced lock inode', () => {
  const release = acquireDriverLock(root);
  const file = path.join(root, '.driver-lock.json');
  expect(readJSON(file)).toMatchObject({ pid: process.pid });
  expect(() => acquireDriverLock(root)).toThrow(/EEXIST/);
  fs.renameSync(file, file + '.saved');
  publishJSON(file, { pid: 999999 });
  expect(() => release()).toThrow('identity changed');
  expect(readJSON(file).pid).toBe(999999);
  fs.unlinkSync(file);
  fs.renameSync(file + '.saved', file);
  release();
  expect(fs.existsSync(file)).toBe(false);
  acquireDriverLock(root)();
});

function raceWorker(target, canary, stop) {
  for (const name of ['protocol.js', 'workspace-race-worker.js']) {
    fs.copyFileSync(path.join(__dirname, '../../scripts/shared-executor-verification', name), path.join(root, name));
  }
  const child = spawn(process.execPath, [path.join(root, 'workspace-race-worker.js'), '--workspace-race-worker', target, canary, stop], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal, stderr })); child.once('error', reject); });
  return { child, exited };
}

test('a workspace worker joins its live parent, actually races, and leaves the driver lock owned by the parent', async () => {
  const fixture = path.join(root, 'fixtures');
  const target = path.join(fixture, 'workspace'), canary = path.join(fixture, 'canary'), stop = path.join(fixture, 'stop');
  for (const dir of [fixture, target, canary]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(canary, 'private.txt'), 'FAKE_CANARY');
  const original = fs.statSync(target, { bigint: true });
  const release = acquireDriverLock(root), owner = readJSON(path.join(root, '.driver-lock.json'));
  const { child, exited } = raceWorker(target, canary, stop);
  try {
    const ready = await waitForJSON(stop + '.ready', 5000);
    expect(ready).toMatchObject({ ready: true, pid: child.pid });
    expect(processIdentity(child.pid).startTime).toBe(ready.startTime);
    await new Promise(resolve => setTimeout(resolve, 25));
    fs.writeFileSync(stop, 'stop', { mode: 0o600, flag: 'wx' });
    expect(await exited).toEqual({ code: 0, signal: null, stderr: '' });
    expect(readJSON(stop + '.counts')).toMatchObject({ completed: true });
    expect(readJSON(stop + '.counts').replacements).toBeGreaterThan(0);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.statSync(target, { bigint: true }).ino).toBe(original.ino);
    expect(fs.readFileSync(path.join(canary, 'private.txt'), 'utf8')).toBe('FAKE_CANARY');
    expect(readJSON(path.join(root, '.driver-lock.json'))).toEqual(owner);
    expect(() => acquireDriverLock(root)).toThrow(/EEXIST/);
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    release();
  }
});

test('a standalone worker without its parent lock fails before publishing readiness or changing paths', async () => {
  const fixture = path.join(root, 'fixtures'), target = path.join(fixture, 'workspace'), canary = path.join(fixture, 'canary'), stop = path.join(fixture, 'stop');
  for (const dir of [fixture, target, canary]) fs.mkdirSync(dir, { mode: 0o700 });
  const original = fs.statSync(target).ino;
  const { exited } = raceWorker(target, canary, stop);
  expect((await exited).code).toBe(1);
  expect(fs.existsSync(stop + '.ready')).toBe(false);
  expect(fs.statSync(target).ino).toBe(original);
});

test('a worker rejects a substituted parent identity and retains that lock', async () => {
  const owner = { ...processIdentity(process.pid), startTime: '1', nonce: 'test-owner' };
  publishJSON(path.join(root, '.driver-lock.json'), owner);
  const { exited } = raceWorker(path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'stop'));
  const result = await exited;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Worker driver identity changed');
  expect(readJSON(path.join(root, '.driver-lock.json'))).toEqual(owner);
});

test('a driver rejects missing, cross-round, symlink and non-executable recorders before execution', () => {
  const previousPath = process.env.PODMAN_PATH, previousRound = process.env.AGENT_SHARING_ROUND_DIR;
  const recorder = path.join(root, 'podman-phase-recorder.js');
  try {
    delete process.env.PODMAN_PATH;
    delete process.env.AGENT_SHARING_ROUND_DIR;
    expect(() => verifyRecorder(root)).toThrow('same private round');
    process.env.PODMAN_PATH = path.join(root, 'another-round', 'podman-phase-recorder.js');
    expect(() => verifyRecorder(root)).toThrow('same private round');
    process.env.PODMAN_PATH = recorder;
    fs.writeFileSync(recorder, '#!/usr/bin/env node\n', { mode: 0o700 });
    expect(() => verifyRecorder(root)).not.toThrow();
    process.env.AGENT_SHARING_ROUND_DIR = path.join(root, 'another-round');
    expect(() => verifyRecorder(root)).toThrow('same private round');
    delete process.env.AGENT_SHARING_ROUND_DIR;
    fs.chmodSync(recorder, 0o600);
    expect(() => verifyRecorder(root)).toThrow('private executable');
    fs.renameSync(recorder, recorder + '.saved');
    fs.symlinkSync(recorder + '.saved', recorder);
    expect(() => verifyRecorder(root)).toThrow('private executable');
  } finally {
    if (previousPath === undefined) delete process.env.PODMAN_PATH; else process.env.PODMAN_PATH = previousPath;
    if (previousRound === undefined) delete process.env.AGENT_SHARING_ROUND_DIR; else process.env.AGENT_SHARING_ROUND_DIR = previousRound;
  }
});
