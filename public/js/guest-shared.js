/* global GuestCrypto, GuestWorkspace */
'use strict';

(function (root) {
  const form = document.getElementById('guestUnlockForm');
  const panel = document.getElementById('guestUnlockPanel');
  const workspacePanel = document.getElementById('guestWorkspace');
  const status = document.getElementById('guestStatus');
  if (!form || !panel || !workspacePanel) return;

  let activeSession = null;
  let ended = false;

  function cookie(name) {
    const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
  }

  function clearGuestCache(shareId, guestId) {
    if (!shareId || !guestId) return;
    const prefix = `guest-outbox:${shareId}:${guestId}:`;
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key && key.startsWith(prefix)) sessionStorage.removeItem(key);
      }
    } catch (_) {
      // The workspace is still hidden and the durable private key is removed below.
    }
  }

  function updateJoinAvailability() {
    const button = form.querySelector('button[type="submit"]');
    const hasInvite = /^[A-Za-z0-9_-]{43}$/.test(root.location.hash.slice(1));
    if (button) button.disabled = !hasInvite;
    if (!hasInvite && !activeSession && !status.textContent.includes('original invitation link')) {
      status.textContent = `${status.textContent ? status.textContent + ' ' : ''}Open the original invitation link to join again.`;
    }
  }

  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (activeSession?.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers['x-guest-csrf'] = activeSession.csrfToken;
    const requestOptions = { ...options, method, credentials: 'same-origin', headers };
    if (requestOptions.body && typeof requestOptions.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(requestOptions.body);
    }
    const response = await fetch('/api/guest' + path, requestOptions);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || 'Guest session unavailable'), { status: response.status });
    return data;
  }

  async function startSession(session, workspace, identity) {
    activeSession = session;
    ended = false;
    panel.hidden = true;
    workspacePanel.hidden = false;
    document.getElementById('guestLogout').hidden = false;
    status.textContent = '';
    if (root.GuestWorkspace?.start) {
      await root.GuestWorkspace.start({
        csrfToken: session.csrfToken,
        workspace,
        identity,
        onSessionEnded: endSession
      });
    }
  }

  async function establish(responseData) {
    const identity = await root.GuestCrypto.ensureIdentity(responseData.share.shareId, responseData.guest.guestId);
    activeSession = { csrfToken: responseData.csrfToken, share: responseData.share, guestId: responseData.guest.guestId };
    const identityResponse = await request('/identity', {
      method: 'PUT',
      body: { publicKey: identity.publicKey }
    });
    if (!identityResponse) throw new Error('Encrypted guest identity could not be registered');
    const workspace = await request('/workspace');
    root.history.replaceState(null, '', root.location.pathname + root.location.search);
    await startSession(activeSession, workspace, identity);
  }

  async function endSession(message = 'You’re signed out. Open the original invitation link to join again.') {
    if (ended) return;
    ended = true;
    const session = activeSession;
    try { await root.GuestWorkspace?.stop?.(); } catch (_) { /* Continue clearing guest credentials. */ }
    clearGuestCache(session?.share?.shareId, session?.guestId);
    try {
      if (session?.share?.shareId && session?.guestId) await root.GuestCrypto.removeIdentity(session.share.shareId, session.guestId);
    } catch (_) {
      // The visible workspace is still hidden; the key store will be retried on the next revocation path.
    }
    panel.hidden = false;
    workspacePanel.hidden = true;
    document.getElementById('guestLogout').hidden = true;
    const nextStep = /expired|revoked|disabled|unavailable/i.test(message)
      ? 'Ask the owner for a new guest link.'
      : 'Open the original invitation link to join again.';
    status.textContent = `${message} ${nextStep}`;
    activeSession = null;
    updateJoinAvailability();
  }

  async function logout() {
    const session = activeSession;
    try {
      await request('/logout', { method: 'POST', body: {} });
    } catch (error) {
      if (error.status !== 401 && error.status !== 404) status.textContent = error.message;
    }
    if (session?.share?.shareId && session?.guestId) await root.GuestCrypto.removeIdentity(session.share.shareId, session.guestId).catch(() => {});
    clearGuestCache(session?.share?.shareId, session?.guestId);
    await root.GuestWorkspace?.stop?.();
    panel.hidden = false;
    workspacePanel.hidden = true;
    document.getElementById('guestLogout').hidden = true;
    form.reset();
    status.textContent = 'Logged out. Your guest key was removed from this browser. Open the original invitation link to join again.';
    activeSession = null;
    ended = false;
    updateJoinAvailability();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const linkSecret = root.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(linkSecret)) {
      status.textContent = 'This guest link is missing or invalid.';
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Unlocking…';
    try {
      const response = await request('/unlock', {
        method: 'POST',
        body: {
          linkSecret,
          displayName: form.elements.displayName.value,
          password: form.elements.password.value
        }
      });
      activeSession = {
        csrfToken: response.csrfToken,
        share: response.share,
        guestId: response.guest.guestId
      };
      status.textContent = 'Preparing encrypted access…';
      await establish(response);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('guestLogout').addEventListener('click', logout);

  (async () => {
    updateJoinAvailability();
    if (root.location.hash) {
      const linkSecret = root.location.hash.slice(1);
      if (!/^[A-Za-z0-9_-]{43}$/.test(linkSecret)) return;
      try {
        const response = await fetch('/api/guest/preview', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkSecret })
        });
        const preview = await response.json().catch(() => ({}));
        if (!response.ok) {
          status.textContent = 'This invitation has expired or was disabled. Ask the person who shared it for a new guest link.';
          const join = form.querySelector('button[type="submit"]');
          if (join) join.disabled = true;
          return;
        }
        const agentName = preview.agents?.[0]?.agentName || 'shared agent chat';
        const ownerName = preview.ownerDisplayName || 'Someone';
        const eyebrow = panel.querySelector('.guest-eyebrow');
        const title = document.getElementById('guestUnlockTitle');
        const description = panel.querySelector('form')?.previousElementSibling;
        if (eyebrow) eyebrow.textContent = `${ownerName} invited you`;
        if (title) title.textContent = `Join ${agentName}`;
        if (description) description.textContent = 'You can read this conversation and shared files, message the agent, and talk with other participants. The owner can read messages in this chat.';
        status.textContent = preview.requiresCode ? 'This guest link also needs a separate guest access code.' : 'No guest access code is required for this link.';
      } catch (_) {
        status.textContent = 'Invitation details could not load. You can still try joining this chat.';
      }
      return;
    }
    try {
      const session = await request('/session');
      const workspace = await request('/workspace');
      const identity = await root.GuestCrypto.ensureIdentity(session.share.shareId, session.guest.guestId);
      await startSession({ csrfToken: cookie('guest_csrf'), share: session.share, guestId: session.guest.guestId }, workspace, identity);
    } catch (_) {
      // No active guest session is the normal state on a fresh visit.
    }
  })();
})(window);
