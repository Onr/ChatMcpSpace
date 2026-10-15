const { SUPPORTED_PROVIDERS } = require('./modelCatalog');

const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const APPROVAL_MODES = ['full-auto', 'auto-edit', 'suggest', 'default', 'acceptEdits', 'bypassPermissions', 'plan'];
const SANDBOX_MODES = ['read-only', 'workspace-write', 'none', 'danger-full-access'];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,119}$/;

const ENUMS = {
  thinking_effort: THINKING_EFFORTS,
  approval_mode: APPROVAL_MODES,
  sandbox_mode: SANDBOX_MODES
};

/**
 * Validates optional per-message run settings. Returns { valid, value } where
 * value is a normalized object or null (null = use the agent's own config).
 */
function validateRunOverrides(input, allowedPermissions = {}) {
  if (input === undefined || input === null) return { valid: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, message: 'runOverrides must be an object' };
  }

  const value = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (key === 'model_provider') {
      if (typeof raw !== 'string' || !(SUPPORTED_PROVIDERS.has(raw) || raw === 'default')) {
        return { valid: false, message: `Unsupported model_provider '${String(raw).slice(0, 40)}'` };
      }
      value.model_provider = raw;
    } else if (key === 'model') {
      if (typeof raw !== 'string' || !MODEL_PATTERN.test(raw)) {
        return { valid: false, message: 'Invalid model name' };
      }
      value.model = raw;
    } else if (ENUMS[key]) {
      if (!ENUMS[key].includes(raw)) {
        return { valid: false, message: `${key} must be one of: ${ENUMS[key].join(', ')}` };
      }
      value[key] = raw === 'danger-full-access' ? 'none' : raw;
    } else {
      return { valid: false, message: `Unknown run override '${key.slice(0, 40)}'` };
    }
  }

  if (value.model && !value.model_provider) {
    return { valid: false, message: 'model_provider is required when overriding model' };
  }

  const restricted = Object.keys(allowedPermissions || {})
    .filter((key) => !['inter_agent', 'project_path'].includes(key));
  if (restricted.length > 0 && value.model_provider) {
    const checked = value.model_provider === 'default' ? 'codex' : value.model_provider;
    if (!allowedPermissions[checked]) {
      return { valid: false, message: `Provider '${value.model_provider}' is not allowed by this agent's permissions` };
    }
  }

  return { valid: true, value: Object.keys(value).length ? value : null };
}

module.exports = { validateRunOverrides, THINKING_EFFORTS, APPROVAL_MODES, SANDBOX_MODES };
