const fs = require('fs');
const os = require('os');
const path = require('path');
// Host prerequisites are modeled only for the engine protocol fixtures. The
// fixed actual procfs reader and the dedicated VM have separate behavior checks.
jest.mock('../../src/shared/executorHostPolicy', () => ({ assertSafeCoreDumpPolicy: jest.fn() }));
// These engine protocol fixtures do not create actual container cgroups. Real
// kernel identity, limits and persistence must also pass on the rootless VM.
jest.mock('../../src/shared/executorCgroup', () => ({
  ...jest.requireActual('../../src/shared/executorCgroup'),
  observeTaskProcess: jest.fn(p => ({...p,absentOrStopped:true})),
  observeRetainedTaskCgroup: jest.fn(() => ({stopped:true,scope:{removed:true},leaf:{removed:true}})),
  readInitializedTaskCgroup: jest.fn((_process, id) => {
    const scope = '/sys/fs/cgroup/user.slice/libpod-' + id + '.scope';
    return { path: scope + '/container', dev: '30', ino: '123', scope: { path: scope, dev: '30', ino: '122' } };
  })
}));
const {
  RootlessPodmanExecutor,
  RestrictedTaskFiles,
  ExecutorUnavailableError,
  approvedWorkspace,
  safeEnvironment,
  restrictedPolicy,
  assertNoAutomaticMounts,
  validateOCISpec,
  readOCISpec,
  readInitializedMountIdentity,
  validateInitializedMountIdentity,
  assertOutputStoreMount
} = require('../../src/shared/restrictedExecutor');

let workspace, outputStore, capacitySpy, directorySpy, engineDirectories, controlRoot, storeSecuritySpy;
const image = 'example.test/runner@sha256:' + 'a'.repeat(64);
// Explicit protocol-only kernel model for isolated subprocess fixtures. These
// fake engines have no kernel container process; the VM checks actual metadata.
function subprocessKernelFixture() {
  return `require(require('path').join(require('path').dirname(process.argv[1]), 'executorHostPolicy')).assertSafeCoreDumpPolicy = () => {};
    const kernel = require(require('path').join(require('path').dirname(process.argv[1]), 'executorCgroup'));
    kernel.readInitializedTaskCgroup = (_process, id) => {
      const scope = '/sys/fs/cgroup/user.slice/libpod-' + id + '.scope';
      return {path:scope+'/container',dev:'30',ino:'123',scope:{path:scope,dev:'30',ino:'122'}};
    };
    kernel.observeTaskProcess = value => ({...value,absentOrStopped:true});
    kernel.observeRetainedTaskCgroup = () => ({stopped:true});`;
}

