const fs = require('fs');
const path = require('path');

describe('Group UI regressions', () => {
  const repoRoot = path.join(__dirname, '../..');
  const dashboardEjsPath = path.join(repoRoot, 'views/dashboard.ejs');
  const cssPath = path.join(repoRoot, 'public/css/style.css');
  const jsPath = path.join(repoRoot, 'public/js/dashboard.js');

  const ejs = fs.readFileSync(dashboardEjsPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  it('renders the group back button adjacent to the council orbit area', () => {
    // Keep the button inside the council section, above the orbit, instead of fixed to the page.
    expect(ejs).toMatch(/id="groupBackBtn"[\s\S]*class="hidden\s+relative\b/);
    expect(ejs).toMatch(/id="groupBackBtn"[\s\S]*Back to all agents[\s\S]*id="councilCircle"/);
    expect(ejs).toMatch(/id="councilCircle"[\s\S]*class="council-orbit/);
  });

  it('supports per-group theme hues for group seats and group center', () => {
    expect(css).toMatch(/\.group-seat\s*\{[\s\S]*--group-hue:/);
    expect(css).toMatch(/\.group-seat__center\s*\{[\s\S]*hsl\(var\(--group-hue\)/);
    expect(css).toMatch(/\.council-center--group[\s\S]*--group-hue/);
  });

  it('assigns deterministic theme hue to group seats in the orbit renderer', () => {
    expect(js).toMatch(/function getGroupThemeHue\(/);
    expect(js).toMatch(/--group-hue:\s*\$\{groupHue\}/);
  });
});
