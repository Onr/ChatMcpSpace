'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { ExecutorUnavailableError } = require('./restrictedExecutor');
const { validateTaskCgroupIdentity } = require('./executorCgroup');
const STATES = new Set(['admitted', 'staged', 'executing', 'stopped', 'review_required']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultSupervisorRoot() {
  return path.join(os.homedir(), '.local', 'state', 'AgentsMCPspace', 'restricted-executor');
}

function privateDirectory(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) ||
      stat.gid !== BigInt(process.getgid()) || (stat.mode & 0o777n) !== 0o700n || fs.realpathSync(file) !== file) {
    throw new ExecutorUnavailableError('Executor supervisor storage must be a private owned directory');
  }
  return stat;
}

function sameDirectory(file, expected) {
  const current = privateDirectory(file);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new ExecutorUnavailableError('Executor supervisor directory identity changed; preserve it for review');
}

function ownerProcess() {
  const fd = fs.openSync('/proc/self/stat', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(4096), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, count).toString(), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (count === bytes.length || !text.startsWith(process.pid + ' (') || !/^[1-9][0-9]*$/.test(fields[19])) throw new ExecutorUnavailableError('Supervisor process identity is unavailable');
    return { pid: process.pid, startTime: fields[19] };
  } finally { fs.closeSync(fd); }
}

function readBootIdentity() {
  const fd = fs.openSync('/proc/sys/kernel/random/boot_id', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(38), count = fs.readSync(fd, bytes, 0, bytes.length, 0), value = bytes.subarray(0, count).toString();
    if (count !== 37 || !value.endsWith('\n') || !UUID.test(value.trim())) throw new ExecutorUnavailableError('Kernel boot identity is unavailable');
    return value.trim();
  } finally { fs.closeSync(fd); }
}

class ExecutionSupervisor {
  constructor({ root = defaultSupervisorRoot() } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) throw new TypeError('Supervisor root must be an absolute normalized path');
    this.root = root;
  }

  acquire(taskId) {
    if (!UUID.test(taskId)) throw new TypeError('Supervisor task identity must be a UUID');
    if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) throw new ExecutorUnavailableError('Durable executor admission is unavailable');
    const bootId = readBootIdentity();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const rootStat = privateDirectory(this.root);
    const rootFd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let leaseFd;
    try {
      const pinned = fs.fstatSync(rootFd, { bigint: true });
      if (pinned.dev !== rootStat.dev || pinned.ino !== rootStat.ino) throw new ExecutorUnavailableError('Supervisor root changed while opening');
      const anchored = `/proc/self/fd/${rootFd}/active`;
      try { fs.mkdirSync(anchored, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw new ExecutorUnavailableError('Another restricted task or retained execution requires supervisor review');
        throw error;
      }
      fs.fsyncSync(rootFd);
      const leasePath = path.join(this.root, 'active'), leaseStat = privateDirectory(leasePath);
      leaseFd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const actual = fs.fstatSync(leaseFd, { bigint: true });
      if (actual.dev !== leaseStat.dev || actual.ino !== leaseStat.ino) throw new ExecutorUnavailableError('Admission directory changed while opening');
      const lease = new ExecutionLease({ root: this.root, rootFd, rootStat, leasePath, leaseFd, leaseStat, taskId, bootId });
      lease.write();
      return lease;
    } catch (error) {
      // Never expire or remove a partial admission after an uncertain failure.
      if (leaseFd !== undefined) fs.closeSync(leaseFd);
      fs.closeSync(rootFd);
      throw error;
    }
  }
}

class ExecutionLease {
  constructor(fields) {
    Object.assign(this, fields);
    this.receipt = { version: 1, bootId: fields.bootId, leaseId: randomUUID(), taskId: fields.taskId, state: 'admitted',
      ownerProcess: ownerProcess(), admittedAt: new Date().toISOString(), maxConcurrentTasks: 1, maxStagedInputBytes: 20000000, maxInputFiles: 10 };
    this.closed = false;
  }

  assertIdentity() {
    if (this.closed) throw new ExecutorUnavailableError('Execution admission is closed');
    sameDirectory(this.root, this.rootStat);
    sameDirectory(this.leasePath, this.leaseStat);
  }

