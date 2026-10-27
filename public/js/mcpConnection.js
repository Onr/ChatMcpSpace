(() => {
  'use strict';
  const config = JSON.parse(document.getElementById('mcp-config').textContent);
  const state = document.getElementById('state');
  const detail = document.getElementById('detail');
  const unlock = document.getElementById('unlock');
  const password = document.getElementById('password');
  const changeKey = document.getElementById('changeKey');
  const reconnect = document.getElementById('reconnect');
  const unlockButton = document.getElementById('unlockButton');
  const active = { connectionId: null, gatewaySecret: null, agentToken: null, agentName: null, key: null, running: false, connecting: false, connected: false, revoked: false, generation: 0, cancelUnlock: null };
  const CIPHER_CACHE_KEY = 'chatmcp_mcp_encrypted_send_cache_v1';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const setState = (value, message) => {
    state.textContent = value;
    if (message) detail.textContent = message;
    const panel = document.getElementById('connectionStatus');
    if (panel) { panel.dataset.state = value; panel.setAttribute('aria-busy', String(['Connecting', 'Unlocking', 'Disconnecting'].includes(value))); }
    const ready = value === 'Connected';
    document.getElementById('successActions')?.toggleAttribute('hidden', !ready);
    const unlockStep = document.getElementById('unlockStep');
    if (unlockStep) {
      unlockStep.dataset.done = String(!!active.key);
      unlockStep.querySelector('small').textContent = active.key ? 'Unlocked' : 'Use your encryption password';
    }
    const appStep = document.getElementById('appStep');
    if (appStep) {
      appStep.dataset.done = String(ready);
      appStep.querySelector('small').textContent = ready ? 'Connected' : 'Wait for Connected below';
    }
    const returnLink = document.getElementById('returnToApp');
    if (returnLink) returnLink.hidden = ready || config.grantReady === true || active.revoked;
    const returnInstruction = document.getElementById('returnInstruction');
    if (returnInstruction && ready) returnInstruction.textContent = 'Switch back to your AI app to start using your connected agent.';
    if (ready) {
      const returnTitle = document.getElementById('returnTitle');
      if (returnTitle) returnTitle.textContent = 'Continue in your AI app';
      const feedback = document.getElementById('returnFeedback');
      if (feedback) feedback.textContent = 'AI app connection confirmed.';
    }
    reconnect.disabled = active.connecting || ready || active.revoked;
    reconnect.textContent = ready ? 'Connected' : active.connecting ? 'Connecting…' : 'Try connecting again';
    changeKey.disabled = active.connecting || active.revoked;
  };
  const headers = extra => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrf, ...extra });
  async function request(path, body, extra = {}) {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: headers(extra), body: JSON.stringify(body), signal: AbortSignal.timeout?.(20000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || `Request failed (${response.status})`);
      error.code = data.error;
      error.keyStored = data.keyStored === true;
      throw error;
    }
    return data;
  }
  async function promptForKey() {
    unlock.hidden = false;
    password.disabled = false;
    unlockButton.disabled = false;
    unlockButton.textContent = config.hostedApproved ? 'Unlock and enable connection' : 'Unlock and connect';
    changeKey.hidden = true;
    setState('Locked', 'Enter your ChatMCP encryption password below, then press Unlock. This is the password you use to read your encrypted chats.');
    password.focus();
    const proceed = await new Promise(resolve => {
      active.cancelUnlock = () => resolve(false);
      unlockButton.onclick = () => {
        if (!password.value) {
          password.setAttribute('aria-invalid', 'true');
          setState('Locked', 'The password field is empty. Enter your encryption password, then press Unlock.');
          password.focus();
          return;
        }
        password.removeAttribute('aria-invalid');
        resolve(true);
      };
    });
    active.cancelUnlock = null;
    unlockButton.onclick = null;
    if (!proceed) throw new Error('Connection cancelled.');
    const supplied = password.value;
    password.value = '';
    password.disabled = true;
    unlockButton.disabled = true;
    unlockButton.textContent = 'Unlocking…';
    setState('Unlocking', 'Password received. Unlocking your encryption key in this browser…');
    const key = await window.E2EEncryption.deriveKey(supplied, config.encryptionSalt);
    await window.E2EEncryption.storeEncryptionKey(key);
    unlock.hidden = true;
    return key;
  }
  async function unlockKey() {
    // Only the explicitly approved hosted connection needs to export this key.
    // Ordinary browser message encryption keeps the default non-exportable key.
    const key = await window.E2EEncryption.getStoredEncryptionKey({ extractable: config.hostedApproved === true });
    return key || promptForKey();
  }
  async function api(path, method, payload) {
    const response = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'X-Agent-Token': active.agentToken, 'X-Agent-Name': active.agentName, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data.error?.code || data.error || 'API_ERROR';
      if (code === 'SHARED_DM_KEY_REQUIRED') throw new Error('This peer uses a separate shared DM key. Finish that key setup in ChatMCP before sending to this shared peer.');
      throw new Error(data.error?.message || 'The approved agent API operation failed.');
    }
    return data;
  }
  function cacheKey(operation, recipient, idempotencyId) { return `${config.grantId}:${operation}:${recipient || 'user'}:${idempotencyId}`; }
  function readCipherCache(key) {
    try {
      const entries = JSON.parse(localStorage.getItem(CIPHER_CACHE_KEY) || '{}');
      const now = Date.now();
      for (const [entryKey, entry] of Object.entries(entries)) if (!entry || now - entry.createdAt > 7 * 24 * 60 * 60 * 1000) delete entries[entryKey];
      localStorage.setItem(CIPHER_CACHE_KEY, JSON.stringify(entries));
      return entries[key]?.ciphertext || null;
    } catch (_error) { throw new Error('The browser cannot access the encrypted retry cache. Check storage settings before sending.'); }
  }
  function writeCipherCache(key, ciphertext) {
    try {
      const entries = JSON.parse(localStorage.getItem(CIPHER_CACHE_KEY) || '{}');
      entries[key] = { ciphertext, createdAt: Date.now() };
      const sorted = Object.entries(entries).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 80);
      localStorage.setItem(CIPHER_CACHE_KEY, JSON.stringify(Object.fromEntries(sorted)));
    } catch (_error) { throw new Error('Could not save the encrypted retry cache, so this message was not sent.'); }
  }
  async function encryptedForRetry(operation, recipient, text, idempotencyId) {
    const key = cacheKey(operation, recipient, idempotencyId);
    const cached = readCipherCache(key);
    if (cached) {
      let previous;
      try { previous = await window.E2EEncryption.decryptMessage(cached, active.key); }
      catch (_error) { throw new Error('The encrypted retry record could not be checked; message send stopped safely.'); }
      if (previous !== text) throw new Error('This idempotencyId already belongs to different message text. Use a new UUID.');
      return cached;
    }
    const encrypted = await window.E2EEncryption.encryptMessage(text, active.key);
    writeCipherCache(key, encrypted);
    return encrypted;
  }
  async function decryptItem(item) {
    if (!item || typeof item !== 'object') return item;
    if (item.attachments?.length) return { ...item, content: '[Attachment is unsupported by MCP message tools.]', attachments: undefined, attachmentUnsupported: true };
    if (item.updateAction) return { ...item, updateAction: undefined, content: item.content || 'System update is available. Ask the account owner to review it in ChatMCP.' };
    if (item.encrypted === true && typeof item.content === 'string') {
      try { return { ...item, content: await window.E2EEncryption.decryptMessage(item.content, active.key), encrypted: false }; }
      catch (_error) { throw new Error('Could not decrypt a message with the unlocked key. Check the encryption password in this browser.'); }
    }
    for (const field of ['selectedOption', 'freeResponse']) {
      if (typeof item[field] === 'string' && item[field].split(':').length === 3) {
        try { item = { ...item, [field]: await window.E2EEncryption.decryptMessage(item[field], active.key) }; }
        catch (_error) { throw new Error('A response could not be decrypted; ciphertext was withheld.'); }
      }
    }
    if (item.responseId) {
      const parts = [item.selectedOption, item.freeResponse].filter(value => typeof value === 'string' && value.length);
      return { ...item, messageId: item.responseId, kind: 'response', content: parts.join('\n'), encrypted: false };
    }
    return item;
  }
  async function discoverPeers() {
    const data = await api('/api/agent/discover', 'GET');
    return data.agents || data.peers || data.discoveredAgents || [];
  }
  async function operate(operation) {
    const a = operation.args || {};
    if (operation.operation === 'list_agents') return (await discoverPeers()).map(peer => ({ id: peer.agentId || peer.agent_id || peer.id, name: peer.agentName || peer.agent_name || peer.name }));
    if (operation.operation === 'read_inbox') {
      const data = await api(`/api/agent/responses?markRead=false&limit=${a.limit || 50}&agentName=${encodeURIComponent(active.agentName)}`, 'GET');
      const messages = (data.responses || []).slice(0, a.limit || 50);
      const output = [];
      for (const message of messages) {
        const safe = await decryptItem(message);
        if (safe.encrypted) throw new Error('A message could not be decrypted; plaintext was withheld.');
        output.push({ ...safe, kind: safe.kind === 'response' ? 'response' : 'user' });
      }
      if (operation.args?.peerRead) {
        const inbox = await api(`/api/agent/messages/direct?markRead=false&limit=${a.limit || 50}`, 'GET');
        const allowed = new Set((await discoverPeers()).map(peer => peer.agentId || peer.agent_id || peer.id));
        for (const message of (inbox.messages || []).slice(0, a.limit || 50)) {
          if (!allowed.has(message.fromAgentId)) continue;
          if (message.shared) throw new Error('This shared peer uses a separate approved DM key. Finish shared-key setup in ChatMCP; MCP withheld its message text.');
          const safe = await decryptItem(message);
          if (safe.encrypted) throw new Error('A peer message could not be decrypted; plaintext was withheld.');
          output.push({ ...safe, kind: 'peer' });
        }
      }
      return output.sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp)).slice(0, a.limit || 50);
    }
    if (operation.operation === 'read_thread') {
      const data = await api(`/api/agent/messages/history?agentName=${encodeURIComponent(active.agentName)}&limit=${a.limit || 50}${a.beforeId ? `&beforeId=${encodeURIComponent(a.beforeId)}` : ''}`, 'GET');
      const visible = (data.messages || []).filter(message => !['agent_dm_sent', 'agent_dm_received'].includes(message.type)).slice(-(a.limit || 50));
      const messages = [];
      for (const message of visible) {
        const safe = await decryptItem(message);
        if (safe.encrypted) throw new Error('A thread item could not be decrypted; plaintext was withheld.');
        messages.push(safe);
      }
      return { agentId: data.agentId, agentName: data.agentName, messages, nextBeforeId: messages.length ? messages[0].messageId : null };
    }
    if (operation.operation === 'send_message') {
      const encrypted = await encryptedForRetry('send_message', null, a.text, a.idempotencyId);
      const result = await api('/api/agent/messages', 'POST', { agentName: active.agentName, content: encrypted, encrypted: true, clientMessageId: a.idempotencyId });
      return { sent: true, messageId: result.messageId, idempotencyId: a.idempotencyId };
    }
    if (operation.operation === 'send_peer_message') {
      const peers = await discoverPeers();
      const peer = peers.find(item => (item.agentId || item.agent_id || item.id) === a.peerId);
      if (!peer) throw new Error('That peer is not currently allowed for this agent. Check ChatMCP peer and group permissions.');
      if (peer.shared) throw new Error('This peer uses a separate shared DM key. Finish shared-key setup in ChatMCP; MCP message tools do not accept that key.');
      const encrypted = await encryptedForRetry('send_peer_message', a.peerId, a.text, a.idempotencyId);
      const peerName = peer.agentName || peer.agent_name || peer.name;
      const result = await api('/api/agent/messages/direct', 'POST', { toAgentName: peerName, content: encrypted, encrypted: true, clientMessageId: a.idempotencyId });
      return { sent: true, messageId: result.messageId || result.agentMessageId, peerId: a.peerId, idempotencyId: a.idempotencyId };
    }
    if (operation.operation === 'ack_message') {
      const path = a.kind === 'peer' ? '/api/agent/messages/direct/ack' : '/api/agent/responses/ack';
      if (a.kind === 'peer') {
        const [inbox, peers] = await Promise.all([api('/api/agent/messages/direct?markRead=false&limit=100', 'GET'), discoverPeers()]);
        const allowed = new Set(peers.map(peer => peer.agentId || peer.agent_id || peer.id));
        const found = (inbox.messages || []).some(message => message.messageId === a.messageId && !message.shared && allowed.has(message.fromAgentId));
        if (!found) throw new Error('That peer message is no longer visible to this agent. Check current peer and group permissions.');
      }
      return api(path, 'POST', { messageId: a.messageId, responseType: a.kind === 'response' ? 'response' : 'text' });
    }
    throw new Error('Unsupported browser operation.');
  }
  async function loop() {
    while (active.running) {
      try {
        const claimed = await request('/mcp/gateway/claim', { grantId: config.grantId, connectionId: active.connectionId, gatewaySecret: active.gatewaySecret });
        if (!claimed.operation) { await pause(700); continue; }
        let result;
        let error;
        try { result = await operate(claimed.operation); } catch (failure) {
          error = failure.message || 'The browser operation failed.';
          if (/decrypt|encryption password/i.test(error)) {
            changeKey.hidden = false;
            setState('Locked', `${error} If this browser has a stale key, use “Unlock with another password” and try again.`);
          }
        }
        await request('/mcp/gateway/result', { grantId: config.grantId, connectionId: active.connectionId, gatewaySecret: active.gatewaySecret, requestId: claimed.operation.id, ...(error ? { error } : { result }) });
      } catch (error) {
        active.running = false;
        active.connected = false;
        setState('Offline', 'Connection interrupted. Press Try connecting again to restore access. Keep this tab open for browser-only access.');
      }
    }
  }
  async function setupSharedPeers() {
    if (!config.peerAccess || document.getElementById('sharedPeerSetup')) return;
    const data = await request('/mcp/hosted/peers', { grantId: config.grantId });
    const peers = (data.agents || []).filter(peer => peer.shared);
    if (!peers.length) return;
    const section = document.createElement('section');
    section.id = 'sharedPeerSetup';
    section.innerHTML = '<h2>Shared peer encryption (optional)</h2><p>For agents in other accounts, enter the shared password and salt once. The password stays in this browser; ChatMCP protects the derived key for this approved peer.</p><label>Peer <select id="sharedPeerId"></select></label><label>Shared encryption password <input id="sharedPeerPassword" type="password" autocomplete="off"></label><label>Shared salt (base64) <input id="sharedPeerSalt" autocomplete="off"></label><button id="saveSharedPeer" type="button">Save peer connection</button><p id="sharedPeerResult" role="status"></p>';
    const select = section.querySelector('#sharedPeerId');
    for (const peer of peers) {
      const option = document.createElement('option');
      option.value = peer.id;
      option.textContent = peer.name;
      select.appendChild(option);
    }
    section.querySelector('#saveSharedPeer').addEventListener('click', async () => {
      const passwordInput = section.querySelector('#sharedPeerPassword');
      const saltInput = section.querySelector('#sharedPeerSalt');
      const feedback = section.querySelector('#sharedPeerResult');
      let raw;
      try {
        if (!passwordInput.value || !saltInput.value) throw new Error('Enter the shared encryption password and salt.');
        const key = await window.E2EEncryption.deriveKey(passwordInput.value, saltInput.value);
        passwordInput.value = '';
        raw = new Uint8Array(await window.crypto.subtle.exportKey('raw', key));
        await request('/mcp/hosted/peer-key', { grantId: config.grantId, peerId: select.value, encryptionKey: btoa(String.fromCharCode(...raw)) });
        feedback.textContent = 'Shared peer configured. Its messages and attachments can now be used without this tab.';
      } catch (error) { feedback.textContent = error.message; }
      finally { passwordInput.value = ''; raw?.fill(0); }
    });
    (document.querySelector('main') || document.body).appendChild(section);
  }
  async function connect({ forcePassword = false } = {}) {
    if (active.running || active.connecting) return;
    active.connecting = true;
    const generation = ++active.generation;
    try {
      active.connected = false;
      setState('Connecting', 'Checking for an encryption key saved in this browser…');
      const key = forcePassword ? await promptForKey() : active.key || await unlockKey();
      if (generation !== active.generation) return;
      active.key = key;
      if (config.hostedApproved) {
        setState('Connecting', 'Encryption unlocked. Activating your always-on connection…');
        let connected = false;
        let encoded;
        const raw = new Uint8Array(await window.crypto.subtle.exportKey('raw', active.key));
        try { encoded = btoa(String.fromCharCode(...raw)); } finally { raw.fill(0); }
        try {
          for (let attempt = 0; attempt < 60; attempt++) {
            if (generation !== active.generation) return;
            try {
              await request('/mcp/hosted/enable', { grantId: config.grantId, encryptionKey: encoded });
              connected = true;
              break;
            } catch (error) {
              if (error.code !== 'grant_revoked' || config.grantReady) throw error;
              const returnLink = document.getElementById('returnToApp');
              if (error.keyStored && returnLink?.href) {
                try {
                  const callbackUrl = new URL(returnLink.href, window.location?.origin || 'https://chatmcp.space');
                  if (window.location?.origin && callbackUrl.origin !== window.location.origin) {
                    returnLink.removeAttribute('target');
                    setState('Connecting', 'Encryption unlocked. Returning to your AI app to finish linking…');
                    window.location.assign(callbackUrl.href);
                    return;
                  }
                } catch (_err) { /* fall through to polling */ }
              }
              setState('Waiting for AI app', 'Encryption unlocked. Press Return to your AI app below and finish connecting there. Keep this tab open; it will confirm when the connection is ready.');
              await pause(1000);
            }
          }
        } finally { encoded = null; }
        if (generation !== active.generation) return;
        if (!connected) throw new Error('The AI app has not finished connecting yet. Press Return to your AI app and complete the connection there, then press Try connecting again here. If the approval has expired, start a new connection in the AI app.');
        config.grantReady = true;
        active.connected = true;
        active.connecting = false;
        changeKey.hidden = false;
        setState('Connected', 'Your agent connection is ready. Return to your AI app and ask it to read your ChatMCP inbox or send a test message. You can close this tab.');
        setupSharedPeers().catch(() => {});
        return;
      }
      setState('Connecting', 'Waiting for your AI app to finish its OAuth setup, then enrolling the browser gateway.');
      let enrollment;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (generation !== active.generation) return;
        try { enrollment = await request('/mcp/gateway/enroll', { grantId: config.grantId }); break; }
        catch (error) {
          if (!['grant_revoked', 'gateway_unavailable'].includes(error.code) || (error.code === 'grant_revoked' && config.grantReady)) throw error;
          setState('Waiting for AI app', 'Encryption unlocked. Press Return to your AI app and finish connecting there. Keep this tab open; we are checking for completion.');
          await pause(1000);
        }
      }
      if (generation !== active.generation) return;
      if (!enrollment) throw new Error('The AI app did not finish connecting. Return to it and select Connect, then retry here.');
      active.agentToken = enrollment.agentToken;
      active.agentName = enrollment.agentName;
      active.connectionId = enrollment.connectionId;
      active.gatewaySecret = enrollment.gatewaySecret;
      active.running = true;
      active.connected = true;
      active.connecting = false;
      config.grantReady = true;
      changeKey.hidden = false;
      setState('Connected', 'The browser is connected and unlocked. Keep this tab open.');
      loop();
    } catch (error) {
      if (generation === active.generation) {
        active.connecting = false;
        changeKey.hidden = false;
        unlock.hidden = true;
        const messages = {
          login_required: 'Your sign-in session expired. Reload this page and sign in again to continue.',
          csrf_invalid: 'This page has expired. Reload it, then try connecting again.',
          grant_revoked: 'This approval has expired or was disconnected. Start a new MCP connection from your AI app.',
          hosted_setup_failed: 'Always-on setup could not finish. Press Use another encryption password if your saved password has changed, then try again. If it still fails, the ChatMCP service needs attention.'
        };
        const message = messages[error.code] || (error.name === 'TimeoutError'
          ? 'ChatMCP is taking too long to respond. Press Try connecting again. If it keeps timing out, the service needs attention.'
          : /extractable|exportKey/.test(error.message)
          ? 'The saved encryption key could not be reused. Press Use another encryption password and unlock again.'
          : error.message === 'Failed to fetch' ? 'Could not reach ChatMCP. Check your internet connection, then press Try connecting again.' : error.message);
        setState('Connection needs attention', message);
      }
    }
  }
  reconnect.addEventListener('click', () => connect());
  password.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); unlockButton.click(); }
  });
  changeKey.addEventListener('click', async () => {
    if (active.connecting || active.revoked) return;
    if (config.hostedApproved || !active.running) { await connect({ forcePassword: true }); return; }
    try {
      active.key = await promptForKey();
      changeKey.hidden = false;
      if (active.running) setState('Connected', 'The key was replaced locally. Keep this tab open and retry the message tool.');
    } catch (error) { setState('Locked', error.message); }
  });
  const disconnect = document.getElementById('disconnect');
  disconnect.addEventListener('click', async () => {
    disconnect.disabled = true;
    active.generation++;
    active.connecting = false;
    active.running = false;
    active.cancelUnlock?.();
    active.connected = false;
    unlock.hidden = true;
    setState('Disconnecting', 'Removing this app’s access and the stored connection key…');
    try {
      await request('/mcp/gateway/close', { grantId: config.grantId, ...(active.connectionId ? { connectionId: active.connectionId, gatewaySecret: active.gatewaySecret } : {}) });
    } catch (error) {
      setState('Offline', `Could not revoke this connection: ${error.message}. Retry Disconnect while online.`);
      disconnect.disabled = false;
      return;
    }
    active.connectionId = active.gatewaySecret = active.agentToken = null;
    active.key = null;
    active.revoked = true;
    changeKey.hidden = true;
    reconnect.hidden = true;
    document.getElementById('returnToApp')?.setAttribute('hidden', '');
    setState('Offline', 'Disconnected and access revoked. Reconnect from your AI app to use message tools again.');
  });
  document.getElementById('returnToApp')?.addEventListener('click', () => {
    const feedback = document.getElementById('returnFeedback');
    if (feedback) feedback.textContent = active.connected
      ? 'Continue in your AI app. Ask it to read your ChatMCP inbox to verify the connection.'
      : 'Opened the return link. Finish connecting in your AI app. Leave this tab open until it says Connected.';
  });
  window.addEventListener('beforeunload', () => { active.running = false; });
  connect();
})();
