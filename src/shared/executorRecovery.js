'use strict';

// Operator-only pinned control context. Public inspection is read-only; explicit
// stop and release live in their explicit operator modules.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { defaultSupervisorRoot, readBootIdentity } = require('./executorSupervisor');
const { ExecutorUnavailableError } = require('./restrictedExecutor');
const { validateTaskCgroupIdentity, observeTaskProcess: processState } = require('./executorCgroup');
const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-f0-9]{64}$/;
const STATES = new Set(['admitted', 'staged', 'executing', 'stopped', 'review_required']);

function deny(message) { throw new ExecutorUnavailableError(message + '; preserve retained admission'); }
function normalized(value) { return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value); }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function directory(file, expected) {
  if (!normalized(file) || fs.realpathSync(file) !== file) deny('Recovery directory is not canonical');
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) ||
      stat.gid !== BigInt(process.getgid()) || (stat.mode & 0o777n) !== 0o700n ||
      expected && (String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino)) deny('Recovery directory identity is invalid');
  return identity(stat);
}
function readPrivate(file, bound) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) ||
        (stat.mode & 0o777n) !== 0o600n || stat.size < 1n || stat.size > BigInt(bound)) deny('Recovery file identity is invalid');
    const bytes = Buffer.alloc(Number(stat.size) + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd, { bigint: true });
    if (count !== Number(stat.size) || stat.size !== after.size || stat.ctimeNs !== after.ctimeNs || stat.mtimeNs !== after.mtimeNs) deny('Recovery file changed during read');
    return { bytes: bytes.subarray(0, count), ...identity(stat) };
  } finally { fs.closeSync(fd); }
}
function validateReceipt(receipt, root) {
  if (!receipt || receipt.version !== 1 || typeof receipt.taskId !== 'string' || !UUID.test(receipt.taskId) || typeof receipt.leaseId !== 'string' || !UUID.test(receipt.leaseId) ||
      !STATES.has(receipt.state) || receipt.maxConcurrentTasks !== 1 || receipt.maxStagedInputBytes !== 20000000 ||
      receipt.maxInputFiles !== 10) deny('Retained receipt is invalid');
  processState(receipt.ownerProcess);
  if (receipt.bootId !== undefined && (typeof receipt.bootId !== 'string' || !UUID.test(receipt.bootId))) deny('Retained boot identity is invalid');
  if (receipt.directories !== undefined) {
    const dirs = receipt.directories;
    if (!Array.isArray(dirs) || dirs.length !== 3 || dirs.some(d => !d || !normalized(d.path) || !/^[0-9]+$/.test(d.dev) || !/^[1-9][0-9]*$/.test(d.ino)) ||
        path.dirname(dirs[0].path) !== fs.realpathSync(os.tmpdir()) || !/^chatspace-task-files-[a-zA-Z0-9]{6}$/.test(path.basename(dirs[0].path)) ||
        dirs[1].path !== path.join(dirs[0].path, 'inputs') || !/^chatspace-task-outputs-[a-zA-Z0-9]{6}$/.test(path.basename(dirs[2].path))) deny('Retained staging identities are invalid');
  }
  if (receipt.engine !== undefined) {
    const e = receipt.engine;
    if (!e || !['creating', 'created', 'starting', 'absent'].includes(e.phase) ||
        typeof e.containerName !== 'string' || !e.containerName.startsWith('chatspace-task-') || !UUID.test(e.containerName.slice('chatspace-task-'.length)) ||
        typeof e.image !== 'string' || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(e.image) ||
        !normalized(e.configuration?.path) || !/^[0-9]+$/.test(e.configuration.dev) || !/^[1-9][0-9]*$/.test(e.configuration.ino) ||
        path.dirname(e.configuration.path) !== fs.realpathSync(os.tmpdir()) || !/^chatspace-engine-config-[a-zA-Z0-9]{6}$/.test(path.basename(e.configuration.path))) deny('Retained engine identity is invalid');
    if (e.phase !== 'creating' && (typeof e.containerId !== 'string' || !ID.test(e.containerId) || e.cidFile?.path !== path.join(root, 'active', 'container.cid') ||
        !/^[0-9]+$/.test(e.cidFile.dev) || !/^[1-9][0-9]*$/.test(e.cidFile.ino))) deny('Retained exact container identity is incomplete');
    if (e.phase === 'starting') processState(e.process);
    if (e.cgroup !== undefined) validateTaskCgroupIdentity(e.cgroup, e.containerId);
  }
}

