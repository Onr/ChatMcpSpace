/* The last three distinct conversations opened by this account on this browser. */
(function (root) {
  'use strict';
  let agents = [], contexts = [], entries = [], active = null, accountKey = null;
  let loaded = false, signature = '', opening = 0;
  const identity = entry => JSON.stringify([entry.agentId, entry.conversationId || null]);
  function load() {
    const userId = document.getElementById('dashboardRoot')?.dataset.userId;
    const key = userId ? `dashboard_recent_chats:${userId}` : null;
    if (loaded && key === accountKey) return;
    loaded = true; accountKey = key; entries = []; active = null; signature = '';
    try {
      const saved = key && JSON.parse(root.localStorage.getItem(key));
      if (!Array.isArray(saved)) return;
      const seen = new Set();
      entries = saved.filter(entry => {
        if (!entry || typeof entry.agentId !== 'string' || !entry.agentId || entry.agentId === '__ALL__' ||
            (entry.conversationId != null && (typeof entry.conversationId !== 'string' || !entry.conversationId))) return false;
        const id = identity(entry);
        if (seen.has(id)) return false;
        seen.add(id); return true;
      }).slice(0, 3).map(entry => ({agentId: entry.agentId, conversationId: entry.conversationId || null}));
    } catch (_) { /* Storage denial and malformed data must not block navigation. */ }
  }
  function save() {
    try { if (accountKey) root.localStorage.setItem(accountKey, JSON.stringify(entries)); }
    catch (_) { /* Keep the in-memory history when storage is unavailable. */ }
  }
  function metadata(entry) {
    if (entry.conversationId) return contexts.find(c => c.conversationId === entry.conversationId && c.agentId === entry.agentId);
    return agents.find(a => a.agentId === entry.agentId);
  }
  function render() {
    load();
    const nav = document.getElementById('recentChats');
    if (!nav) return;
    const visible = entries.map(entry => ({entry, data: metadata(entry)})).filter(item => item.data);
    const nextSignature = JSON.stringify(visible.map(({entry, data}) => [identity(entry), data.agentName || data.name, active === identity(entry)]));
    if (signature === nextSignature) return;
    signature = nextSignature;
    const focused = nav.contains(document.activeElement) ? document.activeElement.dataset.chatKey : null;
    nav.replaceChildren(); nav.hidden = !visible.length;
    for (let i = 0; i < visible.length; i++) {
      const {entry, data} = visible[i];
      const name = data.agentName || data.name || 'Chat';
      const shared = Boolean(entry.conversationId);
      const isCurrent = active === identity(entry);
      const rankLabel = i === 0 ? (isCurrent ? 'Current chat' : 'Most recent') : i === 1 ? 'Previous chat' : 'Earlier chat';
      const button = document.createElement('button');
      button.type = 'button'; button.className = `recent-chat recent-chat--rank-${i + 1}`;
      button.dataset.chatKey = identity(entry); button.dataset.recencyRank = String(i + 1);
      button.title = `${name} · ${rankLabel} (${shared ? 'Shared chat' : 'Personal chat'})`;
      button.setAttribute('aria-label', `Open ${name}, ${shared ? 'shared chat' : 'personal chat'}`);
      if (isCurrent) button.setAttribute('aria-current', 'page');
      const avatar = document.createElement('span'); avatar.className = 'recent-chat__avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = name.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase() || '•';
      const label = document.createElement('span'); label.className = 'recent-chat__name'; label.textContent = name;
      button.append(avatar, label);
      if (shared) {
        const badge = document.createElement('span'); badge.className = 'recent-chat__shared';
        badge.textContent = '↗'; badge.setAttribute('aria-hidden', 'true'); button.append(badge);
      }
      button.addEventListener('click', () => { void open(entry, button); });
      nav.append(button);
    }
    for (let i = visible.length; visible.length > 0 && i < 3; i++) {
      const slot = document.createElement('span');
      slot.className = `recent-chat recent-chat--empty recent-chat--rank-${i + 1}`;
      slot.setAttribute('aria-hidden', 'true');
      const avatar = document.createElement('span'); avatar.className = 'recent-chat__avatar';
      const label = document.createElement('span'); label.className = 'recent-chat__name'; label.textContent = '···';
      slot.append(avatar, label);
      nav.append(slot);
    }
    if (focused) [...nav.children].find(el => el.dataset.chatKey === focused)?.focus({preventScroll: true});
  }
  async function open(entry, button) {
    const request = ++opening;
    const selection = root.DashboardHelpers?.getChatSelectionVersion();
    const stillCurrent = () => request === opening && selection === root.DashboardHelpers?.getChatSelectionVersion();
    button.disabled = true;
    let timeout;
    try {
      if (entry.conversationId) {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 15000);
        const response = await root.fetch('/api/user/chat-threads/' + encodeURIComponent(entry.conversationId), {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        if (!stillCurrent()) return;
        if (!response.ok) {
          if (response.status === 403 || response.status === 404) {
            entries = entries.filter(item => identity(item) !== identity(entry)); save(); render();
          }
          throw new Error(response.status === 403 || response.status === 404
            ? 'This chat is no longer available.' : 'Could not open this chat. Please try again.');
        }
        const context = await response.json();
        if (stillCurrent()) await root.DashboardHelpers.selectChatContext(context);
      } else {
        const agent = metadata(entry);
        if (!agent) return;
        await root.selectAgent(entry.agentId, agent.name, {agentType: agent.agentType,
          externalProvider: agent.externalProvider, forceMainSelection: true});
      }
    } catch (error) {
      if (stillCurrent()) root.showError?.(error.name === 'AbortError' ? 'Opening this chat timed out. Please try again.' : error.message);
    } finally { clearTimeout(timeout); button.disabled = false; }
  }
  root.RecentChats = {
    updateAgents(list) { agents = Array.isArray(list) ? list : []; render(); },
    updateContexts(list) { contexts = Array.isArray(list) ? list : []; render(); },
    remember(agentId, context) {
      if (!agentId) return;
      load();
      if (agentId === '__ALL__') { active = null; render(); return; }
      const entry = {agentId, conversationId: context?.mode === 'shared' ? context.conversationId : null};
      // A just-opened shared context can render before the next background refresh.
      if (entry.conversationId) contexts = [context, ...contexts.filter(c => c.conversationId !== entry.conversationId)];
      active = identity(entry);
      entries = [entry, ...entries.filter(item => identity(item) !== active)].slice(0, 3);
      save(); render();
    }
  };
})(window);
