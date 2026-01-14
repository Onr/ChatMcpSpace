const LEVELS = ['error', 'warn', 'info'];
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function isEnabled(level) {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(LOG_LEVEL);
}

function log(level, event, data = {}) {
  if (!isEnabled(level)) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function logInfo(event, data) {
  log('info', event, data);
}

function logWarn(event, data) {
  log('warn', event, data);
}

function logError(event, data) {
  log('error', event, data);
}

module.exports = {
  logInfo,
  logWarn,
  logError,
};
