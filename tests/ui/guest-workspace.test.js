/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder ||= TextEncoder;
global.TextDecoder ||= TextDecoder;
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../../public/js/guest-workspace.js'), 'utf8');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function domFor(fetchImpl) {
  const dom = new JSDOM(`
    <section id="guestWorkspace">
      <p id="guestWorkspaceStatus"></p><p id="guestWorkspaceAudience"></p>
      <div id="guestRooms"></div>
      <section id="guestConversation" hidden>
        <h2 id="guestConversationTitle"></h2><p id="guestConversationStatus"></p>
        <button id="guestPeopleButton" disabled aria-expanded="false"><span data-guest-people-count>…</span></button>
        <dialog id="guestAudienceDialog"><button id="guestPeopleClose" type="button">Close people</button><div id="guestAudience"></div></dialog>
        <p id="guestHistoryStatus" hidden></p>
        <div id="guestTimeline"></div>
        <form id="guestComposer"><p id="guestReplyState"></p>
          <textarea id="guestMessage"></textarea>
          <input id="guestFiles" type="file" multiple>
          <select id="guestAddress"><option value="">Everyone</option></select>
          <button type="submit">Send</button><button id="guestCancelReply" type="button" hidden>Cancel</button>
        </form>
      </section>
    </section>`, {
    url: 'https://space.example/guest',
    runScripts: 'outside-only'
  });
  dom.window.fetch = jest.fn((url, options) => {
    if (String(url).includes('/message-status?')) return Promise.resolve(response([]));
    const fixtureUrl = String(url).replace(/\/messages\?before=9223372036854775807&limit=200/, '/messages?after=0');
    return fetchImpl(fixtureUrl, options);
  });
  dom.window.SharedCrypto = {
    unwrap: jest.fn().mockResolvedValue({ key: 'room-key' }),
    encrypt: jest.fn().mockResolvedValue({ v: 1, iv: 'guest-iv', data: 'guest-data' }),
    decrypt: jest.fn().mockResolvedValue({ text: 'Hello from the guest' })
  };
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.crypto.subtle = {
    encrypt: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer),
    decrypt: jest.fn().mockResolvedValue(new Uint8Array([9, 8, 7]).buffer)
  };
  dom.window.URL.createObjectURL = jest.fn(() => 'blob:guest-file');
  dom.window.URL.revokeObjectURL = jest.fn();
  dom.window.HTMLAnchorElement.prototype.click = jest.fn();
  dom.window.crypto.randomUUID = jest.fn(() => 'stable-message-id');
  dom.window.setInterval = jest.fn(() => 1);
  dom.window.clearInterval = jest.fn();
  dom.window.confirm = jest.fn(() => true);
  dom.window.eval(script);
  return dom;
}

const workspace = {
  share: { shareId: 'share-one' },
  guest: { guest_id: 'guest-one' },
  rooms: [
    { roomId: 'room-one', agentId: 'agent-one', agentName: 'One', title: 'First', status: 'active', keyReady: true, rotationRequired: false },
    { roomId: 'room-two', agentId: 'agent-two', agentName: 'Two', title: 'Second', status: 'active', keyReady: true, rotationRequired: false }
  ]
};

function context(roomId, title = roomId) {
  return {
    room: { id: roomId, title, ownerId: 'user-one', keyVersion: 1, rotationRequired: false, runtimeLastSeenAt: new Date().toISOString(), executionUncertain: false },
    member: { kind: 'guest', id: 'guest-one', displayName: 'Guest One', status: 'active' },
    members: [{ kind: 'user', id: 'user-one', displayName: 'Account One', role: 'member', status: 'active' }],
    guests: [
      { kind: 'guest', id: 'guest-one', displayName: 'Guest One', status: 'active' },
      { kind: 'guest', id: 'guest-two', displayName: 'Guest Two', status: 'active' }
    ],
    keys: [{ key_version: 1, wrapped_key: 'wrapped-room-key' }],
    agentIdentity: { display_name: 'Agent' }
  };
}

