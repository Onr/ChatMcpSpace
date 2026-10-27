/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const keyboard = source.slice(source.indexOf('function setupKeyboardNavigation()'), source.indexOf('function setFocusArea(area)'));
function listenerFor(html) {
  document.body.innerHTML = html;
  let listener;
  const unexpected = jest.fn(() => { throw Error('Global agent navigation intercepted a native control'); });
  const context = vm.createContext({ document: { addEventListener: (_type, fn) => { listener = fn; } }, getVisibleAgentSeats: unexpected });
  vm.runInContext(keyboard + '\nsetupKeyboardNavigation();', context);
  return (key, selector = '#target', extras = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extras });
    Object.defineProperty(event, 'target', { value: document.querySelector(selector) });
    if (extras.alreadyHandled) event.preventDefault();
    listener(event);
    return event;
  };
}
test.each(['Tab', 'Enter', 'Delete', 'ArrowRight', 'j'])(`%s leaves native buttons, links, selects, summaries, editors and dialog inputs alone`, key => {
  for (const html of ['<button id="target">Open menu</button>', '<a id="target" href="/settings">Settings</a>', '<select id="target"><option>Model</option></select>', '<details><summary id="target">Help</summary></details>', '<div id="target" contenteditable="true">Draft</div>', '<dialog open><input id="target"></dialog>', '<div id="decryptionModal"><input id="target"></div>']) {
    const press = listenerFor(html);
    expect(press(key).defaultPrevented).toBe(false);
  }
});
test('Tab and Shift+Tab preserve native focus order even on the workspace background', () => {
  const press = listenerFor('<div id="target"></div>');
  expect(press('Tab').defaultPrevented).toBe(false);
  expect(press('Tab', '#target', { shiftKey: true }).defaultPrevented).toBe(false);
});
test('an already handled event never reaches council shortcuts', () => {
  const press = listenerFor('<div id="target"></div>');
  expect(() => press('Enter', '#target', { alreadyHandled: true })).not.toThrow();
});
