/* Shared-agent galaxy and group-aware endpoints for the live council. */
(function (root) {
  'use strict';
  let agents = [], groups = [], activeGroup = null, contexts = [], connections = [], frame = null;
  let panel = null, trigger = null, returnFocus = null;
  const node = (tag, cls, text) => Object.assign(document.createElement(tag), {className: cls, ...(text === undefined ? {} : {textContent: text})});
  function schedule() {
    if (frame !== null) return;
    frame = root.requestAnimationFrame(() => {
      frame = null;
      render();
      root.dispatchEvent(new Event('council:layout'));
    });
  }
  let contextsSignature = '';
  function incoming() {
    return contexts.filter(c => c.mode === 'shared' && c.role !== 'owner');
  }
  function close() {
    if (!panel) return;
    panel.remove(); panel = null;
    trigger?.setAttribute('aria-expanded', 'false');
    returnFocus?.focus();
  }
  function open() {
    if (panel) { close(); return; }
    returnFocus = document.activeElement;
    panel = node('div', 'shared-galaxy-dialog');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'sharedGalaxyTitle');
    const card = node('section', 'shared-galaxy-card');
    const header = node('header', 'shared-galaxy-header');
    const title = node('h2', '', 'Shared galaxy'); title.id = 'sharedGalaxyTitle';
    const dismiss = node('button', 'shared-galaxy-close', '×'); dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Close shared galaxy'); dismiss.addEventListener('click', close);
    header.append(title, dismiss); card.append(header);
    card.append(node('p', 'shared-galaxy-hint', 'Agents shared with you · access and messaging permissions stay with their owners.'));
    const list = node('div', 'shared-galaxy-list');
    incoming().forEach(context => {
      const button = node('button', 'shared-galaxy-agent'); button.type = 'button';
      const avatar = node('span', 'shared-galaxy-avatar', (context.agentName || 'Agent').slice(0,2).toUpperCase());
      avatar.setAttribute('aria-hidden', 'true');
      const copy = node('span', 'shared-galaxy-copy');
      copy.append(node('strong', '', context.agentName || 'Shared agent'));
      copy.append(node('small', '', context.membershipStatus === 'active' ? 'Open shared conversation' : 'Waiting for access · open details'));
      button.append(avatar, copy);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await root.fetch('/api/user/chat-threads/' + encodeURIComponent(context.conversationId), {credentials: 'same-origin', cache: 'no-store'});
          if (!response.ok) throw new Error('This conversation is no longer available. Refresh the shared list.');
          const current = await response.json();
          await root.DashboardHelpers?.selectChatContext?.(current);
          close();
        } catch (error) { feedback.textContent = error.message; button.disabled = false; }
      });
      list.append(button);
    });
    if (!incoming().length) list.append(node('p', '', 'No agents are currently shared with you.'));
    const feedback = node('p', 'shared-galaxy-feedback'); feedback.setAttribute('role', 'status');
    card.append(list, feedback); panel.append(card); document.body.append(panel);
    panel.addEventListener('click', e => { if (e.target === panel) close(); });
    panel.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key !== 'Tab') return;
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    trigger?.setAttribute('aria-expanded', 'true'); dismiss.focus();
  }
  function badge(seat) {
    if (seat.querySelector('.agent-share-badge')) return;
    const mark = node('span', 'agent-share-badge');
    mark.title = 'Shared with others'; mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', 'Shared with others');
    mark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/></svg>';
    (seat.querySelector('.agent-avatar') || seat).append(mark);
  }
  function render() {
    const circle = document.getElementById('councilCircle');
    if (!circle) return;
    trigger = document.getElementById('sharedGalaxy');
    if (!trigger) {
      trigger = node('button', 'shared-galaxy'); trigger.id = 'sharedGalaxy'; trigger.type = 'button';
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
      trigger.innerHTML = '<span class="shared-galaxy-art" aria-hidden="true"><i></i><i></i><i></i><b>✦</b></span><span class="shared-galaxy-label"></span>';
      trigger.addEventListener('click', open); circle.append(trigger);
    }
    trigger.hidden = !incoming().length;
    trigger.querySelector('.shared-galaxy-label').textContent = `Shared with you · ${incoming().length}`;
    trigger.setAttribute('aria-label', `Open shared galaxy, ${incoming().length} shared conversations`);
    const outgoing = new Set(contexts.filter(c => c.role === 'owner' && c.mode === 'shared').map(c => c.agentId));
    circle.querySelectorAll('.agent-seat').forEach(seat => {
      if (outgoing.has(seat.dataset.agentId)) badge(seat);
      else seat.querySelector('.agent-share-badge')?.remove();
    });
    // In a group, preserve routes to other groups through small named gateways.
    circle.querySelectorAll('.a2a-group-gateway').forEach(el => el.remove());
    const activeMembers = new Set(groups.find(g => g.groupId === activeGroup)?.memberIds || []);
    const remoteIds = new Set();
    connections.filter(c => Date.now() - new Date(c.lastMessage).getTime() < 3600000).forEach(c => {
      if (activeMembers.has(c.agent1Id)) remoteIds.add(c.agent2Id);
      if (activeMembers.has(c.agent2Id)) remoteIds.add(c.agent1Id);
    });
    const gateways = groups.filter(g => g.groupId !== activeGroup && g.memberIds?.some(id => remoteIds.has(id)));
    const grouped = new Set(groups.flatMap(g => g.memberIds || []));
    if (agents.some(a => remoteIds.has(a.agentId) && !grouped.has(a.agentId))) gateways.push({groupId:'__home', groupName:'All agents'});
    if (activeGroup) gateways.slice(0,8).forEach((g, i) => {
      const gate = node('button', 'a2a-group-gateway', g.groupName); gate.type = 'button';
      gate.dataset.groupId = g.groupId; gate.style.top = `${22 + i * 34}px`;
      gate.title = `Open group ${g.groupName}`;
      gate.addEventListener('click', () => g.groupId === '__home' ? root.exitGroupView?.() : root.enterGroupView?.(g.groupId));
      circle.append(gate);
    });
  }
  function positions(circle, bounds) {
    const result = new Map();
    const add = (element, ids, key) => {
      if (!element || element.hidden) return;
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height) return;
      for (const id of ids) if (!result.has(id)) result.set(id, {x:r.left+r.width/2-bounds.left, y:r.top+r.height/2-bounds.top, key});
    };
    groups.forEach(g => {
      const seat = [...circle.querySelectorAll('.group-seat, .a2a-group-gateway')].find(el => el.dataset.groupId === g.groupId);
      add(seat, g.memberIds || [], 'group:' + g.groupId);
    });
    const home = circle.querySelector('[data-group-id="__home"]');
    const grouped = new Set(groups.flatMap(g => g.memberIds || []));
    add(home, agents.filter(a => !grouped.has(a.agentId)).map(a => a.agentId), 'home');
    add(document.getElementById('sharedGalaxy'), incoming().map(c => c.agentId), 'shared-galaxy');
    return result;
  }
  async function loadMessagingSettings(context) {
    document.getElementById('sharedAgentMessagingSetting')?.remove();
    if (context?.role !== 'owner' || context.mode !== 'shared') return;
    const host = document.getElementById('shareExistingChatInvites');
    if (!host) return;
    const wrap = node('div', 'shared-a2a-setting'); wrap.id = 'sharedAgentMessagingSetting';
    const label = node('label', '');
    const input = document.createElement('input'); input.type = 'checkbox'; input.disabled = true;
    label.append(input, document.createTextNode(' Allow members’ agents to message this agent'));
    const hint = node('p', '', 'The shared agent must use a trusted runtime. Members’ agents may use its normal tool permissions. Both agents must allow all-agent messaging and use the same separate DM password and salt. Turn off to stop new shared DMs.');
    const feedback = node('p', ''); feedback.setAttribute('role', 'status');
    wrap.append(label, hint, feedback); host.append(wrap);
    const url = '/api/user/shared/' + encodeURIComponent(context.conversationId) + '/agent-messaging';
    try {
      const response = await root.fetch(url, {credentials:'same-origin', cache:'no-store'});
      if (!response.ok) throw new Error('Could not load agent messaging permissions.');
      input.checked = (await response.json()).enabled; input.disabled = false;
    } catch (error) { feedback.textContent = error.message; }
    input.addEventListener('change', async () => {
      input.disabled = true; const requested = input.checked;
      try {
        const fetcher = root.csrfFetch || root.fetch;
        const response = await fetcher(url, {method:'PUT', credentials:'same-origin',
          headers:{'Content-Type':'application/json', 'X-CSRF-Token':root.csrfToken || ''}, body:JSON.stringify({enabled:requested})});
        if (!response.ok) throw new Error('Could not save agent messaging permissions.');
        input.checked = (await response.json()).enabled;
        feedback.textContent = input.checked ? 'Shared agent messaging enabled.' : 'Shared agent messaging disabled.';
      } catch (error) { input.checked = !requested; feedback.textContent = error.message; }
      finally { input.disabled = false; }
    });
  }
  root.CouncilSharing = {
    updateOrbit(nextAgents, nextGroups, group) { agents = nextAgents; groups = nextGroups || []; activeGroup = group; schedule(); },
    updateContexts(next) { const signature = JSON.stringify((next || []).map(c => [c.agentId,c.conversationId,c.agentName,c.mode,c.role,c.membershipStatus])); if (signature === contextsSignature) return; contextsSignature = signature; contexts = Array.isArray(next) ? next : []; if (panel) close(); schedule(); },
    updateConnections(next) { connections = next || []; schedule(); },
    positions,
    loadMessagingSettings,
    open,
    destroy() { close(); if (frame !== null) root.cancelAnimationFrame(frame); frame = null; }
  };
})(window);
