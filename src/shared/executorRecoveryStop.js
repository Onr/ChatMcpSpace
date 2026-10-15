'use strict';

// An explicit operator stop. It leaves the original receipt, all staged files,
// configuration and admission intact, including when cleanup is uncertain.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { withExecutorRecovery, processState } = require('./executorRecovery');
const { observeRetainedTaskCgroup, readInitializedTaskCgroup } = require('./executorCgroup');
const { ExecutorUnavailableError } = require('./restrictedExecutor');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deny(message) { throw new ExecutorUnavailableError(message + '; preserve admission and retained files'); }

async function operatorLock(rootFd) {
  const binary = fs.lstatSync('/usr/bin/flock');
  if (!binary.isFile() || binary.isSymbolicLink() || binary.uid !== 0 || binary.mode & 0o022 || !(binary.mode & 0o111)) deny('Trusted operator lock is unavailable');
  const file = '/proc/self/fd/' + rootFd + '/.operator.lock';
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o600n || stat.dev !== named.dev || stat.ino !== named.ino) deny('Operator lock identity is unsafe');
    await new Promise((resolve, reject) => {
      // The inherited descriptor shares the parent's open file description.
      // The kernel keeps the lock after flock exits until this descriptor closes.
      const child = spawn('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); code === 0 && !signal ? resolve() : reject(new ExecutorUnavailableError('Another operator or an uncertain lock prevents recovery')); });
    });
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function auditDirectory(rootFd) {
  const parent = '/proc/self/fd/' + rootFd + '/recovery';
  try { fs.mkdirSync(parent, { mode: 0o700 }); fs.fsyncSync(rootFd); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.uid !== BigInt(process.getuid()) || stat.gid !== BigInt(process.getgid()) || (stat.mode & 0o777n) !== 0o700n) deny('Operator audit directory is unsafe');
    const id = randomUUID(), anchored = '/proc/self/fd/' + fd + '/' + id;
    fs.mkdirSync(anchored, { mode: 0o700 }); fs.fsyncSync(fd);
    const auditFd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    return { id, fd: auditFd };
  } finally { fs.closeSync(fd); }
}
function writeAudit(fd, name, value) {
  const file = fs.openSync('/proc/self/fd/' + fd + '/' + name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(file, JSON.stringify(value) + '\n'); fs.fsyncSync(file); } finally { fs.closeSync(file); }
  fs.fsyncSync(fd);
}

async function stopExecutorRecovery({ receiptSha256, ...options } = {}) {
  if (typeof receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receiptSha256)) deny('Reviewed receipt SHA-256 is required');
  return withExecutorRecovery(options, async context => {
    const { report, receipt, rootFd, run, assertStable } = context;
    const expected = receipt.engine;
    if (report.receiptSha256 !== receiptSha256) deny('Reviewed receipt changed');
    if (report.boot.same !== true || !report.ownerProcess.absentOrStopped) deny('Original runner must be stopped on the recorded kernel boot');
    if (!['executing', 'review_required', 'stopped'].includes(receipt.state) ||
        !expected?.process || !expected.cgroup || !['starting', 'absent'].includes(expected.phase) || !run) deny('Complete process hierarchy receipt is required');
    const permitted = new Set(['Exact task container still exists; review is not cleanup permission',
      'Initialized task process is still alive', 'Operator stoppage, descendant/late-start proof and staged cleanup remain required']);
    if (report.blockers.some(blocker => !permitted.has(blocker))) deny('Retained identity review has unresolved blockers');
    const lock = await operatorLock(rootFd);
    let audit, step = 'preconditions';
    try {
      assertStable();
      if (!processState(receipt.ownerProcess).absentOrStopped) deny('Original runner became live');
      const before = observeRetainedTaskCgroup(expected.cgroup, expected.containerId);
      if (!report.container.exactAbsence) {
        const item = JSON.parse((await run(['container', 'inspect', '--format', '{{json .}}', expected.containerId])).stdout);
        if (item.Id !== expected.containerId || item.Name !== expected.containerName || item.ImageName !== expected.image ||
            item.Config?.Labels?.['chatspace.task'] !== receipt.taskId || item.Config?.Labels?.['chatspace.lease'] !== receipt.leaseId ||
            !Number.isSafeInteger(item.State?.Pid) || item.State.Pid < 0 || typeof item.State.Running !== 'boolean' ||
            !['initialized', 'running', 'paused', 'exited', 'stopped'].includes(item.State.Status) ||
            item.State.Pid !== 0 && item.State.Pid !== expected.process.pid || item.State.Running && item.State.Pid <= 1) deny('Current exact container identity changed');
      }
      if (!processState(expected.process).absentOrStopped &&
          JSON.stringify(readInitializedTaskCgroup(expected.process, expected.containerId)) !== JSON.stringify(report.container.cgroup)) deny('Current task process left its recorded cgroup');
      assertStable();
      audit = auditDirectory(rootFd);
      writeAudit(audit.fd, 'intent.json', { version: 1, operation: 'stop_only', id: audit.id,
        at: new Date().toISOString(), taskId: report.taskId, leaseId: report.leaseId, receiptSha256,
        boot: report.boot, rootIdentity: report.rootIdentity, activeIdentity: report.activeIdentity,
        containerId: expected.containerId, containerName: expected.containerName,
        process: { pid: expected.process.pid, startTime: expected.process.startTime }, cgroup: report.container.cgroup,
        before, admissionCleared: false });
      step = 'exact_removal';
      if (!report.container.exactAbsence) {
        assertStable();
        await run(['rm', '--force', '--time=0', '--ignore', expected.containerId]);
      }
      step = 'stoppage_proof';
      const observations = [];
      for (let i = 0; i < 5; i++) {
        assertStable();
        let absent = false;
        try { await run(['container', 'exists', expected.containerId]); }
        catch (error) { if (error.code === 1 && !error.signal && !error.killed && error.stdout === '' && error.stderr === '') absent = true; else deny('Exact absence query is uncertain'); }
        if (!absent) deny('Exact task container remains present');
        const process = processState(expected.process), hierarchy = observeRetainedTaskCgroup(expected.cgroup, expected.containerId);
        if (!process.absentOrStopped || !hierarchy.stopped) deny('Task process hierarchy remains live or uncertain');
        observations.push({ at: new Date().toISOString(), exactAbsence: true, process, hierarchy });
        if (i < 4) await sleep(500);
      }
      assertStable();
      const result = { version: 1, mode: 'stop_only', taskId: report.taskId, leaseId: report.leaseId,
        receiptSha256, operationId: audit.id, containerId: expected.containerId, stopConfirmed: true,
        observations, admissionCleared: false, blockers: ['Staging cleanup and admission release remain required'] };
      writeAudit(audit.fd, 'result.json', result);
      return result;
    } catch (error) {
      if (audit) {
        try { writeAudit(audit.fd, 'uncertain.json', { version: 1, status: 'uncertain', step, containerId: expected.containerId, admissionCleared: false }); }
        catch (_) { /* Original intent and admission remain even if disk is full. */ }
      }
      throw error;
    } finally {
      if (audit) fs.closeSync(audit.fd);
      fs.closeSync(lock);
    }
  });
}

module.exports = { stopExecutorRecovery, operatorLock, auditDirectory, writeAudit };
