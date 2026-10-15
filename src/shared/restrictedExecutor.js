'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { promisify, isDeepStrictEqual } = require('util');
const hostPolicy = require('./executorHostPolicy');
const RESTRICTED_SECCOMP = require('./restricted-seccomp.json');

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_ENV = /(TOKEN|PASSWORD|SECRET|PRIVATE|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY)/i;
const PINNED_IMAGE = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/;
const MAX_TASK_FILE_BYTES = 20_000_000;
const MAX_TASK_FILES = 10;
const MAX_OUTPUT_STORE_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_STORE_INODES = 256;
const MAX_OCI_CONFIG_BYTES = 256 * 1024;
const quarantinedEngines = new Set();

// This adapter exposes only a local workspace. More specific tool permissions
// need a different enforcement boundary; they cannot be supplied as prompts.
function restrictedPolicy(context, profile, { deviceId, conversation, boundExecutionApproval = false } = {}) {
  const deny = reason => { throw new ExecutorUnavailableError(reason); };
  if (context?.contextVersion !== 2 || profile?.executor !== 'rootless-podman') deny('Shared execution requires the restricted protocol-2 adapter');
  const authorization = context.authorization;
  const execution = context.execution;
  if (!authorization?.grantId || !Number.isSafeInteger(authorization.policyRevision) || authorization.policyRevision < 1) deny('A current execution grant is required');
  if (execution?.isolation !== 'project-container' || execution.identityStatus !== 'owner-approved' || !execution.executorId ||
      authorization.deviceId !== execution.executorId || execution.executorId !== deviceId ||
      !Number.isSafeInteger(authorization.deviceEpoch) || authorization.deviceEpoch < 1) deny('The approved executor identity does not match');
  if (context.conversation?.id !== conversation || !context.request?.taskId || !['user', 'guest'].includes(context.request.requester?.kind)) deny('The execution context does not match this conversation');
  if (authorization.expiresAt !== undefined && authorization.expiresAt !== null &&
      (typeof authorization.expiresAt !== 'string' || !Number.isFinite(Date.parse(authorization.expiresAt)) || Date.parse(authorization.expiresAt) <= Date.now())) deny('Execution grant has expired or its expiry is invalid');
  if (!profile.workspaceAlias || authorization.workspaceAlias !== profile.workspaceAlias || execution.workspaceAlias !== profile.workspaceAlias) deny('The approved workspace does not match this profile');
  if (!Array.isArray(authorization.resources) || authorization.resources.length !== 1 || authorization.resources[0] !== profile.workspaceAlias) deny('Resource restrictions are unsupported by this adapter');
  const actions = authorization.allowed;
  if (!Array.isArray(actions) || !actions.includes('workspace.read') || !actions.includes('workspace.execute') ||
      actions.some(action => !['workspace.read', 'workspace.write', 'workspace.execute'].includes(action))) deny('This adapter requires explicit workspace execution permission');
  if (!Array.isArray(authorization.destinations) || authorization.destinations.length ||
      !Array.isArray(authorization.requiresApproval) || authorization.requiresApproval.some(action => !boundExecutionApproval || action !== 'workspace.execute') ||
      !Array.isArray(authorization.denied) || authorization.denied.length) deny('Destination or action approval policies require a supported action boundary');
  const budget = authorization.budget;
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(key => key !== 'maxRuntimeMs') ||
      !Number.isSafeInteger(budget.maxRuntimeMs) || budget.maxRuntimeMs < 1000 || budget.maxRuntimeMs > 900000) deny('A finite supported execution budget is required');
  if (profile.timeoutMs !== undefined && (!Number.isSafeInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 900000)) deny('The profile runtime budget is invalid');
  return { readOnly: !actions.includes('workspace.write'), timeoutMs: Math.min(profile.timeoutMs || DEFAULT_TIMEOUT_MS, budget.maxRuntimeMs) };
}

class ExecutorUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'RESTRICTED_EXECUTOR_UNAVAILABLE';
    this.status = 503;
  }
}

function workspaceSnapshot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new TypeError('Workspace root must be absolute');
  let stat;
  try {
    stat = fs.lstatSync(workspaceRoot, { bigint: true });
  } catch (_) {
    throw new TypeError('Workspace root must be a regular directory');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Workspace root must be a regular directory');
  const resolved = fs.realpathSync(workspaceRoot);
  const current = fs.lstatSync(workspaceRoot, { bigint: true });
  const resolvedStat = fs.lstatSync(resolved, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || resolvedStat.isSymbolicLink() || !resolvedStat.isDirectory() ||
      current.dev !== stat.dev || current.ino !== stat.ino || resolvedStat.dev !== stat.dev || resolvedStat.ino !== stat.ino) {
    throw new TypeError('Workspace root changed while resolving');
  }
  if (/[:\n\r\0]/.test(resolved)) throw new TypeError('Workspace root cannot contain mount separators');
  return { root: resolved, stat };
}

function approvedWorkspace(workspaceRoot) {
  return workspaceSnapshot(workspaceRoot).root;
}

function safeEnvironment(environment, allowlist) {
  if (environment === undefined || environment === null) return {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new TypeError('Executor environment must be an object');
  const allowed = new Set(allowlist);
  const result = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || SECRET_ENV.test(key) || !allowed.has(key)) throw new TypeError(`Environment variable is not approved: ${key}`);
    if (typeof value !== 'string' || value.length > 4096) throw new TypeError(`Invalid environment value: ${key}`);
    result[key] = value;
  }
  return result;
}

// Engine control processes also run outside the container. Do not give probes
// or cancellation access to connector credentials or remote-engine settings.
function engineEnvironment(configPath) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    CONTAINERS_CONF: configPath
  };
}

