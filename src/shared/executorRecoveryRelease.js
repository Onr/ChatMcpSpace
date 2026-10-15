'use strict';

const fs = require('fs');
const path = require('path');
const { withExecutorRecovery, processState } = require('./executorRecovery');
const { operatorLock, auditDirectory, writeAudit } = require('./executorRecoveryStop');
const { observeRetainedTaskCgroup } = require('./executorCgroup');
const { ExecutorUnavailableError } = require('./restrictedExecutor');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deny(message) { throw new ExecutorUnavailableError(message + '; preserve admission and operator audits'); }
function same(stat, value) { return String(stat.dev) === value.dev && String(stat.ino) === value.ino; }
function privateFd(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || stat.gid !== BigInt(process.getgid()) || (stat.mode & 0o777n) !== 0o700n) {
    fs.closeSync(fd); deny('Operator audit directory is unsafe');
  }
  return fd;
}
function readAudit(fd, name) {
  const file = fs.openSync('/proc/self/fd/' + fd + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o600n || stat.size < 1n || stat.size > 65536n) deny('Operator audit file is unsafe');
    const bytes = Buffer.alloc(Number(stat.size) + 1), count = fs.readSync(file, bytes, 0, bytes.length, 0), after = fs.fstatSync(file, { bigint: true });
    if (count !== Number(stat.size) || stat.size !== after.size || stat.ctimeNs !== after.ctimeNs || stat.mtimeNs !== after.mtimeNs) deny('Operator audit changed');
    return JSON.parse(bytes.subarray(0, count).toString());
  } finally { fs.closeSync(file); }
}
function verifyStopAudit(rootFd, operation, report) {
  const parent = privateFd('/proc/self/fd/' + rootFd + '/recovery');
  let fd;
  try {
    fd = privateFd('/proc/self/fd/' + parent + '/' + operation);
    const intent = readAudit(fd, 'intent.json'), result = readAudit(fd, 'result.json');
    const binding = record => record.version === 1 && record.taskId === report.taskId && record.leaseId === report.leaseId &&
      record.receiptSha256 === report.receiptSha256 && record.containerId === report.container.id && record.admissionCleared === false;
    if (!binding(intent) || !binding(result) || intent.operation !== 'stop_only' || intent.id !== operation || result.mode !== 'stop_only' ||
        result.operationId !== operation || result.stopConfirmed !== true || !Array.isArray(result.observations) || result.observations.length !== 5 ||
        intent.boot?.recorded !== report.boot.recorded || intent.boot?.current !== report.boot.current || intent.boot?.same !== true ||
        JSON.stringify(intent.rootIdentity) !== JSON.stringify(report.rootIdentity) || JSON.stringify(intent.activeIdentity) !== JSON.stringify(report.activeIdentity)) deny('Stop audit is not bound to this retained admission');
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(parent); }
}

