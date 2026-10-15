'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { ExecutionSupervisor } = require('../../src/shared/executorSupervisor');
const modulePath = require.resolve('../../src/shared/executorSupervisor');
let dir, root, supervisor, leases;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-supervisor-test-'));
  root = path.join(dir, 'supervisor');
  supervisor = new ExecutionSupervisor({ root }); leases = [];
});
afterEach(() => {
  for (const lease of leases) lease.close();
  // Only test-created filesystem fixtures; no executor/container was started.
  fs.rmSync(dir, { recursive: true, force: true });
});
function acquire() { const lease = supervisor.acquire(crypto.randomUUID()); leases.push(lease); return lease; }
function receipt() { return JSON.parse(fs.readFileSync(path.join(root, 'active', 'receipt.json'))); }
function files() {
  const result = { root: path.join(dir, 'inputs-store'), inputRoot: path.join(dir, 'inputs-store', 'inputs'), outputRoot: path.join(dir, 'outputs') };
  for (const file of Object.values(result)) fs.mkdirSync(file, { mode: 0o700 });
  return result;
}
test('one private admission excludes other processes, not just another object', () => {
  const lease = acquire();
  expect(receipt()).toMatchObject({ taskId: lease.taskId, state: 'admitted', maxConcurrentTasks: 1, maxStagedInputBytes: 20000000, ownerProcess: { pid: process.pid } });
  expect(receipt().ownerProcess.startTime).toMatch(/^[1-9][0-9]*$/);
  expect(receipt().bootId).toBe(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  expect(() => new ExecutionSupervisor({ root }).acquire(crypto.randomUUID())).toThrow('supervisor review');
  const child = "const {ExecutionSupervisor}=require(process.argv[1]);try{new ExecutionSupervisor({root:process.argv[2]}).acquire(process.argv[3]);process.exit(9)}catch(e){if(e.code!=='RESTRICTED_EXECUTOR_UNAVAILABLE')throw e;console.log('BLOCKED')}";
  expect(execFileSync(process.execPath, ['-e', child, modulePath, root, crypto.randomUUID()], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).trim()).toBe('BLOCKED');
  expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(root, 'active', 'receipt.json')).mode & 0o777).toBe(0o600);
});
test('confirmed stoppage and cleanup release admission for a different task', () => {
  const lease = acquire(), staged = files();
  lease.staged(staged); lease.start();
  expect(receipt().directories.map(item => item.path)).toEqual(Object.values(staged));
  expect(() => lease.release()).toThrow('not been confirmed');
  lease.stopped(); lease.release();
  const next = acquire(); expect(next.taskId).not.toBe(lease.taskId); next.stopped(); next.release();
});
test('uncertainty is retained after handles close and cannot be expired or implicitly retried', () => {
  const lease = acquire(); lease.staged(files()); lease.start(); lease.retain();
  expect(receipt().state).toBe('review_required');
  expect(() => supervisor.acquire(crypto.randomUUID())).toThrow('supervisor review');
  expect(fs.existsSync(receipt().directories[0].path)).toBe(true);
});
test('a killed owner leaves its durable receipt and blocks a fresh process', async () => {
  const code = "const {ExecutionSupervisor}=require(process.argv[1]);const l=new ExecutionSupervisor({root:process.argv[2]}).acquire(process.argv[3]);console.log('ADMITTED');setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ['-e', code, modulePath, root, crypto.randomUUID()], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('No admission acknowledgement')), 5000);
      child.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('ADMITTED') ? resolve() : reject(Error('Bad acknowledgement')); });
      child.once('error', reject);
    });
    const before = receipt(); child.kill('SIGKILL'); await closed;
    expect(receipt()).toEqual(before);
    expect(() => supervisor.acquire(crypto.randomUUID())).toThrow('supervisor review');
  } finally { child.kill('SIGKILL'); await closed; }
});
test.each(['root', 'admission'])('%s replacement cannot redirect release or delete another directory', kind => {
  const lease = acquire(); lease.stopped();
  const target = kind === 'root' ? root : path.join(root, 'active'), saved = target + '-saved';
  fs.renameSync(target, saved); fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, 'canary'), 'PRESERVE', { mode: 0o600 });
  expect(() => lease.release()).toThrow('identity changed');
  expect(fs.readFileSync(path.join(target, 'canary'), 'utf8')).toBe('PRESERVE');
  expect(fs.existsSync(path.join(saved, kind === 'root' ? 'active/receipt.json' : 'receipt.json'))).toBe(true);
});
test.each(['symlink', 'nonce', 'metadata', 'unknown-file'])('receipt %s is preserved and cannot clear admission', attack => {
  const lease = acquire(); lease.stopped(); const file = path.join(root, 'active', 'receipt.json');
  if (attack === 'symlink') { fs.renameSync(file, file + '-owned'); fs.symlinkSync(path.join(dir, 'private-canary'), file); }
  if (attack === 'nonce') fs.writeFileSync(file, JSON.stringify({ ...receipt(), leaseId: crypto.randomUUID() }));
  if (attack === 'metadata') fs.writeFileSync(file, JSON.stringify({ ...receipt(), ownerProcess: { pid: 99999, startTime: '1' } }));
  if (attack === 'unknown-file') fs.writeFileSync(path.join(root,'active','unknown'), 'PRESERVE');
  expect(() => lease.release()).toThrow();
  expect(fs.existsSync(path.join(root, 'active'))).toBe(true);
});

