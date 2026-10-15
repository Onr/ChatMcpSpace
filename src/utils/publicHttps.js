function isPublicHttpsConfigured({ httpsEnabled = false, baseUrl = '' } = {}) {
  if (httpsEnabled === true) return true;

  try {
    return new URL(String(baseUrl)).protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isPublicHttpsConfigured };