beforeEach(() => {
  engineDirectories = [];
  const create = fs.mkdtempSync.bind(fs);
  directorySpy = jest.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
    const directory = create(prefix, options);
    if (path.basename(prefix) === 'chatspace-engine-config-') engineDirectories.push({ directory, stat: fs.lstatSync(directory) });
    return directory;
  });
  // Exercise the observed random-name collision with the RUN template marker.
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-executor-RUN-test-'));
  controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-engine-fixture-'));
  fs.mkdirSync(path.join(controlRoot, 'graph'));
  fs.mkdirSync(path.join(controlRoot, 'run'));
  outputStore = process.env.SHARED_TEST_OUTPUT_STORE || fs.mkdtempSync(path.join(os.tmpdir(), 'shared-output-store-fixture-'));
  if (!process.env.SHARED_TEST_OUTPUT_STORE) {
    const statfs = fs.statfsSync.bind(fs);
    capacitySpy = jest.spyOn(fs, 'statfsSync').mockImplementation(candidate => String(candidate).startsWith(outputStore) ?
      { type: 0x01021994, bsize: 4096, blocks: 4096, files: 128 } : statfs(candidate));
    // Without an operator-created tmpfs these are protocol fixtures only.
    storeSecuritySpy = jest.spyOn(RestrictedTaskFiles.prototype, 'assertOutputStoreSecurity').mockImplementation(() => {});
  }
});
afterEach(() => {
  directorySpy.mockRestore();
  for (const { directory, stat } of engineDirectories) {
    if (!fs.existsSync(directory)) continue;
    const current = fs.lstatSync(directory);
    expect(current.isDirectory() && current.ino === stat.ino && current.dev === stat.dev).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  capacitySpy?.mockRestore();
  capacitySpy = null;
  storeSecuritySpy?.mockRestore();
  storeSecuritySpy = null;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(controlRoot, { recursive: true, force: true });
  if (!process.env.SHARED_TEST_OUTPUT_STORE) fs.rmSync(outputStore, { recursive: true, force: true });
});

test('fails closed when the rootless engine or pinned image is unavailable', async () => {
  const executor = new RootlessPodmanExecutor({
    podmanPath: path.join(workspace, 'missing-podman'),
    image,
    workspaceRoot: workspace
  });
  await expect(executor.probe()).resolves.toMatchObject({
    available: false
  });
  await expect(executor.run({
    argv: ['sh', '-c', 'echo should never run']
  })).rejects.toBeInstanceOf(ExecutorUnavailableError);
});

test('rejects secrets, unapproved environment and unsafe workspace roots', () => {
  expect(() => safeEnvironment({
    API_KEY: 'secret'
  }, ['API_KEY'])).toThrow('not approved');
  expect(() => safeEnvironment({
    CUSTOM: 'value'
  }, ['HOME'])).toThrow('not approved');
  expect(() => new RootlessPodmanExecutor({
    podmanPath: 'podman',
    image,
    workspaceRoot: path.join(workspace, 'missing')
  })).toThrow('regular directory');
});

test('does not offer an unrestricted shell fallback', async () => {
  const executor = new RootlessPodmanExecutor({
    podmanPath: path.join(workspace, 'missing-podman'),
    image,
    workspaceRoot: workspace
  });
  await expect(executor.run({
    argv: ['sh', '-c', 'cat /etc/passwd']
  })).rejects.toMatchObject({
    code: 'RESTRICTED_EXECUTOR_UNAVAILABLE'
  });
});

test('requires an immutable image digest and unambiguous mount path', () => {
  expect(() => new RootlessPodmanExecutor({ image: 'runner:latest', workspaceRoot: workspace })).toThrow('SHA-256');
  const ambiguous = path.join(workspace, 'project:ro');
  fs.mkdirSync(ambiguous);
  expect(() => new RootlessPodmanExecutor({ image, workspaceRoot: ambiguous })).toThrow('mount separators');
});

test('rejects a workspace replaced between inspection and path resolution', () => {
  const project = path.join(workspace, 'project');
  const replacement = path.join(workspace, 'replacement');
  fs.mkdirSync(project);
  fs.mkdirSync(replacement);
  const realpath = fs.realpathSync.bind(fs);
  const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(candidate => {
    if (candidate === project) {
      fs.renameSync(project, path.join(workspace, 'original'));
      fs.symlinkSync(replacement, project);
    }
    return realpath(candidate);
  });
  try { expect(() => approvedWorkspace(project)).toThrow(/changed/); }
  finally { spy.mockRestore(); }
});

test('does not start execution if the approved workspace changes during its probe', async () => {
  const project = path.join(workspace, 'project');
  fs.mkdirSync(project);
  const executor = new RootlessPodmanExecutor({ image, workspaceRoot: project });
  jest.spyOn(executor, 'probe').mockImplementation(async () => {
    fs.renameSync(project, path.join(workspace, 'original'));
    fs.mkdirSync(project);
    return { available: true };
  });
  await expect(executor.run({ argv: ['agent'] })).rejects.toThrow(/workspace changed/);
});

// This subprocess fixture verifies the adapter protocol, not container isolation.
function engineReviewFixture(mode = 'echo') {
  return `
const path = require('path');
const graphRoot = ${JSON.stringify(path.join(controlRoot, 'graph'))};
const runRoot = ${JSON.stringify(path.join(controlRoot, 'run'))};
const cid = 'b'.repeat(64);
const staticDir = path.join(graphRoot, 'overlay-containers', cid, 'userdata');
const createdPath = ${JSON.stringify(path.join(workspace, 'created'))};
function reviewControl(args) {
  if (args[0] === '--version') process.stdout.write('podman version 4.9.3');
  else if (args[0] === 'info' && args.at(-1) === '{{json .Store}}') process.stdout.write(JSON.stringify({graphDriverName:'overlay',graphRoot,runRoot}));
  else if (args[0] === 'init') {
    const created = JSON.parse(fs.readFileSync(createdPath));
    const spec = ${JSON.stringify(require('../fixtures/sharedOCI.json'))};
    if (${JSON.stringify(mode)} === 'large-boundary') spec.process.env = ['CONTROLLED=' + 'x'.repeat(180000)];
    const volume = created[created.indexOf('--volume')+1].split(':');
    for (const mount of spec.mounts) {
      const sources = { WORKSPACE: volume[0], GRAPH: graphRoot, RUN: runRoot, CID: cid };
      mount.source = mount.source.replace(/WORKSPACE|GRAPH|RUN|CID/g, token => sources[token]);
      if (mount.destination === '/workspace' && volume[2] === 'rw') mount.options = mount.options.filter(x=>x!=='ro');
    }
    for (let i=created.indexOf('--volume')+2; i<created.length; i++) if (created[i]==='--volume') {
      const [source,destination,options] = created[++i].split(':');
      spec.mounts.push({source,destination,type:'bind',options:['rbind','rprivate',...options.split(',').filter(x=>x!=='rw')]});
    }
    const mounts = {};
    for (const mount of spec.mounts.filter(m => ['/workspace','/task-inputs','/task-outputs'].includes(m.destination))) {
      const substitute = ${JSON.stringify(mode)} === 'workspace-aba' && mount.destination === '/workspace' ||
        ${JSON.stringify(mode)} === 'input-aba' && mount.destination === '/task-inputs' ||
        ${JSON.stringify(mode)} === 'output-aba' && mount.destination === '/task-outputs';
      const saved = mount.source + '-saved';
      const alternate = mount.source + '-alternate';
      if (substitute) {
        fs.mkdirSync(alternate);
        fs.renameSync(mount.source,saved);
        fs.renameSync(alternate,mount.source);
      }
      try {
        const stat = fs.statSync(mount.source,{bigint:true});
        mounts[mount.destination] = {dev:String(stat.dev),ino:String(stat.ino)};
      } finally {
        if (substitute) {
          fs.renameSync(mount.source,alternate);
          fs.renameSync(saved,mount.source);
          fs.rmdirSync(alternate);
        }
      }
    }
    fs.mkdirSync(staticDir,{recursive:true});
    fs.writeFileSync(path.join(staticDir,'mounted-identities.json'),JSON.stringify({pid:1234,startTime:'100',namespace:{dev:'4',ino:'12345'},mounts}));
    spec.root.path = spec.root.path.replace('GRAPH',graphRoot);
    if (${JSON.stringify(mode)} === 'extra-mount') spec.mounts.push({destination:'/private',type:'bind',source:staticDir+'/canary',options:['bind','ro','rprivate','nosuid','nodev','noexec']});
    if (${JSON.stringify(mode)} === 'workspace-source') spec.mounts.find(m=>m.destination==='/workspace').source='/private';
    if (${JSON.stringify(mode)} === 'seccomp-missing') delete spec.linux.seccomp;
    if (${JSON.stringify(mode)} === 'seccomp-unconfined') spec.linux.seccomp.defaultAction='SCMP_ACT_ALLOW';
    if (${JSON.stringify(mode)} === 'seccomp-unix') spec.linux.seccomp.syscalls.push({names:['socket'],action:'SCMP_ACT_ALLOW'});
    fs.mkdirSync(staticDir,{recursive:true});
    fs.writeFileSync(path.join(staticDir,'config.json'),JSON.stringify(spec));
    fs.writeFileSync(${JSON.stringify(path.join(workspace, 'initialized'))},'ready');
    if (${JSON.stringify(mode)} === 'delayed-init') setTimeout(()=>{},150);
  }
  else if (args[0] === 'container' && args[1] === 'inspect') {
    fs.writeFileSync(${JSON.stringify(path.join(workspace, 'inspection-started'))},'ready');
    fs.appendFileSync(${JSON.stringify(path.join(workspace, 'inspection-count'))},'inspect\\n');
    const created = JSON.parse(fs.readFileSync(createdPath));
    const state = {Status:${JSON.stringify(mode)} === 'not-initialized' ? 'created' : 'initialized',Running:false,Pid:1234};
    if (args[3] === '{{json .State}}') {
      if (${JSON.stringify(mode)} === 'pid-changed') state.Pid++;
      if (${JSON.stringify(mode)} === 'already-started') { state.Running=true; state.Status='running'; }
      process.stdout.write(JSON.stringify(state));
    } else process.stdout.write(JSON.stringify({Id:cid,Name:created[created.indexOf('--name')+1],StaticDir:staticDir,OCIConfigPath:path.join(staticDir,'config.json'),State:state,HostConfig:{NetworkMode:'none'},Config:{Cmd:${JSON.stringify(mode)} === 'oversized-inspection' ? ['x'.repeat(270000)] : created,Labels:Object.fromEntries(created.flatMap((v,i)=>v==='--label'?[created[i+1].split('=')]:[]))}}));
    if (${JSON.stringify(mode)} === 'delayed-inspection') setTimeout(()=>{},150);
  }
  else if (args[0] === 'unshare') {
    fs.writeFileSync(${JSON.stringify(path.join(workspace, 'boundary-started'))},'ready');
    if (${JSON.stringify(mode)} === 'mount-reader-denied') { process.stderr.write('fake procfs access denial'); process.exit(1); }
    // Only the mounted-inode receipt is simulated here. The real filesystem OCI
    // reader and contract run in the fixed subprocess helper before that receipt.
    const expression = args.indexOf('-e');
    const helper = 'require("fs").writeFileSync(' + JSON.stringify(${JSON.stringify(path.join(controlRoot, 'helper-runtime.json'))}) + ',JSON.stringify({heapLimit:require("v8").getHeapStatistics().heap_size_limit}));' + args[expression+1].replace('const receipt = readInitializedMountIdentity(pid, spec.root.path, !!policy.taskFiles);',
      'const receipt = JSON.parse(require("fs").readFileSync(' + JSON.stringify(path.join(staticDir,'mounted-identities.json')) + ',"utf8"));');
    process.stdout.write(require('child_process').execFileSync(args[1],[...args.slice(2,expression),'-e',helper,...args.slice(expression+2)]));
    if (${JSON.stringify(mode)} === 'delayed-boundary') setTimeout(()=>{},150);
  }
  else return false;
  return true;
}
`;
}

function fixtureEngine(mode = 'echo') {
  const executable = path.join(workspace, 'engine');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const local = args[0] === '--remote=false';
if (local) args.shift();
${engineReviewFixture(mode)}
if (${JSON.stringify(mode)} === 'remote-default' && !local) { process.exit(125); }
if (reviewControl(args)) {}
else if (args[0] === 'info') { process.stdout.write('true'); }
else if (args[0] === 'image') { process.exitCode = 0; }
else if (args[0] === 'create') {
  fs.writeFileSync(${JSON.stringify(path.join(workspace, 'created'))}, JSON.stringify(args));
  fs.writeFileSync(${JSON.stringify(path.join(workspace, 'present'))}, 'present');
  if (args.includes('--cidfile')) fs.writeFileSync(args[args.indexOf('--cidfile')+1], (${JSON.stringify(mode)} === 'bad-cidfile' ? 'c' : 'b').repeat(64), {mode:0o600,flag:'wx'});
  if (${JSON.stringify(mode)} === 'delayed-create') setTimeout(() => process.stdout.write('b'.repeat(64)), 150);
  else process.stdout.write('b'.repeat(64));
}
else if (args[0] === 'container' && args[1] === 'exists') {
  fs.appendFileSync(${JSON.stringify(path.join(workspace, 'queries'))}, args.at(-1) + '\\n');
  if (${JSON.stringify(mode)} === 'query-stderr') process.stderr.write('fake configuration error');
  if (${JSON.stringify(mode)} === 'query-stdout') process.stdout.write('fake unexpected diagnostic');
  process.exitCode = ${JSON.stringify(mode)} === 'query-error' ? 125 : fs.existsSync(${JSON.stringify(path.join(workspace, 'present'))}) ? 0 : 1;
}
else if (args[0] === 'rm') {
  fs.writeFileSync(${JSON.stringify(path.join(workspace, 'removed'))}, args.at(-1));
  fs.appendFileSync(${JSON.stringify(path.join(workspace, 'removal-args'))}, JSON.stringify(args) + '\\n');
  if (${JSON.stringify(mode)} === 'immediate-removal' && !args.includes('--time=0')) process.exit(125);
  if (${JSON.stringify(mode)} === 'unconfirmed') process.exitCode = 1;
  else if (${JSON.stringify(mode)} !== 'residual') fs.rmSync(${JSON.stringify(path.join(workspace, 'present'))}, { force: true });
  if (fs.existsSync(${JSON.stringify(path.join(workspace, 'attached-pid'))})) {
    try { process.kill(Number(fs.readFileSync(${JSON.stringify(path.join(workspace, 'attached-pid'))})), 'SIGTERM'); } catch (_) {}
  }
}
else {
  fs.writeFileSync(${JSON.stringify(path.join(workspace, 'started'))}, fs.existsSync(${JSON.stringify(path.join(workspace, 'created'))}) ? fs.readFileSync(${JSON.stringify(path.join(workspace, 'created'))}) : JSON.stringify(args));
  fs.writeFileSync(${JSON.stringify(path.join(workspace, 'attached-pid'))}, String(process.pid));
  if (['stderr', 'unconfirmed'].includes(${JSON.stringify(mode)})) { process.stderr.write('x'.repeat(1000001)); setInterval(() => {}, 1000); }
  else if (${JSON.stringify(mode)} === 'wait') { setInterval(() => {}, 1000); }
  else { let input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ input, args: fs.existsSync(${JSON.stringify(path.join(workspace, 'created'))}) ? JSON.parse(fs.readFileSync(${JSON.stringify(path.join(workspace, 'created'))})) : args, leaked: process.env.SHARED_EXECUTOR_TEST_SECRET || null }))); }
}
`, { mode: 0o700 });
  return new RootlessPodmanExecutor({ podmanPath: executable, image, workspaceRoot: workspace });
}

test('forces local execution despite a remote-default engine configuration', async () => {
  // The fixture rejects an implicit remote default; real configuration precedence
  // must also be tested against Podman in the dedicated VM.
  const result = await fixtureEngine('remote-default').run({ argv: ['agent'], input: 'local only' });
  expect(JSON.parse(result.output).input).toBe('local only');
});

test.each([2, 3])('refuses a crash-handler policy change at admission check %s before task argv', async call => {
  const policy = require('../../src/shared/executorHostPolicy').assertSafeCoreDumpPolicy;
  let count = 0;
  policy.mockImplementation(() => { if (++count === call) throw Object.assign(Error('verified host core policy required'), {code:'RESTRICTED_EXECUTOR_UNAVAILABLE'}); });
  try {
    await expect(fixtureEngine().run({argv:['agent']})).rejects.toThrow('verified host core policy');
    expect(fs.existsSync(path.join(workspace,'started'))).toBe(false);
    if (call === 2) expect(fs.existsSync(path.join(workspace,'created'))).toBe(false);
    else expect(fs.readFileSync(path.join(workspace,'removed'),'utf8')).toBe('b'.repeat(64));
  } finally { policy.mockReset(); }
});

test('ignores host default mounts and config override environment in the engine protocol', async () => {
  // This models the configuration boundary only; actual Podman precedence and
  // the complete OCI mount set still require the VM harness.
  const executable = path.join(workspace, 'configured-engine');
  const hostConfig = path.join(workspace, 'host-config');
  const record = path.join(workspace, 'configuration-calls');
  fs.writeFileSync(hostConfig, '[containers]\nmounts=["type=bind,source=/fake-private,destination=/private"]\n');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--remote=false') args.shift();
${engineReviewFixture()}
const configPath = process.env.CONTAINERS_CONF || ${JSON.stringify(hostConfig)};
const config = fs.readFileSync(configPath, 'utf8');
const override = process.env.CONTAINERS_CONF_OVERRIDE;
const mounts = !/^mounts = \\[\\]$/m.test(config) || !!override;
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ action: args[0], configPath, mounts, override: override || null, mode: fs.statSync(configPath).mode & 0o777 }) + '\\n');
if (reviewControl(args)) {}
else if (args[0] === 'info') process.stdout.write('true');
else if (args[0] === 'create') { fs.writeFileSync(createdPath,JSON.stringify(args)); process.stdout.write('b'.repeat(64)); }
else if (args[0] === 'container') process.exitCode = 1;
else if (['run', 'start'].includes(args[0])) { process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ mounts }))); }
`, { mode: 0o700 });
  const { execFileSync } = require('child_process');
  expect(JSON.parse(execFileSync(executable, ['--remote=false', 'run'], {
    input: '', encoding: 'utf8', env: { ...process.env, CONTAINERS_CONF: hostConfig, CONTAINERS_CONF_OVERRIDE: hostConfig }
  })).mounts).toBe(true);
  fs.unlinkSync(record);
  const script = `
    const { RootlessPodmanExecutor } = require(process.argv[1]);
    ${subprocessKernelFixture()}
    const executor = new RootlessPodmanExecutor({ podmanPath: process.argv[2], image: process.argv[3], workspaceRoot: process.argv[4] });
    executor.run({ argv: ['agent'] }).then(result => process.stdout.write(result.output)).catch(() => { process.exitCode = 1; });
  `;
  const result = execFileSync(process.execPath, ['-e', script, require.resolve('../../src/shared/restrictedExecutor'), executable, image, workspace], {
    encoding: 'utf8', timeout: 4000,
    env: { ...process.env, CONTAINERS_CONF: hostConfig, CONTAINERS_CONF_OVERRIDE: hostConfig }
  });
  expect(JSON.parse(result).mounts).toBe(false);
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.map(call => call.action)).toEqual(['--version', 'info', 'image', 'info', 'create', 'init', 'container', 'unshare', 'container', 'start', 'rm', 'container']);
  expect(calls.every(call => !call.mounts && call.override === null && call.mode === 0o600)).toBe(true);
  for (const call of calls) {
    expect(path.dirname(call.configPath).startsWith(workspace + path.sep)).toBe(false);
    expect(fs.existsSync(path.dirname(call.configPath))).toBe(false);
  }
});