  write() {
    this.assertIdentity();
    if (!STATES.has(this.receipt.state)) throw new TypeError('Invalid supervisor state');
    const anchor = `/proc/self/fd/${this.leaseFd}`;
    const temporary = path.join(anchor, '.receipt-' + randomUUID());
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.receipt) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(anchor, 'receipt.json'));
    fs.fsyncSync(this.leaseFd);
  }

  staged(files) {
    if (this.receipt.state !== 'admitted') throw new ExecutorUnavailableError('Task staging admission was already used');
    const directories = [files.root, files.inputRoot, files.outputRoot].map(file => {
      const stat = privateDirectory(file);
      return { path: file, dev: String(stat.dev), ino: String(stat.ino) };
    });
    this.receipt = { ...this.receipt, state: 'staged', directories };
    this.write();
  }

  start() {
    if (this.receipt.state !== 'staged') throw new ExecutorUnavailableError('Restricted task has no durable staging receipt');
    this.receipt.state = 'executing'; this.write();
  }

  journal() {
    this.assertIdentity();
    if (this.receipt.state !== 'executing' || this.receipt.engine) throw new ExecutorUnavailableError('Engine admission was already used');
    return { taskId: this.taskId, leaseId: this.receipt.leaseId, cidFile: path.join(this.leasePath, 'container.cid'),
      record: event => this.recordEngine(event) };
  }

  recordEngine(event) {
    this.assertIdentity();
    if (this.receipt.state !== 'executing') throw new ExecutorUnavailableError('Engine admission is not executing');
    const previous = this.receipt.engine;
    const deny = () => { throw new ExecutorUnavailableError('Invalid or changed engine lifecycle identity; retain admission'); };
    if (!event || typeof event !== 'object') deny();
    if (event.phase === 'creating') {
      const directory = event.configuration;
      if (previous || !/^chatspace-task-[a-f0-9-]{36}$/.test(event.containerName) ||
          typeof event.image !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(event.image) ||
          typeof event.podmanPath !== 'string' || !event.podmanPath || event.podmanPath.length > 4096 || /[\0\r\n]/.test(event.podmanPath) ||
          !directory || typeof directory.path !== 'string' || !path.isAbsolute(directory.path)) deny();
      const stat = privateDirectory(directory.path);
      if (String(stat.dev) !== directory.dev || String(stat.ino) !== directory.ino) deny();
      this.receipt.engine = { phase: 'creating', containerName: event.containerName, image: event.image,
        podmanPath: event.podmanPath, configuration: { path: directory.path, dev: directory.dev, ino: directory.ino } };
    } else {
      if (!previous || !/^[a-f0-9]{64}$/.test(event.containerId) || previous.containerId && previous.containerId !== event.containerId) deny();
      if (event.phase === 'created') {
        if (previous.phase !== 'creating' || event.cidFile?.path !== path.join(this.leasePath, 'container.cid')) deny();
        const stat = fs.lstatSync(event.cidFile.path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) ||
            (stat.mode & 0o777n) !== 0o600n || event.cidFile.dev !== String(stat.dev) || event.cidFile.ino !== String(stat.ino)) deny();
        this.receipt.engine = { ...previous, phase: 'created', containerId: event.containerId,
          cidFile: { path: event.cidFile.path, dev: event.cidFile.dev, ino: event.cidFile.ino } };
      } else if (event.phase === 'starting') {
        if (previous.phase !== 'created' || !Number.isSafeInteger(event.process?.pid) || event.process.pid <= 1 ||
            typeof event.process.startTime !== 'string' || !/^[1-9][0-9]*$/.test(event.process.startTime)) deny();
        const cgroup = validateTaskCgroupIdentity(event.cgroup, event.containerId);
        this.receipt.engine = { ...previous, phase: 'starting', process: { pid: event.process.pid, startTime: event.process.startTime }, cgroup };
      } else if (event.phase === 'absent') {
        if (!['created', 'starting'].includes(previous.phase)) deny();
        this.receipt.engine = { ...previous, phase: 'absent' };
      } else deny();
    }
    this.write();
    if (event.phase === 'absent') this.confirmedEngineAbsence = true;
  }

  stopped() {
    if (!['admitted', 'staged', 'executing'].includes(this.receipt.state)) throw new ExecutorUnavailableError('Retained execution needs explicit supervisor recovery');
    if (this.receipt.engine && this.receipt.engine.phase !== 'absent') throw new ExecutorUnavailableError('Exact engine absence has not been confirmed');
    this.receipt.state = 'stopped'; this.write();
  }

  retain() {
    this.receipt.state = 'review_required';
    try { this.write(); } finally { this.close(); }
  }

  release() {
    this.assertIdentity();
    if (this.receipt.state !== 'stopped') throw new ExecutorUnavailableError('Execution stoppage has not been confirmed');
    const anchor = `/proc/self/fd/${this.leaseFd}`;
    const entries = fs.readdirSync(anchor);
    const cid = this.receipt.engine?.cidFile;
    // Podman removes its cidfile with the container. Its missing file is never
    // absence proof; only our earlier exact engine query records that proof.
    const hasCid = entries.includes('container.cid');
    if (cid && !hasCid && !this.confirmedEngineAbsence) throw new ExecutorUnavailableError('Missing engine identity is not cleanup proof');
    const expected = cid && hasCid ? ['container.cid', 'receipt.json'] : ['receipt.json'];
    if (entries.length !== expected.length || entries.sort().some((item, index) => item !== expected[index])) throw new ExecutorUnavailableError('Supervisor admission contains unreviewed files');
    const fd = fs.openSync(path.join(anchor, 'receipt.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new ExecutorUnavailableError('Supervisor receipt identity is invalid');
      const bytes = Buffer.alloc(stat.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const current = JSON.parse(bytes.subarray(0, count).toString());
      if (count !== stat.size || JSON.stringify(current) !== JSON.stringify(this.receipt) || current.state !== 'stopped') throw new ExecutorUnavailableError('Supervisor receipt changed; preserve it for review');
    } finally { fs.closeSync(fd); }
    if (cid && hasCid) {
      const file = path.join(anchor, 'container.cid'), descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(descriptor, { bigint: true }), bytes = Buffer.alloc(66);
        const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0), value = bytes.subarray(0, count).toString();
        if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== cid.dev || String(stat.ino) !== cid.ino ||
            stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o600n || count !== Number(stat.size) ||
            !/^[a-f0-9]{64}\n?$/.test(value) || value.trim() !== this.receipt.engine.containerId) throw new ExecutorUnavailableError('Engine identity receipt changed; retain admission');
      } finally { fs.closeSync(descriptor); }
      fs.unlinkSync(file);
    }
    fs.unlinkSync(path.join(anchor, 'receipt.json'));
    fs.fsyncSync(this.leaseFd);
    fs.rmdirSync(`/proc/self/fd/${this.rootFd}/active`);
    fs.fsyncSync(this.rootFd);
    this.close();
  }

  close() {
    if (this.closed) return;
    fs.closeSync(this.leaseFd); fs.closeSync(this.rootFd); this.closed = true;
  }
}

module.exports = { ExecutionSupervisor, defaultSupervisorRoot, readBootIdentity };
