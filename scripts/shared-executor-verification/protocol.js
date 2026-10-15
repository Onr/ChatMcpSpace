'use strict';

// Harness coordination only. These functions never invoke an engine or load an
// executor. Publish a complete document before its final pathname becomes visible.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const MAX_JSON_BYTES = 512 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

function publishJSON(file, value, { replace = false } = {}) {
  const data = Buffer.from(JSON.stringify(value) + '\n');
  if (data.length > MAX_JSON_BYTES) throw Error('Harness document exceeds its limit');
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = undefined;
    if (replace) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Harness document is not privately owned');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(temporary, file);
    } else {
      // Unlike rename, link refuses an existing destination. Only the complete
      // temporary inode becomes visible; a second driver cannot replace control.
      fs.linkSync(temporary, file);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readBounded(file, limit, { growing = false } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw Error('Harness evidence is not a bounded regular file');
    if (!growing && before.nlink !== 1) {
      // link publishes complete bytes; unlinking the temporary name then changes
      // ctime. Wait until that publication finishes BEFORE reading, preserving
      // every size/time mutation check rather than ignoring a changed ctime.
      const error = Error('Harness publication has not finished');
      if (before.nlink === 2) error.code = 'HARNESS_PUBLICATION_PENDING';
      throw error;
    }
    const data = Buffer.alloc(before.size + (growing ? 0 : 1));
    let count = 0, n;
    while (count < data.length && (n = fs.readSync(fd, data, count, data.length - count, null))) count += n;
    const after = fs.fstatSync(fd);
    if (!growing && (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) {
      throw Error('Harness document changed during read');
    }
    return data.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function readJSON(file) { return JSON.parse(readBounded(file, MAX_JSON_BYTES)); }

async function waitForJSON(file, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  do {
    try { return readJSON(file); }
    catch (error) { if (!['ENOENT', 'HARNESS_PUBLICATION_PENDING'].includes(error.code)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < until);
  const error = Error('Harness phase barrier not reached');
  error.code = 'HARNESS_BARRIER_TIMEOUT';
  throw error;
}

function readJSONLines(file) {
  let text;
  try { text = readBounded(file, MAX_LOG_BYTES, { growing: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // An append may be in progress. Parse only newline-terminated records and fail
  // on malformed completed lines rather than discarding inconvenient evidence.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function phaseReader(file) {
  let offset = 0, identity, pending = '';
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  return () => {
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT' && !identity) return []; throw error; }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size > BigInt(MAX_LOG_BYTES) || stat.size < BigInt(offset) ||
          (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino))) throw Error('Harness phase log changed identity or exceeded its bound');
      identity = { dev: stat.dev, ino: stat.ino };
      const records = [], bytes = Buffer.alloc(64 * 1024);
      while (offset < Number(stat.size)) {
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, Number(stat.size) - offset), offset);
        if (!count) throw Error('Harness phase log truncated during read');
        offset += count;
        pending += decoder.write(bytes.subarray(0, count));
        const last = pending.lastIndexOf('\n');
        if (last >= 0) {
          records.push(...pending.slice(0, last).split('\n').filter(Boolean).map(line => JSON.parse(line)));
          pending = pending.slice(last + 1);
        }
        if (Buffer.byteLength(pending) > MAX_JSON_BYTES) throw Error('Harness phase record exceeds its limit');
      }
      return records;
    } finally { fs.closeSync(fd); }
  };
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('Invalid observed process ID');
  const fd = fs.openSync('/proc/' + pid + '/stat', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(fd, bytes, 0, bytes.length, null);
    if (count === bytes.length) throw Error('Observed process stat exceeds its limit');
    const text = bytes.subarray(0, count).toString('utf8');
    const last = text.lastIndexOf(')');
    const fields = text.slice(last + 2).trim().split(/\s+/);
    if (!text.startsWith(pid + ' (') || last < 0 || !/^[1-9][0-9]*$/.test(fields[19])) throw Error('Observed process identity is invalid');
    return { pid, command: text.slice(text.indexOf('(') + 1, last), state: fields[0], startTime: fields[19] };
  } finally { fs.closeSync(fd); }
}

function acquireDriverLock(root) {
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw Error('Verification round directory must be privately owned');
  }
  const file = path.join(root, '.driver-lock.json');
  publishJSON(file, { ...processIdentity(process.pid), nonce: randomUUID() });
  const owned = fs.lstatSync(file, { bigint: true });
  let released = false;
  const release = () => {
    if (released) return;
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) throw Error('Driver lock identity changed; preserve it');
    fs.unlinkSync(file);
    released = true;
    process.removeListener('exit', onExit);
  };
  const onExit = () => { try { release(); } catch (_) { /* Preserve changed/stale evidence. */ } };
  process.once('exit', onExit);
  return release;
}

function joinDriver(root) {
  // A worker belongs to its live parent driver. It neither acquires nor removes
  // that driver's lock, and a standalone invocation cannot impersonate a child.
  const directory = fs.lstatSync(root);
  const file = path.join(root, '.driver-lock.json');
  const stat = fs.lstatSync(file);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077) ||
      !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Worker requires a private driver lock');
  const owner = readJSON(file);
  if (owner.pid !== process.ppid || typeof owner.nonce !== 'string' || !owner.nonce) throw Error('Worker parent does not own the driver lock');
  const live = processIdentity(owner.pid);
  if (live.startTime !== owner.startTime || ['Z', 'X', 'x'].includes(live.state)) throw Error('Worker driver identity changed');
  return owner;
}

function verifyRecorder(root) {
  const expected = path.join(root, 'podman-phase-recorder.js');
  if (!process.env.PODMAN_PATH || path.resolve(process.env.PODMAN_PATH) !== expected ||
      (process.env.AGENT_SHARING_ROUND_DIR && path.resolve(process.env.AGENT_SHARING_ROUND_DIR) !== root)) {
    throw Error('Driver and recorder must use the same private round');
  }
  const stat = fs.lstatSync(expected);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || !(stat.mode & 0o100) || fs.realpathSync(expected) !== expected) {
    throw Error('Recorder must be a private executable file in the driver round');
  }
}

function requiredResultsExitCode(records, expectedCount) {
  // The process exit is also an evidence gate: blocked/skipped/unknown checks
  // cannot become successful just because no check explicitly reported FAIL.
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || !Array.isArray(records) || records.length !== expectedCount) return 1;
  for (let i = 0; i < expectedCount; i++) {
    const record = records[i];
    if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, 'status') || record.status !== 'PASS') return 1;
  }
  return 0;
}

function readCgroupSample(directory, timing) {
  const sample = { ...timing };
  for (const file of ['pids.current', 'pids.events', 'memory.events', 'cpu.stat', 'cgroup.events', 'cgroup.procs']) {
    try { sample[file] = fs.readFileSync(path.join(directory, file), 'utf8').trim(); }
    catch (error) {
      if (!['ENOENT', 'ENODEV'].includes(error.code)) throw error;
      // A dying cgroup can lose a file during a live sample. Retain partial
      // evidence; this is never proof that the task or its writers stopped.
      sample.observationEnded = { file, code: error.code };
      break;
    }
  }
  return sample;
}

module.exports = { publishJSON, readJSON, waitForJSON, readJSONLines, phaseReader, processIdentity, acquireDriverLock, joinDriver, verifyRecorder, requiredResultsExitCode, readCgroupSample };