test('removes private engine configuration when the engine probe fails', async () => {
  const executor = new RootlessPodmanExecutor({ podmanPath: path.join(workspace, 'missing-engine'), image, workspaceRoot: workspace });
  await expect(executor.probe()).resolves.toMatchObject({ available: false });
  expect(engineDirectories).toHaveLength(1);
  expect(fs.existsSync(engineDirectories[0].directory)).toBe(false);
});

test('refuses a workspace that would expose temporary engine configuration', async () => {
  const executor = new RootlessPodmanExecutor({ podmanPath: path.join(workspace, 'unused-engine'), image, workspaceRoot: os.tmpdir() });
  await expect(executor.probe()).resolves.toMatchObject({ available: false, reason: 'Engine configuration must be outside the approved workspace' });
  await expect(executor.run({ argv: ['agent'] })).rejects.toBeInstanceOf(ExecutorUnavailableError);
});

test('passes the transcript on stdin with readonly access and no inherited connector secret', async () => {
  process.env.SHARED_EXECUTOR_TEST_SECRET = 'fixture-only';
  try {
    const result = JSON.parse((await fixtureEngine().run({ argv: ['agent'], input: 'encrypted-room transcript', readOnly: true })).output);
    expect(result.input).toBe('encrypted-room transcript');
    expect(result.leaked).toBeNull();
    expect(result.args).toContain(`${workspace}:/workspace:ro`);
    expect(result.args).toContain('--network=none');
    expect(result.args).toContain('--interactive');
  } finally { delete process.env.SHARED_EXECUTOR_TEST_SECRET; }
});