function basicFetch(messages = []) {
  return async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url === '/api/guest/rooms/room-two') return response(context('room-two', 'Second'));
    if (url.includes('/messages?after=')) {
      const after = Number(new URL(url, 'https://space.example').searchParams.get('after'));
      return response(messages.filter(item => Number(item.seq) > after));
    }
    if (url.endsWith('/read')) return response({ ok: true });
    if (options.method === 'POST' && url.endsWith('/messages')) return response({ id: 'stable-message-id' });
    throw new Error(`Unexpected request ${url}`);
  };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function start(dom, fetchWorkspace = workspace) {
  await dom.window.GuestWorkspace.start({
    csrfToken: 'csrf-token',
    workspace: fetchWorkspace,
    identity: { privateKey: { key: 'private' } },
    onSessionEnded: jest.fn()
  });
  await settle();
}

test('guest read receipts patch check marks while preserving mounted content, scroll and draft', async () => {
  const dom = domFor(basicFetch([{ id: 'message-one', seq: 1, sender_guest_id: 'guest-one', kind: 'message', key_version: 1,
    payload: { v: 1, iv: 'guest-iv', data: 'guest-data' } }]));
  await start(dom);
  const document = dom.window.document;
  const timeline = document.getElementById('guestTimeline');
  const article = timeline.querySelector('[data-message-id="message-one"]');
  const receipt = article.querySelector('.message-read-indicator');
  expect(receipt.dataset.receiptState).toBe('delivered');
  const image = document.createElement('img');
  article.append(image);
  timeline.scrollTop = 123;
  document.getElementById('guestMessage').value = 'Unsent guest draft';
  const base = dom.window.fetch;
  dom.window.fetch = jest.fn((url, options) => String(url).includes('/message-status?')
    ? Promise.resolve(response([{ messageId: 'message-one', readAt: '2026-10-13T01:00:00Z' }])) : base(url, options));
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(receipt.dataset.receiptState).toBe('read');
  expect(receipt.title).toBe('Read by agent');
  expect(article.querySelector('.message-read-indicator')).toBe(receipt);
  expect(article.querySelector('img')).toBe(image);
  expect(timeline.scrollTop).toBe(123);
  expect(document.getElementById('guestMessage').value).toBe('Unsent guest draft');
  dom.window.close();
});

test('guest ignores an optional receipt that arrives after switching rooms', async () => {
  const dom = domFor(basicFetch([{ id: 'message-one', seq: 1, sender_guest_id: 'guest-one', kind: 'message', key_version: 1,
    payload: { v: 1, iv: 'guest-iv', data: 'guest-data' } }]));
  await start(dom);
  let release;
  const base = dom.window.fetch;
  dom.window.fetch = jest.fn((url, options) => String(url).includes('/message-status?')
    ? new Promise(resolve => { release = resolve; }) : base(url, options));
  await dom.window.setInterval.mock.calls[0][0]();
  expect(release).toBeDefined();
  dom.window.document.querySelectorAll('#guestRooms button')[1].click();
  await settle();
  release(response([{ messageId: 'message-one', readAt: '2026-10-13T01:00:00Z' }]));
  await settle();
  expect(dom.window.document.querySelector('.message-read-indicator').dataset.receiptState).toBe('delivered');
  dom.window.close();
});

test('renders typed account and guest audience labels in the selected room', async () => {
  const dom = domFor(basicFetch([{
    id: 'message-one', seq: 1, sender_guest_id: 'guest-two', kind: 'message', key_version: 1,
    payload: { v: 1, iv: 'guest-iv', data: 'guest-data' }, addressed_to_principals: [{ kind: 'user', id: 'user-one' }]
  }]));
  await start(dom);
  expect(dom.window.document.getElementById('guestAudience').textContent).toContain('Account One · member · registered account');
  expect(dom.window.document.getElementById('guestAudience').textContent).toContain('Guest Two · Guest participant · unverified identity');
  expect(dom.window.document.getElementById('guestTimeline').textContent).toContain('Guest Two · Guest');
  expect(dom.window.document.getElementById('guestTimeline').textContent).toContain('Addressed to: Account One · Account');
  dom.window.close();
});

test('guest timeline explains the actual audience of a restricted agent reply', async () => {
  const dom = domFor(basicFetch([{
    id: 'agent-private', seq: 1, sender_agent_id: 'agent-one', kind: 'message', key_version: 1,
    recipient_principals: [{ kind: 'user', id: 'user-one' }],
    payload: { v: 1, iv: 'guest-iv', data: 'guest-data' }
  }]));
  await start(dom);
  expect(dom.window.document.getElementById('guestTimeline').textContent).toContain('Visible to: Owner only');
  dom.window.close();
});

