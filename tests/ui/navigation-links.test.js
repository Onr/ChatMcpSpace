/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const layout = fs.readFileSync(path.join(__dirname, '../../views/layout.ejs'), 'utf8');

function renderNavigation(currentPath, user = { email: 'navigation@example.test' }) {
  const html = ejs.render(layout, { assetUrl: url => url, currentPath, user, cspNonce: 'test', body: '<p>Content</p>' }, { filename: path.join(__dirname, '../../views/layout.ejs') });
  document.documentElement.innerHTML = html;
  return document.getElementById('navToggleButton');
}

describe('Native dashboard/settings navigation', () => {
  test.each([
    ['/dashboard', '/settings', 'Settings'],
    ['/settings', '/dashboard', 'Dashboard'],
    ['/settings/external-agents/approve', '/dashboard', 'Dashboard'],
    ['/archive', '/settings', 'Settings'],
    ['/settings-other', '/settings', 'Settings'],
    [undefined, '/settings', 'Settings'],
  ])('renders the destination without client JavaScript on %s', (route, href, label) => {
    const link = renderNavigation(route);
    expect(link.getAttribute('href')).toBe(href);
    expect(link.textContent.trim()).toBe(label);
    expect(link.tabIndex).toBe(0);
  });

  test('returning to either rendered page retains its destination', () => {
    for (const route of ['/dashboard', '/settings', '/dashboard', '/settings']) {
      const link = renderNavigation(route);
      window.dispatchEvent(new Event('pageshow'));
      expect(link.getAttribute('href')).toBe(route === '/settings' ? '/dashboard' : '/settings');
    }
  });

  test('does not load the navigation interceptor or expose duplicate link labels', () => {
    renderNavigation('/dashboard');
    expect(document.querySelector('script[src="/js/page-transitions.js"]')).toBeNull();
    expect(document.querySelector('.button-text-next')).toBeNull();
    expect(document.querySelector('#navToggleButton[onclick]')).toBeNull();
  });

  test('does not expose signed-in navigation to signed-out visitors', () => {
    expect(renderNavigation('/', null)).toBeNull();
  });
});
