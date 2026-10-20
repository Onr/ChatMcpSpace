'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scripts = path.join(__dirname, '..', '..', 'scripts');
const FILES = ['windows-cli.ps1', 'windows-agent-runner.js', 'external-agent-bridge.js'];
function generateWindowsSetup(baseUrl) {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Windows installer requires an HTTPS base URL.');
  }
  return fs.readFileSync(path.join(scripts, 'setup-windows.ps1'), 'utf8').replace('__JETSPACE_BASE_URL__', url.toString().replace(/\/$/, '').replace(/'/g, "''"));
}
function registerWindowsSetupRoutes(router) {
  router.get('/setup.ps1', (req, res, next) => {
    try {
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      res.set('Cache-Control', 'no-store').type('text/plain').send(generateWindowsSetup(baseUrl));
    } catch (error) { next(error); }
  });
  router.get('/setup/windows/manifest.json', (_req, res, next) => {
    try {
      const files = Object.fromEntries(FILES.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(scripts, name))).digest('hex')]));
      res.set('Cache-Control', 'no-store').json({ version: 1, files });
    } catch (error) { next(error); }
  });
  for (const name of FILES) router.get(`/setup/windows/${name}`, (_req, res) => res.set('Cache-Control', 'no-store').type('text/plain').sendFile(path.join(scripts, name)));
}
module.exports = { generateWindowsSetup, registerWindowsSetupRoutes };