test('cancellation removes the named container before reporting completion', async () => {
  const signal = new AbortController();
  const running = fixtureEngine('wait').run({ argv: ['agent'], signal: signal.signal });
  const result = expect(running).rejects.toThrow('fixture cancellation');
  for (let i = 0; i < 200 && !fs.existsSync(path.join(workspace, 'started')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(true);
  signal.abort(new Error('fixture cancellation'));
  await result;
  expect(fs.readFileSync(path.join(workspace, 'removed'), 'utf8')).toBe('b'.repeat(64));
  expect(fs.readFileSync(path.join(workspace, 'queries'), 'utf8').trim()).toBe('b'.repeat(64));
});

test('bounds stderr as well as stdout and cleans up excessive output', async () => {
  await expect(fixtureEngine('stderr').run({ argv: ['agent'] })).rejects.toThrow('output exceeded');
  expect(fs.existsSync(path.join(workspace, 'removed'))).toBe(true);
});

test('reviews initialized containers with long literal argv within the bounded inspection limit', async () => {
  const argument = 'a'.repeat(20000);
  const result = await fixtureEngine().run({ argv: ['agent', argument] });
  expect(JSON.parse(result.output).args.at(-1)).toBe(argument);
});

test('the fixed boundary helper parses a large valid spec within a bounded host heap', async () => {
  const result = await fixtureEngine('large-boundary').run({argv:['agent'],input:'bounded control reader'});
  expect(JSON.parse(result.output).input).toBe('bounded control reader');
  const runtime = JSON.parse(fs.readFileSync(path.join(controlRoot,'helper-runtime.json'),'utf8'));
  expect(runtime.heapLimit).toBeLessThanOrEqual(96 * 1024 * 1024);
  expect(fs.readFileSync(path.join(workspace,'removed'),'utf8')).toBe('b'.repeat(64));
});

test.each(['inspection', 'boundary'])('cancellation during %s review stops further initialization and removes the exact ID', async phase => {
  const controller = new AbortController();
  const running = fixtureEngine('delayed-' + phase).run({ argv: ['agent'], signal: controller.signal });
  const result = expect(running).rejects.toThrow('cancel review');
  const marker = path.join(workspace, phase + '-started');
  for (let i = 0; i < 300 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(fs.existsSync(marker)).toBe(true);
  controller.abort(new Error('cancel review'));
  await result;
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  if (phase === 'inspection') expect(fs.existsSync(path.join(workspace, 'boundary-started'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'inspection-count'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(fs.readFileSync(path.join(workspace, 'queries'), 'utf8').trim()).toBe('b'.repeat(64));
});

test('the OCI reader bounds real files and refuses symlinks, directories and malformed JSON', () => {
  const config = path.join(workspace, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ root: { path: '/fixture' } }));
  expect(readOCISpec(config)).toEqual({ root: { path: '/fixture' } });
  const link = path.join(workspace, 'config-link');
  fs.symlinkSync(config, link);
  expect(() => readOCISpec(link)).toThrow();
  expect(() => readOCISpec(workspace)).toThrow('Invalid OCI configuration');
  fs.writeFileSync(config, 'x'.repeat(262145));
  expect(() => readOCISpec(config)).toThrow('Invalid OCI configuration');
  fs.writeFileSync(config, '{');
  expect(() => readOCISpec(config)).toThrow();
});

test('the OCI reader rejects concurrent growth and closes its descriptor after failure', () => {
  const config = path.join(workspace, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ root: { path: '/fixture' } }));
  const read = fs.readSync.bind(fs);
  let descriptor;
  const spy = jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
    descriptor = fd;
    const count = read(fd, ...args);
    fs.appendFileSync(config, ' ');
    return count;
  });
  try {
    expect(() => readOCISpec(config)).toThrow('OCI configuration changed');
    expect(() => fs.fstatSync(descriptor)).toThrow(/EBADF/);
  } finally { spy.mockRestore(); }
});

test.each(['not-initialized', 'oversized-inspection'])('rejects %s inspection before task startup', async mode => {
  await expect(fixtureEngine(mode).run({ argv: ['agent'] })).rejects.toThrow();
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
});

test('requests immediate forced removal rather than the engine default grace', async () => {
  await expect(fixtureEngine('immediate-removal').run({ argv: ['agent'] })).resolves.toHaveProperty('output');
  const calls = fs.readFileSync(path.join(workspace, 'removal-args'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.every(args => args.includes('--force') && args.includes('--time=0') && args.at(-1) === 'b'.repeat(64))).toBe(true);
});

test.each(['query-stderr', 'query-stdout'])('treats exit 1 with %s diagnostics as uncertain cleanup', async mode => {
  const executor = fixtureEngine(mode);
  await expect(executor.run({ argv: ['agent'] })).rejects.toMatchObject({ code: 'RESTRICTED_CANCELLATION_UNCONFIRMED' });
  await expect(executor.probe()).resolves.toMatchObject({ available: false, reason: 'Executor cleanup requires operator review' });
});

test.each(['workspace-aba', 'input-aba', 'output-aba'])('rejects restored source paths with substituted effective %s mounts', async mode => {
  const taskFiles = mode === 'workspace-aba' ? undefined : new RestrictedTaskFiles(workspace, outputStore);
  const original = fs.statSync(workspace);
  try {
    await expect(fixtureEngine(mode).run({ argv: ['agent'], taskFiles })).rejects.toThrow('Effective initialized mounts');
    expect(fs.statSync(workspace).ino).toBe(original.ino);
    taskFiles?.assertReady();
    expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
  } finally { taskFiles?.cleanup(); }
});

test.each(['pid-changed', 'already-started', 'mount-reader-denied'])('does not start after %s during effective mount review', async mode => {
  await expect(fixtureEngine(mode).run({ argv: ['agent'] })).rejects.toThrow();
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
});

test.each(['echo', 'workspace-aba'])('keeps approved directory inodes pinned and closes them after %s', async mode => {
  const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs);
  const pins = new Set();
  let observed = false;
  const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
    const fd = open(file, flags, ...args);
    if (file === workspace && (flags & fs.constants.O_DIRECTORY)) pins.add(fd);
    return fd;
  });
  const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
    if (pins.has(fd)) observed = fs.existsSync(path.join(workspace, 'initialized')) && fs.existsSync(path.join(workspace, 'removed'));
    pins.delete(fd);
    return close(fd);
  });
  try {
    const running = fixtureEngine(mode).run({ argv: ['agent'] });
    if (mode === 'echo') await running;
    else await expect(running).rejects.toThrow('Effective initialized mounts');
    expect(observed).toBe(true);
    expect(pins.size).toBe(0);
  } finally { openSpy.mockRestore(); closeSpy.mockRestore(); }
});

