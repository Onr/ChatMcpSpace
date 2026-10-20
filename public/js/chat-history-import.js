/* Owner-side in-browser conversion of a private agent timeline into its shared thread. */
(function (root) {
  'use strict';
  function sessionFetch(url, options) {
    return (root.csrfFetch || root.fetch)(url, options);
  }
  const dialog = document.getElementById('shareExistingChatDialog');
  const trigger = document.getElementById('headerShareExistingChatBtn');
  if (!dialog || !trigger) return;
  const status = document.getElementById('shareExistingChatStatus');
  const previewNode = document.getElementById('shareExistingChatPreview');
  const invitesPanel = document.getElementById('shareExistingChatInvites');
  const inviteList = document.getElementById('shareInviteList');
  const guestControls = document.getElementById('shareGuestControls');
  const prepareButton = document.getElementById('shareExistingChatPrepare');
  const retryButton = document.getElementById('shareExistingChatRetry');
  let captured = null;
  let preview = null;
  let busy = false;
  let guestShareId = null;
  let guestShareConversationId = null;
  let guestShareDiscoveryRequest = 0;
  let sharePanelConversationId = null;
  let activeImport = null;
  let dialogEpoch = 0;
  let focusReturn = null;
  let openAgentRequest = 0;
  let importDbPromise = null;

  function openImportDb() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!importDbPromise) importDbPromise = new Promise((resolve, reject) => {
      const openRequest = root.indexedDB.open('shared-history-import-cache', 1);
      openRequest.onupgradeneeded = () => openRequest.result.createObjectStore('encrypted');
      openRequest.onsuccess = () => resolve(openRequest.result);
      openRequest.onerror = () => reject(openRequest.error);
    });
    return importDbPromise;
  }
  async function cacheGet(key) {
    const db = await openImportDb();
    if (!db) { try { return JSON.parse(sessionStorage.getItem(`history-cache:${key}`) || 'null'); } catch (_) { return null; } }
    return new Promise((resolve, reject) => {
      const request = db.transaction('encrypted', 'readonly').objectStore('encrypted').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  async function cachePut(key, value) {
    const db = await openImportDb();
    if (!db) { sessionStorage.setItem(`history-cache:${key}`, JSON.stringify(value)); return; }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      tx.objectStore('encrypted').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Could not save encrypted history progress.'));
    });
  }
  async function cacheDelete(key) {
    const db = await openImportDb();
    if (!db) { sessionStorage.removeItem(`history-cache:${key}`); return; }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      tx.objectStore('encrypted').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function cacheDeleteImport(importId) {
    const prefixes = [`file:${importId}:`, `chunk:${importId}:`];
    const db = await openImportDb();
    if (!db) {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key && prefixes.some(prefix => key.startsWith(`history-cache:${prefix}`))) sessionStorage.removeItem(key);
      }
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction('encrypted', 'readwrite');
      const store = tx.objectStore('encrypted');
      const keys = store.getAllKeys();
      keys.onsuccess = () => keys.result.filter(key => prefixes.some(prefix => String(key).startsWith(prefix))).forEach(key => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function isCurrent(epoch, conversationId) {
    if (epoch !== dialogEpoch || dialog.classList.contains('hidden')) return false;
    const selected = root.DashboardHelpers?.getSelectedAgentIdentity?.();
    if (captured?.agentId && selected?.agentId !== captured.agentId) return false;
    const active = root.InPlaceChat?.getContext?.();
    if (conversationId && selected?.conversationId && selected.conversationId !== conversationId) return false;
    if (conversationId && active?.mode === 'shared' && active.conversationId !== conversationId) return false;
    if (!conversationId) return true;
    return captured?.conversationId === conversationId;
  }
  function localDateTimeValue(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function request(path, body, method) {
    return sessionFetch('/api/user/chat-threads' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': root.csrfToken || '' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Could not prepare this conversation.');
      return data;
    });
  }
  function open() {
    if (busy) return;
    const epoch = ++dialogEpoch;
    focusReturn = document.activeElement;
    captured = root.DashboardHelpers?.getSelectedAgentIdentity?.();
    const nextConversationId = captured?.conversationId || null;
    if (sharePanelConversationId !== nextConversationId) resetConversationShareState(nextConversationId);
    prepareButton.hidden = false;
    prepareButton.textContent = 'Share this conversation';
    document.getElementById('shareExistingChatCancel').textContent = 'Cancel';
    dialog.classList.remove('hidden');
    dialog.classList.add('flex');
    [trigger, document.getElementById('selectedChatContextStatus')].forEach(button => button?.setAttribute('aria-expanded', 'true'));
    status.textContent = 'Checking the conversation and history scope…';
    previewNode.textContent = '';
    previewNode.hidden = false;
    if (retryButton) retryButton.hidden = true;
    invitesPanel.hidden = true;
    if (guestControls) guestControls.hidden = true;
    prepareButton.disabled = true;
    const title = document.getElementById('shareExistingChatTitle');
    if (title) title.textContent = captured?.agentName ? `Share ${captured.agentName}` : 'Share this conversation';
    preview = null;
    if (!captured || captured.agentType === 'news_feed') {
      status.textContent = 'Select one of your private agent conversations to share it.';
      return;
    }
    if (captured.mode === 'shared') {
      prepareButton.hidden = true;
      document.getElementById('shareExistingChatCancel').textContent = 'Done';
      if (captured.role !== 'owner') {
        status.textContent = 'People in this conversation. Only the owner can manage access.';
        void loadSharedAudience(epoch, captured.conversationId);
        document.getElementById('shareExistingChatClose').focus();
        return;
      }
      previewNode.hidden = true;
      invitesPanel.hidden = false;
      void root.CouncilSharing?.loadMessagingSettings(captured);
      if (guestControls) guestControls.hidden = false;
      status.textContent = 'Invite someone into this same conversation. They can join from the email or dashboard inbox.';
      void loadInvitations(epoch, captured.conversationId);
      void discoverGuestShare(epoch, captured.conversationId, captured.agentId);
      (document.getElementById('shareInviteEmail') || document.getElementById('shareExistingChatClose')).focus();
      return;
    }
    invitesPanel.hidden = false;
    const inviteEmailInput = document.getElementById('shareInviteEmail');
    if (inviteEmailInput) inviteEmailInput.disabled = false;
    const inviteSubmit = document.getElementById('shareInviteSubmit');
    if (inviteSubmit) inviteSubmit.disabled = false;
    const inviteDelivery = document.getElementById('shareInviteDelivery');
    if (inviteDelivery) inviteDelivery.textContent = 'Add an email now. The invitation will be sent after you finish sharing this conversation.';
    (document.getElementById('shareExistingChatClose') || prepareButton).focus();
    void loadPreview(epoch);
  }
  function resetConversationShareState(conversationId) {
    sharePanelConversationId = conversationId;
    guestShareId = null;
    guestShareConversationId = null;
    guestShareDiscoveryRequest += 1;
    activeImport = null;
    for (const id of ['shareGuestPasscode','shareGuestLinkValue','shareInviteEmail','shareInviteSignupLink','shareGuestExpiresAt']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
    for (const id of ['shareGuestLinkResult','shareInviteSignupResult']) {
      const result = document.getElementById(id);
      if (result) result.hidden = true;
    }
    const link = document.getElementById('shareGuestLinkCreate');
    if (link) { link.textContent = 'Create guest link'; link.disabled = true; }
    const revoke = document.getElementById('shareGuestLinkDisable');
    if (revoke) revoke.hidden = true;
    const clearPasscode = document.getElementById('shareGuestClearPasscode');
    if (clearPasscode) clearPasscode.checked = false;
    const linkStatus = document.getElementById('shareGuestLinkStatus');
    if (linkStatus) linkStatus.textContent = 'Guest access will use this same conversation.';
    const inviteDelivery = document.getElementById('shareInviteDelivery');
    if (inviteDelivery) inviteDelivery.textContent = 'Add an email now. The invitation will be sent after you finish sharing this conversation.';
  }
  function close() {
    if (busy) return;
    dialogEpoch += 1;
    openAgentRequest += 1;
    dialog.classList.add('hidden');
    dialog.classList.remove('flex');
    [trigger, document.getElementById('selectedChatContextStatus')].forEach(button => button?.setAttribute('aria-expanded', 'false'));
    (focusReturn || trigger).focus?.();
  }
  async function loadSharedAudience(epoch, conversationId) {
    try {
      const response = await sessionFetch('/api/user/shared/' + encodeURIComponent(conversationId), { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load the people in this conversation.');
      const details = await response.json();
      if (!isCurrent(epoch, conversationId)) return;
      previewNode.replaceChildren();
      for (const person of [...(details.members || []), ...(details.guests || [])].filter(person => person.status !== 'removed')) {
        const row = document.createElement('p');
        row.textContent = `${person.display_name || 'Participant'} · ${person.role === 'owner' ? 'Owner' : person.status === 'active' ? 'Joined' : 'Access pending'}`;
        previewNode.append(row);
      }
    } catch (error) { if (isCurrent(epoch, conversationId)) status.textContent = error.message; }
  }
  async function loadPreview(epoch) {
    prepareButton.disabled = true;
    preview = null;
    previewNode.hidden = true;
    if (retryButton) retryButton.hidden = true;
    try {
      const agentId = captured.agentId;
      const context = await request('/resolve', { agentId });
      if (!isCurrent(epoch) || context.agentId !== agentId) return;
      if (!captured || context.agentId !== captured.agentId || !['private','preparing'].includes(context.state)) {
        throw new Error('This conversation is already being shared or is not available.');
      }
      captured = { ...captured, conversationId: context.conversationId, ownerId: context.ownerId };
      if (sharePanelConversationId !== context.conversationId) {
        const inviteEmail = document.getElementById('shareInviteEmail')?.value || '';
        resetConversationShareState(context.conversationId);
        const inviteEmailNode = document.getElementById('shareInviteEmail');
        if (inviteEmailNode) inviteEmailNode.value = inviteEmail;
      }
      const title = document.getElementById('shareExistingChatTitle');
      if (title) title.textContent = `Share ${context.agentName || 'this conversation'}`;
      preview = await request('/' + encodeURIComponent(context.conversationId) + '/share-preview');
      if (!isCurrent(epoch, context.conversationId)) return;
      activeImport = context.state === 'preparing'
        ? await request('/' + encodeURIComponent(context.conversationId) + '/imports/active') : null;
      if (!isCurrent(epoch, context.conversationId)) return;
      const abortButton = document.getElementById('shareHistoryAbort');
      if (abortButton) abortButton.hidden = !activeImport;
      if (preview.excludedAttachments || preview.pendingScheduledMessages) {
        status.textContent = preview.excludedAttachments
          ? 'This conversation contains files that cannot be converted. No history has been moved.'
          : 'Pending private scheduled messages must be delivered or canceled before sharing. No history has been moved.';
      } else if (preview.runtimeReady === false && context.state !== 'preparing') {
        status.textContent = 'This agent\'s shared runner is offline or not connected yet, so it could not answer people you invite. Connect the shared runner on the machine where this agent runs, then press Try again. No history has been moved.';
        if (retryButton) retryButton.hidden = false;
      } else {
        status.textContent = context.state === 'preparing'
          ? `Saved preparation: ${activeImport?.importedItems || 0} of ${activeImport?.expectedItems || 0} messages converted. Resume here; your history remains private until completion.`
          : 'Review the source scope before converting. Your private history is read and re-encrypted in this browser.';
        prepareButton.disabled = false;
        if (context.state === 'preparing') prepareButton.textContent = 'Resume preparation';
      }
      previewNode.textContent = `${preview.agentName}: ${preview.includedMessages} messages and ${preview.includedFiles || 0} files will be included.`;
      previewNode.hidden = false;
    } catch (error) {
      if (isCurrent(epoch)) {
        status.textContent = `${error.message} Try again to load sharing options.`;
        if (retryButton) retryButton.hidden = false;
      }
    }
  }
  async function loadInvitations(epoch = dialogEpoch, conversationId = captured?.conversationId) {
    if (!conversationId) return;
    try {
      const rows = await request('/' + encodeURIComponent(conversationId) + '/invitations');
      if (!isCurrent(epoch, conversationId)) return;
      inviteList.replaceChildren();
      const history = document.getElementById('shareHistoricalInvitationList');
      if (history) history.replaceChildren();
      const oldInvitations = rows.filter(item => item.state !== 'pending');
      const historyPanel = document.getElementById('shareInvitationHistory');
      if (historyPanel) historyPanel.hidden = oldInvitations.length === 0;
      const roomResponse = await sessionFetch('/api/user/shared/' + encodeURIComponent(conversationId), { credentials: 'same-origin', cache: 'no-store' });
      if (roomResponse.ok) {
        const details = await roomResponse.json();
        if (!isCurrent(epoch, conversationId)) return;
        const rosterHeading = document.createElement('p');
        rosterHeading.className = 'font-semibold text-slate-200';
        rosterHeading.textContent = 'People with access';
        inviteList.append(rosterHeading);
        for (const member of details.members || []) {
          if (member.role === 'owner') continue;
          const row = document.createElement('div');
          row.className = 'flex items-center justify-between gap-2';
          const label = document.createElement('span');
          const memberState = ({ active: 'Joined', pending: 'Activating encrypted access', invited: 'Invited', recovering: 'Needs identity verification', removed: 'Removed' })[member.status] || member.status;
          label.textContent = `${member.display_name || 'Collaborator'} · ${memberState}`;
          row.append(label);
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'min-h-11 px-2 text-amber-300'; remove.textContent = 'Remove';
          remove.setAttribute('aria-label', `Remove ${member.display_name || 'collaborator'}`);
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              const response = await sessionFetch(`/api/user/shared/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(member.user_id)}`, {
                method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': root.csrfToken || '' }
              });
              const result = await response.json().catch(() => ({}));
              if (!response.ok) throw new Error(result.error?.message || 'Could not remove this person.');
              if (!isCurrent(epoch, conversationId)) return;
              const context = root.InPlaceChat?.getContext?.();
              if (context?.conversationId === conversationId) await root.InPlaceChat.prepareOwnerShare(context);
              if (isCurrent(epoch, conversationId)) await loadInvitations(epoch, conversationId);
            } catch (error) { if (isCurrent(epoch, conversationId)) status.textContent = error.message; remove.disabled = false; }
          });
          row.append(remove);
          inviteList.append(row);
        }
        for (const guest of details.guests || []) {
          const row = document.createElement('div');
          row.className = 'flex items-center justify-between gap-2';
          const label = document.createElement('span');
          label.textContent = `${guest.display_name || 'Guest'} · ${guest.status}`;
          row.append(label);
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'min-h-11 px-2 text-amber-300'; remove.textContent = 'Remove guest';
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              if (!guestShareId) await discoverGuestShare(epoch, conversationId, captured.agentId);
              if (!guestShareId) throw new Error('Guest link details are unavailable.');
              const response = await sessionFetch(`/api/user/shared/guest-shares/${encodeURIComponent(guestShareId)}/guests/${encodeURIComponent(guest.guest_id)}`, {
                method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': root.csrfToken || '' }
              });
              const result = await response.json().catch(() => ({}));
              if (!response.ok) throw new Error(result.error?.message || 'Could not remove this guest.');
              if (!isCurrent(epoch, conversationId)) return;
              const context = root.InPlaceChat?.getContext?.();
              if (context?.conversationId === conversationId) await root.InPlaceChat.prepareOwnerShare(context);
              if (isCurrent(epoch, conversationId)) await loadInvitations(epoch, conversationId);
            } catch (error) { if (isCurrent(epoch, conversationId)) status.textContent = error.message; remove.disabled = false; }
          });
          row.append(remove);
          inviteList.append(row);
        }
      }
      for (const item of rows.filter(item => item.state === 'pending')) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2';
        const label = document.createElement('span');
        const invitationState = ({ pending: 'Invitation pending', accepted: 'Joined', declined: 'Declined', revoked: 'Revoked', expired: 'Expired' })[item.state] || 'Invitation status unknown';
        const deliveryState = ({ sent: 'Email sent', in_app_only: 'Available in app', queued: 'Email queued', failed: 'Delivery failed', not_available: 'Email unavailable' })[item.deliveryState] || 'Delivery status unknown';
        label.textContent = `${item.recipientEmail} · ${invitationState} · ${deliveryState}`;
        row.append(label);
        if (item.state === 'pending') {
          if (item.deliveryState !== 'sent') {
            const resend = document.createElement('button');
            resend.type = 'button'; resend.className = 'min-h-11 px-2 text-cyan-300'; resend.textContent = 'Resend email';
            resend.addEventListener('click', async () => {
              resend.disabled = true;
              try {
                const result = await request('/invitations/' + encodeURIComponent(item.invitationId) + '/resend', {}, 'POST');
                if (!isCurrent(epoch, conversationId)) return;
                document.getElementById('shareInviteDelivery').textContent = result.deliveryState === 'sent'
                  ? `Invitation email sent to ${item.recipientEmail}.`
                  : 'Email could not be sent. The invite remains available in the recipient’s dashboard inbox.';
                await loadInvitations(epoch, conversationId);
              } catch (error) { if (isCurrent(epoch, conversationId)) status.textContent = error.message; resend.disabled = false; }
            });
            row.append(resend);
          }
          const revoke = document.createElement('button');
          revoke.type = 'button'; revoke.className = 'min-h-11 px-2 text-amber-300'; revoke.textContent = 'Revoke';
          revoke.addEventListener('click', async () => {
            await request('/invitations/' + encodeURIComponent(item.invitationId), undefined, 'DELETE');
            if (isCurrent(epoch, conversationId)) await loadInvitations(epoch, conversationId);
          });
          row.append(revoke);
        }
        inviteList.append(row);
      }
      for (const item of oldInvitations) {
        const row = document.createElement('p');
        row.textContent = `${item.recipientEmail} · ${item.state} · ${item.deliveryState}`;
        history?.append(row);
      }
    } catch (error) { status.textContent = error.message; }
  }
  async function submitInvitation() {
    const input = document.getElementById('shareInviteEmail');
    const email = input.value.trim();
    if (!captured?.conversationId || !email) return;
    if (captured.mode !== 'shared') {
      document.getElementById('shareInviteDelivery').textContent = `${email} will be invited as soon as you press "Share this conversation" and sharing finishes.`;
      return;
    }
    const epoch = dialogEpoch;
    const conversationId = captured.conversationId;
    const button = document.getElementById('shareInviteSubmit');
    button.disabled = true;
    try {
      const requestId = crypto.randomUUID();
      const created = await request('/' + encodeURIComponent(conversationId) + '/invitations', { email, requestId });
      if (!isCurrent(epoch, conversationId)) return;
      input.value = '';
      document.getElementById('shareInviteDelivery').textContent = created.deliveryState === 'sent'
        ? `Invitation email sent to ${created.recipientEmail}.`
        : `Invitation saved for ${created.recipientEmail}; they can join from their dashboard inbox. Email delivery: ${created.deliveryState}.`;
      if (created.invitationId) {
        document.getElementById('shareInviteSignupLink').value = `${root.location.origin}/join/invitation/${encodeURIComponent(created.invitationId)}`;
        document.getElementById('shareInviteSignupResult').hidden = false;
      }
      await loadInvitations(epoch, conversationId);
    } catch (error) { if (isCurrent(epoch, conversationId)) document.getElementById('shareInviteDelivery').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function createGuestLink() {
    if (!captured?.conversationId || !captured?.agentId) return;
    const epoch = dialogEpoch;
    const conversationId = captured.conversationId;
    const agentId = captured.agentId;
    const agentName = captured.agentName;
    const button = document.getElementById('shareGuestLinkCreate');
    if (guestShareConversationId !== conversationId) {
      document.getElementById('shareGuestLinkStatus').textContent = 'Still checking guest access for this conversation. Try again in a moment.';
      return;
    }
    const statusNode = document.getElementById('shareGuestLinkStatus');
    const passphrase = document.getElementById('shareGuestPasscode')?.value || '';
    const expiryInput = document.getElementById('shareGuestExpiresAt');
    if (passphrase && (passphrase.length < 12 || new root.Blob([passphrase]).size > 72)) {
      statusNode.textContent = 'A guest passphrase must be 12–72 UTF-8 bytes.';
      return;
    }
    button.disabled = true;
    try {
      const rotating = Boolean(guestShareId);
      if (rotating && !root.confirm('Replace this guest link? Current guests will be signed out and need to join again with the new link.')) return;
      if (!isCurrent(epoch, conversationId) || captured.agentId !== agentId) throw new Error('The selected conversation changed. Reopen Share and try again.');
      const body = rotating ? { replaceLink: true } : { conversationId, agentIds: [agentId], roomMode: 'common', title: agentName || 'Shared conversation' };
      if (passphrase) body.password = passphrase;
      else if (rotating && document.getElementById('shareGuestClearPasscode')?.checked) body.password = '';
      if (expiryInput?.value) body.expiresAt = new Date(expiryInput.value).toISOString();
      const response = await sessionFetch('/api/user/shared/guest-shares'+(rotating?'/'+encodeURIComponent(guestShareId):''), {
        method:rotating?'PATCH':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':root.csrfToken||''},
        body:JSON.stringify(body)
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(result.error?.message||'Could not create a guest link.');
      if (!isCurrent(epoch, conversationId)) return;
      guestShareId=result.shareId;
      guestShareConversationId=conversationId;
      const clearPasscode = document.getElementById('shareGuestClearPasscode');
      if (clearPasscode) clearPasscode.checked = false;
      const url=`${root.location.origin}/guest#${result.linkSecret}`;
      document.getElementById('shareGuestLinkValue').value=url;
      document.getElementById('shareGuestLinkResult').hidden=false;
      statusNode.textContent=rotating?'Guest link replaced; previous guest sessions were signed out. Copy the new link and send it to the invited guests.':'Guest link created for this conversation. Copy it now; the secret is shown only once.';
      const disable = document.getElementById('shareGuestLinkDisable');
      if (disable) disable.hidden = false;
    } catch(error) { if (isCurrent(epoch, conversationId)) statusNode.textContent=error.message; }
    finally { button.disabled=false; }
  }
  async function discoverGuestShare(epoch = dialogEpoch, conversationId = captured?.conversationId, agentId = captured?.agentId) {
    if(!guestControls || !conversationId) return;
    const requestId = ++guestShareDiscoveryRequest;
    guestShareId = null;
    guestShareConversationId = null;
    const button = document.getElementById('shareGuestLinkCreate');
    button.disabled = true;
    try {
      const response=await sessionFetch('/api/user/shared/guest-shares',{method:'GET',credentials:'same-origin',cache:'no-store'});
      if(!response.ok) throw new Error('Could not check guest access for this conversation.');
      const shares=await response.json();
      if (!isCurrent(epoch, conversationId) || requestId !== guestShareDiscoveryRequest || captured?.agentId !== agentId) return;
      const share=shares.find(item=>!item.revoked_at && item.room_mode==='common' && item.agents?.some(agent=>agent.agent_id===agentId && agent.room_id===conversationId));
      guestShareConversationId = conversationId;
      if(share) {
        guestShareId=share.shareId;
        button.textContent='Replace guest link';
        const expiry = document.getElementById('shareGuestExpiresAt');
        if (expiry && share.expires_at) expiry.value = localDateTimeValue(share.expires_at);
        document.getElementById('shareGuestLinkStatus').textContent = `Guest link is active${share.expires_at ? ` until ${new Date(share.expires_at).toLocaleString()}` : ' with no expiry'}. Replace it to change its one-time secret or access code.`;
        const disable = document.getElementById('shareGuestLinkDisable');
        if (disable) disable.hidden = false;
      }
    } catch(error) {
      if (isCurrent(epoch, conversationId) && requestId === guestShareDiscoveryRequest) document.getElementById('shareGuestLinkStatus').textContent = error.message || 'Could not check guest access.';
    } finally {
      if (isCurrent(epoch, conversationId) && requestId === guestShareDiscoveryRequest) button.disabled = false;
    }
  }

  async function disableGuestLink() {
    const conversationId = captured?.conversationId;
    const shareId = guestShareId;
    const epoch = dialogEpoch;
    if (!conversationId || !shareId || guestShareConversationId !== conversationId) return;
    if (!root.confirm('Disable guest access? Current guest sessions will be signed out and this link will stop working.')) return;
    const button = document.getElementById('shareGuestLinkDisable');
    button.disabled = true;
    try {
      const response = await sessionFetch('/api/user/shared/guest-shares/' + encodeURIComponent(shareId), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': root.csrfToken || '' },
        body: JSON.stringify({ revoked: true })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || 'Could not disable guest access.');
      if (!isCurrent(epoch, conversationId) || guestShareId !== shareId) return;
      guestShareId = null;
      document.getElementById('shareGuestLinkCreate').textContent = 'Create guest link';
      document.getElementById('shareGuestLinkResult').hidden = true;
      document.getElementById('shareGuestLinkValue').value = '';
      document.getElementById('shareGuestLinkStatus').textContent = 'Guest access disabled. Existing guest sessions were signed out.';
      button.hidden = true;
    } catch (error) {
      if (isCurrent(epoch, conversationId)) document.getElementById('shareGuestLinkStatus').textContent = error.message;
    } finally { button.disabled = false; }
  }
  async function convert() {
    if (busy || !captured || !preview || preview.excludedAttachments || preview.pendingScheduledMessages) return;
    const epoch = dialogEpoch;
    const target = { ...captured };
    busy = true;
    prepareButton.disabled = true;
    document.getElementById('shareExistingChatClose').disabled = true;
    document.getElementById('shareExistingChatCancel').disabled = true;
    const input = document.getElementById('userMessageInput');
    const draft = input?.value || '';
    const area = document.getElementById('conversationArea');
    const scroll = area?.scrollTop || 0;
    let started = Boolean(activeImport);
    try {
      const requestKey = `sharing-import-request:${target.conversationId}`;
      let requestId = sessionStorage.getItem(requestKey);
      if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(requestKey, requestId); }
      await root.InPlaceChat.ensureIdentity();
      if (!isCurrent(epoch, target.conversationId)) throw new Error('The selected conversation changed. Reopen Share to continue.');
      let result = activeImport
        ? await request('/imports/' + encodeURIComponent(activeImport.importId))
        : await request('/' + target.conversationId + '/imports', { requestId, sourceFingerprint: preview.sourceFingerprint });
      started = true;
      if (!isCurrent(epoch, target.conversationId)) throw new Error('The selected conversation changed. Reopen Share to continue.');
      const importKey = `sharing-import-mappings:${result.importId}`;
      let mappings = {};
      try { mappings = JSON.parse(sessionStorage.getItem(importKey) || '{}'); } catch (_) {}
      const ownerKey = root.DashboardHelpers?.getEncryptionKey?.();
      const prepared = await root.InPlaceChat.prepareOwnerShare({ ...captured, mode: 'shared', capabilities: { read: true, send: false } });
      const chunkSize = 40;
      for (let offset = Number(result.importedItems || 0); offset < result.expectedItems; ) {
        const chunkKey = `chunk:${result.importId}:${offset}`;
        let converted = await cacheGet(chunkKey);
        if (!converted) {
        const page = await request(`/imports/${result.importId}/source?offset=${offset}&limit=${chunkSize}`);
        if (!isCurrent(epoch, target.conversationId)) throw new Error('The selected conversation changed. Reopen Share to continue.');
        if (!page.items.length && offset < result.expectedItems) throw new Error('History conversion stopped before all captured messages were read.');
        converted = [];
        for (const source of page.items) {
          const mapKey = `${source.sourceKind}:${source.sourceId}`;
          let targetMessageId = mappings[mapKey];
          if (!targetMessageId) { targetMessageId = crypto.randomUUID(); mappings[mapKey] = targetMessageId; }
          let text = source.content || '';
          if (source.encrypted) {
            if (!ownerKey) throw new Error('Unlock your account encryption to convert this history.');
            text = await root.E2EEncryption.decryptMessage(text, ownerKey);
          }
          const fileIds = [];
          const sharedFiles = [];
          for (const sourceFile of source.metadata?.attachments || []) {
            const fileKey = `file:${sourceFile.attachmentId}`;
            let fileId = mappings[fileKey];
            if (!fileId) { fileId = crypto.randomUUID(); mappings[fileKey] = fileId; }
            let encryptedBytesBase64 = await cacheGet(`file:${result.importId}:${sourceFile.attachmentId}`);
            if (!encryptedBytesBase64 && mappings[`${fileKey}:encrypted`]) {
              encryptedBytesBase64 = mappings[`${fileKey}:encrypted`];
              await cachePut(`file:${result.importId}:${sourceFile.attachmentId}`, encryptedBytesBase64);
              delete mappings[`${fileKey}:encrypted`];
            }
            if (!encryptedBytesBase64) {
              const response = await sessionFetch(`/api/user/attachments/${encodeURIComponent(sourceFile.attachmentId)}`, { credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok) throw new Error(`Could not read source attachment ${sourceFile.fileName || ''}.`);
              let plain = new Uint8Array(await response.arrayBuffer());
              if (sourceFile.encrypted) {
                if (!ownerKey) throw new Error('Unlock your account encryption to convert this attachment.');
                plain = new Uint8Array(await root.E2EEncryption.decryptBinaryWithKey(plain,
                  new Uint8Array(root.E2EEncryption.base64ToArrayBuffer(sourceFile.ivBase64)),
                  new Uint8Array(root.E2EEncryption.base64ToArrayBuffer(sourceFile.tagBase64)), ownerKey));
              }
              const encrypted = await root.InPlaceChat.encryptImportedFile(target.conversationId, plain, prepared.room.key_version);
              encryptedBytesBase64 = root.SharedCrypto.b64(encrypted);
              await cachePut(`file:${result.importId}:${sourceFile.attachmentId}`, encryptedBytesBase64);
              sessionStorage.setItem(importKey, JSON.stringify(mappings));
            }
            {
              const form = new FormData();
              form.append('revision', String(result.revision));
              form.append('targetFileId', fileId);
              form.append('file', new Blob([root.SharedCrypto.bytes(encryptedBytesBase64)], { type: 'application/octet-stream' }), 'encrypted.bin');
              const upload = await sessionFetch(`/api/user/chat-threads/imports/${encodeURIComponent(result.importId)}/files/${encodeURIComponent(sourceFile.attachmentId)}`, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': root.csrfToken || '' }, body: form
              });
              const uploaded = await upload.json().catch(() => ({}));
              if (!upload.ok) throw new Error(uploaded.error?.message || 'Could not import an encrypted attachment.');
            }
            fileIds.push(fileId);
            sharedFiles.push({ id: fileId, name: sourceFile.fileName || 'attachment', type: sourceFile.contentType || 'application/octet-stream', size: Number(sourceFile.sizeBytes) || 0 });
          }
          const sourceMetadata = { ...(source.metadata || {}) };
          delete sourceMetadata.attachments;
          converted.push({
            sourceKind: source.sourceKind, sourceId: source.sourceId,
            sourceFingerprint: source.sourceFingerprint, targetMessageId,
            fileIds,
            keyVersion: Number(prepared.room.key_version),
            payload: await root.InPlaceChat.encryptImportedPayload(target.conversationId,
              { text, ...sourceMetadata, files: sharedFiles }, prepared.room.key_version)
          });
        }
        sessionStorage.setItem(importKey, JSON.stringify(mappings));
        await cachePut(chunkKey, converted);
        }
        if (!isCurrent(epoch, target.conversationId)) throw new Error('The selected conversation changed. Reopen Share to continue.');
        result = await request(`/imports/${result.importId}/messages`, { revision: result.revision, items: converted });
        await cacheDelete(chunkKey);
        offset = Number(result.importedItems);
        status.textContent = `Encrypting history in this browser… ${offset} of ${result.expectedItems}`;
      }
      await request(`/imports/${result.importId}/validate`, {});
      await request(`/imports/${result.importId}/activate`, { revision: result.revision });
      const sharedContext = await request('/' + target.conversationId);
      if (!isCurrent(epoch, target.conversationId)) throw new Error('The selected conversation changed. Reopen Share to continue.');
      await root.DashboardHelpers.selectChatContext(sharedContext);
      root.history.replaceState({}, '', `?conversationId=${encodeURIComponent(sharedContext.conversationId)}`);
      if (input) input.value = draft;
      if (area) area.scrollTop = scroll;
      const queuedInvite = document.getElementById('shareInviteEmail').value.trim();
      sessionStorage.removeItem(importKey);
      sessionStorage.removeItem(`sharing-import-request:${target.conversationId}`);
      await cacheDeleteImport(result.importId);
      busy = false;
      activeImport = null;
      const abortButton = document.getElementById('shareHistoryAbort');
      if (abortButton) abortButton.hidden = true;
      captured = { ...captured, ...sharedContext, mode: 'shared', role: 'owner' };
      prepareButton.hidden = true;
      document.getElementById('shareExistingChatCancel').textContent = 'Done';
      previewNode.hidden = true;
      invitesPanel.hidden = false;
      document.getElementById('shareInviteEmail').disabled = false;
      document.getElementById('shareInviteSubmit').disabled = false;
      if (guestControls) guestControls.hidden = false;
      document.getElementById('shareInviteDelivery').textContent = 'The conversation is shared. Send an invitation now; guests can join from the link controls below.';
      status.textContent = 'Your conversation is shared. Invite someone to join this same chat.';
      focusReturn = document.getElementById('shareInviteEmail');
      document.getElementById('shareInviteEmail').focus();
      void discoverGuestShare(epoch, target.conversationId, target.agentId);
      if (queuedInvite) void submitInvitation();
      else void loadInvitations(epoch, target.conversationId);
    } catch (error) {
      status.textContent = error.message || 'History conversion paused. Reopen Share to resume this import.';
      if (!started && /not ready for shared delivery/.test(error.message || '')) {
        status.textContent = 'This agent\'s shared runner went offline. Connect the shared runner on the machine where this agent runs, then press Try again. No history has been moved.';
        if (retryButton) retryButton.hidden = false;
      }
      prepareButton.textContent = started ? 'Resume conversion' : 'Share this conversation';
    } finally {
      busy = false;
      prepareButton.disabled = false;
      document.getElementById('shareExistingChatClose').disabled = false;
      document.getElementById('shareExistingChatCancel').disabled = false;
    }
  }
  root.AgentChatSharing = {
    openForAgent: async agentId => {
      if (busy) return;
      const requestNumber = ++openAgentRequest;
      const selected = root.DashboardHelpers?.getSelectedAgentIdentity?.();
      if (selected?.agentId !== agentId) {
        const context = await request('/resolve', { agentId });
        if (requestNumber !== openAgentRequest) return;
        const current = root.DashboardHelpers?.getSelectedAgentIdentity?.();
        if (current?.agentId !== selected?.agentId || current?.conversationId !== selected?.conversationId) return;
        await root.DashboardHelpers.selectChatContext(context);
        if (requestNumber !== openAgentRequest) return;
      }
      open();
      focusReturn = document.getElementById('selectedAgentActionIcon') || trigger;
    }
  };
  trigger.addEventListener('click', open);
  retryButton?.addEventListener('click', () => {
    if (busy || !isCurrent(dialogEpoch)) return;
    status.textContent = 'Checking this conversation…';
    void loadPreview(dialogEpoch);
  });
  document.getElementById('selectedChatContextStatus')?.addEventListener('click', event => { event.stopPropagation(); open(); });
  document.getElementById('shareExistingChatClose').addEventListener('click', close);
  document.getElementById('shareExistingChatCancel').addEventListener('click', close);
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const candidates = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.hidden && !node.closest('[hidden]') && node.getAttribute('aria-hidden') !== 'true');
    if (!candidates.length) { event.preventDefault(); return; }
    const first = candidates[0], last = candidates[candidates.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  prepareButton.addEventListener('click', () => void convert());
  document.getElementById('shareHistoryAbort')?.addEventListener('click', async () => {
    if (!activeImport || busy || !root.confirm('Discard this incomplete sharing preparation? Your private conversation history will remain unchanged.')) return;
    const epoch = dialogEpoch;
    const conversationId = captured?.conversationId;
    try {
      const importId = activeImport.importId;
      await request('/imports/' + encodeURIComponent(importId), undefined, 'DELETE');
      if (!isCurrent(epoch, conversationId)) return;
      activeImport = null;
      sessionStorage.removeItem(`sharing-import-request:${conversationId}`);
      sessionStorage.removeItem(`sharing-import-mappings:${importId}`);
      await cacheDeleteImport(importId);
      status.textContent = 'Preparation discarded. Your private conversation is unchanged.';
      prepareButton.textContent = 'Share this conversation';
      prepareButton.disabled = false;
      document.getElementById('shareHistoryAbort').hidden = true;
    } catch (error) { if (isCurrent(epoch, conversationId)) status.textContent = error.message; }
  });
  document.getElementById('shareInviteSubmit').addEventListener('click', () => void submitInvitation());
  document.getElementById('shareInviteSignupCopy')?.addEventListener('click', async () => {
    const input = document.getElementById('shareInviteSignupLink');
    try { await navigator.clipboard.writeText(input.value); }
    catch (_) { input.select(); document.execCommand('copy'); }
    document.getElementById('shareInviteDelivery').textContent = 'Signup link copied. Send it to the invited email address owner.';
  });
  document.getElementById('shareGuestLinkCreate')?.addEventListener('click', () => void createGuestLink());
  document.getElementById('shareGuestLinkDisable')?.addEventListener('click', () => void disableGuestLink());
  document.getElementById('shareGuestPasscodeGenerate')?.addEventListener('click', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const random = new Uint8Array(20);
    crypto.getRandomValues(random);
    document.getElementById('shareGuestPasscode').value = [...random].map(value => alphabet[value % alphabet.length]).join('');
  });
  document.getElementById('shareGuestPasscodeReveal')?.addEventListener('click', event => {
    const input = document.getElementById('shareGuestPasscode');
    input.type = input.type === 'password' ? 'text' : 'password';
    event.currentTarget.textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  document.getElementById('shareGuestPasscodeCopy')?.addEventListener('click', async () => {
    const input = document.getElementById('shareGuestPasscode');
    if (!input.value) return;
    try { await navigator.clipboard.writeText(input.value); }
    catch (_) { input.type = 'text'; input.select(); document.execCommand('copy'); }
    document.getElementById('shareGuestLinkStatus').textContent = 'Guest access code copied. Send it separately from the private guest link.';
  });
  document.getElementById('shareGuestLinkCopy')?.addEventListener('click', async () => {
    if (!document.getElementById('shareGuestLinkValue').value) return;
    try { await navigator.clipboard.writeText(document.getElementById('shareGuestLinkValue').value); document.getElementById('shareGuestLinkStatus').textContent='Guest link copied.'; }
    catch (_) { document.getElementById('shareGuestLinkValue').select(); document.getElementById('shareGuestLinkStatus').textContent='Select and copy the guest link.'; }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !dialog.classList.contains('hidden')) close(); });
})(window);