function assertNoAutomaticMounts(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new ExecutorUnavailableError('A local executor home is required');
  // containers/common reads these independently of CONTAINERS_CONF, and copies
  // their sources during initialization. Refuse rather than read private data or
  // disable system FIPS controls. The final OCI check also catches late mounts.
  for (const file of [path.join(home, '.config/containers/mounts.conf'),
    '/etc/containers/mounts.conf', '/usr/share/containers/mounts.conf', '/etc/system-fips']) {
    try { fs.lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new ExecutorUnavailableError('Automatic container mount configuration cannot be verified');
    }
    throw new ExecutorUnavailableError('Automatic container mount configuration is unsupported by this executor');
  }
}

function pathsOverlap(left, right) {
  const contains = (a, b) => b === a || b.startsWith(a + path.sep);
  return contains(left, right) || contains(right, left);
}

// This is deliberately version-specific. inspect.Mounts excludes automatic
// subscription mounts; only the complete initialized OCI mount set is checked.
function validateOCISpec(spec, { workspaceRoot, readOnly, taskFiles, graphRoot, runRoot, containerId } = {}) {
  const deny = () => { throw new ExecutorUnavailableError('Initialized container configuration violates the restricted boundary'); };
  // Network namespaces do not isolate pathname Unix sockets in bind mounts.
  // Check the complete native-ABI filter, including default denial, before argv.
  if (!isDeepStrictEqual(spec?.linux?.seccomp, RESTRICTED_SECCOMP)) deny();
  if (!spec || spec.root?.readonly !== true || spec.process?.noNewPrivileges !== true || spec.process.cwd !== '/workspace' ||
      (spec.hooks && Object.values(spec.hooks).some(hooks => !Array.isArray(hooks) || hooks.length)) ||
      Object.values(spec.process.capabilities || {}).some(caps => !Array.isArray(caps) || caps.length) ||
      (spec.linux?.devices && (!Array.isArray(spec.linux.devices) || spec.linux.devices.length))) deny();
  const resources = spec.linux?.resources;
  if (resources?.memory?.limit !== 512 * 1024 * 1024 || resources.cpu?.quota !== 100000 || resources.cpu?.period !== 100000 || resources.pids?.limit !== 128) deny();
  if (!Array.isArray(spec.process.rlimits)) deny();
  const coreLimits = spec.process.rlimits.filter(limit => limit?.type === 'RLIMIT_CORE');
  if (coreLimits.length !== 1 || coreLimits[0].soft !== 0 || coreLimits[0].hard !== 0) deny();
  const namespaces = spec.linux?.namespaces;
  const expectedNamespaces = ['pid', 'network', 'ipc', 'uts', 'mount', 'user', 'cgroup'];
  if (!Array.isArray(namespaces) || namespaces.length !== expectedNamespaces.length ||
      expectedNamespaces.some(type => namespaces.filter(ns => ns.type === type && !ns.path).length !== 1)) deny();
  const rootPattern = new RegExp('^' + graphRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/overlay/[a-f0-9]{64}/merged$');
  if (typeof spec.root.path !== 'string' || !rootPattern.test(spec.root.path)) deny();
  const staticDir = path.join(graphRoot, 'overlay-containers', containerId, 'userdata');
  const runtimeDir = path.join(runRoot, 'overlay-containers', containerId, 'userdata');
  const expected = new Map();
  const mount = (destination, type, source, required, optional = []) => expected.set(destination, { type, source, required, optional });
  mount('/sys', 'sysfs', 'sysfs', ['nosuid', 'noexec', 'nodev', 'ro']);
  mount('/tmp', 'tmpfs', 'tmpfs', ['rw', 'noexec', 'nosuid', 'nodev', 'rprivate', 'tmpcopyup']);
  for (const destination of ['/run', '/var/tmp']) mount(destination, 'tmpfs', 'tmpfs', ['rw', 'rprivate', 'nosuid', 'nodev', 'tmpcopyup']);
  mount('/proc', 'proc', 'proc', ['nosuid', 'noexec', 'nodev']);
  mount('/dev', 'tmpfs', 'tmpfs', ['nosuid', 'strictatime', 'mode=755', 'size=65536k']);
  mount('/dev/pts', 'devpts', 'devpts', ['nosuid', 'noexec', 'newinstance', 'ptmxmode=0666', 'mode=0620', 'gid=5']);
  mount('/dev/mqueue', 'mqueue', 'mqueue', ['nosuid', 'noexec', 'nodev']);
  mount('/sys/fs/cgroup', 'cgroup', 'cgroup', ['rprivate', 'nosuid', 'noexec', 'nodev', 'relatime', 'ro']);
  mount('/workspace', 'bind', workspaceRoot, ['rprivate', 'rbind', ...(readOnly ? ['ro'] : [])], readOnly ? [] : ['rw']);
  const privateFlags = ['bind', 'rprivate', 'nosuid', 'noexec', 'nodev'];
  mount('/etc/hostname', 'bind', path.join(runtimeDir, 'hostname'), [...privateFlags, 'ro']);
  mount('/etc/hosts', 'bind', path.join(runtimeDir, 'hosts'), [...privateFlags, 'ro']);
  mount('/run/.containerenv', 'bind', path.join(runtimeDir, '.containerenv'), [...privateFlags, 'ro']);
  mount('/dev/shm', 'bind', path.join(staticDir, 'shm'), privateFlags, ['rw']);
  if (taskFiles) {
    const taskFlags = ['rbind', 'rprivate', 'nosuid', 'noexec', 'nodev'];
    mount('/task-inputs', 'bind', taskFiles.inputRoot, [...taskFlags, 'ro']);
    mount('/task-outputs', 'bind', taskFiles.outputRoot, taskFlags, ['rw']);
  }
  if (!Array.isArray(spec.mounts) || spec.mounts.length !== expected.size) deny();
  for (const entry of spec.mounts) {
    const policy = expected.get(entry?.destination);
    if (!policy || entry.type !== policy.type || entry.source !== policy.source || !Array.isArray(entry.options) ||
        new Set(entry.options).size !== entry.options.length || policy.required.some(option => !entry.options.includes(option)) ||
        entry.options.some(option => !policy.required.includes(option) && !policy.optional.includes(option))) deny();
    expected.delete(entry.destination);
  }
  if (expected.size) deny();
}

// Fixed host-side control helper, run in Podman's user namespace so that remapped
// OCI files can be read. No shell, task argv or supplied program is executed here.
function readOCISpec(configPath) {
  const fs = require('fs');
  const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_OCI_CONFIG_BYTES) throw Error('Invalid OCI configuration');
    const data = Buffer.alloc(before.size + 1);
    let count = 0, n;
    while (count < data.length && (n = fs.readSync(fd, data, count, data.length - count, null))) count += n;
    const after = fs.fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw Error('OCI configuration changed');
    }
    return JSON.parse(data.subarray(0, count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function directoryIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

async function withPinnedDirectories(entries, callback) {
  const descriptors = [];
  const expected = {};
  let failure;
  try {
    for (const { destination, root, stat } of entries) {
      const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.push(fd);
      const pinned = fs.fstatSync(fd, { bigint: true });
      if (!pinned.isDirectory() || String(pinned.dev) !== String(stat.dev) || String(pinned.ino) !== String(stat.ino)) {
        throw new ExecutorUnavailableError('Approved directory changed before pinning');
      }
      // Keep the inode allocated through execution and cleanup, even if its
      // host pathname is removed or restored during runtime initialization.
      expected[destination] = directoryIdentity(pinned);
    }
    return await callback(expected);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const failures = [];
    for (const fd of descriptors) {
      try { fs.closeSync(fd); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const combined = new AggregateError([failure, ...failures].filter(Boolean), 'Approved directory handle cleanup failed');
      for (const key of ['code', 'containerName', 'containerId', 'retainedEngineConfiguration']) {
        if (failure?.[key] !== undefined) combined[key] = failure[key];
      }
      throw combined;
    }
  }
}

// Fixed control program only. /proc/PID/root traverses the initialized process's
// effective mount namespace, unlike the host source path or inspect.Mounts.
// Pin the proc directory first: a dead process cannot be replaced by a reused PID
// through that descriptor. No task files or process arguments are read.
function readInitializedMountIdentity(pid, rootPath, hasTaskFiles) {
  const fs = require('fs');
  if (!Number.isSafeInteger(pid) || pid <= 1 || typeof rootPath !== 'string' || !rootPath.startsWith('/') ||
      typeof hasTaskFiles !== 'boolean') throw Error('Invalid initialized mount identity request');
  const descriptors = [];
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NONBLOCK;
  const open = (file, flags) => { const fd = fs.openSync(file, flags); descriptors.push(fd); return fd; };
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  try {
    const proc = open('/proc/' + pid, directoryFlags | fs.constants.O_NOFOLLOW);
    const anchor = '/proc/self/fd/' + proc;
    const startTime = () => {
      const fd = fs.openSync(anchor + '/stat', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const data = Buffer.alloc(4097);
        let count = 0, n;
        while (count < data.length && (n = fs.readSync(fd, data, count, data.length - count, null))) count += n;
        if (count === data.length) throw Error('Invalid initialized process identity');
        const stat = data.subarray(0, count).toString('utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (!stat.startsWith(pid + ' (') || ['Z', 'X', 'x'].includes(fields[0]) || !/^[1-9][0-9]*$/.test(fields[19])) {
          throw Error('Initialized process is no longer available');
        }
        return fields[19];
      } finally { fs.closeSync(fd); }
    };
    const before = startTime();
    const namespace = identity(fs.statSync(anchor + '/ns/mnt', { bigint: true }));
    // Following this one kernel procfs magic link is intentional. All mount
    // destination opens below are direct children and refuse final symlinks.
    const root = open(anchor + '/root', directoryFlags);
    const rootIdentity = identity(fs.fstatSync(root, { bigint: true }));
    const approvedRoot = open(rootPath, directoryFlags | fs.constants.O_NOFOLLOW);
    if (!same(rootIdentity, identity(fs.fstatSync(approvedRoot, { bigint: true })))) {
      throw Error('Initialized root filesystem does not match');
    }
    const destinations = hasTaskFiles ? ['/workspace', '/task-inputs', '/task-outputs'] : ['/workspace'];
    const mounts = {};
    for (const destination of destinations) {
      const fd = open('/proc/self/fd/' + root + destination, directoryFlags | fs.constants.O_NOFOLLOW);
      mounts[destination] = identity(fs.fstatSync(fd, { bigint: true }));
    }
    if (startTime() !== before || !same(namespace, identity(fs.statSync(anchor + '/ns/mnt', { bigint: true })))) {
      throw Error('Initialized process identity changed');
    }
    return { pid, startTime: before, namespace, mounts };
  } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}

function readInitializedBoundary(configPath, pid, policy) {
  const spec = readOCISpec(configPath);
  // Validate before opening the initialized root. The parent independently
  // repeats the contract and compares the receipt with its retained handles.
  validateOCISpec(spec, policy);
  const receipt = readInitializedMountIdentity(pid, spec.root.path, !!policy.taskFiles);
  return { spec, receipt };
}

// One fixed control process performs both reviews in the same user namespace.
// This removes a Podman/Node startup without moving the execution deadline or
// dropping the full OCI, effective inode, process or final-state checks.
const INITIALIZED_BOUNDARY_READER = [
  "const path=require('path');",
  "const {isDeepStrictEqual}=require('util');",
  'const RESTRICTED_SECCOMP=' + JSON.stringify(RESTRICTED_SECCOMP) + ';',
  'const MAX_OCI_CONFIG_BYTES=' + MAX_OCI_CONFIG_BYTES + ';',
  ExecutorUnavailableError.toString(), readOCISpec.toString(), validateOCISpec.toString(),
  readInitializedMountIdentity.toString(), readInitializedBoundary.toString(),
  'process.stdout.write(JSON.stringify(readInitializedBoundary(process.argv[1],Number(process.argv[2]),JSON.parse(process.argv[3]))));'
].join('\n');

function validateInitializedMountIdentity(receipt, pid, expected) {
  const deny = () => { throw new ExecutorUnavailableError('Effective initialized mounts do not match the approved directories'); };
  if (!receipt || receipt.pid !== pid || !Number.isSafeInteger(pid) || pid <= 1 ||
      typeof receipt.startTime !== 'string' || !/^[1-9][0-9]*$/.test(receipt.startTime) ||
      !receipt.namespace || typeof receipt.namespace.dev !== 'string' || typeof receipt.namespace.ino !== 'string' ||
      !/^[0-9]+$/.test(receipt.namespace.dev) || !/^[1-9][0-9]*$/.test(receipt.namespace.ino) ||
      !receipt.mounts || Object.keys(receipt.mounts).length !== Object.keys(expected).length) deny();
  for (const [destination, identity] of Object.entries(expected)) {
    const mounted = receipt.mounts[destination];
    if (!mounted || mounted.dev !== identity.dev || mounted.ino !== identity.ino) deny();
  }
}

async function withEngineConfiguration(workspaceRoot, callback) {
  const temporaryRoot = approvedWorkspace(os.tmpdir());
  const relative = path.relative(workspaceRoot, temporaryRoot);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new ExecutorUnavailableError('Engine configuration must be outside the approved workspace');
  }
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'chatspace-engine-config-'));
  let failure;
  try {
    fs.chmodSync(root, 0o700);
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks, { mode: 0o700 });
    const configPath = path.join(root, 'containers.conf');
    // CONTAINERS_CONF replaces system/user defaults. Never inherit an override
    // file. Pin OCI hooks to an empty private directory instead of default paths.
    const config = '[containers]\nmounts = []\nvolumes = []\nenv = []\nenv_host = false\n' +
      '[engine]\nremote = false\nimage_volume_mode = "ignore"\nhooks_dir = [' + JSON.stringify(hooks) + ']\n';
    fs.writeFileSync(configPath, config, { mode: 0o600, flag: 'wx' });
    return await callback(engineEnvironment(configPath));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // An engine operation may still own these paths. Do not remove its control
    // configuration while lifecycle cleanup is uncertain.
    if (failure?.code === 'RESTRICTED_CANCELLATION_UNCONFIRMED') {
      failure.retainedEngineConfiguration = root;
    } else {
      try { fs.rmSync(root, { recursive: true, force: true }); }
      catch (cleanupError) {
        if (failure) {
          const combined = new AggregateError([failure, cleanupError], 'Restricted execution failed and private configuration cleanup is unconfirmed');
          combined.code = failure.code;
          throw combined;
        }
        throw new ExecutorUnavailableError('Private engine configuration cleanup is unconfirmed; review the executor');
      }
    }
  }
}

