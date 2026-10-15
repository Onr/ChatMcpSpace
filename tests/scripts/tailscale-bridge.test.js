const fs = require('fs');
const path = require('path');

describe('tailscale_bridge.sh', () => {
  const scriptPath = path.join(__dirname, '../../scripts/tailscale_bridge.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');

  it('uses private Tailscale Serve and never Funnel', () => {
    expect(script).toMatch(/tailscale serve --bg --yes/);
    expect(script).toMatch(/http:\/\/127\.0\.0\.1:\$\{app_port\}/);
    expect(script).not.toMatch(/tailscale funnel/);
  });

  it('checks the local app before configuring the proxy', () => {
    expect(script).toMatch(/curl --fail --silent --show-error --max-time 5/);
  });

  it('requires an authenticated Tailscale connection', () => {
    expect(script).toMatch(/tailscale ip -4/);
  });
});
