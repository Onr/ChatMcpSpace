/* global SharedCrypto, getStoredEncryptionKey */
'use strict';

(async function () {
  const C = SharedCrypto,
    app = document.getElementById('sharedApp'),
    $ = id => document.getElementById(id);
  let refreshQueue = Promise.resolve(),
    mutating = false;
  let userId,
    privateKey,
    active,
    context,
    keys = new Map(),
    replyTo = null,
    question = null,
    loading = false,
    rendered = '',
    ownName = '';
  const objectUrls = [];
  let agentChoices = new Map(),
    agentListLoading = false,
    agentListError = false,
    agentListRequest = 0;
  let requestedAgent = new URLSearchParams(location.search).get('agentId');
  // Production caches compiled views. Also support pages rendered with the old
  // form so a refreshed static script does not require a service restart.
  prepareAgentControls();
  function error(e) {
    $('sharedError').textContent = e?.message || String(e);
  }
  async function api(path = '', body, method) {
    const response = await fetch('/api/user/shared' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        'x-csrf-token': app.dataset.csrf,
        ...(body instanceof FormData ? {} : {
          'Content-Type': 'application/json'
        })
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), {
      status: response.status
    });
    return data;
  }
  function node(tag, text) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  // Polling must not replace the options of an open native picker. Keep each
  // option (and the current selection) unless its actual catalogue changes.
  function syncOptions(select, choices, preferred = select.value) {
    const existing = new Map([...select.options].map(option => [option.value, option]));
    const wanted = new Set(choices.map(choice => choice.value));
    for (const option of [...select.options]) {
      if (!wanted.has(option.value)) option.remove();
    }
    choices.forEach((choice, index) => {
      const option = existing.get(choice.value) || node('option');
      if (option.value !== choice.value) option.value = choice.value;
      if (option.textContent !== choice.text) option.textContent = choice.text;
      if (select.options[index] !== option) select.insertBefore(option, select.options[index] || null);
    });
    const next = wanted.has(preferred) ? preferred : choices[0]?.value || '';
    if (select.value !== next) select.value = next;
  }
  function prepareAgentControls() {
    const form = $('sharedCreate'),
      select = form.elements.agentId,
      submit = form.querySelector('button');
    submit.type = 'submit';
    submit.disabled = true;
    select.disabled = true;
    select.setAttribute('aria-describedby', 'sharedAgentStatus');
    if (!$('sharedAgentStatus')) {
      const status = form.querySelector('p') || node('p');
      status.id = 'sharedAgentStatus';
      status.setAttribute('role', 'status');
      status.textContent = 'Loading your agents…';
      form.append(status);
    }
    if (!$('sharedRefreshAgents')) {
      const refresh = node('button', 'Refresh agents');
      refresh.id = 'sharedRefreshAgents';
      refresh.type = 'button';
      form.append(refresh);
    }
    if (!form.querySelector('a[href="/dashboard"]')) {
      const link = node('a', 'Manage your agents'), paragraph = node('p');
      link.href = '/dashboard';
      paragraph.append(link);
      form.append(paragraph);
    }
  }
  function action(text, fn) {
    const b = node('button', text);
    b.type = 'button';
    b.onclick = () => Promise.resolve().then(() => {
      if (mutating) throw new Error('Please wait for the current request to finish.');
      return fn();
    }).catch(error);
    return b;
  }
  function name(id) {
    return (context?.members.find(m => m.user_id === id)?.display_name || 'Former participant') + ' · ' + id.slice(0, 6);
  }
  function principalName(principal) {
    if (principal?.kind === 'user') return name(principal.id);
    const guest = context?.guests?.find(member => member.guest_id === principal?.id);
    return (guest?.display_name || 'Former guest') + ' · ' + String(principal?.id || '').slice(0, 6) + ' · guest';
  }
  function canAnswer(message) {
    const typed = message.addressed_to_principals;
    return (!message.addressed_to.length || message.addressed_to.includes(userId)) &&
      (typed === undefined || Array.isArray(typed) && (!typed.length || typed.some(target => target?.kind === 'user' && target.id === userId)));
  }
  function ctx(version) {
    return `${active}:${version}`;
  }
  function bind(form, fn) {
    $(form).onsubmit = async e => {
      e.preventDefault();
      $('sharedError').textContent = '';
      const button = e.target.querySelector('button');
      button.disabled = true;
      mutating = true;
      updateAgentControls();
      try {
        await refreshQueue.catch(() => {});
        await fn(e.target);
      } catch (e) {
        error(e);
      } finally {
        button.disabled = false;
        mutating = false;
        updateAgentControls();
      }
    };
  }
  function agentReady(choice) {
    const seen = new Date(choice?.runtime?.last_seen_at).getTime();
    return Boolean(choice?.runtime) && Number.isFinite(seen) && Date.now() - seen < 120000;
  }
  function updateAgentControls() {
    const form = $('sharedCreate'),
      choice = agentChoices.get(form.elements.agentId.value),
      ready = agentReady(choice);
    form.elements.agentId.disabled = !agentChoices.size;
    form.querySelector('button[type="submit"]').disabled = mutating || agentListLoading || agentListError || !ready;
    $('sharedRefreshAgents').disabled = mutating || agentListLoading;
    $('sharedAgentStatus').textContent = agentListLoading ? (agentChoices.size ? 'Updating your agents…' : 'Loading your agents…') :
      agentListError ? 'Unable to load your agents. Use Refresh agents to try again.' :
      !choice ? 'No agents available. Add an agent from your dashboard, then refresh this list.' :
      ready ? `${choice.name}: Ready to start a shared chat.` :
      choice.runtime ? `${choice.name}: Shared runner offline. Reconnect it, then refresh this list.` :
      `${choice.name}: Connect the shared runner, then refresh this list. Stop its existing listener before connecting.`;
    return ready && !agentListLoading && !agentListError;
  }
  async function loadAgentChoices(runtimes) {
    const request = ++agentListRequest,
      select = $('sharedCreate').elements.agentId;
    agentListLoading = true;
    updateAgentControls();
    try {
      // The account catalogue includes agents without a shared runner and excludes
      // archived agents. Shared readiness still comes only from the shared API.
      const response = await fetch('/api/user/agents', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.agents)) throw new Error('Agents unavailable');
      if (request !== agentListRequest) return;
      const shared = new Map(runtimes.map(runtime => [runtime.agent_id, runtime]));
      const selected = requestedAgent || select.value;
      agentChoices = new Map();
      const options = [];
      for (const agent of data.agents) {
        if (typeof agent.agentId !== 'string' || !agent.agentId || agentChoices.has(agent.agentId)) continue;
        const choice = { name: agent.name || 'Unnamed agent', runtime: shared.get(agent.agentId) };
        agentChoices.set(agent.agentId, choice);
        const status = agentReady(choice) ? 'Ready for shared chat' : choice.runtime ? 'Shared runner offline' : 'Connect shared runner';
        options.push({ value: agent.agentId, text: `${choice.name} — ${status}` });
      }
      const preferred = agentChoices.has(selected) ? selected :
        [...agentChoices].find(([, choice]) => agentReady(choice))?.[0] || '';
      syncOptions(select, options.length ? options : [{ value: '', text: 'No agents available' }], preferred);
      if (requestedAgent) {
        document.querySelector('.chat-new-room').open = true;
        requestedAgent = null;
      }
      agentListError = false;
    } catch (_) {
      if (request !== agentListRequest) return;
      if (!agentChoices.size) syncOptions(select, [{ value: '', text: 'Agents unavailable' }]);
      agentListError = true;
    } finally {
      if (request === agentListRequest) {
        agentListLoading = false;
        updateAgentControls();
      }
    }
  }
  async function listing() {
    const data = await api();
    userId = data.userId;
    const list = $('sharedRooms');
    list.replaceChildren();
    for (const room of data.rooms) {
      const b = action(`${room.title} — ${room.agent_name}${room.status === 'invited' ? ' (invitation)' : ''}${room.unread ? ' · ' + room.unread + ' unread' : ''}`, async () => {
        if (room.status === 'recovering') {
          throw new Error('Another manager must approve your key recovery in this conversation.');
        }
        if (room.status === 'invited') {
          if (!confirm('Join this shared chat? All members see all shared messages. Your role: ' + room.role)) return;
          await api('/' + room.id + '/accept', {});
        }
        await refreshQueue.catch(() => {});
        active = room.id;
        keys = new Map();
        rendered = '';
        replyTo = null;
        question = null;
        window.SharingUI?.setView($('sharedWorkspace'), 'conversation');
        await refresh();
      });
      b.className = 'chat-room';
      b.dataset.chatRoom = room.id;
      b.setAttribute('aria-current', String(room.id === active));
      b.replaceChildren();
      const avatar = node('span', '✧');
      avatar.className = 'chat-avatar chat-avatar-agent';
      avatar.setAttribute('aria-hidden', 'true');
      const copy = node('span');
      copy.className = 'chat-room-copy';
      copy.append(node('strong', room.title), node('small', ' — ' + room.agent_name +
        (room.status === 'invited' ? ' · Invitation' : '') + (room.unread ? ` · ${room.unread} unread` : '')));
      b.append(avatar, copy);
      list.append(b);
      if (room.status === 'invited') list.append(action('Decline ' + room.title, async () => {
        await api('/' + room.id + '/decline', {});
        await listing();
      }));
    }
    await loadAgentChoices(data.agents);
  }
  async function keyRefresh() {
    context = await api('/' + active);
    keys = new Map();
    for (const e of context.keys) keys.set(e.key_version, await C.unwrap(e.wrapped_key, privateKey));
    if (context.room.member.status !== 'active' || context.room.member.role === 'participant') return;
    // Only holders of existing keys can provision. Pending users wait for an unlocked member.
    const version = context.room.key_version;
    const initial = context.keys.length === 0 && context.room.member.role === 'owner' && version === 1;
    if (initial) keys.set(1, await C.newKey());
    if (context.room.rotation_required) keys.set(version + 1, await C.newKey());
    if (initial || context.room.rotation_required || context.members.some(m => m.status === 'pending') || context.guests?.some(m => m.status === 'pending')) {
      const recipients = context.members.filter(m => ['active', 'pending'].includes(m.status));
      if (recipients.some(m => !m.public_key) || !context.agentIdentity?.public_key) return;
      const envelopes = [];
      for (const [v, key] of keys) {
        for (const m of recipients) envelopes.push({
          principal: 'user:' + m.user_id,
          keyVersion: v,
          wrappedKey: await C.wrap(key, m.public_key)
        });
        for (const m of context.guests || []) envelopes.push({
          principal: 'guest:' + m.guest_id,
          keyVersion: v,
          wrappedKey: await C.wrap(key, m.public_key)
        });
        envelopes.push({
          principal: 'agent:' + context.room.agent_id,
          keyVersion: v,
          wrappedKey: await C.wrap(key, context.agentIdentity.public_key)
        });
      }
      // Provision only versions retained by the server; older keys may have no remaining messages.
      const all = await allMessages();
      const needed = new Set(all.filter(m => !m.deleted_at).map(m => m.key_version));
      needed.add(context.room.rotation_required ? version + 1 : version);
      await api('/' + active + '/keys', {
        membershipVersion: context.room.membership_version,
        keyVersion: version,
        envelopes: envelopes.filter(e => needed.has(e.keyVersion))
      });
      context = await api('/' + active);
      keys = new Map();
      for (const e of context.keys) keys.set(e.key_version, await C.unwrap(e.wrapped_key, privateKey));
    }
  }
  async function allMessages() {
    let after = 0,
      messages = [];
    for (;;) {
      const page = await api('/' + active + '/messages?after=' + after);
      messages.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1].seq;
    }
    return messages;
  }
  async function controls() {
    const mine = context.room.member,
      manager = ['owner', 'manager'].includes(mine.role),
      members = $('sharedMembers');
    members.replaceChildren();
    for (const m of context.members) {
      const row = node('div', `${m.display_name || 'Invited member'} · ${m.user_id.slice(0, 6)} — ${m.role}, ${m.status}`);
      if (m.status === 'recovering' && manager && m.user_id !== userId) row.append(action('Approve key recovery', async () => {
        if (!confirm('Verify this participant requested a new encryption identity before granting access to retained history.')) return;
        await api(`/${active}/members/${m.user_id}/recover`, {});
        await refresh();
      }));
      if (m.role !== 'owner' && (manager || m.user_id === userId)) row.append(action(m.user_id === userId ? 'Leave' : 'Remove', async () => {
        if (!confirm('Remove access? Future messages will use a new key. Downloaded copies cannot be revoked.')) return;
        await api(`/${active}/members/${m.user_id}`, {}, 'DELETE');
        if (m.user_id === userId) {
          active = null;
          $('sharedConversation').hidden = true;
        }
        await listing();
        if (active) await refresh();
      }));
      if (mine.role === 'owner' && m.role !== 'owner') row.append(action(m.role === 'manager' ? 'Make participant' : 'Make manager', async () => {
        await api(`/${active}/members/${m.user_id}`, {
          role: m.role === 'manager' ? 'participant' : 'manager'
        }, 'PATCH');
        await refresh();
      }));
      members.append(row);
    }
    for (const id of ['sharedInvite', 'sharedProfile', 'sharedStop', 'sharedRetry', 'sharedSkip']) $(id).hidden = !manager;
    const profiles = $('sharedProfile').elements.profile;
    syncOptions(profiles, (context.runtime?.capabilities.profiles || []).map(p => ({
      value: JSON.stringify(p), text: p.provider + ' / ' + p.model
    })));
    syncOptions($('sharedComposer').elements.address, [{ value: '', text: 'Everyone' },
      ...context.members.filter(m => m.status === 'active').map(m => ({ value: m.user_id, text: name(m.user_id) }))]);
  }
  async function attachment(file, version) {
    const response = await fetch(`/api/user/shared/${active}/files/${file.id}`, {
      headers: {
        'x-csrf-token': app.dataset.csrf
      }
    });
    if (!response.ok) throw new Error('Attachment unavailable');
    const data = new Uint8Array(await response.arrayBuffer());
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: data.slice(0, 12),
      additionalData: new TextEncoder().encode(ctx(version))
    }, keys.get(version), data.slice(12));
    // Always download arbitrary types; only raster images may be displayed inline.
    const safeImage = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    const url = URL.createObjectURL(new Blob([plain], {
      type: safeImage ? file.type : 'application/octet-stream'
    }));
    objectUrls.push(url);
    return {
      url,
      safeImage
    };
  }
  async function render(messages) {
    const sourceRoomId = active;
    const audience = JSON.stringify([sourceRoomId, context.room.key_version, context.room.membership_version,
      ...context.members.map(member => [member.user_id, member.status, member.role]),
      ...(context.guests || []).map(member => [member.guest_id, member.status, member.role])]);
    const signature = JSON.stringify(messages) + audience;
    if (signature === rendered) return;
    const log = $('sharedTimeline'),
      bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const previousForms = new Map([...log.children].filter(node => node.dataset.richSignature)
      .map(node => [node.id, { signature: node.dataset.richSignature, content: node.querySelector('[data-sharing-rich]') }]));
    objectUrls.splice(0).forEach(URL.revokeObjectURL);
    log.replaceChildren();
    const answered = new Set(messages.filter(m => m.question_id).map(m => m.question_id));
    for (const m of messages) {
      const article = node('article');
      article.className = 'chat-message';
      article.id = 'shared-message-' + m.id;
      article.dataset.own = String(m.sender_user_id === userId);
      const who = m.sender_user_id ? (m.display_name || 'Participant') + ' · ' + m.sender_user_id.slice(0, 6) :
        m.sender_guest_id ? (m.display_name || 'Guest') + ' · ' + m.sender_guest_id.slice(0, 6) + ' · guest' : m.display_name || 'Agent';
      const targets = Array.isArray(m.addressed_to_principals) && m.addressed_to_principals.length ?
        m.addressed_to_principals.map(principalName) : m.addressed_to.map(name);
      const avatar = node('span', m.sender_agent_id ? '✧' : (m.display_name || 'P').slice(0, 1).toUpperCase());
      avatar.className = 'chat-avatar' + (m.sender_agent_id ? ' chat-avatar-agent' : '');
      avatar.setAttribute('aria-hidden', 'true');
      const header = node('header');
      const timestamp = node('small', new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      timestamp.title = new Date(m.created_at).toLocaleString();
      header.append(node('strong', who), timestamp);
      article.append(avatar, header);
      if (targets.length) {
        const address = node('p', 'Addressed to: ' + targets.join(', '));
        address.className = 'chat-message-address';
        article.append(address);
      }
      for (const id of m.reply_to) {
        const a = node('a', ' ↪ Reply reference');
        a.href = '#shared-message-' + id;
        article.append(a);
      }
      if (m.deleted_at) {
        article.append(node('p', 'Message deleted'));
        log.append(article);
        continue;
      }
      let content;
      try {
        content = await C.decrypt(keys.get(m.key_version), m.payload, ctx(m.key_version));
      } catch (_) {
        article.append(node('p', 'Unable to decrypt. Unlock the correct account key or request key recovery.'));
        log.append(article);
        continue;
      }
      if (!content || typeof content !== 'object') content = {
        text: String(content)
      };
      const rich = window.RichRendering?.detectRichContent?.(typeof content.text === 'string' ? content.text : JSON.stringify(content.text || ''));
      if (rich && window.RichRendering?.renderRichContent) {
        const richSignature = JSON.stringify(m) + audience;
        const old = previousForms.get(article.id);
        const form = old?.content && old.signature === richSignature ? old.content : window.RichRendering.renderRichContent(rich, response => sendRichResponse(sourceRoomId, m.id, response));
        form.dataset.sharingRich = 'true';
        article.dataset.richSignature = richSignature;
        article.append(form);
      }
      else {
        const text = node('p', content.text || '');
        text.className = 'shared-content';
        article.append(text);
      }
      for (const f of (Array.isArray(content.files) ? content.files : []).filter(f => f && typeof f.id === 'string' && typeof f.name === 'string')) {
        article.append(action('Download ' + f.name, async () => {
          const {
            url
          } = await attachment(f, m.key_version);
          const a = node('a');
          a.href = url;
          a.download = f.name;
          document.body.append(a);
          a.click();
          a.remove();
        }));
        if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) article.append(action('View image', async () => {
          const {
            url
          } = await attachment(f, m.key_version);
          const img = node('img');
          img.alt = f.name;
          img.src = url;
          article.append(img);
        }));
      }
      if (m.kind === 'question') {
        if (answered.has(m.id)) article.append(node('p', 'Answered'));else if (canAnswer(m)) {
          for (const opt of (Array.isArray(content.options) ? content.options : []).filter(o => typeof o === 'string' || o && typeof o.text === 'string')) article.append(action(typeof opt === 'string' ? opt : opt.text, async () => {
            await submitAnswer(m, typeof opt === 'string' ? opt : opt.text);
            await refresh();
          }));
          article.append(action('Answer in your own words', () => {
            question = m;
            replyTo = m.id;
            $('sharedReply').textContent = 'Answering this question (visible to everyone)';
            $('sharedCancelReply').hidden = false;
            $('sharedComposer').elements.text.focus();
          }));
        }
      }
      article.append(action('Reply', () => {
        question = null;
        replyTo = m.id;
        $('sharedReply').textContent = 'Replying to ' + who;
        $('sharedCancelReply').hidden = false;
        $('sharedComposer').elements.text.focus();
      }));
      if (m.sender_user_id === userId || ['owner', 'manager'].includes(context.room.member.role)) article.append(action('Delete', async () => {
        if (!confirm('Delete this message for everyone? Existing downloaded copies cannot be erased.')) return;
        await api(`/${active}/messages/${m.id}`, {}, 'DELETE');
        await refresh();
      }));
      log.append(article);
    }
    rendered = signature;
    if (bottom) log.scrollTop = log.scrollHeight;
  }
  function refresh() {
    refreshQueue = refreshQueue.catch(() => {}).then(refreshNow);
    return refreshQueue;
  }
  async function sendRichResponse(roomId, messageId, response) {
    if (active !== roomId) throw new Error('Return to the original conversation to respond to this form.');
    if (mutating || loading) throw new Error('Please wait for the current request to finish.');
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    if (!text || text.length > 60000) throw new Error('Form response is empty or too large.');
    mutating = true;
    const outbox = `shared-rich-outbox:${userId}:${roomId}:${messageId}`;
    try {
      await refreshQueue.catch(() => {});
      await keyRefresh();
      if (active !== roomId || context.room.rotation_required || context.room.member.status !== 'active') throw new Error('Encrypted access is not ready.');
      const version = context.room.key_version, key = keys.get(version);
      if (!key) throw new Error('Conversation key unavailable.');
      const retained = sessionStorage.getItem(outbox);
      let body = retained ? JSON.parse(retained) : { id: crypto.randomUUID(), keyVersion: version, addressedTo: [], replyTo: [messageId], fileIds: [],
        payload: await C.encrypt(key, { text }, `${roomId}:${version}`) };
      if (body.keyVersion !== version) {
        const originalKey = keys.get(body.keyVersion);
        if (!originalKey) throw new Error('The original response key is unavailable. Your encrypted response is retained.');
        const original = await C.decrypt(originalKey, body.payload, `${roomId}:${body.keyVersion}`);
        body = { ...body, keyVersion: version, payload: await C.encrypt(key, original, `${roomId}:${version}`) };
      }
      sessionStorage.setItem(outbox, JSON.stringify(body));
      await api(`/${roomId}/messages`, body);
      sessionStorage.removeItem(outbox);
      await refresh();
    } catch (failure) { error(failure); throw failure; }
    finally { mutating = false; }
  }
  async function refreshNow() {
    if (!active) return;
    await keyRefresh();
    $('sharedConversation').hidden = false;
    if ($('sharedEmpty')) $('sharedEmpty').hidden = true;
    $('sharedTitle').textContent = context.room.title;
    if ($('sharedRoleBadge')) $('sharedRoleBadge').textContent = context.room.member.role === 'owner' ? 'Owner' : context.room.member.role === 'manager' ? 'Manager' : 'Collaborator';
    const pending = context.room.member.status !== 'active';
    $('sharedComposer').hidden = pending;
    $('sharedStatus').textContent = pending ? 'Waiting for an unlocked manager to provide encrypted access.' : context.room.rotation_required ? 'Key rotation required before sending.' : Date.now() - new Date(context.runtime?.last_seen_at).getTime() > 120000 ? 'Agent offline or stale. Requests remain queued.' : 'Shared chat connected.';
    if (pending) return;
    await controls();
    const messages = await allMessages();
    await render(messages);
    const batches = await api('/' + active + '/batches');
    const uncertain = batches.some(b => b.status === 'uncertain') || context.runtime?.execution_uncertain;
    if (uncertain) $('sharedStatus').textContent = 'An execution needs review before work can continue.';else if (batches.some(b => b.status === 'processing')) $('sharedStatus').textContent += ' Agent is processing a batch.';else if (messages.some(m => (m.sender_user_id || m.sender_guest_id) && !m.batch_id && !m.deleted_at)) $('sharedStatus').textContent += ' Messages queued.';
    if (context.taskSupport && window.SharingUI?.renderTasks) {
      const roomId = active;
      window.SharingUI.renderTasks($('sharedTasks'), await api('/' + roomId + '/tasks'), {
        cancel: async task => { await api(`/tasks/${task.task_id}/cancel`, {}); await refresh(); },
        decide: async (task, action, decision) => { await api(`/tasks/${task.task_id}/actions/${action.actionId}/decision`, { decision, digest: action.digest }); await refresh(); },
        review: context.room.member.role === 'owner' ? async task => {
          const result = await api(`/tasks/${task.task_id}/held-result`);
          const text = [];
          for (const message of result.held_result?.messages || []) {
            const key = keys.get(Number(message.keyVersion));
            if (!key) throw new Error('The original result key is unavailable. Restore your encryption access to review it.');
            text.push((await C.decrypt(key, message.payload, `${roomId}:${message.keyVersion}`)).text || '');
          }
          return text.join('\n\n') || 'No message text is available.';
        } : undefined
      });
    } else if ($('sharedTasks')) $('sharedTasks').hidden = true;
    if (messages.length && document.visibilityState === 'visible') {
      await api('/' + active + '/read', {
        seq: messages[messages.length - 1].seq
      });
      await listing();
    }
  }
  async function submitAnswer(m, text) {
    const v = context.room.key_version;
    return api(`/${active}/questions/${m.id}/answer`, {
      id: crypto.randomUUID(),
      keyVersion: v,
      payload: await C.encrypt(keys.get(v), {
        text
      }, ctx(v))
    });
  }
  $('sharedRecover').onclick = async () => {
    try {
      if (!confirm('Replace your shared identity? Every shared chat will require another manager to approve access.')) return;
      const account = await getStoredEncryptionKey();
      if (!account) throw new Error('Unlock your current account encryption first.');
      await listing();
      const pair = await C.identity(account, 'user:' + userId);
      await api('/identity/recover', {
        ...pair,
        confirm: true
      });
      privateKey = await C.privateKey(account, pair.privateKey, 'user:' + userId);
      active = null;
      keys.clear();
      $('sharedConversation').hidden = true;
      $('sharedUnlock').hidden = true;
      $('sharedWorkspace').hidden = false;
      await listing();
    } catch (e) {
      error(e);
    }
  };
  bind('sharedUnlock', async form => {
    const account = await getStoredEncryptionKey();
    if (!account) throw new Error('Open your private dashboard and unlock encryption first, then return here.');
    await listing();
    ownName = form.elements.displayName.value.trim();
    let saved = await api('/identity');
    if (!saved) {
      const pair = await C.identity(account, 'user:' + userId);
      saved = await api('/identity', {
        ...pair,
        displayName: ownName
      }, 'PUT');
    }
    privateKey = await C.privateKey(account, saved.private_key, 'user:' + userId);
    $('sharedUnlock').hidden = true;
    $('sharedWorkspace').hidden = false;
    await listing();
  });
  bind('sharedCreate', async form => {
    if (!updateAgentControls()) throw new Error($('sharedAgentStatus').textContent);
    const r = await api('', {
      agentId: form.elements.agentId.value,
      title: form.elements.title.value
    });
    active = r.id;
    rendered = '';
    window.SharingUI?.setView($('sharedWorkspace'), 'conversation');
    await listing();
    await refresh();
  });
  $('sharedCreate').elements.agentId.onchange = updateAgentControls;
  $('sharedRefreshAgents').onclick = () => {
    if (!mutating && !agentListLoading) listing().catch(error);
  };
  bind('sharedInvite', async form => {
    await api('/' + active + '/invitations', {
      email: form.elements.email.value,
      role: form.elements.role.value
    });
    form.reset();
    await refresh();
  });
  bind('sharedProfile', async form => {
    if (!confirm('Change the provider/model for every conversation using this agent?')) return;
    await api('/' + active + '/control', {
      action: 'profile',
      ...JSON.parse(form.elements.profile.value)
    });
    await refresh();
  });
  for (const [id, act] of [['sharedStop', 'stop'], ['sharedRetry', 'retry'], ['sharedSkip', 'skip']]) $(id).onclick = async () => {
    try {
      if (!confirm(act === 'stop' ? 'Request a stop across all conversations? External tools may require separate stopping.' : 'Confirm you inspected the runtime. Retrying can repeat actions; skipping discards this batch.')) return;
      await api('/' + active + '/control', {
        action: act
      });
      await refresh();
    } catch (e) {
      error(e);
    }
  };
  $('sharedCancelReply').onclick = () => {
    replyTo = null;
    question = null;
    $('sharedReply').textContent = '';
    $('sharedCancelReply').hidden = true;
  };
  bind('sharedComposer', async form => {
    const pendingKey = 'shared-outbox:' + userId + ':' + active;
    const pending = sessionStorage.getItem(pendingKey);
    if (pending) {
      const saved = JSON.parse(pending);
      try {
        await api(saved.path, saved.body);
      } catch (e) {
        if (e.status !== 409 || !['Stale conversation key', 'Conversation key rotation is required'].includes(e.message)) throw e;
        await keyRefresh();
        const oldVersion = saved.body.keyVersion,
          nextVersion = context.room.key_version;
        if (context.room.rotation_required || !keys.has(oldVersion) || !keys.has(nextVersion)) throw new Error('Waiting for conversation keys; your unsent message is preserved.');
        const content = await C.decrypt(keys.get(oldVersion), saved.body.payload, ctx(oldVersion));
        for (const f of content.files || []) {
          const response = await fetch(`/api/user/shared/${active}/files/${f.id}`);
          if (!response.ok) throw new Error('Unsent attachment unavailable; message preserved.');
          const bytes = new Uint8Array(await response.arrayBuffer());
          const fileVersion = Number(response.headers.get('X-Shared-Key-Version')) || oldVersion;
          const plain = await crypto.subtle.decrypt({
            name: 'AES-GCM',
            iv: bytes.slice(0, 12),
            additionalData: new TextEncoder().encode(ctx(fileVersion))
          }, keys.get(fileVersion), bytes.slice(12));
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt({
            name: 'AES-GCM',
            iv,
            additionalData: new TextEncoder().encode(ctx(nextVersion))
          }, keys.get(nextVersion), plain);
          const data = new FormData();
          data.append('id', f.id);
          data.append('keyVersion', nextVersion);
          data.append('file', new Blob([iv, encrypted]), 'encrypted.bin');
          await api('/' + active + '/files', data);
        }
        saved.body.payload = await C.encrypt(keys.get(nextVersion), content, ctx(nextVersion));
        saved.body.keyVersion = nextVersion;
        saved.body.addressedTo = saved.body.addressedTo.filter(id => context.members.some(m => m.user_id === id && m.status === 'active'));
        sessionStorage.setItem(pendingKey, JSON.stringify(saved));
        await api(saved.path, saved.body);
      }
      sessionStorage.removeItem(pendingKey);
      form.reset();
      $('sharedCancelReply').click();
      await refresh();
      return;
    }
    const text = form.elements.text.value.trim(),
      files = [...form.elements.files.files];
    if (!text && !files.length) throw new Error('Write a message or attach a file.');
    if (files.length > 10 || files.some(f => f.size > 20000000)) throw new Error('Up to ten files, 20 MB each.');
    await keyRefresh();
    if (context.room.rotation_required) throw new Error('Key rotation is pending.');
    const v = context.room.key_version,
      key = keys.get(v);
    if (!key) throw new Error('Conversation key unavailable');
    if (question) {
      if (files.length) throw new Error('Send attachments as a separate message before answering.');
      await submitAnswer(question, text);
    } else {
      const attachments = [];
      for (const f of files) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({
          name: 'AES-GCM',
          iv,
          additionalData: new TextEncoder().encode(ctx(v))
        }, key, await f.arrayBuffer());
        const id = crypto.randomUUID(),
          data = new FormData();
        data.append('id', id);
        data.append('keyVersion', v);
        data.append('file', new Blob([iv, ciphertext]), 'encrypted.bin');
        await api('/' + active + '/files', data);
        attachments.push({
          id,
          name: f.name,
          type: f.type || 'application/octet-stream'
        });
      }
      const id = crypto.randomUUID(),
        payload = await C.encrypt(key, {
          text,
          files: attachments
        }, ctx(v));
      const sendPath = '/' + active + '/messages',
        sendBody = {
          id,
          keyVersion: v,
          payload,
          fileIds: attachments.map(f => f.id),
          addressedTo: form.elements.address.value ? [form.elements.address.value] : [],
          replyTo: replyTo ? [replyTo] : []
        };
      sessionStorage.setItem(pendingKey, JSON.stringify({
        path: sendPath,
        body: sendBody
      }));
      try {
        await api(sendPath, sendBody);
      } catch (e) {
        throw new Error(e.message + ' Your encrypted outgoing message is retained; press Send to retry that same message.');
      }
      sessionStorage.removeItem(pendingKey);
    }
    form.reset();
    $('sharedCancelReply').click();
    await refresh();
  });
  setInterval(async () => {
    if (!privateKey || loading || mutating) return;
    loading = true;
    try {
      await listing();
      await refresh();
    } catch (e) {
      error(e);
    } finally {
      loading = false;
    }
  }, 5000);
})().catch(e => {
  document.getElementById('sharedError').textContent = e.message;
});