function cleanupUnconfirmed(containerName, containerId, errors) {
  const error = new AggregateError(errors.filter(Boolean), 'Restricted execution cleanup is unconfirmed; review the executor before retrying');
  error.code = 'RESTRICTED_CANCELLATION_UNCONFIRMED';
  error.containerName = containerName;
  error.containerId = containerId || null;
  return error;
}

// A trusted connector may journal engine identities outside every task mount.
// Podman's cidfile survives owner death between creation and stdout delivery;
// it never authorizes removal on its own. Recovery must also check the exact
// name, task/lease labels and image recorded before creation.
function executionJournal(journal, directories) {
  if (journal === undefined) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!journal || typeof journal.record !== 'function' || !uuid.test(journal.taskId) || !uuid.test(journal.leaseId) ||
      typeof journal.cidFile !== 'string' || !path.isAbsolute(journal.cidFile) || path.resolve(journal.cidFile) !== journal.cidFile ||
      path.basename(journal.cidFile) !== 'container.cid') throw new TypeError('Invalid trusted execution journal');
  const root = path.dirname(journal.cidFile), stat = fs.lstatSync(root, { bigint: true });
  const check = () => {
    const current = fs.lstatSync(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(process.getuid()) ||
        current.gid !== BigInt(process.getgid()) || (current.mode & 0o777n) !== 0o700n || fs.realpathSync(root) !== root ||
        current.dev !== stat.dev || current.ino !== stat.ino || directories.some(directory => pathsOverlap(root, directory.root))) {
      throw new ExecutorUnavailableError('Engine identities require private storage outside task mounts');
    }
  };
  check();
  if (fs.existsSync(journal.cidFile) || fs.readdirSync(root).includes('container.cid')) throw new ExecutorUnavailableError('Engine identity file already exists; retain it for review');
  return {
    args: ['--cidfile', journal.cidFile, '--label', 'chatspace.task=' + journal.taskId, '--label', 'chatspace.lease=' + journal.leaseId],
    async record(event) { check(); await journal.record(event); check(); },
    readId(expected) {
      check();
      const fd = fs.openSync(journal.cidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const file = fs.fstatSync(fd, { bigint: true }), bytes = Buffer.alloc(66);
        if (!file.isFile() || file.nlink !== 1n || file.uid !== BigInt(process.getuid()) ||
            (file.mode & 0o022n) !== 0n || file.size < 64n || file.size > 65n) throw new ExecutorUnavailableError('Engine identity file is unsafe');
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0), value = bytes.subarray(0, count).toString();
        if (count !== Number(file.size) || !/^[a-f0-9]{64}\n?$/.test(value) || value.trim() !== expected) throw new ExecutorUnavailableError('Engine identity file does not match create result');
        fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd);
        return { path: journal.cidFile, dev: String(file.dev), ino: String(file.ino) };
      } finally { fs.closeSync(fd); }
    },
    labels: { 'chatspace.task': journal.taskId, 'chatspace.lease': journal.leaseId }
  };
}