test('directory-handle cleanup failure preserves uncertain execution identity and retained paths', async () => {
  const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs);
  let pin;
  const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((file, flags, ...args) => {
    const fd = open(file, flags, ...args);
    if (file === workspace && (flags & fs.constants.O_DIRECTORY)) pin = fd;
    return fd;
  });
  const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation(fd => {
    close(fd);
    if (fd === pin) { pin = undefined; throw Object.assign(new Error('fake handle close failure'), {code:'EIO'}); }
  });
  try {
    let error;
    try { await fixtureEngine('unconfirmed').run({ argv: ['agent'] }); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code:'RESTRICTED_CANCELLATION_UNCONFIRMED',containerId:'b'.repeat(64) });
    expect(fs.existsSync(path.join(error.retainedEngineConfiguration,'containers.conf'))).toBe(true);
    expect(error.errors.at(-1)).toHaveProperty('code','EIO');
  } finally { openSpy.mockRestore(); closeSpy.mockRestore(); }
});

test('the fixed mount reader refuses an unrelated live process root and missing processes', () => {
  expect(() => readInitializedMountIdentity(process.pid, workspace, false)).toThrow('root filesystem does not match');
  expect(() => readInitializedMountIdentity(2147483647, workspace, false)).toThrow();
});

test.each([0, 1, -1, 2.5, '1234', Number.NaN])('the fixed mount reader rejects invalid PID %p', pid => {
  expect(() => readInitializedMountIdentity(pid, workspace, false)).toThrow('Invalid initialized mount identity');
});

test('validates exact mounted directory identities without source pathname checks', () => {
  const expected = { '/workspace': { dev: '10', ino: '123' } };
  const receipt = { pid: 1234, startTime: '100', namespace: { dev: '4', ino: '12345' }, mounts: expected };
  expect(() => validateInitializedMountIdentity(receipt, 1234, expected)).not.toThrow();
  for (const change of [r => r.pid++, r => r.startTime='', r => r.mounts={},
    r => r.mounts['/workspace'].ino='124', r => r.mounts['/workspace'].dev='11',
    r => r.mounts['/extra']={dev:'10',ino:'123'}]) {
    const altered = JSON.parse(JSON.stringify(receipt));
    change(altered);
    expect(() => validateInitializedMountIdentity(altered, 1234, expected)).toThrow('Effective initialized mounts');
  }
});

test('normal completion confirms the exact created container is absent', async () => {
  await fixtureEngine().run({ argv: ['agent'] });
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'queries'), 'utf8').trim().split('\n')).toEqual(['b'.repeat(64)]);
});

test.each(['extra-mount', 'workspace-source'])('rejects %s before starting task argv and confirms cleanup', async mode => {
  await expect(fixtureEngine(mode).run({ argv: ['agent'] })).rejects.toBeInstanceOf(ExecutorUnavailableError);
  expect(fs.existsSync(path.join(workspace, 'initialized'))).toBe(true);
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'queries'), 'utf8').trim()).toBe('b'.repeat(64));
});

test('cancellation during initialization does not start a reviewed task', async () => {
  const controller = new AbortController();
  const running = fixtureEngine('delayed-init').run({ argv: ['agent'], signal: controller.signal });
  const result = expect(running).rejects.toThrow('cancel initialization');
  for (let i = 0; i < 400 && !fs.existsSync(path.join(workspace, 'initialized')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(fs.existsSync(path.join(workspace, 'initialized'))).toBe(true);
  controller.abort(new Error('cancel initialization'));
  await result;
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
});

test('refuses independent mounts.conf without reading its private source', async () => {
  const home = path.join(controlRoot, 'home');
  fs.mkdirSync(path.join(home, '.config/containers'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/containers/mounts.conf'), '/private:/private');
  const read = jest.spyOn(fs, 'readFileSync');
  try {
    expect(() => assertNoAutomaticMounts(home)).toThrow('Automatic container mount configuration is unsupported');
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await expect(fixtureEngine().probe()).resolves.toMatchObject({ available: false, reason: 'Automatic container mount configuration is unsupported by this executor' });
    expect(fs.existsSync(path.join(workspace, 'created'))).toBe(false);
  } finally { process.env.HOME = previous; }
});

test.each(['/etc/containers/mounts.conf', '/usr/share/containers/mounts.conf', '/etc/system-fips'])('rejects automatic source %s without overriding system policy', file => {
  const lstat = fs.lstatSync.bind(fs);
  const spy = jest.spyOn(fs, 'lstatSync').mockImplementation(candidate => candidate === file ? lstat(workspace) : lstat(candidate));
  try { expect(() => assertNoAutomaticMounts(controlRoot)).toThrow('Automatic container mount configuration is unsupported'); }
  finally { spy.mockRestore(); }
});

function reviewSpec() {
  const policy = {workspaceRoot: workspace, readOnly: true, graphRoot: path.join(controlRoot, 'graph'), runRoot: path.join(controlRoot, 'run'), containerId: 'b'.repeat(64)};
  const sources = { WORKSPACE: policy.workspaceRoot, GRAPH: policy.graphRoot, RUN: policy.runRoot, CID: policy.containerId };
  const spec = JSON.parse(JSON.stringify(require('../fixtures/sharedOCI.json')), (key, value) =>
    typeof value === 'string' ? value.replace(/WORKSPACE|GRAPH|RUN|CID/g, token => sources[token]) : value);
  return {spec, policy};
}

test.each(['seccomp-missing', 'seccomp-unconfined', 'seccomp-unix'])('never starts argv with %s initialized policy', async mode => {
  await expect(fixtureEngine(mode).run({ argv: ['agent'] })).rejects.toBeInstanceOf(ExecutorUnavailableError);
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'removed'), 'utf8')).toBe('b'.repeat(64));
});

test.each([
  ['missing filter', s => delete s.linux.seccomp],
  ['default allow', s => s.linux.seccomp.defaultAction = 'SCMP_ACT_ALLOW'],
  ['notification listener', s => s.linux.seccomp.listenerPath = '/workspace/socket'],
  ['extra ABI', s => s.linux.seccomp.architectures.push('SCMP_ARCH_X86')],
  ['io_uring bypass', s => s.linux.seccomp.syscalls.push({names:['io_uring_setup'],action:'SCMP_ACT_ALLOW'})],
  ['broad socket rule', s => s.linux.seccomp.syscalls.push({names:['socket'],action:'SCMP_ACT_ALLOW'})],
  ['altered socket argument', s => s.linux.seccomp.syscalls.find(rule => rule.names.includes('socket') && rule.action === 'SCMP_ACT_ERRNO').args = []],
  ['weakened default error', s => s.linux.seccomp.defaultErrnoRet = 0]
])('refuses a changed complete syscall policy: %s', (_name, change) => {
  const {spec, policy} = reviewSpec(); change(spec);
  expect(() => validateOCISpec(spec, policy)).toThrow('restricted boundary');
});

test('accepts the reviewed Round 5 OCI mount fixture', () => {
  const {spec, policy} = reviewSpec();
  expect(() => validateOCISpec(spec, policy)).not.toThrow();
});

test.each([
  ['copied canary in userdata', s => s.mounts.push({destination:'/private',type:'bind',source:'/private',options:['ro']})],
  ['missing workspace', s => s.mounts = s.mounts.filter(m => m.destination !== '/workspace')],
  ['duplicate destination', s => s.mounts[0] = s.mounts[1]],
  ['writable readonly workspace', s => s.mounts.find(m => m.destination === '/workspace').options.push('rw')],
  ['host bind at approved destination', s => s.mounts.find(m => m.destination === '/etc/hosts').source = '/private'],
  ['shared propagation', s => s.mounts.find(m => m.destination === '/workspace').options.push('rshared')],
  ['executable tmpfs', s => s.mounts.find(m => m.destination === '/tmp').options = ['rw']],
  ['external network namespace', s => s.linux.namespaces.find(n => n.type === 'network').path = '/proc/1/ns/net'],
  ['missing mount namespace', s => s.linux.namespaces = s.linux.namespaces.filter(n => n.type !== 'mount')],
  ['OCI hook', s => s.hooks = {prestart:[{path:'/host/program'}]}],
  ['capability', s => s.process.capabilities = {effective:['CAP_SYS_ADMIN']}],
  ['extra device', s => s.linux.devices = [{path:'/dev/private'}]],
  ['unbounded memory', s => s.linux.resources.memory.limit = -1],
  ['unbounded PIDs', s => s.linux.resources.pids.limit = -1],
  ['unbounded CPU', s => s.linux.resources.cpu.quota = -1],
  ['missing core limit', s => delete s.process.rlimits],
  ['duplicate core limit', s => s.process.rlimits.push({...s.process.rlimits[0]})],
  ['nonzero core soft limit', s => s.process.rlimits[0].soft = 1],
  ['unbounded core hard limit', s => s.process.rlimits[0].hard = -1],
  ['writable root', s => s.root.readonly = false],
  ['foreign root filesystem', s => s.root.path = '/private'],
  ['privilege escalation', s => s.process.noNewPrivileges = false]
])('rejects an initialized OCI configuration with %s', (_name, change) => {
  const {spec, policy} = reviewSpec();
  change(spec);
  expect(() => validateOCISpec(spec, policy)).toThrow('restricted boundary');
});

test('cancellation during create waits for identity and never starts task code', async () => {
  const controller = new AbortController();
  const running = fixtureEngine('delayed-create').run({ argv: ['agent'], signal: controller.signal });
  const result = expect(running).rejects.toThrow('cancel creation');
  for (let i = 0; i < 200 && !fs.existsSync(path.join(workspace, 'created')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(fs.existsSync(path.join(workspace, 'created'))).toBe(true);
  controller.abort(new Error('cancel creation'));
  await result;
  expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace, 'present'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace, 'queries'), 'utf8').trim()).toBe('b'.repeat(64));
});

