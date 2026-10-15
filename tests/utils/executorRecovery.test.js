'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { ExecutionSupervisor } = require('../../src/shared/executorSupervisor');
const { reviewExecutorRecovery } = require('../../src/shared/executorRecovery');
let dir, root, lease, stages, configuration, podmanPath, receiptPath, queryLog;
const cid = 'b'.repeat(64);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-recovery-test-'));
  root = path.join(dir, 'supervisor');
  lease = new ExecutionSupervisor({ root }).acquire(crypto.randomUUID());
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-task-files-'));
  stages = { root: stageRoot, inputRoot: path.join(stageRoot, 'inputs'), outputRoot: fs.mkdtempSync(path.join(dir, 'chatspace-task-outputs-')) };
  fs.mkdirSync(stages.inputRoot, { mode: 0o700 }); lease.staged(stages); lease.start();
  configuration = fs.mkdtempSync(path.join(os.tmpdir(), 'chatspace-engine-config-'));
  const stat = fs.statSync(configuration, { bigint: true });
  const journal = lease.journal();
  journal.record({ phase: 'creating', containerName: 'chatspace-task-' + crypto.randomUUID(), image: 'sha256:' + 'a'.repeat(64),
    podmanPath: '/untrusted/receipt/engine', configuration: { path: configuration, dev: String(stat.dev), ino: String(stat.ino) } });
  fs.writeFileSync(journal.cidFile, cid, { mode: 0o600 });
  const c = fs.statSync(journal.cidFile, { bigint: true });
  journal.record({ phase: 'created', containerId: cid, cidFile: { path: journal.cidFile, dev: String(c.dev), ino: String(c.ino) } });
  lease.retain(); receiptPath = path.join(root, 'active', 'receipt.json');
  queryLog = path.join(dir, 'queries.jsonl'); podmanPath = path.join(dir, 'engine');
  const receipt = readReceipt();
  const inspection = { Id: cid, Name: receipt.engine.containerName, ImageName: receipt.engine.image, Config: { Labels: {
    'chatspace.task': receipt.taskId, 'chatspace.lease': receipt.leaseId } }, State: { Status: 'exited', Running: false, Pid: 0 } };
  fs.writeFileSync(path.join(dir, 'inspection.json'), JSON.stringify(inspection));
  engine('absent');
});
afterEach(() => {
  lease?.close();
  // Only these filesystem/subprocess fixtures. No actual Podman/task is involved.
  for (const p of [stages.root, configuration, dir]) fs.rmSync(p, { recursive: true, force: true });
  delete process.env.RECOVERY_FAKE_SECRET;
});
function readReceipt() { return JSON.parse(fs.readFileSync(receiptPath || path.join(root, 'active', 'receipt.json'))); }
function change(fn) { const r = readReceipt(); fn(r); fs.writeFileSync(receiptPath, JSON.stringify(r) + '\n'); }
function engine(mode) {
  fs.writeFileSync(podmanPath, '#!' + process.execPath + '\n' + `
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),dir=${JSON.stringify(dir)},mode=${JSON.stringify(mode)};
fs.appendFileSync(path.join(dir,'queries.jsonl'),JSON.stringify({args,keys:Object.keys(process.env),config:fs.readFileSync(process.env.CONTAINERS_CONF,'utf8')})+'\\n');
if(mode==='receipt-change')fs.appendFileSync(${JSON.stringify(path.join(root, 'active', 'receipt.json'))},' ');
if(mode==='root-change'){fs.renameSync(${JSON.stringify(root)},${JSON.stringify(root + '-saved')});fs.mkdirSync(${JSON.stringify(root)},{mode:0o700});}
if(args[0]!=='--remote=false')process.exit(9);
if(args[1]==='container'&&args[2]==='exists'){
 if(mode==='query-error'){console.error('FAKE_PRIVATE_DIAGNOSTIC');process.exit(1);}
 process.exit(mode==='present'?0:1);
}
if(args[1]==='container'&&args[2]==='inspect')console.log(fs.readFileSync(path.join(dir,'inspection.json'),'utf8'));else process.exit(9);
`, { mode: 0o700 });
}
function review() { return reviewExecutorRecovery({ root, podmanPath }); }
function queries() { return fs.existsSync(queryLog) ? fs.readFileSync(queryLog, 'utf8').trim().split('\n').map(JSON.parse) : []; }
function deadOwner() {
  const identity = JSON.parse(execFileSync(process.execPath, ['-e', "const fs=require('fs'),s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);console.log(JSON.stringify({pid:process.pid,startTime:f[19]}))"], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }));
  change(r => { r.ownerProcess = identity; });
}
test('real exited process identity and exact silent absence are review only, never admission release', async () => {
  deadOwner(); const before = fs.readFileSync(receiptPath), report = await review();
  expect(report).toMatchObject({ mode: 'review_only', ownerProcess: { absentOrStopped: true }, container: { id: cid, exactAbsence: true }, admissionCleared: false });
  expect(report.receiptSha256).toBe(crypto.createHash('sha256').update(before).digest('hex'));
  expect(report.blockers).toContain('Operator stoppage, descendant/late-start proof and staged cleanup remain required');
  expect(fs.readFileSync(receiptPath)).toEqual(before);
  expect(() => new ExecutionSupervisor({ root }).acquire(crypto.randomUUID())).toThrow('supervisor review');
  expect(fs.readdirSync(root)).toEqual(['active']);
});
test('live original runner blocks recovery and its receipt remains untouched', async () => {
  const report = await review(); expect(report.ownerProcess.absentOrStopped).toBe(false);
  expect(report.blockers).toContain('Original runner is still alive');
});
test.each(['changed', 'legacy'])('%s boot prevents trusting volatile recovery identities', async kind => {
  change(r => { if (kind === 'changed') r.bootId = crypto.randomUUID(); else delete r.bootId; });
  const before = fs.readFileSync(receiptPath), report = await review();
  expect(report.boot.same).toBe(kind === 'changed' ? false : null);
  expect(report.blockers.some(b => /boot identity|boot changed/.test(b))).toBe(true);
  expect(fs.readFileSync(receiptPath)).toEqual(before); expect(report.admissionCleared).toBe(false);
});
test('malformed boot metadata is denied before any engine query', async () => {
  change(r => { r.bootId = false; }); await expect(review()).rejects.toThrow('boot identity is invalid');
  expect(queries()).toEqual([]);
});
test('review reports selected metadata only, not unreviewed receipt fields', async () => {
  change(r => { r.ownerProcess.extra = 'SYNTHETIC_NOT_FOR_REPORT'; r.directories[0].extra = 'SYNTHETIC_NOT_FOR_REPORT'; r.engine.configuration.extra = 'SYNTHETIC_NOT_FOR_REPORT'; });
  const report = await review(); expect(JSON.stringify(report)).not.toContain('SYNTHETIC_NOT_FOR_REPORT');
});
test('review uses only local bounded controls and new minimal settings without parent credentials', async () => {
  process.env.RECOVERY_FAKE_SECRET = 'SYNTHETIC_ONLY'; engine('present');
  const report = await review(); expect(report.container.identityMatched).toBe(true);
  const seen = queries(); expect(seen).toHaveLength(2);
  expect(seen.every(q => q.args[0] === '--remote=false' && q.args[1] === 'container' && ['exists','inspect'].includes(q.args[2]) && q.args.at(-1) === cid)).toBe(true);
  expect(seen.every(q => !q.keys.includes('RECOVERY_FAKE_SECRET') && q.config.includes('mounts = []') && q.config.includes('remote = false'))).toBe(true);
  expect(report.blockers.some(b => b.includes('still exists'))).toBe(true);
});
test.each(['task', 'lease', 'name', 'image', 'id'])('changed container %s cannot pass identity review', async field => {
  engine('present'); const p = path.join(dir, 'inspection.json'), r = JSON.parse(fs.readFileSync(p));
  if (field === 'task' || field === 'lease') r.Config.Labels['chatspace.' + field] = crypto.randomUUID();
  else r[{ name: 'Name', image: 'ImageName', id: 'Id' }[field]] = field === 'id' ? 'c'.repeat(64) : 'changed';
  fs.writeFileSync(p, JSON.stringify(r));
  await expect(review()).rejects.toThrow('not bound'); expect(fs.existsSync(receiptPath)).toBe(true);
});
test.each(['public', 'symlink', 'hardlink', 'oversize', 'invalid-json'])('unsafe %s receipt never contacts an engine', async kind => {
  if (kind === 'public') fs.chmodSync(receiptPath, 0o644);
  if (kind === 'symlink') { fs.renameSync(receiptPath, receiptPath + '-saved'); fs.symlinkSync(receiptPath + '-saved', receiptPath); }
  if (kind === 'hardlink') fs.linkSync(receiptPath, path.join(dir, 'linked'));
  if (kind === 'oversize') fs.writeFileSync(receiptPath, 'a'.repeat(8193));
  if (kind === 'invalid-json') fs.writeFileSync(receiptPath, '{');
  await expect(review()).rejects.toThrow(); expect(queries()).toEqual([]);
});
test.each(['owner-number', 'unknown-stage', 'cid', 'cid-inode', 'unknown-phase'])('invalid %s identity is denied or blocked before engine contact', async kind => {
  if (kind === 'owner-number') change(r => { r.ownerProcess.startTime = Number(r.ownerProcess.startTime); });
  if (kind === 'unknown-stage') change(r => { r.directories[0].path = dir; });
  if (kind === 'cid') fs.writeFileSync(path.join(root, 'active', 'container.cid'), 'c'.repeat(64));
  if (kind === 'cid-inode') { const p = path.join(root, 'active', 'container.cid'); fs.renameSync(p, p + '-old'); fs.writeFileSync(p, cid, { mode: 0o600 }); }
  if (kind === 'unknown-phase') change(r => { r.engine.phase = 'unknown'; });
  await expect(review()).rejects.toThrow(); expect(queries()).toEqual([]);
});
test('incomplete creation never guesses by name or treats missing CID as absence', async () => {
  change(r => { r.engine.phase = 'creating'; delete r.engine.containerId; delete r.engine.cidFile; });
  const report = await review(); expect(report.container).toBeNull(); expect(report.blockers.some(b => b.includes('No completed exact'))).toBe(true); expect(queries()).toEqual([]);
});
test('legacy process receipts remain inspectable but lack descendant recovery evidence', async () => {
  deadOwner(); change(r => { r.engine.phase = 'starting'; r.engine.process = r.ownerProcess; });
  const report = await review();
  expect(report.container.process.absentOrStopped).toBe(true);
  expect(report.blockers).toContain('Legacy engine receipt has no exact task cgroup identity');
  expect(report.admissionCleared).toBe(false);
});
test('cgroup receipt from a different exact container is denied before engine access', async () => {
  change(r => { const p='/sys/fs/cgroup/user.slice/libpod-'+ 'c'.repeat(64) +'.scope';
    r.engine.cgroup={path:p+'/container',dev:'30',ino:'123',scope:{path:p,dev:'30',ino:'122'}}; });
  await expect(review()).rejects.toThrow('cgroup identity'); expect(queries()).toEqual([]);
});
test('cgroup review excludes unknown receipt fields', async () => {
  change(r => { const p='/sys/fs/cgroup/user.slice/libpod-'+cid+'.scope';
    r.engine.cgroup={path:p+'/container',dev:'30',ino:'123',extra:'SYNTHETIC_HIDDEN',scope:{path:p,dev:'30',ino:'122',extra:'SYNTHETIC_HIDDEN'}}; });
  const report=await review(); expect(report.container.cgroup.path).toContain(cid);
  expect(JSON.stringify(report)).not.toContain('SYNTHETIC_HIDDEN');
});
test.each(['receipt-change', 'root-change'])('%s during engine observation preserves admission and fails review', async mode => {
  engine(mode); await expect(review()).rejects.toThrow();
  expect(fs.existsSync(path.join(mode === 'root-change' ? root + '-saved' : root, 'active', 'receipt.json'))).toBe(true);
});
test('stage replacement reports blocked without deleting either directory', async () => {
  const saved = stages.outputRoot + '-saved'; fs.renameSync(stages.outputRoot, saved); fs.mkdirSync(stages.outputRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(stages.outputRoot, 'canary'), 'PRESERVE');
  const report = await review(); expect(report.directories[2].unchanged).toBe(false); expect(report.blockers.some(b => b.includes('Staged directory'))).toBe(true);
  expect(fs.readFileSync(path.join(stages.outputRoot, 'canary'), 'utf8')).toBe('PRESERVE'); expect(fs.existsSync(saved)).toBe(true);
});
test('diagnostic exit1 is never absence and CLI does not print raw diagnostics', async () => {
  engine('query-error'); await expect(review()).rejects.toThrow('query is uncertain');
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/shared-executor-recovery.js'), 'inspect', '--root', root, '--podman', podmanPath], { encoding: 'utf8' });
  expect(r.status).toBe(1); expect(r.stdout).toBe(''); expect(r.stderr).toContain('No cleanup was performed'); expect(r.stderr).not.toContain('FAKE_PRIVATE_DIAGNOSTIC');
});
test('CLI emits a complete blocked report with exit2 and preserves admission', () => {
  deadOwner(); const before = fs.readFileSync(receiptPath);
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/shared-executor-recovery.js'), 'inspect', '--root', root, '--podman', podmanPath], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } });
  expect(r.status).toBe(2); expect(r.stderr).toBe('');
  expect(JSON.parse(r.stdout)).toMatchObject({ mode: 'review_only', admissionCleared: false, ownerProcess: { absentOrStopped: true }, container: { id: cid, exactAbsence: true } });
  expect(fs.readFileSync(receiptPath)).toEqual(before);
  expect(() => new ExecutionSupervisor({ root }).acquire(crypto.randomUUID())).toThrow('supervisor review');
});
