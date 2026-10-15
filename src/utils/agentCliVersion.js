/**
 * Agent CLI version policy.
 *
 * IMPORTANT FOR FUTURE MAINTAINERS:
 * - Bump AGENT_CLI_VERSION whenever generated agent CLI/runtime behavior changes.
 * - This version is used for:
 *   1) Display in generated CLI scripts
 *   2) Agent self-reporting during message polling
 *   3) Outdated-agent detection and update prompting in the dashboard
 */
const AGENT_CLI_VERSION = '1.5.11';

function normalizeCliVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function parseCliVersion(value) {
  const normalized = normalizeCliVersion(value);
  if (!normalized) return null;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: normalized
  };
}

function compareCliVersions(a, b) {
  const parsedA = parseCliVersion(a);
  const parsedB = parseCliVersion(b);
  if (!parsedA || !parsedB) return null;

  if (parsedA.major !== parsedB.major) return parsedA.major > parsedB.major ? 1 : -1;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor > parsedB.minor ? 1 : -1;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch > parsedB.patch ? 1 : -1;
  return 0;
}

function isCliVersionOutdated(reportedVersion, latestVersion = AGENT_CLI_VERSION) {
  const cmp = compareCliVersions(reportedVersion, latestVersion);
  return cmp !== null && cmp < 0;
}

module.exports = {
  AGENT_CLI_VERSION,
  normalizeCliVersion,
  parseCliVersion,
  compareCliVersions,
  isCliVersionOutdated
};
