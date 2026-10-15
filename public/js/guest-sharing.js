/* global SharedCrypto */
'use strict';

(function (root) {
  const app = document.getElementById('guestSharingApp');
  if (!app) return;

  const state = {
    agents: [],
    devices: [],
    runtimes: [],
    shares: [],
    sharesEpoch: 0,
    userId: app.dataset.userId || '',
    csrf: app.dataset.csrf || ''
  };
  const $ = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const errorMessage = error => error?.message || String(error || 'Request failed');

  function showError(message) {
    $('guestSharingError').textContent = message || '';
    if (message) $('guestSharingStatus').textContent = '';
  }

  function showStatus(message) {
    $('guestSharingStatus').textContent = message || '';
    if (message) $('guestSharingError').textContent = '';
  }

  async function request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = typeof root.Headers === 'function' ? new root.Headers(options.headers || {}) : { ...(options.headers || {}) };
    const setHeader = (name, value) => typeof headers.set === 'function' ? headers.set(name, value) : (headers[name] = value);
    if (state.csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) setHeader('x-csrf-token', state.csrf);
    const requestOptions = { ...options, method, headers };
    if (requestOptions.body !== undefined && !(requestOptions.body instanceof FormData)) {
      setHeader('Content-Type', 'application/json');
      requestOptions.body = JSON.stringify(requestOptions.body);
    }
    const response = await fetch(url, requestOptions);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || 'The server rejected this request.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const sharedApi = (path, options) => request('/api/user/shared' + path, options);

  function selectedAgentIds() {
    return [...document.querySelectorAll('#guestAgentSelection input[type="checkbox"]:checked')].map(input => input.value);
  }

  function updateSelectionPreview() {
    const selected = selectedAgentIds();
    $('guestSelectionPreview').textContent = `${selected.length} agent${selected.length === 1 ? '' : 's'} selected`;
    $('guestCreateShare').disabled = selected.length === 0;
  }

  function runtimeStatus(agent) {
    const runtime = state.runtimes.find(item => item.agent_id === agent.agentId);
    if (runtime?.capabilities?.executionMode === 'trusted') {
      const online = Date.now() - new Date(runtime.last_seen_at).getTime() <= 120000;
      return `${online ? 'Sharing connected' : 'Sharing runner offline'} · Uses existing agent permissions`;
    }
    const lastSeen = agent.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : 0;
    const online = Number.isFinite(lastSeen) && Date.now() - lastSeen <= 120000;
    const devices = state.devices.filter(device => device.agent_id === agent.agentId && !device.revoked_at && ['owner-approved', 'isolation-tested'].includes(device.verification_status));
    const deviceSummary = devices.length
      ? `${devices.length} approved device${devices.length === 1 ? '' : 's'}`
      : 'No approved execution device';
    return `${online ? 'Runtime seen recently' : 'Runtime not recently seen'} · ${deviceSummary}`;
  }

  function renderAgents() {
    const selection = $('guestAgentSelection');
    selection.replaceChildren();
    if (!state.agents.length) {
      selection.append(make('p', 'No agents are available to share.', 'guest-share-empty'));
      updateSelectionPreview();
      return;
    }
    const requested = new URLSearchParams(root.location.search).get('agentId');
    state.agents.forEach((agent, index) => {
      const row = make('div', undefined, 'guest-agent-option');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = agent.agentId;
      checkbox.id = `guest-agent-${index}`;
      checkbox.checked = requested === agent.agentId;
      checkbox.addEventListener('change', updateSelectionPreview);
      const info = make('label', undefined, 'guest-agent-copy');
      info.htmlFor = checkbox.id;
      info.append(make('span', agent.name || 'Unnamed agent', 'guest-agent-name'));
      info.append(make('span', runtimeStatus(agent), 'guest-agent-meta'));
      const shareOne = make('button', 'Share this agent', 'guest-agent-share');
      shareOne.type = 'button';
      shareOne.dataset.agentId = agent.agentId;
      shareOne.addEventListener('click', () => {
        document.querySelectorAll('#guestAgentSelection input[type="checkbox"]').forEach(input => {
          input.checked = input.value === agent.agentId;
        });
        $('guestShareForm').elements.title.value = `${agent.name || 'Agent'} guest access`;
        updateSelectionPreview();
        $('guestShareForm').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      });
      row.append(checkbox, info, shareOne);
      selection.append(row);
    });
    updateSelectionPreview();
  }

  function formatDate(value) {
    if (!value) return 'No expiry';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? `Expires ${date.toLocaleString()}` : 'Expiry unavailable';
  }

  function activeAgents(detail) {
    return (detail?.agents || []).filter(agent => !agent.removed_at);
  }

  function renderShare(detail) {
    const shareId = detail.shareId || detail.share_id;
    const row = make('article', undefined, 'guest-share-row');
    row.dataset.shareId = shareId;
    const top = make('div', undefined, 'guest-share-row__top');
    const heading = make('div');
    heading.append(make('h3', detail.title || 'Guest shared work'));
    heading.append(make('p', `${detail.room_mode === 'common' ? 'One common room' : 'Separate rooms'} · ${formatDate(detail.expires_at)}`, 'guest-share-row__meta'));
    const status = make('span', detail.revoked_at ? 'Revoked' : 'Active', `guest-share-row__status${detail.revoked_at ? ' is-revoked' : ''}`);
    top.append(heading, status);
    row.append(top);

    const allowlist = make('div', undefined, 'guest-share-allowlist');
    allowlist.append(make('strong', 'Current agent allowlist'));
    const allowed = activeAgents(detail);
    const allowedList = make('ul');
    if (!allowed.length) allowedList.append(make('li', 'No active agents')); else allowed.forEach(agent => {
      const item = make('li');
      item.append(make('span', agent.agent_name || agent.agent_id));
      if (!detail.revoked_at && allowed.length > 1) {
        const remove = make('button', 'Remove', 'guest-danger');
        remove.type = 'button';
        remove.addEventListener('click', () => changeAllowlist(detail, agent.agent_id));
        item.append(' ', remove);
      }
      allowedList.append(item);
    });
    allowlist.append(allowedList);
    row.append(allowlist);

    const audience = make('div', undefined, 'guest-share-audience');
    audience.append(make('strong', `Guest audience (${detail.guests?.length || 0})`));
    const guests = make('ul');
    if (!detail.guests?.length) guests.append(make('li', 'No guest has unlocked this share.'));
    (detail.guests || []).forEach(guest => {
      const item = make('li');
      item.append(make('span', `${guest.display_name || 'Unnamed guest'} · ${guest.status}`));
      const keyStatus = make('span', guest.public_key ? ' Identity ready; keys pending owner action.' : ' Waiting for guest identity.', 'guest-guest-status');
      item.append(keyStatus);
      if (!detail.revoked_at && guest.public_key && guest.status !== 'revoked') {
        const provision = make('button', 'Provision pending keys');
        provision.type = 'button';
        provision.addEventListener('click', () => provisionGuest(detail, guest, provision));
        item.append(' ', provision);
        if (activeAgents(detail).every(agent => agent.execution_mode === 'trusted')) {
          item.append(make('span', ' Uses existing agent permissions.', 'guest-guest-status'));
        } else {
          const permissions = make('button', 'Execution permissions');
          permissions.type = 'button';
          permissions.addEventListener('click', () => executionPermissions(detail, guest, item, permissions));
          item.append(' ', permissions);
        }
      }
      if (!detail.revoked_at && guest.status !== 'revoked') {
        const remove = make('button', 'Remove guest', 'guest-danger');
        remove.type = 'button';
        remove.addEventListener('click', () => removeGuest(detail, guest, remove));
        item.append(' ', remove);
      }
      guests.append(item);
    });
    audience.append(guests);
    row.append(audience);

    if (!detail.revoked_at) {
      const controls = make('div', undefined, 'guest-share-controls');
      const replacementPassword = document.createElement('input');
      replacementPassword.type = 'password';
      replacementPassword.minLength = 12;
      replacementPassword.maxLength = 72;
      replacementPassword.placeholder = 'New password (optional)';
      replacementPassword.autocomplete = 'new-password';
      const replacePassword = make('button', 'Replace password');
      replacePassword.type = 'button';
      replacePassword.addEventListener('click', () => replaceSharePassword(detail, replacementPassword, replacePassword));
      const replaceLink = make('button', 'Replace link');
      replaceLink.type = 'button';
      replaceLink.addEventListener('click', () => replaceShareLink(detail, replaceLink));
      const revoke = make('button', 'Revoke share', 'guest-danger');
      revoke.type = 'button';
      revoke.addEventListener('click', () => revokeShare(detail, revoke));
      controls.append(replacementPassword, replacePassword, replaceLink, revoke);
      row.append(controls);
    }
    return row;
  }

  async function loadShares() {
    const list = $('guestShares');
    const refresh = $('guestRefreshShares');
    const epoch = ++state.sharesEpoch;
    list.setAttribute('inert', '');
    list.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    try {
      const summaries = await sharedApi('/guest-shares');
      const details = await Promise.all(summaries.map(summary => sharedApi('/guest-shares/' + encodeURIComponent(summary.shareId || summary.share_id))));
      if (epoch !== state.sharesEpoch) return false;
      state.shares = details;
      list.replaceChildren();
      if (!details.length) list.append(make('p', 'No guest shares have been created yet.', 'guest-share-empty'));
      else details.forEach(detail => list.append(renderShare(detail)));
      return true;
    } finally {
      if (epoch === state.sharesEpoch) {
        list.removeAttribute('inert');
        list.removeAttribute('aria-busy');
        refresh.disabled = false;
      }
    }
  }

  async function executionPermissions(detail, guest, parent, button) {
    showError('');
    button.disabled = true;
    try {
      parent.querySelector('.guest-execution-permissions')?.remove();
      const [grants, devices] = await Promise.all([sharedApi('/grants'), sharedApi('/devices')]);
      state.devices = devices;
      const panel = make('div', undefined, 'guest-execution-permissions');
      panel.append(make('strong', `Execution access in ${guest.display_name || 'Guest'}'s chats`));
      panel.append(make('p', 'Chat access and execution access are separate. A compatible runner is required. Changes stop work under the previous permission revision.'));
      const active = grants.filter(grant => grant.status === 'active' && (guest.rooms || []).some(room => room.room_id === grant.room_id) &&
        (grant.grantee_kind === 'guest' && grant.grantee_id === guest.guest_id || grant.grantee_kind === 'user' && grant.grantee_id === detail.owner_id));
      for (const grant of active) {
        const line = make('p', `${grant.grantee_kind === 'user' ? 'You' : guest.display_name || 'Guest'} · ${grant.workspace_alias} · ${(grant.actions || []).join(', ')} · revision ${grant.revision}`);
        const revoke = make('button', 'Revoke execution access', 'guest-danger');
        revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await sharedApi('/grants/' + encodeURIComponent(grant.grant_id), { method: 'DELETE' }); showStatus('Execution access revoked.'); await executionPermissions(detail, guest, parent, button); }
          catch (error) { showError(errorMessage(error)); revoke.disabled = false; }
        });
        line.append(' ', revoke); panel.append(line);
      }
      const choices = [];
      for (const room of guest.rooms || []) for (const device of state.devices) {
        if (device.agent_id !== room.agent_id || device.revoked_at || device.platform !== 'linux' || device.executor_type !== 'container' ||
          !['owner-approved', 'isolation-tested'].includes(device.verification_status)) continue;
        if (!['workspace.read', 'workspace.execute'].every(action => (device.capabilities?.actions || []).includes(action))) continue;
        for (const alias of device.workspaceAliases || device.workspace_aliases || []) if ((device.capabilities?.resources || []).includes(alias)) choices.push({ room, device, alias });
      }
      if (!choices.length) panel.append(make('p', 'No compatible approved device is available. Connect and verify a restricted runner before granting execution access.'));
      else {
        const form = make('form');
        const requesterLabel = make('label', 'Whose requests can run?');
        const requester = make('select'); requester.name = 'executionRequester';
        const guestOption = make('option', guest.display_name || 'Guest'); guestOption.value = 'guest'; requester.append(guestOption);
        if (detail.owner_id) { const ownerOption = make('option', 'You (agent owner)'); ownerOption.value = 'user'; requester.append(ownerOption); }
        requesterLabel.append(requester); form.append(requesterLabel);
        const selectLabel = make('label', 'Agent, device and project');
        const select = make('select'); select.name = 'executionTarget';
        choices.forEach((choice, index) => { const option = make('option', `${choice.room.agent_name} · ${choice.device.device_label} · ${choice.alias}`); option.value = String(index); select.append(option); });
        selectLabel.append(select); form.append(selectLabel);
        const secondsLabel = make('label', 'Time limit per task (seconds)');
        const seconds = make('input'); Object.assign(seconds, { type: 'number', min: '5', max: '900', value: '30', required: true }); seconds.name = 'executionSeconds';
        secondsLabel.append(seconds); form.append(secondsLabel);
        form.append(make('p', 'Allows reading the selected project and running commands in its sandbox. Project files stay read only. Queued requests may run with this access. No external destinations or owner credentials are granted.'));
        const submit = make('button', 'Grant read-only execution', 'guest-primary'); submit.type = 'submit'; form.append(submit);
        form.addEventListener('submit', async event => {
          event.preventDefault(); submit.disabled = true; showError('');
          try {
            const choice = choices[Number(select.value)];
            if (!choice || !Number.isInteger(Number(seconds.value))) throw new Error('Choose a device and a whole-second time limit.');
            const kind = requester.value;
            const requesterId = kind === 'user' ? detail.owner_id : guest.guest_id;
            if (!['guest', 'user'].includes(kind) || !requesterId) throw new Error('Choose the guest or agent owner.');
            const existing = active.find(grant => grant.room_id === choice.room.room_id && grant.device_id === choice.device.device_id &&
              grant.grantee_kind === kind && grant.grantee_id === requesterId);
            await sharedApi(existing ? '/grants/' + encodeURIComponent(existing.grant_id) : '/grants', { method: existing ? 'PATCH' : 'POST', body: { agentId: choice.room.agent_id, roomId: choice.room.room_id,
              deviceId: choice.device.device_id, granteeKind: kind, granteeId: requesterId, workspaceAlias: choice.alias,
              actions: ['workspace.read', 'workspace.execute'], resources: [choice.alias], destinations: [],
              budget: { ...(existing?.budget || {}), maxRuntimeMs: Number(seconds.value) * 1000 }, approvalPolicy: existing?.approval_policy || {} } });
            showStatus('Scoped execution access granted. A compatible runner is still required.');
            await executionPermissions(detail, guest, parent, button);
          } catch (error) { showError(errorMessage(error)); submit.disabled = false; }
        });
        panel.append(form);
      }
      if (!parent.isConnected) return;
      parent.append(panel);
    } catch (error) { showError(errorMessage(error)); }
    finally { button.disabled = false; }
  }

  function showCreatedLink(secret) {
    if (typeof secret !== 'string' || !secret) throw new Error('The server did not return a share link. Nothing was marked as created.');
    const origin = root.location.origin && root.location.origin !== 'null' ? root.location.origin : '';
    $('guestCreatedLinkValue').value = `${origin}/guest#${secret}`;
    $('guestCreatedLink').hidden = false;
    $('guestCopyStatus').textContent = 'Link is shown once. Copy and store it before leaving this page.';
  }

  async function createShare(event) {
    event.preventDefault();
    showError('');
    showStatus('');
    const form = event.currentTarget;
    const ids = selectedAgentIds();
    if (!ids.length) return showError('Select at least one agent.');
    const body = {
      agentIds: ids,
      roomMode: form.elements.roomMode.value,
      title: form.elements.title.value.trim() || 'Guest shared work'
    };
    if (form.elements.expiresAt.value) body.expiresAt = new Date(form.elements.expiresAt.value).toISOString();
    if (form.elements.passwordEnabled.checked) {
      const password = form.elements.password.value;
      if (!password || password.length < 12 || new TextEncoder().encode(password).length > 72) {
        showError('Guest passwords must be 12–72 UTF-8 bytes.');
        return;
      }
      body.password = password;
    }
    const submit = $('guestCreateShare');
    submit.disabled = true;
    try {
      const result = await sharedApi('/guest-shares', { method: 'POST', body });
      showCreatedLink(result.linkSecret);
      form.elements.password.value = '';
      form.elements.passwordEnabled.checked = false;
      $('guestPasswordField').hidden = true;
      showStatus('Share created. The link is available in the panel above.');
      await loadShares();
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      submit.disabled = selectedAgentIds().length === 0;
    }
  }

  async function changeAllowlist(detail, removedAgentId) {
    const ids = activeAgents(detail).map(agent => agent.agent_id).filter(id => id !== removedAgentId);
    if (!ids.length) return showError('A share must keep at least one selected agent.');
    if (typeof root.confirm === 'function' && !root.confirm('Remove this agent from the guest allowlist?')) return;
    try {
      await sharedApi('/guest-shares/' + encodeURIComponent(detail.shareId || detail.share_id) + '/agents', { method: 'PUT', body: { agentIds: ids } });
      showStatus('Guest allowlist updated.');
      await loadShares();
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  async function revokeShare(detail, button) {
    if (typeof root.confirm === 'function' && !root.confirm('Revoke this guest share and its guest sessions?')) return;
    button.disabled = true;
    try {
      await sharedApi('/guest-shares/' + encodeURIComponent(detail.shareId || detail.share_id), { method: 'PATCH', body: { revoked: true } });
      showStatus('Guest share revoked.');
      await loadShares();
    } catch (error) {
      button.disabled = false;
      showError(errorMessage(error));
    }
  }

  async function replaceShareLink(detail, button) {
    button.disabled = true;
    try {
      const result = await sharedApi('/guest-shares/' + encodeURIComponent(detail.shareId || detail.share_id), { method: 'PATCH', body: { replaceLink: true } });
      showCreatedLink(result.linkSecret);
      showStatus('Link replaced. Existing guest sessions were revoked.');
      await loadShares();
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function replaceSharePassword(detail, input, button) {
    const password = input.value;
    if (password && (password.length < 12 || new TextEncoder().encode(password).length > 72)) {
      return showError('Guest passwords must be 12–72 UTF-8 bytes.');
    }
    button.disabled = true;
    try {
      await sharedApi('/guest-shares/' + encodeURIComponent(detail.shareId || detail.share_id), { method: 'PATCH', body: { password } });
      input.value = '';
      showStatus(password ? 'Guest password replaced. Existing guest sessions were revoked.' : 'Guest password removed.');
      await loadShares();
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function removeGuest(detail, guest, button) {
    if (typeof root.confirm === 'function' && !root.confirm('Remove this guest and revoke their sessions?')) return;
    button.disabled = true;
    try {
      await sharedApi(`/guest-shares/${encodeURIComponent(detail.shareId || detail.share_id)}/guests/${encodeURIComponent(guest.guest_id)}`, { method: 'DELETE' });
      showStatus('Guest removed.');
      await loadShares();
    } catch (error) {
      button.disabled = false;
      showError(errorMessage(error));
    }
  }

  async function allMessages(roomId) {
    const messages = [];
    let after = 0;
    for (;;) {
      const page = await sharedApi(`/${encodeURIComponent(roomId)}/messages?after=${after}`);
      messages.push(...page);
      if (page.length < 200) return messages;
      after = page[page.length - 1].seq;
    }
  }

  async function provisionGuest(detail, guest, button, attempt = 0) {
    button.disabled = true;
    try {
      const accountKey = await root.E2EEncryption?.getStoredEncryptionKey?.();
      if (!accountKey) throw new Error('Unlock account encryption on the Shared chats page first. No keys were sent.');
      const identity = await sharedApi('/identity');
      if (!identity?.private_key) throw new Error('Owner shared encryption is not initialized. Unlock Shared chats first.');
      const privateKey = await root.SharedCrypto.privateKey(accountKey, identity.private_key, 'user:' + state.userId);
      const active = Array.isArray(guest.rooms) ? guest.rooms : activeAgents(detail);
      if (!active.length || active.some(agent => !agent.room_id)) throw new Error('Guest rooms are not ready. Ask the guest to unlock the share first.');
      const envelopes = [];
      const rooms = [];
      for (const mapping of active) {
        const context = await sharedApi('/' + encodeURIComponent(mapping.room_id));
        rooms.push({ roomId: mapping.room_id, keyVersion: context.room.key_version,
          membershipVersion: context.room.membership_version, rotationRequired: context.room.rotation_required });
        const owner = (context.members || []).find(member => member.user_id === state.userId);
        if (!owner?.public_key) throw new Error('Owner shared identity is unavailable for one of the rooms.');
        if (!context.agentIdentity?.public_key) throw new Error(`Agent identity is unavailable for ${mapping.agent_name || 'an agent'}.`);
        const keys = new Map();
        for (const entry of context.keys || []) keys.set(Number(entry.key_version), await root.SharedCrypto.unwrap(entry.wrapped_key, privateKey));
        const retained = new Set((await allMessages(mapping.room_id)).filter(message => !message.deleted_at).map(message => Number(message.key_version)));
        const targetVersion = Number(context.room.key_version) + (context.room.rotation_required ? 1 : 0);
        retained.add(targetVersion);
        if (!keys.has(targetVersion)) keys.set(targetVersion, await root.SharedCrypto.newKey());
        for (const version of retained) {
          const key = keys.get(version);
          if (!key) throw new Error('An owner key for retained history is unavailable. Refresh the Shared chats page first.');
          const recipients = [
            ...(context.members || []).filter(member => ['active', 'pending'].includes(member.status)).map(member => ['user:' + member.user_id, member.public_key]),
            ['agent:' + mapping.agent_id, context.agentIdentity.public_key],
            ...(context.guests || []).map(member => ['guest:' + member.guest_id, member.public_key]),
            ['guest:' + guest.guest_id, guest.public_key]
          ];
          for (const [principal, publicKey] of new Map(recipients)) {
            if (!publicKey) throw new Error('A remaining participant has not initialized shared encryption.');
            envelopes.push({
              roomId: mapping.room_id,
              keyVersion: version,
              principal,
              wrappedKey: await root.SharedCrypto.wrap(key, publicKey)
            });
          }
        }
      }
      await sharedApi('/guest-shares/' + encodeURIComponent(detail.shareId || detail.share_id) + '/keys', {
        method: 'POST',
        body: { guestId: guest.guest_id, envelopes, rooms }
      });
      await loadShares();
      // The refresh replaces the guest list. Publish completion only after its
      // new controls are attached, so follow-up actions cannot target a stale row.
      showStatus(`Encrypted keys provisioned for ${guest.display_name || 'guest'}.`);
    } catch (error) {
      if (error.status === 409 && error.message === 'Guest room changed; refresh before provisioning' && attempt < 2) {
        await provisionGuest(detail, guest, button, attempt + 1);
        return;
      }
      showError(errorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function loadAgents() {
    const [result, devices, shared] = await Promise.all([
      request('/api/user/agents'), sharedApi('/devices'), sharedApi('')
    ]);
    state.agents = Array.isArray(result.agents) ? result.agents : [];
    state.devices = Array.isArray(devices) ? devices : [];
    state.runtimes = Array.isArray(shared.agents) ? shared.agents : [];
    renderAgents();
  }

  async function refreshOwnerKeyStatus() {
    try {
      const key = await root.E2EEncryption?.getStoredEncryptionKey?.();
      $('guestOwnerKeyStatus').textContent = key ? 'Owner encryption: unlocked' : 'Owner encryption: unlock Shared chats to provision guest keys';
    } catch (_) {
      $('guestOwnerKeyStatus').textContent = 'Owner encryption: unavailable until Shared chats is unlocked';
    }
  }

  function bind() {
    $('guestShareForm').addEventListener('submit', createShare);
    $('guestPasswordEnabled').addEventListener('change', event => {
      $('guestPasswordField').hidden = !event.currentTarget.checked;
      if (!event.currentTarget.checked) $('guestShareForm').elements.password.value = '';
    });
    $('guestCopyLink').addEventListener('click', async () => {
      const value = $('guestCreatedLinkValue').value;
      try {
        await root.navigator.clipboard.writeText(value);
        $('guestCopyStatus').textContent = 'Copied.';
      } catch (_) {
        $('guestCreatedLinkValue').focus();
        $('guestCreatedLinkValue').select();
        $('guestCopyStatus').textContent = 'Copy was unavailable; the link is selected for manual copying.';
      }
    });
    $('guestRefreshShares').addEventListener('click', async () => {
      try {
        if (await loadShares()) showStatus('Guest shares refreshed.');
      } catch (error) {
        showError(errorMessage(error));
      }
    });
  }

  async function init() {
    bind();
    try {
      await loadAgents();
      await loadShares();
      await refreshOwnerKeyStatus();
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  root.GuestSharing = { init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else void init();
})(window);
