/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const importScript = fs.readFileSync(path.join(__dirname, '../../public/js/chat-history-import.js'), 'utf8');
const helpers = dashboard.slice(dashboard.indexOf('/**\n * Fetch a fresh CSRF token'), dashboard.indexOf('\nfunction isOpenClawProvider'));
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, clone() { return response(body, status); } });
const invalid = () => response({ error: { code: 'CSRF_TOKEN_INVALID', message: 'Invalid CSRF token' } }, 403);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function install(fetchMock) {
  window.csrfToken = 'stale';
  window.fetch = fetchMock;
  window.csrfFetch = new Function('window', 'fetch', helpers + '\nreturn csrfFetch;')(window, fetchMock);
}
afterEach(() => { delete window.csrfFetch; });

test('a stale token recovers once without changing the mutation body or caller options', async () => {
  const sent = [];
  const fetchMock = jest.fn(async (url, options) => {
    sent.push({ url, ...options, headers: { ...options.headers } });
    if (url === '/csrf-token') return response({ csrfToken: 'fresh' });
    return options.headers['X-CSRF-Token'] === 'fresh' ? response({ ok: true }) : invalid();
  });
  install(fetchMock);
  const options = { method: 'POST', headers: { 'X-CSRF-Token': 'stale' }, body: 'same-encrypted-payload' };
  expect((await window.csrfFetch('/api/user/shared/room/messages', options)).ok).toBe(true);
  expect(sent.map(call => call.url)).toEqual(['/api/user/shared/room/messages', '/csrf-token', '/api/user/shared/room/messages']);
  expect(sent[1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
  expect(sent[0].body).toBe(sent[2].body);
  expect(options.headers['X-CSRF-Token']).toBe('stale');
  expect(window.csrfToken).toBe('fresh');
});

test('concurrent rejected requests share one token refresh', async () => {
  let finishRefresh;
  const fetchMock = jest.fn(async (url, options) => {
    if (url === '/csrf-token') return new Promise(resolve => { finishRefresh = resolve; });
    return options.headers['X-CSRF-Token'] === 'fresh' ? response({ ok: true }) : invalid();
  });
  install(fetchMock);
  const options = { method: 'DELETE', headers: { 'X-CSRF-Token': 'stale' } };
  const requests = [window.csrfFetch('/api/user/shared/one', options), window.csrfFetch('/api/user/shared/two', options)];
  await tick();
  expect(fetchMock.mock.calls.filter(([url]) => url === '/csrf-token')).toHaveLength(1);
  finishRefresh(response({ csrfToken: 'fresh' }));
  expect((await Promise.all(requests)).every(item => item.ok)).toBe(true);
});

test('permission errors and read requests never trigger token recovery', async () => {
  const fetchMock = jest.fn(async () => response({ error: { code: 'FORBIDDEN' } }, 403));
  install(fetchMock);
  await window.csrfFetch('/api/user/shared/room', { method: 'PATCH', headers: { 'X-CSRF-Token': 'stale' } });
  fetchMock.mockImplementation(async () => invalid());
  await window.csrfFetch('/api/user/shared/room', { method: 'GET', headers: { 'X-CSRF-Token': 'stale' } });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each(['CSRF_TOKEN_MISSING', 'CSRF_TOKEN_EXPIRED'])('recovers once for %s with case-insensitive headers', async code => {
  const fetchMock = jest.fn(async (url, options) => {
    if (url === '/csrf-token') return response({ csrfToken: 'fresh' });
    return options.headers['x-csrf-token'] === 'fresh' ? response({ ok: true }) : response({ error: { code } }, 403);
  });
  install(fetchMock);
  const result = await window.csrfFetch('/api/user/shared/room', { method: 'patch', headers: [['x-csrf-token', 'stale'], ['Content-Type', 'application/json']], body: '{}' });
  expect(result.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][1].headers['Content-Type']).toBe('application/json');
});

test('repeated rejection stops after one retry and failed refresh preserves the original response', async () => {
  const fetchMock = jest.fn(async url => url === '/csrf-token' ? response({ csrfToken: 'fresh' }) : invalid());
  install(fetchMock);
  const options = { method: 'POST', headers: { 'X-CSRF-Token': 'stale' }, body: new FormData() };
  expect((await window.csrfFetch('/api/user/shared/room/files', options)).status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[2][1].body);
  fetchMock.mockClear();
  fetchMock.mockImplementation(async url => url === '/csrf-token' ? response({}) : invalid());
  expect((await window.csrfFetch('/api/user/shared/room/files', options)).status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('opening Share recovers from stale CSRF and leaves the email field and Share button usable', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><button id="shareExistingChatRetry" hidden></button><div id="shareExistingChatInvites" hidden><input id="shareInviteEmail"><button id="shareInviteSubmit"></button></div><button id="shareExistingChatPrepare" disabled></button></div><button id="headerShareExistingChatBtn"></button>`;
  window.DashboardHelpers = { getSelectedAgentIdentity: () => ({ agentId: 'agent', agentName: 'Mira', mode: 'private', role: 'owner' }) };
  let resolveCount = 0;
  install(jest.fn(async (url, options) => {
    if (url === '/csrf-token') return response({ csrfToken: 'fresh' });
    if (url.endsWith('/resolve')) {
      resolveCount++;
      return options.headers['X-CSRF-Token'] === 'fresh' ? response({ agentId: 'agent', conversationId: 'room', state: 'private' }) : invalid();
    }
    if (url.endsWith('/share-preview')) return response({ agentName: 'Mira', includedMessages: 2 });
    return response([]);
  }));
  window.eval(importScript);
  document.getElementById('headerShareExistingChatBtn').click();
  document.getElementById('shareInviteEmail').value = 'person@example.com';
  for (let i = 0; i < 20 && document.getElementById('shareExistingChatPrepare').disabled; i++) await tick();
  expect(resolveCount).toBe(2);
  expect(document.getElementById('shareExistingChatPrepare').disabled).toBe(false);
  expect(document.getElementById('shareInviteEmail').disabled).toBe(false);
  expect(document.getElementById('shareInviteEmail').value).toBe('person@example.com');
  expect(document.getElementById('shareExistingChatStatus').textContent).not.toContain('Invalid CSRF');
});

test('a failed preview offers retry in the same panel and preserves the typed email', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><button id="shareExistingChatRetry" hidden>Try again</button><div id="shareExistingChatInvites" hidden><input id="shareInviteEmail"><button id="shareInviteSubmit"></button></div><button id="shareExistingChatPrepare" disabled></button></div><button id="headerShareExistingChatBtn"></button>`;
  window.DashboardHelpers = { getSelectedAgentIdentity: () => ({ agentId: 'agent', mode: 'private', role: 'owner' }) };
  let fail = true;
  window.fetch = jest.fn(async url => {
    if (url.endsWith('/resolve')) {
      if (fail) throw new Error('Connection interrupted');
      return response({ agentId: 'agent', conversationId: 'room', state: 'private' });
    }
    if (url.endsWith('/share-preview')) return response({ includedMessages: 2 });
    return response([]);
  });
  window.eval(importScript);
  document.getElementById('headerShareExistingChatBtn').click();
  await tick();
  const retry = document.getElementById('shareExistingChatRetry');
  expect(retry.hidden).toBe(false);
  expect(document.getElementById('shareExistingChatPreview').hidden).toBe(true);
  document.getElementById('shareInviteEmail').value = 'person@example.com';
  fail = false;
  retry.click();
  for (let i = 0; i < 20 && document.getElementById('shareExistingChatPrepare').disabled; i++) await tick();
  expect(document.getElementById('shareExistingChatPrepare').disabled).toBe(false);
  expect(document.getElementById('shareInviteEmail').value).toBe('person@example.com');
  expect(retry.hidden).toBe(true);
});