async function withExecutorRecovery({ root = defaultSupervisorRoot(), podmanPath = '/usr/bin/podman' } = {}, handler) {
  if (process.platform !== 'linux' || process.getuid() === 0 || !fs.constants.O_NOFOLLOW) deny('Ordinary Linux executor account required');
  const rootIdentity = directory(root), rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let activeFd, configRoot, runEngine, archivedAdmission;
  try {
    if (JSON.stringify(identity(fs.fstatSync(rootFd, { bigint: true }))) !== JSON.stringify(rootIdentity)) deny('Recovery root changed');
    const activePath = path.join(root, 'active'), activeIdentity = directory(activePath);
    activeFd = fs.openSync('/proc/self/fd/' + rootFd + '/active', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (JSON.stringify(identity(fs.fstatSync(activeFd, { bigint: true }))) !== JSON.stringify(activeIdentity)) deny('Recovery admission changed');
    const anchor = '/proc/self/fd/' + activeFd;
    const saved = readPrivate(anchor + '/receipt.json', 8192), receipt = JSON.parse(saved.bytes.toString());
    validateReceipt(receipt, root);
    const report = { version: 1, mode: 'review_only', taskId: receipt.taskId, leaseId: receipt.leaseId,
      receiptSha256: createHash('sha256').update(saved.bytes).digest('hex'), state: receipt.state,
      rootIdentity, activeIdentity, ownerProcess: processState(receipt.ownerProcess),
      container: null, directories: [], blockers: [], admissionCleared: false };
    const bootId = readBootIdentity();
    report.boot = { recorded: receipt.bootId || null, current: bootId, same: receipt.bootId ? receipt.bootId === bootId : null };
    if (report.boot.same !== true) report.blockers.push(receipt.bootId ?
      'Kernel boot changed; volatile path and process identities require independent recovery review' :
      'Legacy receipt has no boot identity; automatic recovery is unavailable');
    for (const item of receipt.directories || []) {
      const selected = { path: item.path, dev: item.dev, ino: item.ino };
      try { directory(item.path, item); report.directories.push({ ...selected, unchanged: true }); }
      catch (error) { report.directories.push({ ...selected, unchanged: false }); report.blockers.push('Staged directory is missing, changed or unsafe'); }
    }
    if (!report.ownerProcess.absentOrStopped) report.blockers.push('Original runner is still alive');
    const unknownFiles = fs.readdirSync(anchor).filter(n => !['receipt.json', 'container.cid'].includes(n));
    if (unknownFiles.length) report.blockers.push('Admission contains unreviewed files');
    const e = receipt.engine;
    if (!e || e.phase === 'creating') report.blockers.push('No completed exact engine identity; late create or partial staging requires manual review');
    else {
      const selected = { path: e.configuration.path, dev: e.configuration.dev, ino: e.configuration.ino };
      try { directory(e.configuration.path, e.configuration); report.configuration = { ...selected, unchanged: true }; }
      catch (_) { report.configuration = { ...selected, unchanged: false }; report.blockers.push('Retained engine configuration is missing, changed or unsafe'); }
      if (fs.readdirSync(anchor).includes('container.cid')) {
        const cid = readPrivate(anchor + '/container.cid', 65);
        if (cid.dev !== e.cidFile.dev || cid.ino !== e.cidFile.ino || cid.bytes.toString().trim() !== e.containerId || !/^[a-f0-9]{64}\n?$/.test(cid.bytes.toString())) deny('Retained CID changed');
      }
      if (!normalized(podmanPath)) deny('Recovery engine must use an explicit absolute path');
      const binary = fs.lstatSync(podmanPath);
      if (!binary.isFile() || binary.isSymbolicLink() || ![0, process.getuid()].includes(binary.uid) || binary.mode & 0o022 || !(binary.mode & 0o111)) deny('Recovery engine path is unsafe');
      // Use new controlled settings, never execute the receipt's engine path or
      // trust a retained configuration that may be the cause of the failure.
      configRoot = fs.mkdtempSync('/proc/self/fd/' + rootFd + '/.recovery-review-');
      fs.chmodSync(configRoot, 0o700);
      const config = path.join(configRoot, 'containers.conf');
      const engineConfigRoot = path.join(root, path.basename(configRoot));
      fs.mkdirSync(path.join(configRoot, 'hooks'), { mode: 0o700 });
      fs.writeFileSync(config, '[containers]\nmounts = []\nvolumes = []\nenv = []\nenv_host = false\n[engine]\nremote = false\nhooks_dir = [' + JSON.stringify(path.join(engineConfigRoot, 'hooks')) + ']\n', { mode: 0o600, flag: 'wx' });
      const configIdentity = identity(fs.statSync(configRoot, { bigint: true }));
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        // Podman's rootless namespace cannot traverse the caller's proc handles.
        // Control settings use a private canonical path; cleanup stays fd-bound.
        CONTAINERS_CONF: path.join(engineConfigRoot, 'containers.conf') };
      const run = args => {
        directory(root, rootIdentity); directory(engineConfigRoot, configIdentity);
        return execute(podmanPath, ['--remote=false', ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 });
      };
      runEngine = run;
      let absent = false;
      try { await run(['container', 'exists', e.containerId]); }
      catch (error) {
        if (error.code === 1 && !error.signal && !error.killed && error.stdout === '' && error.stderr === '') absent = true;
        else deny('Exact container query is uncertain');
      }
      report.container = { id: e.containerId, name: e.containerName, exactAbsence: absent, identityMatched: false };
      if (!absent) {
        const inspection = JSON.parse((await run(['container', 'inspect', '--format', '{{json .}}', e.containerId])).stdout);
        if (inspection.Id !== e.containerId || inspection.Name !== e.containerName || inspection.ImageName !== e.image ||
            inspection.Config?.Labels?.['chatspace.task'] !== receipt.taskId || inspection.Config?.Labels?.['chatspace.lease'] !== receipt.leaseId) deny('Container is not bound to the retained task and lease');
        report.container.identityMatched = true;
        report.container.status = inspection.State?.Status;
        report.blockers.push('Exact task container still exists; review is not cleanup permission');
      }
      if (e.process) {
        report.container.process = processState(e.process);
        if (!report.container.process.absentOrStopped) report.blockers.push('Initialized task process is still alive');
      }
      if (e.cgroup) report.container.cgroup = validateTaskCgroupIdentity(e.cgroup, e.containerId);
      else if (e.process) report.blockers.push('Legacy engine receipt has no exact task cgroup identity');
      // A single absence observation is not a descendant/late-start proof.
      report.blockers.push('Operator stoppage, descendant/late-start proof and staged cleanup remain required');
    }
    const assertStable = () => {
      directory(root, rootIdentity);
      if (archivedAdmission) {
        const stat = fs.lstatSync(archivedAdmission, { bigint: true });
        if (!stat.isDirectory() || String(stat.dev) !== activeIdentity.dev || String(stat.ino) !== activeIdentity.ino) deny('Archived admission changed');
      } else directory(activePath, activeIdentity);
      if (readBootIdentity() !== bootId || !saved.bytes.equals(readPrivate(anchor + '/receipt.json', 8192).bytes)) deny('Retained receipt changed during review');
    };
    assertStable();
    const archiveAdmission = destinationFd => {
      assertStable();
      if (archivedAdmission) deny('Admission was already archived');
      const destination = fs.fstatSync(destinationFd, { bigint: true });
      if (!destination.isDirectory() || String(destination.dev) !== rootIdentity.dev ||
          destination.uid !== BigInt(process.getuid()) || destination.gid !== BigInt(process.getgid()) ||
          (destination.mode & 0o777n) !== 0o700n) deny('Admission archive is unsafe');
      const archivePath = fs.realpathSync('/proc/self/fd/' + destinationFd);
      if (path.dirname(archivePath) !== path.join(root, 'recovery') || !UUID.test(path.basename(archivePath))) deny('Admission must remain in its private operator audit');
      const target = '/proc/self/fd/' + destinationFd + '/admission';
      try { fs.lstatSync(target); deny('Admission archive already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Preserve the original receipt/CID atomically. The intent and ready
      // records have already been fsynced by the explicit release operation.
      fs.renameSync('/proc/self/fd/' + rootFd + '/active', target);
      archivedAdmission = path.join(archivePath, 'admission');
      fs.fsyncSync(destinationFd); fs.fsyncSync(rootFd);
      assertStable();
    };
    const result = handler ? await handler({ report, receipt, rootFd, activeFd, run: runEngine, assertStable, archiveAdmission, admissionArchived: () => !!archivedAdmission }) : report;
    assertStable();
    return result;
  } finally {
    // Only fresh operator control settings; retained engine/stage paths untouched.
    try { if (configRoot) fs.rmSync(configRoot, { recursive: true }); }
    finally { if (activeFd !== undefined) fs.closeSync(activeFd); fs.closeSync(rootFd); }
  }
}

function reviewExecutorRecovery(options) { return withExecutorRecovery(options); }
module.exports = { reviewExecutorRecovery, withExecutorRecovery, processState };
