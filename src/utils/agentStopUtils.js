const fs = require('fs');

function readPidFromFile(pidPath) {
  if (!pidPath || !fs.existsSync(pidPath)) {
    return null;
  }

  const raw = fs.readFileSync(pidPath, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sendSignalToProcessOrGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return { sent: true, target: 'group' };
  } catch (_groupErr) {
    try {
      process.kill(pid, signal);
      return { sent: true, target: 'pid' };
    } catch (pidErr) {
      return { sent: false, error: pidErr };
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we do not have permission to signal it.
    return err && err.code === 'EPERM';
  }
}

/**
 * Terminate a process with a built-in failsafe:
 * 1. SIGTERM to process group (fallback PID)
 * 2. If still alive, escalate to SIGKILL
 */
function terminateProcessWithEscalation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      processKilled: false,
      forceKillAttempted: false,
      forceKilled: false
    };
  }

  const termResult = sendSignalToProcessOrGroup(pid, 'SIGTERM');
  if (!termResult.sent) {
    return {
      processKilled: false,
      forceKillAttempted: false,
      forceKilled: false
    };
  }

  if (!isProcessAlive(pid)) {
    return {
      processKilled: true,
      forceKillAttempted: false,
      forceKilled: false
    };
  }

  const killResult = sendSignalToProcessOrGroup(pid, 'SIGKILL');
  return {
    processKilled: true,
    forceKillAttempted: true,
    forceKilled: killResult.sent
  };
}

module.exports = {
  readPidFromFile,
  terminateProcessWithEscalation
};
