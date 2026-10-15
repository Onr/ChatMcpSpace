'use strict';

// Fixed kernel metadata only. Neither task paths nor supplied programs are read.
const fs = require('fs');
const path = require('path');
const { ExecutorUnavailableError } = require('./restrictedExecutor');
const CGROUP2 = 0x63677270;

function deny() { throw new ExecutorUnavailableError('Exact task cgroup identity is unavailable; retain admission'); }
function same(stat, expected) { return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino; }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function readBounded(file, bound) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) deny();
    const bytes = Buffer.alloc(bound + 1);
    let count = 0, n;
    while (count < bytes.length && (n = fs.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
    if (count === bytes.length) deny();
    return bytes.subarray(0, count).toString();
  } finally { fs.closeSync(fd); }
}

function validateTaskCgroupIdentity(value, containerId) {
  const validDirectory = d => d && typeof d.path === 'string' && d.path.length <= 4096 &&
    path.resolve(d.path) === d.path && !/[\0\r\n]/.test(d.path) &&
    typeof d.dev === 'string' && /^[0-9]+$/.test(d.dev) && typeof d.ino === 'string' && /^[1-9][0-9]*$/.test(d.ino);
  if (!/^[a-f0-9]{64}$/.test(containerId || '') || !validDirectory(value) || !validDirectory(value.scope) ||
      !value.path.startsWith('/sys/fs/cgroup/') || path.basename(value.path) !== 'container' ||
      path.dirname(value.path) !== value.scope.path || path.basename(value.scope.path) !== 'libpod-' + containerId + '.scope') deny();
  return { path: value.path, dev: value.dev, ino: value.ino,
    scope: { path: value.scope.path, dev: value.scope.dev, ino: value.scope.ino } };
}

function readInitializedTaskCgroup(expected, containerId) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 ||
      typeof expected.startTime !== 'string' || !/^[1-9][0-9]*$/.test(expected.startTime)) deny();
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const procFd = fs.openSync('/proc/' + expected.pid, flags);
  const proc = '/proc/self/fd/' + procFd;
  let cgroupFd, scopeFd;
  const checkProcess = () => {
    const text = readBounded(proc + '/stat', 4096), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!text.startsWith(expected.pid + ' (') || fields[19] !== expected.startTime || ['Z', 'X', 'x'].includes(fields[0])) deny();
  };
  try {
    checkProcess();
    const membership = readBounded(proc + '/cgroup', 4096);
    if (!/^0::\/[^\0\r\n]+\n$/.test(membership)) deny();
    const leaf = '/sys/fs/cgroup' + membership.slice(3, -1), scope = path.dirname(leaf);
    // Check the exact libpod scope before opening any candidate cgroup path.
    validateTaskCgroupIdentity({ path: leaf, dev: '0', ino: '1', scope: { path: scope, dev: '0', ino: '1' } }, containerId);
    if (fs.realpathSync(leaf) !== leaf || fs.realpathSync(scope) !== scope) deny();
    scopeFd = fs.openSync(scope, flags);
    cgroupFd = fs.openSync('/proc/self/fd/' + scopeFd + '/container', flags);
    const cgroup = '/proc/self/fd/' + cgroupFd;
    if (fs.statfsSync(cgroup).type !== CGROUP2) deny();
    const saved = { path: leaf, ...identity(fs.fstatSync(cgroupFd, { bigint: true })),
      scope: { path: scope, ...identity(fs.fstatSync(scopeFd, { bigint: true })) } };
    const procs = readBounded(cgroup + '/cgroup.procs', 32768);
    if (!/^(?:[1-9][0-9]*\n)+$/.test(procs) || !procs.trim().split('\n').includes(String(expected.pid)) ||
        !/^populated 1$/m.test(readBounded(cgroup + '/cgroup.events', 256)) ||
        readBounded(cgroup + '/cgroup.type', 64) !== 'domain\n' ||
        readBounded(cgroup + '/memory.max', 64) !== '536870912\n' ||
        readBounded(cgroup + '/pids.max', 64) !== '128\n' ||
        readBounded(cgroup + '/cpu.max', 64) !== '100000 100000\n') deny();
    checkProcess();
    if (readBounded(proc + '/cgroup', 4096) !== membership ||
        !same(fs.lstatSync(leaf, { bigint: true }), saved) || !same(fs.lstatSync(scope, { bigint: true }), saved.scope)) deny();
    return validateTaskCgroupIdentity(saved, containerId);
  } finally {
    if (cgroupFd !== undefined) fs.closeSync(cgroupFd);
    if (scopeFd !== undefined) fs.closeSync(scopeFd);
    fs.closeSync(procFd);
  }
}

function observeTaskProcess(expected) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 ||
      typeof expected.startTime !== 'string' || !/^[1-9][0-9]*$/.test(expected.startTime)) deny();
  const selected = { pid: expected.pid, startTime: expected.startTime };
  try {
    const text = readBounded('/proc/' + expected.pid + '/stat', 4096);
    if (!text.startsWith(expected.pid + ' (')) deny();
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^[1-9][0-9]*$/.test(fields[19])) deny();
    return { ...selected, absentOrStopped: fields[19] !== expected.startTime || ['Z', 'X', 'x'].includes(fields[0]) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return { ...selected, absentOrStopped: true };
    throw error;
  }
}

function observeRetainedTaskCgroup(value, containerId) {
  const expected = validateTaskCgroupIdentity(value, containerId);
  if (fs.realpathSync('/sys/fs/cgroup') !== '/sys/fs/cgroup' || fs.statfsSync('/sys/fs/cgroup').type !== CGROUP2) deny();
  const observe = directory => {
    let fd;
    try {
      if (fs.realpathSync(directory.path) !== directory.path) deny();
      fd = fs.openSync(directory.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const anchor = '/proc/self/fd/' + fd;
      if (!same(fs.fstatSync(fd, { bigint: true }), directory) || fs.statfsSync(anchor).type !== CGROUP2) deny();
      const events = readBounded(anchor + '/cgroup.events', 256), procs = readBounded(anchor + '/cgroup.procs', 32768);
      const population = events.split('\n').filter(line => /^populated [01]$/.test(line));
      if (population.length !== 1 || !/^(?:[1-9][0-9]*\n)*$/.test(procs) ||
          !same(fs.lstatSync(directory.path, { bigint: true }), directory)) deny();
      return { removed: false, populated: population[0] === 'populated 1', processCount: procs ? procs.trim().split('\n').length : 0 };
    } catch (error) {
      // Kernel removal requires no children or live processes. Missing control
      // files alone do not prove removal; the exact directory must also be gone.
      if (error.code === 'ENOENT' || error.code === 'ENODEV') {
        try { fs.lstatSync(directory.path); } catch (missing) {
          if (missing.code === 'ENOENT') return { removed: true, populated: false, processCount: 0 };
          throw missing;
        }
      }
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const scope = observe(expected.scope), leaf = observe(expected);
  if (scope.removed && !leaf.removed) deny();
  return { scope, leaf, stopped: !scope.populated && !leaf.populated && !scope.processCount && !leaf.processCount };
}

module.exports = { validateTaskCgroupIdentity, readInitializedTaskCgroup, observeRetainedTaskCgroup, observeTaskProcess };
