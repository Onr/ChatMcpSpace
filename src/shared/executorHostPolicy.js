'use strict';

const fs = require('fs');

// Piped core handlers execute in the host namespaces outside the task's cgroup.
// Linux ignores RLIMIT_CORE for them. Do not admit tasks on such a host, even
// when the task's own soft and hard limits are zero. Never alter host policy here.
function assertSafeCoreDumpPolicy() {
  const deny = () => { const error = new Error('Restricted execution requires a verified host core policy without external crash handlers');
    error.code = 'RESTRICTED_EXECUTOR_UNAVAILABLE'; error.status = 503; throw error; };
  let fd;
  try {
    fd = fs.openSync('/proc/sys/kernel/core_pattern', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || fs.statfsSync('/proc/self/fd/' + fd).type !== 0x9fa0) deny();
    const bytes = Buffer.alloc(130);
    let count = 0, n;
    while (count < bytes.length && (n = fs.readSync(fd, bytes, count, bytes.length - count, null))) count += n;
    const pattern = bytes.subarray(0, count).toString('utf8');
    if (count > 129 || !/^[\x20-\x7e]{0,128}\n$/.test(pattern) || pattern.startsWith('|')) deny();
  } catch (_) { deny(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { assertSafeCoreDumpPolicy };
