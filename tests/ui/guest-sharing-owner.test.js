/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder ||= TextEncoder;
global.TextDecoder ||= TextDecoder;
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../../public/js/guest-sharing.js'), 'utf8');
const shareSecret = 'a'.repeat(43);

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function createDom(fetchImpl) {
  const dom = new JSDOM(`
    <main id="guestSharingApp" data-csrf="csrf-token" data-user-id="owner-id">
      <p id="guestOwnerKeyStatus"></p><p id="guestSharingError"></p><p id="guestSharingStatus"></p>
      <form id="guestShareForm">
        <div id="guestAgentSelection"></div><span id="guestSelectionPreview"></span>
        <input name="title"><select name="roomMode"><option value="separate">Separate</option><option value="common">Common</option></select>
        <input name="expiresAt"><input id="guestPasswordEnabled" name="passwordEnabled" type="checkbox">
        <label id="guestPasswordField"><input name="password"></label><button id="guestCreateShare" type="submit"></button>
      </form>
      <aside id="guestCreatedLink" hidden><input id="guestCreatedLinkValue"><button id="guestCopyLink"></button><p id="guestCopyStatus"></p></aside>
      <button id="guestRefreshShares"></button><div id="guestShares"></div>
    </main>`, { url: 'https://space.example/guest-sharing', runScripts: 'outside-only' });
  dom.window.fetch = jest.fn(fetchImpl);
  dom.window.Headers = global.Headers;
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.E2EEncryption = { getStoredEncryptionKey: jest.fn().mockResolvedValue(null) };
  dom.window.navigator.clipboard = { writeText: jest.fn().mockResolvedValue(undefined) };
  dom.window.confirm = jest.fn().mockReturnValue(true);
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom;
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function initialFetch() {
  return async (url, options = {}) => {
    if (url === '/api/user/agents') return response({ agents: [
      { agentId: 'agent-one', name: 'One', lastSeenAt: new Date().toISOString() },
      { agentId: 'agent-two', name: 'Two', lastSeenAt: null }
    ] });
    if (url === '/api/user/shared/devices') return response([]);
    if (url === '/api/user/shared') return response({ agents: [] });
    if (url === '/api/user/shared/guest-shares' && options.method === 'POST') return response({
      shareId: 'share-one', linkSecret: shareSecret, agents: [{ agentId: 'agent-one' }, { agentId: 'agent-two' }]
    });
    if (url === '/api/user/shared/guest-shares') return response([]);
    throw new Error(`Unexpected request ${url}`);
  };
}

test('selects one or several agents and only reports a share after the server returns a link', async () => {
  const dom = createDom(initialFetch());
  await settle();
  const checkboxes = [...dom.window.document.querySelectorAll('#guestAgentSelection input[type="checkbox"]')];
  expect(checkboxes).toHaveLength(2);
  expect(dom.window.document.querySelector('#guestSelectionPreview').textContent).toBe('0 agents selected');

  dom.window.document.querySelector('[data-agent-id="agent-one"]').click();
  expect(checkboxes.map(input => input.checked)).toEqual([true, false]);
  dom.window.document.querySelector('#guestAgentSelection input[value="agent-two"]').click();
  expect(checkboxes.map(input => input.checked)).toEqual([true, true]);

  const form = dom.window.document.getElementById('guestShareForm');
  form.elements.roomMode.value = 'common';
  form.elements.passwordEnabled.checked = true;
  form.elements.password.value = 'a sufficiently long password';
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  const create = dom.window.fetch.mock.calls.find(([url, options]) => url === '/api/user/shared/guest-shares' && options.method === 'POST');
  expect(create).toBeTruthy();
  expect(JSON.parse(create[1].body)).toMatchObject({
    agentIds: ['agent-one', 'agent-two'],
    roomMode: 'common',
    password: 'a sufficiently long password'
  });
  expect(dom.window.document.getElementById('guestCreatedLinkValue').value).toBe(`https://space.example/guest#${shareSecret}`);
  expect(dom.window.document.getElementById('guestShareForm').elements.password.value).toBe('');
  expect(dom.window.document.getElementById('guestSharingError').textContent).toBe('');
  dom.window.close();
});

test('renders the current allowlist and guest audience without exposing stored password material', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/user/agents') return response({ agents: [] });
    if (url === '/api/user/shared/devices') return response([]);
    if (url === '/api/user/shared') return response({ agents: [] });
    if (url === '/api/user/shared/guest-shares') return response([{ shareId: 'share-one', password_revision: 2 }]);
    if (url === '/api/user/shared/guest-shares/share-one') return response({
      shareId: 'share-one', room_mode: 'separate', password_revision: 2,
      agents: [{ agent_id: 'agent-one', agent_name: 'One', room_id: 'room-one', removed_at: null }],
      guests: [{ guest_id: 'guest-one', display_name: 'Guest One', status: 'active', public_key: { kty: 'RSA' } }]
    });
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = createDom(fetchImpl);
  await settle();
  const text = dom.window.document.getElementById('guestShares').textContent;
  expect(text).toContain('One');
  expect(text).toContain('Guest One');
  expect(text).toContain('Provision pending keys');
  expect(text).not.toContain('password_hash');
  expect(text).not.toContain('password_revision');
  expect(dom.window.document.querySelector('input[placeholder="New password (optional)"]')).toBeTruthy();
  dom.window.close();
});