test('guest recipient picker keeps its options, focus and selection through background polling', async () => {
  const dom = domFor(basicFetch());
  await start(dom);
  dom.window.document.querySelector('#guestRooms button').click();
  await settle();
  const select = dom.window.document.getElementById('guestAddress');
  select.value = 'guest:guest-two';
  select.focus();
  const options = [...select.options];
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect([...select.options]).toEqual(options);
  expect(select.value).toBe('guest:guest-two');
  expect(dom.window.document.activeElement).toBe(select);
  dom.window.close();
});

test('guest drafts stay with their conversation when switching between shared agents', async () => {
  const dom = domFor(basicFetch());
  const document = dom.window.document;
  await start(dom);
  const rooms = [...document.querySelectorAll('#guestRooms button')];
  rooms[0].click();
  await settle();
  document.getElementById('guestMessage').value = 'Draft for One';
  document.getElementById('guestAddress').value = 'guest:guest-two';
  rooms[1].click();
  await settle();
  expect(document.getElementById('guestMessage').value).toBe('');
  document.getElementById('guestMessage').value = 'Draft for Two';
  rooms[0].click();
  await settle();
  expect(document.getElementById('guestMessage').value).toBe('Draft for One');
  expect(document.getElementById('guestAddress').value).toBe('guest:guest-two');
  rooms[1].click();
  await settle();
  expect(document.getElementById('guestMessage').value).toBe('Draft for Two');
  dom.window.close();
});

test('guest switching restores only the selected room transcript when the incremental response is empty', async () => {
  const dom = domFor(async url => {
    if (url === '/api/guest/workspace') return response(workspace);
    const roomId = url.includes('/room-two') ? 'room-two' : 'room-one';
    if (url.includes('/messages?after=0')) return response([{
      id: `${roomId}-message`, seq: 1, sender_guest_id: 'guest-two', kind: 'message',
      key_version: 1, payload: { text: `Transcript for ${roomId}` }
    }]);
    if (url.includes('/messages?after=')) return response([]);
    if (url.endsWith('/read')) return response({ ok: true });
    if (url === `/api/guest/rooms/${roomId}`) return response(context(roomId));
    throw new Error(`Unexpected request ${url}`);
  });
  dom.window.SharedCrypto.decrypt.mockImplementation(async (_key, payload) => payload);
  await start(dom);
  const timeline = dom.window.document.getElementById('guestTimeline');
  expect(timeline.textContent).toContain('Transcript for room-one');
  dom.window.document.querySelector('[data-chat-room="room-two"]').click();
  await settle();
  expect(timeline.textContent).toContain('Transcript for room-two');
  dom.window.document.querySelector('[data-chat-room="room-one"]').click();
  await settle();
  expect(timeline.textContent).toContain('Transcript for room-one');
  expect(timeline.textContent).not.toContain('Transcript for room-two');
  dom.window.close();
});

test('guest transcript returns after a temporary access request failure without needing a new message', async () => {
  let roomRequests = 0;
  const base = basicFetch([{ id: 'saved', seq: 1, sender_guest_id: 'guest-two', key_version: 1, payload: { v: 1 } }]);
  const dom = domFor(async (url, options) => {
    if (url === '/api/guest/rooms/room-one' && ++roomRequests === 2) return response({ error: { message: 'Temporary connection failure' } }, 503);
    return base(url, options);
  });
  await start(dom);
  const timeline = dom.window.document.getElementById('guestTimeline');
  expect(timeline.querySelector('[data-message-id="saved"]')).toBeTruthy();
  await dom.window.setInterval.mock.calls[0][0]();
  expect(timeline.children).toHaveLength(0);
  await dom.window.setInterval.mock.calls[0][0]();
  expect(timeline.querySelector('[data-message-id="saved"]')).toBeTruthy();
  dom.window.close();
});

test('guest room navigation keeps keyboard focus through an unchanged workspace poll', async () => {
  const dom = domFor(basicFetch());
  await start(dom);
  const button = dom.window.document.querySelector('[data-chat-room="room-two"]');
  button.focus();
  await dom.window.setInterval.mock.calls[0][0]();
  expect(dom.window.document.activeElement).toBe(button);
  dom.window.close();
});

