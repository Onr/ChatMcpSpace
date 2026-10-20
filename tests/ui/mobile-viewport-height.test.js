const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const start = source.indexOf('function initializeMobileViewport()');
const end = source.indexOf('/**\n * Initialize dashboard', start);

describe('mobile viewport recovery', () => {
  let dom, viewport, input, height, preserveScroll;

  beforeEach(() => {
    dom = new JSDOM('<div id="dashboardRoot"><textarea></textarea></div>', {
      runScripts: 'outside-only'
    });
    const { window } = dom;
    viewport = new window.EventTarget();
    viewport.height = 800;
    viewport.scale = 1;
    window.visualViewport = viewport;
    window.matchMedia = () => ({ matches: true });
    window.ensureMobileComposerVisible = jest.fn();
    window.setMobileChromeCollapsed = jest.fn();
    preserveScroll = window.preserveMobileConversationScroll = jest.fn();
    window.eval(`${source.slice(start, end)}\ninitializeMobileViewport();`);
    input = window.document.querySelector('textarea');
    height = () => window.document.documentElement.style.getPropertyValue('--vh');
  });

  afterEach(() => dom.window.close());

  test('uses dynamic full height until an input opens the keyboard', () => {
    expect(height()).toBe('100dvh');
    input.focus();
    viewport.height = 420;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    expect(height()).toBe('420px');
    expect(preserveScroll).toHaveBeenCalled();
  });

  test('blur recovers full height even if the visual viewport still reports the keyboard height', async () => {
    input.focus();
    viewport.height = 420;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    input.blur();
    await new Promise(resolve => dom.window.setTimeout(resolve, 10));
    expect(height()).toBe('100dvh');
    // Browser chrome can now expand or collapse without leaving a stale pixel height.
    viewport.height = 760;
    viewport.dispatchEvent(new dom.window.Event('scroll'));
    expect(height()).toBe('100dvh');
  });

  test('dismissing the keyboard while retaining input focus restores the expanded viewport', () => {
    input.focus();
    viewport.height = 420;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    viewport.height = 800;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    expect(height()).toBe('800px');
  });

  test('window resize and page restoration refresh viewport sizing', () => {
    input.focus();
    viewport.height = 500;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(height()).toBe('500px');
    viewport.height = 800;
    dom.window.dispatchEvent(new dom.window.Event('pageshow'));
    expect(height()).toBe('800px');
  });

  test('pinch zoom does not shrink the app shell to the magnified viewport', () => {
    input.focus();
    viewport.height = 400;
    viewport.scale = 2;
    viewport.dispatchEvent(new dom.window.Event('resize'));
    expect(height()).toBe('100dvh');
  });
});
