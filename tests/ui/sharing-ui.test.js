/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/sharing-ui.js'), 'utf8');

beforeEach(() => {
  document.body.innerHTML = `<section data-chat-workspace data-view="conversation">
    <button data-chat-room aria-current="true">Current room</button><button class="chat-mobile-back">Back</button>
    <form data-chat-composer><textarea></textarea><input type="file" multiple><div data-chat-files></div><button type="submit">Send</button></form>
  </section>`;
  window.eval(script);
  document.dispatchEvent(new Event('DOMContentLoaded'));
});

test('mobile back returns to rooms and focuses the current room without discarding the draft', () => {
  const textarea = document.querySelector('textarea');
  textarea.value = 'Keep my thought';
  document.querySelector('.chat-mobile-back').click();
  expect(document.querySelector('[data-chat-workspace]').dataset.view).toBe('rooms');
  expect(document.activeElement).toBe(document.querySelector('[data-chat-room]'));
  expect(textarea.value).toBe('Keep my thought');
});

test('plain Enter and IME composition never submit, while Ctrl or Command Enter submits once when ready', () => {
  const form = document.querySelector('form');
  const textarea = form.querySelector('textarea');
  const send = jest.fn(event => event.preventDefault());
  form.addEventListener('submit', send);
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
  expect(send).not.toHaveBeenCalled();
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  expect(send).toHaveBeenCalledTimes(1);
  form.querySelector('button').disabled = true;
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  expect(send).toHaveBeenCalledTimes(1);
});

test('attachment names render as text and clear after a successful composer reset', () => {
  const input = document.querySelector('input');
  Object.defineProperty(input, 'files', { value: [new File(['test'], '<img src=x onerror=alert(1)>.txt')] });
  input.dispatchEvent(new Event('change'));
  const files = document.querySelector('[data-chat-files]');
  expect(files.textContent).toContain('<img src=x onerror=alert(1)>.txt');
  expect(files.querySelector('img')).toBeNull();
  document.querySelector('form').reset();
  expect(files.textContent).toBe('');
});

test('task status never claims a cancellation request is stopped and approvals render untrusted commands as text', async () => {
  const panel = document.createElement('details');
  panel.innerHTML = '<div data-chat-tasks></div><p data-task-error></p>';
  document.body.append(panel);
  const decide = jest.fn().mockResolvedValue();
  const tasks = [{ task_id: '12345678-task', state: 'cancellation_requested', requester_kind: 'guest', canCancel: true, actions: [] },
    { task_id: '87654321-task', state: 'waiting_for_approval', requester_kind: 'user', actions: [{ actionId: 'action-id',
      approvalState: 'pending', name: 'project.test', resource: 'Website', digest: 'exact-digest', parameters: { command: '<img onerror=alert(1)>' } }] }];
  window.SharingUI.renderTasks(panel, tasks, { decide });
  expect(panel.textContent).toContain('Stopping — confirmation pending');
  expect(panel.querySelector('img')).toBeNull();
  expect(panel.textContent).toContain('<img onerror=alert(1)>');
  const approve = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Approve action');
  approve.click();
  await Promise.resolve();
  expect(decide).toHaveBeenCalledWith(tasks[1], tasks[1].actions[0], 'approve');
  expect(panel.querySelectorAll('button')).toHaveLength(2);
});
