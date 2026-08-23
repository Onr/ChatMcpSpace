const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readPidFromFile,
  terminateProcessWithEscalation
} = require('../../src/utils/agentStopUtils');

describe('agentStopUtils', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('readPidFromFile', () => {
    it('returns null when pid file is missing', () => {
      const missingPath = path.join(os.tmpdir(), `missing-pid-${Date.now()}`);
      expect(readPidFromFile(missingPath)).toBeNull();
    });

    it('returns parsed positive PID from file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-test-'));
      const pidPath = path.join(tmpDir, '.agent_pid');
      fs.writeFileSync(pidPath, '12345');
      expect(readPidFromFile(pidPath)).toBe(12345);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null for invalid PID content', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-test-'));
      const pidPath = path.join(tmpDir, '.agent_pid');
      fs.writeFileSync(pidPath, 'not-a-pid');
      expect(readPidFromFile(pidPath)).toBeNull();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('terminateProcessWithEscalation', () => {
    it('escalates to SIGKILL when process remains alive after SIGTERM', () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 'SIGTERM' && pid === -4242) return true;
        if (signal === 0 && pid === 4242) return true;
        if (signal === 'SIGKILL' && pid === -4242) return true;
        throw Object.assign(new Error('unexpected call'), { code: 'ESRCH' });
      });

      const result = terminateProcessWithEscalation(4242);
      expect(result).toEqual({
        processKilled: true,
        forceKillAttempted: true,
        forceKilled: true
      });
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(4242, 0);
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });

    it('falls back to direct PID signal if process group signal fails', () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -9898 && signal === 'SIGTERM') {
          throw Object.assign(new Error('no group'), { code: 'ESRCH' });
        }
        if (pid === 9898 && signal === 'SIGTERM') return true;
        if (pid === 9898 && signal === 0) {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        }
        throw Object.assign(new Error('unexpected call'), { code: 'ESRCH' });
      });

      const result = terminateProcessWithEscalation(9898);
      expect(result).toEqual({
        processKilled: true,
        forceKillAttempted: false,
        forceKilled: false
      });
      expect(killSpy).toHaveBeenCalledWith(-9898, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(9898, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(9898, 0);
    });

    it('returns not killed when PID is invalid', () => {
      expect(terminateProcessWithEscalation(0)).toEqual({
        processKilled: false,
        forceKillAttempted: false,
        forceKilled: false
      });
    });
  });
});
