/* Shared conversation transport for the ordinary dashboard chat shell. */
(function (root) {
  'use strict';
  async function sessionFetch(url, options = {}) {
    const fetcher = root.csrfFetch || root.fetch;
    if (!root.AbortController) return fetcher(url, options);
    const controller = new root.AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let timedOut = false;
    const timeout = root.setTimeout(() => { timedOut = true; abort(); },
      options.body instanceof root.FormData ? 90000 : options.method && options.method !== 'GET' && !String(url).endsWith('/resolve') ? 30000 : 15000);
    try { return await fetcher(url, { ...options, signal: controller.signal }); }
    catch (error) {
      if (timedOut) throw Object.assign(new Error('The connection is taking too long. Please try again.'), { code: 'REQUEST_TIMEOUT' });
      throw error;
    } finally {
      root.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  const C = root.SharedCrypto;
  let activeContext = null;
  let contextEpoch = 0;
  const keysByRoom = new Map();
  const roomRefreshes = new Map();
  let accessMaintenance = null;
  let listSignature = null;
  let preparingContextRefresh = null;
  let viewerId = '';
  let privateKey = null;
  let identityPromise = null;
  let attachmentDbPromise = null;
  let timelineCacheRoomId = null;
  let timelineCache = [];
  let timelineUpdateCursor = null;
  let timelineLoaded = false;
  let timelineHasOlder = false;
  let receiptRequest = null;
  let receiptCursor = 0;
  let ownerHistory = { roomId: null, messages: [], offset: 0, boundary: null, hasMore: false, loaded: false };
  const sendingByRoom = new Map();
  const executionRecoveries = new Map();
  const attachmentCipherCache = new Map();

  function openAttachmentDb() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!attachmentDbPromise) attachmentDbPromise = new Promise((resolve, reject) => {
      const openRequest = root.indexedDB.open('shared-chat-attachment-cache', 1);
      openRequest.onupgradeneeded = () => openRequest.result.createObjectStore('encrypted');
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
    return attachmentDbPromise;
  }
  async function getAttachmentCipher(cacheKey) {
    if (attachmentCipherCache.has(cacheKey)) return attachmentCipherCache.get(cacheKey);
    const db = await openAttachmentDb();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const request = db.transaction('encrypted', 'readonly').objectStore('encrypted').get(cacheKey);
      request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : null);
      request.onerror = () => reject(request.error);
    });
  }
  async function saveAttachmentCipher(cacheKey, bytes) {
    const copy = new Uint8Array(bytes);
    attachmentCipherCache.set(cacheKey, copy);
    const db = await openAttachmentDb();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      tx.objectStore('encrypted').put(copy, cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function deleteAttachmentCipher(cacheKey) {
    attachmentCipherCache.delete(cacheKey);
    const db = await openAttachmentDb();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      tx.objectStore('encrypted').delete(cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function traceSend(phase, data = {}) {
    if (!root.__IN_PLACE_CHAT_DEBUG__) return;
    root.__inPlaceChatDebugLog = root.__inPlaceChatDebugLog || [];
    root.__inPlaceChatDebugLog.push({ phase, at: Date.now(), ...data });
  }

  function rootNode() { return document.getElementById('dashboardRoot'); }
  function csrf() { return root.csrfToken || ''; }
  let olderRequest = null;
  function hasOlderMessages() {
    return activeContext?.mode === 'shared' && timelineLoaded && (timelineHasOlder || ownerHistory.hasMore);
  }
  function showInvitationNotice(text) {
    const section = document.getElementById('sharedConversationSection');
    if (!section) return;
    let notice = document.getElementById('sharingInvitationNotice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'sharingInvitationNotice';
      notice.className = 'rounded-lg border border-amber-500/30 bg-amber-950/30 p-2 text-xs text-amber-100';
      notice.setAttribute('role', 'alert');
      section.prepend(notice);
    }
    section.hidden = false;
    notice.textContent = text;
  }
  function showInvitationPreview(invitationId, invitation) {
    const section = document.getElementById('sharedConversationSection');
    if (!section) return;
    let card = document.getElementById('sharingInvitationPreview');
    if (!card) {
      card = document.createElement('article');
      card.id = 'sharingInvitationPreview';
      card.className = 'space-y-2 rounded-lg border border-emerald-500/30 bg-slate-950/70 p-3 text-xs text-slate-200';
      section.prepend(card);
    }
    section.hidden = false;
    card.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = `${invitation.ownerDisplayName || 'Someone'} invited you to ${invitation.agentName || 'an agent chat'}`;
    const scope = document.createElement('p');
    scope.textContent = 'Joining lets you read this conversation and its shared files, send messages, and reply to the agent. Your messages are visible to the conversation owner.';
    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2';
    const join = document.createElement('button');
    join.type = 'button'; join.className = 'min-h-11 rounded-lg bg-emerald-600 px-3 font-semibold text-white';
    join.textContent = 'Join chat';
    const feedback = document.createElement('p');
    feedback.className = 'basis-full text-amber-200';
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
    join.addEventListener('click', async () => {
      join.disabled = true;
      feedback.hidden = true;
      try {
        await initializeIdentity();
        const acceptResponse = await sessionFetch('/api/user/chat-threads/invitations/' + encodeURIComponent(invitationId) + '/accept', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
          body: JSON.stringify({ requestId: crypto.randomUUID() })
        });
        const accepted = await acceptResponse.json().catch(() => ({}));
        if (!acceptResponse.ok) throw new Error(accepted.error?.message || 'Could not join this conversation.');
        const contextResponse = await sessionFetch('/api/user/chat-threads/' + encodeURIComponent(accepted.conversationId), { credentials: 'same-origin', cache: 'no-store' });
        if (!contextResponse.ok) throw new Error('The invited conversation is unavailable.');
        const context = await contextResponse.json();
        setContext(context);
        await root.DashboardHelpers?.selectChatContext?.(context);
        await refreshList();
      } catch (error) {
        feedback.hidden = false;
        feedback.textContent = `${error.message} You can unlock this account, verify the invited email, or switch to the invited account, then retry.`;
      } finally { join.disabled = false; }
    });
    if (!invitation.verified) {
      const verify = document.createElement('a');
      verify.href = '/verify-email'; verify.textContent = 'Verify your email'; verify.className = 'min-h-11 inline-flex items-center px-2 text-cyan-200';
      actions.append(verify);
    }
    actions.append(join);
    card.append(heading, scope, actions, feedback);
  }
  function api(path, body, method, signal) {
    traceSend('api:begin', { path, method: method || (body === undefined ? 'GET' : 'POST') });
    return sessionFetch('/api/user/shared' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', signal
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      traceSend('api:done', { path, status: response.status });
      if (!response.ok) {
        const serverMessage = typeof data.error === 'string' ? data.error : data.error?.message;
        const fallback = response.status === 401
          ? 'Your session has expired. Refresh the dashboard and sign in again.'
          : response.status >= 500
            ? 'The server is temporarily unavailable. Please try again shortly.'
            : `Shared conversation request failed (HTTP ${response.status}). Please retry.`;
        throw Object.assign(new Error(serverMessage || fallback), { status: response.status });
      }
      return data;
    });
  }
  async function uploadSharedFile(conversationId, fileId, keyVersion, encryptedBytes, fileName) {
    const form = new root.FormData();
    form.append('id', fileId);
    form.append('keyVersion', String(keyVersion));
    form.append('file', new root.Blob([encryptedBytes], { type: 'application/octet-stream' }), fileName || 'encrypted.bin');
    const response = await sessionFetch(`/api/user/shared/${encodeURIComponent(conversationId)}/files`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': csrf() }, body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Shared attachment upload failed.'), { status: response.status });
    return data;
  }
  async function uploadOutboxAttachment(context, entry, fileId, keyVersion) {
    const cacheKey = `${context.conversationId}:${fileId}:${keyVersion}`;
    let bytes = await getAttachmentCipher(cacheKey);
    if (!bytes) {
      bytes = await encryptImportedFile(context.conversationId, new Uint8Array(await entry.file.arrayBuffer()), keyVersion);
      await saveAttachmentCipher(cacheKey, bytes);
    }
    await uploadSharedFile(context.conversationId, fileId, keyVersion, bytes, entry.file.name);
  }
  async function initializeIdentity() {
    if (privateKey) return;
    if (identityPromise) return identityPromise;
    identityPromise = (async () => {
    const accountKey = await root.getStoredEncryptionKey?.() || root.DashboardHelpers?.getEncryptionKey?.();
    if (!accountKey) throw Object.assign(new Error('Unlock your account encryption locally to finish granting access.'), { code: 'ENCRYPTION_LOCKED' });
    viewerId = rootNode()?.dataset.userId || '';
    if (!viewerId) throw new Error('Your account identity is unavailable. Refresh the dashboard.');
    let saved = await api('/identity');
    if (!saved) {
      const pair = await C.identity(accountKey, `user:${viewerId}`);
      saved = await api('/identity', { ...pair, displayName: rootNode()?.dataset.displayName || 'Member' }, 'PUT');
    }
    try {
      privateKey = await C.privateKey(accountKey, saved.private_key, `user:${viewerId}`);
    } catch (_) {
      throw Object.assign(new Error('Unlock with the account encryption password used to set up sharing on this account.'), { code: 'ENCRYPTION_LOCKED' });
    }
    })();
    try { await identityPromise; }
    finally { identityPromise = null; }
  }
  async function resolveAgentContext(agentId) {
    const response = await sessionFetch('/api/user/chat-threads/resolve', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ agentId })
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error?.message || 'Could not open the agent conversation.');
    return value;
  }
  // Key writes share the same membership snapshot and must serialize even when
  // the owner is viewing another chat while the background access check runs.
  function refreshRoom(context, options = {}) {
    const id = context?.conversationId;
    const previous = roomRefreshes.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => refreshRoomSnapshot(context, options));
    roomRefreshes.set(id, pending);
    const clear = () => { if (roomRefreshes.get(id) === pending) roomRefreshes.delete(id); };
    pending.then(clear, clear);
    return pending;
  }
  async function unwrapRoomKeys(roomData) {
    const keys = new Map();
    for (const envelope of roomData.keys || []) {
      keys.set(Number(envelope.key_version), await C.unwrap(envelope.wrapped_key, privateKey));
    }
    return keys;
  }
  async function refreshRoomSnapshot(context, { allowRotation = false, retries = 2 } = {}) {
    if (!context || context.mode !== 'shared') throw new Error('Shared conversation context is unavailable.');
    const conversationId = context.conversationId;
    traceSend('room:load:begin', { conversationId, allowRotation });
    let roomData = await api('/' + encodeURIComponent(conversationId));
    traceSend('room:load:done', { conversationId, status: roomData?.room?.member?.status, keyVersion: roomData?.room?.key_version, rotationRequired: roomData?.room?.rotation_required });
    if (roomData.room.member.status === 'invited') throw new Error('Join this invitation from the chat list to activate encrypted access.');
    if (roomData.room.member.status !== 'active') {
      const ownerName = roomData.members?.find(member => member.role === 'owner')?.display_name || 'the owner';
      throw new Error(`Encrypted access is waiting for ${ownerName} to unlock their account. This chat will activate automatically when access is ready.`);
    }
    let keys = await unwrapRoomKeys(roomData);
    const currentVersion = Number(roomData.room.key_version);
    const ownerNeedsProvision = roomData.room.member.role === 'owner' && (
      (roomData.room.rotation_required && allowRotation) ||
      (!roomData.room.rotation_required && (!keys.has(currentVersion) ||
        (roomData.members || []).some(member => member.status === 'pending') ||
        (roomData.guests || []).some(guest => guest.status === 'pending')))
    );
    if (ownerNeedsProvision) {
      traceSend('keys:provision:begin', { conversationId, rotationRequired: roomData.room.rotation_required });
      const retained = [];
      let after = 0;
      for (;;) {
        const page = await api('/' + conversationId + '/messages?after=' + after);
        retained.push(...page.filter(message => !message.deleted_at));
        if (page.length < 200) break;
        after = Number(page[page.length - 1].seq);
      }
      traceSend('keys:retained:done', { conversationId, count: retained.length });
      if (!roomData.room.rotation_required && !keys.has(currentVersion) && retained.length) {
        throw new Error('Conversation keys for retained history are unavailable.');
      }
      const targetVersion = currentVersion + (roomData.room.rotation_required ? 1 : 0);
      const neededVersions = new Set(retained.map(message => Number(message.key_version)));
      for (const version of neededVersions) {
        if (!keys.has(version)) throw new Error('Conversation keys for retained history are unavailable.');
      }
      neededVersions.add(targetVersion);
      if (!keys.has(targetVersion)) keys.set(targetVersion, await C.newKey());
      const eligible = (roomData.members || []).filter(member => ['active','pending'].includes(member.status));
      const eligibleGuests = (roomData.guests || []).filter(guest => ['active','pending'].includes(guest.status));
      if (eligible.some(member => !member.public_key) || !roomData.agentIdentity?.public_key) {
        throw new Error('Encrypted access setup is waiting for participant identities.');
      }
      if (eligibleGuests.some(guest => !guest.public_key)) throw new Error('A guest encryption identity is unavailable.');
      const envelopes = [];
      for (const version of neededVersions) {
        const key = keys.get(version);
        for (const member of eligible) envelopes.push({
          principal: `user:${member.user_id}`, keyVersion: Number(version), wrappedKey: await C.wrap(key, member.public_key)
        });
        envelopes.push({ principal: `agent:${roomData.room.agent_id}`, keyVersion: Number(version), wrappedKey: await C.wrap(key, roomData.agentIdentity.public_key) });
        for (const guest of eligibleGuests) envelopes.push({
          principal: `guest:${guest.guest_id}`, keyVersion: Number(version), wrappedKey: await C.wrap(key, guest.public_key)
        });
      }
      try {
        await api('/' + conversationId + '/keys', {
          membershipVersion: roomData.room.membership_version, keyVersion: currentVersion, envelopes
        });
      } catch (error) {
        if (retries > 0 && error.status === 409 && /Membership or key changed/i.test(error.message)) {
          return refreshRoomSnapshot(context, { allowRotation, retries: retries - 1 });
        }
        throw error;
      }
      traceSend('keys:provision:done', { conversationId });
      roomData = await api('/' + conversationId);
      // Another owner tab may have won initial provisioning. Always use the
      // accepted envelopes, never the locally generated losing key.
      keys = await unwrapRoomKeys(roomData);
    } else if (!keys.has(currentVersion)) {
      throw new Error('Waiting for an authorized member to provide conversation keys.');
    }
    keysByRoom.set(conversationId, keys);
    return { roomData, keys };
  }
  function actorLabel(message, roomData) {
    if (message.sender_user_id === viewerId) return 'You';
    if (message.display_name) return message.display_name;
    if (message.sender_guest_id) return roomData?.guests?.find(guest => guest.guest_id === message.sender_guest_id)?.display_name || 'Guest';
    const member = roomData?.members?.find(item => item.user_id === message.sender_user_id);
    return member?.display_name || 'Former participant';
  }
  function senderKind(message, roomData) {
    if (message.sender_agent_id) return 'agent';
    if (message.sender_guest_id) return 'guest';
    return message.sender_user_id === roomData?.room?.owner_id ? 'owner' : 'participant';
  }
  function audienceLabel(message, roomData) {
    const recipients = Array.isArray(message.recipient_principals) ? message.recipient_principals : [];
    if (!recipients.length) return 'Everyone';
    const ownerId = String(roomData?.room?.owner_id || '');
    const names = recipients.map(target => {
      if (target.kind === 'user') {
        if (String(target.id) === ownerId) return 'Owner';
        return roomData?.members?.find(member => String(member.user_id) === String(target.id))?.display_name || 'Participant';
      }
      if (target.kind === 'guest') return roomData?.guests?.find(guest => String(guest.guest_id) === String(target.id))?.display_name || 'Guest';
      return target.kind === 'agent' ? 'Agent' : 'Participant';
    });
    return names.includes('Owner') ? `Owner${names.filter(name => name !== 'Owner').length ? ' + ' + [...new Set(names.filter(name => name !== 'Owner'))].join(', ') : ' only'}` : names.join(', ');
  }
  function updateExecutionNotice(context, roomData) {
    const notice = document.getElementById('sharingExecutionNotice');
    if (!notice) return;
    const runtime = roomData?.runtime;
    const executionId = runtime?.execution_id;
    const recovery = executionRecoveries.get(executionId);
    const previousExecutionId = notice.dataset.executionId;
    notice.hidden = context?.role !== 'owner' || !executionId || !runtime?.execution_uncertain ||
      runtime.execution_kind !== 'shared' || runtime.execution_conversation_id !== context.conversationId || recovery === 'resolved';
    notice.dataset.executionId = notice.hidden ? '' : executionId;
    if (notice.hidden) return;
    const noticeEpoch = contextEpoch;
    const isCurrent = () => contextEpoch === noticeEpoch && activeContext?.conversationId === context.conversationId &&
      notice.dataset.executionId === executionId;
    const buttons = ['sharingExecutionSkip', 'sharingExecutionRetry'].map(id => document.getElementById(id)).filter(Boolean);
    const errorText = document.getElementById('sharingExecutionError');
    if (errorText && previousExecutionId !== executionId) errorText.textContent = '';
    buttons.forEach(button => { button.disabled = recovery === 'pending'; });
    for (const action of ['skip', 'retry']) {
      const button = document.getElementById(action === 'skip' ? 'sharingExecutionSkip' : 'sharingExecutionRetry');
      if (!button) continue;
      button.onclick = async () => {
        if (!isCurrent() || executionRecoveries.has(executionId)) return;
        executionRecoveries.set(executionId, 'pending');
        buttons.forEach(control => { control.disabled = true; });
        if (errorText) errorText.textContent = '';
        try {
          await api('/' + context.conversationId + '/control', { action, executionId });
          // An older poll may finish after recovery. Do not show that request again.
          executionRecoveries.set(executionId, 'resolved');
          if (isCurrent()) notice.hidden = true;
        } catch (error) {
          executionRecoveries.delete(executionId);
          if (isCurrent() && errorText) errorText.textContent = error.message;
        } finally {
          if (isCurrent()) buttons.forEach(control => { control.disabled = false; });
        }
      };
    }
  }
  async function loadOwnerHistory(context, epoch, older = false) {
    if (context.role !== 'owner') return;
    if (ownerHistory.roomId !== context.conversationId) ownerHistory = {
      roomId: context.conversationId, messages: [], offset: 0, boundary: null, hasMore: false, loaded: false
    };
    const snapshot = ownerHistory;
    const refreshLatest = snapshot.loaded && !older;
    if (snapshot.loaded && (older ? !snapshot.hasMore : Date.now() - snapshot.refreshedAt < 10000)) return;
    if (snapshot.request) return snapshot.request;
    snapshot.request = (async () => {
    if (!refreshLatest) root.DashboardHelpers?.ownerHistoryStatus?.(context.conversationId, 'Loading your earlier private messages…');
    const query = new URLSearchParams({ offset: refreshLatest ? '0' : String(snapshot.offset), limit: root.innerWidth < 768 ? (older ? '50' : '30') : '200' });
    if (snapshot.boundary && !refreshLatest) query.set('boundary', snapshot.boundary);
    const response = await sessionFetch(`/api/user/chat-threads/${encodeURIComponent(context.conversationId)}/owner-history?${query}`, {
      credentials: 'same-origin', cache: 'no-store'
    });
    if (!response.ok) throw new Error('Your private history could not be loaded. Please retry.');
    const page = await response.json();
    if (epoch !== contextEpoch || ownerHistory !== snapshot) return;
    const merged = new Map(snapshot.messages.map(message => [message.messageId, message]));
    let changed = false;
    (page.messages || []).forEach(message => {
      // Rendered private rows may already be locally decrypted. Refresh only
      // new rows instead of replacing those cached objects with ciphertext.
      if (!refreshLatest || !merged.has(message.messageId)) { merged.set(message.messageId, message); changed = true; }
      else {
        const cached = merged.get(message.messageId);
        if (message.readAt) cached.readAt = message.readAt;
        for (const field of ['deliveryState', 'deliveryFailed', 'failedReason']) {
          if (message[field] !== undefined) cached[field] = message[field];
        }
      }
    });
    snapshot.messages = [...merged.values()];
    if (!refreshLatest) {
      snapshot.offset = page.nextOffset;
      snapshot.boundary = page.boundary;
      snapshot.hasMore = Boolean(page.hasMore);
    }
    snapshot.loaded = true;
    snapshot.refreshedAt = Date.now();
    root.DashboardHelpers?.ownerHistoryStatus?.(context.conversationId, '');
    root.DashboardHelpers?.updateMessageReceipts?.(combinedTimeline());
    if (!older && (!refreshLatest || changed)) root.DashboardHelpers?.ownerHistoryUpdated?.(context.conversationId, combinedTimeline());
    })().finally(() => { snapshot.request = null; });
    return snapshot.request;
  }
  function combinedTimeline() {
    const byId = new Map(timelineCache.map(message => [message.messageId, message]));
    for (const message of timelineCache) {
      const originalId = message.replyTo?.[0];
      const original = byId.get(originalId);
      message.reply = originalId ? (original ? {
        messageId: originalId, senderName: original.senderName || 'Agent',
        text: String(original.content || (original.attachments?.length ? 'Attachment' : 'Message')).slice(0, 240)
      } : { messageId: originalId, senderName: 'Original message', text: 'Message unavailable or not loaded' }) : null;
    }
    return [...timelineCache, ...(activeContext?.role === 'owner' ? ownerHistory.messages : [])]
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp) || (Number(a.sharedSequence) || 0) - (Number(b.sharedSequence) || 0));
  }
  function refreshReadReceipts(context, epoch) {
    if (receiptRequest?.epoch === epoch) return;
    const unread = timelineCache.filter(message => message.type === 'user_message' && !message.readAt && !message.deleted);
    if (!unread.length) return;
    const start = receiptCursor % unread.length;
    const candidates = [...unread.slice(start), ...unread.slice(0, start)].slice(0, 100);
    receiptCursor = (start + candidates.length) % unread.length;
    const request = { epoch };
    const controller = root.AbortController ? new root.AbortController() : null;
    const timeout = controller ? root.setTimeout(() => controller.abort(), 15000) : null;
    request.promise = api('/' + context.conversationId + '/message-status?' + new URLSearchParams({ ids: candidates.map(message => message.messageId).join(',') }), undefined, undefined, controller?.signal)
      .then(statuses => {
        if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return;
        const byId = new Map(timelineCache.map(message => [message.messageId, message]));
        for (const status of statuses) {
          const message = byId.get(status.messageId);
          if (!message || message.readAt) continue;
          message.readAt = status.readAt || null;
          message.deliveryState = status.readAt ? 'read' : 'delivered';
        }
        root.DashboardHelpers?.updateMessageReceipts?.(combinedTimeline());
      }).catch(() => {}).finally(() => {
        if (timeout !== null) root.clearTimeout(timeout);
        if (receiptRequest === request) receiptRequest = null;
      });
    receiptRequest = request;
  }
  async function loadTimeline({ before = null, olderPrivate = false } = {}) {
    let context = activeContext;
    const epoch = contextEpoch;
    if (!context || context.mode !== 'shared') throw new Error('Shared conversation context is unavailable.');
    await initializeIdentity();
    const { roomData, keys } = await refreshRoom(context);
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return [];
    // An invitation is selected while the member is pending, so its initial
    // capabilities are read-only. Once the owner provisions the room key,
    // refresh the authorized thread context before applying that stale gate.
    if (!context.capabilities?.read && roomData.room.member.status === 'active') {
      const response = await sessionFetch('/api/user/chat-threads/' + encodeURIComponent(context.conversationId), {
        credentials: 'same-origin', cache: 'no-store'
      });
      if (!response.ok) throw new Error('Conversation access is still being activated.');
      context = await response.json();
      if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return [];
      activeContext = context;
    }
    if (!context.capabilities?.read) throw new Error('You do not have access to this conversation yet.');
    root.DashboardHelpers?.refreshSelectedChatContext?.(context, roomData);
    updateExecutionNotice(context, roomData);
    if (timelineCacheRoomId !== context.conversationId) {
      timelineCacheRoomId = context.conversationId;
      timelineCache = [];
      timelineUpdateCursor = null;
      timelineLoaded = false;
      timelineHasOlder = false;
    }
    const refreshExistingReceipts = timelineLoaded && before === null;
    const messages = [];
    let after = timelineCache.reduce((last, message) => Math.max(last, Number(message.sharedSequence) || 0), 0);
    const since = timelineUpdateCursor;
    const pollStartedAt = new Date().toISOString();
    for (;;) {
      const olderCursor = before;
      const initialWindow = !timelineLoaded && olderCursor === null;
      const historyLimit = root.innerWidth < 768 ? (initialWindow ? 30 : 50) : 200;
      const query = olderCursor !== null
        ? new URLSearchParams({ before: String(olderCursor), limit: String(historyLimit) })
        : !timelineLoaded
          ? new URLSearchParams({ before: '9223372036854775807', limit: String(historyLimit) })
          : new URLSearchParams({ after: String(after), limit: '200' });
      if (since && olderCursor === null && timelineLoaded) query.set('since', since);
      const page = await api('/' + context.conversationId + '/messages?' + query);
      if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return [];
      if (initialWindow) {
        timelineHasOlder = page.length === historyLimit;
        timelineLoaded = true;
      } else if (olderCursor !== null) timelineHasOlder = page.length === historyLimit;
      for (const message of page) {
        const fromAgent = Boolean(message.sender_agent_id);
        if (message.deleted_at) {
          messages.push({
            messageId: message.id,
            type: fromAgent ? 'agent_message' : 'user_message',
            content: 'Message removed', deleted: true, encrypted: false, timestamp: message.created_at, priority: 0,
            agentName: fromAgent ? context.agentName : undefined,
            senderName: fromAgent ? undefined : actorLabel(message, roomData),
            sharedAudienceLabel: audienceLabel(message, roomData),
            sharedSenderKind: senderKind(message, roomData),
            sharedAudienceMode: message.recipient_principals?.length ? 'selected' : 'all',
            sharedConversationId: context.conversationId, sharedSequence: Number(message.seq)
          });
          continue;
        }
        const key = keys.get(Number(message.key_version));
        if (!key) throw new Error('A conversation key needed for this history is unavailable.');
        const value = await C.decrypt(key, message.payload, `${context.conversationId}:${message.key_version}`);
        if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return [];
        const options = fromAgent && message.kind === 'question' && Array.isArray(value?.options)
          ? value.options.map(option => ({ optionId: option.optionId || option.id, text: option.text, benefits: option.benefits, downsides: option.downsides, isDefault: Boolean(option.default ?? option.isDefault) }))
          : undefined;
        const selectedOption = options?.find(option => option.optionId && option.optionId === value?.response?.optionId)?.text || null;
        const attachments = Array.isArray(value?.files) ? value.files.map(file => ({
          attachmentId: file.id, fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size,
          sharedConversationId: context.conversationId, sharedKeyVersion: Number(message.key_version),
          downloadUrl: `/api/user/shared/${encodeURIComponent(context.conversationId)}/files/${encodeURIComponent(file.id)}`
        })) : [];
        messages.push({
          messageId: message.id,
          type: fromAgent ? (message.kind === 'question' ? 'agent_question' : 'agent_message') : 'user_message',
          content: value?.text || '',
          replyTo: message.reply_to || [],
          encrypted: false,
          timestamp: message.created_at,
          priority: 0,
          agentName: fromAgent ? context.agentName : undefined,
          senderName: fromAgent ? undefined : actorLabel(message, roomData),
          sharedAudienceLabel: audienceLabel(message, roomData),
          sharedSenderKind: senderKind(message, roomData),
          sharedAudienceMode: message.recipient_principals?.length ? 'selected' : 'all',
          options,
          selectedOption,
          attachments,
          freeResponse: value?.response?.freeResponse || null,
          sharedKind: message.kind,
          sharedQuestionId: message.question_id,
          answerOptionId: value?.optionId || null,
          readAt: message.agent_read_at || null,
          deliveryState: message.agent_read_at ? 'read' : 'delivered',
          serverReceived: true,
          sharedConversationId: context.conversationId,
          sharedSequence: Number(message.seq)
        });
      }
      if (initialWindow || olderCursor !== null || page.length < 200 || Number(page[page.length - 1]?.seq) <= after) break;
      after = Number(page[page.length - 1].seq);
    }
    const merged = new Map(timelineCache.map(message => [message.messageId, message]));
    messages.forEach(message => {
      const previous = merged.get(message.messageId);
      if (previous?.readAt && !message.readAt) { message.readAt = previous.readAt; message.deliveryState = 'read'; }
      merged.set(message.messageId, message);
    });
    const allMessages = [...merged.values()].sort((a, b) => Number(a.sharedSequence) - Number(b.sharedSequence));
    timelineCache = allMessages;
    if (refreshExistingReceipts) refreshReadReceipts(context, epoch);
    if (before === null) timelineUpdateCursor = pollStartedAt;
    const answersByQuestion = new Map(allMessages.filter(message => message.sharedKind === 'answer' && message.sharedQuestionId)
      .map(message => [message.sharedQuestionId, message]));
    for (const question of allMessages.filter(message => message.type === 'agent_question')) {
      const answer = answersByQuestion.get(question.messageId);
      if (!answer) continue;
      const selected = question.options?.find(option => option.optionId && option.optionId === answer.answerOptionId);
      if (selected) question.selectedOption = selected.text;
      else question.freeResponse = answer.content;
    }
    const last = allMessages[allMessages.length - 1];
    if (last && document.visibilityState === 'visible' && epoch === contextEpoch) {
      // Read receipts must never hold the visible transcript behind a stalled
      // mobile request. Message delivery and read acknowledgement are separate.
      void api('/' + context.conversationId + '/read', { seq: last.sharedSequence }).catch(() => {});
    }
    if (olderPrivate) await loadOwnerHistory(context, epoch, true);
    else void loadOwnerHistory(context, epoch).catch(error => {
      if (epoch === contextEpoch) root.DashboardHelpers?.ownerHistoryStatus?.(context.conversationId,
        error.message || 'Your private history could not load. Please retry.', true);
    });
    if (epoch !== contextEpoch) return [];
    return combinedTimeline();
  }
  async function loadOlderTimeline() {
    if (!(timelineHasOlder || ownerHistory.hasMore) || activeContext?.mode !== 'shared') return combinedTimeline();
    if (olderRequest?.epoch === contextEpoch) return olderRequest.promise;
    const request = { epoch: contextEpoch };
    const oldest = Math.min(...timelineCache.map(message => Number(message.sharedSequence) || Infinity));
    request.promise = loadTimeline({ before: timelineHasOlder && Number.isFinite(oldest) ? String(oldest) : null, olderPrivate: true })
      .finally(() => { if (olderRequest === request) olderRequest = null; });
    olderRequest = request;
    return request.promise;
  }
  function sendMessage(text, files = [], options = {}) {
    const roomId = activeContext?.conversationId;
    if (sendingByRoom.has(roomId)) return sendingByRoom.get(roomId);
    const sending = sendMessageOnce(text, files, options).finally(() => {
      if (sendingByRoom.get(roomId) === sending) sendingByRoom.delete(roomId);
    });
    sendingByRoom.set(roomId, sending);
    return sending;
  }
  async function sendMessageOnce(text, files = [], options = {}) {
    const context = activeContext;
    const epoch = contextEpoch;
    traceSend('send:start', { conversationId: context?.conversationId, epoch, textLength: String(text || '').length });
    if (!context || context.mode !== 'shared') throw new Error('Shared conversation context is unavailable.');
    if (!context.capabilities?.send) throw new Error('You cannot send messages in this conversation yet.');
    const selectedFiles = Array.isArray(files) ? files.filter(entry => entry?.file) : [];
    if ((!text || !String(text).trim()) && !selectedFiles.length) throw new Error('Write a message or attach a file before sending.');
    traceSend('send:identity:begin', { conversationId: context.conversationId, epoch });
    await initializeIdentity();
    traceSend('send:identity:done', { conversationId: context.conversationId, epoch });
    traceSend('send:room:begin', { conversationId: context.conversationId, epoch });
    const { roomData, keys } = await refreshRoom(context, { allowRotation: true });
    traceSend('send:room:done', { conversationId: context.conversationId, epoch, keyVersion: roomData?.room?.key_version });
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the message was sent. Your draft is still in the composer.');
    if (roomData?.room?.rotation_required) throw new Error('Conversation keys are being rotated. Wait for access to be restored.');
    const idKey = `shared-dashboard-outbox:${viewerId}:${context.conversationId}`;
    const stored = sessionStorage.getItem(idKey);
    const version = Number(roomData.room.key_version);
    let body = stored ? JSON.parse(stored) : null;
    let preserveDraft = false;
    if (!body) {
      if (!keys.has(version)) throw new Error('Conversation key unavailable. Your draft is still in the composer.');
      traceSend('send:encrypt:begin', { conversationId: context.conversationId, epoch, keyVersion: version });
      const clientFileIds = selectedFiles.map(entry => entry.id);
      const fileMetadata = selectedFiles.map((entry, index) => ({
        id: crypto.randomUUID(), name: entry.file.name || 'attachment', type: entry.file.type || 'application/octet-stream', size: entry.file.size
      }));
      body = {
        id: crypto.randomUUID(),
        keyVersion: version,
        payload: await C.encrypt(keys.get(version), { text: String(text || '').trim(), files: fileMetadata }, `${context.conversationId}:${version}`),
        addressedTo: [], replyTo: options.replyTo ? [options.replyTo] : [], fileIds: fileMetadata.map(file => file.id), clientFileIds
      };
      if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the message was sent. Your draft is still in the composer.');
      sessionStorage.setItem(idKey, JSON.stringify(body));
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const entry = selectedFiles[index];
        if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the message was sent. Your draft is still in the composer.');
        await uploadOutboxAttachment(context, entry, body.fileIds[index], version);
      }
      traceSend('send:encrypt:done', { conversationId: context.conversationId, epoch, outboxId: body.id });
      if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the message was sent. Your draft is still in the composer.');
      sessionStorage.setItem(idKey, JSON.stringify(body));
    } else {
      const originalKey = keys.get(Number(body.keyVersion));
      if (!originalKey) throw new Error('The saved encrypted message needs an unavailable key. Your request is preserved.');
      const original = await C.decrypt(originalKey, body.payload, `${context.conversationId}:${body.keyVersion}`);
      const sameFiles = JSON.stringify(body.clientFileIds || []) === JSON.stringify(selectedFiles.map(entry => entry.id));
      preserveDraft = String(original?.text || '').trim() !== String(text || '').trim() || !sameFiles ||
        (body.replyTo?.[0] || null) !== (options.replyTo || null);
      if (Number(body.keyVersion) !== version) {
        if ((body.fileIds || []).length && !sameFiles) throw new Error('The saved shared attachment request needs its original files to recover after key rotation. Your new draft is still available.');
        body.keyVersion = version;
        body.payload = await C.encrypt(keys.get(version), original, `${context.conversationId}:${version}`);
        sessionStorage.setItem(idKey, JSON.stringify(body));
      }
      if (sameFiles) {
        for (let index = 0; index < selectedFiles.length; index += 1) {
          const entry = selectedFiles[index];
          if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the attachment was sent. Your draft is still in the composer.');
          await uploadOutboxAttachment(context, entry, body.fileIds[index], version);
        }
      }
    }
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the message was sent. Your draft is still in the composer.');
    traceSend('send:post:begin', { conversationId: context.conversationId, epoch, outboxId: body.id });
    const requestBody = { ...body };
    delete requestBody.clientFileIds;
    await api('/' + context.conversationId + '/messages', requestBody);
    traceSend('send:post:done', { conversationId: context.conversationId, epoch, outboxId: body.id });
    sessionStorage.removeItem(idKey);
    await Promise.all((body.fileIds || []).map(fileId => deleteAttachmentCipher(`${context.conversationId}:${fileId}:${body.keyVersion}`)));
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return { messages: [], preserveDraft };
    try { return { messages: await loadTimeline(), preserveDraft }; }
    catch (error) {
      // The server accepted this id. A failed refresh must not turn success
      // into a retry with a new id (and a second copy of the same image).
      return { messages: epoch === contextEpoch ? combinedTimeline() : [], preserveDraft, refreshError: error.message };
    }
  }
  async function answerQuestion(questionId, option) {
    const context = activeContext;
    const epoch = contextEpoch;
    if (!context || context.mode !== 'shared' || !context.capabilities?.send) throw new Error('You cannot answer questions in this conversation yet.');
    await initializeIdentity();
    const { roomData, keys } = await refreshRoom(context, { allowRotation: true });
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the answer was sent.');
    const keyVersion = Number(roomData.room.key_version);
    if (!keys.has(keyVersion)) throw new Error('The current conversation key is unavailable.');
    const bodyKey = `shared-dashboard-answer:${viewerId}:${context.conversationId}:${questionId}`;
    let body = sessionStorage.getItem(bodyKey);
    if (body) body = JSON.parse(body);
    else {
      body = {
        id: crypto.randomUUID(), keyVersion,
        payload: await C.encrypt(keys.get(keyVersion), { text: option.text, optionId: option.optionId }, `${context.conversationId}:${keyVersion}`),
        addressedTo: [], replyTo: [questionId], fileIds: []
      };
      if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) throw new Error('Conversation changed before the answer was sent.');
      sessionStorage.setItem(bodyKey, JSON.stringify(body));
    }
    await api('/' + context.conversationId + '/questions/' + encodeURIComponent(questionId) + '/answer', body);
    sessionStorage.removeItem(bodyKey);
    if (epoch !== contextEpoch || activeContext?.conversationId !== context.conversationId) return [];
    return loadTimeline();
  }
  function maintainOwnedAccess(contexts) {
    if (accessMaintenance) return accessMaintenance;
    const owned = contexts.filter(item => item.mode === 'shared' && item.role === 'owner');
    if (!owned.length) return Promise.resolve([]);
    accessMaintenance = Promise.allSettled(owned.map(async context => {
      // Session access can inspect admission before local decryption is ready.
      // Avoid requiring an unlock for rooms which already have usable access.
      const details = await api('/' + encodeURIComponent(context.conversationId));
      const needsSetup = details.room.rotation_required ||
        !(details.keys || []).some(key => Number(key.key_version) === Number(details.room.key_version)) ||
        (details.members || []).some(member => member.status === 'pending') ||
        (details.guests || []).some(guest => guest.status === 'pending');
      if (!needsSetup) return;
      await initializeIdentity();
      return refreshRoom(context, { allowRotation: true });
    })).then(results => {
      const failures = results.map((result, index) => ({ ...result, context: owned[index] }))
        .filter(result => result.status === 'rejected');
      const notice = document.getElementById('sharingAccessNotice');
      if (notice) {
        notice.hidden = failures.length === 0;
        const text = document.getElementById('sharingAccessNoticeText');
        const unlock = document.getElementById('sharingAccessUnlock');
        const locked = failures.some(result => result.reason?.code === 'ENCRYPTION_LOCKED');
        if (text && failures.length) text.textContent = `Access setup for ${[...new Set(failures.map(result => result.context.agentName || 'your agent'))].join(', ')}: ${failures[0].reason?.message || 'Please retry.'}`;
        if (unlock) unlock.hidden = !locked;
      }
      for (const failure of failures) traceSend('keys:maintenance:error', { conversationId: failure.context.conversationId, message: failure.reason?.message });
      return results;
    });
    const clear = () => { accessMaintenance = null; };
    accessMaintenance.then(clear, clear);
    return accessMaintenance;
  }
  async function refreshList() {
    const section = document.getElementById('sharedConversationSection');
    const list = document.getElementById('sharedConversationList');
    const invitationList = document.getElementById('incomingSharingInvitations');
    if (!section || !list) return;
    try {
      const response = await sessionFetch('/api/user/chat-threads', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { section.hidden = true; return; }
      const allContexts = await response.json();
      root.CouncilSharing?.updateContexts(allContexts);
      root.RecentChats?.updateContexts(allContexts);
      const selectedContext = root.DashboardHelpers?.getSelectedChatContext?.();
      if (selectedContext?.state === 'preparing' && !preparingContextRefresh) {
        const latest = allContexts.find(item => item.agentId === selectedContext.agentId && item.role === 'owner');
        if (latest && latest.state !== 'preparing') {
          preparingContextRefresh = Promise.resolve(root.DashboardHelpers?.selectChatContext?.(latest))
            .catch(error => traceSend('context:refresh:error', { message: error.message }))
            .finally(() => { preparingContextRefresh = null; });
        }
      }
      // Owned chats already have their ordinary agent row. Legacy rooms must
      // not appear as indistinguishable duplicate entries in that list.
      const contexts = allContexts.filter(item => item.mode === 'shared' && item.role !== 'owner');
      const selectedShared = root.DashboardHelpers?.getSelectedChatContext?.();
      const latestShared = selectedShared?.role !== 'owner' && contexts.find(item => item.conversationId === selectedShared?.conversationId);
      if (latestShared) root.DashboardHelpers?.refreshSelectedChatContext?.(latestShared);
      void maintainOwnedAccess(allContexts).catch(error => {
        traceSend('keys:maintenance:error', { message: error.message });
      });
      const invitationsResponse = invitationList ? await sessionFetch('/api/user/chat-threads/invitations/incoming', { credentials: 'same-origin', cache: 'no-store' }) : null;
      const invitations = invitationsResponse?.ok ? await invitationsResponse.json() : [];
      const signature = JSON.stringify([contexts, invitations]);
      if (signature === listSignature) { section.hidden = contexts.length === 0 && invitations.length === 0; syncSharedListSelection(); return; }
      listSignature = signature;
      list.replaceChildren();
      invitationList?.replaceChildren();
      section.hidden = contexts.length === 0 && invitations.length === 0;
      const count = document.getElementById('sharedConversationCount');
      if (count) count.textContent = String(contexts.length + invitations.length);
      for (const invite of invitations) {
        const row = document.createElement('div');
        row.className = 'flex flex-wrap items-center gap-2 rounded-lg bg-slate-950/50 p-2 text-xs text-slate-300';
        const label = document.createElement('span');
        label.className = 'min-w-0 flex-1';
        label.textContent = `${invite.ownerDisplayName || 'Someone'} invited you to ${invite.agentName || 'an agent'} · ${invite.recipientEmail || 'your account'}`;
        const feedback = document.createElement('span');
        feedback.className = 'w-full basis-full text-amber-200';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        feedback.hidden = true;
        const join = document.createElement('button');
        join.type = 'button'; join.className = 'min-h-11 rounded px-2 text-emerald-300'; join.textContent = 'Join';
        join.addEventListener('click', async () => {
          join.disabled = true;
          try {
            await root.InPlaceChat?.ensureIdentity();
            await sessionFetch('/api/user/chat-threads/invitations/' + encodeURIComponent(invite.invitationId) + '/accept', {
              method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
              body: JSON.stringify({ requestId: crypto.randomUUID() })
            }).then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error?.message || 'Could not join this conversation.'); return data; });
            const contextResponse = await sessionFetch('/api/user/chat-threads/' + encodeURIComponent(invite.conversationId), { credentials: 'same-origin', cache: 'no-store' });
            if (!contextResponse.ok) throw new Error('The invited conversation is unavailable.');
            const context = await contextResponse.json();
            await root.DashboardHelpers?.selectChatContext?.(context);
            await refreshList();
          } catch (error) { join.disabled = false; feedback.hidden = false; feedback.textContent = error.message; }
        });
        const decline = document.createElement('button');
        decline.type = 'button'; decline.className = 'min-h-11 rounded px-2 text-slate-400'; decline.textContent = 'Decline';
        decline.addEventListener('click', async () => {
          decline.disabled = true;
          try {
            const response = await sessionFetch('/api/user/chat-threads/invitations/' + encodeURIComponent(invite.invitationId) + '/decline', {
              method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: '{}'
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error?.message || 'Could not decline this invitation. Try again.');
            await refreshList();
          } catch (error) { decline.disabled = false; feedback.hidden = false; feedback.textContent = error.message; }
        });
        row.append(label, join, decline, feedback); invitationList?.append(row);
      }
      for (const item of contexts) {
        const row = document.createElement('div');
        row.className = 'shared-conversation-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'shared-conversation-open';
        button.dataset.sharedConversationId = item.conversationId;
        const name = item.agentName || 'Agent';
        button.setAttribute('aria-label', `${item.membershipStatus === 'invited' ? 'Join' : 'Open'} ${name} shared conversation`);
        const avatar = document.createElement('span');
        avatar.className = 'shared-conversation-avatar'; avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = name.slice(0, 2).toUpperCase();
        const info = document.createElement('span'); info.className = 'shared-conversation-info';
        const title = document.createElement('span'); title.className = 'shared-conversation-name';
        title.textContent = name; title.title = name;
        const status = document.createElement('span'); status.className = 'shared-conversation-status';
        const statusText = item.membershipStatus === 'invited' ? 'Invitation · Join chat' : item.membershipStatus === 'active' ? 'Chat together' : 'Waiting for access';
        status.textContent = statusText;
        info.append(title, status);
        const arrow = document.createElement('span'); arrow.className = 'shared-conversation-arrow';
        arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '›';
        button.append(avatar, info, arrow);
        const feedback = document.createElement('p'); feedback.className = 'shared-conversation-feedback';
        feedback.hidden = true; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
        button.addEventListener('click', async () => {
          button.disabled = true;
          feedback.hidden = true; status.textContent = 'Opening…';
          try {
            if (item.membershipStatus === 'invited') {
              await initializeIdentity();
              await api('/' + encodeURIComponent(item.conversationId) + '/accept', {});
            }
            const current = await sessionFetch('/api/user/chat-threads/' + encodeURIComponent(item.conversationId), { credentials: 'same-origin', cache: 'no-store' });
            if (!current.ok) throw new Error('This conversation is no longer available.');
            const context = await current.json();
            if (root.DashboardHelpers?.selectChatContext) await root.DashboardHelpers.selectChatContext(context);
            if (root.innerWidth < 1024) root.setMobileListExpanded?.(false, { skipBrowserHistory: true });
            await refreshList();
          } catch (error) { feedback.textContent = error.message; feedback.hidden = false; }
          finally { button.disabled = false; status.textContent = statusText; }
        });
        row.append(button);
        if (item.role !== 'owner' && item.membershipStatus === 'active') {
          const leave = document.createElement('button');
          leave.type = 'button'; leave.className = 'shared-conversation-leave';
          leave.textContent = 'Leave'; leave.setAttribute('aria-label', `Leave ${item.agentName || 'shared conversation'}`);
          leave.addEventListener('click', async () => {
            leave.disabled = true;
            try {
              await leaveConversation(item.conversationId);
            } catch (error) { leave.disabled = false; leave.title = error.message; }
          });
          row.append(leave);
        }
        row.append(feedback);
        list.append(row);
      }
      syncSharedListSelection();
    } catch (_) { section.hidden = true; }
  }
  function syncSharedListSelection() {
    document.querySelectorAll('#sharedConversationList [data-shared-conversation-id]').forEach(button => {
      button.setAttribute('aria-current', String(activeContext?.mode === 'shared' && activeContext.conversationId === button.dataset.sharedConversationId));
    });
  }
  async function leaveConversation(conversationId) {
    const viewerId = rootNode()?.dataset.userId;
    if (!viewerId) throw new Error('Your account identity is unavailable.');
    if (!root.confirm('Leave this shared conversation? You will need a new invitation to rejoin.')) return false;
    const response = await sessionFetch(`/api/user/shared/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(viewerId)}`, {
      method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf() }
    });
    if (!response.ok) throw new Error('Could not leave this conversation.');
    if (activeContext?.conversationId === conversationId) setContext(null);
    root.history.replaceState({}, '', '/dashboard');
    root.location.reload();
    return true;
  }
  function setContext(context) {
    const nextId = context?.mode === 'shared' ? context.conversationId : null;
    if (timelineCacheRoomId !== nextId) {
      timelineCacheRoomId = nextId;
      timelineCache = [];
      timelineUpdateCursor = null;
      timelineLoaded = false;
      timelineHasOlder = false;
      receiptCursor = 0;
      ownerHistory = { roomId: null, messages: [], offset: 0, boundary: null, hasMore: false, loaded: false };
    }
    activeContext = context || null;
    syncSharedListSelection();
    contextEpoch += 1;
    const executionNotice = document.getElementById('sharingExecutionNotice');
    if (executionNotice) executionNotice.hidden = true;
    root.DashboardHelpers?.ownerHistoryStatus?.(context?.conversationId, '');
    root.DashboardHelpers?.sharedHistoryLoading?.(false);
    root.DashboardHelpers?.sharedHistoryError?.('');
  }
  async function prepareOwnerShare(context) {
    const captured = { ...context, mode: 'shared', role: 'owner' };
    setContext(captured);
    await initializeIdentity();
    const prepared = await refreshRoom(captured, { allowRotation: true });
    return { context: captured, room: prepared.roomData.room };
  }
  async function encryptImportedPayload(conversationId, value, keyVersion) {
    const key = keysByRoom.get(conversationId)?.get(Number(keyVersion));
    if (!key) throw new Error('The shared history encryption key is unavailable.');
    return C.encrypt(key, value, `${conversationId}:${keyVersion}`);
  }
  async function encryptImportedFile(conversationId, bytes, keyVersion) {
    const key = keysByRoom.get(conversationId)?.get(Number(keyVersion));
    if (!key) throw new Error('The shared history encryption key is unavailable.');
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode(`${conversationId}:${keyVersion}`) }, key, bytes));
    const output = new Uint8Array(iv.length + ciphertext.length);
    output.set(iv); output.set(ciphertext, iv.length);
    return output;
  }
  async function decryptSharedFile(conversationId, keyVersion, bytes) {
    const key = keysByRoom.get(conversationId)?.get(Number(keyVersion));
    if (!key || bytes.byteLength <= 28) throw new Error('The shared file key is unavailable.');
    return root.crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(`${conversationId}:${keyVersion}`) }, key, bytes.slice(12));
  }
  async function loadOlderOnScroll() {
    const context = activeContext;
    const epoch = contextEpoch;
    const area = document.getElementById('conversationArea');
    if (!context || area.scrollTop > 160 || area.classList.contains('hidden') || !hasOlderMessages() || olderRequest?.epoch === epoch ||
        root.DashboardHelpers?.chatHistoryBusy?.()) return;
    root.DashboardHelpers?.sharedHistoryLoading?.(true);
    try {
      const messages = await loadOlderTimeline();
      if (epoch !== contextEpoch) return;
      await root.DashboardHelpers?.prependSharedHistory?.(context, messages);
    } catch (error) {
      if (epoch === contextEpoch) root.DashboardHelpers?.sharedHistoryError?.('Could not load earlier messages. Scroll up to try again.');
    } finally {
      if (epoch === contextEpoch) root.DashboardHelpers?.sharedHistoryLoading?.(false);
    }
  }
  const historyArea = document.getElementById('conversationArea');
  historyArea?.addEventListener('scroll', loadOlderOnScroll, { passive: true });
  // At the absolute top another upward wheel gesture does not change
  // scrollTop. It still lets the reader retry a failed page request.
  historyArea?.addEventListener('wheel', event => { if (event.deltaY < 0) void loadOlderOnScroll(); }, { passive: true });
  document.getElementById('ownerHistoryRetry')?.addEventListener('click', () => {
    if (activeContext?.role !== 'owner' || activeContext?.mode !== 'shared') return;
    const context = activeContext, epoch = contextEpoch;
    void loadOwnerHistory(context, epoch).catch(error => {
      if (epoch === contextEpoch) root.DashboardHelpers?.ownerHistoryStatus?.(context.conversationId, error.message, true);
    });
  });
  root.InPlaceChat = { refreshList, resolveAgentContext, setContext, getContext: () => activeContext, loadTimeline, loadOlderTimeline,
    hasOlderMessages, isLoadingOlder: () => olderRequest?.epoch === contextEpoch, sendMessage, answerQuestion, leaveConversation,
    maintainOwnedAccess, prepareOwnerShare, encryptImportedPayload, encryptImportedFile, decryptSharedFile, ensureIdentity: initializeIdentity };
  // dashboard.js also selects the remembered private agent during
  // DOMContentLoaded. Run deep-link selection after that initialization so it
  // cannot immediately replace the requested shared context.
  root.addEventListener('load', async () => {
    // Run independently of the selected chat: pending invitees must not depend
    // on the owner opening a second sharing screen or reselecting the room.
    let accessTimer = null;
    const startMaintenance = () => {
      if (accessTimer === null) accessTimer = root.setInterval(() => { void refreshList(); }, 5000);
    };
    root.addEventListener('pagehide', () => { root.clearInterval(accessTimer); accessTimer = null; });
    root.addEventListener('pageshow', event => {
      if (event.persisted) { void refreshList(); startMaintenance(); }
    });
    root.addEventListener('encryption:unlocked', () => { void refreshList(); });
    root.addEventListener('focus', () => { void refreshList(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { void refreshList(); startMaintenance(); }
    });
    startMaintenance();
    void refreshList();
    const entryEpoch = contextEpoch;
    if (!root.dashboardReady) await new Promise(resolve => root.addEventListener('dashboard:ready', resolve, { once: true }));
    const conversationId = new URLSearchParams(location.search).get('conversationId');
    const invitationId = new URLSearchParams(location.search).get('invitationId');
    if ((conversationId || invitationId) && entryEpoch !== contextEpoch) return;
    if (!conversationId && !invitationId && entryEpoch === contextEpoch) {
      const selected = root.DashboardHelpers?.getSelectedAgentIdentity?.();
      if (selected?.agentId && selected.mode !== 'shared' && selected.role === 'owner' && selected.agentType !== 'news_feed') {
        const context = await resolveAgentContext(selected.agentId);
        if (entryEpoch === contextEpoch && context.mode === 'shared') await root.DashboardHelpers?.selectChatContext?.(context);
      }
    }
    // /guest sends signed-in visitors here when their account still needs an
    // encrypted sharing identity; create it, then send their access request.
    const requestSecret = /^#request-access=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
    if (requestSecret) {
      history.replaceState(null, '', location.pathname + location.search);
      try {
        await initializeIdentity();
        const response = await sessionFetch('/api/user/shared/link-requests', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
          body: JSON.stringify({ linkSecret: requestSecret })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || 'Your access request could not be sent.');
        root.showSuccessMessage?.(result.state === 'member' ? 'You already have access to this shared chat.'
          : 'Access request sent. The chat appears here once the owner approves it.');
      } catch (error) {
        root.showError?.(error.code === 'ENCRYPTION_LOCKED' ? `${error.message} Then open the shared link again.` : error.message);
      }
    }
    if (invitationId && !conversationId) {
      if (!root.dashboardReady) await new Promise(resolve => root.addEventListener('dashboard:ready', resolve, { once: true }));
      try {
        const previewResponse = await sessionFetch('/api/user/chat-threads/invitations/' + encodeURIComponent(invitationId), { credentials: 'same-origin', cache: 'no-store' });
        const invitation = await previewResponse.json().catch(() => ({}));
        if (!previewResponse.ok) throw new Error(invitation.error?.message || 'This invitation is unavailable.');
        showInvitationPreview(invitationId, invitation);
      } catch (error) {
        showInvitationNotice(`${error.message} The invitation is still available; unlock this account or switch to the invited email, then choose Join to retry.`);
      }
    }
    if (conversationId) {
      // Last-chat restoration may already have opened this room. Selecting it
      // again after a late request would close a list the user just opened.
      if (activeContext?.conversationId === conversationId) return;
      if (!root.dashboardReady) {
        await new Promise(resolve => root.addEventListener('dashboard:ready', resolve, { once: true }));
      }
      const response = await sessionFetch('/api/user/chat-threads/' + encodeURIComponent(conversationId), { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        const context = await response.json();
        if (entryEpoch === contextEpoch && root.DashboardHelpers?.selectChatContext) {
          setContext(context);
          await root.DashboardHelpers.selectChatContext(context);
        }
      }
    }
  });
  document.getElementById('sharingAccessUnlock')?.addEventListener('click', () => root.DashboardHelpers?.unlockEncryption?.());
  document.getElementById('sharingAccessRetry')?.addEventListener('click', () => { void refreshList(); });
})(window);