test('guest polling advances its sequence cursor and does not refetch history after an empty update', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url === '/api/guest/rooms/room-two') return response(context('room-two', 'Second'));
    if (url.includes('/messages?after=')) {
      requests.push(new URL(url, 'https://space.example'));
      const after = Number(requests.at(-1).searchParams.get('after'));
      return response(after === 0 ? [{ id: 'one', seq: 1, sender_guest_id: 'guest-two', key_version: 1, payload: { v: 1 } }] : []);
    }
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = domFor(fetchImpl);
  await start(dom);
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(requests.map(url => url.searchParams.get('after'))).toEqual(['0', '1']);
  expect(dom.window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=9223372036854775807&limit=200'))).toBe(true);
  expect(requests[1].searchParams.get('since')).toBeTruthy();
  const countAfterIncrementalPoll = requests.length;
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(requests).toHaveLength(countAfterIncrementalPoll + 1);
  expect(requests.at(-1).searchParams.get('after')).toBe('1');
  dom.window.close();
});

test('guest opens the newest history window and loads older messages without losing the visible transcript', async () => {
  let releaseOlder;
  const olderReady = new Promise(resolve => { releaseOlder = resolve; });
  const recent = Array.from({ length: 200 }, (_, index) => ({
    id: `message-${index + 201}`, seq: index + 201, sender_guest_id: 'guest-two', kind: 'message',
    key_version: 1, payload: { v: 1 }, addressed_to_principals: []
  }));
  const fetchImpl = async url => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url === '/api/guest/rooms/room-two') return response(context('room-two', 'Second'));
    if (url.includes('/messages?before=201&limit=200')) {
      await olderReady;
      return response([{
      id: 'message-1', seq: 1, sender_guest_id: 'guest-two', kind: 'message', key_version: 1,
      payload: { v: 1 }, addressed_to_principals: []
      }]);
    }
    if (url.includes('/messages?after=0')) return response(recent);
    if (url.includes('/messages?after=')) return response([]);
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = domFor(fetchImpl);
  await start(dom);
  const timeline = dom.window.document.getElementById('guestTimeline');
  expect(dom.window.document.getElementById('guestLoadOlder')).toBeNull();
  expect(dom.window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=9223372036854775807&limit=200'))).toBe(true);
  timeline.scrollTop = 0;
  timeline.dispatchEvent(new dom.window.Event('scroll'));
  timeline.dispatchEvent(new dom.window.Event('scroll'));
  await settle();
  const callsWhileLoading = dom.window.fetch.mock.calls.length;
  await dom.window.setInterval.mock.calls[0][0]();
  expect(dom.window.fetch.mock.calls).toHaveLength(callsWhileLoading);
  releaseOlder();
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(dom.window.fetch.mock.calls.some(([url]) => String(url).includes('/messages?before=201&limit=200'))).toBe(true);
  expect(dom.window.document.querySelectorAll('#guestTimeline [data-message-id]')).toHaveLength(201);
  expect(dom.window.document.querySelector('#guestTimeline [data-message-id="message-1"]')).toBeTruthy();
  expect(dom.window.document.getElementById('guestHistoryStatus').hidden).toBe(true);
  const completedCalls = dom.window.fetch.mock.calls.length;
  timeline.dispatchEvent(new dom.window.Event('scroll'));
  await settle();
  expect(dom.window.fetch.mock.calls).toHaveLength(completedCalls);
  dom.window.close();
});

test('people button opens the active audience without losing a draft or closing during polling', async () => {
  const dom = domFor(basicFetch());
  const document = dom.window.document;
  const dialog = document.getElementById('guestAudienceDialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new dom.window.Event('close'));
  };
  await start(dom);
  const button = document.getElementById('guestPeopleButton');
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('3');
  expect(button.getAttribute('aria-label')).toBe('View 3 people in this chat');
  document.getElementById('guestMessage').value = 'Keep this draft';
  button.click();
  expect(dialog.open).toBe(true);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(document.getElementById('guestPeopleClose'));
  await dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(dialog.open).toBe(true);
  expect(document.getElementById('guestMessage').value).toBe('Keep this draft');
  document.getElementById('guestPeopleClose').click();
  expect(dialog.open).toBe(false);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  button.click();
  await dom.window.GuestWorkspace.stop();
  expect(dialog.open).toBe(false);
  dom.window.close();
});

