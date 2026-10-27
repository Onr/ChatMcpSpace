/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const source = dashboard.slice(dashboard.indexOf('function setupCouncilMinimize()'), dashboard.indexOf('function setupCouncilListResizeHandle()'));
let grid, handle, frame, desktop;
function pointer(type, clientX, pointerId = 1) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX, pointerId });
  handle.dispatchEvent(event);
}
function width() { return grid.style.getPropertyValue('--council-panel-width'); }
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div class="dashboard-main-grid"><div class="council-chamber"><button id="minimizeCouncilBtn"></button><button id="maximizeCouncilBtn"></button></div><div id="councilResizeHandle"></div><div id="multiChatContainer"></div></div>';
  grid = document.querySelector('.dashboard-main-grid');
  handle = document.getElementById('councilResizeHandle');
  grid.getBoundingClientRect = () => ({ left: 100 });
  document.querySelector('.council-chamber').getBoundingClientRect = () => ({ width: 470 });
  document.getElementById('multiChatContainer').getBoundingClientRect = () => ({ right: 1500 });
  handle.setPointerCapture = jest.fn();
  handle.releasePointerCapture = jest.fn();
  desktop = { matches: true, addEventListener: jest.fn() };
  window.matchMedia = () => desktop;
  window.MultiChatManager = { onPanelsChanged: jest.fn() };
  jest.spyOn(window, 'addEventListener').mockImplementation(() => {});
  window.requestAnimationFrame = jest.fn(callback => { frame = callback; return 1; });
  window.cancelAnimationFrame = jest.fn();
  new Function('COUNCIL_SPLIT_STORAGE_KEY', 'isMobileListOnlyMode', source + '\nsetupCouncilMinimize(); setupCouncilResizeHandle();')('split', () => false);
});
afterEach(() => jest.restoreAllMocks());
test.each([[false, 339], [true, 289]])('drag past the minimum collapses in multi mode %s', (multi, target) => {
  grid.classList.toggle('dashboard-main-grid--multi-open', multi);
  pointer('pointerdown', 570);
  pointer('pointermove', 100 + target);
  frame();
  expect(grid.classList.contains('council-minimized')).toBe(true);
  expect(localStorage.getItem('council_minimized')).toBe('true');
  expect(grid.classList.contains('dashboard-main-grid--resizing')).toBe(false);
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(document.activeElement.id).toBe('maximizeCouncilBtn');
});
test('the minimum and small overshoot do not collapse', () => {
  pointer('pointerdown', 570);
  pointer('pointermove', 460);
  frame();
  expect(width()).toBe('380px');
  expect(grid.classList.contains('council-minimized')).toBe(false);
});
test('the latest coalesced position controls collapse', () => {
  pointer('pointerdown', 570);
  pointer('pointermove', 650);
  pointer('pointermove', 420);
  frame();
  expect(grid.classList.contains('council-minimized')).toBe(true);
});
test('a quick release before the frame still collapses and cancels the queued frame', () => {
  pointer('pointerdown', 570);
  pointer('pointermove', 430);
  pointer('pointerup', 430);
  expect(grid.classList.contains('council-minimized')).toBe(true);
  expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(handle.releasePointerCapture).toHaveBeenCalledTimes(1);
  frame();
  expect(width()).toBe('470px');
});
test('cancel and unrelated pointers do not collapse', () => {
  pointer('pointerdown', 570);
  pointer('pointermove', 420, 2);
  expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  pointer('pointermove', 420);
  pointer('pointercancel', 420);
  frame();
  expect(grid.classList.contains('council-minimized')).toBe(false);
});
test('expanding restores the saved width and makes the divider usable again', () => {
  const resizeListener = window.addEventListener.mock.calls.find(([name]) => name === 'resize')[1];
  // Other dashboard resize listeners are outside this isolated function fixture.
  jest.spyOn(window, 'dispatchEvent').mockImplementation(() => { resizeListener(); return true; });
  pointer('pointerdown', 570);
  pointer('pointermove', 620);
  frame();
  pointer('pointermove', 420);
  frame();
  expect(handle.classList.contains('hidden')).toBe(true);
  document.getElementById('maximizeCouncilBtn').click();
  expect(grid.classList.contains('council-minimized')).toBe(false);
  expect(handle.classList.contains('hidden')).toBe(false);
  expect(width()).toBe('520px');
  jest.restoreAllMocks();
});
test('mobile ignores divider dragging', () => {
  desktop.matches = false;
  pointer('pointerdown', 570);
  pointer('pointermove', 420);
  expect(window.requestAnimationFrame).not.toHaveBeenCalled();
});