function journalFixture() {
  const root=path.join(controlRoot,'journal');fs.mkdirSync(root,{mode:0o700});
  const events=[];
  const journal={cidFile:path.join(root,'container.cid'),taskId:require('crypto').randomUUID(),leaseId:require('crypto').randomUUID(),
    record:async event=>events.push(event)};
  return {journal,events};
}
test('journals the exact create identity, initialized process and absence outside task mounts', async () => {
  const {journal,events}=journalFixture();
  await fixtureEngine().run({argv:['agent'],journal});
  expect(events.map(e=>e.phase)).toEqual(['creating','created','starting','absent']);
  expect(events[0]).toMatchObject({image,configuration:{path:expect.stringContaining('chatspace-engine-config-')}});
  expect(events[1]).toMatchObject({containerId:'b'.repeat(64),cidFile:{path:journal.cidFile}});
  expect(events[2].process).toEqual({pid:1234,startTime:'100'});
  expect(events[2].cgroup.path).toContain('libpod-'+'b'.repeat(64)+'.scope/container');
  const args=JSON.parse(fs.readFileSync(path.join(workspace,'created')));
  expect(args).toEqual(expect.arrayContaining(['--cidfile',journal.cidFile,'chatspace.task='+journal.taskId,'chatspace.lease='+journal.leaseId]));
  expect(args).toEqual(expect.arrayContaining(['--timeout=120','--stop-timeout=0']));
});
test('unverified kernel cgroup blocks task startup and confirms exact container absence', async () => {
  const cgroup = require('../../src/shared/executorCgroup');
  cgroup.readInitializedTaskCgroup.mockImplementationOnce(() => { throw new ExecutorUnavailableError('cgroup identity unavailable'); });
  const {journal,events}=journalFixture();
  await expect(fixtureEngine().run({argv:['agent'],journal})).rejects.toThrow('cgroup identity unavailable');
  expect(events.map(e=>e.phase)).toEqual(['creating','created','absent']);
  expect(fs.existsSync(path.join(workspace,'started'))).toBe(false);
  expect(fs.existsSync(path.join(workspace,'present'))).toBe(false);
});
test('pre-create journal failure prevents effects and callback failure after create prevents startup', async () => {
  const {journal,events}=journalFixture();
  journal.record=async event=>{events.push(event);if(event.phase==='creating')throw Error('Journal offline');};
  await expect(fixtureEngine().run({argv:['agent'],journal})).rejects.toThrow('Journal offline');
  expect(fs.existsSync(path.join(workspace,'created'))).toBe(false);
  journal.record=async event=>{events.push(event);if(event.phase==='created')throw Error('Receipt interrupted');};
  await expect(fixtureEngine().run({argv:['agent'],journal})).rejects.toThrow('Receipt interrupted');
  expect(fs.existsSync(path.join(workspace,'started'))).toBe(false);
  expect(fs.readFileSync(path.join(workspace,'queries'),'utf8').trim()).toBe('b'.repeat(64));
});
test.each(['existing','symlink','workspace','bad-cidfile'])('rejects %s journal identities without starting task code', async kind => {
  const {journal}=journalFixture();
  if(kind==='existing')fs.writeFileSync(journal.cidFile,'b'.repeat(64));
  if(kind==='symlink')fs.symlinkSync(path.join(workspace,'private'),journal.cidFile);
  if(kind==='workspace'){fs.mkdirSync(path.join(workspace,'journal'),{mode:0o700});journal.cidFile=path.join(workspace,'journal/container.cid');}
  await expect(fixtureEngine(kind==='bad-cidfile'?kind:'echo').run({argv:['agent'],journal})).rejects.toThrow();
  expect(fs.existsSync(path.join(workspace,'started'))).toBe(false);
  if(kind==='bad-cidfile')expect(fs.readFileSync(path.join(workspace,'queries'),'utf8').trim()).toBe('b'.repeat(64));
  else expect(fs.existsSync(path.join(workspace,'created'))).toBe(false);
});

test('a blocked journal cannot launch argv after the original deadline while its timer is delayed', async () => {
  const childProcess=require('child_process'),spawnSpy=jest.spyOn(childProcess,'spawn');let ObservedExecutor;
  jest.isolateModules(()=>{ObservedExecutor=require('../../src/shared/restrictedExecutor').RootlessPodmanExecutor;});
  const fixture=fixtureEngine(),{journal,events}=journalFixture();
  const record=journal.record;journal.record=async event=>{
    await record(event);
    if(event.phase==='starting'){
      const until=Date.now()+1100;while(Date.now()<until){} // Real timer starvation before the launch boundary.
    }
  };
  try {
    const executor=new ObservedExecutor({podmanPath:fixture.podmanPath,image,workspaceRoot:workspace});
    await expect(executor.run({argv:['agent'],journal,timeoutMs:1000})).rejects.toThrow('timed out');
    expect(events.some(e=>e.phase==='starting')).toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled(); // Spy forwards actual calls; it never substitutes an engine/result.
    expect(fs.readFileSync(path.join(workspace,'queries'),'utf8').trim()).toBe('b'.repeat(64));
  } finally {spawnSpy.mockRestore();}
});

test.each(['residual', 'query-error'])('does not publish success when cleanup is %s', async mode => {
  await expect(fixtureEngine(mode).run({ argv: ['agent'] })).rejects.toMatchObject({
    code: 'RESTRICTED_CANCELLATION_UNCONFIRMED', containerId: 'b'.repeat(64)
  });
});

test('uncertain removal retains configuration and quarantines further execution', async () => {
  const executor = fixtureEngine('unconfirmed');
  let error;
  try { await executor.run({ argv: ['agent'] }); } catch (failure) { error = failure; }
  expect(error).toMatchObject({ code: 'RESTRICTED_CANCELLATION_UNCONFIRMED' });
  expect(fs.existsSync(path.join(error.retainedEngineConfiguration, 'containers.conf'))).toBe(true);
  await expect(executor.probe()).resolves.toMatchObject({ available: false, reason: 'Executor cleanup requires operator review' });
  await expect(executor.run({ argv: ['agent'] })).rejects.toBeInstanceOf(ExecutorUnavailableError);
});