async function closedWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function assertOutputStoreMount(mountInfo, outputStore) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
  const matches = mountInfo.split('\n').map(line => line.split(' - ')).filter(parts => parts.length === 2)
    .map(([mount, filesystem]) => ({ mount: mount.split(' '), filesystem: filesystem.split(' ') }))
    .filter(entry => decode(entry.mount[4] || '') === outputStore);
  const entry = matches[0];
  const flags = entry?.mount[5]?.split(',') || [];
  if (matches.length !== 1 || entry.mount[3] !== '/' || entry.filesystem[0] !== 'tmpfs' ||
      !['rw', 'nosuid', 'nodev', 'noexec'].every(flag => flags.includes(flag))) {
    throw new ExecutorUnavailableError('Task output storage requires a dedicated nosuid,nodev,noexec tmpfs mount');
  }
}

function readMountInfo() {
  const fd = fs.openSync('/proc/self/mountinfo', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let count = 0, n;
    while (count < bytes.length && (n = fs.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
    if (count === bytes.length) throw new ExecutorUnavailableError('Executor mount inventory exceeded its verification bound');
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

class RestrictedTaskFiles {
  constructor(workspaceRoot, outputStoreRoot) {
    const workspace = approvedWorkspace(workspaceRoot);
    const temporaryRoot = approvedWorkspace(os.tmpdir());
    if (typeof outputStoreRoot !== 'string') throw new ExecutorUnavailableError('An owner-approved bounded task output store is required');
    const outputStore = approvedWorkspace(outputStoreRoot);
    const relative = path.relative(workspace, temporaryRoot);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new ExecutorUnavailableError('Task staging must be outside the approved workspace');
    }
    const outputRelative = path.relative(workspace, outputStore);
    if (outputRelative === '' || (!outputRelative.startsWith('..' + path.sep) && outputRelative !== '..' && !path.isAbsolute(outputRelative))) {
      throw new ExecutorUnavailableError('Task outputs must be outside the approved workspace');
    }
    this.outputStoreRoot = outputStore;
    this.assertBoundedOutputStore();
    this.root = fs.mkdtempSync(path.join(temporaryRoot, 'chatspace-task-files-'));
    this.inputRoot = path.join(this.root, 'inputs');
    this.inputCount = 0;
    this.inputBytes = 0;
    this.inputs = [];
    try {
      fs.chmodSync(this.root, 0o700);
      fs.mkdirSync(this.inputRoot, { mode: 0o700 });
      this.outputRoot = fs.mkdtempSync(path.join(outputStore, 'chatspace-task-outputs-'));
      fs.chmodSync(this.outputRoot, 0o700);
      this.directories = [this.root, this.inputRoot, this.outputRoot].map(directory => ({ path: directory, stat: fs.lstatSync(directory, { bigint: true }) }));
    } catch (error) {
      fs.rmSync(this.root, { recursive: true, force: true });
      if (this.outputRoot) fs.rmSync(this.outputRoot, { recursive: true, force: true });
      throw error;
    }
  }

  assertBoundedOutputStore() {
    if (process.platform !== 'linux' || typeof fs.statfsSync !== 'function') throw new ExecutorUnavailableError('Bounded task output storage is unavailable');
    const stat = fs.statfsSync(this.outputRoot || this.outputStoreRoot);
    if (stat.type !== 0x01021994 || !Number.isSafeInteger(stat.bsize * stat.blocks) || stat.blocks <= 0 ||
        stat.bsize * stat.blocks > MAX_OUTPUT_STORE_BYTES || !Number.isSafeInteger(stat.files) || stat.files <= 0 || stat.files > MAX_OUTPUT_STORE_INODES) {
      throw new ExecutorUnavailableError('Task output storage requires tmpfs bounded to 24 MiB and 256 inodes');
    }
    this.assertOutputStoreSecurity();
  }

  assertOutputStoreSecurity() {
    const current = fs.lstatSync(this.outputStoreRoot);
    if (current.isSymbolicLink() || !current.isDirectory() || current.uid !== process.getuid() ||
        current.gid !== process.getgid() || (current.mode & 0o777) !== 0o700 ||
        this.outputStoreStat && (current.dev !== this.outputStoreStat.dev || current.ino !== this.outputStoreStat.ino)) {
      throw new ExecutorUnavailableError('Task output storage requires a private executor-owned directory');
    }
    assertOutputStoreMount(readMountInfo(), this.outputStoreRoot);
    this.outputStoreStat ||= current;
  }

  assertReady() {
    for (const directory of this.directories) {
      const current = fs.lstatSync(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.stat.dev || current.ino !== directory.stat.ino) {
        throw new ExecutorUnavailableError('Restricted task files changed before execution');
      }
    }
    this.assertBoundedOutputStore();
    this.assertInputIntegrity();
  }

  inputManifest() {
    return this.inputs.map(({ path: containerPath, bytes, sha256 }) => ({ path: containerPath, bytes, sha256 }));
  }

  assertInputIntegrity() {
    const expected = this.inputs.map(input => path.posix.basename(input.path)).sort();
    if (JSON.stringify(fs.readdirSync(this.inputRoot).sort()) !== JSON.stringify(expected)) throw new ExecutorUnavailableError('Task input inventory changed');
    const directory = fs.openSync(this.inputRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const actual = fs.fstatSync(directory, { bigint: true }), pinned = this.directories[1].stat;
      if (actual.dev !== pinned.dev || actual.ino !== pinned.ino) throw new ExecutorUnavailableError('Task input directory changed');
      for (const input of this.inputs) {
        const fd = fs.openSync(`/proc/self/fd/${directory}/${path.posix.basename(input.path)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const before = fs.fstatSync(fd);
          if (!before.isFile() || before.nlink !== 1 || before.size !== input.bytes) throw new ExecutorUnavailableError('Task input file changed');
          const bytes = Buffer.alloc(input.bytes + 1); let count = 0, n;
          while (count < bytes.length && (n = fs.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
          const after = fs.fstatSync(fd);
          if (count !== input.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
              createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== input.sha256) throw new ExecutorUnavailableError('Task input bytes changed');
        } finally { fs.closeSync(fd); }
      }
    } finally { fs.closeSync(directory); }
  }

  addInput({ name, type, bytes } = {}) {
    this.assertReady();
    if (!Buffer.isBuffer(bytes) || !bytes.length || this.inputBytes + bytes.length > MAX_TASK_FILE_BYTES) throw new Error('Task input files exceed 20 MB; split the request');
    if (this.inputCount >= MAX_TASK_FILES) throw new Error('At most ten input files per restricted task');
    const extension = typeof name === 'string' ? /\.(png|jpg|jpeg|webp|gif|txt|md|pdf|json)$/i.exec(name)?.[0] : null;
    const leaf = randomUUID() + (extension || '.bin');
    fs.writeFileSync(path.join(this.inputRoot, leaf), bytes, { mode: 0o600, flag: 'wx' });
    this.inputCount++;
    this.inputBytes += bytes.length;
    this.inputs.push({ path: '/task-inputs/' + leaf, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    return { name, type, path: '/task-inputs/' + leaf, bytes };
  }

  outputPath(containerPath) {
    const leaf = typeof containerPath === 'string' ? path.posix.basename(containerPath) : '';
    if (!leaf || leaf === '.' || leaf === '..' || containerPath.includes('\0') || containerPath !== '/task-outputs/' + leaf) {
      throw new Error('Restricted results must use a file in the task output directory');
    }
    return path.join(this.outputRoot, leaf);
  }

  cleanup() {
    for (const directory of [this.directories[0], this.directories[2]]) {
      if (!fs.existsSync(directory.path)) continue;
      const current = fs.lstatSync(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.stat.dev || current.ino !== directory.stat.ino) throw new Error('Restricted task directory changed before cleanup');
      fs.rmSync(directory.path, { recursive: true, force: true });
    }
  }
}

class RootlessPodmanExecutor {
  constructor({
    podmanPath = 'podman',
    image,
    workspaceRoot,
    environmentAllowlist = ['HOME', 'LANG', 'LC_ALL', 'PATH'],
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    if (typeof image !== 'string' || !PINNED_IMAGE.test(image)) throw new TypeError('A container image pinned by SHA-256 digest is required');
    this.podmanPath = podmanPath;
    this.image = image;
    const workspace = workspaceSnapshot(workspaceRoot);
    this.workspaceRoot = workspace.root;
    this.workspaceStat = workspace.stat;
    this.environmentAllowlist = [...new Set(environmentAllowlist)];
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 15 * 60 * 1000);
  }

  async probe() {
    if (quarantinedEngines.has(this.podmanPath)) return { available: false, reason: 'Executor cleanup requires operator review' };
    try {
      if (process.platform !== 'linux' || process.arch !== 'x64') throw new ExecutorUnavailableError('The reviewed restricted syscall policy requires Linux x86_64');
      hostPolicy.assertSafeCoreDumpPolicy();
      return await withEngineConfiguration(this.workspaceRoot, async engineEnv => {
        assertNoAutomaticMounts(engineEnv.HOME);
        const version = await execFileAsync(this.podmanPath, ['--remote=false', '--version'], {
          env: engineEnv, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true
        });
        if (version.stdout.trim() !== 'podman version 4.9.3') throw new ExecutorUnavailableError('This restricted boundary requires reviewed Podman 4.9.3');
        const info = await execFileAsync(this.podmanPath, ['--remote=false', 'info', '--format', '{{.Host.Security.Rootless}}'], {
          env: engineEnv,
          timeout: 10_000,
          maxBuffer: 16 * 1024,
          windowsHide: true
        });
        if (info.stdout.trim().toLowerCase() !== 'true') return {
          available: false,
          reason: 'Podman is installed but its service is not rootless.'
        };
        await execFileAsync(this.podmanPath, ['--remote=false', 'image', 'exists', this.image], {
          env: engineEnv,
          timeout: 10_000,
          maxBuffer: 16 * 1024,
          windowsHide: true
        });
        const storage = await execFileAsync(this.podmanPath, ['--remote=false', 'info', '--format', '{{json .Store}}'], {
          env: engineEnv, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true
        });
        const store = JSON.parse(storage.stdout);
        if (store.graphDriverName !== 'overlay') throw new ExecutorUnavailableError('The reviewed executor requires overlay container storage');
        const graphRoot = approvedWorkspace(store.graphRoot);
        const runRoot = approvedWorkspace(store.runRoot);
        for (const directory of [graphRoot, runRoot, path.join(engineEnv.HOME, '.config/containers')]) {
          if (pathsOverlap(this.workspaceRoot, directory)) throw new ExecutorUnavailableError('The workspace overlaps private engine control paths');
        }
        return {
          available: true,
          engine: 'podman-rootless',
          image: this.image,
          graphRoot,
          runRoot
        };
      });
    } catch (error) {
      return {
        available: false,
        reason: error instanceof ExecutorUnavailableError || error.code === 'RESTRICTED_EXECUTOR_UNAVAILABLE' ? error.message : 'A rootless Podman service and the pinned image are required.'
      };
    }
  }

  async assertAvailable() {
    const result = await this.probe();
    if (!result.available) throw new ExecutorUnavailableError(result.reason);
    return result;
  }

  assertWorkspaceReady() {
    let current;
    try { current = fs.lstatSync(this.workspaceRoot, { bigint: true }); }
    catch (_) { throw new ExecutorUnavailableError('Approved workspace changed before execution'); }
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== this.workspaceStat.dev || current.ino !== this.workspaceStat.ino) {
      throw new ExecutorUnavailableError('Approved workspace changed before execution');
    }
  }

  async run({ argv, environment = {}, input = '', signal, readOnly = false, timeoutMs = this.timeoutMs, taskFiles, journal } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value.length)) throw new TypeError('Executor argv must be a non-empty argument array');
    if (argv.some(value => value.includes('\0'))) throw new TypeError('Executor arguments cannot contain NUL bytes');
    const env = safeEnvironment(environment, this.environmentAllowlist);
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_OUTPUT_BYTES) throw new TypeError('Executor input must be at most 1 MB');
    if (typeof readOnly !== 'boolean') throw new TypeError('Workspace access must be explicit');
    if (taskFiles !== undefined && !(taskFiles instanceof RestrictedTaskFiles)) throw new TypeError('Restricted task files must be created by this adapter');
    if (signal?.aborted) throw signal.reason || new Error('Restricted execution cancelled');
    const engine = await this.assertAvailable();
    if (signal?.aborted) throw signal.reason || new Error('Restricted execution cancelled');
    taskFiles?.assertReady();
    this.assertWorkspaceReady();
    const budgetMs = Math.min(Math.max(Number(timeoutMs) || this.timeoutMs, 1000), 15 * 60 * 1000);
    const containerName = 'chatspace-task-' + randomUUID();
    const args = [
      '--remote=false', 'create', '--interactive', '--pull=never', '--name', containerName,
      // Conmon owns this independent kill timer. The original connector deadline
      // still includes create/review and remains the stricter live-owner budget.
      '--timeout=' + Math.ceil(budgetMs / 1000), '--stop-timeout=0',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--ulimit=core=0:0',
      '--memory=512m',
      '--cpus=1',
      '--userns=keep-id',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev',
      '--volume', `${this.workspaceRoot}:/workspace:${readOnly ? 'ro' : 'rw'}`,
      '--workdir', '/workspace'
    ];
    if (taskFiles) args.push('--volume', `${taskFiles.inputRoot}:/task-inputs:ro,nosuid,nodev,noexec`,
      '--volume', `${taskFiles.outputRoot}:/task-outputs:rw,nosuid,nodev,noexec`);
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
    args.push(this.image, ...argv);
    const directories = [{ destination: '/workspace', root: this.workspaceRoot, stat: this.workspaceStat }];
    if (taskFiles) for (const [destination, root] of [['/task-inputs', taskFiles.inputRoot], ['/task-outputs', taskFiles.outputRoot]]) {
      directories.push({ destination, root, stat: taskFiles.directories.find(directory => directory.path === root).stat });
    }
    const identities = executionJournal(journal, directories);
    if (identities) args.splice(2, 0, ...identities.args);
    return withPinnedDirectories(directories, expectedMounts => withEngineConfiguration(this.workspaceRoot, async engineEnv => {
      const control = (controlArgs, maxBuffer = 16 * 1024) => execFileAsync(this.podmanPath, ['--remote=false', ...controlArgs], {
        env: engineEnv, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer, windowsHide: true
      });
      let containerId, child, closed, primary, response, taskProcess, taskCgroup, hierarchyReader;
      let stopError;
      let wakeCancellation;
      const cancellation = new Promise(resolve => { wakeCancellation = resolve; });
      const stop = error => { if (!stopError) { stopError = error; wakeCancellation(); } };
      const abort = () => stop(signal.reason || new Error('Restricted execution cancelled'));
      const deadline = process.hrtime.bigint() + BigInt(Math.ceil(budgetMs * 1_000_000));
      const timer = setTimeout(() => stop(new Error('Restricted execution timed out')), budgetMs);
      signal?.addEventListener('abort', abort, { once: true });
      const checkCancelled = () => {
        if (signal?.aborted) abort();
        // Await/microtask continuation and synchronous journal IO may precede an
        // overdue timer callback. Never start or publish after that deadline.
        if (process.hrtime.bigint() >= deadline) stop(new Error('Restricted execution timed out'));
        if (stopError) throw stopError;
      };
      try {
        checkCancelled();
        hostPolicy.assertSafeCoreDumpPolicy();
        assertNoAutomaticMounts(engineEnv.HOME);
        // Use the pinned policy inside the private control directory. Never
        // inherit a mutable system profile or admit a profile from the task.
        const seccompPath = path.join(path.dirname(engineEnv.CONTAINERS_CONF), 'seccomp.json');
        fs.writeFileSync(seccompPath, JSON.stringify(RESTRICTED_SECCOMP), { mode: 0o600, flag: 'wx' });
        args.splice(2, 0, '--security-opt=seccomp=' + seccompPath);
        if (identities) {
          const root = path.dirname(engineEnv.CONTAINERS_CONF), stat = fs.lstatSync(root, { bigint: true });
          await identities.record({ phase: 'creating', containerName, image: this.image, podmanPath: this.podmanPath,
            configuration: { path: root, dev: String(stat.dev), ino: String(stat.ino) } });
          checkCancelled();
        }
        // Cancellation does not kill a partially completed create command. A
        // completed create supplies the immutable ID used by every later phase.
        try {
          const created = await execFileAsync(this.podmanPath, args, {
            env: engineEnv, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024, windowsHide: true
          });
          containerId = created.stdout.trim();
          if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Executor did not return an exact container identity');
        } catch (error) {
          containerId = null;
          throw cleanupUnconfirmed(containerName, null, [stopError, error]);
        }
        if (identities) await identities.record({ phase: 'created', containerId, cidFile: identities.readId(containerId) });
        checkCancelled();
        await control(['init', containerId]);
        checkCancelled();
        const inspection = await control(['container', 'inspect', '--format', '{{json .}}', containerId], MAX_OCI_CONFIG_BYTES);
        checkCancelled();
        const initialized = JSON.parse(inspection.stdout);
        const staticDir = path.join(engine.graphRoot, 'overlay-containers', containerId, 'userdata');
        if (initialized.Id !== containerId || initialized.Name !== containerName || initialized.State?.Status !== 'initialized' ||
            initialized.State.Running !== false || !Number.isSafeInteger(initialized.State.Pid) || initialized.State.Pid <= 1 || initialized.StaticDir !== staticDir ||
            initialized.OCIConfigPath !== path.join(staticDir, 'config.json') || initialized.HostConfig?.NetworkMode !== 'none' ||
            (identities && Object.entries(identities.labels).some(([key, value]) => initialized.Config?.Labels?.[key] !== value))) {
          throw new ExecutorUnavailableError('The exact task container was not initialized for review');
        }
        const policy = { workspaceRoot: this.workspaceRoot, readOnly,
          taskFiles: taskFiles ? { inputRoot: taskFiles.inputRoot, outputRoot: taskFiles.outputRoot } : undefined,
          graphRoot: engine.graphRoot, runRoot: engine.runRoot, containerId };
        let effective;
        try {
          // The fixed synchronous reader has at most 256 KiB of OCI input. Bound
          // its host heap and background pool independently of the task's limits.
          effective = await execFileAsync(this.podmanPath, ['--remote=false', 'unshare', process.execPath,
            '--v8-pool-size=1', '--max-old-space-size=32', '-e',
            INITIALIZED_BOUNDARY_READER, initialized.OCIConfigPath, String(initialized.State.Pid), JSON.stringify(policy)], {
            env: engineEnv, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: MAX_OCI_CONFIG_BYTES + 16 * 1024, windowsHide: true
          });
        } catch (_) {
          checkCancelled();
          throw new ExecutorUnavailableError('Initialized container boundary could not be verified');
        }
        checkCancelled();
        const boundary = JSON.parse(effective.stdout);
        validateOCISpec(boundary.spec, policy);
        validateInitializedMountIdentity(boundary.receipt, initialized.State.Pid, expectedMounts);
        const lastInspection = await control(['container', 'inspect', '--format', '{{json .State}}', containerId]);
        checkCancelled();
        const lastState = JSON.parse(lastInspection.stdout);
        if (lastState.Status !== 'initialized' || lastState.Running !== false || lastState.Pid !== initialized.State.Pid) {
          throw new ExecutorUnavailableError('Initialized container identity changed before startup');
        }
        // Initialization resolves mounts without running task code. Changes or
        // cancellation during review must never reach start.
        assertNoAutomaticMounts(engineEnv.HOME);
        hostPolicy.assertSafeCoreDumpPolicy();
        this.assertWorkspaceReady();
        taskFiles?.assertReady();
        checkCancelled();
        // Every task needs the fixed kernel identity reader. Journaled runners
        // also persist this evidence before argv can run.
        hierarchyReader = require('./executorCgroup');
        taskProcess = { pid: initialized.State.Pid, startTime: boundary.receipt.startTime };
        taskCgroup = hierarchyReader.readInitializedTaskCgroup(taskProcess, containerId);
        if (identities) await identities.record({ phase: 'starting', containerId, process: taskProcess, cgroup: taskCgroup });
        checkCancelled();
        child = spawn(this.podmanPath, ['--remote=false', 'start', '--attach', '--interactive', '--detach-keys=', containerId], {
          stdio: ['pipe', 'pipe', 'pipe'], env: engineEnv, shell: false, windowsHide: true
        });
        let output = '';
        const decoder = new StringDecoder('utf8');
        let stderr = '';
        let size = 0;
        closed = new Promise(resolve => {
          child.on('error', error => stop(new ExecutorUnavailableError(error.code === 'ENOENT' ? 'Rootless Podman is unavailable.' : 'Restricted executor failed to start.')));
          child.on('close', code => resolve(code));
        });
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES) {
            stop(new Error('Restricted execution output exceeded 1 MB'));
          } else output += decoder.write(chunk);
        });
        child.stderr.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES) stop(new Error('Restricted execution output exceeded 1 MB'));
          else if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
        });
        child.stdin.on('error', error => stop(error));
        child.stdin.end(input);
        const code = await Promise.race([closed, cancellation]);
        checkCancelled();
        if (code !== 0) throw new Error('Restricted execution failed');
        response = { output: output + decoder.end(), stderr };
      } catch (error) { primary = error; }
      finally {
        const failures = [];
        if (containerId) {
          // Stop the container through the engine before killing its attached
          // client. Wait for the client, then remove again to close state races.
          if (child && !(await closedWithin(closed, 0))) {
            try { await control(['rm', '--force', '--time=0', '--ignore', containerId]); } catch (error) { failures.push(error); }
            if (!(await closedWithin(closed, 1000))) child.kill('SIGKILL');
            if (!(await closedWithin(closed, 1000))) failures.push(new Error('Executor attach process did not close'));
          }
          try {
            await control(['rm', '--force', '--time=0', '--ignore', containerId]);
            let absent = false;
            try { await control(['container', 'exists', containerId]); }
            catch (error) {
              // Podman also exits 1 for some configuration errors. Only a
              // normally exited, silent absence query establishes removal.
              if (error.code === 1 && !error.signal && !error.killed && error.stdout === '' && error.stderr === '') absent = true;
              else throw error;
            }
            if (!absent) throw new Error('Exact task container remains after removal');
            if (taskCgroup) {
              const process = hierarchyReader.observeTaskProcess(taskProcess);
              const hierarchy = hierarchyReader.observeRetainedTaskCgroup(taskCgroup, containerId);
              if (!process.absentOrStopped || !hierarchy.stopped) throw new Error('Task writers remain live or their hierarchy is uncertain');
            }
            if (identities && !failures.length) await identities.record({ phase: 'absent', containerId });
          } catch (error) { failures.push(error); }
          if (failures.length) primary = cleanupUnconfirmed(containerName, containerId, [primary, ...failures]);
        }
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (primary?.code === 'RESTRICTED_CANCELLATION_UNCONFIRMED') quarantinedEngines.add(this.podmanPath);
      }
      if (primary) throw primary;
      // Cleanup and durable receipts may outlast the original deadline or an
      // incoming cancellation. Neither event authorizes returning held output.
      checkCancelled();
      return response;
    }));
  }
}

module.exports = {
  RootlessPodmanExecutor,
  RestrictedTaskFiles,
  ExecutorUnavailableError,
  approvedWorkspace,
  safeEnvironment,
  restrictedPolicy,
  assertNoAutomaticMounts,
  validateOCISpec,
  readOCISpec,
  readInitializedBoundary,
  readInitializedMountIdentity,
  validateInitializedMountIdentity,
  assertOutputStoreMount,
  MAX_OUTPUT_BYTES,
  MAX_TASK_FILE_BYTES,
  MAX_TASK_FILES,
  MAX_OUTPUT_STORE_BYTES,
  MAX_OUTPUT_STORE_INODES
};
