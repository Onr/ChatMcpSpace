'use strict';

// Device details are self-reported display metadata, never authorization evidence.
function normalizeDevice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) ||
      typeof value.name !== 'string') return null;
  const name = value.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128);
  return name ? { id: value.id, name } : null;
}
module.exports = { normalizeDevice };