test('keeps failed creation visible as an error without a false success link', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/user/agents') return response({ agents: [{ agentId: 'agent-one', name: 'One', lastSeenAt: null }] });
    if (url === '/api/user/shared/devices') return response([]);
    if (url === '/api/user/shared') return response({ agents: [] });
    if (url === '/api/user/shared/guest-shares' && options.method === 'POST') return response({ error: { message: 'Selected agent is unavailable' } }, 403);
    if (url === '/api/user/shared/guest-shares') return response([]);
    throw new Error(`Unexpected request ${url}`);
  };
  const dom = createDom(fetchImpl);
  await settle();
  dom.window.document.querySelector('#guestAgentSelection input').click();
  dom.window.document.getElementById('guestShareForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(dom.window.document.getElementById('guestSharingError').textContent).toBe('Selected agent is unavailable');
  expect(dom.window.document.getElementById('guestCreatedLink').hidden).toBe(true);
  expect(dom.window.document.getElementById('guestSharingStatus').textContent).toBe('');
  dom.window.close();
});

test('owner provisions the complete audience and retries a conflicting room snapshot', async () => {
  let keyAttempts = 0;
  const target = { guest_id: 'guest-one', display_name: 'Guest One', status: 'active', public_key: { label: 'guest' },
    rooms: [{ room_id: 'separate-room', agent_id: 'agent-one', agent_name: 'One' }] };
  const dom = createDom(async (url, options = {}) => {
    if (url === '/api/user/agents') return response({ agents: [] });
    if (url === '/api/user/shared/devices') return response([]);
    if (url === '/api/user/shared') return response({ agents: [] });
    if (url === '/api/user/shared/guest-shares') return response([{ shareId: 'share-one' }]);
    if (url === '/api/user/shared/guest-shares/share-one') return response({ shareId: 'share-one', room_mode: 'separate',
      agents: [{ agent_id: 'agent-one', agent_name: 'One', room_id: null }], guests: [target] });
    if (url === '/api/user/shared/identity') return response({ private_key: 'wrapped-owner-identity' });
    if (url === '/api/user/shared/separate-room') return response({
      room: { key_version: 2, membership_version: 5, rotation_required: true },
      members: [{ user_id: 'owner-id', status: 'active', public_key: { label: 'owner' } },
        { user_id: 'friend-id', status: 'active', public_key: { label: 'friend' } }],
      guests: [{ guest_id: 'guest-two', status: 'active', public_key: { label: 'other guest' } }, target],
      agentIdentity: { public_key: { label: 'agent' } }, keys: []
    });
    if (url === '/api/user/shared/separate-room/messages?after=0') return response([]);
    if (url === '/api/user/shared/guest-shares/share-one/keys' && options.method === 'POST') {
      keyAttempts++;
      return keyAttempts === 1
        ? response({ error: { message: 'Guest room changed; refresh before provisioning' } }, 409)
        : response({ ok: true });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  dom.window.E2EEncryption.getStoredEncryptionKey.mockResolvedValue({});
  dom.window.SharedCrypto = { privateKey: async () => ({}), newKey: async () => ({}), wrap: async (_key, publicKey) => publicKey.label };
  await settle();
  [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Provision pending keys').click();
  await settle();
  const provision = dom.window.fetch.mock.calls.find(([url, options]) => url.endsWith('/share-one/keys') && options.method === 'POST');
  expect(provision).toBeTruthy();
  const body = JSON.parse(provision[1].body);
  expect(body.rooms).toEqual([{ roomId: 'separate-room', keyVersion: 2, membershipVersion: 5, rotationRequired: true }]);
  expect(new Set(body.envelopes.map(item => item.principal))).toEqual(new Set(['user:owner-id', 'user:friend-id', 'agent:agent-one', 'guest:guest-one', 'guest:guest-two']));
  expect(body.envelopes.every(item => item.roomId === 'separate-room' && item.keyVersion === 3)).toBe(true);
  expect(keyAttempts).toBe(2);
  expect(dom.window.document.getElementById('guestSharingError').textContent).toBe('');
  dom.window.close();
});

test('refresh blocks stale guest controls and cannot overwrite a newer share list or completion', async () => {
  let loads = 0;
  let releaseOldLoad;
  const oldLoad = new Promise(resolve => { releaseOldLoad = resolve; });
  const base = initialFetch();
  const dom = createDom(async (url, options = {}) => {
    if (url === '/api/user/shared/guest-shares' && options.method !== 'POST') {
      loads++;
      if (loads === 2) return oldLoad;
      return response(loads === 1 ? [] : [{ shareId: 'share-new' }]);
    }
    if (url === '/api/user/shared/guest-shares/share-new') return response({
      shareId: 'share-new', title: 'Latest share', room_mode: 'common', agents: [], guests: []
    });
    if (url === '/api/user/shared/guest-shares/share-old') return response({
      shareId: 'share-old', title: 'Stale share', room_mode: 'common', agents: [], guests: []
    });
    return base(url, options);
  });
  await settle();
  const list = dom.window.document.getElementById('guestShares');
  const refresh = dom.window.document.getElementById('guestRefreshShares');
  refresh.click();
  expect(refresh.disabled).toBe(true);
  expect(list.hasAttribute('inert')).toBe(true);
  expect(list.getAttribute('aria-busy')).toBe('true');
  dom.window.document.querySelector('#guestAgentSelection input').click();
  dom.window.document.getElementById('guestShareForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(list.textContent).toContain('Latest share');
  expect(list.hasAttribute('inert')).toBe(false);
  expect(refresh.disabled).toBe(false);
  releaseOldLoad(response([{ shareId: 'share-old' }]));
  await settle();
  expect(list.textContent).toContain('Latest share');
  expect(list.textContent).not.toContain('Stale share');
  expect(dom.window.document.getElementById('guestSharingStatus').textContent).toContain('Share created.');
  dom.window.close();
});

test('trusted agents show existing permissions and need no separate execution grant', async () => {
  const base = initialFetch();
  const dom = createDom(async (url, options = {}) => {
    if (url === '/api/user/shared') return response({ agents: [{ agent_id: 'agent-one',
      last_seen_at: new Date().toISOString(), capabilities: { executionMode: 'trusted' } }] });
    if (url === '/api/user/shared/guest-shares') return response([{ shareId: 'trusted-share' }]);
    if (url === '/api/user/shared/guest-shares/trusted-share') return response({ shareId: 'trusted-share',
      agents: [{ agent_id: 'agent-one', agent_name: 'One', execution_mode: 'trusted' }],
      guests: [{ guest_id: 'guest-one', display_name: 'Guest One', status: 'active', public_key: {} }] });
    return base(url, options);
  });
  await settle();
  expect(dom.window.document.getElementById('guestAgentSelection').textContent).toContain('Sharing connected · Uses existing agent permissions');
  expect(dom.window.document.getElementById('guestShares').textContent).toContain('Uses existing agent permissions');
  expect([...dom.window.document.querySelectorAll('button')].some(button => button.textContent === 'Execution permissions')).toBe(false);
  dom.window.close();
});