function engine(lease) {
  const config = path.join(dir, 'engine-config'); fs.mkdirSync(config, {mode:0o700});
  const s = fs.statSync(config, {bigint:true});
  const journal = lease.journal();
  const creating = { phase:'creating', containerName:'chatspace-task-'+crypto.randomUUID(), image:'sha256:'+'a'.repeat(64),
    podmanPath:'/usr/bin/podman', configuration:{path:config,dev:String(s.dev),ino:String(s.ino)} };
  journal.record(creating);
  fs.writeFileSync(journal.cidFile, 'b'.repeat(64), {mode:0o600,flag:'wx'});
  const f = fs.statSync(journal.cidFile, {bigint:true});
  const created = {phase:'created',containerId:'b'.repeat(64),cidFile:{path:journal.cidFile,dev:String(f.dev),ino:String(f.ino)}};
  journal.record(created); return {journal,creating,created};
}
function cgroup(containerId) {
  const scope = '/sys/fs/cgroup/user.slice/libpod-' + containerId + '.scope';
  return { path: scope + '/container', dev: '30', ino: '123', scope: { path: scope, dev: '30', ino: '122' } };
}
test('durable engine identity requires ordered phases and exact absence before release', () => {
  const lease=acquire();lease.staged(files());lease.start();
  const {journal,creating,created}=engine(lease);
  expect(receipt().engine).toMatchObject({...creating,...created});
  expect(() => journal.record({phase:'absent',containerId:'c'.repeat(64)})).toThrow('changed engine');
  expect(() => lease.stopped()).toThrow('absence has not');
  journal.record({phase:'starting',containerId:created.containerId,process:{pid:1234,startTime:'100'},cgroup:cgroup(created.containerId)});
  expect(receipt().engine.process).toEqual({pid:1234,startTime:'100'});
  expect(receipt().engine.cgroup).toEqual(cgroup(created.containerId));
  journal.record({phase:'absent',containerId:created.containerId});
  expect(lease.confirmedEngineAbsence).toBe(true);
  lease.stopped();lease.release();expect(fs.existsSync(path.join(root,'active'))).toBe(false);
});
test('startup without an exact task cgroup cannot become a recoverable running receipt', () => {
  const lease=acquire();lease.staged(files());lease.start();const {journal,created}=engine(lease);
  expect(() => journal.record({phase:'starting',containerId:created.containerId,process:{pid:1234,startTime:'100'}})).toThrow('cgroup identity');
  expect(receipt().engine.phase).toBe('created');
});
test('Podman removal of its CID file releases only after the durable exact absence checkpoint', () => {
  const lease=acquire();lease.staged(files());lease.start();const {journal,created}=engine(lease);
  fs.unlinkSync(journal.cidFile);
  expect(()=>lease.stopped()).toThrow('absence has not');
  journal.record({phase:'absent',containerId:created.containerId});lease.stopped();lease.release();
  expect(fs.existsSync(path.join(root,'active'))).toBe(false);
});
test.each(['inode','contents','symlink'])('changed CID %s cannot release admission or authorize cleanup', kind => {
  const lease=acquire();lease.staged(files());lease.start();const {journal,created}=engine(lease);
  journal.record({phase:'absent',containerId:created.containerId});lease.stopped();
  if(kind==='inode'){fs.renameSync(journal.cidFile,journal.cidFile+'-saved');fs.writeFileSync(journal.cidFile,created.containerId,{mode:0o600});fs.unlinkSync(journal.cidFile+'-saved');}
  if(kind==='contents')fs.writeFileSync(journal.cidFile,'c'.repeat(64));
  if(kind==='symlink'){fs.unlinkSync(journal.cidFile);fs.symlinkSync(path.join(dir,'private'),journal.cidFile);}
  expect(()=>lease.release()).toThrow();expect(fs.existsSync(path.join(root,'active/receipt.json'))).toBe(true);
});
test('an interrupted create retains its pre-create identity and cidfile without inferring absence', () => {
  const lease=acquire();lease.staged(files());lease.start();const {journal}=engine(lease);
  lease.retain();
  expect(receipt().engine).toMatchObject({phase:'created',containerId:'b'.repeat(64),cidFile:{path:journal.cidFile}});
  expect(()=>supervisor.acquire(crypto.randomUUID())).toThrow('supervisor review');
});
test.each(['public', 'symlink'])('unsafe supervisor %s is rejected before admission', kind => {
  if (kind === 'public') fs.mkdirSync(root, { mode: 0o755 });
  else { const other = path.join(dir, 'other'); fs.mkdirSync(other, { mode: 0o700 }); fs.symlinkSync(other, root); }
  expect(() => acquire()).toThrow('private owned');
  expect(fs.existsSync(path.join(root, 'active'))).toBe(false);
});