test('keeps a failed encrypted send under one idempotency key and retries it', async () => {
  let sendCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url.includes('/rooms/room-one') && url.includes('/messages?after=')) return response([]);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url.endsWith('/read')) return response({ ok: true });
    if (options.method === 'POST' && url.endsWith('/messages')) {
      sendCount += 1;
      return sendCount === 1 ? response({ error: { message: 'offline' } }, 503) : response({ id: 'stable-message-id' });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = domFor(fetchImpl);
  await start(dom);
  const form = dom.window.document.getElementById('guestComposer');
  dom.window.document.getElementById('guestMessage').value = 'retry me';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const stored = JSON.parse(dom.window.sessionStorage.getItem('guest-outbox:share-one:guest-one:room-one:message'));
  expect(stored.id).toBe('stable-message-id');
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const sends = dom.window.fetch.mock.calls.filter(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(sends).toHaveLength(2);
  expect(JSON.parse(sends[0][1].body).id).toBe(JSON.parse(sends[1][1].body).id);
  expect(dom.window.sessionStorage.getItem('guest-outbox:share-one:guest-one:room-one:message')).toBeNull();
  dom.window.close();
});

test('encrypts photos before guest upload and binds their IDs to the message', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url.includes('/messages?after=')) return response([]);
    if (url.endsWith('/read')) return response({ ok: true });
    if (options.method === 'POST' && url.endsWith('/files')) return response({ id: options.body.get('id') });
    if (options.method === 'POST' && url.endsWith('/messages')) return response({ id: 'stable-message-id' });
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = domFor(fetchImpl);
  await start(dom);
  const file = new dom.window.File(['photo bytes'], 'photo.png', { type: 'image/png' });
  if (!file.arrayBuffer) file.arrayBuffer = async () => new TextEncoder().encode('photo bytes').buffer;
  Object.defineProperty(dom.window.document.getElementById('guestFiles'), 'files', { value: [file] });
  dom.window.document.getElementById('guestComposer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const upload = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/files') && options.method === 'POST');
  expect(upload).toBeTruthy();
  const uploadedId = upload[1].body.get('id');
  const send = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(JSON.parse(send[1].body).fileIds).toEqual([uploadedId]);
  expect(JSON.parse(send[1].body).payload).toBeTruthy();
  dom.window.close();
});

