/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder ||= TextEncoder;
global.TextDecoder ||= TextDecoder;
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../../public/js/guest-shared.js'), 'utf8');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('logout removes the guest identity and share-scoped encrypted outbox', async () => {
  const dom = new JSDOM(`
    <section id="guestUnlockPanel"><form id="guestUnlockForm">
      <input name="displayName" value="Guest One"><input name="password" value="">
      <button type="submit">Unlock</button>
    </form><p id="guestStatus"></p></section>
    <section id="guestWorkspace" hidden></section><button id="guestLogout" hidden>Log out</button>`, {
    url: 'https://space.example/guest#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    runScripts: 'outside-only'
  });
  const ensureIdentity = jest.fn().mockResolvedValue({ publicKey: { kty: 'RSA', n: 'public' }, privateKey: { key: 'private' } });
  const removeIdentity = jest.fn().mockResolvedValue(undefined);
  const start = jest.fn().mockResolvedValue(undefined);
  const stop = jest.fn().mockResolvedValue(undefined);
  dom.window.GuestCrypto = { ensureIdentity, removeIdentity };
  dom.window.GuestWorkspace = { start, stop };
  dom.window.fetch = jest.fn(async (url, options = {}) => {
    if (url === '/api/guest/unlock') return response({
      csrfToken: 'csrf-token',
      share: { shareId: 'share-one' },
      guest: { guestId: 'guest-one' }
    });
    if (url === '/api/guest/identity') return response({ ok: true });
    if (url === '/api/guest/workspace') return response({ rooms: [] });
    if (url === '/api/guest/logout') return response({ ok: true });
    throw new Error(`Unexpected request ${url} ${options.method || 'GET'}`);
  });
  dom.window.eval(script);
  const form = dom.window.document.getElementById('guestUnlockForm');
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(dom.window.document.getElementById('guestLogout').hidden).toBe(false);
  dom.window.sessionStorage.setItem('guest-outbox:share-one:guest-one:room-one:message', JSON.stringify({ id: 'pending' }));
  dom.window.document.getElementById('guestLogout').click();
  await settle();
  expect(removeIdentity).toHaveBeenCalledWith('share-one', 'guest-one');
  expect(stop).toHaveBeenCalled();
  expect(dom.window.sessionStorage.getItem('guest-outbox:share-one:guest-one:room-one:message')).toBeNull();
  expect(dom.window.document.getElementById('guestUnlockPanel').hidden).toBe(false);
  expect(dom.window.document.getElementById('guestWorkspace').hidden).toBe(true);
  expect(dom.window.document.getElementById('guestLogout').hidden).toBe(true);
  dom.window.close();
});

test('a guest invitation preview names the owner and conversation before joining', async () => {
  const dom = new JSDOM(`<section id="guestUnlockPanel"><p class="guest-eyebrow">You’re invited</p><h1 id="guestUnlockTitle">Join the conversation</h1><p>Choose a name to chat.</p><form id="guestUnlockForm"><input name="displayName"><input name="password"><button type="submit">Join chat</button></form><p id="guestStatus"></p></section><section id="guestWorkspace" hidden></section><button id="guestLogout" hidden>Log out</button>`, {
    url: 'https://space.example/guest#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', runScripts: 'outside-only'
  });
  dom.window.fetch = jest.fn(async url => url === '/api/guest/preview'
    ? response({ ownerDisplayName: 'Alex', agents: [{ agentName: 'Design Agent' }], requiresCode: true })
    : response({}, 404));
  dom.window.eval(script);
  await settle();
  expect(dom.window.document.querySelector('.guest-eyebrow').textContent).toBe('Alex invited you');
  expect(dom.window.document.getElementById('guestUnlockTitle').textContent).toBe('Join Design Agent');
  expect(dom.window.document.getElementById('guestUnlockPanel').textContent).toContain('The owner can read messages in this chat.');
  expect(dom.window.document.getElementById('guestStatus').textContent).toContain('separate guest access code');
  dom.window.close();
});

test('a request link asks the visitor to send the owner a request, as a guest or with their account', async () => {
  const secret = 'b'.repeat(43);
  const dom = new JSDOM(`<section id="guestUnlockPanel"><p class="guest-eyebrow">You’re invited</p><h1 id="guestUnlockTitle">Join the conversation</h1><p>Choose a name to chat.</p><form id="guestUnlockForm"><input name="displayName" value="Visitor"><input name="password" value=""><label data-request-only hidden>Message</label><textarea name="note" data-request-only hidden></textarea><button type="submit"><span data-join-label>Join chat</span></button></form><div id="guestAccountRequest" data-csrf-token="account-csrf" hidden><button id="guestAccountRequestButton" type="button">Ask with my account instead</button></div><p id="guestStatus"></p></section><section id="guestWorkspace" hidden></section><button id="guestLogout" hidden>Log out</button>`, {
    url: `https://space.example/guest#${secret}`, runScripts: 'outside-only'
  });
  const bodies = {};
  dom.window.fetch = jest.fn(async (url, options = {}) => {
    if (options.body) bodies[url] = { body: JSON.parse(options.body), headers: options.headers };
    if (url === '/api/guest/preview') return response({ ownerDisplayName: 'Alex', agents: [{ agentName: 'Design Agent' }], accessMode: 'request', accountRequests: true });
    if (url === '/api/user/shared/link-requests') return response({ state: 'pending', requested: 1 });
    if (url === '/api/guest/unlock') return response({ error: { message: 'stop here' } }, 400);
    throw new Error(`Unexpected request ${url}`);
  });
  dom.window.eval(script);
  await settle();
  const doc = dom.window.document;
  expect(doc.getElementById('guestUnlockTitle').textContent).toBe('Ask Alex for access');
  expect(doc.querySelector('[data-join-label]').textContent).toBe('Send request');
  expect(doc.querySelector('textarea[name="note"]').hidden).toBe(false);
  expect(doc.getElementById('guestAccountRequest').hidden).toBe(false);

  doc.querySelector('textarea[name="note"]').value = 'From the design team';
  doc.getElementById('guestUnlockForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(bodies['/api/guest/unlock'].body).toMatchObject({ linkSecret: secret, displayName: 'Visitor', note: 'From the design team' });

  doc.getElementById('guestAccountRequestButton').click();
  await settle();
  expect(bodies['/api/user/shared/link-requests'].body).toEqual({ linkSecret: secret, note: 'From the design team' });
  expect(bodies['/api/user/shared/link-requests'].headers['X-CSRF-Token']).toBe('account-csrf');
  expect(doc.getElementById('guestStatus').textContent).toContain('Request sent. Alex will see it');
  dom.window.close();
});
