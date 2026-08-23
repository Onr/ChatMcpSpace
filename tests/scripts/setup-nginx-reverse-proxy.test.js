const fs = require('fs');
const path = require('path');

describe('setup_nginx_reverse_proxy.sh', () => {
  const repoRoot = path.join(__dirname, '../..');
  const scriptPath = path.join(repoRoot, 'scripts/setup_nginx_reverse_proxy.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('uses the app attachment-size env vars for the proxy upload limit', () => {
    expect(script).toMatch(/MAX_UPLOAD_MB="\$\{MAX_ATTACHMENT_SIZE_MB:-\$\{MAX_IMAGE_SIZE_MB:-20\}\}"/);
    expect(script).toMatch(/client_max_body_size \$\{MAX_UPLOAD_MB\}m;/);
  });
});