test('configuration cleanup failure preserves a confirmed execution failure', async () => {
  const remove = fs.rmSync.bind(fs);
  const retained = [];
  const spy = jest.spyOn(fs, 'rmSync').mockImplementation((candidate, options) => {
    if (path.basename(candidate).startsWith('chatspace-engine-config-') && fs.existsSync(path.join(workspace, 'removed'))) {
      retained.push(candidate);
      throw Object.assign(new Error('fixture cleanup failure'), { code: 'EACCES' });
    }
    return remove(candidate, options);
  });
  try {
    const executor = fixtureEngine();
    const controller = new AbortController();
    let error;
    const running = executor.run({ argv: ['agent'], signal: controller.signal });
    for (let i = 0; i < 200 && !fs.existsSync(path.join(workspace, 'created')); i++) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(new Error('fixture cancellation'));
    try { await running; } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0].message).toBe('fixture cancellation');
    expect(error.errors[1].code).toBe('EACCES');
    expect(retained).toHaveLength(1);
  } finally {
    spy.mockRestore();
    for (const directory of retained) remove(directory, { recursive: true, force: true });
  }
});

test('stages bounded task inputs in private directories outside the project', () => {
  const task = new RestrictedTaskFiles(workspace, outputStore);
  try {
    const file = task.addInput({ name: '../../private.txt', type: 'text/plain', bytes: Buffer.from('guest upload') });
    expect(file.path).toMatch(/^\/task-inputs\/[0-9a-f-]+\.txt$/);
    expect(fs.readFileSync(path.join(task.inputRoot, path.posix.basename(file.path)), 'utf8')).toBe('guest upload');
    expect(fs.statSync(task.root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(task.inputRoot, path.posix.basename(file.path))).mode & 0o777).toBe(0o600);
    expect(task.root.startsWith(workspace + path.sep)).toBe(false);
    expect(() => task.addInput({ bytes: Buffer.alloc(20_000_001) })).toThrow(/20 MB/);
    for (let i = 1; i < 10; i++) task.addInput({ bytes: Buffer.from('x') });
    expect(() => task.addInput({ bytes: Buffer.from('x') })).toThrow(/ten/);
  } finally { task.cleanup(); }
  expect(fs.existsSync(task.root)).toBe(false);
});

test('mounts only task-local input and output directories with explicit access', async () => {
  const task = new RestrictedTaskFiles(workspace, outputStore);
  try {
    const result = JSON.parse((await fixtureEngine().run({ argv: ['agent'], taskFiles: task })).output);
    expect(result.args).toContain(`${task.inputRoot}:/task-inputs:ro,nosuid,nodev,noexec`);
    expect(result.args).toContain(`${task.outputRoot}:/task-outputs:rw,nosuid,nodev,noexec`);
    await expect(fixtureEngine().run({ argv: ['agent'], taskFiles: { inputRoot: workspace, outputRoot: workspace } })).rejects.toThrow(/task files/);
  } finally { task.cleanup(); }
});

test('rejects an unbounded task output filesystem', () => {
  expect(() => new RestrictedTaskFiles(workspace, os.tmpdir())).toThrow(/tmpfs bounded/);
});

test.each([
  '/task-outputs/.', '/task-outputs/..', '/task-outputs/', '/task-outputs/report.txt/',
  '/task-outputs//report.txt', '/task-outputs/sub/../report.txt', '/task-outputs/../private.txt'
])('rejects ambiguous restricted output path %s', containerPath => {
  const task = new RestrictedTaskFiles(workspace, outputStore);
  try { expect(() => task.outputPath(containerPath)).toThrow(/task output directory/); }
  finally { task.cleanup(); }
});

test('accepts only direct file paths within this task output directory', () => {
  const task = new RestrictedTaskFiles(workspace, outputStore);
  try {
    expect(task.outputPath('/task-outputs/report.txt')).toBe(path.join(task.outputRoot, 'report.txt'));
    expect(task.outputPath('/task-outputs/.hidden')).toBe(path.join(task.outputRoot, '.hidden'));
    expect(() => task.outputPath('/task-outputs/name\0.txt')).toThrow(/task output directory/);
  } finally { task.cleanup(); }
});

const realOutputStoreTest = process.env.SHARED_TEST_OUTPUT_STORE ? test : test.skip;
realOutputStoreTest('rejects a real output store with broadened access before staging', () => {
  const stat = fs.lstatSync(outputStore);
  let task;
  fs.chmodSync(outputStore, 0o755);
  try { expect(() => { task = new RestrictedTaskFiles(workspace, outputStore); }).toThrow(/private executor-owned/); }
  finally { fs.chmodSync(outputStore, stat.mode & 0o777); task?.cleanup(); }
});

test.each(['suid', 'dev', 'exec', 'ro', 'missing', 'bind-alias'])('rejects output mount with %s', defect => {
  let flags = ['rw', 'nosuid', 'nodev', 'noexec'];
  if (defect === 'suid') flags = flags.filter(x => x !== 'nosuid');
  if (defect === 'dev') flags = flags.filter(x => x !== 'nodev');
  if (defect === 'exec') flags = flags.filter(x => x !== 'noexec');
  if (defect === 'ro') flags = flags.filter(x => x !== 'rw').concat('ro');
  const mount = defect === 'missing' ? '' : `1 0 0:1 ${defect === 'bind-alias' ? '/subdirectory' : '/'} ${outputStore} ${flags.join(',')} - tmpfs tmpfs rw\n`;
  expect(() => assertOutputStoreMount(mount, outputStore)).toThrow('dedicated nosuid,nodev,noexec');
});

test('decodes escaped output mount paths and rejects ambiguous stacked mounts', () => {
  const target = '/tmp/store with spaces';
  const mount = '1 0 0:1 / /tmp/store\\040with\\040spaces rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n';
  expect(() => assertOutputStoreMount(mount, target)).not.toThrow();
  expect(() => assertOutputStoreMount(mount + mount, target)).toThrow('dedicated nosuid,nodev,noexec');
});

realOutputStoreTest('real bounded task output storage rejects excessive bytes and inode creation', () => {
  const task = new RestrictedTaskFiles(workspace, outputStore);
  try {
    const file = path.join(task.outputRoot, 'too-large');
    expect(() => fs.writeFileSync(file, Buffer.alloc(25 * 1024 * 1024))).toThrow(/ENOSPC/);
    fs.unlinkSync(file);
    expect(() => {
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(task.outputRoot, String(i)), '');
    }).toThrow(/ENOSPC/);
  } finally { task.cleanup(); }
});

