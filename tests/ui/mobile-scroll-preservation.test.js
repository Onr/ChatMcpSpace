/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const start = source.indexOf('function preserveMobileConversationScroll()');
const end = source.indexOf('function focusMobileComposerFromBottomOverscroll(', start);

function mount() {
  document.body.innerHTML = '<div id="conversationArea"></div><div id="messageInputArea"></div>';
  const area = document.getElementById('conversationArea');
  Object.defineProperties(area, { scrollHeight: { configurable: true, value: 1200, writable: true },
    clientHeight: { configurable: true, value: 400, writable: true } });
  area.scrollTop = 600;
  const callbacks = [];
  const schedule = callback => callbacks.push(callback);
  const helpers = new Function('document', 'window', 'requestAnimationFrame', 'setTimeout',
    `let forceScrollToBottomUntil=0; let selectedAgentId='one', selectedChatContext={conversationId:'room-one'}; const isMobileListOnlyMode=()=>true;
    ${source.slice(start, end)}
    return { preserveMobileConversationScroll, pinSend:()=>{forceScrollToBottomUntil=Date.now()+2500;}, changeChat:()=>{selectedChatContext={conversationId:'room-two'};} };`)(document, window, schedule, schedule);
  return { area, callbacks, helpers };
}

test('delayed composer callbacks preserve keyboard resizing but stop undoing a reader scroll', () => {
  const { area, callbacks, helpers } = mount();
  helpers.preserveMobileConversationScroll();
  // A changing viewport may reposition the scroll before the next paint.
  area.clientHeight = 300;
  area.scrollTop = 500;
  callbacks.shift()();
  expect(area.scrollTop).toBe(600);
  // The reader chooses an earlier message at the now stable layout size.
  area.scrollTop = 120;
  while (callbacks.length) callbacks.shift()();
  expect(area.scrollTop).toBe(120);
});

test('old mobile composer callbacks cannot change a newly selected conversation', () => {
  const { area, callbacks, helpers } = mount();
  helpers.preserveMobileConversationScroll();
  helpers.changeChat();
  area.clientHeight = 300;
  area.scrollTop = 50;
  while (callbacks.length) callbacks.shift()();
  expect(area.scrollTop).toBe(50);
});

test('a newer composer preservation supersedes callbacks holding an older position', () => {
  const { area, callbacks, helpers } = mount();
  helpers.preserveMobileConversationScroll();
  area.clientHeight = 300;
  area.scrollTop = 120;
  helpers.preserveMobileConversationScroll();
  while (callbacks.length) callbacks.shift()();
  expect(area.scrollTop).toBe(120);
});

 test('a mobile viewport callback cannot restore an older position during send', () => {
  const { area, callbacks, helpers } = mount();
  helpers.preserveMobileConversationScroll();
  helpers.pinSend();
  area.clientHeight = 300;
  area.scrollTop = 900;
  helpers.preserveMobileConversationScroll();
  while (callbacks.length) callbacks.shift()();
  expect(area.scrollTop).toBe(900);
});
