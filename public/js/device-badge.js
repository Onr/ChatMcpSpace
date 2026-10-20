/* Shared, deterministic device identicons. No images, timers, or network requests. */
(function (root) {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const cache = new Map();
  function render(device) {
    const known = device && typeof device.id === 'string' && /^[a-f0-9]{64}$/.test(device.id) &&
      typeof device.name === 'string' && device.name.trim();
    const label = known ? `Device: ${device.name.slice(0, 128)}` : 'Device not reported';
    let svg = '<span aria-hidden="true">?</span>';
    if (known) {
      svg = cache.get(device.id);
      if (!svg) {
        // A mirrored 5x5 pattern and two colors derived from the device fingerprint.
        const bits = parseInt(device.id.slice(0, 8), 16);
        const hue = parseInt(device.id.slice(8, 12), 16) % 360;
        let cells = '';
        for (let y = 0; y < 5; y++) {
          for (let x = 0; x < 5; x++) {
            const column = Math.min(x, 4 - x);
            const on = (bits >>> (y * 3 + column)) & 1;
            cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="hsl(${hue},${on ? 80 : 35}%,${on ? 76 : 22}%)"/>`;
          }
        }
        svg = `<svg viewBox="0 0 5 5" aria-hidden="true" shape-rendering="crispEdges">${cells}</svg>`;
        if (cache.size >= 256) cache.clear();
        cache.set(device.id, svg);
      }
    }
    return `<span class="agent-device-badge${known ? '' : ' agent-device-badge--unknown'}" title="${escape(label)}" aria-label="${escape(label)}" role="img">${svg}</span>`;
  }
  const api = { render };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeviceBadge = api;
})(typeof window === 'object' ? window : globalThis);