test('ignores a stale room render after switching agents', async () => {
  let firstRoomLoads = 0;
  let releaseFirst;
  const delayedFirst = new Promise(resolve => { releaseFirst = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') {
      firstRoomLoads += 1;
      if (firstRoomLoads > 1) return delayedFirst;
      return response(context('room-one', 'First'));
    }
    if (url === '/api/guest/rooms/room-two') return response(context('room-two', 'Second'));
    if (url.includes('/messages?after=')) return response([]);
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = domFor(fetchImpl);
  await start(dom);
  const roomButtons = dom.window.document.querySelectorAll('.guest-room-button');
  roomButtons[0].click();
  await settle();
  roomButtons[1].click();
  await settle();
  expect(dom.window.document.getElementById('guestConversationTitle').textContent).toBe('Two');
  releaseFirst(response(context('room-one', 'Stale First')));
  await settle();
  expect(dom.window.document.getElementById('guestConversationTitle').textContent).toBe('Two');
  dom.window.close();
});

test('downloads and previews an encrypted raster attachment through the current room', async () => {
  const encryptedBytes = new Uint8Array(16).fill(4);
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url.includes('/messages?after=1')) return response([]);
    if (url.includes('/messages?after=')) return response([{
      id: 'message-one', seq: 1, sender_guest_id: 'guest-two', kind: 'message', key_version: 1,
      payload: { v: 1, iv: 'guest-iv', data: 'guest-data' }, addressed_to_principals: []
    }]);
    if (url.endsWith('/files/file-one')) return {
      ok: true,
      status: 200,
      headers: { get: name => name === 'X-Shared-Key-Version' ? '1' : null },
      arrayBuffer: async () => encryptedBytes.buffer
    };
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url} ${options.method || 'GET'}`);
  };
  const dom = domFor(fetchImpl);
  dom.window.SharedCrypto.decrypt.mockResolvedValue({ text: 'Photo', files: [{ id: 'file-one', name: 'photo.png', type: 'image/png' }] });
  await start(dom);
  const download = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Download photo.png');
  expect(download).toBeTruthy();
  download.click();
  await settle();
  expect(dom.window.fetch.mock.calls.some(([url]) => url.endsWith('/files/file-one'))).toBe(true);
  expect(dom.window.URL.createObjectURL).toHaveBeenCalled();
  const preview = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'View image');
  preview.click();
  await settle();
  const image = dom.window.document.querySelector('.guest-attachment-preview');
  expect(image).toBeTruthy();
  const revocations = dom.window.URL.revokeObjectURL.mock.calls.length;
  await dom.window.setInterval.mock.calls[0][0]();
  expect(dom.window.document.querySelector('.guest-attachment-preview')).toBe(image);
  expect(dom.window.URL.revokeObjectURL).toHaveBeenCalledTimes(revocations);
  await dom.window.GuestWorkspace.stop();
  expect(dom.window.URL.revokeObjectURL).toHaveBeenCalled();
  dom.window.close();
});

test('routes sanitized interactive form responses through the original guest room', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') return response(context('room-one', 'First'));
    if (url.includes('/messages?after=')) return response([{
      id: 'question-one', seq: 1, sender_agent_id: 'agent-one', kind: 'message', key_version: 1,
      payload: { v: 1, iv: 'guest-iv', data: 'guest-data' }, addressed_to_principals: []
    }]);
    if (options.method === 'POST' && url.endsWith('/messages')) return response({ id: 'rich-response' });
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url} ${options.method || 'GET'}`);
  };
  const dom = domFor(fetchImpl);
  dom.window.RichRendering = {
    detectRichContent: jest.fn(value => value.includes('rich_html') ? { type: 'rich_html', html: '<form></form>' } : null),
    renderRichContent: jest.fn((_data, callback) => {
      const button = dom.window.document.createElement('button');
      button.textContent = 'Submit rich form';
      button.addEventListener('click', () => callback('Guest form answer'));
      return button;
    })
  };
  dom.window.SharedCrypto.decrypt.mockResolvedValue({ text: JSON.stringify({ type: 'rich_html', html: '<form></form>' }) });
  await start(dom);
  const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === 'Submit rich form');
  expect(button).toBeTruthy();
  button.click();
  await settle();
  const send = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(send[0]).toBe('/api/guest/rooms/room-one/messages');
  expect(JSON.parse(send[1].body).replyTo).toEqual(['question-one']);
  expect(dom.window.fetch.mock.calls.some(([url]) => url.startsWith('/api/user/'))).toBe(false);
  dom.window.close();
});

test('a rich form keeps its draft and waits for a background key refresh before submission', async () => {
  let pause = false, resume;
  const dom = domFor(async (url, options = {}) => {
    if (url === '/api/guest/workspace') return response(workspace);
    if (url === '/api/guest/rooms/room-one') {
      if (pause) return new Promise(resolve => { resume = () => resolve(response(context('room-one', 'First'))); });
      return response(context('room-one', 'First'));
    }
    if (url.includes('/messages?after=')) {
      const after = new URL(url, 'https://space.example').searchParams.get('after');
      return response(after === '0' ? [{
        id: 'form-one', seq: 1, sender_agent_id: 'agent-one', kind: 'message', key_version: 1,
        payload: { v: 1, iv: 'iv', data: 'data' }, addressed_to_principals: []
      }] : []);
    }
    if (options.method === 'POST' && url.endsWith('/messages')) return response({ id: 'answer' });
    if (url.endsWith('/read')) return response({ ok: true });
    throw new Error(`Unexpected request ${url}`);
  });
  dom.window.RichRendering = {
    detectRichContent: () => ({ type: 'rich_html' }),
    renderRichContent: (_data, callback) => {
      const form = dom.window.document.createElement('form');
      form.innerHTML = '<input name="decision"><button type="submit">Submit</button>';
      form.addEventListener('submit', event => { event.preventDefault(); callback(form.elements.decision.value); });
      return form;
    }
  };
  await start(dom);
  const form = dom.window.document.querySelector('[data-sharing-rich]');
  const button = form.querySelector('button');
  form.elements.decision.value = 'Keep my answer';
  pause = true;
  const poll = dom.window.setInterval.mock.calls[0][0]();
  await settle();
  expect(button.disabled).toBe(true);
  expect(form.elements.decision.value).toBe('Keep my answer');
  pause = false;
  resume();
  await poll;
  expect(button.disabled).toBe(false);
  expect(form.isConnected).toBe(true);
  button.click();
  await settle();
  const send = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(send[0]).toBe('/api/guest/rooms/room-one/messages');
  expect(JSON.parse(send[1].body).replyTo).toEqual(['form-one']);
  dom.window.close();
});

