const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const STAT_TTL_MS = 5000;
const cache = new Map();

/**
 * Append a ?v= cache-buster derived from the file's mtime, so browsers holding
 * a 1-day cached copy fetch the new file as soon as it changes on disk.
 * Hand-maintained ?v= stamps were easy to forget and left stale CSS in place.
 */
function assetUrl(urlPath) {
  const now = Date.now();
  const hit = cache.get(urlPath);
  if (hit && now - hit.checkedAt < STAT_TTL_MS) return hit.url;
  let url = urlPath;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (filePath.startsWith(PUBLIC_DIR + path.sep)) {
    try {
      url = `${urlPath}?v=${Math.floor(fs.statSync(filePath).mtimeMs).toString(36)}`;
    } catch (_) {
      // Missing file: serve the bare path and let static middleware 404.
    }
  }
  cache.set(urlPath, { url, checkedAt: now });
  return url;
}

module.exports = { assetUrl };
