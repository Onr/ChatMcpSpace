/* global SharedCrypto */
'use strict';

(function (root) {
  const C = root.SharedCrypto;
  const workspacePanel = document.getElementById('guestWorkspace');
  if (!workspacePanel) return;
  const $ = id => document.getElementById(id);
  const state = {
    csrfToken: '',
    workspace: null,
    identity: null,
    guestId: '',
    activeRoomId: null,
    renderedRoomId: null,
    timelineBinding: null,
    roomListSignature: null,
    context: null,
    keys: new Map(),
    generation: 0,
    roomEpoch: 0,
    receiptRequest: null,
    receiptCursor: 0,
    polling: false,
    mutating: false,
    roomLoading: false,
    loadingOlder: false,
    bound: false,
    timer: null,
    objectUrls: [],
    drafts: new Map(),
    messagesByRoom: new Map(),
    messageUpdateCursors: new Map(),
    hasOlderByRoom: new Map(),
    onSessionEnded: null
  };

  function errorObject(response, data) {
    return Object.assign(new Error(data?.error?.message || 'Guest request failed'), { status: response.status });
  }

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (state.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['x-guest-csrf'] = state.csrfToken;
    const request = { ...options, method, credentials: 'same-origin', headers };
    const isFormData = typeof root.FormData !== 'undefined' && request.body instanceof root.FormData;
    if (request.body && typeof request.body !== 'string' && !isFormData) {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }
    const response = await root.fetch('/api/guest' + path, request);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw errorObject(response, data);
    return data;
  }

  function message(text) {
    $('guestWorkspaceStatus').textContent = text || '';
  }

  function conversationMessage(text) {
    $('guestConversationStatus').textContent = text || '';
  }

  function clearTimeline() {
    state.renderedRoomId = null;
    state.timelineBinding = null;
    $('guestTimeline').replaceChildren();
    revokeObjectUrls();
  }

  function syncActionState() {
    const busy = state.mutating || state.roomLoading;
    document.querySelectorAll('#guestTimeline button[data-guest-action], #guestComposer button[type="submit"]')
      .forEach(button => { button.disabled = busy; });
    // Rich forms keep their DOM and drafts across polls, but their submission
    // must wait for the current room/key refresh just like the composer does.
    document.querySelectorAll('#guestTimeline [data-sharing-rich] button[type="submit"], #guestTimeline [data-sharing-rich] input[type="submit"]')
      .forEach(button => {
        if (busy && !button.disabled) {
          button.dataset.guestRefreshDisabled = 'true';
          button.disabled = true;
        } else if (!busy && button.dataset.guestRefreshDisabled) {
          delete button.dataset.guestRefreshDisabled;
          if (!button.classList.contains('rich-form-submitted') && !button.closest('.rich-form-disabled')) button.disabled = false;
        }
      });
  }

  function setMutating(value) {
    state.mutating = value;
    syncActionState();
  }

  function currentRoom() {
    return state.workspace?.rooms?.find(room => room.roomId === state.activeRoomId) || null;
  }

  function roomStatus(room) {
    if (room.status !== 'active') return 'Waiting for the owner to approve you';
    if (room.rotationRequired) return 'Key rotation required';
    if (!room.keyReady) return 'Encrypted access pending';
    return 'Ready';
  }

  function agentAvatar() {
    const avatar = document.createElement('span');
    avatar.className = 'chat-avatar chat-avatar-agent';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="7" width="14" height="12" rx="4"/><path d="M12 3v4M2 11v4m20-4v4M9 15h6"/><circle cx="9" cy="11" r=".6"/><circle cx="15" cy="11" r=".6"/></svg>';
    return avatar;
  }

  function renderRooms() {
    const list = $('guestRooms');
    const rooms = state.workspace?.rooms || [];
    const signature = JSON.stringify([state.activeRoomId, rooms.map(room =>
      [room.roomId, room.agentName, room.status, room.rotationRequired, room.keyReady])]);
    if (signature === state.roomListSignature) return;
    state.roomListSignature = signature;
    list.replaceChildren();
    if (!rooms.length) {
      list.append(Object.assign(document.createElement('p'), { textContent: 'No agents are currently shared.', className: 'guest-empty' }));
      return;
    }
    rooms.forEach(room => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'guest-room-button chat-room';
      button.dataset.chatRoom = room.roomId;
      button.setAttribute('aria-current', String(room.roomId === state.activeRoomId));
      const avatar = agentAvatar();
      const copy = Object.assign(document.createElement('span'), { className: 'chat-room-copy' });
      copy.append(Object.assign(document.createElement('strong'), { textContent: room.agentName || 'Shared agent' }));
      const detail = document.createElement('small');
      detail.textContent = roomStatus(room);
      copy.append(detail);
      button.append(avatar, copy);
      button.addEventListener('click', () => selectRoom(room.roomId));
      list.append(button);
    });
  }

  function displayName(principal) {
    if (!principal) return 'Participant';
    if (principal.kind === 'guest') {
      const guest = (state.context?.guests || []).find(item => item.id === principal.id);
      return `${guest?.displayName || 'Guest'} · Guest${principal.id === state.guestId ? ' (You)' : ''}`;
    }
    const member = (state.context?.members || []).find(item => item.id === principal.id);
    return `${member?.displayName || 'Registered participant'} · Account`;
  }

  function principalFromValue(value) {
    if (!value) return null;
    const separator = value.indexOf(':');
    if (separator < 1) return null;
    const kind = value.slice(0, separator);
    const id = value.slice(separator + 1);
    return ['user', 'guest'].includes(kind) && id ? { kind, id } : null;
  }

  function principalLabel(kind, id) {
    return displayName({ kind, id });
  }

  function renderAudience() {
    const audience = $('guestAudience');
    audience.replaceChildren();
    const people = [...(state.context?.members || []), ...(state.context?.guests || [])]
      .filter(person => person.status === 'active' || person.id === state.guestId);
    people.forEach(person => {
      const tag = document.createElement('span');
      const role = person.kind === 'guest' ? 'Guest participant · unverified identity' : `${person.role} · registered account`;
      tag.textContent = `${person.displayName} · ${role}${person.id === state.guestId ? ' · You' : ''}`;
      audience.append(tag);
    });
    const button = $('guestPeopleButton');
    if (button) {
      const count = people.filter(person => person.status === 'active').length;
      button.querySelector('[data-guest-people-count]').textContent = String(count);
      button.setAttribute('aria-label', `View ${count} people in this chat`);
      button.disabled = false;
    }
  }

  function renderAddressOptions() {
    const select = $('guestAddress');
    const old = select.value;
    const people = [...(state.context?.members || []), ...(state.context?.guests || [])]
      .filter(person => person.status === 'active');
    const choices = [{ value: '', text: 'Everyone' }, ...people.map(person => ({
      value: `${person.kind}:${person.id}`, text: principalLabel(person.kind, person.id)
    }))];
    const existing = new Map([...select.options].map(option => [option.value, option]));
    const wanted = new Set(choices.map(choice => choice.value));
    for (const option of [...select.options]) if (!wanted.has(option.value)) option.remove();
    choices.forEach((choice, index) => {
      const option = existing.get(choice.value) || document.createElement('option');
      if (option.value !== choice.value) option.value = choice.value;
      if (option.textContent !== choice.text) option.textContent = choice.text;
      if (select.options[index] !== option) select.insertBefore(option, select.options[index] || null);
    });
    const value = wanted.has(old) ? old : '';
    if (select.value !== value) select.value = value;
  }

  function messagePrincipal(message) {
    if (message.sender_guest_id) return { kind: 'guest', id: message.sender_guest_id };
    if (message.sender_user_id) return { kind: 'user', id: message.sender_user_id };
    if (message.sender_agent_id) return { kind: 'agent', id: message.sender_agent_id };
    return null;
  }

  function senderLabel(message) {
    const principal = messagePrincipal(message);
    if (!principal) return 'Participant';
    if (principal.kind === 'agent') return currentRoom()?.agentName || state.context?.agentIdentity?.display_name || 'Agent';
    if (principal.kind === 'guest' && principal.id === state.guestId) return 'You';
    return displayName(principal);
  }

  function addressedLabel(message) {
    const typed = Array.isArray(message.addressed_to_principals) ? message.addressed_to_principals : [];
    if (typed.length) return typed.map(item => displayName(item)).join(', ');
    const users = Array.isArray(message.addressed_to) ? message.addressed_to : [];
    return users.map(id => displayName({ kind: 'user', id })).join(', ');
  }

  function audienceLabel(message) {
    const recipients = Array.isArray(message.recipient_principals) ? message.recipient_principals : [];
    if (!recipients.length) return '';
    const ownerId = String(state.context?.room?.ownerId || state.context?.room?.owner_id || '');
    const names = recipients.map(target => {
      if (target.kind === 'user' && String(target.id) === ownerId) return 'Owner';
      return displayName(target);
    });
    return names.includes('Owner') ? `Owner${names.filter(name => name !== 'Owner').length ? ' + ' + [...new Set(names.filter(name => name !== 'Owner'))].join(', ') : ' only'}` : names.join(', ');
  }

  function action(text, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset.guestAction = 'true';
    button.disabled = state.mutating || state.roomLoading;
    button.addEventListener('click', () => Promise.resolve().then(handler).catch(error => conversationMessage(error.message)));
    return button;
  }

  function messageOutboxKey(roomId, suffix = 'message') {
    return `guest-outbox:${state.workspace.share.shareId}:${state.guestId}:${roomId}:${suffix}`;
  }

  function readOutbox(key) {
    try {
      const value = root.sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (_) {
      throw new Error('Encrypted retry storage is unavailable; the message was not sent.');
    }
  }

  function writeOutbox(key, value) {
    try {
      root.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      throw new Error('Encrypted retry storage is unavailable; the message was not sent.');
    }
  }

  function clearOutbox(key) {
    try {
      root.sessionStorage.removeItem(key);
    } catch (_) {
      // A successful send is already committed; inability to clear local state is handled on the next retry by server idempotency.
    }
  }

  function revokeObjectUrls() {
    for (const url of state.objectUrls.splice(0)) {
      try { root.URL?.revokeObjectURL?.(url); } catch (_) { /* Cleanup is best effort. */ }
    }
  }

  function safeFileName(value) {
    return String(value || 'download').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 180) || 'download';
  }

  function previewable(type) {
    return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(type || '').toLowerCase());
  }

  function richDataFor(content) {
    const candidate = content && typeof content === 'object' && typeof content.text === 'string' ? content.text : content;
    if (!root.RichRendering?.detectRichContent) return null;
    if (typeof candidate === 'string') return root.RichRendering.detectRichContent(candidate);
    if (candidate && typeof candidate === 'object') return root.RichRendering.detectRichContent(JSON.stringify(candidate));
    return null;
  }

  async function sendRichResponse(message, text, generation) {
    const roomId = state.activeRoomId;
    if (!roomId || generation !== state.generation) throw new Error('This interactive form is no longer attached to the selected conversation.');
    if (state.mutating) throw new Error('Please wait for the current guest request to finish.');
    const version = Number(state.context?.room?.keyVersion);
    const key = state.keys.get(version);
    const keys = new Map(state.keys);
    if (!key || state.context?.member?.status !== 'active') throw new Error('Encrypted guest access is still pending.');
    const outboxKey = messageOutboxKey(roomId, `rich:${message.id}`);
    setMutating(true);
    try {
      let body = readOutbox(outboxKey);
      if (!body) {
        body = {
          id: root.crypto.randomUUID(),
          keyVersion: version,
          payload: await C.encrypt(key, { text: String(text || '') }, `${roomId}:${version}`),
          addressedToPrincipals: [],
          replyTo: [message.id]
        };
        writeOutbox(outboxKey, body);
      }
      await sendPrepared(`/rooms/${encodeURIComponent(roomId)}/messages`, body, outboxKey, roomId, version, key, keys);
      clearOutbox(outboxKey);
      if (generation === state.generation && state.activeRoomId === roomId) await refreshRoom();
    } finally {
      setMutating(false);
    }
  }

  async function attachmentBytes(roomId, keys, message, file) {
    const response = await root.fetch(`/api/guest/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.id)}`, {
      credentials: 'same-origin',
      headers: state.csrfToken ? { 'x-guest-csrf': state.csrfToken } : {}
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw errorObject(response, data);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const version = Number(response.headers?.get?.('X-Shared-Key-Version')) || Number(message.key_version);
    const key = keys.get(version);
    if (!key || bytes.length <= 12) throw new Error('Attachment decryption key unavailable.');
    return root.crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(`${roomId}:${version}`)
    }, key, bytes.slice(12));
  }

  async function downloadAttachment(message, file, roomId, generation) {
    if (state.activeRoomId !== roomId || state.generation !== generation) throw new Error('This attachment belongs to the previously selected conversation.');
    const plain = await attachmentBytes(roomId, new Map(state.keys), message, file);
    if (state.activeRoomId !== roomId || state.generation !== generation) throw new Error('The conversation changed during the download.');
    const url = root.URL.createObjectURL(new root.Blob([plain], { type: previewable(file.type) ? file.type : 'application/octet-stream' }));
    state.objectUrls.push(url);
    return { url, name: safeFileName(file.name), preview: previewable(file.type) };
  }

  async function sendPrepared(url, body, outboxKey, roomId, version, key, keys) {
    try {
      return await api(url, { method: 'POST', body });
    } catch (error) {
      // First retry the original ciphertext. A committed response remains
      // idempotent even after rotation; only an explicit stale-key rejection
      // permits rekeying the retained request with the same identifiers.
      if (error.status !== 409 || error.message !== 'Stale conversation key' || Number(body.keyVersion) === version) throw error;
      const oldVersion = Number(body.keyVersion);
      const oldKey = keys.get(oldVersion);
      if (!oldKey) throw new Error('The retry needs its original encryption key. Ask the owner to provision retained keys.');
      const content = await C.decrypt(oldKey, body.payload, `${roomId}:${oldVersion}`);
      for (const file of content.files || []) {
        const plain = await attachmentBytes(roomId, keys, { key_version: oldVersion }, file);
        const encrypted = await encryptFile({ name: file.name, type: file.type, size: plain.byteLength, arrayBuffer: async () => plain }, key, roomId, version);
        encrypted.id = file.id;
        await uploadGuestFile(roomId, version, encrypted);
      }
      const replacement = { ...body, keyVersion: version, payload: await C.encrypt(key, content, `${roomId}:${version}`) };
      writeOutbox(outboxKey, replacement);
      return api(url, { method: 'POST', body: replacement });
    }
  }

  async function uploadGuestFile(roomId, version, encrypted) {
    const form = new root.FormData();
    form.append('id', encrypted.id);
    form.append('keyVersion', String(version));
    form.append('file', new root.Blob([encrypted.bytes], { type: 'application/octet-stream' }), 'encrypted.bin');
    await api(`/rooms/${encodeURIComponent(roomId)}/files`, { method: 'POST', body: form });
  }

  async function deleteUnlinkedFile(roomId, fileId) {
    try {
      await api(`/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', body: {} });
    } catch (_) {
      // The server expires unlinked encrypted uploads; cleanup must not hide the original send failure.
    }
  }

  async function encryptFile(file, key, roomId, version) {
    const type = String(file.type || 'application/octet-stream').toLowerCase();
    if (type.startsWith('image/') && !previewable(type)) throw new Error('Only PNG, JPEG, GIF and WebP images are supported.');
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await root.crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(`${roomId}:${version}`)
    }, key, await file.arrayBuffer()));
    const bytes = new Uint8Array(iv.length + ciphertext.length);
    bytes.set(iv);
    bytes.set(ciphertext, iv.length);
    const id = root.crypto.randomUUID();
    return {
      id,
      bytes,
      metadata: {
        name: safeFileName(file.name),
        type,
        size: file.size
      }
    };
  }

  function historyPageSize(before) {
    return root.innerWidth < 768 ? (String(before) === '9223372036854775807' ? 30 : 50) : 200;
  }
  async function allMessages(roomId, generation, after = 0, since = null, before = null) {
    const messages = [];
    if (before !== null) {
      const query = new URLSearchParams({ before: String(before), limit: String(historyPageSize(before)) });
      const page = await api(`/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
      return generation === state.generation ? page : null;
    }
    for (;;) {
      const query = new URLSearchParams({ after: String(after) });
      if (since) query.set('since', since);
      const page = await api(`/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
      if (generation !== state.generation) return null;
      messages.push(...page);
      if (page.length < 200) return messages;
      after = page[page.length - 1].seq;
    }
  }

  function syncHistoryStatus() {
    const notice = $('guestHistoryStatus');
    if (notice) {
      notice.textContent = state.loadingOlder ? 'Loading earlier messages…' : '';
      notice.hidden = !state.loadingOlder;
    }
    $('guestTimeline')?.setAttribute('aria-busy', String(state.loadingOlder));
  }

  async function loadOlderMessages() {
    const roomId = state.activeRoomId;
    const current = state.messagesByRoom.get(roomId) || [];
    if (!roomId || !current.length || !state.hasOlderByRoom.get(roomId) || state.roomLoading || state.polling || state.loadingOlder) return;
    const generation = state.generation;
    const before = Math.min(...current.map(item => Number(item.seq) || Infinity));
    const log = $('guestTimeline');
    const priorHeight = log.scrollHeight;
    state.loadingOlder = true;
    syncHistoryStatus();
    try {
      const older = await allMessages(roomId, generation, 0, null, before);
      if (!older || generation !== state.generation || roomId !== state.activeRoomId) return;
      const byId = new Map(older.concat(current).map(item => [item.id, item]));
      const merged = [...byId.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
      state.messagesByRoom.set(roomId, merged);
      state.hasOlderByRoom.set(roomId, older.length === historyPageSize(before));
      await renderMessages(merged, generation);
      if (generation === state.generation && roomId === state.activeRoomId) log.scrollTop += Math.max(0, log.scrollHeight - priorHeight);
    } finally {
      state.loadingOlder = false;
      syncHistoryStatus();
    }
  }

  function canGuestAnswer(question) {
    const users = Array.isArray(question.addressed_to) ? question.addressed_to : [];
    const principals = Array.isArray(question.addressed_to_principals) ? question.addressed_to_principals : [];
    return !users.length && (!principals.length || principals.some(item => item?.kind === 'guest' && item.id === state.guestId));
  }

  async function answerQuestion(question, answerText, generation) {
    const roomId = state.activeRoomId;
    if (!roomId || generation !== state.generation) throw new Error('This question belongs to the previously selected conversation.');
    if (state.mutating) throw new Error('Please wait for the current guest request to finish.');
    if (!state.context || state.context.member.status !== 'active') throw new Error('Encrypted guest access is still pending.');
    const version = Number(state.context.room.keyVersion);
    const key = state.keys.get(version);
    const keys = new Map(state.keys);
    if (!key) throw new Error('Conversation key unavailable.');
    const keyName = messageOutboxKey(roomId, `answer:${question.id}`);
    setMutating(true);
    try {
      let body = readOutbox(keyName);
      if (!body) {
        body = {
          id: root.crypto.randomUUID(),
          keyVersion: version,
          payload: await C.encrypt(key, { text: answerText }, `${roomId}:${version}`)
        };
        writeOutbox(keyName, body);
      }
      await sendPrepared(`/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(question.id)}/answer`, body, keyName, roomId, version, key, keys);
      clearOutbox(keyName);
      if (generation === state.generation && state.activeRoomId === roomId) {
        conversationMessage('Answer sent to the shared conversation.');
        await refreshRoom();
      }
    } finally { setMutating(false); }
  }

  async function promptAnswer(question, generation, option = null) {
    const answer = option || root.prompt?.('Answer this question for everyone in the conversation:') || '';
    if (!answer.trim()) return;
    await answerQuestion(question, answer.trim(), generation);
  }

  function applyGuestReceipt(article, item) {
    const indicator = article?.querySelector('.message-read-indicator');
    if (!indicator) return;
    const read = Boolean(item.agent_read_at);
    const mode = read ? 'read' : 'delivered';
    const title = read ? 'Read by agent' : 'Received by server; not yet read by agent';
    if (indicator.dataset.receiptState === mode && indicator.title === title) return;
    indicator.className = 'message-read-indicator message-read-indicator--' + mode;
    indicator.dataset.receiptState = mode;
    indicator.title = title;
    indicator.setAttribute('role', 'img');
    indicator.setAttribute('aria-label', title);
    indicator.textContent = '✓✓';
  }
  function refreshReadReceipts(roomId) {
    if (state.receiptRequest?.roomId === roomId) return;
    const unread = (state.messagesByRoom.get(roomId) || []).filter(item => !item.sender_agent_id && !item.agent_read_at && !item.deleted_at);
    if (!unread.length) return;
    const start = state.receiptCursor % unread.length;
    const selected = [...unread.slice(start), ...unread.slice(0, start)].slice(0, 100);
    state.receiptCursor = (start + selected.length) % unread.length;
    const request = { roomId, epoch: state.roomEpoch, guestId: state.guestId };
    const controller = root.AbortController ? new root.AbortController() : null;
    const timeout = controller ? root.setTimeout(() => controller.abort(), 15000) : null;
    request.promise = api(`/rooms/${encodeURIComponent(roomId)}/message-status?` + new URLSearchParams({ ids: selected.map(item => item.id).join(',') }), { signal: controller?.signal })
      .then(statuses => {
        if (state.activeRoomId !== roomId || state.roomEpoch !== request.epoch || state.guestId !== request.guestId) return;
        const messages = new Map((state.messagesByRoom.get(roomId) || []).map(item => [item.id, item]));
        const articles = new Map([...$('guestTimeline').querySelectorAll('[data-message-id]')].map(node => [node.dataset.messageId, node]));
        for (const status of statuses) {
          const item = messages.get(status.messageId);
          if (!item) continue;
          if (status.readAt) item.agent_read_at = status.readAt;
          applyGuestReceipt(articles.get(item.id), item);
        }
      }).catch(() => {}).finally(() => {
        if (timeout !== null) root.clearTimeout(timeout);
        if (state.receiptRequest === request) state.receiptRequest = null;
      });
    state.receiptRequest = request;
  }
  async function renderMessages(messages, generation) {
    if (generation !== state.generation) return;
    const log = $('guestTimeline');
    const roomId = state.activeRoomId;
    const scrollTop = log.scrollTop;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const focusedAction = log.contains(document.activeElement) ? {
      messageId: document.activeElement.closest('[data-message-id]')?.dataset.messageId,
      index: [...(document.activeElement.closest('[data-message-id]')?.querySelectorAll('button[data-guest-action]') || [])].indexOf(document.activeElement)
    } : null;
    const previousForms = new Map([...log.children].filter(node => node.dataset.richSignature)
      .map(node => [node.dataset.messageId, { signature: node.dataset.richSignature, content: node.querySelector('[data-sharing-rich]') }]));
    const audience = JSON.stringify([roomId, state.context.room.keyVersion, state.context.room.membershipVersion,
      ...(state.context.members || []).map(member => [member.id, member.status, member.role]),
      ...(state.context.guests || []).map(member => [member.id, member.status, member.role])]);
    clearTimeline();
    const actionContext = { roomId, generation };
    state.timelineBinding = actionContext;
    const answered = new Set(messages.filter(item => item.question_id).map(item => item.question_id));
    for (const item of messages) {
      if (generation !== state.generation) return;
      const article = document.createElement('article');
      article.className = 'guest-message chat-message message-bubble' + (!item.sender_agent_id ? ' message-bubble--user' : '');
      article.dataset.messageId = item.id;
      article.dataset.own = String(item.sender_guest_id === state.guestId);
      article.dataset.human = String(!item.sender_agent_id);
      const header = document.createElement('header');
      const avatar = item.sender_agent_id ? agentAvatar() : Object.assign(document.createElement('span'), {
        textContent: senderLabel(item).slice(0, 1).toUpperCase(), className: 'chat-avatar'
      });
      avatar.setAttribute('aria-hidden', 'true');
      header.append(Object.assign(document.createElement('strong'), { textContent: senderLabel(item) }));
      const timestamp = document.createElement('small');
      timestamp.textContent = item.created_at ? new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      timestamp.title = item.created_at ? new Date(item.created_at).toLocaleString() : '';
      header.append(timestamp);
      if (!item.sender_agent_id) {
        const receipt = document.createElement('span');
        receipt.className = 'message-read-indicator';
        header.append(receipt);
      }
      article.append(avatar, header);
      applyGuestReceipt(article, item);
      const addressed = addressedLabel(item);
      if (addressed) article.append(Object.assign(document.createElement('p'), { textContent: 'Addressed to: ' + addressed, className: 'guest-message__address' }));
      const audience = item.sender_agent_id ? audienceLabel(item) : '';
      if (audience) article.append(Object.assign(document.createElement('p'), { textContent: 'Visible to: ' + audience, className: 'guest-message__audience' }));
      if (item.deleted_at || !item.payload) {
        article.append(Object.assign(document.createElement('p'), { textContent: 'Message deleted', className: 'guest-message__body' }));
        log.append(article);
        continue;
      }
      let content;
      try {
        content = await C.decrypt(state.keys.get(Number(item.key_version)), item.payload, `${roomId}:${item.key_version}`);
      } catch (_) {
        if (generation !== state.generation || roomId !== state.activeRoomId) return;
        article.append(Object.assign(document.createElement('p'), { textContent: 'Unable to decrypt this message with the current guest key.', className: 'guest-message__body' }));
        log.append(article);
        continue;
      }
      if (generation !== state.generation || roomId !== state.activeRoomId) return;
      const decoded = content;
      const rich = richDataFor(decoded);
      const text = decoded && typeof decoded === 'object' ? decoded.text || '' : decoded;
      if (rich) {
        try {
          const { agent_read_at: receiptTime, ...richItem } = item;
          const signature = JSON.stringify(richItem) + audience;
          const old = previousForms.get(item.id);
          let form;
          if (old?.content && old.signature === signature) { form = old.content; form.sharingBinding.generation = generation; }
          else {
            const binding = { roomId, generation };
            form = root.RichRendering.renderRichContent(rich, response => {
              if (state.activeRoomId !== binding.roomId) throw new Error('Return to the original conversation to respond to this form.');
              return sendRichResponse(item, response, binding.generation);
            });
            form.dataset.sharingRich = 'true';
            form.sharingBinding = binding;
          }
          article.dataset.richSignature = signature;
          article.append(form);
        } catch (_) {
          article.append(Object.assign(document.createElement('p'), { textContent: 'Interactive content is unavailable in this guest browser.', className: 'guest-message__body' }));
        }
      } else {
        article.append(Object.assign(document.createElement('p'), { textContent: String(text || ''), className: 'guest-message__body' }));
      }
      const files = Array.isArray(decoded?.files) ? decoded.files.filter(file => file && typeof file.id === 'string' && typeof file.name === 'string') : [];
      for (const file of files) {
        article.append(action('Download ' + safeFileName(file.name), async () => {
          const downloaded = await downloadAttachment(item, file, roomId, actionContext.generation);
          const link = document.createElement('a');
          link.href = downloaded.url;
          link.download = downloaded.name;
          document.body.append(link);
          link.click();
          link.remove();
        }));
        if (previewable(file.type)) article.append(action('View image', async () => {
          const downloaded = await downloadAttachment(item, file, roomId, actionContext.generation);
          const image = document.createElement('img');
          image.alt = safeFileName(file.name);
          image.src = downloaded.url;
          image.className = 'guest-attachment-preview';
          article.append(image);
        }));
      }
      const actions = document.createElement('div');
      actions.className = 'guest-message__actions';
      actions.append(action('Reply', () => {
        if (actionContext.generation !== state.generation || state.activeRoomId !== roomId) throw new Error('This reply belongs to the previously selected conversation.');
        $('guestReplyState').textContent = 'Replying to ' + senderLabel(item);
        $('guestCancelReply').hidden = false;
        state.replyTo = [item.id];
        $('guestMessage').focus();
      }));
      if (item.kind === 'question' && !answered.has(item.id) && canGuestAnswer(item)) {
        const options = Array.isArray(decoded?.options) ? decoded.options : [];
        options.filter(option => typeof option === 'string' || option && typeof option.text === 'string').forEach(option => {
          const text = typeof option === 'string' ? option : option.text;
          actions.append(action(text, () => answerQuestion(item, text, actionContext.generation)));
        });
        actions.append(action('Answer in your own words', () => promptAnswer(item, actionContext.generation)));
      } else if (item.kind === 'question' && answered.has(item.id)) {
        article.append(Object.assign(document.createElement('p'), { textContent: 'Answered', className: 'guest-status' }));
      }
      if (item.sender_guest_id === state.guestId) actions.append(action('Delete', async () => {
        if (actionContext.generation !== state.generation || state.activeRoomId !== roomId) throw new Error('This message belongs to the previously selected conversation.');
        if (root.confirm && !root.confirm('Delete this message for everyone? Downloaded copies cannot be erased.')) return;
        await api(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: {} });
        if (actionContext.generation === state.generation && state.activeRoomId === roomId) await refreshRoom();
      }));
      article.append(actions);
      log.append(article);
    }
    if (generation !== state.generation) return;
    state.renderedRoomId = roomId;
    if (focusedAction?.messageId) {
      const buttons = [...(log.querySelector(`[data-message-id="${CSS.escape(focusedAction.messageId)}"]`)?.querySelectorAll('button[data-guest-action]') || [])];
      buttons[focusedAction.index]?.focus({ preventScroll: true });
    }
    if (document.visibilityState === 'visible' && messages.length) {
      await api(`/rooms/${encodeURIComponent(state.activeRoomId)}/read`, { method: 'POST', body: { seq: messages[messages.length - 1].seq } });
    }
    log.scrollTop = atBottom ? log.scrollHeight : scrollTop;
  }

  async function refreshRoom() {
    if (!state.activeRoomId) return;
    const roomId = state.activeRoomId;
    const generation = ++state.generation;
    state.roomLoading = true;
    syncActionState();
    state.context = null;
    state.keys = new Map();
    $('guestConversation').hidden = false;
    if (state.renderedRoomId !== roomId) conversationMessage('Loading encrypted conversation…');
    try {
      const context = await api('/rooms/' + encodeURIComponent(roomId));
      if (generation !== state.generation || state.activeRoomId !== roomId) return;
      state.context = context;
      $('guestConversationTitle').textContent = currentRoom()?.agentName || context.room.title || 'Guest conversation';
      renderAudience();
      renderAddressOptions();
      const pending = context.member.status !== 'active';
      const rotating = context.room.rotationRequired;
      if (pending || rotating || !context.keys.length) {
        $('guestComposer').hidden = true;
        const ownerName = context.members?.find(member => member.role === 'owner')?.displayName || 'the owner';
        conversationMessage(pending ? `Waiting for ${ownerName} to approve you. This chat will open automatically once approved; you can leave it open.` : rotating ? 'The owner is updating conversation access. This chat will reconnect automatically.' : 'Encrypted access is being prepared. This chat will activate automatically.');
        clearTimeline();
        return;
      }
      for (const entry of context.keys) state.keys.set(Number(entry.key_version), await C.unwrap(entry.wrapped_key, state.identity.privateKey));
      const currentKey = state.keys.get(Number(context.room.keyVersion));
      if (!currentKey) {
        $('guestComposer').hidden = true;
        conversationMessage('The current guest key is unavailable. Ask the owner to provision access again.');
        return;
      }
      $('guestComposer').hidden = false;
      const lastSeen = context.room.runtimeLastSeenAt ? Date.now() - new Date(context.room.runtimeLastSeenAt).getTime() : Infinity;
      const remaining = state.workspace?.share?.maxMessages ? ` · ${state.workspace.share.messagesRemaining} of ${state.workspace.share.maxMessages} messages left` : '';
      conversationMessage((context.room.executionUncertain ? 'Work needs owner review' : lastSeen > 120000 ? 'Offline · messages will wait for the agent' : 'Online') + remaining);
      const cachedMessages = state.messagesByRoom.get(roomId) || [];
      const hadCache = state.messagesByRoom.has(roomId);
      const lastSequence = cachedMessages.reduce((last, item) => Math.max(last, Number(item.seq) || 0), 0);
      const since = state.messageUpdateCursors.get(roomId) || null;
      const pollStartedAt = new Date().toISOString();
      const updates = await allMessages(roomId, generation, hadCache ? lastSequence : 0, since,
        hadCache ? null : '9223372036854775807');
      if (updates) {
        if (updates.length) {
          const byId = new Map(cachedMessages.map(item => [item.id, item]));
          updates.forEach(item => byId.set(item.id, { ...item, agent_read_at: item.agent_read_at || byId.get(item.id)?.agent_read_at || null }));
          const messages = [...byId.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
          state.messagesByRoom.set(roomId, messages);
          if (!hadCache) state.hasOlderByRoom.set(roomId, updates.length === historyPageSize('9223372036854775807'));
          await renderMessages(messages, generation);
        } else if (state.renderedRoomId !== roomId) {
          if (!hadCache) state.messagesByRoom.set(roomId, []);
          await renderMessages(cachedMessages, generation);
        } else {
          if (state.timelineBinding?.roomId === roomId) state.timelineBinding.generation = generation;
          // The rendered rich forms stay mounted during empty polls. Their
          // callbacks still need the latest room generation to remain usable.
          $('guestTimeline').querySelectorAll('[data-rich-signature] [data-sharing-rich]').forEach(form => {
            if (form.sharingBinding?.roomId === roomId) form.sharingBinding.generation = generation;
          });
        }
        state.messageUpdateCursors.set(roomId, pollStartedAt);
        if (hadCache) refreshReadReceipts(roomId);
      }
      syncHistoryStatus();
      if (context.taskSupport && root.SharingUI?.renderTasks) {
        const tasks = await api('/rooms/' + encodeURIComponent(roomId) + '/tasks');
        if (generation === state.generation && roomId === state.activeRoomId) root.SharingUI.renderTasks($('guestTasks'), tasks, {
          cancel: async task => { await api(`/tasks/${task.task_id}/cancel`, { method: 'POST', body: {} }); await refreshRoom(); }
        });
      } else if ($('guestTasks')) $('guestTasks').hidden = true;
    } catch (error) {
      if (generation !== state.generation) return;
      $('guestComposer').hidden = true;
      clearTimeline();
      conversationMessage(error.status === 404 ? 'This conversation is no longer shared with this guest.' : error.message);
    } finally {
      if (generation === state.generation) {
        state.roomLoading = false;
        syncActionState();
        syncHistoryStatus();
      }
    }
  }

  async function selectRoom(roomId) {
    state.roomEpoch += 1;
    state.receiptCursor = 0;
    closePeople();
    message('');
    if (state.activeRoomId) {
      state.drafts.set(state.activeRoomId, {
        text: $('guestMessage').value,
        files: $('guestFiles') ? [...$('guestFiles').files] : [],
        address: $('guestAddress').value,
        replyTo: [...state.replyTo]
      });
    }
    cancelReply();
    if (state.activeRoomId !== roomId) clearTimeline();
    state.activeRoomId = roomId;
    const draft = state.drafts.get(roomId) || { text: '', files: [], address: '', replyTo: [] };
    $('guestMessage').value = draft.text;
    $('guestAddress').value = draft.address;
    state.replyTo = draft.replyTo;
    $('guestReplyState').textContent = draft.replyTo.length ? `Replying to ${draft.replyTo.length} message${draft.replyTo.length === 1 ? '' : 's'}` : '';
    $('guestCancelReply').hidden = !draft.replyTo.length;
    const fileInput = $('guestFiles');
    if (fileInput) {
      try {
        const transfer = new DataTransfer();
        draft.files.forEach(file => transfer.items.add(file));
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) { fileInput.value = ''; }
    }
    root.SharingUI?.setView(workspacePanel, 'conversation');
    renderRooms();
    await refreshRoom();
  }

  async function loadWorkspace() {
    try {
      const workspace = await api('/workspace');
      state.workspace = workspace;
      state.guestId = workspace.guest.guest_id || workspace.guest.guestId;
      $('guestWorkspaceAudience').textContent = workspace.guest.display_name || workspace.guest.displayName || 'Shared conversations';
      renderRooms();
      const available = workspace.rooms.some(room => room.roomId === state.activeRoomId);
      if (!available) {
        state.activeRoomId = null;
        state.context = null;
        state.keys = new Map();
        $('guestConversation').hidden = true;
        message(workspace.rooms.length ? 'Select an agent to open its conversation.' : 'No agents are currently available.');
      }
      if (!state.activeRoomId && workspace.rooms.length) await selectRoom(workspace.rooms[0].roomId);
      return true;
    } catch (error) {
      if ([401, 404].includes(error.status)) {
        await state.onSessionEnded?.('This guest share has expired, been revoked, or needs a new unlock.');
        return false;
      }
      message(error.message);
      return false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.mutating || !state.context || state.context.member.status !== 'active') return;
    const text = $('guestMessage').value.trim();
    const fileInput = $('guestFiles');
    const files = fileInput ? [...fileInput.files] : [];
    if (!text && !files.length) return conversationMessage('Write a message or attach a file.');
    if (files.length > 10 || files.some(file => file.size > 20000000)) return conversationMessage('Up to ten files, 20 MB each.');
    const roomId = state.activeRoomId;
    const generation = state.generation;
    const version = Number(state.context.room.keyVersion);
    const key = state.keys.get(version);
    const keys = new Map(state.keys);
    const replies = [...state.replyTo];
    const recipient = principalFromValue($('guestAddress').value);
    if (!key) return conversationMessage('Conversation key unavailable.');
    const keyName = messageOutboxKey(roomId);
    setMutating(true);
    try {
      let body = readOutbox(keyName);
      if (!body) {
        const uploaded = [];
        try {
          const attachmentMetadata = [];
          for (const file of files) {
            const encrypted = await encryptFile(file, key, roomId, version);
            await uploadGuestFile(roomId, version, encrypted);
            uploaded.push(encrypted.id);
            attachmentMetadata.push({ ...encrypted.metadata, id: encrypted.id });
          }
          body = {
            id: root.crypto.randomUUID(),
            keyVersion: version,
            payload: await C.encrypt(key, { text, files: attachmentMetadata }, `${roomId}:${version}`),
            fileIds: uploaded,
            addressedToPrincipals: recipient ? [recipient] : [],
            replyTo: replies
          };
        } catch (error) {
          await Promise.all(uploaded.map(fileId => deleteUnlinkedFile(roomId, fileId)));
          throw error;
        }
        writeOutbox(keyName, body);
      }
      await sendPrepared(`/rooms/${encodeURIComponent(roomId)}/messages`, body, keyName, roomId, version, key, keys);
      clearOutbox(keyName);
      if (state.activeRoomId !== roomId || state.generation !== generation) return;
      $('guestMessage').value = '';
      if (fileInput) fileInput.value = '';
      $('guestAddress').value = '';
      cancelReply();
      conversationMessage('Message sent.');
      await refreshRoom();
    } catch (error) {
      if (state.activeRoomId === roomId && state.generation === generation) conversationMessage(error.message + ' The encrypted message is retained for retry.');
    } finally {
      setMutating(false);
    }
  }

  function cancelReply() {
    state.replyTo = [];
    $('guestReplyState').textContent = '';
    $('guestCancelReply').hidden = true;
  }

  async function poll() {
    if (state.polling || state.mutating || state.loadingOlder) return;
    state.polling = true;
    const roomId = state.activeRoomId;
    try {
      if (await loadWorkspace() && roomId && state.activeRoomId === roomId) await refreshRoom();
    } finally {
      state.polling = false;
    }
  }

  function closePeople() {
    const dialog = $('guestAudienceDialog');
    if (!dialog?.open) return;
    if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
    $('guestPeopleButton')?.setAttribute('aria-expanded', 'false');
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    $('guestComposer').addEventListener('submit', sendMessage);
    const loadHistoryOnScroll = () => {
      if ($('guestTimeline').scrollTop > 160 || $('guestConversation').hidden) return;
      void loadOlderMessages().catch(() => conversationMessage('Could not load earlier messages. Scroll up to try again.'));
    };
    $('guestTimeline')?.addEventListener('scroll', loadHistoryOnScroll, { passive: true });
    $('guestTimeline')?.addEventListener('wheel', event => { if (event.deltaY < 0) loadHistoryOnScroll(); }, { passive: true });
    $('guestCancelReply').addEventListener('click', cancelReply);
    const dialog = $('guestAudienceDialog');
    $('guestPeopleButton')?.addEventListener('click', () => {
      if (!dialog || dialog.open) return;
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
      $('guestPeopleButton').setAttribute('aria-expanded', 'true');
      $('guestPeopleClose')?.focus();
    });
    $('guestPeopleClose')?.addEventListener('click', closePeople);
    dialog?.addEventListener('close', () => {
      $('guestPeopleButton')?.setAttribute('aria-expanded', 'false');
      if (!workspacePanel.hidden) $('guestPeopleButton')?.focus();
    });
    dialog?.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closePeople();
    });
  }

  async function start(options) {
    await stop();
    state.csrfToken = options.csrfToken || '';
    state.workspace = options.workspace;
    state.identity = options.identity;
    state.guestId = options.workspace?.guest?.guest_id || options.workspace?.guest?.guestId || '';
    state.onSessionEnded = options.onSessionEnded;
    bind();
    workspacePanel.hidden = false;
    await loadWorkspace();
    state.timer = root.setInterval(poll, 5000);
  }

  async function stop() {
    closePeople();
    if (state.timer) root.clearInterval(state.timer);
    state.timer = null;
    state.generation += 1;
    state.roomLoading = false;
    state.workspace = null;
    state.identity = null;
    state.context = null;
    state.keys = new Map();
    state.activeRoomId = null;
    state.roomListSignature = null;
    state.guestId = '';
    state.replyTo = [];
    state.messagesByRoom.clear();
    state.messageUpdateCursors.clear();
    state.hasOlderByRoom.clear();
    state.drafts.clear();
    revokeObjectUrls();
    if ($('guestFiles')) $('guestFiles').value = '';
    $('guestRooms').replaceChildren();
    clearTimeline();
    if ($('guestTasks')) { $('guestTasks').hidden = true; delete $('guestTasks').dataset.signature; $('guestTasks').querySelector('[data-chat-tasks]')?.replaceChildren(); }
    $('guestConversation').hidden = true;
  }

  root.GuestWorkspace = { start, stop };
})(window);
