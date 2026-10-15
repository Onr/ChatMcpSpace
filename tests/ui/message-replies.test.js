/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/message-replies.js'), 'utf8');
let replies;
beforeEach(() => {
  document.body.innerHTML = '<div><div><textarea id="userMessageInput"></textarea></div></div>';
  window.eval(script); replies = window.MessageReplies;
});
function mountMessage(id, text = '<img src=x onerror=alert(1)>') {
  const element = document.createElement('article');
  element.dataset.messageId = id;
  element.innerHTML = '<div class="message-bubble"><div class="message-utilities"></div></div>';
  document.body.append(element);
  replies.decorate(element, { messageId: id, content: text, type: 'agent_message', agentName: 'Mira' }, 'room-one', true);
  return element;
}
test('reply previews use text, can be cancelled, and are isolated between conversations', () => {
  mountMessage('one').querySelector('.message-reply-btn').click();
  expect(document.getElementById('messageReplyDraft').textContent).toContain('<img');
  expect(document.getElementById('messageReplyDraft').querySelector('img')).toBeNull();
  replies.setContext('other-room'); expect(document.getElementById('messageReplyDraft')).toBeNull();
  replies.setContext('room-one'); expect(replies.get('room-one').messageId).toBe('one');
  document.querySelector('[aria-label="Cancel reply"]').click();
  expect(replies.get('room-one')).toBeUndefined();
});
test('acknowledging an earlier send keeps a newly selected reply draft', () => {
  mountMessage('one').querySelector('button').click(); const old = replies.get('room-one');
  mountMessage('two').querySelector('button').click();
  replies.clear('room-one', old);
  expect(replies.get('room-one').messageId).toBe('two');
});
test('legacy replies survive encrypted text round trips without parsing ordinary JSON messages', () => {
  const encoded = replies.encode('my answer', { messageId: 'one', text: 'question', senderName: 'Mira' });
  expect(replies.decode(encoded)).toMatchObject({ text: 'my answer', reply: { messageId: 'one', text: 'question' } });
  expect(replies.decode('{"other":"json"}')).toBeNull();
});
test('quote navigation finds the original by ID and encrypted placeholders cannot be replied to', () => {
  const original = mountMessage('one'); original.scrollIntoView = jest.fn();
  const reply = document.createElement('article'); reply.innerHTML = '<div class="message-bubble"></div>';
  replies.decorate(reply, { reply: { messageId: 'one', text: 'original' }, isEncryptedPlaceholder: true }, 'room-one', true);
  reply.querySelector('.message-reply-quote').click(); expect(original.scrollIntoView).toHaveBeenCalled();
  expect(reply.querySelector('.message-reply-btn')).toBeNull();
});
