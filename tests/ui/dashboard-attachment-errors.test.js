const fs = require('fs');
const path = require('path');

describe('Dashboard attachment upload regressions', () => {
  const repoRoot = path.join(__dirname, '../..');
  const jsPath = path.join(repoRoot, 'public/js/dashboard.js');
  const js = fs.readFileSync(jsPath, 'utf8');

  it('uses structured API errors for main composer attachment uploads', () => {
    expect(js).toMatch(/const errorData = await readErrorPayload\(response\);/);
    expect(js).toMatch(/throw buildRequestError\(response, errorData, \{/);
    expect(js).toMatch(/fallbackMessage: `Failed to upload \$\{imageEntry\.file\?\.name \|\| 'attachment'\}`/);
  });

  it('shows the server upload message together with the failed filename list', () => {
    expect(js).toMatch(/function buildFailedUploadMessage\(images = \[\]\)/);
    expect(js).toMatch(/return `\$\{firstError\} Failed: \$\{failedNames\.join\(', '\)\}\.`;/);
    expect(js).toMatch(/showErrorMessage\(buildFailedUploadMessage\(pendingImages\)\);/);
  });

  it('maps non-JSON 413 upload failures to a useful message', () => {
    expect(js).toMatch(/function buildHttpFallbackMessage\(response, fallbackMessage\)/);
    expect(js).toMatch(/status === 413/);
    expect(js).toMatch(/exceeded the current server upload limit/);
    expect(js).toMatch(/current server upload limit of \$\{MAX_ATTACHMENT_SIZE_MB\}MB/);
    expect(js).toMatch(/reverse-proxy upload limit/);
  });
});
