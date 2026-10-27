/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
test('feedback advertises its shortcut and submits once, excluding IME composition', async () => {
  const template = fs.readFileSync(path.join(__dirname, '../../views/layout.ejs'), 'utf8');
  const button = template.match(/<button id="feedbackSendBtn"[\s\S]*?<\/button>/)[0];
  document.body.innerHTML = `<button id="feedbackTriggerBtn"></button><div id="feedbackPanel" class="is-open"><textarea id="feedbackTextarea"></textarea>${button}<button id="feedbackLoveBtn"></button></div>`;
  const textarea = document.getElementById('feedbackTextarea');
  const listeners = {};
  const fetch = jest.fn(() => new Promise(() => {}));
  const doc = { getElementById: id => document.getElementById(id), addEventListener: (name, fn) => { listeners[name] = fn; }, get activeElement() { return document.activeElement; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/js/feedback.js'), 'utf8'), { document: doc, localStorage, console, fetch, window: { location: { href: 'https://fixture.example' }, csrfToken: 'csrf' }, FormData, setTimeout });
  listeners.DOMContentLoaded();
  expect(document.getElementById('feedbackSendBtn').textContent).toContain('Ctrl / ⌘ + Enter');
  textarea.value = 'Useful feedback'; textarea.dispatchEvent(new Event('input')); textarea.focus();
  listeners.keydown(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true }));
  expect(fetch).not.toHaveBeenCalled();
  listeners.keydown(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  listeners.keydown(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
  expect(fetch).toHaveBeenCalledTimes(1);
});