test('does not duplicate composer listeners across logout and rejoin', async () => {
  const dom = domFor(basicFetch([]));
  await start(dom);
  await dom.window.GuestWorkspace.stop();
  await start(dom);
  dom.window.document.getElementById('guestMessage').value = 'once';
  dom.window.document.getElementById('guestComposer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const sends = dom.window.fetch.mock.calls.filter(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(sends).toHaveLength(1);
  dom.window.close();
});

test('a delayed attachment download cannot preview in a newly selected room', async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const base = basicFetch([{ id: 'photo-message', seq: 1, sender_agent_id: 'agent-one', kind: 'message', key_version: 1, payload: {} }]);
  const dom = domFor(async (url, options) => url.endsWith('/files/file-one') ? delayed : base(url, options));
  dom.window.SharedCrypto.decrypt.mockResolvedValue({ text: 'Photo', files: [{ id: 'file-one', name: 'photo.png', type: 'image/png' }] });
  await start(dom);
  [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'View image').click();
  await settle();
  dom.window.document.querySelectorAll('.guest-room-button')[1].click();
  await settle();
  finish({ ok: true, headers: { get: () => '1' }, arrayBuffer: async () => new Uint8Array(40).buffer });
  await settle();
  expect(new TextDecoder().decode(dom.window.crypto.subtle.decrypt.mock.calls[0][0].additionalData)).toBe('room-one:1');
  expect(dom.window.URL.createObjectURL).not.toHaveBeenCalled();
  expect(dom.window.document.querySelector('.guest-attachment-preview')).toBeNull();
  expect(dom.window.document.getElementById('guestConversationTitle').textContent).toBe('Two');
  dom.window.close();
});

test('question controls wait for the previous answer refresh before accepting another answer', async () => {
  let finishRead;
  const readPending = new Promise(resolve => { finishRead = resolve; });
  const questions = ['First choice', 'Second choice'].map((text, index) => ({
    id: `question-${index}`, seq: index + 1, sender_agent_id: 'agent-one', kind: 'question', key_version: 1,
    payload: { text, options: [text] }, addressed_to: [], addressed_to_principals: []
  }));
  let answers = 0;
  const base = basicFetch(questions);
  const dom = domFor(async (url, options) => {
    if (url.includes('/questions/') && url.endsWith('/answer')) { answers += 1; return response({ ok: true }); }
    if (url.includes('/messages?after=') && answers === 1) await readPending;
    return base(url, options);
  });
  dom.window.SharedCrypto.decrypt.mockImplementation(async (_key, payload) => payload);
  await start(dom);
  const choice = text => [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === text);
  choice('First choice').click();
  await settle();
  expect(answers).toBe(1);
  expect(choice('Second choice').disabled).toBe(true);
  expect(dom.window.document.querySelector('#guestComposer button[type="submit"]').disabled).toBe(true);
  choice('Second choice').click();
  await settle();
  expect(answers).toBe(1);
  finishRead();
  await settle();
  expect(choice('Second choice').disabled).toBe(false);
  choice('Second choice').click();
  await settle();
  expect(answers).toBe(2);
  dom.window.close();
});