// A bounded no-follow inventory. Never read task file contents, follow links,
// traverse another filesystem, or delegate cleanup to recursive path-based rm.
function pinTree(expected, { nodes, bytes, depth = 16 }, keptChildren = []) {
  const handles = [], records = [], kept = new Set(keptChildren);
  let nodeCount = 0, byteCount = 0;
  const snapshot = stat => ({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    size: String(stat.size), nlink: String(stat.nlink), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
  const visit = (file, relative, level, parentFd, name) => {
    if (++nodeCount > nodes || level > depth) deny('Staging inventory exceeds its bounded cleanup budget');
    const before = fs.lstatSync(file, { bigint: true });
    if (String(before.dev) !== expected.dev || before.uid !== BigInt(process.getuid())) deny('Staging contains foreign ownership or a mount');
    if (before.isDirectory()) {
      if (before.mode & 0o022n) deny('Staging directory permits untrusted writers');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(fd);
      if (!same(fs.fstatSync(fd, { bigint: true }), snapshot(before))) deny('Staging directory changed while pinning');
      const anchor = '/proc/self/fd/' + fd, children = fs.readdirSync(anchor).sort();
      const entry = { fd, parentFd, name, file, relative, identity: snapshot(before), children, directory: true, keep: relative === '' || kept.has(relative) };
      for (const child of children) visit(anchor + '/' + child, relative ? relative + '/' + child : child, level + 1, fd, child);
      records.push(entry);
    } else {
      if ((!before.isFile() && !before.isSymbolicLink() && !before.isFIFO() && !before.isSocket()) || before.nlink !== 1n) deny('Staging contains an unreviewed special or linked file');
      byteCount += Number(before.size);
      if (!Number.isSafeInteger(byteCount) || byteCount > bytes) deny('Staging exceeds its byte budget');
      records.push({ parentFd, name, file, relative, identity: snapshot(before), directory: false });
    }
  };
  try {
    const before = fs.lstatSync(expected.path, { bigint: true });
    if (!same(before, expected) || !before.isDirectory() || before.isSymbolicLink() || fs.realpathSync(expected.path) !== expected.path ||
        before.uid !== BigInt(process.getuid()) || before.gid !== BigInt(process.getgid()) || (before.mode & 0o777n) !== 0o700n) deny('Retained staging root changed');
    const parentPath = path.dirname(expected.path);
    if (fs.realpathSync(parentPath) !== parentPath) deny('Staging parent changed');
    const parentFd = fs.openSync(parentPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(parentFd);
    const parentIdentity = snapshot(fs.fstatSync(parentFd, { bigint: true }));
    visit('/proc/self/fd/' + parentFd + '/' + path.basename(expected.path), '', 0, parentFd, path.basename(expected.path));
    const verify = () => {
      if (!same(fs.lstatSync(parentPath, { bigint: true }), parentIdentity) || !same(fs.lstatSync(expected.path, { bigint: true }), expected)) deny('Retained staging root was replaced');
      for (const item of records) {
        const current = fs.lstatSync(item.file, { bigint: true });
        if (JSON.stringify(snapshot(current)) !== JSON.stringify(item.identity) || item.directory &&
            JSON.stringify(fs.readdirSync('/proc/self/fd/' + item.fd).sort()) !== JSON.stringify(item.children)) deny('Staging inventory changed');
      }
    };
    verify();
    return { records, nodes: nodeCount, bytes: byteCount, verify,
      purge() {
        verify();
        for (const item of records) {
          if (item.keep) continue;
          const current = fs.lstatSync(item.file, { bigint: true });
          if (!same(current, item.identity)) deny('Staging entry changed during disposal');
          if (item.directory) fs.rmdirSync(item.file); else fs.unlinkSync(item.file);
          fs.fsyncSync(item.parentFd);
        }
        for (const item of records.filter(item => item.keep)) {
          const allowed = records.filter(child => child.keep && child.parentFd === item.fd).map(child => child.name).sort();
          if (JSON.stringify(fs.readdirSync('/proc/self/fd/' + item.fd).sort()) !== JSON.stringify(allowed)) deny('Staging was not emptied');
          fs.fsyncSync(item.fd);
        }
      },
      removeEmptyRoots() {
        for (const item of records.filter(item => item.keep)) {
          if (!same(fs.lstatSync(item.file, { bigint: true }), item.identity)) deny('Empty staging root changed');
          fs.rmdirSync(item.file); fs.fsyncSync(item.parentFd);
        }
      },
      close() { for (const fd of handles) fs.closeSync(fd); }
    };
  } catch (error) { for (const fd of handles) fs.closeSync(fd); throw error; }
}

async function releaseExecutorRecovery({ receiptSha256, stopOperation, discardTaskFiles, ...options } = {}) {
  if (!/^[a-f0-9]{64}$/.test(receiptSha256 || '') || !UUID.test(stopOperation || '') || discardTaskFiles !== true) deny('Reviewed receipt, stop operation and explicit task-file discard are required');
  return withExecutorRecovery(options, async context => {
    const { report, receipt, rootFd, run, assertStable, archiveAdmission } = context;
    if (report.receiptSha256 !== receiptSha256 || report.boot.same !== true || !report.ownerProcess.absentOrStopped ||
        !receipt.engine?.process || !receipt.engine.cgroup || !report.container?.exactAbsence || !run || receipt.directories?.length !== 3 ||
        report.blockers.some(b => b !== 'Operator stoppage, descendant/late-start proof and staged cleanup remain required')) deny('Recovery release has unresolved identity or stoppage blockers');
    const lock = await operatorLock(rootFd), trees = [];
    let audit, committed = false, step = 'preconditions';
    try {
      assertStable(); verifyStopAudit(rootFd, stopOperation, report);
      const observations = [];
      for (let i = 0; i < 5; i++) {
        assertStable();
        let absent = false;
        try { await run(['container', 'exists', receipt.engine.containerId]); }
        catch (error) { if (error.code === 1 && !error.signal && !error.killed && error.stdout === '' && error.stderr === '') absent = true; else deny('Exact absence query is uncertain'); }
        const owner = processState(receipt.ownerProcess), process = processState(receipt.engine.process), hierarchy = observeRetainedTaskCgroup(receipt.engine.cgroup, receipt.engine.containerId);
        if (!absent || !owner.absentOrStopped || !process.absentOrStopped || !hierarchy.stopped) deny('Original task or writer hierarchy is not stopped');
        observations.push({ at: new Date().toISOString(), exactAbsence: true, process, hierarchy });
        if (i < 4) await sleep(500);
      }
      const [stage, input, output] = receipt.directories;
      const roots = [stage, output, receipt.engine.configuration];
      if (roots.some((a, i) => roots.some((b, j) => i !== j && (a.path === b.path || a.path.startsWith(b.path + '/'))))) deny('Staging roots overlap');
      if (JSON.stringify(fs.readdirSync(stage.path)) !== JSON.stringify(['inputs']) ||
          fs.readdirSync(receipt.engine.configuration.path).some(n => !['containers.conf', 'hooks'].includes(n))) deny('Unexpected staging or engine configuration entries');
      trees.push(pinTree(stage, { nodes: 12, bytes: 20000000 }, ['inputs']));
      trees.push(pinTree(output, { nodes: 256, bytes: 24 * 1024 * 1024 }));
      trees.push(pinTree(receipt.engine.configuration, { nodes: 4, bytes: 65536 }, ['hooks']));
      const pinnedInput = trees[0].records.find(r => r.relative === 'inputs');
      if (!pinnedInput || !same(fs.fstatSync(pinnedInput.fd, { bigint: true }), input)) deny('Input staging identity changed');
      assertStable();
      audit = auditDirectory(rootFd);
      writeAudit(audit.fd, 'intent.json', { version: 1, operation: 'release_discard', id: audit.id, stopOperation,
        taskId: report.taskId, leaseId: report.leaseId, receiptSha256, containerId: receipt.engine.containerId,
        boot: report.boot, rootIdentity: report.rootIdentity, activeIdentity: report.activeIdentity,
        discardedTrees: [...receipt.directories, receipt.engine.configuration],
        inventory: trees.map(tree => ({ nodes: tree.nodes, bytes: tree.bytes })), observations, admissionCleared: false });
      step = 'staging_disposal';
      for (const tree of trees) tree.purge();
      assertStable();
      writeAudit(audit.fd, 'ready.json', { version: 1, taskId: report.taskId, leaseId: report.leaseId, receiptSha256,
        stageBytesDisposed: true, originalAdmissionArchivedOnCommit: true });
      step = 'admission_archive';
      archiveAdmission(audit.fd); committed = true;
      step = 'empty_directory_cleanup';
      const cleanupPending = [];
      for (let i = 0; i < trees.length; i++) {
        try { trees[i].removeEmptyRoots(); } catch (_) { cleanupPending.push(i); }
      }
      const result = { version: 1, mode: 'release_discard', operationId: audit.id, stopOperation,
        taskId: report.taskId, leaseId: report.leaseId, receiptSha256, containerId: receipt.engine.containerId,
        admissionCleared: true, stageBytesDisposed: true, cleanupPending,
        blockers: cleanupPending.length ? ['Archived admission released; empty staging directories require review'] : [] };
      writeAudit(audit.fd, 'result.json', result);
      return result;
    } catch (error) {
      if (audit) try { writeAudit(audit.fd, 'uncertain.json', { version: 1, operation: 'release_discard', step, admissionArchiveRenamed: context.admissionArchived(), admissionCleared: committed ? true : context.admissionArchived() ? null : false }); } catch (_) { /* Durable intent and receipt are retained. */ }
      throw error;
    } finally {
      for (const tree of trees) tree.close();
      if (audit) fs.closeSync(audit.fd);
      fs.closeSync(lock);
    }
  });
}

module.exports = { releaseExecutorRecovery };