test('does not pass connector secrets to engine probes or cancellation', async () => {
  const engine = path.join(workspace, 'inspect-engine');
  const record = path.join(workspace, 'control-environment');
  fs.writeFileSync(engine, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const local = args[0] === '--remote=false';
if (local) args.shift();
${engineReviewFixture()}
const configPath = process.env.CONTAINERS_CONF;
const config = configPath ? fs.readFileSync(configPath, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ action: args[0], local, configPath: configPath || null, config, leaked: process.env.SHARED_EXECUTOR_TEST_SECRET || null }) + '\\n');
if (reviewControl(args)) {}
else if (args[0] === 'info') process.stdout.write('true');
else if (args[0] === 'create') { fs.writeFileSync(createdPath,JSON.stringify(args)); process.stdout.write('b'.repeat(64)); }
else if (args[0] === 'start') { fs.writeFileSync(${JSON.stringify(path.join(workspace, 'control-pid'))}, String(process.pid)); process.stderr.write('x'.repeat(1000001)); setInterval(() => {}, 1000); }
else if (args[0] === 'rm') { try { process.kill(Number(fs.readFileSync(${JSON.stringify(path.join(workspace, 'control-pid'))})), 'SIGTERM'); } catch (_) {} }
else if (args[0] === 'container') process.exitCode = 1;
`, { mode: 0o700 });
  require('child_process').execFileSync(process.execPath, ['-e', `
    const { RootlessPodmanExecutor } = require(process.argv[1]);
    ${subprocessKernelFixture()}
    const executor = new RootlessPodmanExecutor({ podmanPath: process.argv[2], image: process.argv[3], workspaceRoot: process.argv[4] });
    executor.run({ argv: ['agent'] }).then(() => { process.exitCode = 1; }).catch(error => {
      if (!error.message.includes('output exceeded')) process.exitCode = 1;
    });
  `, require.resolve('../../src/shared/restrictedExecutor'), engine, image, workspace], {
    timeout: 4000, env: { ...process.env, SHARED_EXECUTOR_TEST_SECRET: 'fixture-only' }
  });
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
  expect(calls.map(call => call.action)).toEqual(['--version', 'info', 'image', 'info', 'create', 'init', 'container', 'unshare', 'container', 'start', 'rm', 'rm', 'container']);
  expect(calls.every(call => call.leaked === null)).toBe(true);
  expect(calls.every(call => call.local)).toBe(true);
  expect(calls.every(call => call.config.includes('mounts = []') && call.config.includes('volumes = []') && call.config.includes('env_host = false'))).toBe(true);
  expect(calls.slice(4).every(call => call.configPath === calls[4].configPath)).toBe(true);
  for (const call of calls) expect(fs.existsSync(call.configPath || '')).toBe(false);
});

function context() {
  return {
    contextVersion: 2,
    conversation: { id: 'room' },
    request: { taskId: 'task', requester: { kind: 'guest', id: 'guest' } },
    execution: { executorId: 'device', identityStatus: 'owner-approved', isolation: 'project-container', workspaceAlias: 'Website' },
    authorization: { grantId: 'grant', policyRevision: 1, deviceId: 'device', deviceEpoch: 1, workspaceAlias: 'Website',
      allowed: ['workspace.read', 'workspace.execute'], resources: ['Website'], destinations: [], requiresApproval: [], denied: [], budget: { maxRuntimeMs: 10000 } }
  };
}
test('only a bound coarse execution approval is supported; read/write approvals and token budgets stay denied', () => {
  const profile = { executor: 'rootless-podman', workspaceAlias: 'Website' }, identity = { deviceId: 'device', conversation: 'room', boundExecutionApproval: true };
  const current = context();
  identity.deviceId = current.execution.executorId; identity.conversation = current.conversation.id;
  current.authorization.requiresApproval = ['workspace.execute'];
  expect(restrictedPolicy(current, profile, identity)).toMatchObject({ readOnly: true });
  expect(() => restrictedPolicy(current, profile, { ...identity, boundExecutionApproval: false })).toThrow(ExecutorUnavailableError);
  current.authorization.requiresApproval = ['workspace.read'];
  expect(() => restrictedPolicy(current, profile, identity)).toThrow(ExecutorUnavailableError);
  current.authorization.requiresApproval = []; current.authorization.budget.maxTokens = 100;
  expect(() => restrictedPolicy(current, profile, identity)).toThrow(ExecutorUnavailableError);
});
test('the staged input manifest pins bytes and rejects mutations, extra files and symlinks', () => {
  const files = new RestrictedTaskFiles(workspace, outputStore);
  try {
    const input = files.addInput({ name: 'invented.txt', type: 'text/plain', bytes: Buffer.from('fixture') });
    const leaf = path.posix.basename(input.path), local = path.join(files.inputRoot, leaf);
    expect(files.inputManifest()).toEqual([{ path: input.path, bytes: 7, sha256: require('crypto').createHash('sha256').update('fixture').digest('hex') }]);
    files.assertReady();
    fs.writeFileSync(local, 'changed'); expect(() => files.assertReady()).toThrow('bytes changed');
    fs.writeFileSync(local, 'fixture'); files.assertReady();
    const extra = path.join(files.inputRoot, 'extra'); fs.writeFileSync(extra, 'unapproved');
    expect(() => files.assertReady()).toThrow('inventory changed'); fs.unlinkSync(extra);
    fs.unlinkSync(local); fs.symlinkSync(path.join(workspace, 'outside'), local);
    expect(() => files.assertReady()).toThrow();
  } finally { files.cleanup(); }
});
const profile = { executor: 'rootless-podman', workspaceAlias: 'Website', timeoutMs: 120000 };
const identity = { deviceId: 'device', conversation: 'room' };

test('enforces grant workspace, write permissions and finite runtime at the adapter', () => {
  expect(restrictedPolicy(context(), profile, identity)).toEqual({ readOnly: true, timeoutMs: 10000 });
  const writable = context();
  writable.authorization.allowed.push('workspace.write');
  expect(restrictedPolicy(writable, profile, identity).readOnly).toBe(false);
});

test.each([
  ['workspace mismatch', c => { c.execution.workspaceAlias = 'Private'; }],
  ['changed executor', c => { c.authorization.deviceId = 'other'; }],
  ['missing execution permission', c => { c.authorization.allowed = ['workspace.read']; }],
  ['unbounded runtime', c => { c.authorization.budget = {}; }],
  ['unsupported budget', c => { c.authorization.budget.cost = 10; }],
  ['unsupported approval', c => { c.authorization.requiresApproval = ['deploy']; }],
  ['unsupported destination', c => { c.authorization.destinations = ['https://private.test']; }],
  ['expired grant', c => { c.authorization.expiresAt = '2000-01-01T00:00:00Z'; }]
])('fails closed for %s', (_, mutate) => {
  const current = context();
  mutate(current);
  expect(() => restrictedPolicy(current, profile, identity)).toThrow(ExecutorUnavailableError);
});

test.each(['', false, 0, [], {}, 'invalid-date'])('rejects malformed supplied expiry %p', expiry => {
  const current = context();
  current.authorization.expiresAt = expiry;
  expect(() => restrictedPolicy(current, profile, identity)).toThrow(ExecutorUnavailableError);
});

test.each([undefined, null, '2999-01-01T00:00:00Z'])('preserves supported grant expiry %p', expiry => {
  const current = context();
  current.authorization.expiresAt = expiry;
  expect(restrictedPolicy(current, profile, identity)).toEqual({ readOnly: true, timeoutMs: 10000 });
});

test.each(['live-process','live-descendant','uncertain-hierarchy'])('normal output remains held when %s is observed after exact engine removal',async kind=>{
 const cgroup=require('../../src/shared/executorCgroup'),{journal,events}=journalFixture();
 if(kind==='live-process')cgroup.observeTaskProcess.mockImplementationOnce(p=>({...p,absentOrStopped:false}));
 if(kind==='live-descendant')cgroup.observeRetainedTaskCgroup.mockImplementationOnce(()=>({stopped:false,scope:{populated:true}}));
 if(kind==='uncertain-hierarchy')cgroup.observeRetainedTaskCgroup.mockImplementationOnce(()=>{throw Error('controlled hierarchy query failure')});
 let failure;try{await fixtureEngine().run({argv:['agent'],journal})}catch(e){failure=e}
 expect(failure).toMatchObject({code:'RESTRICTED_CANCELLATION_UNCONFIRMED',containerId:'b'.repeat(64)});
 expect(events.some(e=>e.phase==='absent')).toBe(false);
 expect(fs.existsSync(path.join(failure.retainedEngineConfiguration,'containers.conf'))).toBe(true);
});

test('an elapsed deadline during durable cleanup cannot return normal output',async()=>{
 const {journal,events}=journalFixture(),record=journal.record,clock=process.hrtime.bigint.bind(process.hrtime);let elapsed=0n;
 const spy=jest.spyOn(process.hrtime,'bigint').mockImplementation(()=>clock()+elapsed);
 journal.record=async e=>{await record(e);if(e.phase==='absent')elapsed=4000000000n};
 try { await expect(fixtureEngine().run({argv:['agent'],journal,timeoutMs:3000})).rejects.toThrow('timed out');expect(events.at(-1).phase).toBe('absent'); }
 finally { spy.mockRestore(); }
});