test('an answer stays bound to its original room while encryption is pending', async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const base = basicFetch([{ id: 'question-one', seq: 1, sender_agent_id: 'agent-one', kind: 'question', key_version: 1, payload: {}, addressed_to: [], addressed_to_principals: [] }]);
  const dom = domFor(async (url, options) => url.endsWith('/questions/question-one/answer') ? response({ ok: true }) : base(url, options));
  dom.window.SharedCrypto.decrypt.mockResolvedValue({ text: 'Choose', options: ['Yes'] });
  await start(dom);
  dom.window.SharedCrypto.encrypt.mockReturnValueOnce(delayed);
  const answer = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Yes');
  answer.click();
  await settle();
  dom.window.document.querySelectorAll('.guest-room-button')[1].click();
  await settle();
  finish({ v: 1, iv: 'fixture', data: 'fixture' });
  await settle();
  const sends = dom.window.fetch.mock.calls.filter(([url]) => url.includes('/questions/'));
  expect(sends.map(([url]) => url)).toEqual(['/api/guest/rooms/room-one/questions/question-one/answer']);
  expect(dom.window.SharedCrypto.encrypt.mock.calls[0][2]).toBe('room-one:1');
  answer.click(); // A detached old-room callback must also be denied.
  await settle();
  expect(dom.window.fetch.mock.calls.filter(([url]) => url.includes('/questions/'))).toHaveLength(1);
  dom.window.close();
});

test('completion of an old-room send preserves the newly selected room draft', async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const dom = domFor(basicFetch());
  await start(dom);
  dom.window.SharedCrypto.encrypt.mockReturnValueOnce(delayed);
  dom.window.document.getElementById('guestMessage').value = 'First room request';
  dom.window.document.getElementById('guestComposer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  dom.window.document.querySelectorAll('.guest-room-button')[1].click();
  await settle();
  dom.window.document.getElementById('guestMessage').value = 'Second room draft';
  finish({ v: 1, iv: 'fixture', data: 'fixture' });
  await settle();
  const sends = dom.window.fetch.mock.calls.filter(([url, options]) => url.endsWith('/messages') && options.method === 'POST');
  expect(sends.map(([url]) => url)).toEqual(['/api/guest/rooms/room-one/messages']);
  expect(dom.window.document.getElementById('guestMessage').value).toBe('Second room draft');
  dom.window.close();
});

test('rotation rekeys a rejected encrypted retry and its file without changing identifiers', async () => {
  let sends = 0;
  const base = basicFetch();
  const dom = domFor(async (url, options = {}) => {
    if (url === '/api/guest/rooms/room-one') return response({ ...context('room-one'),
      room: { ...context('room-one').room, keyVersion: 2 }, keys: [{ key_version: 1, wrapped_key: 'old' }, { key_version: 2, wrapped_key: 'new' }] });
    if (url.endsWith('/files/retained-file')) return { ok: true, headers: { get: () => '1' }, arrayBuffer: async () => new Uint8Array(40).buffer };
    if (url.endsWith('/files') && options.method === 'POST') return response({ id: options.body.get('id') });
    if (url.endsWith('/messages') && options.method === 'POST') return ++sends === 1 ? response({ error: { message: 'Stale conversation key' } }, 409) : response({ ok: true });
    return base(url, options);
  });
  await start(dom);
  const outbox = 'guest-outbox:share-one:guest-one:room-one:message';
  dom.window.sessionStorage.setItem(outbox, JSON.stringify({ id: 'original-message', keyVersion: 1, payload: {}, fileIds: ['retained-file'] }));
  dom.window.SharedCrypto.decrypt.mockResolvedValue({ text: 'Original content', files: [{ id: 'retained-file', name: 'notes.txt', type: 'text/plain' }] });
  dom.window.document.getElementById('guestMessage').value = 'Retry';
  dom.window.document.getElementById('guestComposer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const posts = dom.window.fetch.mock.calls.filter(([url, options]) => url.endsWith('/messages') && options.method === 'POST').map(([, options]) => JSON.parse(options.body));
  expect(posts.map(item => [item.id, item.keyVersion])).toEqual([['original-message', 1], ['original-message', 2]]);
  const upload = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/files') && options.method === 'POST');
  expect(upload[1].body.get('id')).toBe('retained-file');
  expect(upload[1].body.get('keyVersion')).toBe('2');
  expect(dom.window.SharedCrypto.encrypt.mock.calls[0][2]).toBe('room-one:2');
  expect(dom.window.sessionStorage.getItem(outbox)).toBeNull();
  dom.window.close();
});
