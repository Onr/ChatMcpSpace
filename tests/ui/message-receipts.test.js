/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const start = source.indexOf('function messageReceiptPresentation(');
const end = source.indexOf('async function pollReadStatus(', start);
const helpers = new Function('document', source.slice(start, end) + '\nreturn { messageReceiptPresentation, buildUserMessageReadIndicator, applyUserMessageDeliveryState, updateMessageReceipts };')(document);

test.each([
  [{ deliveryState: 'sending', serverReceived: false }, 'pending', '✓'],
  [{ deliveryState: 'delivered', serverReceived: true }, 'delivered', '✓✓'],
  [{ deliveryState: 'pending' }, 'delivered', '✓✓'],
  [{ deliveryState: 'failed', deliveryFailed: true }, 'delivered', '✓✓'],
  [{ deliveryState: 'failed', serverReceived: false }, 'failed', '⚠'],
  [{ readAt: '2026-10-13T01:00:00Z' }, 'read', '✓✓'],
  [{ deliveryState: 'read' }, 'read', '✓✓']
])('receipt presentation for %j', (status, state, text) => {
  expect(helpers.messageReceiptPresentation(status)).toMatchObject({ state, text });
});

test('one sending check becomes two server checks, then two agent-read checks in the same message', () => {
  document.body.innerHTML = `<textarea id="draft">Unsent draft</textarea><div id="conversationArea"><article data-message-id="one" data-message-type="user_message"><img src="blob:image">${helpers.buildUserMessageReadIndicator(null, 'sending', false, false)}</article></div>`;
  const area = document.getElementById('conversationArea');
  area.scrollTop = 127;
  const article = area.firstElementChild;
  const img = article.querySelector('img');
  const receipt = article.querySelector('.message-read-indicator');
  expect(receipt.textContent).toBe('✓');
  expect(receipt.dataset.receiptState).toBe('pending');
  helpers.updateMessageReceipts([{ messageId: 'one', type: 'user_message', serverReceived: true, deliveryState: 'delivered' }]);
  expect(receipt.textContent).toBe('✓✓');
  expect(receipt.dataset.receiptState).toBe('delivered');
  expect(article.hasAttribute('data-read')).toBe(false);
  expect(article.querySelector('.message-read-indicator')).toBe(receipt);
  expect(receipt.classList.contains('message-read-indicator--delivered')).toBe(true);
  expect(receipt.title).toContain('Received by server');
  helpers.updateMessageReceipts([{ messageId: 'one', type: 'user_message', readAt: '2026-10-13T01:00:00Z' }]);
  expect(article.querySelector('.message-read-indicator')).toBe(receipt);
  expect(receipt.classList.contains('message-read-indicator--read')).toBe(true);
  expect(receipt.textContent).toBe('✓✓');
  expect(receipt.dataset.receiptState).toBe('read');
  expect(receipt.getAttribute('aria-label')).toBe('Read by agent');
  expect(article.dataset.read).toBe('true');
  expect(article.querySelector('img')).toBe(img);
  expect(area.scrollTop).toBe(127);
  expect(document.getElementById('draft').value).toBe('Unsent draft');
});
