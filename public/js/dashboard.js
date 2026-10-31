/**
 * Dashboard JavaScript
 * Handles agent list polling, message polling, agent selection, and option selection
 */

const MOBILE_LIST_ONLY_MEDIA_QUERY = '(max-width: 1023px)';
const MOBILE_NARROW_MEDIA_QUERY = '(max-width: 767px)';
const TOUCH_LANDSCAPE_MEDIA_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 600px)';
const DASHBOARD_FAST_MODE_STORAGE_KEY = 'dashboardFastMode';
const SEND_BUTTON_SPACESHIP_ICON_HTML = `
  <svg class="send-spaceship-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path class="send-spaceship-flame" d="M4.2 16.2 1.7 21l4.8-2.5" />
    <path d="M6.5 17.5 10.3 21l1.7-5.1" />
    <path d="M6.5 17.5 3 13.7l5.1-1.7" />
    <path d="M8.1 12c3.5-5.2 7.9-8.1 13.4-9.2-.9 5.5-4 9.9-9.2 13.4L8.1 12Z" />
    <circle cx="15.7" cy="8.3" r="1.6" />
  </svg>`;

function setSendButtonLabel(label) {
  if (!userMessageSendButton) return;

  let labelEl = userMessageSendButton.querySelector('.send-label');
  if (!userMessageSendButton.querySelector('.send-spaceship-icon') || !labelEl) {
    userMessageSendButton.innerHTML = `${SEND_BUTTON_SPACESHIP_ICON_HTML}<span class="send-label"></span>`;
    labelEl = userMessageSendButton.querySelector('.send-label');
  }
  if (labelEl) labelEl.textContent = label;
}

function isMobileListOnlyMode() {
  return Boolean(window.matchMedia?.(MOBILE_LIST_ONLY_MEDIA_QUERY)?.matches);
}

function isAgentListDocked() {
  return Boolean(window.matchMedia?.(
    '(min-width: 768px) and (max-width: 1023px) and (min-height: 601px), ' +
    '(pointer: coarse) and (min-width: 768px) and (max-width: 1180px) and (min-height: 601px)'
  )?.matches);
}

function getDashboardLayoutMode() {
  if (window.matchMedia?.(MOBILE_NARROW_MEDIA_QUERY)?.matches) return 'mobile';
  if (window.matchMedia?.(TOUCH_LANDSCAPE_MEDIA_QUERY)?.matches) return 'touch-landscape';
  return 'desktop';
}

function isDashboardFastModeEnabled() {
  try {
    return window.localStorage?.getItem(DASHBOARD_FAST_MODE_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function setDashboardFastModeEnabled(enabled) {
  try {
    if (enabled) {
      window.localStorage?.setItem(DASHBOARD_FAST_MODE_STORAGE_KEY, '1');
    } else {
      window.localStorage?.removeItem(DASHBOARD_FAST_MODE_STORAGE_KEY);
    }
  } catch (_) {
    // localStorage can be unavailable in private contexts; the body class still updates.
  }
  applyDashboardMobileModeClasses();
}

function applyDashboardMobileModeClasses() {
  if (!document.body) return;

  const mode = getDashboardLayoutMode();
  const isMobileShell = mode === 'mobile' || mode === 'touch-landscape' || isMobileListOnlyMode();
  document.body.classList.toggle('dashboard-mobile', isMobileShell);
  document.body.classList.toggle('dashboard-touch-landscape', mode === 'touch-landscape');
  document.body.classList.toggle('dashboard-desktop', !isMobileShell);
  document.body.classList.toggle('dashboard-fast-mode', isMobileShell && isDashboardFastModeEnabled());

  const listVisible = isAgentListDocked() || document.getElementById('agentListPanel')?.classList.contains('mobile-expanded');
  for (const id of ['collapseMobileListBtn', 'fastModeChatListToggle', 'fastModePlaceholderOpenChats']) {
    document.getElementById(id)?.setAttribute('aria-expanded', String(Boolean(listVisible)));
  }

  const toggle = document.getElementById('mobileFastModeToggle');
  if (toggle) {
    const enabled = document.body.classList.contains('dashboard-fast-mode');
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    toggle.setAttribute('aria-label', enabled ? 'Disable fast mobile mode' : 'Enable fast mobile mode');
    toggle.title = enabled ? 'Disable fast mobile mode' : 'Enable fast mobile mode';
    const label = toggle.querySelector('.mobile-fast-mode-toggle__label');
    if (label) label.textContent = 'Fast Mode';
    const state = toggle.querySelector('.mobile-fast-mode-toggle__state');
    if (state) state.textContent = enabled ? 'On' : 'Off';
  }
}

function setupMobileFastModeToggle() {
  const toggle = document.getElementById('mobileFastModeToggle');
  if (!toggle || toggle.dataset.fastModeBound === 'true') {
    applyDashboardMobileModeClasses();
    ensureFastModeNavCluster();
    return;
  }

  toggle.dataset.fastModeBound = 'true';
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextEnabled = !document.body.classList.contains('dashboard-fast-mode');
    setDashboardFastModeEnabled(nextEnabled);
    ensureMobileComposerVisible({ restoreChrome: true });
    requestAnimationFrame(() => {
      syncMobileComposerLayout();
      window.updateScrollToBottomButton?.();
    });
  });
  applyDashboardMobileModeClasses();
  ensureFastModeNavCluster();
}

function getFastModeUnreadMessageCount(agents = currentAgentList) {
  if (Array.isArray(agents) && agents.length > 0) {
    return agents.reduce((total, agent) => total + (Number(agent?.unreadCount) || 0), 0);
  }

  return Array.from(document.querySelectorAll('#agentSeats .agent-seat[data-agent-unread]'))
    .reduce((total, el) => total + (Number(el.getAttribute('data-agent-unread')) || 0), 0);
}

/**
 * Inject a small cluster of fast-mode-only indicators (urgent / attention badges)
 * into the top nav's .nav-right-buttons row so the fast mobile view can drop the
 * council header row and stats row entirely. Hidden controls live under the
 * normal mobile Menu button.
 * Only visible when body has .dashboard-fast-mode (CSS-gated).
 */
function ensureFastModeNavCluster() {
  const navRight = document.querySelector('nav .nav-right-buttons');
  if (!navRight) return null;

  let cluster = document.getElementById('fastModeNavCluster');
  if (cluster) {
    bindFastModeNavClusterHandlers();
    return cluster;
  }

  cluster = document.createElement('div');
  cluster.id = 'fastModeNavCluster';
  cluster.className = 'fast-mode-nav-cluster';
  cluster.setAttribute('role', 'group');
  cluster.setAttribute('aria-label', 'Fast mode status');
  cluster.innerHTML = [
    '<button type="button" id="fastModeUrgentIndicator" class="fast-mode-nav-cluster__indicator fast-mode-nav-cluster__indicator--urgent" data-count="0" data-filter="urgent" title="Urgent agents — tap to view" aria-haspopup="true" aria-expanded="false" aria-label="Show urgent agents">',
    '  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">',
    '    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>',
    '  </svg>',
    '  <span class="fast-mode-nav-cluster__count" data-count-text>0</span>',
    '</button>',
    '<button type="button" id="fastModeAttentionIndicator" class="fast-mode-nav-cluster__indicator fast-mode-nav-cluster__indicator--attention" data-count="0" data-filter="attention" title="Unread messages — tap to view agents" aria-haspopup="true" aria-expanded="false" aria-label="Show unread messages">',
    '  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">',
    '    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>',
    '  </svg>',
    '  <span class="fast-mode-nav-cluster__count" data-count-text>0</span>',
    '</button>'
  ].join('');

  // Insert at the very start so it sits next to the Menu button (when on mobile)
  // and right after the logo column otherwise.
  navRight.insertBefore(cluster, navRight.firstChild);

  // Seed indicator counts from the existing EJS-rendered stats so the badges
  // are correct on initial paint, before the first agent-list poll.
  const initialUrgent = Number(document.getElementById('statsUrgent')?.textContent?.trim()) || 0;
  const initialAttention = getFastModeUnreadMessageCount();
  updateFastModeNavCluster({ urgent: initialUrgent, attention: initialAttention });

  // Wire the badges so tapping them lists matching agents.
  bindFastModeNavClusterHandlers();

  return cluster;
}

/**
 * Refresh the count badges on the fast-mode top-nav cluster. Hidden when zero.
 */
function updateFastModeNavCluster(stats) {
  const urgent = Math.max(0, Number(stats?.urgent) || 0);
  const attention = Math.max(0, Number(stats?.attention) || 0);

  const urgentEl = document.getElementById('fastModeUrgentIndicator');
  if (urgentEl) {
    urgentEl.dataset.count = String(urgent);
    urgentEl.dataset.active = urgent > 0 ? 'true' : 'false';
    const text = urgentEl.querySelector('[data-count-text]');
    if (text) text.textContent = urgent > 9 ? '9+' : String(urgent);
  }

  const attentionEl = document.getElementById('fastModeAttentionIndicator');
  if (attentionEl) {
    attentionEl.dataset.count = String(attention);
    attentionEl.dataset.active = attention > 0 ? 'true' : 'false';
    const text = attentionEl.querySelector('[data-count-text]');
    if (text) text.textContent = attention > 9 ? '9+' : String(attention);
  }

  // If the popup with the matching agents is currently open, refresh it so
  // jumped-to agents disappear and counts stay consistent with the badges.
  const panel = document.getElementById('fastModeAlertPanel');
  if (panel && !panel.classList.contains('hidden')) {
    renderFastModeAlertPanel(panel.dataset.filter || 'attention');
  }
}

/**
 * Lazily create the popover used by the Fast Mode urgent/attention badges.
 * It lists matching agents and lets the user tap one to jump to that chat.
 */
function getFastModeAlertPanel() {
  let panel = document.getElementById('fastModeAlertPanel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'fastModeAlertPanel';
  panel.className = 'fast-mode-alert-panel hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Agents needing reply');
  panel.innerHTML = [
    '<div class="fast-mode-alert-panel__title" data-panel-title></div>',
    '<div class="fast-mode-alert-panel__list" data-panel-list></div>',
    '<div class="fast-mode-alert-panel__empty" data-panel-empty hidden>No matching agents.</div>'
  ].join('');
  document.body.appendChild(panel);
  return panel;
}

function getFastModeAlertAgentName(agent = {}) {
  return String(agent.name || agent.agentName || agent.agent_name || '').trim();
}

function buildFastModeAlertList(filter) {
  const source = Array.isArray(currentAgentList) ? currentAgentList : [];
  const matches = source.filter(a => {
    if (!a || !a.agentId) return false;
    const ring = getOrbitRingKey(a);
    if (filter === 'urgent') return ring === 'urgent';
    // attention filter also surfaces unread agents so the bell badge takes
    // the user to anything worth replying to.
    return ring === 'attention' || (Number(a.unreadCount) || 0) > 0;
  });
  matches.sort((a, b) => {
    const ar = getOrbitRingKey(a) === 'urgent' ? 0 : 1;
    const br = getOrbitRingKey(b) === 'urgent' ? 0 : 1;
    if (ar !== br) return ar - br;
    const au = Number(a.unreadCount) || 0;
    const bu = Number(b.unreadCount) || 0;
    if (au !== bu) return bu - au;
    return getFastModeAlertAgentName(a).localeCompare(getFastModeAlertAgentName(b));
  });
  return matches;
}

function renderFastModeAlertPanel(filter) {
  const panel = getFastModeAlertPanel();
  const titleEl = panel.querySelector('[data-panel-title]');
  const listEl = panel.querySelector('[data-panel-list]');
  const emptyEl = panel.querySelector('[data-panel-empty]');
  if (!listEl) return;
  if (titleEl) {
    titleEl.textContent = filter === 'urgent' ? 'Urgent agents' : 'Unread messages';
  }

  const matches = buildFastModeAlertList(filter);
  listEl.innerHTML = '';
  if (matches.length === 0) {
    if (emptyEl) emptyEl.removeAttribute('hidden');
    return;
  }
  if (emptyEl) emptyEl.setAttribute('hidden', '');

  matches.forEach(agent => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'fast-mode-alert-panel__item';
    item.dataset.agentId = agent.agentId;
    const agentName = getFastModeAlertAgentName(agent);
    item.dataset.agentName = agentName;
    const ringKey = getOrbitRingKey(agent);
    item.dataset.priority = ringKey;
    const unread = Number(agent.unreadCount) || 0;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'fast-mode-alert-panel__name';
    nameSpan.textContent = agentName || 'Unnamed agent';
    item.appendChild(nameSpan);

    if (ringKey === 'urgent') {
      const badge = document.createElement('span');
      badge.className = 'fast-mode-alert-panel__badge fast-mode-alert-panel__badge--urgent';
      badge.textContent = '!';
      item.appendChild(badge);
    } else if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'fast-mode-alert-panel__badge fast-mode-alert-panel__badge--unread';
      badge.textContent = unread > 9 ? '9+' : String(unread);
      item.appendChild(badge);
    }

    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const aid = item.dataset.agentId;
      const aname = item.dataset.agentName || '';
      closeFastModeAlertPanel();
      if (!aid) return;
      if (typeof setMobileListExpanded === 'function') {
        setMobileListExpanded(false, { skipBrowserHistory: true });
      }
      try {
        if (typeof openAgentWithFeedback === 'function') {
          openAgentWithFeedback(aid, aname, { forceMainSelection: true });
        } else if (typeof selectAgent === 'function') {
          selectAgent(aid, aname, { forceMainSelection: true });
        }
      } catch (_) { /* navigation best-effort */ }
    });
    listEl.appendChild(item);
  });
}

function positionFastModeAlertPanel(triggerEl) {
  const panel = getFastModeAlertPanel();
  if (!triggerEl || !panel) return;
  const rect = triggerEl.getBoundingClientRect();
  const padding = 8;
  const viewportWidth = window.innerWidth;
  const panelWidth = Math.min(280, viewportWidth - 2 * padding);
  panel.style.width = `${panelWidth}px`;
  let left = rect.left + rect.width / 2 - panelWidth / 2;
  left = Math.max(padding, Math.min(left, viewportWidth - panelWidth - padding));
  const top = rect.bottom + 6;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function openFastModeAlertPanel(filter, triggerEl) {
  const panel = getFastModeAlertPanel();
  panel.dataset.filter = filter;
  renderFastModeAlertPanel(filter);
  panel.classList.remove('hidden');
  positionFastModeAlertPanel(triggerEl);

  const urgentBtn = document.getElementById('fastModeUrgentIndicator');
  const attentionBtn = document.getElementById('fastModeAttentionIndicator');
  if (urgentBtn) urgentBtn.setAttribute('aria-expanded', urgentBtn === triggerEl ? 'true' : 'false');
  if (attentionBtn) attentionBtn.setAttribute('aria-expanded', attentionBtn === triggerEl ? 'true' : 'false');

  if (!document.body.dataset.fastModeAlertDismissBound) {
    document.body.dataset.fastModeAlertDismissBound = 'true';
    document.addEventListener('click', (event) => {
      const livePanel = document.getElementById('fastModeAlertPanel');
      if (!livePanel || livePanel.classList.contains('hidden')) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('#fastModeAlertPanel')) return;
      if (target.closest('#fastModeUrgentIndicator, #fastModeAttentionIndicator')) return;
      closeFastModeAlertPanel();
    });
    window.addEventListener('resize', () => {
      const livePanel = document.getElementById('fastModeAlertPanel');
      if (!livePanel || livePanel.classList.contains('hidden')) return;
      const liveFilter = livePanel.dataset.filter || 'attention';
      const liveTrigger = liveFilter === 'urgent'
        ? document.getElementById('fastModeUrgentIndicator')
        : document.getElementById('fastModeAttentionIndicator');
      positionFastModeAlertPanel(liveTrigger);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const livePanel = document.getElementById('fastModeAlertPanel');
      if (livePanel && !livePanel.classList.contains('hidden')) {
        closeFastModeAlertPanel();
      }
    });
  }
}

function closeFastModeAlertPanel() {
  const panel = document.getElementById('fastModeAlertPanel');
  if (panel) panel.classList.add('hidden');
  document.getElementById('fastModeUrgentIndicator')?.setAttribute('aria-expanded', 'false');
  document.getElementById('fastModeAttentionIndicator')?.setAttribute('aria-expanded', 'false');
}

function bindFastModeNavClusterHandlers() {
  const bind = (id, filter) => {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.fastModeAlertBound === 'true') return;
    btn.dataset.fastModeAlertBound = 'true';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const panel = document.getElementById('fastModeAlertPanel');
      const isOpenForThis = panel && !panel.classList.contains('hidden') && panel.dataset.filter === filter;
      if (isOpenForThis) {
        closeFastModeAlertPanel();
      } else {
        openFastModeAlertPanel(filter, btn);
      }
    });
  };
  bind('fastModeUrgentIndicator', 'urgent');
  bind('fastModeAttentionIndicator', 'attention');
}

function getDefaultNonConversationFocusArea() {
  return isMobileListOnlyMode() ? 'list' : 'council';
}

function ensureMobileComposerVisible({ restoreChrome = false } = {}) {
  if (!isMobileListOnlyMode()) return;

  const messageInputArea = document.getElementById('messageInputArea');
  const shouldShowComposer = selectedAgentId && selectedAgentId !== '__ALL__' && document.body.dataset.allChatsView !== 'true';
  if (shouldShowComposer) {
    if (messageInputArea?.classList.contains('hidden')) {
      messageInputArea.classList.remove('hidden');
    }
    document.body.dataset.agentSelected = 'true';
    if (restoreChrome) {
      setMobileChromeCollapsed(false);
    }
    syncMobileComposerLayout();
  } else {
    if (messageInputArea && !messageInputArea.classList.contains('hidden')) {
      messageInputArea.classList.add('hidden');
    }
    delete document.body.dataset.agentSelected;
    syncMobileComposerLayout();
  }
}

function syncMobileComposerLayout() {
  const root = document.documentElement;
  if (!root) return;

  if (!isMobileListOnlyMode() || !selectedAgentId || selectedAgentId === '__ALL__' || document.body.dataset.allChatsView === 'true') {
    root.style.removeProperty('--mobile-composer-height');
    requestAnimationFrame(() => window.updateScrollToBottomButton?.());
    return;
  }

  const messageInputArea = document.getElementById('messageInputArea');
  if (!messageInputArea || messageInputArea.classList.contains('hidden')) {
    root.style.removeProperty('--mobile-composer-height');
    requestAnimationFrame(() => window.updateScrollToBottomButton?.());
    return;
  }

  const composerHeight = Math.ceil(messageInputArea.getBoundingClientRect().height || messageInputArea.offsetHeight || 0);
  if (composerHeight > 0) {
    root.style.setProperty('--mobile-composer-height', `${composerHeight}px`);
  }
  requestAnimationFrame(() => window.updateScrollToBottomButton?.());
}

function revealMobileComposerFromConversationEdge(conversationArea, { restoreChrome = true } = {}) {
  if (!isMobileListOnlyMode() || !selectedAgentId || !conversationArea) {
    return false;
  }

  const distanceFromBottom = conversationArea.scrollHeight - conversationArea.clientHeight - conversationArea.scrollTop;
  if (distanceFromBottom > 12) {
    return false;
  }

  ensureMobileComposerVisible({ restoreChrome });
  return true;
}

function preserveMobileConversationScroll() {
  if (!isMobileListOnlyMode() || !selectedAgentId || selectedAgentId === '__ALL__') {
    return;
  }

  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea) {
    return;
  }

  // A viewport resize during send must not capture a transient render position.
  if (Date.now() < forceScrollToBottomUntil) return;

  const preservedScrollTop = conversationArea.scrollTop;
  const generation = (preserveMobileConversationScroll.generation || 0) + 1;
  preserveMobileConversationScroll.generation = generation;
  const preservedAgentId = selectedAgentId;
  const preservedConversationId = selectedChatContext?.conversationId || selectedAgentId;
  const preserveUntil = Date.now() + 700;
  let expectedScrollTop = preservedScrollTop;
  let lastScrollHeight = conversationArea.scrollHeight;
  let lastClientHeight = conversationArea.clientHeight;
  let cancelled = false;
  const restore = () => {
    if (cancelled || Date.now() > preserveUntil || preserveMobileConversationScroll.generation !== generation ||
        Date.now() < forceScrollToBottomUntil) return;
    if (selectedAgentId !== preservedAgentId || (selectedChatContext?.conversationId || selectedAgentId) !== preservedConversationId) return;
    if (document.body.dataset.allChatsView === 'true' || selectedAgentId === '__ALL__') return;
    if (!document.getElementById('messageInputArea')) return;
    // Keep the viewport through keyboard/composer resizing, but abandon an
    // older restoration once the reader chooses a new position at the same
    // layout size. Background composer updates must not undo their scroll.
    if (Math.abs(conversationArea.scrollTop - expectedScrollTop) > 1 &&
        conversationArea.scrollHeight === lastScrollHeight && conversationArea.clientHeight === lastClientHeight) {
      cancelled = true;
      return;
    }
    conversationArea.scrollTop = preservedScrollTop;
    expectedScrollTop = conversationArea.scrollTop;
    lastScrollHeight = conversationArea.scrollHeight;
    lastClientHeight = conversationArea.clientHeight;
    window.updateScrollToBottomButton?.();
  };

  restore();
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(restore);
  });
  setTimeout(restore, 120);
  setTimeout(restore, 320);
  setTimeout(restore, 650);
}

function cancelMobileConversationScrollPreservation() {
  // A send can add enough content to move the latest message below the
  // preserved viewport. Do not let delayed keyboard-layout callbacks restore
  // the pre-send position after the send has started.
  preserveMobileConversationScroll.generation = (preserveMobileConversationScroll.generation || 0) + 1;
}

function focusMobileComposerFromBottomOverscroll(conversationArea, options = {}) {
  const {
    requireBottomEdge = true,
    respectCooldown = true
  } = options;

  if (requireBottomEdge) {
    if (!revealMobileComposerFromConversationEdge(conversationArea)) {
      return false;
    }
  } else {
    if (!isMobileListOnlyMode() || !selectedAgentId || !conversationArea) {
      return false;
    }
    ensureMobileComposerVisible({ restoreChrome: true });
  }

  if (document.body.dataset.allChatsView === 'true' || selectedAgentId === '__ALL__') {
    return false;
  }

  const input = document.getElementById('userMessageInput');
  if (!input || input.disabled || input.readOnly) {
    return false;
  }

  const now = Date.now();
  if (respectCooldown && now < (focusMobileComposerFromBottomOverscroll.cooldownUntil || 0)) {
    return false;
  }
  if (respectCooldown) {
    focusMobileComposerFromBottomOverscroll.cooldownUntil = now + 800;
  }

  setMobileChromeCollapsed(false);
  ensureMobileComposerVisible({ restoreChrome: true });

  const focusInput = () => {
    try {
      if (typeof input.setSelectionRange === 'function') {
        const end = String(input.value || '').length;
        input.setSelectionRange(end, end);
      }
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
    if (document.activeElement !== input && typeof input.click === 'function') {
      try {
        input.click();
      } catch (_) {
        // click() is only a keyboard-opening hint for mobile browsers.
      }
    }
  };

  focusInput();
  requestAnimationFrame(syncMobileComposerLayout);
  requestAnimationFrame(() => {
    if (document.activeElement !== input) {
      focusInput();
    }
  });
  setTimeout(() => {
    if (document.activeElement !== input) {
      focusInput();
    }
  }, 60);
  return true;
}

function shouldSelectIntoSidePanel(agentId, metadata = {}) {
  if (!agentId || agentId === '__ALL__' || metadata.forceMainSelection === true) {
    return false;
  }
  const sidePanelManager = window.MultiChatManager;
  return Boolean(sidePanelManager && typeof sidePanelManager.isOpen === 'function' && sidePanelManager.isOpen(agentId));
}

function findSidePanelTile(agentId) {
  if (!agentId) return null;
  const tiles = document.querySelectorAll('.chat-tile[data-agent-id]');
  for (const tile of tiles) {
    if (tile.getAttribute('data-agent-id') === agentId) {
      return tile;
    }
  }
  return null;
}

// State management
let agentPollingInterval = null;
let messagePollingInterval = null;
let agentPollNextDelayMs = 3000;
let messagePollNextDelayMs = 3000;
let agentPollInFlight = false;
let messagePollInFlight = false;
let selectedAgentId = null;
let selectedChatContext = null;
let sharedChatSelectionRequest = 0;
let dashboardComposerReady = false;
let dashboardAgentRestorationReady = false;
function signalDashboardReadyWhenInitialized() {
  if (!dashboardComposerReady || !dashboardAgentRestorationReady || window.dashboardReady) return;
  window.dashboardReady = true;
  window.dispatchEvent(new Event('dashboard:ready'));
}
let selectedAgentName = '';
let selectedAgentType = 'standard'; // 'standard' or 'news_feed'
let selectedAgentExternalProvider = '';
let lastMessageTimestamp = null;
let lastMessageCursor = null;
let isLoadingMessages = false; // Flag to prevent polling during message reload
let userMessageForm = null;
let userMessageInput = null;
let userMessageSendButton = null;
let voiceToggleBtn = null;
let voiceInputBtn = null;
let encryptionKey = null; // Store the derived key
window.addEventListener('storage', async event => {
  if (event.key !== null && event.key !== window.E2EEncryption?.encryptionStorageKey?.()) return;
  encryptionKey = await window.E2EEncryption?.getStoredEncryptionKey() || null;
});

// Message history for arrow-key recall (last 4 sent messages per agent)
const messageHistoryMap = new Map(); // agentId -> string[]
let messageHistoryIndex = -1; // -1 = not browsing, 0..n = browsing
let messageHistoryDraft = ''; // save current draft when entering history
let voiceNotificationState = {
  ready: false,
  preferredVoice: null,
  audioUnlocked: false,
  autoplayBlockedNotified: false
};
let lastNotifiedAgentMessage = new Map();
let agentScrollPositions = new Map(); // Store scroll positions for each agent
let forceScrollToBottomOnNextRender = false; // Chat opens should always land on latest message
let forceScrollToBottomUntil = 0; // Keep newly opened chats pinned while async history settles
let pendingSendScrollGuard = null; // Sending should never make the active chat jump upward
const richMessageHistory = new Map(); // agentId -> { messages: [...richData], currentIndex: number }
const interactivePanelStateByAgent = new Map(); // agentId -> boolean (true=open, false=collapsed)
let focusedAgentIndex = -1; // Track focused agent for keyboard navigation
let previousFocusedIndex = -1; // Track previous index for animation direction
let conversationCache = new Map(); // Cache conversations to avoid redundant API calls
let conversationHasMore = new Map(); // agentId -> bool, whether older messages exist
let conversationOldestCursor = new Map(); // agentId -> cursor value for loading older messages
let isLoadingOlderMessages = false; // Guard against concurrent older-message fetches
const INITIAL_MESSAGE_LIMIT = 50; // Only fetch latest N messages on first load
let activeAgentStatsRequestToken = 0; // Cancels stale async stat updates for action menus
let activeConversationLoadToken = 0; // Incremented per chat switch to ignore stale responses
let conversationRenderGeneration = 0;
let isSendingMessage = false;
let openingChatSelection = null;
const CONVERSATION_PRELOAD_LIMIT = 4; // Number of chats to preload in background
const CONVERSATION_PRELOAD_COOLDOWN_MS = 20000; // Avoid hammering the same chat preload
let conversationPreloadInFlight = new Set(); // Track background preload requests
let conversationPreloadLastAttempt = new Map(); // Track last preload attempt time per agent
let numberInputBuffer = ''; // Buffer for two-digit number input
let numberInputTimeout = null; // Timeout for resetting number buffer
let nameInputBuffer = ''; // Buffer for agent name typeahead
let nameInputTimeout = null; // Timeout for resetting name buffer
let agentListSearchQuery = '';
let agentListStatusFilter = 'all';
let agentListCache = { agents: [], timestamp: 0 }; // Cache agent list to avoid redundant API calls
const AGENT_CACHE_TTL = 3000; // Agent cache time-to-live in milliseconds
const DASHBOARD_MIN_POLL_INTERVAL_MS = 3000;
const DASHBOARD_MAX_POLL_INTERVAL_MS = 30000;
const DASHBOARD_DEFAULT_POLL_JITTER_MS = 1000;
const FAST_MODE_AGENT_RENDER_MIN_INTERVAL_MS = 12000;
const FAST_MODE_AGENT_POLL_CACHE_TTL = 12000;
const NAME_TYPEAHEAD_TIMEOUT_MS = 700;
let knownAgentIds = new Set(); // Track known agent IDs to detect new agents
let initialAgentLoadComplete = false; // Flag to skip the very first poll but allow subsequent new agents
let newAgentIds = new Set(); // Track newly added agents for animation
let activeTtsButton = null; // Track currently playing TTS button for animation cleanup
let currentFocusArea = isMobileListOnlyMode() ? 'list' : 'council'; // Track current focus area: 'council' | 'list' | 'conversation'
let activeTtsUtterance = null; // Track active SpeechSynthesisUtterance instance
let activeMessageTtsSession = null; // Resumable per-message playback state
let globalNotifiedMessages = new Set(); // Track message IDs globally to prevent duplicate TTS across agents
let ttsAudioLock = false; // Prevent overlapping TTS audio playback
let pendingTtsQueue = []; // Queue TTS requests when audio is locked
const GLOBAL_NOTIFICATION_TTL = 300000; // Clear global notification tracking after 5 minutes
const NOTIFIED_MESSAGES_STORAGE_KEY = 'dashboard_notified_messages'; // sessionStorage key
const LAST_AGENT_STORAGE_KEY = 'dashboard_last_agent_id'; // localStorage key for last opened agent
const CHAT_NAVIGATION_HISTORY_LIMIT = 50;
const MOBILE_BROWSER_NAVIGATION_STATE_KEY = 'agentsMcpDashboardMobileNavigation';
const MESSAGE_TTS_CHECKPOINT_STORAGE_KEY = 'dashboard_message_tts_checkpoints_v1';
const MESSAGE_TTS_CHECKPOINT_LIMIT = 100;
const MESSAGE_HISTORY_STORAGE_KEY = 'dashboard_message_history_v1';
const COUNCIL_SPLIT_STORAGE_KEY = 'dashboard_council_split_v1';
const COUNCIL_LIST_SPLIT_STORAGE_KEY = 'dashboard_council_list_split_v1';
let lastAgentListRenderSignature = '';
let lastAgentListRenderAt = 0;
const marbleSvgCache = new Map();

function isDashboardFastModeActive() {
  return Boolean(document.body?.classList.contains('dashboard-fast-mode'));
}

function getCachedMarbleSvg(agentId, size, agentName = '', context = 'avatar') {
  const key = `${context}|${agentId}|${size}|${agentName}`;
  if (!marbleSvgCache.has(key)) {
    marbleSvgCache.set(
      key,
      MarbleGenerator.generateMarble(agentId, size, agentName, `${context}-${agentId}`)
    );
  }
  return marbleSvgCache.get(key);
}

function buildAgentListRenderSignature(agents) {
  const agentSignature = (Array.isArray(agents) ? agents : []).map((agent) => [
    agent.agentId,
    agent.name,
    agent.position,
    agent.highestPriority,
    agent.lastMessagePriority,
    agent.unreadCount,
    agent.accessRequests || 0,
    agent.isWorking === true ? '1' : '0',
    agent.lastMessageTime || '',
    agent.lastActivityTime || '',
    agent.lastWorkingHeartbeatTime || '',
    agent.externalProvider || '',
    agent.agentType || ''
  ].join(':')).join('|');

  const groupSignature = (Array.isArray(currentGroups) ? currentGroups : []).map((group) => [
    group.groupId,
    group.groupName,
    (group.memberIds || []).join(',')
  ].join(':')).join('|');

  return [
    isDashboardFastModeActive() ? 'fast' : 'full',
    isAgentListDocked() ? 'docked' : 'overlay',
    activeGroupId || '',
    selectedAgentId || '',
    agentListSearchQuery || '',
    agentListStatusFilter || 'all',
    agentSignature,
    groupSignature
  ].join('||');
}

function shouldSkipAgentListRender(agents) {
  const signature = buildAgentListRenderSignature(agents);
  const now = Date.now();
  const interval = isDashboardFastModeActive() ? FAST_MODE_AGENT_RENDER_MIN_INTERVAL_MS : AGENT_CACHE_TTL;
  if (
    signature === lastAgentListRenderSignature &&
    now - lastAgentListRenderAt < interval
  ) {
    return true;
  }
  lastAgentListRenderSignature = signature;
  lastAgentListRenderAt = now;
  return false;
}

function getAgentPollCacheTtl() {
  return isDashboardFastModeActive() ? FAST_MODE_AGENT_POLL_CACHE_TTL : AGENT_CACHE_TTL;
}

function clampPollDelayMs(value, fallback = DASHBOARD_MIN_POLL_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(DASHBOARD_MIN_POLL_INTERVAL_MS, Math.min(DASHBOARD_MAX_POLL_INTERVAL_MS, Math.round(parsed)));
}

function getPollJitterMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return Math.floor(Math.random() * DASHBOARD_DEFAULT_POLL_JITTER_MS);
  return Math.floor(Math.random() * Math.min(parsed, DASHBOARD_MAX_POLL_INTERVAL_MS));
}

function getRetryAfterMs(response) {
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

function getServerPollDelayMs(response, data, fallback = DASHBOARD_MIN_POLL_INTERVAL_MS) {
  const bodyDelay = data?.poll?.nextPollMs;
  const headerDelay = response?.headers?.get?.('X-Poll-Interval-Ms');
  const retryDelay = getRetryAfterMs(response);
  const base = retryDelay || bodyDelay || headerDelay || fallback;
  const jitterHeader = response?.headers?.get?.('X-Poll-Jitter-Ms');
  const jitterBody = data?.poll?.jitterMs;
  return clampPollDelayMs(base, fallback) + getPollJitterMs(jitterBody ?? jitterHeader);
}

function resetAgentPollCadence() {
  agentPollNextDelayMs = DASHBOARD_MIN_POLL_INTERVAL_MS;
}

function resetMessagePollCadence() {
  messagePollNextDelayMs = DASHBOARD_MIN_POLL_INTERVAL_MS;
}

function shouldRenderAgentListPanelInFastMode() {
  if (!isDashboardFastModeActive()) return true;
  if (isAgentListDocked()) return true;
  const panel = document.getElementById('agentListPanel');
  const hasActiveSearch = normalizeAgentListSearchQuery(agentListSearchQuery).length > 0;
  const hasStatusFilter = agentListStatusFilter && agentListStatusFilter !== 'all';
  return (
    !selectedAgentId ||
    selectedAgentId === '__ALL__' ||
    panel?.classList.contains('mobile-expanded') ||
    hasActiveSearch ||
    hasStatusFilter
  );
}

function clearCollapsedFastModeAgentListPanel() {
  if (!isDashboardFastModeActive()) return;
  if (shouldRenderAgentListPanelInFastMode()) return;
  const listScroll = document.getElementById('agentListScroll');
  if (!listScroll || listScroll.dataset.fastModeCleared === 'true') return;
  listScroll.innerHTML = '';
  listScroll.dataset.fastModeCleared = 'true';
}

function loadPersistedMessageHistory() {
  try {
    const raw = localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    Object.entries(parsed).forEach(([agentId, history]) => {
      if (!agentId || !Array.isArray(history)) return;
      const cleaned = history
        .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        .slice(0, 4);
      if (cleaned.length > 0) {
        messageHistoryMap.set(agentId, cleaned);
      }
    });
  } catch (error) {
    console.warn('Failed to restore saved message history:', error);
  }
}

function persistMessageHistory() {
  try {
    const serialized = {};
    messageHistoryMap.forEach((history, agentId) => {
      if (!agentId || !Array.isArray(history) || history.length === 0) return;
      serialized[agentId] = history.slice(0, 4);
    });
    localStorage.setItem(MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify(serialized));
  } catch (error) {
    console.warn('Failed to persist message history:', error);
  }
}

loadPersistedMessageHistory();
const EMBEDDED_PREVIEW_MODE = window.__embeddedPreview === true;
const AGENT_LOOP_PAUSED_STORAGE_KEY = 'dashboard_agent_loop_paused_agents'; // localStorage key for pausing per-agent loops
const AGENT_UPDATE_PROMPTED_STORAGE_KEY = 'dashboard_agent_cli_update_prompted_versions'; // localStorage key: agentId -> latest prompted version
const INTERACTIVE_PANEL_STATE_STORAGE_KEY = 'dashboard_interactive_panel_state_by_agent'; // localStorage key: agentId -> boolean open state
const INTERACTIVE_RICH_COUNT_STORAGE_KEY = 'dashboard_interactive_rich_count_by_agent'; // localStorage key: agentId -> last known rich message count
let currentAgentList = []; // Latest agent list snapshot for orbit layout
let chatNavigationHistory = []; // Back/forward stack of chats opened in the main conversation
let chatNavigationIndex = -1; // Points at the currently selected entry in chatNavigationHistory
let mobileBrowserNavigationInitialized = false;
let handlingMobileBrowserNavigation = false;
let currentOrbitLayout = null; // Computed orbit layout for drag/drop
let currentGroups = window.__initialGroups || []; // [{ groupId, groupName, description, memberIds }]
let activeGroupId = null; // null = main view, groupId = zoomed into group
let cachedGroupPartition = null; // { ungrouped: [...], grouped: Map<groupId, agents[]>, groupMeta: Map }
let orbitDragState = null; // Active drag state for orbit seats
let orbitPositionSave = Promise.resolve();
let orbitPositionRevision = 0;
const pendingOrbitPositions = new Map();
const confirmedOrbitPositions = new Map();
let orbitDragFrame = null; // Coalesce pointer events to one layout update per frame
let suppressSeatClickUntil = 0; // Prevent click selection after dragging
let orbitDragHandlersInitialized = false; // Ensure drag handlers are attached once
let pendingImages = []; // Array of {file, previewUrl, status, attachmentId, error} for image uploads
let isUploadingImages = false; // Flag to track if images are currently being uploaded
const MAX_IMAGES_PER_MESSAGE = 10; // Maximum attachments allowed per message
const MAX_ATTACHMENT_SIZE_MB = 20;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
let lastAgentRestorationAttempted = false; // Flag to ensure we only try to restore once on page load
let promptedAgentUpdateVersions = new Map(); // Map<agentId, latestVersionAlreadyPrompted>
const interactiveRichMessageCountByAgent = new Map(); // agentId -> number of known rich messages
let agentUpdatePromptActive = false;
let agentUpdateQueueInFlight = new Set(); // Set<agentId>
let pendingAgentUpdateBatch = []; // Agents currently shown in the batch update dialog
const ORBIT_RING_KEYS = ['urgent', 'attention', 'idle'];
const ORBIT_CONFIG = {
  ringRadii: {
    // Match CSS ring sizes (52/72/92%) so agents sit on the ring lines.
    urgent: 26,
    attention: 36,
    idle: 46
  },
  ringIndex: {
    urgent: 0,
    attention: 1,
    idle: 2
  }
};

function getChatNavigationAgent(agentId) {
  if (!agentId) return null;
  const lists = [currentAgentList, agentListCache?.agents];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const agent = list.find((item) => item?.agentId === agentId);
    if (agent) return agent;
  }
  return null;
}

function getChatNavigationMetadata(agent = {}, fallback = {}) {
  return {
    agentType: agent.agentType || fallback.agentType || 'standard',
    externalProvider: agent.externalProvider || fallback.externalProvider || '',
    unread: Number(agent.unreadCount ?? fallback.unread ?? 0),
    lastActivity: agent.lastActivityTime || fallback.lastActivity || '',
    isWorking: agent.isWorking === true || fallback.isWorking === true,
    lastHeartbeat: agent.lastWorkingHeartbeatTime || fallback.lastHeartbeat || '',
    forceMainSelection: true
  };
}

function pruneChatNavigationHistory() {
  if (!Array.isArray(chatNavigationHistory) || chatNavigationHistory.length === 0) return;
  if (!Array.isArray(currentAgentList) || currentAgentList.length === 0) return;

  const selectedEntry = chatNavigationHistory[chatNavigationIndex] || null;
  const validIds = new Set(currentAgentList.map((agent) => agent.agentId).filter(Boolean));
  chatNavigationHistory = chatNavigationHistory.filter((entry) => entry?.agentId && validIds.has(entry.agentId));

  if (chatNavigationHistory.length === 0) {
    chatNavigationIndex = -1;
    return;
  }

  const selectedIndex = selectedEntry
    ? chatNavigationHistory.findIndex((entry) => entry.agentId === selectedEntry.agentId)
    : -1;
  if (selectedIndex >= 0) {
    chatNavigationIndex = selectedIndex;
    return;
  }

  const currentIndex = selectedAgentId
    ? chatNavigationHistory.findIndex((entry) => entry.agentId === selectedAgentId)
    : -1;
  chatNavigationIndex = currentIndex >= 0 ? currentIndex : chatNavigationHistory.length - 1;
}

function recordChatNavigation(agentId, agentName = '', metadata = {}) {
  if (!agentId || metadata.skipChatNavigationHistory === true) return;

  const agent = getChatNavigationAgent(agentId);
  const resolvedName = agentName || agent?.name || metadata.agentName || metadata.name || 'Agent';
  const entry = {
    agentId,
    agentName: resolvedName,
    metadata: getChatNavigationMetadata(agent || {}, metadata)
  };

  if (chatNavigationIndex >= 0 && chatNavigationHistory[chatNavigationIndex]?.agentId === agentId) {
    chatNavigationHistory[chatNavigationIndex] = entry;
    return;
  }

  if (chatNavigationIndex < chatNavigationHistory.length - 1) {
    chatNavigationHistory = chatNavigationHistory.slice(0, chatNavigationIndex + 1);
  }

  const lastEntry = chatNavigationHistory[chatNavigationHistory.length - 1];
  if (lastEntry?.agentId === agentId) {
    chatNavigationHistory[chatNavigationHistory.length - 1] = entry;
    chatNavigationIndex = chatNavigationHistory.length - 1;
    return;
  }

  chatNavigationHistory.push(entry);
  if (chatNavigationHistory.length > CHAT_NAVIGATION_HISTORY_LIMIT) {
    chatNavigationHistory.shift();
  }
  chatNavigationIndex = chatNavigationHistory.length - 1;
}

function navigateChatHistoryBy(delta) {
  if (delta !== -1 && delta !== 1) return false;
  pruneChatNavigationHistory();

  if (chatNavigationIndex < 0 && selectedAgentId) {
    recordChatNavigation(selectedAgentId, selectedAgentName, { forceMainSelection: true });
  }

  const targetIndex = chatNavigationIndex + delta;
  if (targetIndex < 0 || targetIndex >= chatNavigationHistory.length) {
    return false;
  }

  const target = chatNavigationHistory[targetIndex];
  if (!target?.agentId || !getChatNavigationAgent(target.agentId)) {
    pruneChatNavigationHistory();
    return false;
  }

  chatNavigationIndex = targetIndex;
  pendingChatCarouselDirection = delta;
  selectAgent(target.agentId, target.agentName, {
    ...target.metadata,
    forceMainSelection: true,
    skipChatNavigationHistory: true
  });
  return true;
}

function isMobileBrowserNavigationEnabled() {
  return Boolean(
    document.body?.classList.contains('dashboard-mobile') ||
    isMobileListOnlyMode()
  );
}

function getMobileBrowserNavigationState(state = window.history?.state) {
  const navigationState = state?.[MOBILE_BROWSER_NAVIGATION_STATE_KEY];
  if (!navigationState || navigationState.version !== 1) return null;
  if (navigationState.view !== 'list' && navigationState.view !== 'chat') return null;
  return navigationState;
}

function writeMobileBrowserNavigationState(view, { agentId = '', replace = false } = {}) {
  if (
    !mobileBrowserNavigationInitialized ||
    handlingMobileBrowserNavigation ||
    !isMobileBrowserNavigationEnabled() ||
    !window.history?.pushState
  ) {
    return;
  }

  const current = getMobileBrowserNavigationState();
  const normalizedAgentId = view === 'chat' ? String(agentId || '') : '';
  if (current?.view === view && String(current.agentId || '') === normalizedAgentId) {
    return;
  }

  const nextState = {
    ...(window.history.state || {}),
    [MOBILE_BROWSER_NAVIGATION_STATE_KEY]: {
      version: 1,
      view,
      agentId: normalizedAgentId
    }
  };
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method](nextState, '', window.location.href);
}

function handleMobileBrowserNavigation(event) {
  if (!mobileBrowserNavigationInitialized || !isMobileBrowserNavigationEnabled()) return;

  const navigationState = getMobileBrowserNavigationState(event.state);
  if (!navigationState) return;

  handlingMobileBrowserNavigation = true;
  try {
    if (navigationState.view === 'list') {
      if (activeGroupId) exitGroupView();
      clearAgentListSearch({ blur: true, update: false });
      const listScroll = document.getElementById('agentListScroll');
      if (listScroll) delete listScroll.dataset.fastModeCleared;
      updateAgentListPanel(currentAgentList);
      setMobileListExpanded(true, { skipBrowserHistory: true });
      return;
    }

    const agent = getChatNavigationAgent(navigationState.agentId);
    if (!agent) {
      window.history.replaceState({
        ...(window.history.state || {}),
        [MOBILE_BROWSER_NAVIGATION_STATE_KEY]: { version: 1, view: 'list', agentId: '' }
      }, '', window.location.href);
      setMobileListExpanded(true, { skipBrowserHistory: true });
      return;
    }

    const existingIndex = chatNavigationHistory.findIndex((entry) => entry.agentId === agent.agentId);
    if (existingIndex >= 0) chatNavigationIndex = existingIndex;
    selectAgent(agent.agentId, agent.name, {
      ...getChatNavigationMetadata(agent),
      forceMainSelection: true,
      skipChatNavigationHistory: true,
      skipMobileBrowserHistory: true
    });
  } finally {
    handlingMobileBrowserNavigation = false;
  }
}

function initializeMobileBrowserNavigation() {
  if (mobileBrowserNavigationInitialized || !isMobileBrowserNavigationEnabled()) return;

  mobileBrowserNavigationInitialized = true;
  const current = getMobileBrowserNavigationState();
  if (!current) {
    window.history.replaceState({
      ...(window.history.state || {}),
      [MOBILE_BROWSER_NAVIGATION_STATE_KEY]: { version: 1, view: 'list', agentId: '' }
    }, '', window.location.href);
  }
  window.addEventListener('popstate', handleMobileBrowserNavigation);
}

/**
 * Fetch a fresh CSRF token from the server and update window.csrfToken.
 * Returns the new token string.
 */
let csrfRefreshPromise = null;
async function refreshCsrfToken() {
  if (!csrfRefreshPromise) {
    csrfRefreshPromise = (async () => {
      const res = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to refresh CSRF token');
      const data = await res.json();
      if (typeof data.csrfToken !== 'string' || !data.csrfToken) throw new Error('Failed to refresh CSRF token');
      window.csrfToken = data.csrfToken;
      return data.csrfToken;
    })().finally(() => { csrfRefreshPromise = null; });
  }
  return csrfRefreshPromise;
}

/**
 * Wrapper around fetch that auto-retries once on CSRF token errors.
 * Use this for any state-changing request that sends X-CSRF-Token.
 */
async function csrfFetch(url, options = {}) {
  const headers = typeof Headers !== 'undefined' && options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : Array.isArray(options.headers) ? Object.fromEntries(options.headers) : { ...options.headers };
  const csrfHeader = Object.keys(headers).find(name => name.toLowerCase() === 'x-csrf-token');
  const canRetry = csrfHeader && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(options.method || 'GET').toUpperCase());
  if (csrfHeader) headers[csrfHeader] = window.csrfToken || headers[csrfHeader];
  const requestOptions = { ...options, headers };
  let res = await fetch(url, requestOptions);
  if (canRetry && res.status === 403) {
    try {
      const body = await res.clone().json();
      if (['CSRF_TOKEN_MISSING', 'CSRF_TOKEN_INVALID', 'CSRF_TOKEN_EXPIRED'].includes(body?.error?.code)) {
        await refreshCsrfToken();
        // Validation rejected the mutation before it ran. Replay its original
        // body once, retaining request IDs and encrypted upload bytes.
        res = await fetch(url, { ...requestOptions, headers: { ...headers, [csrfHeader]: window.csrfToken } });
      }
    } catch (_) { /* not JSON or other error, return original response */ }
  }
  return res;
}

function isOpenClawProvider(provider) {
  return String(provider || '').toLowerCase() === 'openclaw';
}

function isOpenClawAgent(agent) {
  return isOpenClawProvider(agent?.externalProvider || agent?.external_provider || agent?.provider);
}

const PIN_CHAT_ICON_PATH = 'M12 17.5V22m0-4.5l4.2-4.2a6 6 0 10-8.4 0L12 17.5z';

function getPinChatIconSvg(className = '') {
  const classAttr = className ? ` class="${className}"` : '';
  return `<svg${classAttr} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9" d="${PIN_CHAT_ICON_PATH}" />
  </svg>`;
}

function shouldSuppressPinControlsForMobile() {
  const coarseMobileViewport = Boolean(
    window.matchMedia?.('(pointer: coarse) and (max-width: 1180px)')?.matches
  );
  return isMobileListOnlyMode() || coarseMobileViewport;
}

function pinChatToSidePanel(agentId, agentName, externalProvider = '') {
  if (shouldSuppressPinControlsForMobile()) {
    return false;
  }

  if (!agentId || !window.MultiChatManager || typeof window.MultiChatManager.openSidePanel !== 'function') {
    return false;
  }
  window.MultiChatManager.openSidePanel(agentId, agentName || 'Agent', { externalProvider });
  if (typeof window.MultiChatManager.isOpen === 'function') {
    return window.MultiChatManager.isOpen(agentId);
  }
  return true;
}

function updateMainPinButtonState() {
  const pinBtn = document.getElementById('pinToSideBtn');
  if (!pinBtn) return;

  const hasSelectedAgent = Boolean(selectedAgentId);
  const shouldHideForMobile = shouldSuppressPinControlsForMobile();
  pinBtn.classList.toggle('hidden', !hasSelectedAgent || shouldHideForMobile);

  if (!hasSelectedAgent || shouldHideForMobile) {
    pinBtn.setAttribute('aria-pressed', 'false');
    return;
  }

  const isPinned = Boolean(
    window.MultiChatManager &&
    typeof window.MultiChatManager.isOpen === 'function' &&
    window.MultiChatManager.isOpen(selectedAgentId)
  );
  const agentLabel = selectedAgentName || 'agent';
  pinBtn.classList.toggle('chat-header__pin-btn--active', isPinned);
  pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
  pinBtn.title = isPinned
    ? `${agentLabel} is pinned in side panel`
    : `Pin ${agentLabel} chat to side panel`;

  const labelEl = pinBtn.querySelector('.pin-chat-label');
  if (labelEl) {
    labelEl.textContent = isPinned ? 'Pinned' : 'Pin Chat';
  }
}

function getSideChatPickerAgents() {
  const source = Array.isArray(currentAgentList) && currentAgentList.length > 0
    ? currentAgentList
    : (Array.isArray(agentListCache?.agents) ? agentListCache.agents : []);
  return source.filter(agent => agent && agent.agentId && agent.agentId !== '__ALL__');
}

function isSideChatPickerAvailable() {
  return !shouldSuppressPinControlsForMobile() &&
    Boolean(window.MultiChatManager && typeof window.MultiChatManager.openSidePanel === 'function') &&
    getSideChatPickerAgents().length > 0;
}

function closeSideChatPicker() {
  const picker = document.getElementById('sideChatPicker');
  const addBtn = document.getElementById('sideChatAddBtn');
  if (picker) picker.classList.add('hidden');
  if (addBtn) addBtn.setAttribute('aria-expanded', 'false');
}

function syncSideChatAddButtonState() {
  const addBtn = document.getElementById('sideChatAddBtn');
  if (!addBtn) return;

  const shouldShow = isSideChatPickerAvailable();
  addBtn.classList.toggle('hidden', !shouldShow);
  addBtn.disabled = !shouldShow;
  if (!shouldShow) {
    closeSideChatPicker();
  }
}

function getSideChatPickerSubtitle(agent) {
  if (!agent) return 'Ready';
  if (agent.unreadCount > 0) return `${agent.unreadCount} unread`;
  if (agent.highestPriority === 'high') return 'Urgent';
  if (agent.isWorking) return 'Working';
  if (agent.lastMessageTime) return `Message ${formatRelativeTime(agent.lastMessageTime)}`;
  if (agent.lastActivityTime) return `Active ${formatRelativeTime(agent.lastActivityTime)}`;
  return getAgentAvailability(agent) === 'online' ? 'Online' : 'Ready';
}

function renderSideChatPickerList() {
  const list = document.getElementById('sideChatPickerList');
  const search = document.getElementById('sideChatPickerSearch');
  if (!list) return;

  const query = String(search?.value || '').trim().toLowerCase();
  const agents = getSideChatPickerAgents()
    .filter(agent => !query || String(agent.name || '').toLowerCase().includes(query))
    .sort((a, b) => {
      const aPinned = window.MultiChatManager?.isOpen?.(a.agentId) ? 1 : 0;
      const bPinned = window.MultiChatManager?.isOpen?.(b.agentId) ? 1 : 0;
      if (aPinned !== bPinned) return aPinned - bPinned;
      const aTime = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
      const bTime = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

  if (agents.length === 0) {
    list.innerHTML = `<div class="side-chat-picker__empty">${query ? 'No chats match your search' : 'No chats available'}</div>`;
    return;
  }

  list.innerHTML = agents.map((agent) => {
    const isPinned = Boolean(window.MultiChatManager?.isOpen?.(agent.agentId));
    const initials = escapeHtml(String(agent.name || 'A').slice(0, 2).toUpperCase());
    return `
      <button type="button"
        class="side-chat-picker__item"
        data-agent-id="${escapeHtml(agent.agentId)}"
        data-agent-name="${escapeHtml(agent.name || 'Agent')}"
        data-agent-external-provider="${escapeHtml(agent.externalProvider || '')}"
        role="option"
        aria-selected="${isPinned ? 'true' : 'false'}">
        <span class="side-chat-picker__avatar">${initials}</span>
        <span class="min-w-0">
          <span class="side-chat-picker__name">${escapeHtml(agent.name || 'Agent')}</span>
          <span class="side-chat-picker__meta">${escapeHtml(getSideChatPickerSubtitle(agent))}</span>
        </span>
        <span class="side-chat-picker__state">${isPinned ? 'Open' : 'Add'}</span>
      </button>
    `;
  }).join('');
}

function openSideChatPicker() {
  const picker = document.getElementById('sideChatPicker');
  const addBtn = document.getElementById('sideChatAddBtn');
  const search = document.getElementById('sideChatPickerSearch');
  if (!picker || !addBtn || !isSideChatPickerAvailable()) return;

  renderSideChatPickerList();
  picker.classList.remove('hidden');
  addBtn.setAttribute('aria-expanded', 'true');
  setTimeout(() => search?.focus(), 50);
}

function chooseSideChatFromPicker(agentId, agentName, externalProvider = '') {
  if (!agentId) return;
  const pinned = pinChatToSidePanel(agentId, agentName || 'Agent', externalProvider || '');
  closeSideChatPicker();
  updateMainPinButtonState();
  document.querySelectorAll('.agent-list-pin-btn').forEach((btn) => {
    if (btn.getAttribute('data-agent-id') === agentId) {
      btn.classList.toggle('chat-tile__pin-btn--active', pinned);
    }
  });
}

function getOpenClawIconSvg(className = 'w-7 h-7 text-orange-300') {
  return `
    <svg class="${className}" viewBox="0 0 64 64" fill="none" stroke="currentColor" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M12 38c5-7 11-10 20-10s15 3 20 10" />
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M20 28l-6-10M32 24V12M44 28l6-10" />
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M24 37l-5 13M32 39v13M40 37l5 13" />
      <circle cx="24" cy="33" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="40" cy="33" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  `;
}

let pausedAgentLoopIds = new Set();

function loadPausedAgentLoopIds() {
  try {
    const raw = localStorage.getItem(AGENT_LOOP_PAUSED_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      pausedAgentLoopIds = new Set(parsed.map(id => String(id)));
    }
  } catch (e) {
    // ignore storage failures / invalid JSON
  }
}

function persistPausedAgentLoopIds() {
  try {
    localStorage.setItem(AGENT_LOOP_PAUSED_STORAGE_KEY, JSON.stringify([...pausedAgentLoopIds]));
  } catch (e) {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function loadPromptedAgentUpdateVersions() {
  try {
    const raw = localStorage.getItem(AGENT_UPDATE_PROMPTED_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;

    promptedAgentUpdateVersions = new Map();
    Object.entries(parsed).forEach(([agentId, version]) => {
      if (agentId && typeof version === 'string' && version.trim()) {
        promptedAgentUpdateVersions.set(String(agentId), version.trim());
      }
    });
  } catch (_error) {
    promptedAgentUpdateVersions = new Map();
  }
}

function persistPromptedAgentUpdateVersions() {
  try {
    const payload = {};
    promptedAgentUpdateVersions.forEach((version, agentId) => {
      if (agentId && version) {
        payload[agentId] = version;
      }
    });
    localStorage.setItem(AGENT_UPDATE_PROMPTED_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // ignore storage failures
  }
}

function wasAgentUpdatePromptedForVersion(agentId, version) {
  if (!agentId || !version) return false;
  return promptedAgentUpdateVersions.get(String(agentId)) === String(version);
}

function markAgentUpdatePromptedForVersion(agentId, version) {
  if (!agentId || !version) return;
  promptedAgentUpdateVersions.set(String(agentId), String(version));
  persistPromptedAgentUpdateVersions();
}

function markAgentUpdatesPromptedForVersion(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return;
  let changed = false;
  agents.forEach((agent) => {
    if (!agent?.agentId || !agent?.latestCliVersion) return;
    promptedAgentUpdateVersions.set(String(agent.agentId), String(agent.latestCliVersion));
    changed = true;
  });
  if (changed) {
    persistPromptedAgentUpdateVersions();
  }
}

function isAgentLoopPausedFor(agentId) {
  if (!agentId) return false;
  return pausedAgentLoopIds.has(String(agentId));
}

function loadInteractivePanelStateByAgent() {
  // Panel open/close state is session-only (not persisted across page refreshes).
  // Default is closed; it auto-opens only when a new rich message arrives.
  interactivePanelStateByAgent.clear();
  // Clean up any previously persisted open state so it doesn't leak back in.
  try { localStorage.removeItem(INTERACTIVE_PANEL_STATE_STORAGE_KEY); } catch (_e) { /* ignore */ }
}

function persistInteractivePanelStateByAgent() {
  // Intentionally not persisted to localStorage — panel state resets to closed on page refresh.
}

function getInteractivePanelState(agentId) {
  if (!agentId) return false;
  return interactivePanelStateByAgent.get(String(agentId)) === true;
}

function setInteractivePanelState(agentId, isOpen) {
  if (!agentId) return;
  interactivePanelStateByAgent.set(String(agentId), isOpen === true);
  persistInteractivePanelStateByAgent();
}

function loadInteractiveRichMessageCounts() {
  try {
    const raw = localStorage.getItem(INTERACTIVE_RICH_COUNT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    interactiveRichMessageCountByAgent.clear();
    Object.entries(parsed).forEach(([agentId, count]) => {
      if (!agentId) return;
      const numericCount = Number(count);
      if (Number.isFinite(numericCount) && numericCount >= 0) {
        interactiveRichMessageCountByAgent.set(String(agentId), Math.floor(numericCount));
      }
    });
  } catch (_error) {
    interactiveRichMessageCountByAgent.clear();
  }
}

function persistInteractiveRichMessageCounts() {
  try {
    const payload = {};
    interactiveRichMessageCountByAgent.forEach((count, agentId) => {
      if (agentId) {
        payload[String(agentId)] = count;
      }
    });
    localStorage.setItem(INTERACTIVE_RICH_COUNT_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // ignore storage failures
  }
}

function getInteractiveRichMessageCount(agentId) {
  if (!agentId) return null;
  if (!interactiveRichMessageCountByAgent.has(String(agentId))) return null;
  return interactiveRichMessageCountByAgent.get(String(agentId));
}

function setInteractiveRichMessageCount(agentId, count) {
  if (!agentId) return;
  const normalized = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  interactiveRichMessageCountByAgent.set(String(agentId), normalized);
  persistInteractiveRichMessageCounts();
}

loadPausedAgentLoopIds();
loadPromptedAgentUpdateVersions();
loadInteractivePanelStateByAgent();
loadInteractiveRichMessageCounts();

function updateAgentLoopToggleUi() {
  const btn = document.getElementById('agentLoopToggleBtn');
  const label = document.getElementById('agentLoopToggleLabel');
  const iconPath = document.getElementById('agentLoopToggleIconPath');
  if (!btn || !label) return;

  const agentId = selectedAgentId;
  const isPaused = agentId ? isAgentLoopPausedFor(agentId) : false;
  btn.disabled = !agentId;

  if (isPaused) {
    label.textContent = 'Start Loop';
    if (iconPath) iconPath.setAttribute('d', 'M8 5v14l11-7z');
    btn.classList.remove(
      'text-slate-400',
      'border-white/10',
      'bg-white/5',
      'hover:text-rose-300',
      'hover:border-rose-400/50',
      'hover:bg-rose-400/10'
    );
    btn.classList.add(
      'text-emerald-300',
      'border-emerald-400/30',
      'bg-emerald-400/10',
      'hover:text-emerald-200',
      'hover:border-emerald-400/50'
    );
    btn.setAttribute('title', 'Start polling for this agent');
  } else {
    label.textContent = 'Stop Loop';
    if (iconPath) iconPath.setAttribute('d', 'M6 6h12v12H6z');
    btn.classList.remove(
      'text-emerald-300',
      'border-emerald-400/30',
      'bg-emerald-400/10',
      'hover:text-emerald-200',
      'hover:border-emerald-400/50'
    );
    btn.classList.add(
      'text-slate-400',
      'border-white/10',
      'bg-white/5',
      'hover:text-rose-300',
      'hover:border-rose-400/50',
      'hover:bg-rose-400/10'
    );
    btn.setAttribute('title', 'Stop polling for this agent');
  }
}

function pauseAgentLoop(agentId = selectedAgentId, { persist = true } = {}) {
  if (!agentId) return;
  pausedAgentLoopIds.add(String(agentId));
  if (persist) persistPausedAgentLoopIds();

  if (agentId === selectedAgentId) {
    stopMessagePolling();
  }

  updateAgentLoopToggleUi();
}

function resumeAgentLoop(agentId = selectedAgentId, { persist = true } = {}) {
  if (!agentId) return;
  pausedAgentLoopIds.delete(String(agentId));
  if (persist) persistPausedAgentLoopIds();

  if (agentId === selectedAgentId) {
    startMessagePolling(selectedAgentId);
  }

  updateAgentLoopToggleUi();
}

function setupAgentLoopToggleButton() {
  const btn = document.getElementById('agentLoopToggleBtn');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedAgentId) return;
    if (isAgentLoopPausedFor(selectedAgentId)) {
      resumeAgentLoop(selectedAgentId);
    } else {
      pauseAgentLoop(selectedAgentId);
    }
  });

  updateAgentLoopToggleUi();
}

function getResolvedSelectedAgentName() {
  if (selectedAgentName && selectedAgentName.trim()) return selectedAgentName;
  if (!selectedAgentId) return '';

  // Try to derive from DOM (most reliable)
  const nameEl = document.getElementById('selectedAgentName');
  const domName = nameEl?.textContent?.trim();
  if (domName) {
    selectedAgentName = domName;
    return selectedAgentName;
  }

  // Fallback to cached agent list
  const cached = (agentListCache?.agents || []).find(a => a.agentId === selectedAgentId);
  const cachedName = cached?.name || cached?.agentName || cached?.agent_name || '';
  if (cachedName) {
    selectedAgentName = cachedName;
  }
  return selectedAgentName;
}

// Size limits for spheres (in pixels)
const SPHERE_SIZE_LIMITS = {
  min: 28,  // Minimum readable size
  max: 56,  // Default/maximum size (w-14 = 56px)
  spacing: 6  // Minimum gap between spheres
};

/**
 * Calculate the optimal sphere size based on the number of agents and container size.
 * This prevents spheres from overlapping when there are many agents or the screen is small.
 * 
 * The calculation is based on the arc length between adjacent agents on the outermost ring.
 * Arc length = 2 * π * radius * (angle / 360) where angle = 360 / numAgents
 * For non-overlapping spheres: sphereDiameter + spacing <= arcLength
 * 
 * @param {number} numAgents - Total number of agents in the orbit
 * @returns {number} The optimal sphere size in pixels
 */
function calculateDynamicSphereSize(numAgents) {
  if (numAgents <= 0) {
    return SPHERE_SIZE_LIMITS.max;
  }

  // Get the orbit container element to determine its actual size
  const orbitContainer = document.querySelector('.council-orbit');
  if (!orbitContainer) {
    // Fallback to a reasonable estimate if container not found
    return calculateSphereFromCircumference(numAgents, 400);
  }

  // Use the smaller dimension to ensure spheres fit in a square container
  const containerSize = Math.min(orbitContainer.clientWidth, orbitContainer.clientHeight);

  // If container is too small or not rendered yet, use minimum size
  if (containerSize < 200) {
    return calculateSphereFromCircumference(numAgents, 300);
  }

  return calculateSphereFromCircumference(numAgents, containerSize);
}

/**
 * Calculate sphere size based on circumference and agent count
 * @param {number} numAgents - Number of agents
 * @param {number} containerSize - Container dimension in pixels
 * @returns {number} Optimal sphere size in pixels
 */
function calculateSphereFromCircumference(numAgents, containerSize) {
  // Use the outermost ring (idle) radius as reference (46% of container)
  const outerRingRadiusPercent = ORBIT_CONFIG.ringRadii.idle;
  const outerRingRadius = (containerSize / 2) * (outerRingRadiusPercent / 50);

  // Calculate the circumference of the outermost ring
  const circumference = 2 * Math.PI * outerRingRadius;

  // Calculate the arc length per agent
  const arcPerAgent = circumference / numAgents;

  // The sphere diameter should be less than the arc length minus spacing
  // Allow spheres to use up to 85% of available arc space for a balanced look
  const maxSphereSize = (arcPerAgent - SPHERE_SIZE_LIMITS.spacing) * 0.85;

  // Clamp between min and max sizes
  return Math.round(
    Math.max(SPHERE_SIZE_LIMITS.min, Math.min(SPHERE_SIZE_LIMITS.max, maxSphereSize))
  );
}

// Keep the orbital positions at every panel size. Fit spheres to the nearest
// actual seat, including squashed/inner rings and the footprint of group dots.
function calculateCouncilFit(points, width, height, hasGroups = false) {
  const orbitSize = Math.max(0, Math.floor(Math.min(width - 64, height - 72)));
  const centerSize = Math.min(64, orbitSize * 0.2);
  const footprint = hasGroups ? 1.6 : 1.3;
  let sphereSize = Math.min(SPHERE_SIZE_LIMITS.max, orbitSize / 4);
  const centers = points.map(point => ({
    x: (point.x - 50) * orbitSize / 100,
    y: (point.y - 50) * orbitSize / 100
  }));
  centers.forEach((point, index) => {
    sphereSize = Math.min(sphereSize,
      Math.max(0, Math.hypot(point.x, point.y) - centerSize * 0.65) * 2 / footprint);
    for (let other = 0; other < index; other++) {
      const distance = Math.hypot(point.x - centers[other].x, point.y - centers[other].y);
      sphereSize = Math.min(sphereSize, distance * 0.85 / footprint);
    }
  });
  // Fractional sizes let crowded councils keep their rings instead of switching
  // layouts or forcing a minimum sphere size that overlaps neighbouring seats.
  sphereSize = Math.max(0, Math.floor(sphereSize * 100) / 100);
  return { orbitSize, centerSize, sphereSize,
    compact: sphereSize < SPHERE_SIZE_LIMITS.min || orbitSize < 240,
    dense: sphereSize < 14 };
}

// Small chambers lean the orbit back a little as the spheres shrink. The
// divider tilt still wins when it is stronger.
const COUNCIL_SIZE_TILT = { start: 420, full: 220, squash: 0.82 };
function calculateCouncilTilt(width, height) {
  const orbitSize = Math.min(width - 64, height - 72);
  const progress = (COUNCIL_SIZE_TILT.start - orbitSize) / (COUNCIL_SIZE_TILT.start - COUNCIL_SIZE_TILT.full);
  return 1 - Math.min(1, Math.max(0, progress)) * (1 - COUNCIL_SIZE_TILT.squash);
}

function refreshCouncilFit() {
  if (orbitDragState) return;
  const circle = document.getElementById('councilCircle');
  const orbit = circle?.querySelector('.council-orbit');
  const container = document.getElementById('agentSeats');
  if (!orbit || !container || !circle.clientWidth || !circle.clientHeight) return;
  const dividerSquash = Number.parseFloat(getComputedStyle(circle.parentElement || circle).getPropertyValue('--council-orbit-squash'));
  const squash = Math.min(Number.isFinite(dividerSquash) && dividerSquash > 0 ? dividerSquash : 1,
    calculateCouncilTilt(circle.clientWidth, circle.clientHeight));
  circle.style.setProperty('--council-orbit-squash', squash.toFixed(3));
  const seats = [...container.querySelectorAll('.agent-seat, .group-seat')];
  const points = seats.map(seat => {
    const angle = Number(seat.dataset.councilAngle);
    const radius = Number(seat.dataset.councilRadius);
    const point = seat.hasAttribute('data-council-angle')
      ? projectOrbitPoint(angle, radius, squash)
      : { x: parseFloat(seat.style.left), y: parseFloat(seat.style.top) };
    seat.style.left = `${point.x}%`;
    seat.style.top = `${point.y}%`;
    return point;
  });
  const fit = calculateCouncilFit(points, circle.clientWidth, circle.clientHeight,
    seats.some(seat => seat.classList.contains('group-seat')));
  circle.classList.add('council-responsive');
  circle.classList.toggle('council-compact', fit.compact);
  circle.classList.toggle('council-dense', fit.dense);
  orbit.style.setProperty('--council-fitted-orbit-size', `${fit.orbitSize}px`);
  orbit.style.setProperty('--council-sphere-size', `${fit.sphereSize}px`);
  orbit.style.setProperty('--council-initial-size', `${fit.sphereSize * 0.32}px`);
  orbit.style.setProperty('--council-center-size', `${fit.centerSize}px`);
  orbit.style.setProperty('--council-group-scale', String(fit.sphereSize / 48));
  for (const seat of seats) {
    // Keep every seat available by keyboard, with its full name on focus/hover.
    seat.tabIndex = 0;
    seat.setAttribute('role', 'button');
    const name = seat.dataset.agentName || seat.dataset.groupName || 'Agent';
    seat.setAttribute('aria-label', name);
    seat.title = name;
    if (seat.dataset.agentId) seat.style.order = String(currentOrbitLayout?.order?.indexOf(seat.dataset.agentId) ?? 0);
    else seat.style.order = String(seats.length);
    if (!seat.dataset.councilKeyboardBound) {
      seat.dataset.councilKeyboardBound = 'true';
      seat.addEventListener('keydown', event => {
        if (event.target !== seat || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        seat.click();
      });
    }
  }
  window.dispatchEvent(new Event('council:layout'));
}

function setupResponsiveCouncil() {
  const circle = document.getElementById('councilCircle');
  if (!circle) return;
  let frame = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; refreshCouncilFit(); });
  };
  // Divider drags change the panel without firing a window resize event.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(schedule);
    observer.observe(circle);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    window.addEventListener('pageshow', () => { observer.observe(circle); schedule(); });
  }
  window.addEventListener('resize', schedule);
  refreshCouncilFit();
}

const ORBIT_DRAG_THRESHOLD = 6;
const MARKDOWN_RENDER_OPTIONS = {
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
  smartypants: true
};

if (typeof marked !== 'undefined') {
  marked.setOptions(MARKDOWN_RENDER_OPTIONS);
}

// Keep keyboard sizing separate from the browser's full-height, closed-keyboard layout.
function initializeMobileViewport() {
  if (window.visualViewport) {
    const isTextInputFocused = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const adjustMobileViewport = () => {
      // Let CSS track browser chrome when the keyboard is closed. A stale
      // visualViewport measurement during blur must not leave a short app shell.
      // Pinch zoom also must not resize the layout to the magnified viewport.
      const focused = isTextInputFocused();
      const viewport = window.visualViewport;
      const height = focused && viewport.scale === 1 ? `${viewport.height}px` : '100dvh';
      document.documentElement.style.setProperty('--vh', height);
      document.documentElement.style.setProperty('--mobile-visual-bottom-offset', '0px');
      const dashRoot = document.getElementById('dashboardRoot');
      if (dashRoot && window.matchMedia('(max-width: 1023px)').matches) {
        const shouldPreserveScroll = isTextInputFocused();
        ensureMobileComposerVisible();
        if (shouldPreserveScroll) {
          setMobileChromeCollapsed(false);
          preserveMobileConversationScroll();
        }
      }
    };
    window.visualViewport.addEventListener('resize', adjustMobileViewport);
    window.visualViewport.addEventListener('scroll', adjustMobileViewport);
    window.addEventListener('resize', adjustMobileViewport);
    window.addEventListener('pageshow', adjustMobileViewport);
    // Re-evaluate on focus changes so the composer snaps back to bottom: 0 when keyboard closes
    document.addEventListener('focusin', adjustMobileViewport);
    document.addEventListener('focusout', () => {
      // focusout fires before activeElement updates; defer one tick
      setTimeout(adjustMobileViewport, 0);
    });
    adjustMobileViewport();
  }
}

/**
 * Initialize dashboard when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', async () => {
  applyDashboardMobileModeClasses();
  initializeMobileBrowserNavigation();

  // Prevent browser swipe-back/forward navigation gesture (e.g. two-finger horizontal swipe
  // on trackpad or edge-swipe on touch devices that triggers browser history navigation).
  // This stops accidental logouts caused by swiping back to the login page.
  {
    let swipePreventStartX = 0;
    let swipePreventStartY = 0;
    document.addEventListener('touchstart', (e) => {
      swipePreventStartX = e.touches[0].clientX;
      swipePreventStartY = e.touches[0].clientY;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - swipePreventStartX;
      const dy = Math.abs(e.touches[0].clientY - swipePreventStartY);
      // Block horizontal swipes starting near the left edge (browser back gesture zone)
      if (swipePreventStartX < 30 && dx > 10 && dy < 30) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  initializeMobileViewport();

  // Mobile: keep chrome stable while scrolling. Scroll-driven collapsing caused
  // missing controls and jumpy layout in mobile browsers.
  if (window.matchMedia('(max-width: 1023px)').matches) {
    const convArea = document.getElementById('conversationArea');
    let bottomRevealTouchStartY = null;
    let bottomRevealTriggered = false;
    let bottomFocusRequested = false;
    let bottomFocusEligible = false;
    if (convArea) {
      convArea.addEventListener('scroll', () => {
        const currentY = convArea.scrollTop;
        const nearBottom = (convArea.scrollHeight - convArea.clientHeight - currentY) < 100;
        setMobileChromeCollapsed(false);
        ensureMobileComposerVisible({ restoreChrome: true });
        if (nearBottom) {
          ensureMobileComposerVisible({ restoreChrome: true });
        }
      }, { passive: true });

      convArea.addEventListener('wheel', (event) => {
        if (event.deltaY > 10) {
          revealMobileComposerFromConversationEdge(convArea);
        }
      }, { passive: true });

      convArea.addEventListener('touchstart', (event) => {
        bottomRevealTouchStartY = event.touches[0]?.clientY ?? null;
        bottomRevealTriggered = false;
        bottomFocusRequested = false;
        bottomFocusEligible = (convArea.scrollHeight - convArea.clientHeight - convArea.scrollTop) <= 32;
      }, { passive: true });

      convArea.addEventListener('touchmove', (event) => {
        if (bottomRevealTouchStartY === null) {
          return;
        }
        const currentTouchY = event.touches[0]?.clientY;
        if (typeof currentTouchY !== 'number') {
          return;
        }
        const upwardDragDistance = bottomRevealTouchStartY - currentTouchY;
        if (!bottomRevealTriggered && upwardDragDistance > 18 && revealMobileComposerFromConversationEdge(convArea)) {
          bottomRevealTriggered = true;
        }
        if (bottomFocusEligible && bottomRevealTriggered && upwardDragDistance > 28) {
          bottomFocusRequested = true;
          ensureMobileComposerVisible({ restoreChrome: true });
        }
      }, { passive: true });

      convArea.addEventListener('touchend', (event) => {
        if (bottomFocusRequested) {
          event.preventDefault();
          focusMobileComposerFromBottomOverscroll(convArea, {
            requireBottomEdge: false,
            respectCooldown: false
          });
        }
        bottomRevealTouchStartY = null;
        bottomRevealTriggered = false;
        bottomFocusRequested = false;
        bottomFocusEligible = false;
      }, { passive: false });
    }
  }

  // Scroll-to-bottom button: show when user scrolls up, hide at bottom
  (function setupScrollToBottomBtn() {
    const convArea = document.getElementById('conversationArea');
    const btn = document.getElementById('scrollToBottomBtn');
    if (!convArea || !btn) return;

    function updateScrollBtn() {
      const distFromBottom = convArea.scrollHeight - convArea.clientHeight - convArea.scrollTop;
      const shouldShow = selectedAgentId && selectedAgentId !== '__ALL__' && !convArea.classList.contains('hidden') && distFromBottom > 120;
      if (shouldShow) {
        btn.classList.remove('hidden');
      } else {
        btn.classList.add('hidden');
      }
    }

    window.updateScrollToBottomButton = updateScrollBtn;

    convArea.addEventListener('scroll', updateScrollBtn, { passive: true });

    // A send briefly pins a chat that was already at the bottom while its
    // refreshed history settles. If the reader starts scrolling in that
    // window, drop the pin immediately so a later render cannot pull them
    // back to the newest message.
    const releaseSendScrollPin = () => {
      if (!pendingSendScrollGuard && Date.now() >= forceScrollToBottomUntil) return;
      pendingSendScrollGuard = null;
      forceScrollToBottomOnNextRender = false;
      forceScrollToBottomUntil = 0;
    };
    convArea.addEventListener('wheel', releaseSendScrollPin, { passive: true });
    convArea.addEventListener('touchmove', releaseSendScrollPin, { passive: true });
    convArea.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) releaseSendScrollPin();
    });

    convArea.addEventListener('scroll', () => {
      if (convArea.scrollTop > 300) return;
      if (!selectedAgentId || selectedAgentId === '__ALL__') return;
      if (selectedChatContext?.mode === 'shared') return;
      if (conversationHasMore.get(selectedAgentId) !== true || isLoadingOlderMessages) return;
      if (Date.now() < forceScrollToBottomUntil) return;
      loadOlderMessagesInBackground(selectedAgentId, null);
    }, { passive: true });

    const focusComposerFromScrollControl = () => {
      if (!isMobileListOnlyMode()) return;
      focusMobileComposerFromBottomOverscroll(convArea, {
        requireBottomEdge: false,
        respectCooldown: false
      });
    };

    btn.addEventListener('pointerdown', focusComposerFromScrollControl, { passive: true });
    btn.addEventListener('touchend', focusComposerFromScrollControl, { passive: true });

    btn.addEventListener('click', () => {
      if (selectedAgentId) {
        agentScrollPositions.delete(selectedAgentId);
        forceScrollToBottomOnNextRender = true;
        forceScrollToBottomUntil = Date.now() + 2500;
      }
      focusComposerFromScrollControl();
      scrollToBottom({ smooth: false, force: true, source: 'scroll-button' });
      setTimeout(updateScrollBtn, 250);
      setTimeout(updateScrollBtn, 700);
    });

    // Update when content changes (new messages)
    const observer = new MutationObserver(updateScrollBtn);
    observer.observe(convArea, { childList: true, subtree: false });
    requestAnimationFrame(updateScrollBtn);
  })();

  // Mobile failsafe: MutationObserver prevents the input from ever staying hidden
  // while an agent is selected. Some layout reflows or race conditions can re-add
  // the 'hidden' class; this observer immediately removes it.
  if (window.matchMedia('(max-width: 1023px)').matches) {
    const inputEl = document.getElementById('messageInputArea');
    if (inputEl) {
      const inputObserver = new MutationObserver(() => {
        ensureMobileComposerVisible();
      });
      inputObserver.observe(inputEl, { attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('pageshow', () => ensureMobileComposerVisible());
    window.addEventListener('resize', () => ensureMobileComposerVisible());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        ensureMobileComposerVisible();
      }
    });
    document.addEventListener('touchend', () => ensureMobileComposerVisible(), { passive: true });
  }

  // On narrow/mobile view, the orbit/dock is hidden and list is the primary navigation.
  if (isMobileListOnlyMode()) {
    currentFocusArea = 'list';
    bindMobileListToggleControls();
    // Add mobile hint label to the agent list toggle button
    const collapseBtn = document.getElementById('collapseMobileListBtn');
    if (collapseBtn) {
      collapseBtn.setAttribute('data-mobile-label', 'Agents');
    }
    // Auto-expand the chat list when no agent is selected so the user
    // always sees the list on first load (mirrors initializeMobileDock logic).
    const hasSelectedAgent =
      Boolean(selectedAgentId) ||
      Boolean(document.querySelector('.agent-list-item--selected[data-agent-id]:not([data-agent-id=""])'));
    if (!hasSelectedAgent) {
      setMobileListExpanded(true);
    }
    // Close agent list overlay when tapping the conversation area
    const convArea = document.getElementById('conversationArea');
    if (convArea) {
      convArea.addEventListener('touchstart', () => {
        const panel = document.getElementById('agentListPanel');
        if (panel && panel.classList.contains('mobile-expanded')) {
          setMobileListExpanded(false);
        }
      }, { passive: true });
    }
  }

  // Mobile swipe gesture to navigate between chats (left/right swipe on conversation area)
  if (window.matchMedia('(max-width: 1023px)').matches) {
    const convArea = document.getElementById('conversationArea');
    if (convArea) {
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swiping = false;
      convArea.addEventListener('touchstart', (e) => {
        swipeStartX = e.touches[0].clientX;
        swipeStartY = e.touches[0].clientY;
        swiping = true;
      }, { passive: true });
      convArea.addEventListener('touchend', (e) => {
        if (!swiping) return;
        swiping = false;
        const swipeEndX = e.changedTouches[0].clientX;
        const swipeEndY = e.changedTouches[0].clientY;
        const dx = swipeEndX - swipeStartX;
        const dy = Math.abs(swipeEndY - swipeStartY);
        const swipeThreshold = 80; // Minimum swipe distance
        // Only trigger on horizontal swipe (dx > dy means horizontal)
        if (Math.abs(dx) > swipeThreshold && dy < 50) {
          if (dx > 0) {
            // Swipe right = previous chat in this session's chat history.
            navigateChatHistoryBy(-1);
          } else {
            // Swipe left = next chat only after the user has gone back.
            navigateChatHistoryBy(1);
          }
        }
      }, { passive: true });
    }
  }

  // Pre-populate knownAgentIds from already rendered agents to prevent animation on page load
  const existingAgentSeats = document.querySelectorAll('.agent-seat[data-agent-id]');
  existingAgentSeats.forEach(seat => {
    const agentId = seat.getAttribute('data-agent-id');
    if (agentId) {
      knownAgentIds.add(agentId);
    }
  });

  // Check for encryption key
  await checkEncryptionKey();

  // Prepare high-quality voice notifications
  initializeVoiceNotifications();

  // Unlock audio on first user interaction to reduce autoplay blocks
  setupAudioUnlock();

  // Setup council minimize toggle (desktop only)
  setupCouncilMinimize();
  setupCouncilResizeHandle();
  setupCouncilListResizeHandle();

  // Setup loop toggle UI early (so it reflects persisted state)
  setupAgentLoopToggleButton();
  setupAgentCliUpdateModal();

  // Start polling agent list
  startAgentPolling();

  // Attempt to restore last opened agent after a short delay to ensure agent list is loaded
  setupLastAgentRestoration();

  // Set up agent selection handlers
  setupAgentSelectionHandlers();
  bindAgentListSearch();
  setupAgentListHandlers();

  // Setup drag-to-reposition for orbital seats (desktop/wide view only)
  if (!isMobileListOnlyMode()) {
    setupOrbitDragHandlers();
  }

  // Setup drag-to-pin for sidebar agent list items
  setupSidebarDragHandlers();

  // Prepare the free-text composer
  setupMessageComposer();
  dashboardComposerReady = true;
  signalDashboardReadyWhenInitialized();
  setupMobileFastModeToggle();

  // Setup agent control buttons (stop, config)
  setupAgentControls();

  // Setup main chat "Pin Chat" button
  setupMainPinButton();
  setupSideChatAddPicker();

  // Setup keyboard navigation
  setupKeyboardNavigation();

  // Setup voice control
  setupVoiceControl();

  // Setup decryption modal button
  setupDecryptionModalButton();

  // Setup copy buttons
  setupCopyButtons();

  // Setup archive buttons
  setupArchiveButtons();

  // Setup group UI handlers (FAB, modal, back button)
  setupGroupUIHandlers();

  // Setup delete confirmation modal
  setupDeleteConfirmationModal();

  // Setup clear conversation modal
  setupClearConversationModal();

  // Setup hide messages modal
  setupHideMessagesModal();

  // Setup run-command inspection modal
  setupRunCommandModal();

  // Setup interactive space
  setupMainInteractiveSpace();

  // Setup TTS keyboard shortcuts
  setupMessageTtsShortcuts();

  // Initialize mobile dock / list controls.
  if (!isMobileListOnlyMode()) {
    initializeMobileDock();
  } else {
    bindMobileListToggleControls();
  }

  // Initialize feedback widget
  // Feedback widget initialized by feedback.js


  // Ensure mobile list controls stay bound even if layout mode changes.
  bindMobileListToggleControls();
  bindMobileOverflowActionControls();
  setupMobileFastModeToggle();

  // Stop polling when user navigates away
  window.addEventListener('beforeunload', () => {
    stopAgentPolling();
    stopMessagePolling();
  });

  setupResponsiveCouncil();

  // Re-render agents on window resize to recalculate sphere sizes
  let resizeTimeout = null;
  window.addEventListener('resize', () => {
    // Debounce resize handler
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      if (currentAgentList.length > 0) {
        applyDashboardMobileModeClasses();
        updateAgentListUI(currentAgentList);
      }
      setupMobileFastModeToggle();
    }, 150);
  });
});

/**
 * Start polling agent list with server-directed adaptive backoff.
 */
function startAgentPolling() {
  // Ensure we don't create duplicate intervals
  stopAgentPolling();
  resetAgentPollCadence();

  // Poll immediately
  scheduleAgentPoll(0);
}

function scheduleAgentPoll(delayMs = agentPollNextDelayMs) {
  stopAgentPolling();
  agentPollingInterval = setTimeout(async () => {
    if (agentPollInFlight) {
      scheduleAgentPoll(agentPollNextDelayMs);
      return;
    }
    agentPollInFlight = true;
    try {
      await pollAgentList();
    } finally {
      agentPollInFlight = false;
      scheduleAgentPoll(agentPollNextDelayMs);
    }
  }, Math.max(0, delayMs));
}

/**
 * Stop polling agent list
 */
function stopAgentPolling() {
  if (agentPollingInterval) {
    clearTimeout(agentPollingInterval);
    agentPollingInterval = null;
  }
}

/**
 * Poll agent list from API and update UI
 * @param {boolean} force - Force fetch from server, bypassing cache
 */
// The open private chat is being read (loadMessages/pollMessages mark its
// messages read server-side), so its unread count must not linger from a
// cached or in-flight agent-list response.
function clearOpenChatUnread(agents) {
  if (!selectedAgentId || selectedChatContext?.mode === 'shared' || !Array.isArray(agents)) return false;
  let changed = false;
  for (const agent of agents) {
    if (agent.agentId === selectedAgentId && agent.unreadCount > 0) {
      agent.unreadCount = 0;
      changed = true;
    }
  }
  return changed;
}

async function pollAgentList(force = false) {
  try {
    // Check if cache is still valid (unless force refresh)
    const now = Date.now();
    if (!force && agentListCache.agents.length > 0 && (now - agentListCache.timestamp) < getAgentPollCacheTtl()) {
      // Use cached data
      updateAgentListUI(agentListCache.agents);
      return;
    }

    const positionRevision = orbitPositionRevision;
    const positionsWerePending = pendingOrbitPositions.size > 0;
    const response = await fetch('/api/user/agents');
    let data = null;

    if (!response.ok) {
      console.error('Failed to fetch agents:', response.status);
      agentPollNextDelayMs = getServerPollDelayMs(response, null, agentPollNextDelayMs * 2);
      return;
    }

    data = await response.json();
    const agents = data.agents || [];
    clearOpenChatUnread(agents);
    if (window.AgentBriefUI) window.AgentBriefUI.agents = agents;
    const localPositions = new Map(currentAgentList.map(agent => [agent.agentId, agent.position]));
    for (const agent of agents) {
      const pending = pendingOrbitPositions.get(agent.agentId);
      if (pending) agent.position = pending.position;
      else if ((positionsWerePending || positionRevision !== orbitPositionRevision) && localPositions.has(agent.agentId)) agent.position = localPositions.get(agent.agentId);
    }
    agentPollNextDelayMs = getServerPollDelayMs(response, data, agents.length ? DASHBOARD_MIN_POLL_INTERVAL_MS : agentPollNextDelayMs);
    const isInitialLoad = !initialAgentLoadComplete;

    // Update group data from poll response
    if (Array.isArray(data.groups)) {
      currentGroups = data.groups;
      cachedGroupPartition = null; // invalidate cache
    }

    // Detect newly added agents FIRST (before handling message notifications)
    const currentAgentIds = new Set(agents.map(a => a.agentId));
    const detectedNewAgents = [];
    const newAgentIdsSet = new Set();

    currentAgentIds.forEach(id => {
      if (!knownAgentIds.has(id)) {
        detectedNewAgents.push(agents.find(a => a.agentId === id));
        newAgentIds.add(id);
        newAgentIdsSet.add(id);
      }
    });

    // Handle message notifications, but exclude new agents (they get their own "joined council" notification)
    handleAgentMessageNotifications(agents, isInitialLoad, newAgentIdsSet);

    // Show decryption password modal when first agent is added (and no key is stored)
    if (knownAgentIds.size === 0 && agents.length > 0 && !encryptionKey) {
      console.log('First agent detected. Checking if decryption password modal is needed...');
      triggerFirstAgentEncryptionPrompt();
    }

    if (knownAgentIds.size === 0 && agents.length > 0) {
      triggerFirstAgentVoicePrompt();
    }

    // Play voice notification for new agents (only after initial load)
    if (initialAgentLoadComplete && detectedNewAgents.length > 0) {
      detectedNewAgents.forEach(agent => {
        playNewAgentNotification(agent);
      });
    }

    // Mark initial load as complete after first successful poll
    if (!initialAgentLoadComplete) {
      initialAgentLoadComplete = true;
    }

    // Update known agent IDs
    knownAgentIds = currentAgentIds;

    // Update cache
    agentListCache.agents = agents;
    agentListCache.timestamp = now;

    updateAgentListUI(agents);
    scheduleConversationPreload(agents);
    await maybePromptForAgentCliUpdate(agents);

    // Clear new agent IDs after animation completes (keep them for 2 seconds)
    if (detectedNewAgents.length > 0) {
      setTimeout(() => {
        detectedNewAgents.forEach(agent => {
          newAgentIds.delete(agent.agentId);
        });
        // Re-render to remove animation classes
        updateAgentListUI(agentListCache.agents);
      }, 2000);
    }

  } catch (error) {
    console.error('Error polling agent list:', error);
  }
}

window.addEventListener('agentbriefsaved', () => pollAgentList(true));

async function queueAgentCliSelfUpdate(agent, options = {}) {
  const {
    silentSuccess = false,
    silentWarning = false,
    silentError = false
  } = options;
  const agentId = agent?.agentId;
  const agentName = agent?.name || 'Agent';
  if (!agentId) return { success: false, error: 'Missing agent id' };
  if (agentUpdateQueueInFlight.has(agentId)) {
    return { success: false, skipped: true, error: 'Update already in progress' };
  }
  agentUpdateQueueInFlight.add(agentId);

  try {
    await checkEncryptionKey();
    if (!encryptionKey || !window.E2EEncryption?.encryptMessage) {
      if (!silentError) {
        showErrorMessage(`Cannot queue update for ${agentName} without an encryption key. Set your password and try again.`);
      }
      if (typeof showDecryptionPasswordModal === 'function') {
        showDecryptionPasswordModal();
      }
      return { success: false, error: 'Encryption key unavailable' };
    }

    const prepareResponse = await csrfFetch(`/api/user/agents/${encodeURIComponent(agentId)}/prepare-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({ instructionsOnly: false })
    });

    if (!prepareResponse.ok) {
      let message = `Failed to prepare update (${prepareResponse.status})`;
      try {
        const errData = await prepareResponse.json();
        message = errData?.error?.message || message;
      } catch (_error) {
        // keep fallback message
      }
      throw new Error(message);
    }

    const manifestResponse = await prepareResponse.json();
    const manifest = {
      version: manifestResponse.version,
      files: manifestResponse.files || {},
      instructionsOnly: manifestResponse.instructionsOnly === true
    };

    const encryptedPayload = await window.E2EEncryption.encryptMessage(
      JSON.stringify(manifest),
      encryptionKey
    );

    const sendResponse = await csrfFetch(`/api/user/agents/${encodeURIComponent(agentId)}/send-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        encryptedPayload,
        version: manifest.version
      })
    });

    if (!sendResponse.ok) {
      let message = `Failed to queue update (${sendResponse.status})`;
      try {
        const errData = await sendResponse.json();
        message = errData?.error?.message || message;
      } catch (_error) {
        // keep fallback message
      }
      throw new Error(message);
    }

    // Send the confirmation from the browser (which owns the encryption key).
    const confirmationResult = await sendAgentUpdateConfirmation(agentId, {
      silentSuccess: true,
      reloadSelectedConversation: false
    });

    if (confirmationResult?.success) {
      if (!silentSuccess) {
        showSuccessMessage(`Queued and confirmed self-update for ${agentName}. It will apply on the next agent poll.`);
      }
      return { success: true, agentId, agentName, version: manifest.version };
    } else {
      if (!silentWarning) {
        showWarningMessage(
          `Queued self-update for ${agentName}, but auto-confirm failed. Open the chat and click "Confirm Update".`
        );
      }
      return {
        success: false,
        queued: true,
        agentId,
        agentName,
        version: manifest.version,
        error: confirmationResult?.error || 'Auto-confirm failed'
      };
    }
  } catch (error) {
    console.error('Failed to queue agent self-update:', error);
    if (!silentError) {
      showErrorMessage(error.message || `Failed to queue update for ${agentName}.`);
    }
    return { success: false, agentId, agentName, error: error.message || `Failed to queue update for ${agentName}.` };
  } finally {
    agentUpdateQueueInFlight.delete(agentId);
  }
}

async function queueAgentCliSelfUpdates(agents) {
  const selectedAgents = Array.isArray(agents) ? agents.filter(agent => agent?.agentId) : [];
  if (selectedAgents.length === 0) return;

  await checkEncryptionKey();
  if (!encryptionKey || !window.E2EEncryption?.encryptMessage) {
    showErrorMessage('Set your encryption password before queueing agent updates.');
    if (typeof showDecryptionPasswordModal === 'function') {
      showDecryptionPasswordModal();
    }
    return;
  }

  const plural = selectedAgents.length === 1 ? '' : 's';
  if (typeof window.showNotification === 'function') {
    window.showNotification(
      `Queueing updates for ${selectedAgents.length} selected agent${plural}.`,
      'info',
      'Agent Updates',
      3000
    );
  }

  const results = [];
  for (const agent of selectedAgents) {
    // Run sequentially so encryption, queueing, and confirmation failures are easy to report.
    results.push(await queueAgentCliSelfUpdate(agent, {
      silentSuccess: true,
      silentWarning: true,
      silentError: true
    }));
  }

  const confirmedCount = results.filter(result => result?.success).length;
  const queuedNeedsManualCount = results.filter(result => result?.queued && !result?.success).length;
  const failedCount = results.length - confirmedCount - queuedNeedsManualCount;

  if (confirmedCount === selectedAgents.length) {
    showSuccessMessage(`Queued and confirmed updates for ${confirmedCount} agent${confirmedCount === 1 ? '' : 's'}.`);
    return;
  }

  if (confirmedCount > 0 || queuedNeedsManualCount > 0) {
    showWarningMessage(
      `Queued ${confirmedCount + queuedNeedsManualCount} update${confirmedCount + queuedNeedsManualCount === 1 ? '' : 's'}; ` +
      `${queuedNeedsManualCount} need manual confirmation and ${failedCount} failed.`
    );
    return;
  }

  showErrorMessage(`Failed to queue updates for ${failedCount} selected agent${failedCount === 1 ? '' : 's'}.`);
}

async function maybePromptForAgentCliUpdate(agents) {
  if (agentUpdatePromptActive) return;
  if (!Array.isArray(agents) || agents.length === 0) return;

  const candidates = agents.filter((agent) => {
    if (!agent?.agentId) return false;
    if (agent.needsCliUpdate !== true) return false;
    if (!agent.latestCliVersion) return false;
    return !wasAgentUpdatePromptedForVersion(agent.agentId, agent.latestCliVersion);
  });

  if (candidates.length === 0) return;
  agentUpdatePromptActive = true;

  try {
    // Prompt only once per target version, even if user declines.
    markAgentUpdatesPromptedForVersion(candidates);

    if (showAgentCliUpdateBatchDialog(candidates)) {
      return;
    }

    const latestVersion = candidates[0]?.latestCliVersion || 'latest';
    const confirmed = window.confirm(
      `${candidates.length} agent${candidates.length === 1 ? '' : 's'} can update to agent-cli ${latestVersion}.\n\n` +
      'Send updates to all of them now?'
    );
    if (confirmed) {
      await queueAgentCliSelfUpdates(candidates);
    }
  } finally {
    agentUpdatePromptActive = false;
  }
}

function showAgentCliUpdateBatchDialog(agents) {
  const modal = document.getElementById('agentCliUpdateModal');
  const list = document.getElementById('agentCliUpdateList');
  const summary = document.getElementById('agentCliUpdateSummary');
  const selectAll = document.getElementById('agentCliUpdateSelectAll');
  const selectedCount = document.getElementById('agentCliUpdateSelectedCount');
  const updateBtn = document.getElementById('agentCliUpdateConfirmBtn');

  if (!modal || !list || !summary || !selectAll || !selectedCount || !updateBtn) {
    return false;
  }

  pendingAgentUpdateBatch = agents
    .filter(agent => agent?.agentId && agent.needsCliUpdate === true && agent.latestCliVersion)
    .map(agent => ({ agent, active: isAgentActive(agent) }))
    .sort((a, b) => Number(b.active) - Number(a.active) ||
      (a.agent.name || '').localeCompare(b.agent.name || ''))
    .map(({ agent }) => agent);
  if (pendingAgentUpdateBatch.length === 0) return false;

  const latestVersions = new Set(pendingAgentUpdateBatch.map(agent => agent.latestCliVersion).filter(Boolean));
  const latestLabel = latestVersions.size === 1 ? [...latestVersions][0] : 'the latest available version';
  summary.textContent =
    `${pendingAgentUpdateBatch.length} agent${pendingAgentUpdateBatch.length === 1 ? '' : 's'} can update to ${latestLabel}. ` +
    'Active agents are listed first. Only checked agents will be updated.';

  list.innerHTML = pendingAgentUpdateBatch.map((agent) => {
    const currentVersion = agent.reportedCliVersion || 'unknown';
    const latestVersion = agent.latestCliVersion || 'latest';
    return `
      <label class="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-left hover:border-cyan-500/50 hover:bg-slate-800 transition">
        <input type="checkbox"
               class="agent-cli-update-checkbox mt-1 rounded border-slate-600 bg-slate-900 text-cyan-500 focus:ring-cyan-500/50"
               value="${escapeHtml(agent.agentId)}">
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold text-slate-100">${escapeHtml(agent.name || 'Agent')}</span>
          <span class="block text-xs text-slate-400">${isAgentActive(agent) ? 'Active' : 'Inactive'} · agent-cli ${escapeHtml(currentVersion)} -> ${escapeHtml(latestVersion)}</span>
        </span>
      </label>
    `;
  }).join('');

  selectAll.checked = false;
  modal.classList.remove('hidden');
  updateAgentCliUpdateModalSelectionState();
  return true;
}

function updateAgentCliMenuButton(buttonId, agentId) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const agent = findCachedAgentRecord(agentId);
  const available = agent?.needsCliUpdate === true && Boolean(agent.latestCliVersion);
  button.classList.toggle('hidden', !available);
  button.hidden = !available;
  button.title = available ? `Update agent-cli to ${agent.latestCliVersion}` : '';
}

function setupAgentCliMenuButtons() {
  for (const buttonId of ['updateAgentBtn', 'floatingUpdateAgentBtn']) {
    document.getElementById(buttonId)?.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = buttonId === 'floatingUpdateAgentBtn'
        ? document.getElementById('floatingAgentMenu')?.dataset.agentId
        : selectedAgentId;
      const agent = findCachedAgentRecord(agentId);
      document.getElementById('agentContextMenu')?.classList.add('hidden');
      hideFloatingAgentMenu();
      if (agent?.needsCliUpdate === true && agent.latestCliVersion) {
        showAgentCliUpdateBatchDialog([agent]);
      } else {
        showErrorMessage('This agent has no available update.');
      }
    });
  }
}

function hideAgentCliUpdateBatchDialog() {
  const modal = document.getElementById('agentCliUpdateModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  pendingAgentUpdateBatch = [];
}

function getSelectedAgentCliUpdateAgents() {
  const list = document.getElementById('agentCliUpdateList');
  if (!list) return [];
  const selectedIds = new Set(
    Array.from(list.querySelectorAll('.agent-cli-update-checkbox:checked')).map(input => input.value)
  );
  return pendingAgentUpdateBatch.filter(agent => selectedIds.has(String(agent.agentId)));
}

function updateAgentCliUpdateModalSelectionState() {
  const list = document.getElementById('agentCliUpdateList');
  const selectAll = document.getElementById('agentCliUpdateSelectAll');
  const selectedCount = document.getElementById('agentCliUpdateSelectedCount');
  const updateBtn = document.getElementById('agentCliUpdateConfirmBtn');
  if (!list || !selectAll || !selectedCount || !updateBtn) return;

  const checkboxes = Array.from(list.querySelectorAll('.agent-cli-update-checkbox'));
  const checkedCount = checkboxes.filter(input => input.checked).length;
  selectedCount.textContent = String(checkedCount);
  updateBtn.disabled = checkedCount === 0;
  updateBtn.textContent = checkedCount === 1 ? 'Update 1 Agent' : `Update ${checkedCount} Agents`;

  selectAll.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

function setupAgentCliUpdateModal() {
  const modal = document.getElementById('agentCliUpdateModal');
  const list = document.getElementById('agentCliUpdateList');
  const selectAll = document.getElementById('agentCliUpdateSelectAll');
  const cancelBtn = document.getElementById('agentCliUpdateCancelBtn');
  const updateBtn = document.getElementById('agentCliUpdateConfirmBtn');
  if (!modal || !list || !selectAll || !cancelBtn || !updateBtn) return;

  list.addEventListener('change', (event) => {
    if (event.target?.classList?.contains('agent-cli-update-checkbox')) {
      updateAgentCliUpdateModalSelectionState();
    }
  });

  selectAll.addEventListener('change', () => {
    list.querySelectorAll('.agent-cli-update-checkbox').forEach((input) => {
      input.checked = selectAll.checked;
    });
    updateAgentCliUpdateModalSelectionState();
  });

  cancelBtn.addEventListener('click', hideAgentCliUpdateBatchDialog);

  updateBtn.addEventListener('click', async () => {
    const selectedAgents = getSelectedAgentCliUpdateAgents();
    hideAgentCliUpdateBatchDialog();
    await queueAgentCliSelfUpdates(selectedAgents);
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      hideAgentCliUpdateBatchDialog();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideAgentCliUpdateBatchDialog();
    }
  });
}

async function sendAgentUpdateConfirmation(
  agentId,
  options = {}
) {
  const {
    confirmationText = 'confirm update',
    reloadSelectedConversation = true,
    silentSuccess = false
  } = options;

  if (!agentId) {
    return { success: false, error: 'Missing agent id' };
  }

  await checkEncryptionKey();
  if (!encryptionKey || !window.E2EEncryption?.encryptMessage) {
    if (!silentSuccess) {
      showErrorMessage('Set your encryption password to send update confirmation.');
    }
    if (typeof showDecryptionPasswordModal === 'function') {
      showDecryptionPasswordModal();
    }
    return { success: false, error: 'Encryption key unavailable' };
  }

  try {
    const encryptedContent = await window.E2EEncryption.encryptMessage(confirmationText, encryptionKey);
    const response = await csrfFetch('/api/user/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        agentId,
        content: encryptedContent,
        encrypted: true
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Failed to send confirmation (${response.status})`);
    }

    if (reloadSelectedConversation && selectedAgentId === agentId) {
      lastMessageTimestamp = null;
      lastMessageCursor = null;
      conversationCache.delete(selectedAgentId);
      await loadMessages(selectedAgentId);
    }

    if (!silentSuccess) {
      showSuccessMessage('Sent encrypted update confirmation to agent.');
    }
    return { success: true };
  } catch (error) {
    console.error('Failed to send update confirmation:', error);
    if (!silentSuccess) {
      showErrorMessage(error.message || 'Failed to send update confirmation.');
    }
    return { success: false, error: error.message || 'Failed to send update confirmation' };
  }
}

function shouldPreloadConversation(agentId) {
  if (!agentId || (selectedChatContext?.mode === 'shared' && selectedChatContext.agentId === agentId)
    || conversationCache.has(agentId) || conversationPreloadInFlight.has(agentId)) {
    return false;
  }

  const lastAttempt = conversationPreloadLastAttempt.get(agentId) || 0;
  return (Date.now() - lastAttempt) >= CONVERSATION_PRELOAD_COOLDOWN_MS;
}

async function preloadConversation(agentId) {
  // An idle callback may have been queued while this was a private selection.
  // Re-check context when it fires so it cannot fetch private history for the
  // agent whose shared room is now open.
  if (!shouldPreloadConversation(agentId)) {
    return;
  }

  conversationPreloadInFlight.add(agentId);
  conversationPreloadLastAttempt.set(agentId, Date.now());

  try {
    const response = await fetch(`/api/user/messages/${agentId}?limit=${INITIAL_MESSAGE_LIMIT}`);
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (Array.isArray(data?.messages)) {
      conversationCache.set(agentId, data.messages);
      conversationHasMore.set(agentId, data.hasMore === true);
      if (data.oldestCursor) {
        conversationOldestCursor.set(agentId, data.oldestCursor);
      }
    }
  } catch (error) {
    console.warn('Background conversation preload failed:', agentId, error);
  } finally {
    conversationPreloadInFlight.delete(agentId);
  }
}

function scheduleConversationPreload(agents = []) {
  if (!Array.isArray(agents) || agents.length === 0 || document.hidden) {
    return;
  }

  const candidateIds = [];
  const selectedIndex = agents.findIndex(agent => agent.agentId === selectedAgentId);

  if (selectedIndex >= 0) {
    const offsets = [1, -1, 2, -2, 3, -3];
    offsets.forEach((offset) => {
      const idx = selectedIndex + offset;
      if (idx >= 0 && idx < agents.length) {
        candidateIds.push(agents[idx].agentId);
      }
    });
  }

  agents.forEach((agent) => {
    if (agent?.agentId && agent.agentId !== selectedAgentId) {
      candidateIds.push(agent.agentId);
    }
  });

  const uniqueCandidates = [...new Set(candidateIds)]
    .filter(shouldPreloadConversation)
    .slice(0, CONVERSATION_PRELOAD_LIMIT);

  uniqueCandidates.forEach((agentId) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => {
        preloadConversation(agentId);
      }, { timeout: 600 });
    } else {
      setTimeout(() => {
        preloadConversation(agentId);
      }, 0);
    }
  });
}

function getOrbitRingKey(agent) {
  if (agent.lastMessagePriority === 'high') {
    return 'urgent';
  }
  if (agent.lastMessagePriority === 'normal') {
    return 'attention';
  }
  if ((agent.briefSummary?.suggestionCount || 0) > 0 || ['waiting_user', 'blocked', 'ready_for_review', 'needs_review'].includes(agent.briefSummary?.status)) {
    return 'attention';
  }
  return 'idle';
}

/**
 * Determine agent availability based on lastActivityTime.
 * Returns: 'online' (seen <5min), 'idle' (5min-1hr), 'offline' (>1hr or never)
 */
function getAgentAvailability(agent) {
  if (!agent.lastActivityTime) return 'offline';
  const ageMs = Date.now() - new Date(agent.lastActivityTime).getTime();
  if (ageMs <= 5 * 60 * 1000) return 'online';    // within 5 minutes
  if (ageMs <= 60 * 60 * 1000) return 'idle';      // within 1 hour
  return 'offline';                                  // over 1 hour
}

/**
 * Partition agents into ungrouped and grouped sets.
 * An agent in at least one group does NOT appear as ungrouped.
 * Result is cached until invalidated by poll.
 */
function getGroupPartition(agents) {
  if (cachedGroupPartition && cachedGroupPartition._agentCount === agents.length && cachedGroupPartition._groupCount === currentGroups.length) {
    return cachedGroupPartition;
  }

  const agentMap = new Map(agents.map(a => [a.agentId, a]));
  const groupedAgentIds = new Set();
  const grouped = new Map(); // groupId -> { group, agents[] }

  for (const group of currentGroups) {
    const memberAgents = (group.memberIds || [])
      .map(id => agentMap.get(id))
      .filter(Boolean);
    grouped.set(group.groupId, {
      group,
      agents: memberAgents
    });
    memberAgents.forEach(a => groupedAgentIds.add(a.agentId));
  }

  const ungrouped = agents.filter(a => !groupedAgentIds.has(a.agentId));

  // Compute group-level priority (max of members)
  const groupMeta = new Map();
  for (const [groupId, data] of grouped) {
    let hasUrgent = false;
    let totalUnread = 0;
    let maxPriorityValue = 0;
    let bestRingKey = 'idle';

    for (const a of data.agents) {
      const ringKey = getOrbitRingKey(a);
      if (ringKey === 'urgent') { hasUrgent = true; bestRingKey = 'urgent'; maxPriorityValue = 3; }
      else if (ringKey === 'attention' && bestRingKey !== 'urgent') { bestRingKey = 'attention'; maxPriorityValue = Math.max(maxPriorityValue, 2); }
      totalUnread += (a.unreadCount || 0);
    }

    groupMeta.set(groupId, {
      ringKey: bestRingKey,
      hasUrgent,
      totalUnread,
      maxPriorityValue,
      memberCount: data.agents.length
    });
  }

  cachedGroupPartition = { ungrouped, grouped, groupMeta, _agentCount: agents.length, _groupCount: currentGroups.length };
  return cachedGroupPartition;
}

/**
 * Compute group priority ring key for orbit placement.
 */
function getGroupRingKey(groupId) {
  const partition = cachedGroupPartition;
  if (!partition) return 'idle';
  const meta = partition.groupMeta.get(groupId);
  return meta ? meta.ringKey : 'idle';
}

const GROUP_THEME_HUES = [
  165, // emerald
  190, // teal/cyan
  210, // sky
  235, // blue
  265, // indigo
  285, // violet
  305, // fuchsia
  330, // rose
  35,  // amber
  55   // yellow
];

function hashStringToInt(input) {
  const str = String(input || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // to 32-bit int
  }
  return Math.abs(hash);
}

function getGroupThemeHue(group) {
  const key = `${group?.groupId || ''}:${group?.groupName || ''}`;
  const idx = hashStringToInt(key) % GROUP_THEME_HUES.length;
  return GROUP_THEME_HUES[idx];
}

function getOrbitSquashValue() {
  // The chamber holds the divider tilt combined with its own small-size tilt.
  const chamber = document.getElementById('councilCircle') || document.querySelector('.dashboard-main-grid');
  if (!chamber) {
    return 1;
  }

  const squash = Number.parseFloat(getComputedStyle(chamber).getPropertyValue('--council-orbit-squash'));
  return Number.isFinite(squash) && squash > 0 ? squash : 1;
}

function projectOrbitPoint(angle, radius, squash = getOrbitSquashValue()) {
  const radians = angle * Math.PI / 180;
  return {
    x: 50 + radius * Math.cos(radians),
    y: 50 + (radius * Math.sin(radians) * squash)
  };
}

function buildOrbitLayout(agents, totalSlots) {
  const orderedAgents = Array.isArray(agents) ? [...agents] : [];
  orderedAgents.sort((a, b) => (a.position || 0) - (b.position || 0));
  const layout = new Map();
  const order = orderedAgents.map(agent => agent.agentId);
  const total = totalSlots || orderedAgents.length;

  if (orderedAgents.length === 0) {
    return { layout, order };
  }

  orderedAgents.forEach((agent, index) => {
    const ringKey = getOrbitRingKey(agent);
    const radius = ORBIT_CONFIG.ringRadii[ringKey] ?? ORBIT_CONFIG.ringRadii.idle;
    const ringIndex = ORBIT_CONFIG.ringIndex[ringKey] ?? ORBIT_CONFIG.ringIndex.idle;
    const angle = (index * 360 / total) - 90;
    const { x, y } = projectOrbitPoint(angle, radius);

    layout.set(agent.agentId, {
      x,
      y,
      angle,
      ringKey,
      ringIndex,
      radius
    });
  });

  return { layout, order };
}

/**
 * Render agent seat HTML for a list of agents.
 * Extracted to share between main view and group view.
 */
function renderAgentSeatsHtml(agents, totalOrbitItems, inGroupView) {
  return agents.map((agent, index) => {
    const isSelected = agent.agentId === selectedAgentId;
    const positionValue = Number.isFinite(agent.position) ? agent.position : Number(agent.position);
    const safePosition = Number.isFinite(positionValue) ? positionValue : (index + 1);
    const orbitMeta = currentOrbitLayout?.layout?.get(agent.agentId);
    const ringKey = orbitMeta?.ringKey || getOrbitRingKey(agent);
    const ringIndex = orbitMeta?.ringIndex ?? ORBIT_CONFIG.ringIndex[ringKey];
    const x = orbitMeta?.x ?? 50;
    const y = orbitMeta?.y ?? 50;

    const statusLabel = ringKey;
    const needsAttention = agent.highestPriority === 'high' || agent.unreadCount > 0 || getOrbitRingKey(agent) === 'attention';
    const isWorking = agent.isWorking === true;
    const isNewAgent = newAgentIds.has(agent.agentId);
    const isNewsAgent = agent.agentType === 'news_feed';
    const isOpenClaw = isOpenClawAgent(agent);

    const marbleSvg = getCachedMarbleSvg(agent.agentId, 100, agent.name, 'orbit');

    const sphereSize = calculateDynamicSphereSize(totalOrbitItems);
    const sizeStyle = `width: ${sphereSize}px; height: ${sphereSize}px;`;

    // In group view, show remove button
    const removeBtn = inGroupView ? `
      <div class="agent-seat__group-remove" data-remove-agent-id="${agent.agentId}" title="Remove from group">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/></svg>
      </div>
    ` : '';

    return `
      <div
        class="agent-seat absolute cursor-pointer transition-all duration-300 agent-seat--${statusLabel} ${needsAttention ? 'agent-seat--active' : ''} ${isSelected ? 'agent-seat--selected' : ''} ${isNewAgent ? 'agent-seat--new' : ''}"
        data-agent-id="${agent.agentId}"
        data-agent-name="${escapeHtml(agent.name)}"
        data-agent-type="${agent.agentType || 'standard'}"
        data-agent-priority="${agent.highestPriority}"
        data-agent-last-message-priority="${agent.lastMessagePriority || 'low'}"
        data-agent-unread="${agent.unreadCount}"
        data-agent-last-message="${agent.lastMessageTime || ''}"
        data-agent-last-activity="${agent.lastActivityTime || ''}"
        data-agent-last-seen="${agent.lastSeenAt || ''}"
        data-agent-last-heartbeat="${agent.lastWorkingHeartbeatTime || ''}"
        data-agent-working="${isWorking ? 'true' : 'false'}"
        data-agent-external-provider="${escapeHtml(agent.externalProvider || '')}"
        data-council-angle="${orbitMeta?.angle ?? -90}"
        data-council-radius="${orbitMeta?.radius ?? ORBIT_CONFIG.ringRadii.idle}"
        data-agent-ring="${ringKey}"
        data-agent-ring-index="${ringIndex}"
        data-agent-index="${index}"
        style="left: ${x}%; top: ${y}%; transform: translate(-50%, -50%);"
      >
        ${removeBtn}
        <div class="agent-number-badge absolute -top-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <span class="text-[10px] font-mono font-bold text-sky-400/70 bg-slate-900/80 px-1.5 py-0.5 rounded border border-sky-400/30">${safePosition}</span>
        </div>
        <div class="agent-avatar relative group flex justify-center">
          ${DeviceBadge.render(agent.device)}
          ${isNewsAgent ? `
            <div class="agent-badge-news" title="News Feed">
              <span>i</span>
            </div>
          ` : ''}
          <div class="council-agent-sphere rounded-full relative z-10 transition-transform duration-300 group-hover:scale-110 overflow-hidden border-2 border-white/10 shadow-2xl bg-slate-900" style="${sizeStyle}">
            ${isOpenClaw ? `
              <div class="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-orange-950/30 to-slate-900">
                <div class="w-[72%] h-[72%] rounded-full border border-orange-400/40 bg-slate-950/70 flex items-center justify-center shadow-[0_0_20px_rgba(251,146,60,0.25)]">
                  ${getOpenClawIconSvg('w-[72%] h-[72%] text-orange-300')}
                </div>
              </div>
            ` : `
              <div class="w-full h-full marble-container">
                  ${marbleSvg}
              </div>
              <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span class="council-agent-initials text-white font-bold opacity-90" style="font-size: ${Math.max(sphereSize * 0.32, 10)}px; text-shadow: 0 2px 4px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.5);">
                  ${escapeHtml(agent.name.substring(0, 2).toUpperCase())}
                </span>
              </div>
            `}
            <div class="absolute inset-0 rounded-full shadow-[inset_0_0_10px_rgba(0,0,0,0.5)] pointer-events-none"></div>
          </div>

          ${agent.highestPriority === 'high' ? `
            <div class="absolute -top-1 -right-1 z-20 w-6 h-6 rounded-full bg-red-500 border-2 border-slate-900 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.6)] flex items-center justify-center">
              <span class="text-white text-xs font-bold">!</span>
            </div>
          ` : agent.unreadCount > 0 ? `
            <div class="absolute -top-1 -right-1 z-20 w-6 h-6 rounded-full bg-amber-400 border-2 border-slate-900 flex items-center justify-center shadow-[0_0_15px_rgba(251,191,36,0.6)]">
              <span class="text-slate-900 text-xs font-bold">${agent.unreadCount}</span>
            </div>
          ` : isWorking ? `
            <div class="absolute bottom-0 right-0 z-20 w-5 h-5 rounded-md bg-amber-500 border-2 border-slate-900 flex items-center justify-center shadow-[0_0_10px_rgba(245,158,11,0.6)] animate-pulse" title="${agent.lastWorkingHeartbeatTime ? `Agent is working (heartbeat ${formatRelativeTime(agent.lastWorkingHeartbeatTime)})` : 'Agent is working...'}">
              <span class="text-[8px]">🛠️</span>
            </div>
          ` : (() => {
            const avail = getAgentAvailability(agent);
            if (avail === 'online') return `<div class="absolute bottom-0 right-0 z-20 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-slate-900 shadow-[0_0_10px_rgba(52,211,153,0.6)]" title="Online${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"></div>`;
            if (avail === 'idle') return `<div class="absolute bottom-0 right-0 z-20 w-3.5 h-3.5 rounded-full bg-slate-400 border-2 border-slate-900 shadow-[0_0_6px_rgba(148,163,184,0.4)]" title="Idle${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"></div>`;
            return `<div class="absolute bottom-0 right-0 z-20 agent-status-disconnected" title="Disconnected${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><line x1="5" y1="5" x2="11" y2="11"/></svg></div>`;
          })()}
        </div>

        <div class="council-seat-name mt-2 text-center opacity-80 ${isSelected ? 'opacity-100' : 'group-hover:opacity-100'} transition-opacity w-full absolute top-full left-1/2 -translate-x-1/2 w-max">
          <p class="text-[10px] font-bold uppercase tracking-wider text-shadow-sm whitespace-nowrap mx-auto ${isSelected ? 'text-emerald-300 bg-slate-900/90 px-2 py-0.5 rounded shadow-lg z-50' : 'text-slate-200 overflow-hidden text-ellipsis max-w-[80px]'}">${escapeHtml(agent.name)}</p>
        </div>

        <svg class="connection-line absolute" style="position: absolute; top: 50%; left: 50%; pointer-events: none; overflow: visible; width: 200px; height: 200px; transform: translate(-50%, -50%); z-index: -1;">
          <line x1="100" y1="100" x2="100" y2="100" stroke="url(#gradient-${index})" stroke-width="1" />
          <defs>
            <linearGradient id="gradient-${index}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="rgba(16, 185, 129, 0)" />
              <stop offset="100%" stop-color="rgba(16, 185, 129, 0.4)" />
            </linearGradient>
          </defs>
        </svg>
      </div>
    `;
  }).join('');
}

/**
 * Update agent list UI with new data (Council Chamber version)
 */
function updateAgentListUI(agents) {
  const agentSeatsContainer = document.getElementById('agentSeats');
  const statsTotal = document.getElementById('statsTotal');
  const statsActive = document.getElementById('statsActive');
  const statsAttention = document.getElementById('statsAttention');
  const statsUrgent = document.getElementById('statsUrgent');
  const listActiveCount = document.getElementById('agentListActiveCount');

  if (!agentSeatsContainer) {
    return;
  }

  currentAgentList = Array.isArray(agents) ? agents : [];
  window.RecentChats?.updateAgents(currentAgentList);
  if (orbitDragState) return; // Keep the captured seat attached while dragging.
  window.CouncilSharing?.updateOrbit(currentAgentList, currentGroups, activeGroupId);
  updateAgentCliMenuButton('updateAgentBtn', selectedAgentId);
  updateAgentCliMenuButton('floatingUpdateAgentBtn', document.getElementById('floatingAgentMenu')?.dataset.agentId);
  pruneChatNavigationHistory();
  const fastModeActive = isDashboardFastModeActive();

  if (shouldSkipAgentListRender(currentAgentList)) {
    return;
  }

  // Update stats
  const activeCount = currentAgentList.filter(isAgentActive).length;
  const urgentCount = currentAgentList.filter(a => getOrbitRingKey(a) === 'urgent').length;
  const attentionCount = currentAgentList.filter(a => getOrbitRingKey(a) === 'attention').length;
  const unreadMessageCount = getFastModeUnreadMessageCount(currentAgentList);
  if (statsTotal) statsTotal.textContent = currentAgentList.length;
  if (statsActive) statsActive.textContent = activeCount;
  if (listActiveCount) listActiveCount.textContent = activeCount;
  if (statsAttention) statsAttention.textContent = attentionCount;
  if (statsUrgent) statsUrgent.textContent = urgentCount;
  syncAgentListFilterControls();
  updateFastModeNavCluster({ urgent: urgentCount, attention: unreadMessageCount });

  // Update minimized stats (desktop)
  const minUrgent = document.getElementById('minimizedStatsUrgent');
  const minAttention = document.getElementById('minimizedStatsAttention');
  const minTotal = document.getElementById('minimizedStatsTotal');

  if (minTotal) minTotal.textContent = currentAgentList.length;
  if (minAttention) {
    minAttention.textContent = currentAgentList.filter(a => getOrbitRingKey(a) === 'attention').length;
  }
  if (minUrgent) {
    minUrgent.textContent = currentAgentList.filter(a => getOrbitRingKey(a) === 'urgent').length;
  }

  // Update mobile dock. In Fast Mode the dock is hidden; keep its sorted agent
  // state fresh for keyboard/header navigation without rebuilding hidden DOM.
  updateMobileDock(currentAgentList, { render: !fastModeActive });
  syncSideChatAddButtonState();

  if (currentAgentList.length === 0) {
    agentSeatsContainer.innerHTML = `
      <div class="absolute inset-0 flex items-center justify-center">
        <div class="council-empty-state text-center text-slate-400">
          <svg class="w-16 h-16 mx-auto mb-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
          </svg>
          <p class="text-sm">No agents in your council yet</p>
          <p class="text-xs text-slate-600 mt-1">Agents will appear here once they connect</p>
          <a class="workspace-setup-link" href="/for-agents">Connect your first agent →</a>
        </div>
      </div>
    `;
    return;
  }

  if (fastModeActive) {
    agentSeatsContainer.innerHTML = '';
    currentOrbitLayout = { layout: new Map(), order: [] };
    if (shouldRenderAgentListPanelInFastMode()) {
      const listScroll = document.getElementById('agentListScroll');
      if (listScroll) delete listScroll.dataset.fastModeCleared;
      updateAgentListPanel(currentAgentList);
    } else {
      clearCollapsedFastModeAgentListPanel();
    }
    syncSelectedChatHeader(currentAgentList);
    if (window.MultiChatManager?.syncWorkingStatus) {
      window.MultiChatManager.syncWorkingStatus(currentAgentList);
    }
    syncSideChatAddButtonState();
    return;
  }

  // Determine which agents to render on orbit
  const partition = getGroupPartition(currentAgentList);
  let orbitAgents; // agents to render as individual seats
  let orbitGroups; // groups to render as group seats

  if (activeGroupId) {
    // Group zoom view: only show group members
    const groupData = partition.grouped.get(activeGroupId);
    orbitAgents = groupData ? groupData.agents : [];
    orbitGroups = [];
  } else if (currentGroups.length > 0) {
    // Main view with groups: ungrouped agents + group seats
    orbitAgents = partition.ungrouped;
    orbitGroups = currentGroups;
  } else {
    // No groups at all: show all agents
    orbitAgents = currentAgentList;
    orbitGroups = [];
  }

  // Rebuild orbit layout for visible items (pass total slots so spacing accounts for groups)
  const totalOrbitItems = orbitAgents.length + orbitGroups.length;
  currentOrbitLayout = buildOrbitLayout(orbitAgents, totalOrbitItems);

  const html = renderAgentSeatsHtml(orbitAgents, totalOrbitItems, activeGroupId);

  // Render group seats (mini solar systems)
  let groupHtml = '';
  if (orbitGroups.length > 0) {
    groupHtml = orbitGroups.map((group, gi) => {
      const meta = partition.groupMeta.get(group.groupId);
      const groupHue = getGroupThemeHue(group);
      const ringKey = meta?.ringKey || 'idle';
      const radius = ORBIT_CONFIG.ringRadii[ringKey] ?? ORBIT_CONFIG.ringRadii.idle;
      // Place groups after agents in the angle sequence
      const itemIndex = orbitAgents.length + gi;
      const angle = (itemIndex * 360 / totalOrbitItems) - 90;
      const { x, y } = projectOrbitPoint(angle, radius);

      const memberCount = meta?.memberCount || 0;
      const displayDots = Math.min(memberCount, 10);
      const overflow = memberCount - displayDots;

      // Generate mini dots
      const groupData = partition.grouped.get(group.groupId);
      const members = groupData ? groupData.agents : [];
      let dotsHtml = '';
      for (let di = 0; di < displayDots; di++) {
        const dotAngle = (di * 360 / displayDots) - 90;
        const dotRadius = 22;
        const dx = 24 + dotRadius * Math.cos(dotAngle * Math.PI / 180);
        const dy = 24 + dotRadius * Math.sin(dotAngle * Math.PI / 180);
        const member = members[di];
        let dotClass = 'group-seat__dot--idle';
        if (member) {
          const memberRing = getOrbitRingKey(member);
          if (memberRing === 'urgent') dotClass = 'group-seat__dot--urgent';
          else if (memberRing === 'attention') dotClass = 'group-seat__dot--attention';
          else if (getAgentAvailability(member) === 'online') dotClass = 'group-seat__dot--online';
        }
        dotsHtml += `<div class="group-seat__dot ${dotClass}" style="left: ${dx}px; top: ${dy}px;"></div>`;
      }
      if (overflow > 0) {
        dotsHtml += `<div class="group-seat__overflow">+${overflow}</div>`;
      }

      // Badge
      let badgeHtml = '';
      if (meta?.hasUrgent) {
        badgeHtml = `<div class="group-seat__badge group-seat__badge--urgent">!</div>`;
      } else if (meta?.totalUnread > 0) {
        badgeHtml = `<div class="group-seat__badge group-seat__badge--unread">${meta.totalUnread}</div>`;
      }

      return `
        <div class="group-seat absolute cursor-pointer transition-all duration-300"
             data-group-id="${group.groupId}"
             data-group-name="${escapeHtml(group.groupName)}"
             data-council-angle="${angle}" data-council-radius="${radius}"
             style="left: ${x}%; top: ${y}%; transform: translate(-50%, -50%); --group-hue: ${groupHue};">
          <div class="group-seat__center relative">
            <span class="group-seat__center-label">${escapeHtml(group.groupName)}</span>
            <div class="group-seat__dots">${dotsHtml}</div>
            ${badgeHtml}
          </div>
          <div class="council-seat-name mt-2 text-center absolute top-full left-1/2 -translate-x-1/2 w-max">
            <p class="group-seat__name">${escapeHtml(group.groupName)}</p>
          </div>
        </div>
      `;
    }).join('');
  }

  const councilScrollTop = agentSeatsContainer.scrollTop;
  const councilFocusId = agentSeatsContainer.contains(document.activeElement)
    ? document.activeElement.dataset.agentId || document.activeElement.dataset.groupId : null;
  agentSeatsContainer.innerHTML = html + groupHtml;
  setupAgentSelectionHandlers();
  setupGroupSeatHandlers();
  refreshCouncilFit();
  agentSeatsContainer.scrollTop = councilScrollTop;
  if (councilFocusId) {
    [...agentSeatsContainer.children].find(seat =>
      (seat.dataset.agentId || seat.dataset.groupId) === councilFocusId)?.focus({ preventScroll: true });
  }

  // Update the agent list panel below the orbit
  updateAgentListPanel(currentAgentList);

  // Sync the selected agent's chat header with latest working status
  syncSelectedChatHeader(currentAgentList);

  // Sync side-chat tile working indicators
  if (window.MultiChatManager?.syncWorkingStatus) {
    window.MultiChatManager.syncWorkingStatus(currentAgentList);
  }
  syncSideChatAddButtonState();
}

/**
 * Setup click handlers for group seats on the orbit
 */
function setupGroupSeatHandlers() {
  document.querySelectorAll('.group-seat').forEach(seat => {
    seat.addEventListener('click', () => {
      const groupId = seat.getAttribute('data-group-id');
      if (groupId) {
        enterGroupView(groupId);
      }
    });
  });

  // Setup remove-from-group buttons in group zoom view
  document.querySelectorAll('.agent-seat__group-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agentId = btn.getAttribute('data-remove-agent-id');
      if (agentId && activeGroupId) {
        await removeAgentFromGroup(activeGroupId, agentId);
      }
    });
  });
}

/**
 * Enter group zoom view - show only group members
 */
function enterGroupView(groupId) {
  const group = currentGroups.find(g => g.groupId === groupId);
  if (!group) return;

  activeGroupId = groupId;

  // Update center label
  const centerLabel = document.getElementById('councilCenterLabel') || document.querySelector('.council-center p');
  if (centerLabel) {
    centerLabel.textContent = group.groupName;
    centerLabel.classList.remove('text-emerald-400/80');
    centerLabel.classList.add('text-violet-400/80');
  }

  // Update center badge (circle) to represent the group
  const councilCenter = document.querySelector('.council-center');
  const centerAvatar = document.getElementById('councilCenterAvatar');
  const centerGroup = document.getElementById('councilCenterGroup');
  const centerGroupText = document.getElementById('councilCenterGroupText');
  if (councilCenter) {
    const groupHue = getGroupThemeHue(group);
    councilCenter.style.setProperty('--group-hue', String(groupHue));
    councilCenter.classList.add('council-center--group');
  }
  if (centerAvatar) centerAvatar.classList.add('hidden');
  if (centerGroup) centerGroup.classList.remove('hidden');
  if (centerGroupText) centerGroupText.textContent = group.groupName;

  // Show back button
  const backBtn = document.getElementById('groupBackBtn');
  if (backBtn) {
    backBtn.classList.remove('hidden');
    const label = document.getElementById('groupBackLabel');
    if (label) label.textContent = 'Back';
  }

  // Hide FAB while in group view
  const fab = document.getElementById('groupManagementFab');
  if (fab) fab.classList.add('hidden');
  hideGroupManagementMenu();

  // Show "Remove from group" option in floating menu
  const removeBtn = document.getElementById('floatingRemoveFromGroupBtn');
  if (removeBtn) removeBtn.classList.remove('hidden');

  // Re-render orbit with only group members
  cachedGroupPartition = null;
  updateAgentListUI(currentAgentList);
}

/**
 * Exit group zoom view - return to main view
 */
function exitGroupView() {
  activeGroupId = null;

  // Restore center label
  const centerLabel = document.getElementById('councilCenterLabel') || document.querySelector('.council-center p');
  if (centerLabel) {
    centerLabel.textContent = 'You';
    centerLabel.classList.remove('text-violet-400/80');
    centerLabel.classList.add('text-emerald-400/80');
  }

  // Restore center badge (planet)
  const councilCenter = document.querySelector('.council-center');
  const centerAvatar = document.getElementById('councilCenterAvatar');
  const centerGroup = document.getElementById('councilCenterGroup');
  const centerGroupText = document.getElementById('councilCenterGroupText');
  if (councilCenter) {
    councilCenter.classList.remove('council-center--group');
    councilCenter.style.removeProperty('--group-hue');
  }
  if (centerGroupText) centerGroupText.textContent = '';
  if (centerGroup) centerGroup.classList.add('hidden');
  if (centerAvatar) centerAvatar.classList.remove('hidden');

  // Hide back button
  const backBtn = document.getElementById('groupBackBtn');
  if (backBtn) backBtn.classList.add('hidden');

  // Show FAB
  const fab = document.getElementById('groupManagementFab');
  if (fab) fab.classList.remove('hidden');

  // Hide "Remove from group" option
  const removeBtn = document.getElementById('floatingRemoveFromGroupBtn');
  if (removeBtn) removeBtn.classList.add('hidden');

  // Re-render
  cachedGroupPartition = null;
  updateAgentListUI(currentAgentList);
}

/**
 * Remove an agent from the active group
 */
async function removeAgentFromGroup(groupId, agentId) {
  try {
    const response = await csrfFetch(`/api/user/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin'
    });

    if (!response.ok) {
      console.error('Failed to remove agent from group:', response.status);
      showErrorMessage('Could not remove the agent from this group. Please try again.');
      return false;
    }

    // Update local state
    const group = currentGroups.find(g => g.groupId === groupId);
    if (group) {
      group.memberIds = group.memberIds.filter(id => id !== agentId);

      // If group is now empty, exit view
      if (group.memberIds.length === 0 && activeGroupId === groupId) {
        exitGroupView();
        return true;
      }
    }

    cachedGroupPartition = null;
    updateAgentListUI(currentAgentList);
    return true;
  } catch (error) {
    console.error('Error removing agent from group:', error);
    showErrorMessage('Could not remove the agent from this group. Please try again.');
    return false;
  }
}

/**
 * Render the "Groups" section of the agent menus: which groups the agent is
 * in, with a toggle per group to add or remove it.
 */
function renderAgentGroupMembership(agentId) {
  const agent = findCachedAgentRecord(agentId);
  document.querySelectorAll('[data-agent-groups]').forEach((section) => {
    if (!agentId || agent?.agentType === 'news_feed') {
      section.innerHTML = '';
      delete section.dataset.agentId;
      return;
    }
    section.dataset.agentId = agentId;
    const groups = (Array.isArray(currentGroups) ? currentGroups : [])
      .slice()
      .sort((a, b) => String(a.groupName || '').localeCompare(String(b.groupName || '')));
    const memberOf = groups.filter(group => (group.memberIds || []).includes(agentId));
    const summary = memberOf.length === 0
      ? 'Not in any group'
      : `In ${memberOf.map(group => escapeHtml(group.groupName || 'Group')).join(', ')}`;
    const items = groups.map((group) => {
      const isMember = (group.memberIds || []).includes(agentId);
      const count = (group.memberIds || []).length;
      const name = escapeHtml(group.groupName || 'Group');
      const attrName = name.replace(/"/g, '&quot;');
      return `
        <button type="button" class="agent-menu-groups__item" role="menuitemcheckbox"
          aria-checked="${isMember}" data-agent-group-toggle="${escapeHtml(group.groupId).replace(/"/g, '&quot;')}"
          title="${isMember ? 'Remove from' : 'Add to'} ${attrName}">
          <span class="agent-menu-groups__check" aria-hidden="true">${isMember
            ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M5 13l4 4L19 7"/></svg>'
            : ''}</span>
          <span class="agent-menu-groups__name">${name}</span>
          <span class="agent-menu-groups__count">${count}</span>
        </button>`;
    }).join('');
    section.innerHTML = `
      <p class="agent-menu-groups__title">Groups</p>
      <p class="agent-menu-groups__summary">${summary}</p>
      ${groups.length > 0
        ? `<div class="agent-menu-groups__list" role="group" aria-label="Group membership">${items}</div>`
        : '<button type="button" class="agent-menu-groups__item agent-menu-groups__create" data-agent-group-create>+ Create a group</button>'}`;
  });
}

const pendingAgentGroupToggles = new Set();
async function toggleAgentGroupMembership(agentId, groupId) {
  const group = currentGroups.find(item => item.groupId === groupId);
  const key = `${groupId}:${agentId}`;
  if (!group || !agentId || pendingAgentGroupToggles.has(key)) return;
  pendingAgentGroupToggles.add(key);
  document.querySelectorAll(`[data-agent-group-toggle="${CSS.escape(groupId)}"]`)
    .forEach(btn => btn.setAttribute('aria-busy', 'true'));
  try {
    if ((group.memberIds || []).includes(agentId)) {
      if (await removeAgentFromGroup(groupId, agentId)) {
        showSuccessMessage(`Agent removed from ${group.groupName}`);
      }
    } else {
      await addAgentToCouncilGroup(agentId, groupId);
    }
  } finally {
    pendingAgentGroupToggles.delete(key);
    renderAgentGroupMembership(agentId);
  }
}

function setupAgentGroupMembershipSections() {
  document.querySelectorAll('[data-agent-groups]').forEach((section) => {
    // Handle clicks on the section itself and stop them here, so the
    // document-level "click outside" handlers don't close the menu when the
    // list is re-rendered under the pointer.
    section.addEventListener('click', (event) => {
      event.stopPropagation();
      const agentId = section.dataset.agentId;
      if (event.target.closest('[data-agent-group-create]')) {
        document.getElementById('agentContextMenu')?.classList.add('hidden');
        hideFloatingAgentMenu();
        showCreateGroupModal();
        return;
      }
      const toggle = event.target.closest('[data-agent-group-toggle]');
      if (toggle && agentId) {
        toggleAgentGroupMembership(agentId, toggle.getAttribute('data-agent-group-toggle'));
      }
    });
  });
}

function hideGroupManagementMenu() {
  const menu = document.getElementById('groupManagementMenu');
  if (menu) menu.classList.add('hidden');
}

function toggleGroupManagementMenu(anchorEl = null) {
  const menu = document.getElementById('groupManagementMenu');
  const fab = document.getElementById('groupManagementFab');
  const anchor = anchorEl || fab;
  if (!menu || !anchor) return;

  if (!menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
    return;
  }

  const rect = anchor.getBoundingClientRect();
  if (isMobileListOnlyMode()) {
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 236))}px`;
    menu.style.right = 'auto';
    menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 156)}px`;
    menu.style.bottom = 'auto';
  } else {
    menu.style.left = 'auto';
    menu.style.top = 'auto';
    menu.style.right = `${Math.max(window.innerWidth - rect.right, 12)}px`;
    menu.style.bottom = `${Math.max(window.innerHeight - rect.top + 8, 12)}px`;
  }
  menu.classList.remove('hidden');
}

/**
 * Show the create group modal
 */
function showCreateGroupModal() {
  const modal = document.getElementById('createGroupModal');
  if (!modal) return;

  // Populate agent selection
  const selectionContainer = document.getElementById('groupAgentSelection');
  if (selectionContainer) {
    const html = currentAgentList.map(agent => {
      const marbleSvg = MarbleGenerator.generateMarble(agent.agentId, 24, agent.name, `grp-${Date.now()}`);
      return `
        <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700/50 cursor-pointer transition">
          <input type="checkbox" value="${agent.agentId}" class="group-agent-checkbox rounded border-slate-600 text-violet-500 focus:ring-violet-500 bg-slate-800" />
          <div class="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">${marbleSvg}</div>
          <span class="text-sm text-slate-200 truncate">${escapeHtml(agent.name)}</span>
        </label>
      `;
    }).join('');
    selectionContainer.innerHTML = html;

    // Update count on change
    selectionContainer.querySelectorAll('.group-agent-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const count = selectionContainer.querySelectorAll('.group-agent-checkbox:checked').length;
        const countEl = document.getElementById('groupSelectedCount');
        if (countEl) countEl.textContent = count;
      });
    });
  }

  // Reset form
  const nameInput = document.getElementById('groupNameInput');
  const descInput = document.getElementById('groupDescInput');
  const countEl = document.getElementById('groupSelectedCount');
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (countEl) countEl.textContent = '0';

  modal.classList.remove('hidden');
  if (nameInput) setTimeout(() => nameInput.focus(), 100);
}

/**
 * Hide the create group modal
 */
function hideCreateGroupModal() {
  const modal = document.getElementById('createGroupModal');
  if (modal) modal.classList.add('hidden');
}

function populateGroupSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  if (currentGroups.length === 0) {
    select.innerHTML = '<option value="">No groups available</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = currentGroups.map(group =>
    `<option value="${group.groupId}">${escapeHtml(group.groupName)}</option>`
  ).join('');
}

function refreshManageGroupSelectionList() {
  const select = document.getElementById('manageGroupSelect');
  const selectionContainer = document.getElementById('manageGroupAgentSelection');
  const countEl = document.getElementById('manageGroupSelectedCount');
  if (!select || !selectionContainer) return;

  const group = currentGroups.find(g => g.groupId === select.value);
  if (!group) {
    selectionContainer.innerHTML = '<p class="text-xs text-slate-500 px-2 py-3">No group selected</p>';
    if (countEl) countEl.textContent = '0';
    return;
  }

  const memberSet = new Set(group.memberIds || []);
  const candidates = currentAgentList.slice();
  if (candidates.length === 0) {
    selectionContainer.innerHTML = '<p class="text-xs text-slate-500 px-2 py-3">No agents available</p>';
    if (countEl) countEl.textContent = '0';
    return;
  }

  selectionContainer.innerHTML = candidates.map(agent => {
    const marbleSvg = MarbleGenerator.generateMarble(agent.agentId, 24, agent.name, `grp-manage-${Date.now()}`);
    const checkedAttr = memberSet.has(agent.agentId) ? 'checked' : '';
    return `
      <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700/50 cursor-pointer transition">
        <input type="checkbox" value="${agent.agentId}" ${checkedAttr} class="manage-group-agent-checkbox rounded border-slate-600 text-violet-500 focus:ring-violet-500 bg-slate-800" />
        <div class="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">${marbleSvg}</div>
        <span class="text-sm text-slate-200 truncate">${escapeHtml(agent.name)}</span>
      </label>
    `;
  }).join('');

  selectionContainer.querySelectorAll('.manage-group-agent-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const count = selectionContainer.querySelectorAll('.manage-group-agent-checkbox:checked').length;
      if (countEl) countEl.textContent = count;
    });
  });
  if (countEl) {
    countEl.textContent = String(selectionContainer.querySelectorAll('.manage-group-agent-checkbox:checked').length);
  }
}

function showEditGroupMembersModal() {
  if (currentGroups.length === 0) {
    if (typeof showWarningMessage === 'function') showWarningMessage('Create a group first');
    return;
  }

  const modal = document.getElementById('editGroupMembersModal');
  const title = document.getElementById('editGroupMembersTitle');
  const subtitle = document.getElementById('editGroupMembersSubtitle');
  const confirmBtn = document.getElementById('editGroupMembersConfirmBtn');
  const select = document.getElementById('manageGroupSelect');
  if (!modal || !title || !subtitle || !confirmBtn || !select) return;

  title.textContent = 'Manage Group Members';
  subtitle.textContent = 'Check agents to include in the group, uncheck to remove';
  confirmBtn.textContent = 'Save Members';

  populateGroupSelect('manageGroupSelect');
  select.onchange = () => refreshManageGroupSelectionList();
  refreshManageGroupSelectionList();

  modal.classList.remove('hidden');
  setTimeout(() => select.focus(), 50);
}

function hideEditGroupMembersModal() {
  const modal = document.getElementById('editGroupMembersModal');
  if (modal) modal.classList.add('hidden');
}

async function submitEditGroupMembers() {
  const select = document.getElementById('manageGroupSelect');
  const selectionContainer = document.getElementById('manageGroupAgentSelection');
  if (!select || !selectionContainer || !select.value) return;

  const groupId = select.value;
  const group = currentGroups.find(g => g.groupId === groupId);
  if (!group) return;

  const memberSet = new Set(group.memberIds || []);
  const visibleAgentIds = currentAgentList.map(agent => agent.agentId);
  const visibleIdSet = new Set(visibleAgentIds);
  const selectedIds = new Set(
    Array.from(selectionContainer.querySelectorAll('.manage-group-agent-checkbox:checked')).map(cb => cb.value)
  );

  const toAdd = Array.from(selectedIds).filter(id => !memberSet.has(id));
  const toRemove = Array.from(memberSet).filter(id => visibleIdSet.has(id) && !selectedIds.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) {
    hideEditGroupMembersModal();
    return;
  }

  try {
    if (toAdd.length > 0) {
      const response = await csrfFetch(`/api/user/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': window.csrfToken
        },
        credentials: 'same-origin',
        body: JSON.stringify({ agentIds: toAdd })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (typeof showWarningMessage === 'function') showWarningMessage(err?.error?.message || 'Failed to update group members');
        return;
      }
    }

    if (toRemove.length > 0) {
      for (const agentId of toRemove) {
        const response = await csrfFetch(`/api/user/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          credentials: 'same-origin'
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          if (typeof showWarningMessage === 'function') showWarningMessage(err?.error?.message || 'Failed to update group members');
          return;
        }
      }
    }

    const finalMembers = new Set(group.memberIds || []);
    toAdd.forEach(id => finalMembers.add(id));
    toRemove.forEach(id => finalMembers.delete(id));
    group.memberIds = Array.from(finalMembers);
    if (group.memberIds.length === 0 && activeGroupId === groupId) {
      exitGroupView();
    }

    cachedGroupPartition = null;
    hideEditGroupMembersModal();
    pollAgentList(true);
  } catch (error) {
    console.error('Error updating group members:', error);
    if (typeof showWarningMessage === 'function') showWarningMessage('Failed to update group members');
  }
}

function showDeleteGroupModal() {
  if (currentGroups.length === 0) {
    if (typeof showWarningMessage === 'function') showWarningMessage('No groups to delete');
    return;
  }
  const modal = document.getElementById('deleteGroupModal');
  const select = document.getElementById('deleteGroupSelect');
  if (!modal || !select) return;

  populateGroupSelect('deleteGroupSelect');
  modal.classList.remove('hidden');
  setTimeout(() => select.focus(), 50);
}

function hideDeleteGroupModal() {
  const modal = document.getElementById('deleteGroupModal');
  if (modal) modal.classList.add('hidden');
}

async function deleteSelectedGroup() {
  const select = document.getElementById('deleteGroupSelect');
  if (!select || !select.value) return;

  const groupId = select.value;
  try {
    const response = await csrfFetch(`/api/user/groups/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin'
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (typeof showWarningMessage === 'function') showWarningMessage(err?.error?.message || 'Failed to delete group');
      return;
    }

    currentGroups = currentGroups.filter(group => group.groupId !== groupId);
    if (activeGroupId === groupId) {
      exitGroupView();
    } else {
      cachedGroupPartition = null;
      updateAgentListUI(currentAgentList);
    }

    hideDeleteGroupModal();
    pollAgentList(true);
  } catch (error) {
    console.error('Error deleting group:', error);
    if (typeof showWarningMessage === 'function') showWarningMessage('Failed to delete group');
  }
}

/**
 * Create a group via API
 */
async function createGroup() {
  const nameInput = document.getElementById('groupNameInput');
  const descInput = document.getElementById('groupDescInput');
  const selectionContainer = document.getElementById('groupAgentSelection');

  const name = (nameInput?.value || '').trim();
  if (!name) {
    if (nameInput) nameInput.focus();
    return;
  }

  const description = (descInput?.value || '').trim();
  const memberIds = [];
  if (selectionContainer) {
    selectionContainer.querySelectorAll('.group-agent-checkbox:checked').forEach(cb => {
      memberIds.push(cb.value);
    });
  }

  try {
    const response = await csrfFetch('/api/user/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name, description, memberIds })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err?.error?.message || 'Failed to create group';
      if (typeof showWarningMessage === 'function') showWarningMessage(msg);
      return;
    }

    const data = await response.json();
    if (data.group) {
      currentGroups.push(data.group);
      cachedGroupPartition = null;
    }

    hideCreateGroupModal();
    pollAgentList(true);
  } catch (error) {
    console.error('Error creating group:', error);
    if (typeof showWarningMessage === 'function') showWarningMessage('Failed to create group');
  }
}

/**
 * Setup group UI event listeners (called once on page load)
 */
function setupGroupUIHandlers() {
  setupAgentGroupMembershipSections();
  const fab = document.getElementById('groupManagementFab');
  if (fab) {
    fab.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGroupManagementMenu(fab);
    });
  }

  const mobileGroupBtn = document.getElementById('mobileGroupManagementBtn');
  if (mobileGroupBtn) {
    mobileGroupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.body.classList.remove('mobile-council-actions-open');
      document.getElementById('mobileCouncilActionsToggle')?.setAttribute('aria-expanded', 'false');
      toggleGroupManagementMenu(mobileGroupBtn);
    });
  }

  const managementMenu = document.getElementById('groupManagementMenu');
  if (managementMenu) {
    managementMenu.addEventListener('click', (e) => e.stopPropagation());
  }

  document.addEventListener('click', () => hideGroupManagementMenu());

  // Back button
  const backBtn = document.getElementById('groupBackBtn');
  if (backBtn) {
    backBtn.addEventListener('click', exitGroupView);
  }

  // Create Group Modal buttons
  const cancelBtn = document.getElementById('createGroupCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', hideCreateGroupModal);
  }

  const confirmBtn = document.getElementById('createGroupConfirmBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', createGroup);
  }

  const menuCreateBtn = document.getElementById('groupMenuCreateBtn');
  if (menuCreateBtn) {
    menuCreateBtn.addEventListener('click', () => {
      hideGroupManagementMenu();
      showCreateGroupModal();
    });
  }

  const menuManageBtn = document.getElementById('groupMenuManageMembersBtn');
  if (menuManageBtn) {
    menuManageBtn.addEventListener('click', () => {
      hideGroupManagementMenu();
      showEditGroupMembersModal();
    });
  }

  const menuDeleteBtn = document.getElementById('groupMenuDeleteGroupBtn');
  if (menuDeleteBtn) {
    menuDeleteBtn.addEventListener('click', () => {
      hideGroupManagementMenu();
      showDeleteGroupModal();
    });
  }

  // Close modal on backdrop click
  const modal = document.getElementById('createGroupModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideCreateGroupModal();
    });
  }

  const editMembersModal = document.getElementById('editGroupMembersModal');
  if (editMembersModal) {
    editMembersModal.addEventListener('click', (e) => {
      if (e.target === editMembersModal) hideEditGroupMembersModal();
    });
  }

  const editMembersCancelBtn = document.getElementById('editGroupMembersCancelBtn');
  if (editMembersCancelBtn) {
    editMembersCancelBtn.addEventListener('click', hideEditGroupMembersModal);
  }

  const editMembersConfirmBtn = document.getElementById('editGroupMembersConfirmBtn');
  if (editMembersConfirmBtn) {
    editMembersConfirmBtn.addEventListener('click', submitEditGroupMembers);
  }

  const deleteGroupModal = document.getElementById('deleteGroupModal');
  if (deleteGroupModal) {
    deleteGroupModal.addEventListener('click', (e) => {
      if (e.target === deleteGroupModal) hideDeleteGroupModal();
    });
  }

  const deleteGroupCancelBtn = document.getElementById('deleteGroupCancelBtn');
  if (deleteGroupCancelBtn) {
    deleteGroupCancelBtn.addEventListener('click', hideDeleteGroupModal);
  }

  const deleteGroupConfirmBtn = document.getElementById('deleteGroupConfirmBtn');
  if (deleteGroupConfirmBtn) {
    deleteGroupConfirmBtn.addEventListener('click', deleteSelectedGroup);
  }

  // "Remove from group" in floating agent menu
  const removeFromGroupBtn = document.getElementById('floatingRemoveFromGroupBtn');
  if (removeFromGroupBtn) {
    removeFromGroupBtn.addEventListener('click', async () => {
      if (activeGroupId && selectedAgentId) {
        hideFloatingAgentMenu();
        await removeAgentFromGroup(activeGroupId, selectedAgentId);
      }
    });
  }
}

/**
 * Keep the animated working dot's hover hint (title + CSS tooltip) in sync.
 */
function setWorkingDotHint(workingDot, lastHeartbeat) {
  const hint = lastHeartbeat
    ? `Agent is working \u2022 heartbeat ${formatRelativeTime(lastHeartbeat)}`
    : 'Agent is working';
  // The CSS ::after tooltip renders data-hint; no title, so the browser
  // tooltip does not double up with it.
  workingDot.removeAttribute('title');
  workingDot.dataset.hint = hint;
  workingDot.setAttribute('aria-label', hint);
}

/**
 * Sync the main chat header for the currently selected agent
 * with the latest working/status data from the agent list poll.
 */
function syncSelectedChatHeader(agents) {
  if (!selectedAgentId) return;
  const agent = agents.find(a => a.agentId === selectedAgentId);
  if (!agent) return;

  const lastActiveEl = document.getElementById('agentLastActive');
  const statusPill = document.getElementById('agentStatusPill');
  const workingDot = document.getElementById('selectedAgentWorkingIndicator');
  const isWorking = agent.isWorking === true;
  for (const id of ['agentBriefRole', 'agentBriefGoal', 'agentBriefProactive', 'agentBriefOpen']) {
    const button = document.getElementById(id);
    if (button) button.dataset.agentId = agent.agentId;
  }
  const briefRole = document.getElementById('agentBriefRole');
  const briefGoal = document.getElementById('agentBriefGoal');
  const briefProactive = document.getElementById('agentBriefProactive');
  if (briefRole) briefRole.textContent = agent.briefSummary?.role || 'Set a role';
  if (briefGoal) briefGoal.textContent = agent.briefSummary?.goal || 'Set a goal';
  if (briefProactive) briefProactive.textContent = `Proactive: ${agent.briefSummary?.proactiveEnabled ? 'On' : 'Off'}`;

  if (lastActiveEl) {
    if (isWorking && agent.lastWorkingHeartbeatTime) {
      lastActiveEl.textContent = `Working \u2022 heartbeat ${formatRelativeTime(agent.lastWorkingHeartbeatTime)}`;
    } else if (agent.lastMessageTime) {
      lastActiveEl.textContent = `Last active ${formatRelativeTime(agent.lastMessageTime)}`;
    } else {
      lastActiveEl.textContent = 'No recent activity';
    }
  }

  if (workingDot) {
    workingDot.style.display = isWorking ? '' : 'none';
    setWorkingDotHint(workingDot, isWorking ? agent.lastWorkingHeartbeatTime : null);
  }

  if (statusPill) {
    const metadata = {
      priority: agent.highestPriority,
      unread: agent.unreadCount,
      isWorking,
      availability: getAgentAvailability(agent)
    };
    const status = getStatusFromMetadata(metadata);
    statusPill.textContent = status.label;
    statusPill.className = `status-pill ${status.className} text-[10px]`;
  }

  updateMainPinButtonState();
}

function normalizeAgentListSearchQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function isAgentActive(agent) {
  if (!agent) return false;
  if (agent.isWorking === true) return true;
  if (getAgentAvailability(agent) === 'online') return true;
  const recentTimestamps = [agent.lastSeenAt, agent.lastWorkingHeartbeatTime]
    .map((ts) => (ts ? new Date(ts).getTime() : NaN))
    .filter((ms) => Number.isFinite(ms));
  if (recentTimestamps.some((ms) => Date.now() - ms <= 5 * 60 * 1000)) {
    return true;
  }
  return false;
}

const VALID_AGENT_STATUS_FILTERS = new Set(['all', 'active', 'attention', 'urgent']);

function filterAgentListByStatus(agents) {
  const list = Array.isArray(agents) ? agents : [];
  if (agentListStatusFilter === 'active') {
    return list.filter(isAgentActive);
  }
  if (agentListStatusFilter === 'attention') {
    return list.filter((agent) => getOrbitRingKey(agent) === 'attention');
  }
  if (agentListStatusFilter === 'urgent') {
    return list.filter((agent) => getOrbitRingKey(agent) === 'urgent');
  }
  return list;
}

function syncAgentListFilterControls() {
  const currentFilter = VALID_AGENT_STATUS_FILTERS.has(agentListStatusFilter) ? agentListStatusFilter : 'all';
  document.querySelectorAll('[data-agent-status-filter]').forEach((btn) => {
    const targetFilter = btn.getAttribute('data-agent-status-filter') || 'all';
    const isActive = targetFilter === currentFilter;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function setAgentListStatusFilter(nextFilter) {
  const normalized = VALID_AGENT_STATUS_FILTERS.has(nextFilter) ? nextFilter : 'all';
  agentListStatusFilter = normalized;
  syncAgentListFilterControls();
  updateAgentListPanel(currentAgentList);
}

function filterAgentListBySearch(agents) {
  const statusFiltered = filterAgentListByStatus(agents);
  const normalizedQuery = normalizeAgentListSearchQuery(agentListSearchQuery);
  if (!normalizedQuery) {
    return statusFiltered;
  }

  return statusFiltered.filter((agent) => {
    const haystack = [
      agent?.name,
      agent?.briefSummary?.displayName,
      agent?.briefSummary?.role,
      agent?.externalProvider,
      agent?.agentType
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function clearAgentListSearch({ blur = false, update = true } = {}) {
  const searchInput = document.getElementById('agentListSearchInput');
  const hadQuery = Boolean(normalizeAgentListSearchQuery(agentListSearchQuery));
  const hadInputValue = Boolean(searchInput?.value);

  agentListSearchQuery = '';
  if (searchInput) {
    searchInput.value = '';
    // Restore the autofill guard after a search is cleared. It will be
    // removed again only when the user intentionally focuses this field.
    searchInput.readOnly = true;
    if (blur && document.activeElement === searchInput) {
      searchInput.blur();
    }
  }

  if (update && (hadQuery || hadInputValue)) {
    updateAgentListPanel(currentAgentList);
  }
}

function getAgentListEmptyStateHtml(message, { offerSetup = false } = {}) {
  return `
    <div class="agent-list-empty">
      <p>${message}</p>
      ${offerSetup ? '<a class="workspace-setup-link" href="/for-agents">Connect an agent →</a>' : ''}
    </div>
  `;
}

/**
 * Update the agent list panel below the orbital view
 * This syncs with the orbit selection and provides an alternative way to select agents
 */
function updateAgentListPanel(agents) {
  const listScroll = document.getElementById('agentListScroll');
  const listCount = document.getElementById('agentListCount');
  const listActiveCount = document.getElementById('agentListActiveCount');
  const statsTotal = document.getElementById('statsTotal');
  const statsActive = document.getElementById('statsActive');

  if (!listScroll) return;

  const agentList = Array.isArray(agents) ? agents : [];
  const activeCount = agentList.filter(isAgentActive).length;
  const filteredAgentList = filterAgentListBySearch(agentList);
  const normalizedSearchQuery = normalizeAgentListSearchQuery(agentListSearchQuery);
  const hasActiveSearch = normalizedSearchQuery.length > 0;
  const hasActiveFilter = hasActiveSearch || agentListStatusFilter !== 'all';
  const searchLabel = escapeHtml(agentListSearchQuery.trim());

  // Update count badges
  if (listCount) {
    listCount.textContent = hasActiveSearch ? `${filteredAgentList.length}/${agentList.length}` : `${agentList.length}`;
  }
  if (listActiveCount) {
    listActiveCount.textContent = `${activeCount}`;
  }
  if (statsTotal) {
    statsTotal.textContent = `${agentList.length}`;
  }
  if (statsActive) {
    statsActive.textContent = `${activeCount}`;
  }
  syncAgentListFilterControls();

  if (agentList.length === 0) {
    listScroll.innerHTML = getAgentListEmptyStateHtml('No agents connected', { offerSetup: true });
    return;
  }

  const getEmptyMatchMessage = () => {
    if (hasActiveSearch) return `No agents match "${searchLabel}"`;
    if (agentListStatusFilter === 'active') return 'No active agents right now';
    if (agentListStatusFilter === 'attention') return 'No agents needing attention right now';
    if (agentListStatusFilter === 'urgent') return 'No urgent agents right now';
    return 'No agents connected';
  };

  // If in group view, show group members — but when searching or filtering by active, show matching agents
  if (activeGroupId) {
    if (hasActiveFilter) {
      const agentsHtml = filteredAgentList.length > 0
        ? renderAgentListItemsHtml(filteredAgentList)
        : getAgentListEmptyStateHtml(getEmptyMatchMessage());
      listScroll.innerHTML = agentsHtml;
      setupAgentListHandlers();
      return;
    }

    const group = currentGroups.find(g => g.groupId === activeGroupId);
    const partition = getGroupPartition(agentList);
    const groupData = partition.grouped.get(activeGroupId);
    const groupAgents = groupData ? groupData.agents : [];

    const headerHtml = `
      <div class="agent-list-group-header" data-action="exit-group" style="margin-bottom: 4px;">
        <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        <span class="agent-list-group-header__name" style="color: rgba(196,181,253,0.9);">${escapeHtml(group?.groupName || 'Group')}</span>
        <span class="agent-list-group-header__count">${groupAgents.length}</span>
      </div>
    `;

    const agentsHtml = groupAgents.length > 0
      ? renderAgentListItemsHtml(groupAgents)
      : getAgentListEmptyStateHtml('No agents in this group');
    listScroll.innerHTML = headerHtml + agentsHtml;
    setupAgentListHandlers();

    // Back header click
    listScroll.querySelector('[data-action="exit-group"]')?.addEventListener('click', exitGroupView);
    return;
  }

  // Main view: show groups then ungrouped
  const partition = getGroupPartition(agentList);
  let html = '';

  // Render group sections
  let hasAnyGroupSection = false;
  for (const group of currentGroups) {
    const groupData = partition.grouped.get(group.groupId);
    if (!groupData || groupData.agents.length === 0) continue;
    const filteredGroupAgents = filterAgentListBySearch(groupData.agents);
    if (filteredGroupAgents.length === 0) continue;
    hasAnyGroupSection = true;

    const meta = partition.groupMeta.get(group.groupId);
    const memberCount = filteredGroupAgents.length;
    let statusIndicator = '';
    if (meta?.hasUrgent) statusIndicator = '<span class="agent-list-item__badge agent-list-item__badge--urgent" style="width:8px;height:8px;min-width:8px;"></span>';
    else if (meta?.totalUnread > 0) statusIndicator = `<span class="agent-list-item__badge agent-list-item__badge--unread" style="width:auto;height:16px;font-size:9px;padding:0 4px;">${meta.totalUnread}</span>`;

    html += `
      <div class="agent-list-group-header" data-group-id="${group.groupId}">
        <div class="agent-list-group-header__icon">
          <svg class="w-3 h-3 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <span class="agent-list-group-header__name">${escapeHtml(group.groupName)}</span>
        ${statusIndicator}
        <span class="agent-list-group-header__count">${memberCount}</span>
        <svg class="agent-list-group-header__arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    `;

    // While searching or filtering by active status, show the matching members inline
    // instead of hiding them behind the collapsed group header.
    if (hasActiveFilter) {
      html += renderAgentListItemsHtml(filteredGroupAgents);
    }
  }

  // Ungrouped section
  const filteredUngrouped = filterAgentListBySearch(partition.ungrouped);
  if (filteredUngrouped.length > 0 && currentGroups.length > 0) {
    html += `<div style="padding: 4px 12px; margin-top: 8px;"><span style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:rgba(148,163,184,0.5);">Ungrouped</span></div>`;
  }

  // Determine which agents to show in list
  const listAgents = (currentGroups.length > 0) ? filteredUngrouped : filteredAgentList;

  // Sort by lastMessageTime (most recent first), fallback to position
  const orderedAgents = [...listAgents].sort((a, b) => {
    const aTime = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
    const bTime = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (a.position || 0) - (b.position || 0);
  });

  if (orderedAgents.length > 0) {
    html += renderAgentListItemsHtml(orderedAgents);
  } else if (!hasAnyGroupSection) {
    html += getAgentListEmptyStateHtml(getEmptyMatchMessage());
  }

  listScroll.innerHTML = html;

  setupAgentListHandlers();

  // Setup group header click handlers
  listScroll.querySelectorAll('.agent-list-group-header[data-group-id]').forEach(header => {
    header.addEventListener('click', () => {
      const groupId = header.getAttribute('data-group-id');
      if (groupId) enterGroupView(groupId);
    });
  });
}

/**
 * Render HTML for a list of agent list items (reusable helper)
 */
function renderAgentListItemsHtml(orderedAgents) {
  return orderedAgents.map((agent) => {
    const ringKey = getOrbitRingKey(agent);
    const needsAttention = agent.highestPriority === 'high' || agent.unreadCount > 0 || getOrbitRingKey(agent) === 'attention';
    const isWorking = agent.isWorking === true;
    const isSelected = agent.agentId === selectedAgentId;
    const isNewsAgent = agent.agentType === 'news_feed';
    const isOpenClaw = isOpenClawAgent(agent);
    // Only show the brief chip when it has something to say; the plain "Identity" entry lives in the ⋯ menu.
    const briefStatusLabel = (agent.briefSummary?.suggestionCount || 0) > 0 ? 'Review suggestion' : agent.briefSummary?.status === 'ready_for_review' ? 'Ready for review' : agent.briefSummary?.status === 'waiting_user' ? 'Waiting for you' : agent.briefSummary?.proactiveEnabled ? 'Automatic work on' : '';
    const marbleSvg = getCachedMarbleSvg(agent.agentId, 100, agent.name, 'list');

    // Status display
    const avail = getAgentAvailability(agent);
    let statusHtml = '';
    if (agent.highestPriority === 'high') {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--urgent">!</span> Urgent`;
    } else if (agent.unreadCount > 0) {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--unread">${agent.unreadCount}</span> Unread`;
    } else if (isWorking) {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--working"></span> Working`;
    } else if (avail === 'online') {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--idle"></span> Online`;
    } else if (avail === 'idle') {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--away"></span> Away`;
    } else {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--offline"></span> Offline`;
    }

    return `
      <div class="agent-list-item agent-list-item--${ringKey} ${needsAttention ? 'agent-list-item--attention' : ''} ${isSelected ? 'agent-list-item--selected' : ''}"
           data-agent-id="${agent.agentId}"
           data-agent-name="${escapeHtml(agent.name)}"
           data-agent-type="${agent.agentType || 'standard'}"
           data-agent-external-provider="${escapeHtml(agent.externalProvider || '')}"
           data-agent-priority="${agent.highestPriority}"
           data-agent-unread="${agent.unreadCount}"
           data-agent-last-activity="${agent.lastActivityTime || ''}"
           data-agent-last-seen="${agent.lastSeenAt || ''}"
           data-agent-last-message="${agent.lastMessageTime || ''}"
           data-agent-last-heartbeat="${agent.lastWorkingHeartbeatTime || ''}"
           data-agent-working="${isWorking ? 'true' : 'false'}">
        <div class="agent-list-item__avatar">
          ${DeviceBadge.render(agent.device)}
          ${isOpenClaw ? `
            <div class="agent-list-item__marble flex items-center justify-center bg-gradient-to-br from-slate-950 via-orange-950/30 to-slate-900 border border-orange-400/30">
              ${getOpenClawIconSvg('w-6 h-6 text-orange-300')}
            </div>
          ` : `
            <div class="agent-list-item__marble">${marbleSvg}</div>
            <span class="agent-list-item__initials">${escapeHtml(agent.briefSummary?.avatar || agent.name.substring(0, 2).toUpperCase())}</span>
          `}
          ${isNewsAgent ? `
            <div class="agent-badge-news">
              <span>i</span>
            </div>
          ` : ''}
        </div>
        <div class="agent-list-item__info">
          <span class="agent-list-item__name">${escapeHtml(agent.briefSummary?.displayName || agent.name)}</span>
          ${agent.briefSummary?.displayName ? `<span class="agent-list-item__runtime">${escapeHtml(agent.name)}</span>` : ''}
          <div class="agent-list-item__status-row">
            <span class="agent-list-item__status">${statusHtml}</span>
            ${agent.accessRequests > 0 ? `<button type="button" data-open-agent-access-requests data-agent-id="${agent.agentId}" class="agent-brief-entry agent-access-request-chip" aria-label="${agent.accessRequests} ${agent.accessRequests === 1 ? 'person wants' : 'people want'} access to ${escapeHtml(agent.name)}. Open sharing.">${agent.accessRequests} ${agent.accessRequests === 1 ? 'wants' : 'want'} access</button>` : ''}
            ${briefStatusLabel ? `<button type="button" data-open-agent-brief data-brief-tab="${(agent.briefSummary?.suggestionCount || 0) > 0 ? 'identity' : 'activity'}" data-agent-id="${agent.agentId}" class="agent-brief-entry" aria-label="View ${escapeHtml(agent.name)} activity">${escapeHtml(briefStatusLabel)}</button>` : ''}
            <div class="agent-list-item__timestamps">
               ${isWorking && agent.lastWorkingHeartbeatTime ? `<span class="agent-list-item__time" title="Last Working Heartbeat">Working ${formatRelativeTime(agent.lastWorkingHeartbeatTime)}</span>` : ''}
               ${agent.lastSeenAt ? `<span class="agent-list-item__time" title="Last Poll">Poll ${formatRelativeTime(agent.lastSeenAt)}</span>` : agent.lastActivityTime ? `<span class="agent-list-item__time" title="Last Active">Active ${formatRelativeTime(agent.lastActivityTime)}</span>` : ''}
               ${agent.lastMessageTime ? `<span class="agent-list-item__time" title="Last Message">Msg ${formatRelativeTime(agent.lastMessageTime)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="agent-list-item__arrow flex items-center gap-1">
          <button type="button" data-open-agent-brief data-agent-id="${agent.agentId}" class="agent-brief-entry" aria-label="Edit ${escapeHtml(agent.name)} identity and goals">⋯</button>
          <button
            type="button"
            class="chat-tile__pin-btn agent-list-pin-btn"
            data-agent-id="${escapeHtml(agent.agentId)}"
            data-agent-name="${escapeHtml(agent.name)}"
            data-agent-external-provider="${escapeHtml(agent.externalProvider || '')}"
            title="Pin chat to side panel"
            aria-label="Pin ${escapeHtml(agent.name)} chat to side panel">
            ${getPinChatIconSvg()}
          </button>
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Setup click handlers for agent list items (below orbit)
 */
let activeAgentOpenFeedbackToken = 0;

function getAgentMetadataFromElement(element) {
  if (!element) return {};
  return {
    priority: element.getAttribute('data-agent-priority'),
    agentType: element.getAttribute('data-agent-type') || 'standard',
    externalProvider: element.getAttribute('data-agent-external-provider') || '',
    unread: Number(element.getAttribute('data-agent-unread') || 0),
    lastActivity: element.getAttribute('data-agent-last-activity'),
    isWorking: element.getAttribute('data-agent-working') === 'true',
    lastHeartbeat: element.getAttribute('data-agent-last-heartbeat'),
    shouldCollapse: true
  };
}

function setAgentOpeningFeedback(agentId, agentName = '') {
  const token = ++activeAgentOpenFeedbackToken;

  document.querySelectorAll('.agent-list-item--loading').forEach(el => {
    el.classList.remove('agent-list-item--loading');
  });
  document.querySelectorAll('.agent-seat--loading').forEach(el => {
    el.classList.remove('agent-seat--loading');
  });
  document.querySelectorAll('.dock-agent--loading').forEach(el => {
    el.classList.remove('dock-agent--loading');
  });

  const listItem = document.querySelector(`.agent-list-item[data-agent-id="${agentId}"]`);
  if (listItem) {
    listItem.classList.add('agent-list-item--loading', 'agent-list-item--selected');
  }

  const orbitSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
  if (orbitSeat) {
    orbitSeat.classList.add('agent-seat--loading', 'agent-seat--selected');
  }

  const dockAgent = document.querySelector(`.dock-agent[data-agent-id="${agentId}"]`);
  if (dockAgent) {
    dockAgent.classList.add('dock-agent--loading');
  }

  const conversationArea = document.getElementById('conversationArea');
  const placeholder = document.getElementById('agentPanelPlaceholder');
  if (placeholder) placeholder.classList.add('hidden');
  if (conversationArea && !conversationCache.has(agentId)) {
    conversationArea.classList.remove('hidden');
    const label = agentName ? `Opening ${escapeHtml(agentName)}…` : 'Opening chat…';
    conversationArea.innerHTML = `<div class="conversation-loading-overlay"><div class="conversation-loading-overlay__spinner"></div><span>${label}</span></div>`;
  }

  return token;
}

function clearAgentOpeningFeedback(token, agentId) {
  const start = Date.now();
  const poll = () => {
    if (token !== activeAgentOpenFeedbackToken) return;
    if (!isLoadingMessages || Date.now() - start > 3500) {
      document.querySelectorAll(`.agent-list-item[data-agent-id="${agentId}"]`).forEach(el => {
        el.classList.remove('agent-list-item--loading');
      });
      document.querySelectorAll(`.agent-seat[data-agent-id="${agentId}"]`).forEach(el => {
        el.classList.remove('agent-seat--loading');
      });
      document.querySelectorAll(`.dock-agent[data-agent-id="${agentId}"]`).forEach(el => {
        el.classList.remove('dock-agent--loading');
      });
    } else {
      setTimeout(poll, 50);
    }
  };
  setTimeout(poll, 200);
}

function openAgentWithFeedback(agentId, agentName, metadata = {}) {
  const token = setAgentOpeningFeedback(agentId, agentName);
  return Promise.resolve(selectAgent(agentId, agentName, metadata))
    .finally(() => clearAgentOpeningFeedback(token, agentId));
}

function setupAgentListHandlers() {
  const listItems = document.querySelectorAll('.agent-list-item[data-agent-id]:not([data-agent-id=""])');
  const pinButtons = document.querySelectorAll('.agent-list-pin-btn');

  listItems.forEach(item => {
    item.addEventListener('click', (event) => {
      const agentId = item.getAttribute('data-agent-id');
      const agentName = item.getAttribute('data-agent-name');
      const metadata = getAgentMetadataFromElement(item);
      const shouldFocusSidePanel = shouldSelectIntoSidePanel(agentId, metadata);

      // Update list selection
      document.querySelectorAll('.agent-list-item').forEach(el => el.classList.remove('agent-list-item--selected'));
      item.classList.add('agent-list-item--selected');

      openAgentWithFeedback(agentId, agentName, metadata);

      // Also update orbit selection
      document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
      const orbitSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
      if (orbitSeat) {
        orbitSeat.classList.add('agent-seat--selected');
      }

      // Hide any floating menu
      hideFloatingAgentMenu();

      // Focus message input
      if (!EMBEDDED_PREVIEW_MODE && event.isTrusted && !shouldFocusSidePanel) {
        setTimeout(() => {
          const messageInput = document.getElementById('userMessageInput');
          if (messageInput && !messageInput.disabled) {
            messageInput.focus();
          }
        }, 100);
      }
    });
  });

  pinButtons.forEach(btn => {
    const agentId = btn.getAttribute('data-agent-id');
    const isPinned = Boolean(
      agentId &&
      window.MultiChatManager &&
      typeof window.MultiChatManager.isOpen === 'function' &&
      window.MultiChatManager.isOpen(agentId)
    );
    btn.classList.toggle('chat-tile__pin-btn--active', isPinned);

    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const id = btn.getAttribute('data-agent-id');
      const name = btn.getAttribute('data-agent-name') || 'Agent';
      const externalProvider = btn.getAttribute('data-agent-external-provider') || '';
      const pinned = pinChatToSidePanel(id, name, externalProvider);
      btn.classList.toggle('chat-tile__pin-btn--active', pinned);

      if (id && id === selectedAgentId) {
        updateMainPinButtonState();
      }
    });
  });
}

function bindAgentListStatusFilters() {
  document.querySelectorAll('[data-agent-status-filter]').forEach((btn) => {
    if (btn.dataset.filterBound === 'true') return;
    btn.dataset.filterBound = 'true';
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const targetFilter = btn.getAttribute('data-agent-status-filter') || 'all';
      const nextFilter = (targetFilter !== 'all' && agentListStatusFilter === targetFilter)
        ? 'all'
        : targetFilter;
      setAgentListStatusFilter(nextFilter);
      if (isMobileListOnlyMode()) {
        setMobileListExpanded(true);
      }
    });
  });
  syncAgentListFilterControls();
}

function bindAgentListSearch() {
  bindAgentListStatusFilters();
  const searchInput = document.getElementById('agentListSearchInput');
  if (!searchInput || searchInput.dataset.bound === 'true') {
    return;
  }

  searchInput.dataset.bound = 'true';
  searchInput.setAttribute('autocomplete', 'off');
  searchInput.setAttribute('autocorrect', 'off');
  searchInput.setAttribute('autocapitalize', 'none');
  searchInput.setAttribute('spellcheck', 'false');
  searchInput.setAttribute('data-lpignore', 'true');
  searchInput.setAttribute('data-1p-ignore', 'true');
  searchInput.setAttribute('data-bwignore', 'true');
  searchInput.value = agentListSearchQuery;

  // Autocomplete="off" is advisory, and some browsers/password managers
  // populate search inputs after the page has loaded. Keep the field locked
  // until the user explicitly taps, clicks, or tabs to it so a saved secret
  // cannot appear merely from opening the agent list.
  const unlockSearchInput = () => {
    searchInput.readOnly = false;
  };
  if (!agentListSearchQuery) {
    searchInput.value = '';
    searchInput.readOnly = true;
  }
  searchInput.addEventListener('pointerdown', unlockSearchInput);
  searchInput.addEventListener('focus', unlockSearchInput);

  // Some mobile browsers/password managers can autofill the first visible
  // search-like field with the account email after page load. If the user has
  // not started an agent-list search, keep this field empty by default.
  [0, 50, 100, 250, 500, 1000].forEach((delay) => {
    setTimeout(() => {
      if (!agentListSearchQuery && searchInput.value) {
        searchInput.value = '';
      }
    }, delay);
  });

  searchInput.addEventListener('input', (event) => {
    agentListSearchQuery = String(event.target.value || '');
    updateAgentListPanel(currentAgentList);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      searchInput.value = '';
      agentListSearchQuery = '';
      updateAgentListPanel(currentAgentList);
    }
  });
}

/**
 * Translate agent metadata into status copy/colors
 */
function getStatusFromMetadata({ priority, unread, isWorking, availability }) {
  if (priority === 'high') {
    return { label: 'Needs Attention', className: 'status-pill--danger' };
  }
  if (unread && unread > 0) {
    return { label: 'Awaiting Reply', className: 'status-pill--warn' };
  }
  if (isWorking) {
    return { label: 'Working', className: 'status-pill--warn' };
  }
  if (availability === 'offline') {
    return { label: 'Disconnected', className: 'status-pill--danger' };
  }
  if (availability === 'idle') {
    return { label: 'Away', className: 'status-pill--neutral' };
  }
  if (priority === 'normal') {
    return { label: 'Connected', className: 'status-pill--ok' };
  }
  return { label: 'Online', className: 'status-pill--ok' };
}

function describePriority(priority) {
  if (priority === 'high') {
    return 'High · Respond as soon as possible';
  }
  if (priority === 'normal') {
    return 'Normal · Check within 1 hour';
  }
  if (priority === 'low') {
    return 'Low · Review when convenient';
  }
  return 'Priority not set';
}

function describeUnread(unread = 0) {
  if (!unread || unread <= 0) {
    return 'Inbox Clear';
  }
  const suffix = unread === 1 ? 'item awaiting reply' : 'items awaiting reply';
  return `${unread} ${suffix}`;
}

function updateConversationMeta(timestamp) {
  const el = document.getElementById('conversationLastSeen');
  if (!el) {
    return;
  }
  el.textContent = timestamp
    ? `Last activity ${formatRelativeTime(timestamp)}`
    : 'Awaiting first message';
}

/**
 * Set up event handlers for agent selection (Council Chamber version)
 */
function setupAgentSelectionHandlers() {
  const agentSeats = document.querySelectorAll('.agent-seat');

  agentSeats.forEach(seat => {
    seat.addEventListener('click', (e) => {
      if (Date.now() < suppressSeatClickUntil) {
        return;
      }

      const agentId = seat.getAttribute('data-agent-id');
      const agentName = seat.getAttribute('data-agent-name');
      const metadata = {
        priority: seat.getAttribute('data-agent-priority'),
        agentType: seat.getAttribute('data-agent-type') || 'standard',
        externalProvider: seat.getAttribute('data-agent-external-provider') || '',
        unread: Number(seat.getAttribute('data-agent-unread') || 0),
        lastActivity: seat.getAttribute('data-agent-last-activity'),
        isWorking: seat.getAttribute('data-agent-working') === 'true',
        lastHeartbeat: seat.getAttribute('data-agent-last-heartbeat'),
        shouldCollapse: true
      };

      // If clicking on the already selected agent, show floating context menu (only for real mouse clicks)
      if (agentId === selectedAgentId) {
        if (e.isTrusted) {
          showFloatingAgentMenu(e, seat);
        }
        return;
      }

      // Hide floating menu when selecting a different agent
      hideFloatingAgentMenu();
      const shouldFocusSidePanel = shouldSelectIntoSidePanel(agentId, metadata);

      document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
      seat.classList.add('agent-seat--selected');

      // Sync focus index if clicked manually
      const seats = getVisibleAgentSeats();
      const index = seats.indexOf(seat);
      if (index !== -1) {
        // Apply slide animation for mouse clicks (same as keyboard navigation)
        const conversationArea = document.getElementById('conversationArea');
        if (conversationArea && previousFocusedIndex !== -1 && previousFocusedIndex !== index) {
          const totalSeats = seats.length;
          const forward = (index - previousFocusedIndex + totalSeats) % totalSeats;
          const backward = (previousFocusedIndex - index + totalSeats) % totalSeats;

          // Remove any existing animation classes
          conversationArea.classList.remove('slide-in-right', 'slide-in-left');

          // Add appropriate animation class based on shortest path
          if (forward <= backward) {
            // Moving clockwise - slide from right
            conversationArea.classList.add('slide-in-right');
          } else {
            // Moving counter-clockwise - slide from left
            conversationArea.classList.add('slide-in-left');
          }

          // Remove animation class after animation completes
          setTimeout(() => {
            conversationArea.classList.remove('slide-in-right', 'slide-in-left');
          }, 200);
        }

        // Update previous and current focus index
        previousFocusedIndex = index;
        focusedAgentIndex = index;
        // Update visual focus immediately without triggering click again
        document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--focused'));
        seat.classList.add('agent-seat--focused');
      }

      openAgentWithFeedback(agentId, agentName, metadata);

      // Focus the message input for real mouse clicks (not programmatic clicks from keyboard nav)
      if (e.isTrusted && !shouldFocusSidePanel) {
        setTimeout(() => {
          const messageInput = document.getElementById('userMessageInput');
          if (messageInput && !messageInput.disabled) {
            messageInput.focus();
          }
        }, 100);
      }
    });
  });
}

function findCouncilGroupDropTarget(x, y) {
  return Array.from(document.querySelectorAll('.group-seat[data-group-id], .agent-list-group-header[data-group-id]'))
    .find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null;
}

function highlightCouncilGroupDropTarget(target) {
  document.querySelectorAll('.council-group-drop-target').forEach(element => {
    if (element !== target) element.classList.remove('council-group-drop-target');
  });
  target?.classList.add('council-group-drop-target');
}

const pendingCouncilGroupAdds = new Set();
async function addAgentToCouncilGroup(agentId, groupId) {
  const group = currentGroups.find(item => item.groupId === groupId);
  const key = `${groupId}:${agentId}`;
  if (!group || !currentAgentList.some(agent => agent.agentId === agentId) ||
      (group.memberIds || []).includes(agentId) || pendingCouncilGroupAdds.has(key)) return;
  pendingCouncilGroupAdds.add(key);
  try {
    const response = await csrfFetch(`/api/user/groups/${encodeURIComponent(groupId)}/members`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
      body: JSON.stringify({ agentIds: [agentId] })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || 'Could not add the agent to this group.');
    }
    group.memberIds = [...new Set([...(group.memberIds || []), agentId])];
    cachedGroupPartition = null;
    updateAgentListUI(currentAgentList);
    showSuccessMessage(`Agent added to ${group.groupName}`);
    return true;
  } catch (error) {
    showErrorMessage(error.message || 'Could not update the group. Please try again.');
  } finally {
    pendingCouncilGroupAdds.delete(key);
  }
}

function setupOrbitDragHandlers() {
  if (orbitDragHandlersInitialized) {
    return;
  }

  const agentSeatsContainer = document.getElementById('agentSeats');
  if (!agentSeatsContainer) {
    return;
  }

  agentSeatsContainer.addEventListener('pointerdown', handleOrbitPointerDown);
  document.addEventListener('pointermove', handleOrbitPointerMove);
  document.addEventListener('pointerup', handleOrbitPointerUp);
  document.addEventListener('pointercancel', handleOrbitPointerUp);

  orbitDragHandlersInitialized = true;
}

function handleOrbitPointerDown(event) {
  const seat = event.target.closest('.agent-seat');
  if (!seat) {
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  const agentId = seat.getAttribute('data-agent-id');
  const ringKey = seat.getAttribute('data-agent-ring') || 'idle';

  if (!agentId) {
    return;
  }

  orbitDragState = {
    agentId,
    ringKey,
    seat,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false
  };

  seat.setPointerCapture(event.pointerId);
}

function handleOrbitPointerMove(event) {
  if (!orbitDragState) {
    return;
  }
  if (event.pointerId !== orbitDragState.pointerId) return;

  const { seat, ringKey, startX, startY } = orbitDragState;
  const distance = Math.hypot(event.clientX - startX, event.clientY - startY);

  if (!orbitDragState.active && distance < ORBIT_DRAG_THRESHOLD) {
    return;
  }

  if (!orbitDragState.active) {
    orbitDragState.active = true;
    seat.classList.add('agent-seat--dragging');
    document.body.classList.add('orbit-dragging');
    suppressSeatClickUntil = Date.now() + 250;

    // Show drop zone if screen is wide enough
    if (window.innerWidth >= 768) {
      const overlay = document.getElementById('chatAreaDropOverlay');
      if (overlay) overlay.classList.add('dropzone-active');
    }
  }

  // Check if over drop zone
  if (window.innerWidth >= 768) {
    const dropContainer = document.querySelector('.chat-drop-container');
    const overlay = document.getElementById('chatAreaDropOverlay');
    if (dropContainer && overlay) {
      const dropRect = dropContainer.getBoundingClientRect();
      if (event.clientX >= dropRect.left && event.clientX <= dropRect.right &&
        event.clientY >= dropRect.top && event.clientY <= dropRect.bottom) {
        overlay.classList.add('dropzone-hover');
      } else {
        overlay.classList.remove('dropzone-hover');
      }
    }
  }

  // Pointer events can exceed the display refresh rate. Coalescing prevents
  // repeated geometry reads/style writes from making a large orbit feel sticky.
  orbitDragState.lastX = event.clientX;
  orbitDragState.lastY = event.clientY;
  if (orbitDragFrame) return;
  orbitDragFrame = requestAnimationFrame(() => {
    orbitDragFrame = null;
    if (!orbitDragState?.active) return;
    const rect = getOrbitContainerRect();
    if (!rect) return;
    const { seat: activeSeat, ringKey: activeRingKey, lastX, lastY } = orbitDragState;
    highlightCouncilGroupDropTarget(findCouncilGroupDropTarget(lastX, lastY));
    const angle = Math.atan2((lastY - (rect.top + rect.height / 2)) / (rect.height * getOrbitSquashValue()), (lastX - (rect.left + rect.width / 2)) / rect.width);
    const radius = ORBIT_CONFIG.ringRadii[activeRingKey] ?? ORBIT_CONFIG.ringRadii.idle;
    const squash = getOrbitSquashValue();
    activeSeat.style.left = `${50 + radius * Math.cos(angle)}%`;
    activeSeat.style.top = `${50 + radius * Math.sin(angle) * squash}%`;
  });
}

function handleOrbitPointerUp(event) {
  if (!orbitDragState) {
    return;
  }
  if (event.pointerId !== orbitDragState.pointerId) return;

  const { seat, ringKey, agentId, active, pointerId } = orbitDragState;
  const groupTarget = active && event.type !== 'pointercancel'
    ? findCouncilGroupDropTarget(event.clientX, event.clientY) : null;
  highlightCouncilGroupDropTarget(null);

  if (seat.hasPointerCapture(pointerId)) {
    seat.releasePointerCapture(pointerId);
  }
  if (orbitDragFrame) {
    cancelAnimationFrame(orbitDragFrame);
    orbitDragFrame = null;
  }

  seat.classList.remove('agent-seat--dragging');
  document.body.classList.remove('orbit-dragging');

  orbitDragState = null;

  const overlay = document.getElementById('chatAreaDropOverlay');
  let droppedOnChat = false;
  if (overlay) {
    if (overlay.classList.contains('dropzone-hover')) {
      droppedOnChat = true;
    }
    overlay.classList.remove('dropzone-active', 'dropzone-hover');
  }

  if (!active) {
    return;
  }

  if (event.type === 'pointercancel') {
    updateAgentListUI(currentAgentList);
    return;
  }
  if (groupTarget) {
    updateAgentListUI(currentAgentList);
    void addAgentToCouncilGroup(agentId, groupTarget.dataset.groupId);
    return;
  }

  if (droppedOnChat && window.innerWidth >= 768 && window.MultiChatManager) {
    const agentName = seat.getAttribute('data-agent-name') || 'Agent';
    const externalProvider = seat.getAttribute('data-agent-external-provider') || '';
    window.MultiChatManager.openSidePanel(agentId, agentName, { externalProvider });
    updateAgentListUI(currentAgentList); // Reset seat back to orbit
    return;
  }

  const rect = getOrbitContainerRect();
  if (!rect || !currentOrbitLayout) {
    updateAgentListUI(currentAgentList);
    return;
  }

  const orbitOrder = [...(currentOrbitLayout.order || [])];
  const total = orbitOrder.length;

  if (total < 2) {
    updateAgentListUI(currentAgentList);
    return;
  }

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const degrees = Math.atan2((event.clientY - centerY) / (rect.height * getOrbitSquashValue()), (event.clientX - centerX) / rect.width) * 180 / Math.PI;
  const angleFromTop = (degrees + 90 + 360) % 360;
  // Groups occupy slots too. Find the closest actual agent angle rather than
  // assuming that the visible agents alone fill the circle.
  let targetIndex = 0;
  let closestAngle = Infinity;
  orbitOrder.forEach((id, index) => {
    const angle = ((currentOrbitLayout.layout.get(id)?.angle ?? (index * 360 / total - 90)) + 90 + 360) % 360;
    const distance = Math.abs(angleFromTop - angle);
    const circularDistance = Math.min(distance, 360 - distance);
    if (circularDistance < closestAngle) { closestAngle = circularDistance; targetIndex = index; }
  });
  const fromIndex = orbitOrder.indexOf(agentId);

  if (fromIndex === -1 || targetIndex === fromIndex) {
    updateAgentListUI(currentAgentList);
    return;
  }

  orbitOrder.splice(fromIndex, 1);
  orbitOrder.splice(targetIndex, 0, agentId);

  const visibleIds = new Set(orbitOrder);
  const sortedPositions = currentAgentList
    .filter(agent => visibleIds.has(agent.agentId))
    .map(agent => Number.isFinite(agent.position) ? agent.position : Number(agent.position))
    .filter(position => Number.isInteger(position) && position > 0)
    .sort((a, b) => a - b);

  const positionsForOrder = sortedPositions.length === orbitOrder.length && new Set(sortedPositions).size === sortedPositions.length
    ? sortedPositions
    : (() => {
      const reserved = new Set(currentAgentList.filter(agent => !visibleIds.has(agent.agentId)).map(agent => Number(agent.position)));
      let next = 1;
      return orbitOrder.map(() => { while (reserved.has(next)) next++; return next++; });
    })();

  const updates = orbitOrder.map((id, index) => ({
    agentId: id,
    position: positionsForOrder[index]
  }));

  applyOrbitPositionUpdates(updates);
}

function setupSidebarDragHandlers() {
  const sidebar = document.getElementById('agentListScroll');
  const dropOverlay = document.getElementById('chatAreaDropOverlay');
  const dropContainer = document.querySelector('.chat-drop-container');

  if (!sidebar || !dropOverlay || !dropContainer) return;

  sidebar.addEventListener('dragover', event => {
    const group = event.target.closest('.agent-list-group-header[data-group-id]');
    if (!group || !Array.from(event.dataTransfer.types || []).includes('application/json')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    highlightCouncilGroupDropTarget(group);
  });
  sidebar.addEventListener('dragleave', event => {
    if (!event.target.closest('.council-group-drop-target')?.contains(event.relatedTarget)) highlightCouncilGroupDropTarget(null);
  });
  sidebar.addEventListener('drop', event => {
    const group = event.target.closest('.agent-list-group-header[data-group-id]');
    highlightCouncilGroupDropTarget(null);
    if (!group) return;
    try {
      const data = JSON.parse(event.dataTransfer.getData('application/json'));
      if (!data.agentId) return;
      event.preventDefault();
      void addAgentToCouncilGroup(data.agentId, group.dataset.groupId);
    } catch (_) { /* Ignore files and unrelated drag data. */ }
  });

  sidebar.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.agent-list-item');
    if (!item || shouldSuppressPinControlsForMobile()) return;

    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify({
      agentId: item.getAttribute('data-agent-id'),
      agentName: item.getAttribute('data-agent-name'),
      externalProvider: item.getAttribute('data-agent-external-provider')
    }));

    item.classList.add('agent-list-item--dragging');
    dropOverlay.classList.add('dropzone-active');
  });

  sidebar.addEventListener('dragend', (e) => {
    highlightCouncilGroupDropTarget(null);
    const item = e.target.closest('.agent-list-item');
    if (item) item.classList.remove('agent-list-item--dragging');
    dropOverlay.classList.remove('dropzone-active', 'dropzone-hover');
  });

  dropContainer.addEventListener('dragover', (e) => {
    if (shouldSuppressPinControlsForMobile()) return;
    const isFileDrag = e.dataTransfer.types && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list'));
    if (isFileDrag) return; // Don't highlight dropzone for files being dropped to upload

    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = 'copy';
    dropOverlay.classList.add('dropzone-hover');
  });

  dropContainer.addEventListener('dragleave', (e) => {
    if (!dropContainer.contains(e.relatedTarget)) {
      dropOverlay.classList.remove('dropzone-hover');
    }
  });

  dropContainer.addEventListener('drop', (e) => {
    if (shouldSuppressPinControlsForMobile()) return;
    const isFileDrag = e.dataTransfer.types && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list'));
    if (isFileDrag) return;

    e.preventDefault();
    dropOverlay.classList.remove('dropzone-active', 'dropzone-hover');

    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data && data.agentId && window.MultiChatManager) {
        window.MultiChatManager.openSidePanel(data.agentId, data.agentName, { externalProvider: data.externalProvider });
      }
    } catch (err) {
      console.error('[MultiChat Drop] Failed to parse dropped agent data:', err);
    }
  });
}

function getOrbitContainerRect() {
  const container = document.getElementById('agentSeats');
  if (!container) {
    return null;
  }
  return container.getBoundingClientRect();
}

function applyOrbitPositionUpdates(updates) {
  const revision = ++orbitPositionRevision;
  for (const agent of currentAgentList) {
    if (!pendingOrbitPositions.has(agent.agentId)) confirmedOrbitPositions.set(agent.agentId, agent.position);
  }
  updates.forEach(update => pendingOrbitPositions.set(update.agentId, { position: update.position, revision }));
  const render = () => {
    agentListCache.agents = currentAgentList;
    agentListCache.timestamp = Date.now();
    cachedGroupPartition = null;
    updateAgentListUI(currentAgentList);
  };
  currentAgentList = currentAgentList.map(agent => {
    const pending = pendingOrbitPositions.get(agent.agentId);
    return pending ? { ...agent, position: pending.position } : agent;
  });
  render(); // The drop responds immediately, including on a slow connection.
  orbitPositionSave = orbitPositionSave.then(async () => {
    try {
      const response = await csrfFetch('/api/user/agents/positions', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
        body: JSON.stringify({ updates })
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || 'Failed to update agent positions');
      }
      updates.forEach(update => confirmedOrbitPositions.set(update.agentId, update.position));
    } catch (error) {
      currentAgentList = currentAgentList.map(agent => pendingOrbitPositions.get(agent.agentId)?.revision === revision
        ? { ...agent, position: confirmedOrbitPositions.get(agent.agentId) } : agent);
      showErrorMessage(error.message || 'Failed to update agent positions.');
    } finally {
      updates.forEach(update => {
        if (pendingOrbitPositions.get(update.agentId)?.revision === revision) pendingOrbitPositions.delete(update.agentId);
      });
      render();
    }
  });
  return orbitPositionSave;
}

/**
 * Show the floating agent menu near the clicked agent
 */
function showFloatingAgentMenu(event, seatElement) {
  if (!seatElement) return;
  const agentId = seatElement.getAttribute('data-agent-id');
  const metadata = {
    lastHeartbeat: seatElement.getAttribute('data-agent-last-heartbeat') || '',
    isWorking: seatElement.getAttribute('data-agent-working') === 'true'
  };

  if (agentId) {
    refreshAgentActionStats(agentId, metadata, { force: true });
  }

  positionFloatingAgentMenu(seatElement.getBoundingClientRect(), agentId);

  if (event?.stopPropagation) {
    event.stopPropagation();
  }
}

function positionFloatingAgentMenu(rect, agentId = null) {
  if (!rect) return;
  const agent = findCachedAgentRecord(agentId);
  updateAgentCliMenuButton('floatingUpdateAgentBtn', agentId);
  const seat = findAgentSeat(agentId);
  window.AgentActionsUI?.position(rect, agentId, {
    name: agent?.name || seat?.dataset.agentName || selectedAgentName || 'Agent',
    shareable: (agent?.agentType || seat?.dataset.agentType || selectedAgentType) !== 'news_feed'
  });
}

function findAgentSeat(agentId) {
  if (!agentId) return null;
  const seats = document.querySelectorAll('.agent-seat[data-agent-id]');
  for (const seat of seats) {
    if (seat.getAttribute('data-agent-id') === agentId) return seat;
  }
  return null;
}

function findCachedAgentRecord(agentId) {
  if (!agentId) return null;

  const fromCurrent = Array.isArray(currentAgentList)
    ? currentAgentList.find((agent) => agent.agentId === agentId)
    : null;
  if (fromCurrent) return fromCurrent;

  const cachedAgents = Array.isArray(agentListCache?.agents) ? agentListCache.agents : [];
  return cachedAgents.find((agent) => agent.agentId === agentId) || null;
}

function resolveAgentStatsMetadata(agentId, metadata = {}) {
  const seat = findAgentSeat(agentId);
  const cached = findCachedAgentRecord(agentId);
  const contacts = [metadata.lastHeartbeat, cached?.lastSeenAt, cached?.lastWorkingHeartbeatTime,
    seat?.getAttribute('data-agent-last-seen'), seat?.getAttribute('data-agent-last-heartbeat')];
  const lastHeartbeat = contacts.filter(value => Number.isFinite(Date.parse(value)))
    .reduce((latest, value) => !latest || Date.parse(value) > Date.parse(latest) ? value : latest, '');

  return {
    ...metadata,
    lastHeartbeat
  };
}

function getAgentMenuStatsSections(targetMenus = []) {
  if (targetMenus.length > 0) {
    return targetMenus
      .map((menu) => menu?.querySelector?.('.agent-menu-stats'))
      .filter(Boolean);
  }
  return Array.from(document.querySelectorAll('.agent-menu-stats'));
}

function updateAgentMenuStatsDisplay({
  messageCount = '\u2014',
  lastHeartbeat = '\u2014',
  visibleChars = '\u2014',
  lastPoll = '\u2014',
  parent = '\u2014',
  children = '\u2014',
  machineName = '\u2014',
  machineIp = '\u2014',
  folderName = '\u2014',
  projectPath = '\u2014',
  folderPath = '\u2014'
}, targetMenus = []) {
  const sections = getAgentMenuStatsSections(targetMenus);
  sections.forEach((section) => {
    const messageCountEl = section.querySelector('[data-agent-stat="message-count"]');
    const lastHeartbeatEl = section.querySelector('[data-agent-stat="last-heartbeat"]');
    const visibleCharsEl = section.querySelector('[data-agent-stat="visible-chars"]');
    const lastPollEl = section.querySelector('[data-agent-stat="last-poll"]');
    const parentEl = section.querySelector('[data-agent-stat="parent"]');
    const childrenEl = section.querySelector('[data-agent-stat="children"]');
    const machineNameEl = section.querySelector('[data-agent-stat="machine-name"]');
    const machineIpEl = section.querySelector('[data-agent-stat="machine-ip"]');
    const folderNameEl = section.querySelector('[data-agent-stat="folder-name"]');
    const projectPathEl = section.querySelector('[data-agent-stat="project-path"]');
    const folderPathEl = section.querySelector('[data-agent-stat="folder-path"]');
    if (messageCountEl) messageCountEl.textContent = messageCount;
    if (lastHeartbeatEl) lastHeartbeatEl.textContent = lastHeartbeat;
    if (visibleCharsEl) visibleCharsEl.textContent = visibleChars;
    if (lastPollEl) lastPollEl.textContent = lastPoll;
    if (parentEl) parentEl.textContent = parent;
    if (childrenEl) childrenEl.textContent = children;
    if (machineNameEl) machineNameEl.textContent = machineName;
    if (machineIpEl) machineIpEl.textContent = machineIp;
    if (folderNameEl) folderNameEl.textContent = folderName;
    if (projectPathEl) projectPathEl.textContent = projectPath;
    if (folderPathEl) folderPathEl.textContent = folderPath;
  });
}

function formatAgentStatsHeartbeat(lastHeartbeat) {
  if (!lastHeartbeat) return 'No heartbeat yet';
  const asDate = new Date(lastHeartbeat);
  if (Number.isNaN(asDate.getTime())) return 'No heartbeat yet';
  return formatRelativeTime(lastHeartbeat);
}

function calculateConversationVisibilityStats(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let visibleChars = 0;

  for (const message of list) {
    if (!message || message.hiddenFromAgent === true) continue;
    if (typeof message.content === 'string') {
      visibleChars += message.content.length;
    }
  }

  return {
    totalMessages: list.length,
    visibleChars
  };
}

function formatAgentStatsNumber(value) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return new Intl.NumberFormat().format(safeValue);
}

function getVisibleAgentActionMenus() {
  const floatingMenu = document.getElementById('floatingAgentMenu');
  const headerMenu = document.getElementById('agentContextMenu');
  const menus = [floatingMenu, headerMenu].filter(Boolean);
  return menus.filter((menu) => !menu.classList.contains('hidden'));
}

function refreshVisibleAgentActionStats(metadata = {}) {
  if (!selectedAgentId) return;
  const visibleMenus = getVisibleAgentActionMenus();
  if (visibleMenus.length === 0) return;
  refreshAgentActionStats(selectedAgentId, metadata, { targetMenus: visibleMenus });
}

async function refreshAgentActionStats(agentId, metadata = {}, options = {}) {
  renderAgentGroupMembership(agentId);
  if (!agentId) {
    updateAgentMenuStatsDisplay({});
    return;
  }

  const targetMenus = Array.isArray(options.targetMenus) && options.targetMenus.length > 0
    ? options.targetMenus
    : getVisibleAgentActionMenus();
  if (!options.force && targetMenus.length === 0) {
    return;
  }

  const resolvedMetadata = resolveAgentStatsMetadata(agentId, metadata);
  const heartbeatText = formatAgentStatsHeartbeat(resolvedMetadata.lastHeartbeat);

  const requestToken = ++activeAgentStatsRequestToken;
  updateAgentMenuStatsDisplay({
    messageCount: '...',
    lastHeartbeat: heartbeatText,
    visibleChars: '...',
    lastPoll: '...',
    parent: '...',
    children: '...',
    machineName: '...',
    machineIp: '...',
    folderName: '...',
    projectPath: '...',
    folderPath: '...'
  }, targetMenus);

  // Fetch messages, lineage, and runtime details in parallel.
  let messages = conversationCache.get(agentId);
  const lineagePromise = fetch(`/api/user/agents/${agentId}/lineage`).then(r => r.ok ? r.json() : null).catch(() => null);
  const runtimePromise = fetch(`/api/user/agents/${agentId}/details`).then(r => r.ok ? r.json() : null).catch(() => null);

  if (!Array.isArray(messages)) {
    try {
      const response = await fetch(`/api/user/messages/${agentId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      messages = Array.isArray(data?.messages) ? data.messages : [];
      conversationCache.set(agentId, messages);
    } catch (error) {
      console.warn('[AgentStats] Failed to load menu stats messages:', error);
      if (requestToken !== activeAgentStatsRequestToken) return;
      updateAgentMenuStatsDisplay({
        messageCount: 'Unavailable',
        lastHeartbeat: heartbeatText,
        visibleChars: 'Unavailable',
        lastPoll: '\u2014',
        parent: '\u2014',
        children: '\u2014',
        machineName: '\u2014',
        machineIp: '\u2014',
        folderName: '\u2014',
        projectPath: '\u2014',
        folderPath: '\u2014'
      }, targetMenus);
      return;
    }
  }

  const lineage = await lineagePromise;
  const runtimeDetails = await runtimePromise;

  if (requestToken !== activeAgentStatsRequestToken) return;

  const stats = calculateConversationVisibilityStats(messages);
  const lastPollText = lineage?.lastPollAt ? formatRelativeTime(lineage.lastPollAt) : '\u2014';
  const parentText = lineage?.parent ? lineage.parent.agentName : 'None';
  const childrenText = lineage?.children?.length > 0
    ? lineage.children.map(c => c.agentName).join(', ')
    : 'None';
  const machineNameText = runtimeDetails?.machineName || '\u2014';
  const machineIpText = runtimeDetails?.machineIp || '\u2014';
  const folderNameText = runtimeDetails?.folderName || '\u2014';
  const projectPathText = runtimeDetails?.projectPath || '\u2014';
  const folderPathText = runtimeDetails?.folderPath || '\u2014';

  updateAgentMenuStatsDisplay({
    messageCount: formatAgentStatsNumber(stats.totalMessages),
    lastHeartbeat: heartbeatText,
    visibleChars: formatAgentStatsNumber(stats.visibleChars),
    lastPoll: lastPollText,
    parent: parentText,
    children: childrenText,
    machineName: machineNameText,
    machineIp: machineIpText,
    folderName: folderNameText,
    projectPath: projectPathText,
    folderPath: folderPathText
  }, targetMenus);
}

/**
 * Open the floating actions menu for a specific agent.
 * Used by side-chat tiles so they can access the same actions menu as main chat.
 */
async function openFloatingAgentMenuForAgent(agentId, agentName, metadata = {}, anchorEl = null) {
  if (!agentId) return;

  const seat = findAgentSeat(agentId);
  const fallbackName = seat?.getAttribute('data-agent-name') || '';
  const resolvedName = agentName || metadata.agentName || fallbackName || 'Agent';
  const resolvedMetadata = resolveAgentStatsMetadata(agentId, {
    ...metadata,
    lastHeartbeat:
      metadata.lastHeartbeat ||
      seat?.getAttribute('data-agent-last-heartbeat') ||
      ''
  });
  const resolvedMeta = {
    ...resolvedMetadata,
    agentName: resolvedName,
    externalProvider: metadata.externalProvider || seat?.getAttribute('data-agent-external-provider') || '',
    forceMainSelection: true
  };

  // Selecting a chat collapses the mobile list, so remember the pressed icon's
  // bounds before it becomes hidden.
  const anchorRect = anchorEl?.getBoundingClientRect?.() || seat?.getBoundingClientRect?.();

  if (selectedAgentId !== agentId || selectedAgentName !== resolvedName) {
    await selectAgent(agentId, resolvedName, resolvedMeta);
  }

  refreshAgentActionStats(agentId, resolvedMeta, { force: true });
  if (anchorRect) {
    positionFloatingAgentMenu(anchorRect, agentId);
  }
}

/**
 * Hide the floating agent menu
 */
function hideFloatingAgentMenu() {
  const floatingMenu = document.getElementById('floatingAgentMenu');
  if (floatingMenu) {
    floatingMenu.classList.add('hidden');
    delete floatingMenu.dataset.agentId;
  }
  activeAgentStatsRequestToken += 1;
}

/**
 * Initialize the free-text composer controls
 */
function setupMessageComposer() {
  userMessageForm = document.getElementById('userMessageForm');
  userMessageInput = document.getElementById('userMessageInput');
  userMessageSendButton = document.getElementById('userMessageSend');
  voiceInputBtn = document.getElementById('voiceInputBtn');
  const messageInputArea = document.getElementById('messageInputArea');

  if (userMessageForm) {
    userMessageForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (selectedChatContext?.mode !== 'shared' && !userMessageInput?.value.trim() && pendingImages.length === 0 && selectedAgentId && selectedAgentType !== 'news_feed') {
        openScheduleMessageActions();
        return;
      }
      await sendUserMessage();
    });
  }

  setupScheduledMessageHold();

  if (userMessageInput) {
    userMessageInput.addEventListener('input', () => {
      updateComposerState();
      ensureMobileComposerVisible({ restoreChrome: true });
      requestAnimationFrame(syncMobileComposerLayout);
    });

    userMessageInput.addEventListener('focus', () => {
      preserveMobileConversationScroll();
      ensureMobileComposerVisible({ restoreChrome: true });
      collapseMainInteractiveSpaceForMobileFocus();
      requestAnimationFrame(syncMobileComposerLayout);
      requestAnimationFrame(() => preserveMobileConversationScroll());
    });

    // Add Ctrl+Enter to send
    userMessageInput.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!userMessageSendButton.disabled) {
          await sendUserMessage();
        }
        return;
      }

      // Arrow key message history (without Ctrl = history, with Ctrl = scroll)
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey) {
        const history = messageHistoryMap.get(selectedAgentId) || [];
        if (history.length === 0) return; // no history, let default behavior

        // Only intercept when input is empty or already browsing history
        if (messageHistoryIndex === -1 && userMessageInput.value.trim() !== '') return;

        e.preventDefault();

        if (e.key === 'ArrowUp') {
          if (messageHistoryIndex === -1) {
            // Start browsing: save current draft
            messageHistoryDraft = userMessageInput.value;
            messageHistoryIndex = 0;
          } else if (messageHistoryIndex < history.length - 1) {
            messageHistoryIndex++;
          }
          userMessageInput.value = history[messageHistoryIndex];
        } else { // ArrowDown
          if (messageHistoryIndex === -1) return;
          if (messageHistoryIndex > 0) {
            messageHistoryIndex--;
            userMessageInput.value = history[messageHistoryIndex];
          } else {
            // Back to draft
            messageHistoryIndex = -1;
            userMessageInput.value = messageHistoryDraft;
          }
        }
        updateComposerState();
      }
    });
  }

  if (messageInputArea) {
    messageInputArea.addEventListener('touchstart', () => {
      ensureMobileComposerVisible({ restoreChrome: true });
    }, { passive: true });
  }

  window.addEventListener('resize', () => {
    requestAnimationFrame(syncMobileComposerLayout);
  });
  window.visualViewport?.addEventListener('resize', () => {
    requestAnimationFrame(syncMobileComposerLayout);
  });
  requestAnimationFrame(syncMobileComposerLayout);

  // Initialize image upload functionality
  setupImageUpload();

  updateComposerState();
}

const SCHEDULE_HOLD_DELAY_MS = 550;

function formatDateTimeLocal(date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

function setupScheduledMessageHold() {
  if (!userMessageSendButton || userMessageSendButton.dataset.scheduleHoldBound === 'true') return;
  userMessageSendButton.dataset.scheduleHoldBound = 'true';
  let holdTimer = null;
  let suppressNextClick = false;
  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };

  userMessageSendButton.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    cancelHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      suppressNextClick = true;
      openScheduleMessageActions();
    }, SCHEDULE_HOLD_DELAY_MS);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
    userMessageSendButton.addEventListener(eventName, cancelHold);
  });
  userMessageSendButton.addEventListener('click', (event) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

let pendingRunOverrides = null;
let pendingRunOverridesAgentId = null;
let runOverrideModelCatalog = null;
const loadedAgentConfigs = new Map();
const RUN_OVERRIDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RUN_OVERRIDE_APPROVALS = [['full-auto', 'Full auto'], ['auto-edit', 'Auto-edit'], ['suggest', 'Suggest only']];
const RUN_OVERRIDE_SANDBOXES = [['read-only', 'Read-only'], ['workspace-write', 'Workspace write'], ['none', 'No sandbox']];

function isMcpAgent(agentOrName) {
  if (!agentOrName) return false;
  if (typeof agentOrName === 'object') {
    if (String(agentOrName.externalProvider || '').toLowerCase() === 'mcp') return true;
    const name = String(agentOrName.name || agentOrName.agentName || '').trim();
    return /\bMCP(?:\s*\(\d+\))?$/i.test(name);
  }
  const key = String(agentOrName).trim();
  const match = Array.isArray(currentAgentList)
    ? currentAgentList.find((a) => a && (a.agentId === key || a.name === key))
    : null;
  if (match && String(match.externalProvider || '').toLowerCase() === 'mcp') return true;
  const checkName = match?.name || key;
  return /\bMCP(?:\s*\(\d+\))?$/i.test(String(checkName).trim());
}

function getPendingRunOverrides() {
  return pendingRunOverrides && pendingRunOverridesAgentId === selectedAgentId ? pendingRunOverrides : null;
}

function getEffectiveRunOverridesForSend() {
  const explicit = getPendingRunOverrides();
  const agentName = getResolvedSelectedAgentName();
  if (isMcpAgent(selectedAgentId) || isMcpAgent(agentName)) return explicit || null;
  const base = agentName ? loadedAgentConfigs.get(agentName) : null;
  if (!explicit && !base) return null;
  const merged = { ...(base || {}), ...(explicit || {}) };
  const normalized = {};
  if (merged.model_provider) normalized.model_provider = merged.model_provider;
  if (merged.model && normalized.model_provider) normalized.model = merged.model;
  if (merged.thinking_effort) normalized.thinking_effort = merged.thinking_effort;
  if (merged.approval_mode) normalized.approval_mode = merged.approval_mode;
  if (merged.sandbox_mode) {
    normalized.sandbox_mode = merged.sandbox_mode === 'danger-full-access' ? 'none' : merged.sandbox_mode;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function clearPendingRunOverrides() {
  pendingRunOverrides = null;
  pendingRunOverridesAgentId = null;
  if (userMessageSendButton) userMessageSendButton.removeAttribute('data-run-overrides');
}

function summarizeRunOverrides(overrides) {
  if (!overrides) return 'Agent default';
  const provider = overrides.model_provider
    ? (overrides.model ? `${overrides.model_provider} / ${overrides.model}` : overrides.model_provider)
    : null;
  return [provider, overrides.thinking_effort && `effort ${overrides.thinking_effort}`, overrides.approval_mode, overrides.sandbox_mode && `sandbox ${overrides.sandbox_mode}`]
    .filter(Boolean).join(' · ') || 'Agent default';
}

async function loadRunOverrideModels() {
  if (runOverrideModelCatalog) return runOverrideModelCatalog;
  try {
    const response = await fetch('/dashboard/models', { credentials: 'same-origin' });
    if (response.ok) {
      const data = await response.json();
      if (data?.models && typeof data.models === 'object') runOverrideModelCatalog = data.models;
    }
  } catch (error) {
    console.warn('Failed to load provider models:', error);
  }
  return runOverrideModelCatalog || { codex: [{ value: 'default', label: 'Default' }] };
}

async function openRunSettingsDialog(onDone) {
  document.getElementById('runSettingsDialog')?.remove();
  const catalog = await loadRunOverrideModels();
  const current = getPendingRunOverrides() || {};
  const option = (value, label, selected) => `<option value="${escapeScheduledMessageHtml(value)}"${selected ? ' selected' : ''}>${escapeScheduledMessageHtml(label)}</option>`;
  const select = (id, label, options) => `<label class="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400" for="${id}">${label}</label><select id="${id}" class="mt-1 min-h-11 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100">${option('', 'Agent default', !options.some((o) => o.selected))}${options.map((o) => option(o.value, o.label, o.selected)).join('')}</select>`;
  const dialog = document.createElement('div');
  dialog.id = 'runSettingsDialog';
  dialog.className = 'fixed inset-0 z-[310] flex items-end justify-center bg-slate-950/75 backdrop-blur-sm sm:items-center sm:p-4';
  dialog.innerHTML = `<div class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-t-2xl border border-emerald-400/30 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="runSettingsTitle"><h2 id="runSettingsTitle" class="text-base font-semibold text-slate-100">Run settings</h2><p class="mt-1 text-sm text-slate-400">Applies to this message only. Messages with different settings run as separate turns.</p>${select('runSettingsProvider', 'Provider', Object.keys(catalog).map((key) => ({ value: key, label: key, selected: current.model_provider === key })))}<div id="runSettingsModelWrap"></div>${select('runSettingsEffort', 'Thinking effort', RUN_OVERRIDE_EFFORTS.map((value) => ({ value, label: value, selected: current.thinking_effort === value })))}${select('runSettingsApproval', 'Approval mode', RUN_OVERRIDE_APPROVALS.map(([value, label]) => ({ value, label, selected: current.approval_mode === value })))}${select('runSettingsSandbox', 'Sandbox', RUN_OVERRIDE_SANDBOXES.map(([value, label]) => ({ value, label, selected: current.sandbox_mode === value })))}<div class="mt-5 grid gap-2"><button type="button" data-run-save class="min-h-11 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300">Use these settings</button><button type="button" data-run-reset class="min-h-11 rounded-lg bg-sky-400/10 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-sky-400/20">Use agent default</button><button type="button" data-run-cancel class="min-h-11 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button></div></div>`;
  document.body.appendChild(dialog);
  const providerSelect = dialog.querySelector('#runSettingsProvider');
  const modelWrap = dialog.querySelector('#runSettingsModelWrap');
  const renderModels = () => {
    const provider = providerSelect.value;
    if (!provider) { modelWrap.innerHTML = ''; return; }
    const models = catalog[provider] || [];
    modelWrap.innerHTML = `<label class="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400" for="runSettingsModel">Model</label><select id="runSettingsModel" class="mt-1 min-h-11 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100">${models.map((m) => option(m.value, m.label, current.model_provider === provider && current.model === m.value)).join('')}</select>`;
  };
  providerSelect.addEventListener('change', renderModels);
  renderModels();
  const close = () => { dialog.remove(); if (typeof onDone === 'function') onDone(); };
  dialog.querySelector('[data-run-cancel]').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  dialog.querySelector('[data-run-reset]').addEventListener('click', () => { clearPendingRunOverrides(); close(); });
  dialog.querySelector('[data-run-save]').addEventListener('click', () => {
    const overrides = {};
    const provider = providerSelect.value;
    if (provider) {
      overrides.model_provider = provider;
      const model = dialog.querySelector('#runSettingsModel')?.value;
      if (model) overrides.model = model;
    }
    const effort = dialog.querySelector('#runSettingsEffort').value;
    const approval = dialog.querySelector('#runSettingsApproval').value;
    const sandbox = dialog.querySelector('#runSettingsSandbox').value;
    if (effort) overrides.thinking_effort = effort;
    if (approval) overrides.approval_mode = approval;
    if (sandbox) overrides.sandbox_mode = sandbox;
    if (Object.keys(overrides).length === 0) {
      clearPendingRunOverrides();
    } else {
      pendingRunOverrides = overrides;
      pendingRunOverridesAgentId = selectedAgentId;
      if (userMessageSendButton) userMessageSendButton.setAttribute('data-run-overrides', summarizeRunOverrides(overrides));
    }
    close();
  });
}

function openScheduleMessageActions() {
  document.getElementById('scheduleMessageActionsDialog')?.remove();
  const hasMessage = Boolean(userMessageInput?.value.trim());
  const summary = summarizeRunOverrides(getPendingRunOverrides());
  const dialog = document.createElement('div');
  dialog.id = 'scheduleMessageActionsDialog';
  dialog.className = 'fixed inset-0 z-[300] flex items-end justify-center bg-slate-950/75 backdrop-blur-sm sm:items-center sm:p-4';
  dialog.innerHTML = `<div class="w-full max-w-sm rounded-t-2xl border border-emerald-400/30 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="scheduleMessageActionsTitle"><h2 id="scheduleMessageActionsTitle" class="text-base font-semibold text-slate-100">Send options</h2><p class="mt-1 text-sm text-slate-400">Choose run settings, send now, or schedule this message.</p><button type="button" data-run-settings class="mt-4 w-full min-h-11 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-700"><span class="block text-xs uppercase tracking-wide text-slate-400">Run settings</span><span class="block truncate">${escapeScheduledMessageHtml(summary)}</span></button><div class="mt-3 grid gap-3"><button type="button" data-send-now class="min-h-11 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50" ${hasMessage ? '' : 'disabled'}>Send now</button><button type="button" data-schedule-new class="min-h-11 rounded-lg bg-emerald-400/20 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-400/30 disabled:cursor-not-allowed disabled:opacity-50" ${hasMessage ? '' : 'disabled'}>Choose send time</button><button type="button" data-schedule-manage class="min-h-11 rounded-lg bg-sky-400/10 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-sky-400/20">View scheduled messages</button><button type="button" data-schedule-actions-close class="min-h-11 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button></div>${hasMessage ? '' : '<p class="mt-3 text-xs text-slate-400">Write a message first to send it or choose a send time.</p>'}</div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('[data-schedule-actions-close]').addEventListener('click', close);
  dialog.querySelector('[data-run-settings]').addEventListener('click', () => { close(); openRunSettingsDialog(openScheduleMessageActions); });
  dialog.querySelector('[data-send-now]')?.addEventListener('click', () => { close(); sendUserMessage(); });
  dialog.querySelector('[data-schedule-new]')?.addEventListener('click', () => { close(); openScheduleMessageDialog(); });
  dialog.querySelector('[data-schedule-manage]').addEventListener('click', () => { close(); openScheduledMessagesDialog(); });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
}

function openScheduleMessageDialog() {
  const content = userMessageInput?.value.trim();
  if (!selectedAgentId || !content) {
    showErrorMessage('Write a message before scheduling it.');
    return;
  }
  if (pendingImages.length > 0) {
    showErrorMessage('Scheduled messages currently support text only. Remove attachments first.');
    return;
  }
  document.getElementById('scheduleMessageDialog')?.remove();
  const dialog = document.createElement('div');
  dialog.id = 'scheduleMessageDialog';
  dialog.className = 'fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm';
  dialog.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl border border-emerald-400/30 bg-slate-900 p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="scheduleMessageTitle">
      <h2 id="scheduleMessageTitle" class="text-base font-semibold text-slate-100">Schedule message</h2>
      <p class="mt-1 text-sm text-slate-400">Choose when this message should be sent.</p>
      <p class="mt-2 truncate text-xs text-slate-400">Runs with: ${escapeScheduledMessageHtml(summarizeRunOverrides(getPendingRunOverrides()))}</p>
      <label class="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-400" for="scheduleMessageTime">Send at</label>
      <input id="scheduleMessageTime" type="datetime-local" min="${formatDateTimeLocal(new Date(Date.now() + 60_000))}" value="${formatDateTimeLocal(new Date(Date.now() + 10 * 60_000))}" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100" />
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" data-schedule-cancel class="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button type="button" data-schedule-confirm class="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300">Schedule</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('[data-schedule-cancel]').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  const confirm = dialog.querySelector('[data-schedule-confirm]');
  const timeInput = dialog.querySelector('#scheduleMessageTime');
  confirm.addEventListener('click', async () => {
    const when = new Date(timeInput.value);
    if (!timeInput.value || Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      showErrorMessage('Choose a time in the future.');
      return;
    }
    confirm.disabled = true;
    confirm.textContent = 'Scheduling...';
    try {
      let contentToSend = content;
      let isEncrypted = false;
      if (encryptionKey) {
        contentToSend = await window.E2EEncryption.encryptMessage(content, encryptionKey);
        isEncrypted = true;
      }
      const response = await csrfFetch('/api/user/messages/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ agentId: selectedAgentId, content: contentToSend, encrypted: isEncrypted, scheduledFor: when.toISOString(), ...(getPendingRunOverrides() ? { runOverrides: getPendingRunOverrides() } : {}) })
      });
      if (!response.ok) {
        throw buildRequestError(response, await readErrorPayload(response), { fallbackMessage: 'Unable to schedule message' });
      }
      userMessageInput.value = '';
      clearPendingRunOverrides();
      updateComposerState();
      close();
      window.showNotification?.(`Message scheduled for ${when.toLocaleString()}.`, 'success', 'Scheduled');
    } catch (error) {
      console.error('Error scheduling user message:', error);
      showErrorMessage(error.message || 'Unable to schedule message.');
      confirm.disabled = false;
      confirm.textContent = 'Schedule';
    }
  });
  timeInput.focus();
}

function escapeScheduledMessageHtml(value) {
  const template = document.createElement('template');
  template.textContent = value;
  return template.innerHTML;
}

async function prepareScheduledMessageForEditing(message) {
  if (!message.encrypted) return { ...message, editableContent: true };
  if (!encryptionKey || !window.E2EEncryption?.decryptMessage) {
    return { ...message, editableContent: false, content: 'Unlock encrypted chat to view or edit this message.' };
  }
  try {
    return {
      ...message,
      content: await window.E2EEncryption.decryptMessage(message.content, encryptionKey),
      editableContent: true,
      wasEncrypted: true
    };
  } catch (error) {
    console.warn('Unable to decrypt scheduled message:', error);
    return { ...message, editableContent: false, content: 'Unable to decrypt this message on this device.' };
  }
}

async function openScheduledMessagesDialog() {
  if (!selectedAgentId) return;
  document.getElementById('scheduledMessagesDialog')?.remove();
  const dialog = document.createElement('div');
  dialog.id = 'scheduledMessagesDialog';
  dialog.className = 'fixed inset-0 z-[300] flex items-end justify-center bg-slate-950/75 backdrop-blur-sm sm:items-center sm:p-4';
  dialog.innerHTML = `<div class="max-h-[calc(100dvh-1rem)] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-sky-400/30 bg-slate-900 p-5 shadow-2xl sm:max-h-[85vh] sm:rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="scheduledMessagesTitle"><div class="flex items-start justify-between gap-4"><div><h2 id="scheduledMessagesTitle" class="text-base font-semibold text-slate-100">Scheduled messages</h2><p class="mt-1 text-sm text-slate-400">Messages waiting to be sent to ${escapeScheduledMessageHtml(selectedAgentName || 'this agent')}.</p></div><button type="button" data-scheduled-close class="min-h-11 min-w-11 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">✕</button></div><div data-scheduled-list class="mt-4 space-y-3"><p class="text-sm text-slate-400">Loading scheduled messages…</p></div></div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('[data-scheduled-close]').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });
  const list = dialog.querySelector('[data-scheduled-list]');
  const load = async () => {
    list.innerHTML = '<p class="text-sm text-slate-400">Loading scheduled messages…</p>';
    try {
      const response = await csrfFetch(`/api/user/messages/scheduled?agentId=${encodeURIComponent(selectedAgentId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw buildRequestError(response, await readErrorPayload(response), { fallbackMessage: 'Unable to load scheduled messages' });
      const { scheduledMessages = [] } = await response.json();
      if (!scheduledMessages.length) { list.innerHTML = '<p class="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-4 text-sm text-slate-400">No scheduled messages for this agent.</p>'; return; }
      const editableMessages = await Promise.all(scheduledMessages.map(prepareScheduledMessageForEditing));
      list.innerHTML = editableMessages.map((message) => `<article class="rounded-xl border border-slate-700 bg-slate-800/60 p-3" data-scheduled-id="${message.scheduledMessageId}"><p class="whitespace-pre-wrap break-words text-sm text-slate-100">${escapeScheduledMessageHtml(message.content)}</p><p class="mt-2 text-xs text-sky-300">Sends ${new Date(message.scheduledFor).toLocaleString()}</p>${message.runOverrides ? `<p class="mt-1 truncate text-xs text-slate-400">Runs with: ${escapeScheduledMessageHtml(summarizeRunOverrides(message.runOverrides))}</p>` : ''}<div class="mt-3 flex gap-2"><button type="button" data-scheduled-edit class="min-h-11 flex-1 rounded-lg bg-sky-400/10 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-sky-400/20">${message.editableContent ? 'Edit message' : 'Change time'}</button><button type="button" data-scheduled-cancel class="min-h-11 rounded-lg px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-400/10">Cancel</button></div></article>`).join('');
      list.querySelectorAll('[data-scheduled-cancel]').forEach((button) => button.addEventListener('click', async () => {
        const card = button.closest('[data-scheduled-id]');
        if (!window.confirm('Cancel this scheduled message?')) return;
        button.disabled = true;
        try {
          const response = await csrfFetch(`/api/user/messages/scheduled/${card.dataset.scheduledId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': window.csrfToken }, credentials: 'same-origin' });
          if (!response.ok) throw buildRequestError(response, await readErrorPayload(response), { fallbackMessage: 'Unable to cancel scheduled message' });
          window.showNotification?.('Scheduled message cancelled.', 'success', 'Cancelled'); await load();
        } catch (error) { showErrorMessage(error.message || 'Unable to cancel scheduled message.'); button.disabled = false; }
      }));
      list.querySelectorAll('[data-scheduled-edit]').forEach((button, index) => button.addEventListener('click', () => openScheduledMessageEditDialog(editableMessages[index], load)));
    } catch (error) { list.innerHTML = `<p class="rounded-lg border border-red-400/30 bg-red-950/30 px-3 py-4 text-sm text-red-200">${escapeScheduledMessageHtml(error.message || 'Unable to load scheduled messages.')}</p>`; }
  };
  await load();
}

function openScheduledMessageEditDialog(message, onSaved) {
  document.getElementById('scheduledMessageEditDialog')?.remove();
  const dialog = document.createElement('div');
  const editableContent = message.editableContent === true;
  dialog.id = 'scheduledMessageEditDialog';
  dialog.className = 'fixed inset-0 z-[310] flex items-end justify-center bg-slate-950/80 backdrop-blur-sm sm:items-center sm:p-4';
  dialog.innerHTML = `<div class="max-h-[calc(100dvh-1rem)] w-full max-w-sm overflow-y-auto rounded-t-2xl border border-sky-400/30 bg-slate-900 p-5 shadow-2xl sm:max-h-[85vh] sm:rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="scheduledMessageEditTitle"><h2 id="scheduledMessageEditTitle" class="text-base font-semibold text-slate-100">Edit scheduled message</h2>${editableContent ? `<label class="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-400" for="editScheduledMessageContent">Message</label><textarea id="editScheduledMessageContent" rows="5" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-base text-slate-100">${escapeScheduledMessageHtml(message.content)}</textarea>` : `<p class="mt-3 text-sm text-slate-400">${escapeScheduledMessageHtml(message.content)}</p>`}<label class="mt-4 block text-xs font-medium uppercase tracking-wide text-slate-400" for="editScheduledMessageTime">Send at</label><input id="editScheduledMessageTime" type="datetime-local" min="${formatDateTimeLocal(new Date(Date.now() + 60_000))}" value="${formatDateTimeLocal(new Date(message.scheduledFor))}" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100"/><div class="mt-5 flex gap-2"><button type="button" data-edit-cancel class="min-h-11 flex-1 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button><button type="button" data-edit-save class="min-h-11 flex-1 rounded-lg bg-sky-300 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-200">Save</button></div></div>`;
  document.body.appendChild(dialog);
  const close = () => dialog.remove();
  dialog.querySelector('[data-edit-cancel]').addEventListener('click', close);
  dialog.querySelector('[data-edit-save]').addEventListener('click', async (event) => {
    const when = new Date(dialog.querySelector('#editScheduledMessageTime').value);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return showErrorMessage('Choose a time in the future.');
    const button = event.currentTarget; button.disabled = true;
    try {
      const payload = { scheduledFor: when.toISOString() };
      if (editableContent) {
        const content = dialog.querySelector('#editScheduledMessageContent').value.trim();
        if (!content) throw new Error('Write a message before saving.');
        payload.content = message.wasEncrypted ? await window.E2EEncryption.encryptMessage(content, encryptionKey) : content;
        payload.encrypted = Boolean(message.wasEncrypted);
      }
      const response = await csrfFetch(`/api/user/messages/scheduled/${message.scheduledMessageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken }, credentials: 'same-origin', body: JSON.stringify(payload) });
      if (!response.ok) throw buildRequestError(response, await readErrorPayload(response), { fallbackMessage: 'Unable to update scheduled message' });
      close(); window.showNotification?.('Scheduled message updated.', 'success', 'Updated'); await onSaved();
    } catch (error) { showErrorMessage(error.message || 'Unable to update scheduled message.'); button.disabled = false; }
  });
}

/**
 * Enable/disable composer controls based on current state
 */
function updateComposerState() {
  if (typeof window !== 'undefined' && window.MessageReplies) {
    window.MessageReplies.setContext(selectedChatContext?.conversationId || selectedAgentId);
  }
  if (!userMessageInput || !userMessageSendButton) {
    return;
  }
  if (openingChatSelection !== null) {
    userMessageSendButton.disabled = true;
    setSendButtonLabel('Opening...');
    return;
  }
  if (isSendingMessage) {
    userMessageSendButton.disabled = true;
    setSendButtonLabel('Sending...');
    return;
  }

  const hasAgent = Boolean(selectedAgentId);
  const hasContent = userMessageInput.value.trim().length > 0;
  const hasImages = pendingImages.length > 0;
  const hasSpeechSupport = window.voiceControl ? window.voiceControl.supportsSpeechRecognition : false;
  const isNewsFeed = selectedAgentType === 'news_feed';
  const hasEncryptionKey = Boolean(encryptionKey);
  // Get file input and label elements
  const imageFileInput = document.getElementById('imageFileInput');
  const imageUploadLabel = document.getElementById('imageUploadLabel');
  const generalFileInput = document.getElementById('generalFileInput');
  const generalFileUploadLabel = document.getElementById('generalFileUploadLabel');
  if (imageUploadLabel && !pendingImages.length) imageUploadLabel.style.position = '';

  // For news feed agents, show read-only activity log placeholder
  if (isNewsFeed) {
    userMessageInput.disabled = false; // Allow typing notes
    userMessageInput.placeholder = '📋 Activity Log — Type a note (agents only post here)';
    userMessageSendButton.disabled = !hasContent || isUploadingImages;
    setSendButtonLabel(isUploadingImages ? 'Uploading...' : 'Add Note');
    // Disable image upload for news feed
    if (imageFileInput) imageFileInput.disabled = true;
    if (imageUploadLabel) imageUploadLabel.classList.add('disabled');
  } else {
    userMessageInput.disabled = !hasAgent;
    userMessageInput.placeholder = hasAgent
      ? 'Write a message...'
      : 'Select an agent to start typing...';

    // Keep Send reachable for an active conversation even with an empty draft:
    // a hold (or an empty click) opens the scheduled-message manager.
    const canSend = hasAgent && (hasContent || hasImages) && !isUploadingImages;
    const canManageScheduledMessages = hasAgent && !isUploadingImages;
    userMessageSendButton.disabled = !(canSend || canManageScheduledMessages);

    // Update button text based on state
    if (isUploadingImages) {
      setSendButtonLabel('Uploading...');
      userMessageSendButton.classList.add('uploading');
    } else if (hasImages && !hasContent) {
      setSendButtonLabel(`Send ${pendingImages.length} Attachment${pendingImages.length > 1 ? 's' : ''}`);
      userMessageSendButton.classList.remove('uploading');
    } else {
      setSendButtonLabel('Send');
      userMessageSendButton.classList.remove('uploading');
    }

    // Enable/disable image upload based on agent selection and encryption key
    const canUploadImages = hasAgent && hasEncryptionKey && pendingImages.length < MAX_IMAGES_PER_MESSAGE;
    if (imageFileInput) {
      imageFileInput.disabled = !canUploadImages;
    }
    if (imageUploadLabel) {
      if (canUploadImages) {
        imageUploadLabel.classList.remove('disabled');
        imageUploadLabel.title = 'Attach images';
      } else if (!hasAgent) {
        imageUploadLabel.classList.add('disabled');
        imageUploadLabel.title = 'Select an agent first';
      } else if (!hasEncryptionKey) {
        imageUploadLabel.classList.add('disabled');
        imageUploadLabel.title = 'Set encryption password to upload images';
      } else {
        imageUploadLabel.classList.add('disabled');
        imageUploadLabel.title = `Maximum ${MAX_IMAGES_PER_MESSAGE} attachments allowed`;
      }
    }

    // Enable/disable general file upload (same logic as images)
    const canUploadFiles = hasAgent && hasEncryptionKey && pendingImages.length < MAX_IMAGES_PER_MESSAGE;
    if (generalFileInput) {
      generalFileInput.disabled = !canUploadFiles;
    }
    if (generalFileUploadLabel) {
      if (canUploadFiles) {
        generalFileUploadLabel.classList.remove('disabled');
        generalFileUploadLabel.title = 'Attach files (PDF, TXT, etc.)';
      } else if (!hasAgent) {
        generalFileUploadLabel.classList.add('disabled');
        generalFileUploadLabel.title = 'Select an agent first';
      } else if (!hasEncryptionKey) {
        generalFileUploadLabel.classList.add('disabled');
        generalFileUploadLabel.title = 'Set encryption password to upload files';
      } else {
        generalFileUploadLabel.classList.add('disabled');
        generalFileUploadLabel.title = `Maximum ${MAX_IMAGES_PER_MESSAGE} attachments allowed`;
      }
    }
  }

  if (voiceInputBtn) {
    voiceInputBtn.disabled = !hasAgent || !hasSpeechSupport || isNewsFeed;
    voiceInputBtn.title = isNewsFeed
      ? 'Voice input disabled for activity log'
      : (hasSpeechSupport
        ? ''
        : 'Voice input needs a Chromium browser (Chrome/Edge) with microphone access enabled.');
  }

  // Enable/disable stop and config buttons (disable for news feed and MCP agents)
  const stopBtn = document.getElementById('agentStopBtn');
  const configBtn = document.getElementById('agentConfigBtn');
  const configContainer = document.getElementById('agentConfigContainer');
  const isMcp = hasAgent && (isMcpAgent(selectedAgentId) || isMcpAgent(selectedAgentName));
  if (stopBtn) stopBtn.disabled = !hasAgent || isNewsFeed;
  if (configBtn) configBtn.disabled = !hasAgent || isNewsFeed || isMcp;
  const collaboratorView = selectedChatContext?.mode === 'shared' && selectedChatContext.role !== 'owner';
  if (stopBtn) stopBtn.hidden = collaboratorView;
  if (configContainer) configContainer.hidden = collaboratorView || isMcp;
  // Hide the entire config container when no agent is selected or for MCP agents
  if (configContainer) {
    if (!hasAgent || isNewsFeed || collaboratorView || isMcp) {
      configContainer.style.display = 'none';
    } else {
      configContainer.style.display = '';
    }
  }
  if (isMcp) {
    document.getElementById('mobileAgentStatusStrip')?.classList.add('hidden');
    document.getElementById('agentConfigDropdown')?.classList.add('hidden');
  }
  const chatPreparing = selectedChatContext?.state === 'preparing';
  if (chatPreparing || selectedChatContext?.privateHistory || selectedChatContext?.mode === 'shared' && !selectedChatContext.capabilities?.send) {
    userMessageInput.disabled = true;
    userMessageInput.placeholder = chatPreparing
      ? 'Conversation setup in progress — you can send when it is ready…'
      : selectedChatContext.privateHistory
        ? 'Private history — select the agent again to return to the shared chat'
        : selectedChatContext.sharingEnabled === false
          ? 'Sharing is off — the owner can restore access'
          : 'Waiting for encrypted conversation access…';
    userMessageSendButton.disabled = true;
    if (imageFileInput) imageFileInput.disabled = true;
    if (generalFileInput) generalFileInput.disabled = true;
  }
}

/**
 * Setup agent control buttons (stop, config)
 */
function setupAgentControls() {
  const stopBtn = document.getElementById('agentStopBtn');
  const configBtn = document.getElementById('agentConfigBtn');
  const configDropdown = document.getElementById('agentConfigDropdown');
  const messageInputArea = document.getElementById('messageInputArea');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const configProvider = document.getElementById('configProvider');
  const configModel = document.getElementById('configModel');

  // Provider-specific option containers
  const codexOptions = document.getElementById('codexOptions');
  const claudeOptions = document.getElementById('claudeOptions');
  const geminiOptions = document.getElementById('geminiOptions');
  const copilotOptions = document.getElementById('copilotOptions');

  let providerModels = {
    codex: [{ value: 'default', label: 'Default' }]
  };
  let providerModelsLoaded = false;
  let providerModelsLoadedAt = 0;

  async function ensureProviderModelsLoaded() {
    if (providerModelsLoaded && Date.now() - providerModelsLoadedAt < 5 * 60 * 1000) return;
    try {
      const response = await fetch('/dashboard/models');
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.models && typeof data.models === 'object') {
        providerModels = data.models;
        providerModelsLoaded = true;
        providerModelsLoadedAt = Date.now();
      }
    } catch (error) {
      console.warn('Failed to load provider models:', error);
    }
  }

  // Update model dropdown based on provider
  function updateModelDropdown(provider) {
    if (!configModel) return;
    const models = providerModels[provider] || providerModels.codex || [{ value: 'default', label: 'Default' }];
    configModel.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      configModel.appendChild(opt);
    });
  }

  // Toggle provider-specific options when provider changes
  if (configProvider) {
    configProvider.addEventListener('change', () => {
      const provider = configProvider.value;

      // Update model dropdown
      updateModelDropdown(provider);

      // Hide all provider options
      codexOptions?.classList.add('hidden');
      claudeOptions?.classList.add('hidden');
      geminiOptions?.classList.add('hidden');
      copilotOptions?.classList.add('hidden');

      // Show relevant options
      if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
        codexOptions?.classList.remove('hidden');
      } else if (provider === 'claude' || provider === 'antigravity') {
        claudeOptions?.classList.remove('hidden');
      } else if (provider === 'gemini') {
        geminiOptions?.classList.remove('hidden');
      } else if (provider === 'copilot') {
        copilotOptions?.classList.remove('hidden');
      }
    });
  }

  // Stop button handler
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      const agentName = getResolvedSelectedAgentName();
      if (!agentName) return;

      stopBtn.disabled = true;
      stopBtn.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

      try {
        const response = await csrfFetch('/dashboard/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({ agentName })
        });

        if (response.ok) {
          showSuccessMessage('Stop requested. Agent will halt shortly.');
        } else {
          const data = await response.json();
          showErrorMessage(data.error?.message || 'Failed to stop agent');
        }
      } catch (error) {
        console.error('Error stopping agent:', error);
        showErrorMessage('Failed to stop agent');
      } finally {
        stopBtn.disabled = false;
        stopBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span class="hidden sm:inline">Stop</span>';
      }
    });
  }

  // Config button toggle dropdown
  if (configBtn && configDropdown) {
    const configStrip = document.getElementById('mobileAgentStatusStrip');
    const syncConfigDropdownState = () => {
      const isOpen = !configDropdown.classList.contains('hidden');
      messageInputArea?.classList.toggle('message-input--config-open', isOpen);
      configBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      configStrip?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    const openConfigDropdown = async () => {
      if (!configDropdown.classList.contains('hidden')) return;
      configDropdown.classList.remove('hidden');
      syncConfigDropdownState();

      if (getResolvedSelectedAgentName()) {
        await ensureProviderModelsLoaded();
        await loadAgentConfig();
      }
    };

    const closeConfigDropdown = () => {
      if (configDropdown.classList.contains('hidden')) return;
      configDropdown.classList.add('hidden');
      syncConfigDropdownState();
    };

    const toggleConfigDropdown = async () => {
      if (configDropdown.classList.contains('hidden')) {
        await openConfigDropdown();
      } else {
        closeConfigDropdown();
      }
    };

    configBtn.addEventListener('click', toggleConfigDropdown);

    configStrip?.addEventListener('click', async () => {
      if (!isDashboardFastModeEnabled()) return;
      await toggleConfigDropdown();
    });

    configStrip?.addEventListener('keydown', async (e) => {
      if (!isDashboardFastModeEnabled()) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      await toggleConfigDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!configBtn.contains(e.target) && !configDropdown.contains(e.target) && !configStrip?.contains(e.target)) {
        closeConfigDropdown();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !configDropdown.classList.contains('hidden')) {
        closeConfigDropdown();
      }
    });
  }

  // Load model catalog in background so the first config open is fast.
  ensureProviderModelsLoaded();

  // Inter-agent stats inline click handler (toggle communication)
  const interAgentStatsInline = document.getElementById('interAgentStatsInline');
  if (interAgentStatsInline) {
    interAgentStatsInline.addEventListener('click', async () => {
      const agentName = getResolvedSelectedAgentName();
      if (!agentName) return;

      try {
        // Get current mode
        const configResponse = await fetch(`/dashboard/config?agentName=${encodeURIComponent(agentName)}`);
        if (!configResponse.ok) return;

        const configData = await configResponse.json();
        const currentMode = configData.interAgentMode || 'disabled';

        // Toggle mode
        let newMode;
        if (currentMode === 'disabled') {
          newMode = 'listen_all'; // Enable with default mode
        } else {
          newMode = 'disabled'; // Disable
        }

        // Save the new mode
        const response = await csrfFetch('/dashboard/config', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({
            agentName,
            inter_agent_mode: newMode
          })
        });

        if (response.ok) {
          // Reload stats to show updated state
          await loadInterAgentStats();

          // Show success message
          if (newMode === 'disabled') {
            showSuccessMessage('A2A communication disabled');
          } else {
            showSuccessMessage('A2A communication enabled');
          }
        } else {
          showErrorMessage('Failed to update A2A communication');
        }
      } catch (error) {
        console.error('Error toggling inter-agent mode:', error);
        showErrorMessage('Failed to update inter-agent communication');
      }
    });
  }

  // Inter-agent toggle handler
  const interAgentToggle = document.getElementById('configInterAgentToggle');
  const interAgentSelect = document.getElementById('configInterAgentMode');
  if (interAgentToggle) {
    interAgentToggle.addEventListener('click', () => {
      const currentMode = interAgentToggle.dataset.mode || 'disabled';
      const isCurrentlyEnabled = currentMode !== 'disabled';

      if (isCurrentlyEnabled) {
        // Turn off
        updateInterAgentUI('disabled');
      } else {
        // Turn on - use the selected mode from dropdown (default to listen_all)
        const selectedMode = interAgentSelect?.value || 'listen_all';
        updateInterAgentUI(selectedMode);
      }
    });

    // Mode select change handler
    if (interAgentSelect) {
      interAgentSelect.addEventListener('change', () => {
        const currentMode = interAgentToggle.dataset.mode || 'disabled';
        if (currentMode !== 'disabled') {
          // If already enabled, update to the new mode
          updateInterAgentUI(interAgentSelect.value);
        }
      });
    }
  }

  // Save config handler
  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      const agentName = getResolvedSelectedAgentName();
      if (!agentName) return;

      saveConfigBtn.disabled = true;
      saveConfigBtn.textContent = 'Saving...';

      try {
        const provider = configProvider?.value || 'codex';
        const model = document.getElementById('configModel')?.value || 'default';

        // Build config based on provider
        let configData = {
          agentName,
          model_provider: provider,
          model: model
        };

        if (provider === 'codex' || provider === 'default') {
          configData.thinking_effort = document.getElementById('configCodexThinkingEffort')?.value || 'medium';
        }

        // Add provider-specific settings
        if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
          let sandbox = document.getElementById('configCodexSandbox')?.value || 'workspace-write';
          if (sandbox === 'danger-full-access') sandbox = 'none';
          const bypass = document.getElementById('configCodexBypass')?.checked || false;
          configData.sandbox_mode = sandbox;
          if (bypass) {
            configData.approval_mode = 'full-auto';
            configData.sandbox_mode = 'none';
          }
        } else if (provider === 'claude' || provider === 'antigravity') {
          const perm = document.getElementById('configClaudeMode')?.value || 'bypassPermissions';
          const skip = document.getElementById('configClaudeSkip')?.checked ?? true;
          configData.approval_mode = perm;
          if (skip) configData.sandbox_mode = 'none';
          if (provider === 'claude') {
            configData.thinking_effort = document.getElementById('configClaudeThinkingEffort')?.value || 'medium';
          }
        } else if (provider === 'gemini') {
          const mode = document.getElementById('configGeminiMode')?.value || 'sandbox';
          const yolo = document.getElementById('configGeminiYolo')?.checked || false;
          configData.sandbox_mode = mode === 'no-sandbox' ? 'none' : 'workspace-write';
          if (yolo) configData.approval_mode = 'full-auto';
        } else if (provider === 'copilot') {
          const copilotMode = document.getElementById('configCopilotMode')?.value || 'default';
          const copilotYolo = document.getElementById('configCopilotYolo')?.checked || false;
          if (copilotYolo || copilotMode === 'allow-all') {
            configData.approval_mode = 'full-auto';
            configData.sandbox_mode = 'none';
          } else if (copilotMode === 'allow-all-tools') {
            configData.approval_mode = 'full-auto';
            configData.sandbox_mode = 'workspace-write';
          } else {
            configData.approval_mode = 'suggest';
            configData.sandbox_mode = 'workspace-write';
          }
        } else if (provider === 'pi') {
          configData.approval_mode = 'suggest';
          configData.sandbox_mode = 'workspace-write';
        }

        // Add inter-agent mode (read from toggle button state)
        const interAgentToggle = document.getElementById('configInterAgentToggle');
        const interAgentMode = interAgentToggle?.dataset.mode || 'disabled';
        configData.inter_agent_mode = interAgentMode;

        const response = await csrfFetch('/dashboard/config', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify(configData)
        });

        if (response.ok) {
          loadedAgentConfigs.set(agentName, { ...(loadedAgentConfigs.get(agentName) || {}), ...configData });
          showSuccessMessage('Config saved. Changes take effect next loop.');
          configDropdown?.classList.add('hidden');
          // Update status display
          await loadAgentConfig();
        } else {
          const data = await response.json();
          showErrorMessage(data.error?.message || 'Failed to save config');
        }
      } catch (error) {
        console.error('Error saving config:', error);
        showErrorMessage('Failed to save config');
      } finally {
        saveConfigBtn.disabled = false;
        saveConfigBtn.textContent = 'Save Config';
      }
    });
  }
}

/**
 * Load agent config and update status display
 */
let _configRequestId = 0;

function formatConfigLabel(value, fallback = 'Default') {
  if (!value || value === 'default') return fallback;
  return String(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function summarizeConfigPermissions(config = {}) {
  const sandboxMode = config.sandbox_mode === 'danger-full-access' ? 'none' : config.sandbox_mode;
  const approvalMode = config.approval_mode || 'default';

  if (sandboxMode === 'none' && approvalMode === 'full-auto') return 'Full auto';
  if (sandboxMode === 'none') return 'Full access';
  if (approvalMode === 'full-auto') return 'Auto tools';
  if (sandboxMode) return formatConfigLabel(sandboxMode, 'Default');
  return formatConfigLabel(approvalMode, 'Default');
}

function updateMobileAgentStatusStrip({ config = {}, modeStr = 'Default', allowedProviders = [], interAgentMode = 'disabled' } = {}) {
  const strip = document.getElementById('mobileAgentStatusStrip');
  if (!strip) return;

  const providerEl = document.getElementById('mobileConfigProvider');
  const modelEl = document.getElementById('mobileConfigModel');
  const modeEl = document.getElementById('mobileConfigMode');
  const permissionsEl = document.getElementById('mobileConfigPermissions');

  const provider = config.model_provider || 'codex';
  const model = config.model && config.model !== 'default' ? config.model : 'Default';
  const access = summarizeConfigPermissions(config);
  const providerCount = allowedProviders.length > 0 ? `${allowedProviders.length} providers` : 'All providers';
  const interAgent = interAgentMode && interAgentMode !== 'disabled' ? `A2A ${formatConfigLabel(interAgentMode)}` : 'A2A off';

  if (providerEl) providerEl.textContent = formatConfigLabel(provider, 'Codex');
  if (modelEl) modelEl.textContent = model;
  if (modeEl) modeEl.textContent = formatConfigLabel(modeStr, 'Default');
  if (permissionsEl) permissionsEl.textContent = `${access} | ${providerCount} | ${interAgent}`;

  strip.classList.remove('hidden');
}

async function loadAgentConfig() {
  const agentName = getResolvedSelectedAgentName();
  if (!agentName) return;

  if (isMcpAgent(selectedAgentId) || isMcpAgent(agentName)) {
    const configContainer = document.getElementById('agentConfigContainer');
    if (configContainer) {
      configContainer.hidden = true;
      configContainer.style.display = 'none';
    }
    document.getElementById('mobileAgentStatusStrip')?.classList.add('hidden');
    document.getElementById('agentConfigDropdown')?.classList.add('hidden');
    return;
  }

  const requestId = ++_configRequestId;
  const configProvider = document.getElementById('configProvider');
  const statusProvider = document.getElementById('configStatusProvider');
  const statusMode = document.getElementById('configStatusMode');

  try {
    const response = await fetch(`/dashboard/config?agentName=${encodeURIComponent(agentName)}`);
    // Discard stale responses if a newer loadAgentConfig() call was made while we were waiting
    if (requestId !== _configRequestId) return;
    if (response.ok) {
      const data = await response.json();
      const config = data.config || {};
      loadedAgentConfigs.set(agentName, { ...config });
      const allowedPermissions = data.allowedPermissions || {};
      const allowedProviders = Object.keys(allowedPermissions).filter(k => k !== 'inter_agent' && k !== 'project_path');
      const normalizedSandboxMode = config.sandbox_mode === 'danger-full-access' ? 'none' : config.sandbox_mode;

      // Filter provider dropdown based on allowed permissions
      if (configProvider) {
        // Store all options first time (before any filtering)
        if (!configProvider.dataset.allOptions) {
          const allOpts = [];
          for (const opt of configProvider.options) {
            allOpts.push({ value: opt.value, text: opt.text });
          }
          configProvider.dataset.allOptions = JSON.stringify(allOpts);
        }

        const allOptions = JSON.parse(configProvider.dataset.allOptions);
        configProvider.innerHTML = '';

        if (allowedProviders.length > 0) {
          // Filter to only allowed providers
          for (const opt of allOptions) {
            if (allowedProviders.includes(opt.value)) {
              const option = document.createElement('option');
              option.value = opt.value;
              option.textContent = opt.text;
              configProvider.appendChild(option);
            }
          }
        } else {
          // No restrictions — restore all providers
          for (const opt of allOptions) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.text;
            configProvider.appendChild(option);
          }
        }
      }

      // Update dropdown value
      if (configProvider && config.model_provider) {
        configProvider.value = config.model_provider;
        // Trigger change to show right options and populate model dropdown
        configProvider.dispatchEvent(new Event('change'));
      }

      // Set model dropdown value (after provider change populates it)
      const configModel = document.getElementById('configModel');
      if (configModel && config.model) {
        // Wait a tick for provider change to populate models
        setTimeout(() => {
          configModel.value = config.model;
        }, 0);
      }

      // Update button status text - show model and mode
      const modelDisplay = config.model && config.model !== 'default' ? config.model : (config.model_provider || 'codex');
      if (statusProvider) statusProvider.textContent = modelDisplay;
      if (statusMode) {
        // Determine mode display string based on provider/settings
        let modeStr = config.approval_mode || 'default';

        if (config.model_provider === 'codex' || !config.model_provider) {
          if (normalizedSandboxMode === 'none') modeStr = 'FULL ACCESS';
          else modeStr = normalizedSandboxMode || 'workspace-write';
        } else if (config.model_provider === 'gemini') {
          if (config.approval_mode === 'full-auto') modeStr = 'YOLO';
          else modeStr = normalizedSandboxMode === 'none' ? 'No Sandbox' : 'Sandboxed';
        } else if (config.model_provider === 'claude' || config.model_provider === 'antigravity') {
          if (normalizedSandboxMode === 'none') modeStr = 'Bypass Permissions';
          else modeStr = config.approval_mode || 'default';
        } else if (config.model_provider === 'copilot') {
          if (normalizedSandboxMode === 'none' && config.approval_mode === 'full-auto') modeStr = 'YOLO (Allow All)';
          else if (config.approval_mode === 'full-auto') modeStr = 'Allow All Tools';
          else modeStr = 'Default';
        } else if (config.model_provider === 'pi') {
          modeStr = 'Print Mode';
        }

        statusMode.textContent = modeStr;
      }
      const mobileModeStr = statusMode?.textContent || config.approval_mode || 'default';

      // Reset effort when switching agents so a previous agent's choice cannot leak.
      const codexThinkingEffort = document.getElementById('configCodexThinkingEffort');
      if (codexThinkingEffort) codexThinkingEffort.value = config.thinking_effort || 'medium';

      // Set provider-specific values
      if (config.model_provider === 'codex' || config.model_provider === 'default') {
        const sandboxEl = document.getElementById('configCodexSandbox');
        const bypassEl = document.getElementById('configCodexBypass');
        if (sandboxEl && normalizedSandboxMode) {
          sandboxEl.value = normalizedSandboxMode === 'none' ? 'danger-full-access' : normalizedSandboxMode;
        }
        // Auto-check bypass if full-auto + no sandbox
        if (bypassEl) {
          bypassEl.checked = config.approval_mode === 'full-auto' && normalizedSandboxMode === 'none';
        }
      } else if (config.model_provider === 'gemini') {
        const geminiMode = document.getElementById('configGeminiMode');
        const geminiYolo = document.getElementById('configGeminiYolo');
        if (geminiMode) geminiMode.value = normalizedSandboxMode === 'none' ? 'no-sandbox' : 'sandbox';
        if (geminiYolo) geminiYolo.checked = config.approval_mode === 'full-auto';
      } else if (config.model_provider === 'claude' || config.model_provider === 'antigravity') {
        const claudeMode = document.getElementById('configClaudeMode');
        const claudeSkip = document.getElementById('configClaudeSkip');
        const claudeThinkingEffort = document.getElementById('configClaudeThinkingEffort');
        if (claudeMode && config.approval_mode) claudeMode.value = config.approval_mode;
        if (claudeThinkingEffort && config.thinking_effort) claudeThinkingEffort.value = config.thinking_effort;
        // Auto-check skip permissions if sandbox is none
        if (claudeSkip) {
          claudeSkip.checked = normalizedSandboxMode === 'none';
        }
      } else if (config.model_provider === 'copilot') {
        const copilotMode = document.getElementById('configCopilotMode');
        const copilotYolo = document.getElementById('configCopilotYolo');
        if (copilotMode) {
          if (normalizedSandboxMode === 'none' && config.approval_mode === 'full-auto') {
            copilotMode.value = 'allow-all';
          } else if (config.approval_mode === 'full-auto') {
            copilotMode.value = 'allow-all-tools';
          } else {
            copilotMode.value = 'default';
          }
        }
        if (copilotYolo) copilotYolo.checked = normalizedSandboxMode === 'none' && config.approval_mode === 'full-auto';
      }

      // Apply permission restrictions to UI elements (disable disallowed options)
      applyPermissionRestrictions(allowedPermissions, config.model_provider);

      // Set inter-agent mode and update UI
      const interAgentMode = data.interAgentMode || 'disabled';
      updateInterAgentUI(interAgentMode);
      updateMobileAgentStatusStrip({ config, modeStr: mobileModeStr, allowedProviders, interAgentMode });
    }
  } catch (e) {
    console.error('Failed to load agent config:', e);
  }
}

/**
 * Update inter-agent communication UI based on mode
 */
function updateInterAgentUI(mode) {
  const toggle = document.getElementById('configInterAgentToggle');
  const select = document.getElementById('configInterAgentMode');
  const modeSelectContainer = document.getElementById('interAgentModeSelect');
  const statusIcon = document.getElementById('interAgentStatusIcon');
  const statusText = document.getElementById('interAgentStatusText');
  const groupInfo = document.getElementById('interAgentGroupInfo');

  if (!toggle) return;

  const isEnabled = mode !== 'disabled';

  // Update toggle button
  toggle.dataset.mode = mode;
  toggle.setAttribute('aria-checked', isEnabled.toString());

  if (isEnabled) {
    toggle.classList.remove('bg-slate-600');
    toggle.classList.add('bg-cyan-500');
    toggle.querySelector('span:last-child').classList.remove('translate-x-0');
    toggle.querySelector('span:last-child').classList.add('translate-x-5');
  } else {
    toggle.classList.remove('bg-cyan-500');
    toggle.classList.add('bg-slate-600');
    toggle.querySelector('span:last-child').classList.remove('translate-x-5');
    toggle.querySelector('span:last-child').classList.add('translate-x-0');
  }

  // Update mode select
  if (select) {
    if (mode === 'disabled') {
      select.value = 'listen_all'; // Default when enabling
    } else {
      select.value = mode;
    }
  }

  // Show/hide mode selector
  if (modeSelectContainer) {
    if (isEnabled) {
      modeSelectContainer.classList.remove('hidden');
    } else {
      modeSelectContainer.classList.add('hidden');
    }
  }

  // Update status display
  if (statusIcon && statusText) {
    if (isEnabled) {
      statusIcon.classList.remove('bg-slate-500');
      statusIcon.classList.add('bg-cyan-400');

      if (mode === 'listen_all') {
        statusText.textContent = 'Agent-to-agent communication turned ON';
        statusText.classList.remove('text-slate-400');
        statusText.classList.add('text-cyan-300');
        if (groupInfo) {
          groupInfo.classList.add('hidden');
        }
      } else if (mode === 'groups') {
        statusText.textContent = 'Agent-to-agent communication turned ON (Groups only)';
        statusText.classList.remove('text-slate-400');
        statusText.classList.add('text-cyan-300');
        if (groupInfo) {
          groupInfo.textContent = 'Part of agent groups - can communicate with group members';
          groupInfo.classList.remove('hidden');
        }
      }
    } else {
      statusIcon.classList.remove('bg-cyan-400');
      statusIcon.classList.add('bg-slate-500');
      statusText.textContent = 'Agent-to-agent communication disabled';
      statusText.classList.remove('text-cyan-300');
      statusText.classList.add('text-slate-400');
      if (groupInfo) {
        groupInfo.classList.add('hidden');
      }
    }
  }
}

/**
 * Load and display inter-agent communication status for the selected agent
 */
async function loadInterAgentStats() {
  const agentName = getResolvedSelectedAgentName();
  if (!agentName) return;

  const statsInline = document.getElementById('interAgentStatsInline');
  const statusEl = document.getElementById('interAgentStatsStatus');

  if (!statsInline) return;

  // Always show stats inline
  statsInline.classList.remove('hidden');

  try {
    // Get agent's inter-agent mode
    const configResponse = await fetch(`/dashboard/config?agentName=${encodeURIComponent(agentName)}`);
    if (!configResponse.ok) return;

    const configData = await configResponse.json();
    const interAgentMode = configData.interAgentMode || 'disabled';

    // Update status based on mode
    if (statusEl) {
      if (interAgentMode === 'disabled') {
        statusEl.textContent = 'A2A Off';
        statusEl.classList.remove('text-cyan-400', 'text-purple-400');
        statusEl.classList.add('text-slate-400');
      } else {
        statusEl.textContent = 'A2A On';
        statusEl.classList.remove('text-slate-400', 'text-purple-400');
        statusEl.classList.add('text-cyan-400');
      }
    }

  } catch (error) {
    console.error('Failed to load inter-agent status:', error);
  }
}

/**
 * Apply permission restrictions to UI elements
 * Disables/dims options that are not allowed by CLI permissions
 */
function applyPermissionRestrictions(allowedPermissions, currentProvider) {
  // If no restrictions, enable everything
  const providerKeyCount = !allowedPermissions ? 0 : Object.keys(allowedPermissions).filter(k => k !== 'inter_agent' && k !== 'project_path').length;
  const noRestrictions = !allowedPermissions || providerKeyCount === 0;

  // Codex sandbox options
  const codexSandbox = document.getElementById('configCodexSandbox');
  const providerPerms = allowedPermissions[currentProvider] || {};

  if (codexSandbox) {
    const allowedSandboxes = noRestrictions ? [] : (providerPerms['--sandbox'] || []);
    for (const option of codexSandbox.options) {
      // If no restrictions or empty array, allow all
      const isAllowed = allowedSandboxes.length === 0 || allowedSandboxes.includes(option.value);
      option.disabled = !isAllowed;
      // Reset text first
      option.textContent = option.textContent.replace(' (Not Allowed)', '');
      if (!isAllowed) {
        option.textContent += ' (Not Allowed)';
        option.style.color = '#64748b';
      } else {
        option.style.color = '';
      }
    }
  }

  // Codex bypass checkbox
  const codexBypass = document.getElementById('configCodexBypass');
  if (codexBypass) {
    const bypassAllowed = noRestrictions || providerPerms['--dangerously-bypass-approvals-and-sandbox'] === true;
    codexBypass.disabled = !bypassAllowed;
    codexBypass.parentElement.classList.toggle('opacity-40', !bypassAllowed);
    codexBypass.parentElement.title = bypassAllowed ? '' : 'Not allowed by your CLI permissions';
  }

  // Claude permission mode
  const claudeMode = document.getElementById('configClaudeMode');
  if (claudeMode) {
    const claudePerms = allowedPermissions['claude'] || {};
    const allowedModes = noRestrictions ? [] : (claudePerms['--permission-mode'] || []);
    for (const option of claudeMode.options) {
      const isAllowed = allowedModes.length === 0 || allowedModes.includes(option.value);
      option.disabled = !isAllowed;
      option.textContent = option.textContent.replace(' (Not Allowed)', '');
      if (!isAllowed) {
        option.textContent += ' (Not Allowed)';
        option.style.color = '#64748b';
      } else {
        option.style.color = '';
      }
    }
  }

  // Claude skip permissions
  const claudeSkip = document.getElementById('configClaudeSkip');
  if (claudeSkip) {
    const claudePerms = allowedPermissions['claude'] || {};
    const skipAllowed = noRestrictions || claudePerms['--dangerously-skip-permissions'] === true;
    claudeSkip.disabled = !skipAllowed;
    claudeSkip.parentElement.classList.toggle('opacity-40', !skipAllowed);
    claudeSkip.parentElement.title = skipAllowed ? '' : 'Not allowed by your CLI permissions';
  }

  // Explain why Claude full access is greyed out. The grant comes from the
  // agent's setup, so the dashboard cannot widen it itself.
  const claudeOptions = document.getElementById('claudeOptions');
  if (claudeOptions) {
    const claudePerms = allowedPermissions?.['claude'] || {};
    const modes = claudePerms['--permission-mode'] || [];
    const fullAccessAllowed = noRestrictions || modes.length === 0 || modes.includes('bypassPermissions')
      || claudePerms['--dangerously-skip-permissions'] === true;
    let hint = document.getElementById('configClaudeAccessHint');
    if (!hint) {
      hint = document.createElement('p');
      hint.id = 'configClaudeAccessHint';
      hint.className = 'text-[10px] leading-snug text-amber-300/90';
      claudeOptions.insertBefore(hint, document.getElementById('configClaudeMode')?.nextSibling || null);
    }
    hint.hidden = fullAccessAllowed;
    hint.textContent = fullAccessAllowed ? '' : `Full access is off for this agent. Its saved permissions only allow: ${modes.join(', ') || 'none'}. `
      + 'These are set when the agent is set up and cannot be changed from here.';
  }

  // Gemini mode
  const geminiMode = document.getElementById('configGeminiMode');
  if (geminiMode) {
    const geminiPerms = allowedPermissions['gemini'] || {};
    for (const option of geminiMode.options) {
      let isAllowed = true;
      if (!noRestrictions) {
        if (option.value === 'sandbox') {
          isAllowed = geminiPerms['--sandbox'] === true;
        } else if (option.value === 'no-sandbox') {
          isAllowed = geminiPerms['--no-sandbox'] === true;
        }
      }
      option.disabled = !isAllowed;
      option.textContent = option.textContent.replace(' (Not Allowed)', '');
      if (!isAllowed) {
        option.textContent += ' (Not Allowed)';
        option.style.color = '#64748b';
      } else {
        option.style.color = '';
      }
    }
  }

  // Gemini yolo
  const geminiYolo = document.getElementById('configGeminiYolo');
  if (geminiYolo) {
    const geminiPerms = allowedPermissions['gemini'] || {};
    const yoloAllowed = noRestrictions || geminiPerms['--yolo'] === true;
    geminiYolo.disabled = !yoloAllowed;
    geminiYolo.parentElement.classList.toggle('opacity-40', !yoloAllowed);
    geminiYolo.parentElement.title = yoloAllowed ? '' : 'Not allowed by your CLI permissions';
  }

  // Copilot permission mode
  const copilotMode = document.getElementById('configCopilotMode');
  if (copilotMode) {
    const copilotPerms = allowedPermissions['copilot'] || {};
    for (const option of copilotMode.options) {
      let isAllowed = true;
      if (!noRestrictions) {
        if (option.value === 'allow-all') {
          isAllowed = copilotPerms['--allow-all'] === true;
        } else if (option.value === 'allow-all-tools') {
          isAllowed = copilotPerms['--allow-all-tools'] === true || copilotPerms['--allow-all'] === true;
        }
        // 'default' is always allowed
      }
      option.disabled = !isAllowed;
      option.textContent = option.textContent.replace(' (Not Allowed)', '');
      if (!isAllowed) {
        option.textContent += ' (Not Allowed)';
        option.style.color = '#64748b';
      } else {
        option.style.color = '';
      }
    }
  }

  // Copilot yolo
  const copilotYolo = document.getElementById('configCopilotYolo');
  if (copilotYolo) {
    const copilotPerms = allowedPermissions['copilot'] || {};
    const yoloAllowed = noRestrictions || copilotPerms['--allow-all'] === true;
    copilotYolo.disabled = !yoloAllowed;
    copilotYolo.parentElement.classList.toggle('opacity-40', !yoloAllowed);
    copilotYolo.parentElement.title = yoloAllowed ? '' : 'Not allowed by your CLI permissions';
  }
}

/**
 * Show success message toast
 */
function showSuccessMessage(message) {
  window.showSuccess(message);
}

/**
 * Show warning message toast
 */
function showWarningMessage(message) {
  if (typeof window.showWarning === 'function') {
    window.showWarning(message);
    return;
  }
  window.showError(message);
}

let lastRateLimitNoticeAt = 0;
let lastRateLimitNoticeKey = '';

function formatRetryAfterDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function buildRateLimitUserMessage({ errorMessage, retryAfter, panelCount = 0 } = {}) {
  const guidance = [
    'wait a moment and send again',
    panelCount > 0 ? `close a few pinned chats (${panelCount} open)` : 'close a few pinned chats',
    'pause extra busy agents if they are spamming updates'
  ];

  const retryText = formatRetryAfterDuration(retryAfter);
  const parts = [errorMessage || 'You hit a dashboard rate limit.'];
  if (retryText) {
    parts.push(`Try again in about ${retryText}.`);
  }
  parts.push(`To reduce this, ${guidance.join(', ')}.`);
  return parts.join(' ');
}

async function readErrorPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function buildHttpFallbackMessage(response, fallbackMessage) {
  const status = Number(response?.status) || 0;
  if (status === 413) {
    return `This upload was rejected before the app could inspect it because it exceeded the current server upload limit of ${MAX_ATTACHMENT_SIZE_MB}MB. Try a smaller file or increase the reverse-proxy upload limit.`;
  }
  if (status === 403) {
    return 'The request was rejected because your session or access is no longer valid. Refresh the page and try again.';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'The server did not finish processing this request. Try again in a moment.';
  }
  return fallbackMessage || `Request failed (${status || 'unknown'})`;
}

function buildRequestError(response, errorData = {}, options = {}) {
  const apiError = errorData?.error || {};
  const retryAfterHeader = Number(response.headers.get('Retry-After'));
  const retryAfter = Number.isFinite(apiError.retryAfter) ? apiError.retryAfter : (Number.isFinite(retryAfterHeader) ? retryAfterHeader : null);

  if (response.status === 429 || apiError.code === 'RATE_LIMIT_EXCEEDED') {
    const panelCount = window.MultiChatManager?.getOpenPanelCount?.() || 0;
    const message = buildRateLimitUserMessage({
      errorMessage: apiError.message || options.fallbackMessage || 'Too many requests, please slow down.',
      retryAfter,
      panelCount
    });
    const error = new Error(message);
    error.isRateLimit = true;
    error.retryAfter = retryAfter;
    error.status = response.status;
    return error;
  }

  const error = new Error(apiError.message || buildHttpFallbackMessage(response, options.fallbackMessage) || 'Request failed');
  error.status = response.status;
  return error;
}

function notifyRateLimit(error, options = {}) {
  if (!error?.isRateLimit) {
    return false;
  }

  const now = Date.now();
  const panelCount = window.MultiChatManager?.getOpenPanelCount?.() || 0;
  const retryBucket = Number.isFinite(error.retryAfter) ? error.retryAfter : 'na';
  const noticeKey = `${options.scope || 'general'}:${retryBucket}:${panelCount}`;
  if (noticeKey === lastRateLimitNoticeKey && now - lastRateLimitNoticeAt < 15000) {
    return true;
  }

  lastRateLimitNoticeKey = noticeKey;
  lastRateLimitNoticeAt = now;

  const message = error.message || buildRateLimitUserMessage({ retryAfter: error.retryAfter, panelCount });
  if (typeof window.showNotification === 'function') {
    window.showNotification(message, 'warning', options.title || 'Rate Limit', 9000);
  } else {
    showWarningMessage(message);
  }
  return true;
}

/**
 * Submit the free-text reply on behalf of the user
 */
// Send animation: a copy of the draft lifts out of the composer as a sent
// bubble and hovers just above the bottom of the conversation while the
// request is in flight. settle() drops it into place once the server has
// accepted the message; cancel() sends it back to the composer when the
// send fails or stops early. It is decorative only — the real send never
// waits on it — it animates just transform and opacity on one element, and
// a safety timer removes it if neither call ever comes.
const NOOP_SEND_FLIGHT = { settle() {}, cancel() {} };
function playSendFlight(text) {
  try {
    if (!text || !userMessageInput || typeof Element.prototype.animate !== 'function') return NOOP_SEND_FLIGHT;
    if (document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return NOOP_SEND_FLIGHT;
    const area = document.getElementById('conversationArea');
    if (!area) return NOOP_SEND_FLIGHT;
    const from = userMessageInput.getBoundingClientRect();
    const to = area.getBoundingClientRect();
    if (!from.width || !to.width || to.bottom < 0 || from.top > window.innerHeight) return NOOP_SEND_FLIGHT;

    const ghost = document.createElement('div');
    ghost.className = 'send-flight';
    ghost.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'send-flight__body';
    body.textContent = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    ghost.appendChild(body);
    const width = Math.min(from.width - 16, Math.max(160, Math.min(to.width * 0.7, 520)));
    const left = from.left + 8;
    const top = from.top + 6;
    ghost.style.width = `${width}px`;
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    document.body.appendChild(ghost);

    // Land at the right edge, just above the bottom of the chat, where the
    // sent message appears; hover a little higher than that while sending.
    const ghostHeight = ghost.offsetHeight;
    const dx = (to.right - 24 - width) - left;
    const dy = Math.min(0, (to.bottom - 20 - ghostHeight) - top);
    const hoverDy = Math.max(dy - 28, to.top + 8 - top);
    const landed = `translate(${dx}px, ${dy}px) scale(1)`;
    const hovering = `translate(${dx}px, ${hoverDy}px) scale(1.03)`;

    let current = ghost.animate([
      { transform: 'translate(0, 0) scale(0.98)', opacity: 0.85 },
      { transform: hovering, opacity: 1 }
    ], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
    current.onfinish = () => ghost.classList.add('send-flight--hovering');

    let done = false;
    const remove = () => ghost.remove();
    const finish = (keyframes, options) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      ghost.classList.remove('send-flight--hovering');
      const startTransform = getComputedStyle(ghost).transform;
      const previous = current;
      current = ghost.animate([
        { transform: startTransform === 'none' ? 'translate(0, 0)' : startTransform, opacity: 1 },
        ...keyframes
      ], { fill: 'forwards', ...options });
      previous.cancel();
      current.onfinish = remove;
      current.oncancel = remove;
      setTimeout(remove, (options.duration || 0) + 600);
    };
    const safety = setTimeout(() => finish([{ transform: hovering, opacity: 0 }], { duration: 300 }), 20000);

    return {
      settle() {
        ghost.classList.add('send-flight--sent');
        finish([
          { transform: `translate(${dx}px, ${dy + 3}px) scale(0.995)`, opacity: 1, offset: 0.7 },
          { transform: landed, opacity: 0 }
        ], { duration: 360, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
      },
      cancel() {
        finish([
          { transform: 'translate(0, 0) scale(0.96)', opacity: 0 }
        ], { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
      }
    };
  } catch (_) {
    // Purely cosmetic; never let it affect sending.
    return NOOP_SEND_FLIGHT;
  }
}

async function sendUserMessage() {
  if (isSendingMessage || openingChatSelection !== null) return;
  if (selectedChatContext?.privateHistory) {
    showErrorMessage('Select the agent again to send in its shared conversation.');
    return;
  }
  if (!userMessageInput || !userMessageSendButton) {
    return;
  }

  if (!selectedAgentId) {
    showErrorMessage('Please select an agent before sending a reply.');
    return;
  }

  const trimmedContent = userMessageInput.value.trim();
  const replyContext = selectedChatContext?.conversationId || selectedAgentId;
  const sentReply = window.MessageReplies?.get(replyContext);
  const sentFiles = pendingImages.slice();
  const hasImages = pendingImages.length > 0;

  // Allow sending if there's content OR images (or both)
  if (!trimmedContent && !hasImages) {
    showErrorMessage('Please enter a message or attach a file.');
    return;
  }

  cancelMobileConversationScrollPreservation();

  const sendFlight = playSendFlight(trimmedContent);

  const sendScrollGuard = captureSendScrollGuard();
  if (sendScrollGuard?.wasNearBottom) {
    forceScrollToBottomOnNextRender = true;
    forceScrollToBottomUntil = Date.now() + 2500;
  }
  settleScrollAfterSend(sendScrollGuard);

  isSendingMessage = true;
  userMessageSendButton.disabled = true;
  setSendButtonLabel(hasImages ? 'Uploading...' : 'Sending...');

  try {
    if (selectedChatContext?.mode === 'shared') {
      const conversationId = selectedChatContext.conversationId;
      const sendResult = await window.InPlaceChat.sendMessage(trimmedContent, sentFiles, { replyTo: sentReply?.messageId });
      sendFlight.settle();
      if (selectedChatContext?.conversationId !== conversationId) return;
      const messages = sendResult.messages;
      conversationCache.set(conversationId, messages);
      rearmSendScrollGuard(sendScrollGuard);
      await displayMessages(messages, false, { agentId: selectedAgentId, conversationId });
      if (!sendResult.preserveDraft && userMessageInput.value.trim() === trimmedContent &&
          JSON.stringify(pendingImages.map(entry => entry.id)) === JSON.stringify(sentFiles.map(entry => entry.id))) {
        userMessageInput.value = '';
        clearAllImages();
        window.MessageReplies?.clear(replyContext, sentReply);
      }
      updateComposerState();
      setSendButtonLabel('Send');
      if (sendResult.refreshError) showErrorMessage('Message sent. ' + sendResult.refreshError);
      settleScrollAfterSend(sendScrollGuard);
      return;
    }

    // Upload images first if there are any
    let attachmentIds = [];
    if (hasImages) {
      // Check for encryption key (required for image uploads)
      if (!encryptionKey) {
        showErrorMessage('Please set your encryption password to send images.');
        userMessageSendButton.disabled = false;
        updateComposerState();
        return;
      }

      attachmentIds = await uploadAllImages();

      // Check if any uploads failed
      if (hasFailedUploads()) {
        showErrorMessage(buildFailedUploadMessage(pendingImages));
        userMessageSendButton.disabled = false;
        updateComposerState();
        return;
      }
    }

    // Encrypt the message content if there is any
    const replyContent = window.MessageReplies?.encode(trimmedContent, sentReply) || trimmedContent;
    let contentToSend = replyContent || null;
    let isEncrypted = false;

    if (trimmedContent && encryptionKey) {
      try {
        contentToSend = await window.E2EEncryption.encryptMessage(replyContent, encryptionKey);
        isEncrypted = true;
      } catch (encryptError) {
        console.error('Failed to encrypt message:', encryptError);
        showErrorMessage('Failed to encrypt message. Please refresh and try again.');
        userMessageSendButton.disabled = false;
        setSendButtonLabel('Send');
        return;
      }
    }

    // Build request body
    const requestBody = {
      agentId: selectedAgentId,
      encrypted: isEncrypted
    };

    // Add content if present
    if (contentToSend) {
      requestBody.content = contentToSend;
    }

    // Add attachment IDs if present
    if (attachmentIds.length > 0) {
      requestBody.attachmentIds = attachmentIds;
    }

    const hadExplicitRunOverrides = Boolean(getPendingRunOverrides());
    const sentRunOverrides = getEffectiveRunOverridesForSend();
    if (sentRunOverrides) {
      requestBody.runOverrides = sentRunOverrides;
    }

    const response = await csrfFetch('/api/user/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await readErrorPayload(response);
      throw buildRequestError(response, errorData, { fallbackMessage: 'Unable to send message' });
    }

    sendFlight.settle();
    if (hadExplicitRunOverrides) clearPendingRunOverrides();
    const data = await response.json();

    // Reload full message history so we rely on
    // server-side ordering/cursors and avoid duplicates
    if (selectedAgentId) {
      resetMessagePollCadence();
      lastMessageTimestamp = null;
      lastMessageCursor = null;
      // Clear cache for this agent to force refresh
      conversationCache.delete(selectedAgentId);
      // Clear saved scroll position so we scroll to bottom after sending
      agentScrollPositions.delete(selectedAgentId);
      rearmSendScrollGuard(sendScrollGuard);
      await loadMessages(selectedAgentId);
      settleScrollAfterSend(sendScrollGuard);
    }

    // Save to message history (most recent first, max 4)
    if (trimmedContent) {
      const history = messageHistoryMap.get(selectedAgentId) || [];
      // Don't add duplicates at the front
      if (history[0] !== trimmedContent) {
        history.unshift(trimmedContent);
        if (history.length > 4) history.pop();
      }
      messageHistoryMap.set(selectedAgentId, history);
      persistMessageHistory();
    }
    messageHistoryIndex = -1;
    messageHistoryDraft = '';

    // Clear the input and any pending images
    userMessageInput.value = '';
    window.MessageReplies?.clear(replyContext, sentReply);
    clearAllImages();
    updateComposerState();

  } catch (error) {
    console.error('Error sending user message:', error);
    if (notifyRateLimit(error, { scope: 'send-message', title: 'Send Delayed' })) {
      return;
    }
    if (error.status === 409 && /chat is preparing or shared/i.test(error.message || '') && window.InPlaceChat?.resolveAgentContext) {
      try {
        const context = await window.InPlaceChat.resolveAgentContext(selectedAgentId);
        if (selectedAgentId === context.agentId) {
          await window.DashboardHelpers?.selectChatContext?.(context);
          showErrorMessage(context.state === 'preparing'
            ? 'Conversation setup is still in progress. Your draft is safe; send it when setup finishes.'
            : 'Conversation context refreshed. Your draft is safe; send again to continue.');
          return;
        }
      } catch (refreshError) {
        console.warn('Could not refresh chat context after a send conflict:', refreshError);
      }
    }
    showErrorMessage(error.message || 'Failed to send message');
  } finally {
    // No-op after settle(); otherwise the send failed or stopped early.
    sendFlight.cancel();
    isSendingMessage = false;
    // Note: Don't reset button styling here - displayMessages() handles that
    // based on whether there are more unanswered questions
    updateComposerState();
    settleScrollAfterSend(sendScrollGuard);
  }
}

// ============================================================================
// Image Upload Functionality
// ============================================================================

/**
 * Initialize image upload handlers
 */
function setupImageUpload() {
  const imageFileInput = document.getElementById('imageFileInput');
  const imagePreviewArea = document.getElementById('imagePreviewArea');
  const imagePreviewContainer = document.getElementById('imagePreviewContainer');
  const clearAllImagesBtn = document.getElementById('clearAllImagesBtn');
  const imageUploadLabel = document.getElementById('imageUploadLabel');

  if (!imageFileInput || !imagePreviewArea || !imagePreviewContainer) {
    console.warn('Image upload elements not found');
    return;
  }
  if (imageUploadLabel) imageUploadLabel.style.position = '';

  // Handle file selection
  imageFileInput.addEventListener('change', (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    // Check if adding these would exceed the limit
    const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
    if (files.length > remainingSlots) {
      showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} files per message. ${remainingSlots} slots remaining.`);
      // Only take what we can
      files.splice(remainingSlots);
    }

    // Add files to pending attachments
    files.forEach(file => {
      // Validate file type
      const allowedImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      const isAllowedImage = allowedImageTypes.includes(file.type);
      const isAllowedVideo = String(file.type || '').startsWith('video/');
      if (!isAllowedImage && !isAllowedVideo) {
        showErrorMessage(`${file.name}: Invalid file type. Only PNG, JPEG, WebP, GIF, and video files are allowed.`);
        return;
      }

      if (file.size > MAX_ATTACHMENT_BYTES) {
        showErrorMessage(`${file.name}: File too large. Maximum size is ${MAX_ATTACHMENT_SIZE_MB}MB.`);
        return;
      }

      // Create preview URL
      const previewUrl = URL.createObjectURL(file);

      // Add to pending images
      pendingImages.push({
        id: crypto.randomUUID(),
        file,
        previewUrl,
        status: 'pending', // pending, uploading, success, error
        attachmentId: null,
        error: null
      });
    });

    // Clear the input so the same file can be selected again
    imageFileInput.value = '';

    // Update the UI
    renderImagePreviews();
    updateComposerState();
  });

  // Handle clear all button
  if (clearAllImagesBtn) {
    clearAllImagesBtn.addEventListener('click', () => {
      clearAllImages();
    });
  }

  // Handle general file input (for non-image files like PDFs, text, etc.)
  const generalFileInput = document.getElementById('generalFileInput');
  if (generalFileInput) {
    generalFileInput.addEventListener('change', (event) => {
      const files = Array.from(event.target.files);
      if (files.length === 0) return;

      // Check if adding these would exceed the limit
      const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
      if (files.length > remainingSlots) {
        showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} files per message. ${remainingSlots} slots remaining.`);
        files.splice(remainingSlots);
      }

      // Add files to pending attachments
      files.forEach(file => {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          showErrorMessage(`${file.name}: File too large. Maximum size is 20MB.`);
          return;
        }

        // Create preview URL (will show file icon for non-images)
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;

        // Add to pending images (reusing the same array for all attachments)
        pendingImages.push({
          id: crypto.randomUUID(),
          file,
          previewUrl,
          isFile: true, // Flag to indicate this is a general file, not just an image
          status: 'pending',
          attachmentId: null,
          error: null
        });
      });

      // Clear the input so the same file can be selected again
      generalFileInput.value = '';

      // Update the UI
      renderImagePreviews();
      updateComposerState();
    });
  }

  // Handle drag and drop on the preview area
  imagePreviewArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    imagePreviewArea.classList.add('border-emerald-400/50');
  });

  imagePreviewArea.addEventListener('dragleave', (e) => {
    e.preventDefault();
    imagePreviewArea.classList.remove('border-emerald-400/50');
  });

  imagePreviewArea.addEventListener('drop', (e) => {
    e.preventDefault();
    imagePreviewArea.classList.remove('border-emerald-400/50');

    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (files.length > 0) {
      // Simulate file input change
      const dataTransfer = new DataTransfer();
      files.forEach(f => dataTransfer.items.add(f));
      imageFileInput.files = dataTransfer.files;
      imageFileInput.dispatchEvent(new Event('change'));
    }
  });

  // Handle paste events on the message input (Ctrl+V to paste images)
  if (userMessageInput) {
    userMessageInput.addEventListener('paste', async (event) => {
      const items = event.clipboardData?.items;
      if (!items || items.length === 0) return;

      // Check if there are any image items in the clipboard
      let hasImage = false;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          hasImage = true;
          break;
        }
      }

      // If no images in clipboard, let normal paste behavior happen
      if (!hasImage) return;

      // Prevent default paste behavior for images (don't insert anything into the input)
      event.preventDefault();
      event.stopPropagation();

      // Collect image files from clipboard
      const imageFiles = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            imageFiles.push(blob);
          }
        }
      }

      if (imageFiles.length === 0) return;

      // Check if adding these would exceed the limit
      const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
      if (imageFiles.length > remainingSlots) {
        showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} images per message. ${remainingSlots} slots remaining.`);
        imageFiles.splice(remainingSlots);
      }

      // Process each image file
      for (const file of imageFiles) {
        // Validate file type
        const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
        if (!allowedTypes.includes(file.type)) {
          showErrorMessage(`${file.name || 'Pasted image'}: Invalid file type. Only PNG, JPEG, WebP, and GIF are allowed.`);
          continue;
        }

        // Validate file size (5MB max)
        const maxSize = 5 * 1024 * 1024;
        if (file.size > maxSize) {
          showErrorMessage(`${file.name || 'Pasted image'}: File too large. Maximum size is 5MB.`);
          continue;
        }

        // Create preview URL
        const previewUrl = URL.createObjectURL(file);

        // Add to pending images
        pendingImages.push({
          id: crypto.randomUUID(),
          file,
          previewUrl,
          status: 'pending',
          attachmentId: null,
          error: null
        });
      }

      // Update the UI
      renderImagePreviews();
      updateComposerState();

      // Show feedback
      const addedCount = imageFiles.length;
      if (addedCount > 0) {
        showSuccessMessage(`Added ${addedCount} image${addedCount > 1 ? 's' : ''} from clipboard`);
      }
    });

    // Handle drag and drop on the message text input (userMessageInput)
    userMessageInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      userMessageInput.classList.add('ring-2', 'ring-emerald-400/50');
    });

    userMessageInput.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      userMessageInput.classList.remove('ring-2', 'ring-emerald-400/50');
    });

    userMessageInput.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      userMessageInput.classList.remove('ring-2', 'ring-emerald-400/50');

      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
      if (files.length > 0) {
        // Check remaining slots
        const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
        if (files.length > remainingSlots) {
          showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} files per message. ${remainingSlots} slots remaining.`);
          files.splice(remainingSlots);
        }

        // Process each image file
        for (const file of files) {
          // Validate file type
          const allowedImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
          const isAllowedImage = allowedImageTypes.includes(file.type);
          const isAllowedVideo = String(file.type || '').startsWith('video/');
          if (!isAllowedImage && !isAllowedVideo) {
            showErrorMessage(`${file.name}: Invalid file type. Only PNG, JPEG, WebP, GIF, and video files are allowed.`);
            continue;
          }

          if (file.size > MAX_ATTACHMENT_BYTES) {
            showErrorMessage(`${file.name}: File too large. Maximum size is ${MAX_ATTACHMENT_SIZE_MB}MB.`);
            continue;
          }

          // Create preview URL
          const previewUrl = URL.createObjectURL(file);

          // Add to pending images
          pendingImages.push({
            id: crypto.randomUUID(),
            file,
            previewUrl,
            status: 'pending',
            attachmentId: null,
            error: null
          });
        }

        // Update the UI
        renderImagePreviews();
        updateComposerState();

        // Show feedback
        const addedCount = files.length;
        if (addedCount > 0) {
          showSuccessMessage(`Added ${addedCount} attachment${addedCount > 1 ? 's' : ''} from drag & drop`);
        }
      }
    });
  }
}

/**
 * Render image previews in the preview container
 */
function renderImagePreviews() {
  const imagePreviewArea = document.getElementById('imagePreviewArea');
  const imagePreviewContainer = document.getElementById('imagePreviewContainer');
  const imageUploadLabel = document.getElementById('imageUploadLabel');

  if (!imagePreviewArea || !imagePreviewContainer) return;

  // Show/hide preview area based on pending images
  if (pendingImages.length === 0) {
    imagePreviewArea.classList.add('hidden');
    // Remove count badge from upload button
    const existingBadge = imageUploadLabel?.querySelector('.image-upload-count');
    if (existingBadge) existingBadge.remove();
    if (imageUploadLabel) imageUploadLabel.style.position = '';
    return;
  }

  imagePreviewArea.classList.remove('hidden');

  // Update count badge on upload button
  if (imageUploadLabel) {
    let badge = imageUploadLabel.querySelector('.image-upload-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'image-upload-count';
      // The label is already absolutely positioned (desktop) or relative
      // (mobile CSS), so it anchors the badge. Forcing an inline
      // position:relative here dropped it out of the textarea and pushed
      // both attach buttons below the composer.
      imageUploadLabel.appendChild(badge);
    }
    badge.textContent = pendingImages.length;
    imageUploadLabel.style.position = '';
  }

  // Render each image preview
  imagePreviewContainer.innerHTML = pendingImages.map(img => {
    let statusOverlay = '';
    let itemClass = 'image-preview-item';

    switch (img.status) {
      case 'uploading':
        statusOverlay = `
          <div class="image-preview-progress">
            <div class="image-preview-spinner"></div>
            <span class="image-preview-progress-text">Encrypting...</span>
          </div>
        `;
        break;
      case 'success':
        itemClass += ' image-preview-item--success';
        statusOverlay = `
          <div class="image-preview-progress" style="opacity: 0.8;">
            <svg class="image-preview-success-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
        `;
        break;
      case 'error':
        itemClass += ' image-preview-item--error';
        statusOverlay = `
          <svg class="image-preview-error-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        `;
        break;
    }

    // Determine if this is an image or a general file
    const isImage = img.file.type.startsWith('image/') && img.previewUrl;
    const isVideo = img.file.type.startsWith('video/') && img.previewUrl;

    // Content to display (image preview or file icon)
    let contentHtml;
    if (isImage) {
      contentHtml = `<img src="${img.previewUrl}" alt="${escapeHtml(img.file.name)}" />`;
    } else if (isVideo) {
      contentHtml = `<video src="${img.previewUrl}" muted playsinline preload="metadata"></video>`;
      itemClass += ' video-preview-item';
    } else {
      // Show file icon for non-image files
      const fileExt = img.file.name.split('.').pop()?.toUpperCase() || 'FILE';
      contentHtml = `
        <div class="file-preview-icon">
          <svg class="w-8 h-8 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" 
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
          </svg>
          <span class="file-ext-label">${escapeHtml(fileExt)}</span>
        </div>
      `;
      itemClass += ' file-preview-item';
    }

    return `
      <div class="${itemClass}" data-image-id="${img.id}" title="${img.error || img.file.name}">
        ${contentHtml}
        <button type="button" class="image-preview-remove" onclick="removeImage('${img.id}')" title="Remove">
          &times;
        </button>
        <span class="image-preview-filename">${escapeHtml(img.file.name)}</span>
        ${statusOverlay}
      </div>
    `;
  }).join('');
}

/**
 * Remove a single image from pending images
 * @param {string} imageId - The unique ID of the image to remove
 */
function removeImage(imageId) {
  const index = pendingImages.findIndex(img => img.id === imageId);
  if (index !== -1) {
    // Revoke the preview URL to free memory
    URL.revokeObjectURL(pendingImages[index].previewUrl);
    pendingImages.splice(index, 1);
    renderImagePreviews();
    updateComposerState();
  }
}

// Expose removeImage to global scope for onclick handlers
window.removeImage = removeImage;

/**
 * Clear all pending images
 */
function clearAllImages() {
  // Revoke all preview URLs
  pendingImages.forEach(img => {
    URL.revokeObjectURL(img.previewUrl);
  });
  pendingImages = [];
  renderImagePreviews();
  updateComposerState();
}

/**
 * Get image dimensions from a file
 * @param {File} file - The image file
 * @returns {Promise<{width: number, height: number}>}
 */
async function getImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => {
      reject(new Error('Failed to load image'));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

const ATTACHMENT_EXTENSION_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg'
};

function getAttachmentFilename(fileOrAttachment) {
  return String(fileOrAttachment?.name || fileOrAttachment?.fileName || fileOrAttachment?.filename || '').trim();
}

function inferAttachmentContentType(fileOrAttachment) {
  const explicitContentType = String(fileOrAttachment?.type || fileOrAttachment?.contentType || '').trim().toLowerCase();
  if (explicitContentType && explicitContentType !== 'application/octet-stream') {
    return explicitContentType;
  }

  const filename = getAttachmentFilename(fileOrAttachment).toLowerCase();
  const extMatch = filename.match(/\.[a-z0-9]+$/);
  if (!extMatch) {
    return explicitContentType || 'application/octet-stream';
  }

  return ATTACHMENT_EXTENSION_CONTENT_TYPES[extMatch[0]] || explicitContentType || 'application/octet-stream';
}

function isAttachmentImage(fileOrAttachment) {
  const contentType = inferAttachmentContentType(fileOrAttachment);
  return contentType.startsWith('image/');
}

function isAttachmentVideo(fileOrAttachment) {
  const contentType = inferAttachmentContentType(fileOrAttachment);
  return contentType.startsWith('video/');
}

function getAttachmentContentType(file) {
  return String(file?.type || '').trim() || 'application/octet-stream';
}

/**
 * Upload a single image (encrypt and send to server)
 * @param {Object} imageEntry - The pending image entry
 * @returns {Promise<string|null>} - The attachment ID or null on failure
 */
async function uploadSingleImage(imageEntry) {
  if (!encryptionKey) {
    imageEntry.status = 'error';
    imageEntry.error = 'Encryption key not set';
    return null;
  }

  if (!selectedAgentId) {
    imageEntry.status = 'error';
    imageEntry.error = 'No agent selected';
    return null;
  }

  try {
    imageEntry.status = 'uploading';
    renderImagePreviews();

    // Read file as ArrayBuffer
    const arrayBuffer = await imageEntry.file.arrayBuffer();

    let dimensions = { width: 0, height: 0 };
    if (isAttachmentImage(imageEntry.file)) {
      dimensions = await getImageDimensions(imageEntry.file);
    }

    // Encrypt the image data
    const { ciphertext, iv, authTag } = await window.E2EEncryption.encryptBinaryWithKey(arrayBuffer, encryptionKey);

    // Create FormData for upload
    const formData = new FormData();
    formData.append('agentId', selectedAgentId);
    formData.append('file', new Blob([ciphertext], { type: 'application/octet-stream' }), imageEntry.file.name);
    formData.append('ivBase64', window.E2EEncryption.arrayBufferToBase64(iv.buffer));
    formData.append('authTagBase64', window.E2EEncryption.arrayBufferToBase64(authTag.buffer));
    formData.append('contentType', getAttachmentContentType(imageEntry.file));
    if (dimensions.width > 0) formData.append('width', dimensions.width.toString());
    if (dimensions.height > 0) formData.append('height', dimensions.height.toString());

    // Upload to server
    const response = await csrfFetch('/api/user/attachments', {
      method: 'POST',
      headers: {
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: formData
    });

    if (!response.ok) {
      const errorData = await readErrorPayload(response);
      throw buildRequestError(response, errorData, {
        fallbackMessage: `Failed to upload ${imageEntry.file?.name || 'attachment'}`
      });
    }

    const data = await response.json();

    imageEntry.status = 'success';
    imageEntry.attachmentId = data.attachment.attachmentId;
    renderImagePreviews();

    return data.attachment.attachmentId;

  } catch (error) {
    console.error('Image upload failed:', error);
    imageEntry.status = 'error';
    imageEntry.error = error.message || 'Upload failed';
    if (typeof window.DashboardHelpers?.notifyRateLimit === 'function') {
      window.DashboardHelpers.notifyRateLimit(error, { scope: 'dashboard-upload-attachment', title: 'Upload Delayed' });
    }
    renderImagePreviews();
    return null;
  }
}

/**
 * Upload all pending images
 * @returns {Promise<string[]>} - Array of successful attachment IDs
 */
async function uploadAllImages() {
  if (pendingImages.length === 0) return [];

  isUploadingImages = true;
  updateComposerState();

  const attachmentIds = [];

  // Upload images sequentially to show progress
  for (const imageEntry of pendingImages) {
    if (imageEntry.status === 'success' && imageEntry.attachmentId) {
      // Already uploaded
      attachmentIds.push(imageEntry.attachmentId);
      continue;
    }

    const attachmentId = await uploadSingleImage(imageEntry);
    if (attachmentId) {
      attachmentIds.push(attachmentId);
    }
  }

  isUploadingImages = false;
  updateComposerState();

  return attachmentIds;
}

/**
 * Check if there are any failed uploads
 * @returns {boolean}
 */
function hasFailedUploads() {
  return pendingImages.some(img => img.status === 'error');
}

function buildFailedUploadMessage(images = []) {
  const failedImages = images.filter((img) => img?.status === 'error');
  if (failedImages.length === 0) {
    return 'Attachment upload failed. Please remove or retry.';
  }

  const firstError = failedImages[0]?.error || 'Attachment upload failed.';
  const failedNames = failedImages
    .map((img) => img?.file?.name || 'attachment')
    .filter(Boolean);

  if (failedNames.length === 0) {
    return firstError;
  }

  return `${firstError} Failed: ${failedNames.join(', ')}.`;
}

/**
 * Retry failed uploads
 */
async function retryFailedUploads() {
  const failedImages = pendingImages.filter(img => img.status === 'error');
  for (const img of failedImages) {
    img.status = 'pending';
    img.error = null;
  }
  renderImagePreviews();
  return uploadAllImages();
}

// =============================================================================
// Message Attachment Display Functions
// =============================================================================

// Track object URLs for memory management
const attachmentObjectUrls = new Map(); // messageId -> [objectUrl, ...]

/**
 * Download and decrypt an attachment
 * @param {Object} attachment - Attachment metadata from message
 * @returns {Promise<{blob: Blob, objectUrl: string}|null>} - Decrypted blob and object URL, or null on error
 */
async function downloadAndDecryptAttachment(attachment) {
  try {
    if (attachment.sharedConversationId) {
      const response = await fetch(attachment.downloadUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const ciphertext = await response.arrayBuffer();
      const version = Number(response.headers.get('X-Shared-Key-Version')) || Number(attachment.sharedKeyVersion);
      const decryptedBuffer = await window.InPlaceChat.decryptSharedFile(attachment.sharedConversationId, version, ciphertext);
      const blob = new Blob([decryptedBuffer], { type: inferAttachmentContentType(attachment) });
      return { blob, objectUrl: URL.createObjectURL(blob) };
    }
    if (!encryptionKey) {
      throw new Error('No encryption key available');
    }

    // Download the encrypted ciphertext
    const response = await fetch(attachment.downloadUrl);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const ciphertext = await response.arrayBuffer();

    // Get encryption metadata
    const iv = window.E2EEncryption.base64ToArrayBuffer(attachment.encryption.ivBase64);
    const authTag = window.E2EEncryption.base64ToArrayBuffer(attachment.encryption.tagBase64);

    // Decrypt the binary data
    const decryptedBuffer = await window.E2EEncryption.decryptBinaryWithKey(
      ciphertext,
      new Uint8Array(iv),
      new Uint8Array(authTag),
      encryptionKey
    );

    // Create blob with the correct content type
    const blob = new Blob([decryptedBuffer], { type: inferAttachmentContentType(attachment) });
    const objectUrl = URL.createObjectURL(blob);

    return { blob, objectUrl };
  } catch (error) {
    console.error('Failed to download/decrypt attachment:', error);
    return null;
  }
}

/**
 * Create attachment container HTML for a message
 * @param {Array} attachments - Array of attachment metadata
 * @param {string} messageId - The message ID for tracking
 * @returns {HTMLElement} - The attachments container element
 */
function createAttachmentsContainer(attachments, messageId) {
  const container = document.createElement('div');
  container.className = 'message-attachments';
  container.dataset.messageId = messageId;

  attachments.forEach((attachment, index) => {
    const attachmentEl = createAttachmentPlaceholder(attachment, messageId, index);
    container.appendChild(attachmentEl);
  });

  return container;
}

/**
 * Create a placeholder element while attachment loads
 * @param {Object} attachment - Attachment metadata
 * @param {string} messageId - The message ID
 * @param {number} index - Index of attachment in message
 * @returns {HTMLElement}
 */
function createAttachmentPlaceholder(attachment, messageId, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-attachment-loading';
  wrapper.dataset.attachmentIndex = index;
  wrapper.innerHTML = '<div class="message-attachment-spinner"></div>';
  return wrapper;
}

/**
 * Create a loaded attachment element with image
 * @param {Object} attachment - Attachment metadata
 * @param {string} objectUrl - Object URL for the decrypted image
 * @param {string} messageId - The message ID
 * @returns {HTMLElement}
 */
function createAttachmentElement(attachment, objectUrl, messageId) {
  const item = document.createElement('div');
  item.className = 'message-attachment-item';
  const isImage = isAttachmentImage(attachment);
  const isVideo = isAttachmentVideo(attachment);
  const displayName = attachment.fileName || attachment.filename || 'attachment';

  if (isImage) {
    const img = document.createElement('img');
    img.className = 'message-attachment-image';
    img.src = objectUrl;
    img.alt = displayName;
    img.loading = 'lazy';
    img.onclick = () => openImageLightbox(objectUrl, displayName, attachment.contentType);
    item.appendChild(img);
  } else if (isVideo) {
    const video = document.createElement('video');
    video.className = 'message-attachment-video';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = objectUrl;
    const source = document.createElement('source');
    source.src = objectUrl;
    source.type = inferAttachmentContentType(attachment);
    video.appendChild(source);
    video.load();
    item.appendChild(video);
  } else {
    const fileCard = document.createElement('div');
    fileCard.className = 'message-attachment-file';
    const fileExt = displayName.split('.').pop()?.slice(0, 6).toUpperCase() || 'FILE';
    fileCard.innerHTML = `
      <div class="message-attachment-file-icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
        </svg>
      </div>
      <div class="message-attachment-file-meta">
        <span class="message-attachment-file-ext">${escapeHtml(fileExt)}</span>
        <span class="message-attachment-file-type">${escapeHtml(attachment.contentType || 'application/octet-stream')}</span>
      </div>
    `;
    item.appendChild(fileCard);
  }

  const infoBar = document.createElement('div');
  infoBar.className = 'message-attachment-info';

  const filename = document.createElement('span');
  filename.className = 'message-attachment-filename';
  filename.textContent = displayName;
  filename.title = displayName;

  const actions = document.createElement('div');
  actions.className = 'message-attachment-actions';

  // Expand button
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'message-attachment-btn';
  expandBtn.title = isImage ? 'View full size' : 'Open attachment';
  expandBtn.innerHTML = `
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
    </svg>
  `;
  expandBtn.onclick = () => {
    if (isImage) {
      openImageLightbox(objectUrl, displayName, attachment.contentType);
      return;
    }
    window.open(objectUrl, '_blank', 'noopener');
  };

  // Download button
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'message-attachment-btn';
  downloadBtn.title = 'Download';
  downloadBtn.innerHTML = `
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
    </svg>
  `;
  downloadBtn.onclick = () => downloadDecryptedImage(objectUrl, displayName, attachment.contentType);

  actions.appendChild(expandBtn);
  actions.appendChild(downloadBtn);
  infoBar.appendChild(filename);
  infoBar.appendChild(actions);
  item.appendChild(infoBar);

  return item;
}

/**
 * Create an error element for failed attachments
 * @param {string} errorMessage - Error message to display
 * @returns {HTMLElement}
 */
function createAttachmentErrorElement(errorMessage) {
  const errorEl = document.createElement('div');
  errorEl.className = 'message-attachment-error';
  errorEl.innerHTML = `
    <svg class="message-attachment-error-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
    </svg>
    <span class="message-attachment-error-text">${escapeHtml(errorMessage)}</span>
  `;
  return errorEl;
}

/**
 * Load and display all attachments for a message
 * @param {HTMLElement} container - The attachments container
 * @param {Array} attachments - Array of attachment metadata
 * @param {string} messageId - The message ID
 */
async function loadMessageAttachments(container, attachments, messageId) {
  const objectUrls = [];

  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    const placeholder = container.querySelector(`[data-attachment-index="${i}"]`);

    if (!placeholder) continue;

    const result = await downloadAndDecryptAttachment(attachment);

    if (result) {
      objectUrls.push(result.objectUrl);
      const attachmentEl = createAttachmentElement(attachment, result.objectUrl, messageId);
      placeholder.replaceWith(attachmentEl);
    } else {
      const errorEl = createAttachmentErrorElement(
        encryptionKey ? 'Failed to decrypt' : 'Set password to view'
      );
      placeholder.replaceWith(errorEl);
    }
  }

  // Track object URLs for memory management
  if (objectUrls.length > 0) {
    attachmentObjectUrls.set(messageId, objectUrls);
  }
}

/**
 * Open the image lightbox modal
 * @param {string} objectUrl - Object URL for the image
 * @param {string} filename - Original filename
 * @param {string} contentType - MIME type of the image
 */
function openImageLightbox(objectUrl, filename, contentType) {
  const lightbox = document.getElementById('imageLightbox');
  const lightboxImage = document.getElementById('lightboxImage');
  const lightboxFilename = document.getElementById('lightboxFilename');
  const lightboxDownload = document.getElementById('lightboxDownload');

  if (!lightbox || !lightboxImage) return;

  lightboxImage.src = objectUrl;
  lightboxImage.alt = filename || 'Image';

  if (lightboxFilename) {
    lightboxFilename.textContent = filename || 'image';
  }

  if (lightboxDownload) {
    lightboxDownload.href = objectUrl;
    lightboxDownload.download = filename || 'image';
  }

  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Focus trap for accessibility
  lightbox.focus();
}

/**
 * Close the image lightbox modal
 */
function closeImageLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  const lightboxImage = document.getElementById('lightboxImage');

  if (!lightbox) return;

  lightbox.classList.remove('active');
  document.body.style.overflow = '';

  // Clear the image source after transition
  setTimeout(() => {
    if (lightboxImage) {
      lightboxImage.src = '';
    }
  }, 300);
}

/**
 * Download a decrypted image
 * @param {string} objectUrl - Object URL for the image
 * @param {string} filename - Original filename
 * @param {string} contentType - MIME type of the image
 */
function downloadDecryptedImage(objectUrl, filename, contentType) {
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename || 'image';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Revoke object URLs for a message to free memory
 * @param {string} messageId - The message ID
 */
function revokeAttachmentUrls(messageId) {
  const urls = attachmentObjectUrls.get(messageId);
  if (urls) {
    urls.forEach(url => URL.revokeObjectURL(url));
    attachmentObjectUrls.delete(messageId);
  }
}

/**
 * Revoke all attachment object URLs (call when clearing conversation)
 */
function revokeAllAttachmentUrls() {
  attachmentObjectUrls.forEach((urls, messageId) => {
    urls.forEach(url => URL.revokeObjectURL(url));
  });
  attachmentObjectUrls.clear();
}

/**
 * Initialize lightbox event handlers
 */
function initializeLightbox() {
  const lightbox = document.getElementById('imageLightbox');
  const closeBtn = document.getElementById('lightboxCloseBtn');

  if (!lightbox) return;

  // Close on button click
  if (closeBtn) {
    closeBtn.addEventListener('click', closeImageLightbox);
  }

  // Close on backdrop click
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      closeImageLightbox();
    }
  });

  // Close on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox.classList.contains('active')) {
      closeImageLightbox();
    }
  });
}

// Initialize lightbox when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeLightbox);
} else {
  initializeLightbox();
}

// Preserve the icon and refresh the live participant count and accessible label.
function updateSharedChatControl(context, details) {
  const button = document.getElementById('selectedChatContextStatus');
  if (!button) return;
  button.hidden = context?.mode !== 'shared';
  const count = details ? [...(details.members || []), ...(details.guests || [])]
    .filter(member => member.status === 'active').length : null;
  const countNode = button.querySelector('[data-shared-participant-count]');
  if (countNode) countNode.textContent = count === null ? '…' : String(count);
  const action = context?.role === 'owner' ? 'Manage sharing' : 'View people and sharing';
  const label = count === null ? action : `${action} · ${count} ${count === 1 ? 'person' : 'people'}`;
  button.setAttribute('aria-label', label);
  button.title = label;
}

/**
 * Handle agent selection (Council Chamber version)
 */
async function selectAgent(agentId, agentName, metadata = {}) {
  const selection = ++sharedChatSelectionRequest;
  openingChatSelection = null;
  if (!metadata.chatContext && !metadata.skipSharedResolve && window.InPlaceChat?.resolveAgentContext &&
      agentId !== '__ALL__' && metadata.agentType !== 'news_feed') {
    if (isMobileListOnlyMode()) {
      openingChatSelection = selection;
      stopMessagePolling();
      ++activeConversationLoadToken;
      ++conversationRenderGeneration;
      setMobileListExpanded(false, { skipBrowserHistory: true });
      document.getElementById('agentPanelPlaceholder')?.classList.add('hidden');
      const area = document.getElementById('conversationArea');
      if (area) {
        area.classList.remove('hidden');
        area.innerHTML = `<div class="conversation-loading-overlay" role="status"><div class="conversation-loading-overlay__spinner"></div><span>Opening ${escapeHtml(agentName || 'chat')}…</span></div>`;
      }
      updateComposerState();
    }
    try {
      const context = await window.InPlaceChat.resolveAgentContext(agentId);
      if (selection !== sharedChatSelectionRequest) return;
      if (context.mode === 'shared' || context.state === 'preparing') metadata = { ...metadata, chatContext: context, forceMainSelection: true };
    } catch (error) {
      if (selection !== sharedChatSelectionRequest) return;
      showErrorMessage(error.message || 'Could not open this conversation.');
      const area = document.getElementById('conversationArea');
      if (openingChatSelection === selection && area) {
        area.innerHTML = `<div class="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-300"><p>${escapeHtml(error.message || 'Could not open this chat.')}</p><button type="button" class="min-h-11 rounded-lg bg-emerald-600 px-4 font-semibold text-white" data-retry-open-chat>Try again</button></div>`;
        area.querySelector('[data-retry-open-chat]')?.addEventListener('click', () => { void selectAgent(agentId, agentName, metadata); });
      }
      return;
    } finally {
      if (openingChatSelection === selection) {
        openingChatSelection = null;
        updateComposerState();
      }
    }
  }
  const focusSidePanel = shouldSelectIntoSidePanel(agentId, metadata);
  // If this agent is already open in a side tile, jump to it instead of changing main chat
  if (focusSidePanel) {
    const tile = findSidePanelTile(agentId);
    if (tile) {
      tile.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      tile.querySelector('.chat-tile__textarea')?.focus();
      tile.classList.add('chat-tile--flash');
      setTimeout(() => tile.classList.remove('chat-tile--flash'), 600);
      return;
    }
  }

  selectedChatContext = metadata.chatContext || null;
  window.InPlaceChat?.setContext(selectedChatContext);
  document.body.classList.toggle('dashboard-shared-chat', selectedChatContext?.mode === 'shared');
  const leaveSharedButton = document.getElementById('leaveSharedConversationHeaderBtn');
  updateSharedChatControl(selectedChatContext);
  if (leaveSharedButton) {
    leaveSharedButton.hidden = !selectedChatContext || selectedChatContext.role === 'owner';
    if (!leaveSharedButton.dataset.inPlaceBound) {
      leaveSharedButton.dataset.inPlaceBound = 'true';
      leaveSharedButton.addEventListener('click', async () => {
        try { if (selectedChatContext?.conversationId) await window.InPlaceChat?.leaveConversation(selectedChatContext.conversationId); }
        catch (error) { leaveSharedButton.title = error.message || 'Could not leave this conversation.'; }
      });
    }
  }
  if (selectedChatContext) resetMainInteractiveSpace();

  const previousAgentId = selectedAgentId;

  const useCarouselTransition = isMobileDockViewport();
  let carouselDirection = 0;
  if (useCarouselTransition) {
    if (pendingChatCarouselDirection !== 0) {
      carouselDirection = pendingChatCarouselDirection;
    } else if (previousAgentId && previousAgentId !== agentId && dockSortedAgents && dockSortedAgents.length > 1) {
      const oldIndex = dockSortedAgents.findIndex(a => a.agentId === previousAgentId);
      const newIndex = dockSortedAgents.findIndex(a => a.agentId === agentId);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const len = dockSortedAgents.length;
        const forwardSteps = (newIndex - oldIndex + len) % len;
        const backwardSteps = (oldIndex - newIndex + len) % len;
        carouselDirection = forwardSteps <= backwardSteps ? 1 : -1;
      }
    }
  }
  pendingChatCarouselDirection = 0;

  if (useCarouselTransition && previousAgentId && previousAgentId !== agentId) {
    await animateConversationLeave(carouselDirection);
  }

  // Save scroll position for previous agent
  if (selectedAgentId) {
    const conversationArea = document.getElementById('conversationArea');
    if (conversationArea) {
      agentScrollPositions.set(selectedAgentId, conversationArea.scrollTop);
    }
  }

  // Clear pending images when switching agents (they're not uploaded yet)
  if (pendingImages.length > 0) {
    clearAllImages();
  }

  // Stop polling for previously selected agent
  stopMessagePolling();

  // Auto-collapse agent list on mobile when selecting an agent
  if (isMobileListOnlyMode()) {
    clearAgentListSearch({ blur: true, update: true });
    setMobileListExpanded(false, { skipBrowserHistory: true });
  }

  // Update selected agent
  selectedAgentId = agentId;
  forceScrollToBottomOnNextRender = true;
  forceScrollToBottomUntil = Date.now() + 2500;
  const cachedAgentName =
    (Array.isArray(currentAgentList)
      ? currentAgentList.find((agent) => agent.agentId === agentId)?.name
      : null) ||
    (agentListCache?.agents || []).find((agent) => agent.agentId === agentId)?.name ||
    '';
  const resolvedAgentName =
    agentName ||
    metadata.agentName ||
    metadata.name ||
    cachedAgentName ||
    'Agent';
  selectedAgentName = resolvedAgentName;
  selectedAgentType = metadata.agentType || 'standard';
  const inPlaceShareButton = document.getElementById('headerShareExistingChatBtn');
  if (inPlaceShareButton) inPlaceShareButton.hidden = Boolean(
    selectedChatContext?.mode === 'shared' || selectedChatContext?.privateHistory ||
    agentId === '__ALL__' || selectedAgentType === 'news_feed'
  );
  selectedAgentExternalProvider = metadata.externalProvider || '';
  // Expose for header pin button
  window._lastSelectedAgentId = agentId;
  updateMainPinButtonState();
  if (!selectedAgentExternalProvider && Array.isArray(currentAgentList)) {
    const selectedAgent = currentAgentList.find((agent) => agent.agentId === agentId);
    selectedAgentExternalProvider = selectedAgent?.externalProvider || '';
  }
  lastMessageTimestamp = null;
  lastMessageCursor = null;

  // Keep reloads and mobile reopening aligned with the visible conversation.
  rememberLastChat(agentId, selectedChatContext);
  window.RecentChats?.remember(agentId, selectedChatContext);
  recordChatNavigation(agentId, resolvedAgentName, metadata);
  if (metadata.skipMobileBrowserHistory !== true) {
    writeMobileBrowserNavigationState('chat', { agentId });
  }

  // Show agent panel
  const placeholder = document.getElementById('agentPanelPlaceholder');
  const header = document.getElementById('agentPanelHeader');
  const conversationArea = document.getElementById('conversationArea');
  const messageInputArea = document.getElementById('messageInputArea');

  if (placeholder) placeholder.classList.add('hidden');
  // Header styling logic is now handled below with isNewsAgent check

  const selectedConversationId = selectedChatContext?.mode === 'shared' ? selectedChatContext.conversationId : null;
  const conversationCacheKey = selectedConversationId || agentId;
  const hasCachedConversation = conversationCache.has(conversationCacheKey);
  if (conversationArea) {
    conversationArea.classList.remove('hidden');
    if (!hasCachedConversation) {
      conversationArea.innerHTML = '<div class="conversation-loading-overlay"><div class="conversation-loading-overlay__spinner"></div><span>Loading messages…</span></div>';
    }
    if (useCarouselTransition) {
      const token = scheduleConversationEnter(carouselDirection);
      conversationArea.dataset.chatCarouselToken = String(token);
    } else {
      delete conversationArea.dataset.chatCarouselToken;
    }
  }
  const isAllChatsView = agentId === '__ALL__';
  if (isAllChatsView) {
    if (messageInputArea) messageInputArea.classList.add('hidden');
    document.body.dataset.agentSelected = 'true';
    document.body.dataset.allChatsView = 'true';
  } else {
    if (messageInputArea) messageInputArea.classList.remove('hidden');
    document.body.removeAttribute('data-all-chats-view');
    // Mark body so mobile CSS can force input visible even if 'hidden' class sneaks back
    document.body.dataset.agentSelected = 'true';
    ensureMobileComposerVisible({ restoreChrome: true });
  }

  // Update agent header
  const initialsEl = document.getElementById('selectedAgentInitials');
  const imageEl = document.getElementById('selectedAgentImage');
  const nameEl = document.getElementById('selectedAgentName');
  const lastActiveEl = document.getElementById('agentLastActive');
  const statusPill = document.getElementById('agentStatusPill');
  const unreadBadge = document.getElementById('agentUnreadBadge');

  const isNewsAgent = selectedAgentType === 'news_feed' || (selectedAgentName || '').toLowerCase().includes('local news');
  const isOpenClaw = isOpenClawProvider(selectedAgentExternalProvider);

  if (header) {
    header.classList.remove('hidden');
    // Apply styling for News Feed
    if (isOpenClaw) {
      header.classList.add('bg-orange-900/30', 'border-orange-700/40', 'shadow-lg', 'shadow-orange-900/20');
      header.classList.remove('bg-blue-900/40', 'border-blue-700/40', 'shadow-blue-900/20', 'bg-blue-950/60', 'border-blue-800/50', 'bg-sky-900/20', 'border-sky-800/30', 'border-white/5');
    } else if (isNewsAgent) {
      // Blue theme for News Agents
      header.classList.add('bg-blue-900/40', 'border-blue-700/40', 'shadow-lg', 'shadow-blue-900/20');
      header.classList.remove('bg-blue-950/60', 'border-blue-800/50', 'bg-orange-900/30', 'border-orange-700/40', 'shadow-orange-900/20');
      header.classList.remove('bg-sky-900/20', 'border-sky-800/30', 'border-white/5');
    } else {
      // Default theme
      header.classList.remove('bg-blue-900/40', 'border-blue-700/40', 'shadow-lg', 'shadow-blue-900/20');
      header.classList.remove('bg-blue-950/60', 'border-blue-800/50');
      header.classList.remove('bg-orange-900/30', 'border-orange-700/40', 'shadow-orange-900/20');
      header.classList.remove('bg-sky-900/20', 'border-sky-800/30');
      header.classList.add('border-white/5');
    }
  }

  // Ensure avatar renders for the selected agent
  if (imageEl) {
    if (isOpenClaw) {
      imageEl.innerHTML = `
        <div class="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-orange-950/30 to-slate-900">
          <div class="w-[72%] h-[72%] rounded-full border border-orange-400/40 bg-slate-950/70 flex items-center justify-center shadow-[0_0_20px_rgba(251,146,60,0.25)]">
            ${getOpenClawIconSvg('w-[72%] h-[72%] text-orange-300')}
          </div>
        </div>
      `;
      if (initialsEl) initialsEl.classList.add('hidden');
    } else {
      imageEl.innerHTML = getCachedMarbleSvg(agentId, 100, agentName, 'selected');
      if (initialsEl) initialsEl.classList.remove('hidden');
    }
  }

  // Update image border for OpenClaw / News / default
  if (imageEl && imageEl.parentElement) {
    if (isOpenClaw) {
      imageEl.parentElement.classList.remove('border-emerald-400/60', 'shadow-emerald-500/30', 'border-sky-400/60', 'shadow-sky-500/30');
      imageEl.parentElement.classList.add('border-orange-400/60', 'shadow-orange-500/30');
    } else if (isNewsAgent) {
      imageEl.parentElement.classList.remove('border-emerald-400/60', 'shadow-emerald-500/30');
      imageEl.parentElement.classList.remove('border-orange-400/60', 'shadow-orange-500/30');
      imageEl.parentElement.classList.add('border-sky-400/60', 'shadow-sky-500/30');
    } else {
      imageEl.parentElement.classList.remove('border-orange-400/60', 'shadow-orange-500/30');
      imageEl.parentElement.classList.add('border-emerald-400/60', 'shadow-emerald-500/30');
      imageEl.parentElement.classList.remove('border-sky-400/60', 'shadow-sky-500/30');
    }
  }

  // Update text color for OpenClaw / News / default
  if (nameEl) {
    nameEl.textContent = resolvedAgentName;
    if (isOpenClaw) {
      nameEl.classList.remove('text-white', 'text-sky-100');
      nameEl.classList.add('text-orange-100');
    } else if (isNewsAgent) {
      nameEl.classList.remove('text-white');
      nameEl.classList.remove('text-orange-100');
      nameEl.classList.add('text-sky-100');
    } else {
      nameEl.classList.add('text-white');
      nameEl.classList.remove('text-orange-100');
      nameEl.classList.remove('text-sky-100');
    }
  }
  const workingDot = document.getElementById('selectedAgentWorkingIndicator');
  if (workingDot) {
    workingDot.style.display = metadata.isWorking ? '' : 'none';
    setWorkingDotHint(workingDot, metadata.isWorking ? metadata.lastHeartbeat : null);
  }
  if (lastActiveEl) {
    if (metadata.isWorking && metadata.lastHeartbeat) {
      lastActiveEl.textContent = `Working • heartbeat ${formatRelativeTime(metadata.lastHeartbeat)}`;
    } else if (metadata.lastActivity) {
      lastActiveEl.textContent = `Last active ${formatRelativeTime(metadata.lastActivity)}`;
    } else {
      lastActiveEl.textContent = 'No recent activity';
    }
  }
  if (statusPill) {
    const status = getStatusFromMetadata(metadata);
    statusPill.textContent = status.label;
    statusPill.className = `status-pill ${status.className} text-[10px]`;
  }
  if (unreadBadge) {
    if (metadata.unread > 0) {
      const unreadLabel = `${metadata.unread} unread message${metadata.unread === 1 ? '' : 's'}`;
      unreadBadge.textContent = `\u{1F4E9} ${metadata.unread}`;
      unreadBadge.title = unreadLabel;
      unreadBadge.setAttribute('aria-label', unreadLabel);
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }

  refreshVisibleAgentActionStats(metadata);

  const loadToken = ++activeConversationLoadToken;

  if (hasCachedConversation) {
    await displayMessages(conversationCache.get(conversationCacheKey), false, { agentId, requestToken: loadToken, conversationId: selectedConversationId });
    if (isStaleConversationLoad(agentId, loadToken)) {
      return;
    }
  }

  // Load messages for selected agent
  loadMessages(agentId, loadToken, { renderCached: !hasCachedConversation });

  updateAgentLoopToggleUi();

  // Start polling messages for selected agent unless paused
  if (isAgentLoopPausedFor(agentId)) {
    stopMessagePolling();
  } else {
    startMessagePolling(agentId);
  }

  updateComposerState();

  // Load and display agent config (not applicable for all-chats view)
  if (agentId !== '__ALL__') {
    loadAgentConfig();
    // Load and display inter-agent stats
    loadInterAgentStats();
  }

  // Update agent list UI from cache to reflect the selection
  // No need to fetch from server - the cache is updated by the regular polling interval
  clearOpenChatUnread(agentListCache.agents);
  document.getElementById('agentUnreadBadge')?.classList.add('hidden');
  if (agentListCache.agents.length > 0) {
    updateAgentListUI(agentListCache.agents);
  }

  // Update mobile dock center to show selected agent
  syncDockToSelectedAgent(agentId);
  scheduleConversationPreload(currentAgentList);

  // The mobile list closes at selection start. A render finishing later must
  // respect a list the user has opened while that render was in progress.
}



/**
 * Start polling messages for selected agent with server-directed adaptive backoff.
 */
function startMessagePolling(agentId) {
  if (agentId !== '__ALL__' && isAgentLoopPausedFor(agentId)) {
    stopMessagePolling();
    return;
  }

  // Ensure we don't create duplicate intervals
  stopMessagePolling();
  resetMessagePollCadence();

  // Poll immediately first
  scheduleMessagePoll(agentId, 0);
}

function scheduleMessagePoll(agentId, delayMs = messagePollNextDelayMs) {
  stopMessagePolling();
  messagePollingInterval = setTimeout(async () => {
    if (selectedAgentId !== agentId || (agentId !== '__ALL__' && isAgentLoopPausedFor(agentId))) {
      return;
    }
    if (messagePollInFlight) {
      scheduleMessagePoll(agentId, messagePollNextDelayMs);
      return;
    }
    messagePollInFlight = true;
    try {
      await pollMessages(agentId);
    } finally {
      messagePollInFlight = false;
      if (selectedAgentId === agentId && (agentId === '__ALL__' || !isAgentLoopPausedFor(agentId))) {
        scheduleMessagePoll(agentId, messagePollNextDelayMs);
      }
    }
  }, Math.max(0, delayMs));
}

/**
 * Stop polling messages
 */
function stopMessagePolling() {
  if (messagePollingInterval) {
    clearTimeout(messagePollingInterval);
    messagePollingInterval = null;
  }
}

/**
 * Load messages for selected agent (initial load)
 */
function isStaleConversationLoad(agentId, requestToken) {
  if (requestToken === null || requestToken === undefined) {
    return selectedAgentId !== agentId;
  }
  return selectedAgentId !== agentId || activeConversationLoadToken !== requestToken;
}

async function fetchConversationPayload(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = response.ok ? await response.json() : await readErrorPayload(response);
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The connection is taking too long. Please try again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function showConversationLoadRetry(agentId, requestToken, message) {
  const area = document.getElementById('conversationArea');
  if (!area) return;
  area.innerHTML = `<div class="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-300"><p>${escapeHtml(message)}</p><button type="button" class="min-h-11 rounded-lg bg-emerald-600 px-4 font-semibold text-white" data-retry-messages>Try again</button></div>`;
  area.querySelector('[data-retry-messages]')?.addEventListener('click', () => {
    if (!isStaleConversationLoad(agentId, requestToken)) void loadMessages(agentId, requestToken, { forceShared: true });
  });
}

async function loadMessages(agentId, requestToken = null, options = {}) {
  const { renderCached = true, forceShared = false } = options;

  if (selectedChatContext?.mode === 'shared' && selectedChatContext.agentId === agentId) {
    const conversationId = selectedChatContext.conversationId;
    // Private pagination state is keyed by agent ID. A shared room for the
    // same agent must never reuse it to fetch or append private history.
    conversationHasMore.set(agentId, false);
    conversationOldestCursor.delete(agentId);
    const cachedShared = conversationCache.get(conversationId);
    if (cachedShared && renderCached && !forceShared) await displayMessages(cachedShared, false, { agentId, requestToken, conversationId });
    if (cachedShared && !forceShared) return;
    isLoadingMessages = true;
    try {
      const messages = await window.InPlaceChat.loadTimeline();
      if (selectedChatContext?.conversationId !== conversationId || isStaleConversationLoad(agentId, requestToken)) return;
      conversationCache.set(conversationId, messages);
      await displayMessages(messages, false, { agentId, requestToken, conversationId });
    } catch (error) {
      if (selectedChatContext?.conversationId !== conversationId) return;
      showConversationLoadRetry(agentId, requestToken, error.message || 'Shared conversation is not ready.');
    } finally { isLoadingMessages = false; }
    return;
  }

  // Check cache first - display cached messages immediately for responsiveness
  if (conversationCache.has(agentId)) {
    if (renderCached) {
      const cachedMessages = conversationCache.get(agentId);
      await displayMessages(cachedMessages, false, { agentId, requestToken });
    }
    // Don't return - still fetch fresh data in background via polling
    // The pollMessages call in startMessagePolling will pick up any new messages
    return;
  }

  // Set loading flag to prevent polling interference
  isLoadingMessages = true;

  try {
    const isAllChats = agentId === '__ALL__';
    const baseUrl = isAllChats ? '/api/user/messages/all' : `/api/user/messages/${agentId}`;
    const apiUrl = isAllChats ? baseUrl : `${baseUrl}?limit=${INITIAL_MESSAGE_LIMIT}`;
    const { response, data } = await fetchConversationPayload(apiUrl);

    if (isStaleConversationLoad(agentId, requestToken)) {
      return;
    }

    if (!response.ok) {
      const requestError = buildRequestError(response, data, { fallbackMessage: 'Failed to load messages' });
      console.error('Failed to fetch messages:', response.status, requestError.message);
      if (notifyRateLimit(requestError, { scope: 'load-messages' })) {
        return;
      }
      showConversationLoadRetry(agentId, requestToken, requestError.message);
      return;
    }

    if (isStaleConversationLoad(agentId, requestToken)) {
      return;
    }

    // Cache the messages and pagination state
    conversationCache.set(agentId, data.messages);
    conversationHasMore.set(agentId, data.hasMore === true);
    if (data.oldestCursor) {
      conversationOldestCursor.set(agentId, data.oldestCursor);
    }

    await displayMessages(data.messages, false, { agentId, requestToken });

    // On mobile/Fast Mode, avoid a second full-history render immediately after
    // opening the chat. That render can block taps and delay keyboard focus on
    // large conversations. Desktop still warms the full cache in the background.
    // Older history is loaded on demand when the user scrolls near the top.

  } catch (error) {
    if (isStaleConversationLoad(agentId, requestToken)) {
      return;
    }
    console.error('Error loading messages:', error);
    showConversationLoadRetry(agentId, requestToken, error.message || 'Error loading messages.');
  } finally {
    isLoadingMessages = false;
  }
}

async function loadOlderMessagesInBackground(agentId, requestToken) {
  if (selectedChatContext?.mode === 'shared') {
    conversationHasMore.set(agentId, false);
    return;
  }
  if (isStaleConversationLoad(agentId, requestToken)) return;
  if (isLoadingOlderMessages) return;
  isLoadingOlderMessages = true;

  // Show a small banner at the top while loading
  const conversationArea = document.getElementById('conversationArea');
  let banner = null;
  if (conversationArea) {
    banner = document.createElement('div');
    banner.className = 'load-more-banner';
    banner.id = 'loadMoreBanner';
    banner.innerHTML = '<div class="load-more-banner__spinner"></div><span>Loading earlier messages…</span>';
    conversationArea.prepend(banner);
  }

  try {
    const apiUrl = `/api/user/messages/${agentId}`;
    const response = await fetch(apiUrl);

    if (isStaleConversationLoad(agentId, requestToken)) return;
    if (!response.ok) return;

    const data = await response.json();
    if (isStaleConversationLoad(agentId, requestToken)) return;

    // Replace cache with full message set
    conversationCache.set(agentId, data.messages);
    conversationHasMore.set(agentId, false);
    conversationOldestCursor.delete(agentId);

    // Re-render with full messages, preserving scroll position near the bottom
    const shouldStayPinnedToLatest = false;
    const wasNearBottom = conversationArea
      ? (conversationArea.scrollHeight - conversationArea.scrollTop - conversationArea.clientHeight) < 80
      : true;

    await displayMessages(data.messages, false, {
      agentId,
      requestToken,
      preserveScrollPosition: !wasNearBottom && !shouldStayPinnedToLatest
    });

    if ((wasNearBottom || shouldStayPinnedToLatest) && conversationArea) {
      scrollToBottom();
    }
  } catch (err) {
    console.warn('Failed to load older messages:', err);
  } finally {
    isLoadingOlderMessages = false;
    const existingBanner = document.getElementById('loadMoreBanner');
    if (existingBanner) existingBanner.remove();
  }
}

/**
 * Scroll options for a full re-render of the chat that is already open
 * (shared timeline polls, history updates). Without them displayMessages
 * restores the position saved when the user last switched away from this
 * chat, which jumps the conversation upward after sending or on a reply.
 */
function liveRefreshScrollOptions(agentId) {
  const conversationArea = document.getElementById('conversationArea');
  const wasNearBottom = !conversationArea ||
    (conversationArea.scrollHeight - conversationArea.scrollTop - conversationArea.clientHeight) < 120;
  agentScrollPositions.delete(agentId);
  return { preserveScrollPosition: !wasNearBottom };
}

/**
 * Poll messages for selected agent (with 'since' parameter)
 */
async function pollMessages(agentId) {
  // Skip polling if we're in the middle of a full reload
  if (isLoadingMessages || isLoadingOlderMessages) {
    return;
  }

  if (selectedChatContext?.mode === 'shared' && selectedChatContext.agentId === agentId) {
    const conversationId = selectedChatContext.conversationId;
    try {
      const requestToken = activeConversationLoadToken;
      const messages = await window.InPlaceChat.loadTimeline();
      if (selectedChatContext?.conversationId !== conversationId || isStaleConversationLoad(agentId, requestToken)) return;
      if (isLoadingOlderMessages) return;
      const hasPrevious = conversationCache.has(conversationId);
      const previous = conversationCache.get(conversationId) || [];
      const signature = list => JSON.stringify(list.map(message => [message.messageId, message.content, message.timestamp, message.type,
        message.senderName, message.sharedSenderKind, message.sharedAudienceLabel, message.sharedAudienceMode]));
      conversationCache.set(conversationId, messages);
      window.DashboardHelpers?.updateMessageReceipts?.(messages);
      if (!hasPrevious || signature(previous) !== signature(messages)) {
        await displayMessages(messages, false, { agentId, conversationId, requestToken, ...liveRefreshScrollOptions(agentId) });
      }
      return;
    } catch (error) {
      console.warn('Shared conversation refresh failed:', error.message);
      return;
    }
  }

  if (isStaleConversationLoad(agentId, null)) {
    return;
  }

  try {
    const baseUrl = agentId === '__ALL__' ? '/api/user/messages/all' : `/api/user/messages/${agentId}`;
    let url = baseUrl;

    // Add 'since' parameter if we have a last message timestamp
    if (lastMessageCursor !== null) {
      url += `?cursor=${encodeURIComponent(lastMessageCursor)}`;
    } else if (lastMessageTimestamp) {
      url += `?since=${encodeURIComponent(lastMessageTimestamp)}`;
    }

    const response = await fetch(url);

    if (isStaleConversationLoad(agentId, null)) {
      return;
    }

    if (!response.ok) {
      const errorData = await readErrorPayload(response);
      const requestError = buildRequestError(response, errorData, { fallbackMessage: 'Failed to poll messages' });
      console.error('Failed to poll messages:', response.status, requestError.message);
      messagePollNextDelayMs = getServerPollDelayMs(response, errorData, messagePollNextDelayMs * 2);
      notifyRateLimit(requestError, { scope: 'poll-messages' });
      return;
    }

    const data = await response.json();

    if (isStaleConversationLoad(agentId, null)) {
      return;
    }

    const hasNewMessages = Array.isArray(data.messages) && data.messages.length > 0;
    messagePollNextDelayMs = getServerPollDelayMs(
      response,
      data,
      hasNewMessages ? DASHBOARD_MIN_POLL_INTERVAL_MS : messagePollNextDelayMs
    );

    // Only update UI if we have new messages
    if (hasNewMessages) {
      // Update cache with new messages (with deduplication)
      if (conversationCache.has(agentId)) {
        const cached = conversationCache.get(agentId);
        const existingIds = new Set(cached.map(m => m.messageId));
        const newMessages = data.messages.filter(m => !existingIds.has(m.messageId));

        if (newMessages.length > 0) {
          conversationCache.set(agentId, [...cached, ...newMessages]);
          displayMessages(newMessages, true, { agentId });
        }
      } else {
        conversationCache.set(agentId, data.messages);
        displayMessages(data.messages, true, { agentId });
      }
    }

    // Also check for readAt updates on existing user messages (not needed for all-chats)
    if (agentId !== '__ALL__') {
      await pollReadStatus(agentId);
    }

  } catch (error) {
    console.error('Error polling messages:', error);
  }
}

function messageReceiptPresentation(status = {}) {
  if (status.readAt || status.deliveryState === 'read') return { state: 'read', text: '✓✓', title: 'Read by agent' };
  if (status.deliveryState === 'sending' || status.serverReceived === false) {
    if (status.deliveryState === 'failed') return { state: 'failed', text: '⚠', title: 'Message could not reach the server' };
    return { state: 'pending', text: '✓', title: 'Sending to server' };
  }
  return { state: 'delivered', text: '✓✓', title: 'Received by server; not yet read by agent' };
}
function buildUserMessageReadIndicator(readAt, deliveryState, deliveryFailed, serverReceived = true) {
  const receipt = messageReceiptPresentation({ readAt, deliveryState, deliveryFailed, serverReceived });
  return `<span class="message-read-indicator message-read-indicator--${receipt.state}" data-receipt-state="${receipt.state}" role="img" aria-label="${receipt.title}" title="${receipt.title}">${receipt.text}</span>`;
}

function applyUserMessageDeliveryState(msgEl, status) {
  if (!msgEl || !status) {
    return;
  }

  const checkSpan = msgEl.querySelector('.message-read-indicator');
  if (!checkSpan) {
    return;
  }

  const receipt = messageReceiptPresentation(status);
  if (receipt.state === 'read') msgEl.setAttribute('data-read', 'true');
  else msgEl.removeAttribute('data-read');
  if (checkSpan.dataset.receiptState === receipt.state && checkSpan.title === receipt.title) return;
  checkSpan.classList.remove('message-read-indicator--pending', 'message-read-indicator--delivered', 'message-read-indicator--failed', 'message-read-indicator--read');
  checkSpan.classList.add('message-read-indicator--' + receipt.state);
  checkSpan.dataset.receiptState = receipt.state;
  checkSpan.setAttribute('role', 'img');
  checkSpan.setAttribute('aria-label', receipt.title);
  checkSpan.title = receipt.title;
  checkSpan.textContent = receipt.text;
}
function updateMessageReceipts(messages = []) {
  const statuses = new Map(messages.filter(message => message.type === 'user_message').map(message => [message.messageId, message]));
  document.getElementById('conversationArea')?.querySelectorAll('[data-message-id][data-message-type="user_message"]').forEach(node => {
    const status = statuses.get(node.dataset.messageId);
    if (status) applyUserMessageDeliveryState(node, status);
  });
}

/**
 * Poll for read status updates on user messages
 */
async function pollReadStatus(agentId) {
  if (selectedChatContext?.mode === 'shared' && selectedChatContext.agentId === agentId) return;
  try {
    if (isStaleConversationLoad(agentId, null)) {
      return;
    }

    // Find all user message elements that don't have the read indicator yet
    const unreadMessages = document.querySelectorAll('[data-message-id][data-message-type="user_message"]:not([data-read="true"])');

    if (unreadMessages.length === 0) {
      return;
    }

    const messageIds = Array.from(unreadMessages).map(el => el.getAttribute('data-message-id'));
    const response = await fetch(`/api/user/messages/${agentId}/status?ids=${encodeURIComponent(messageIds.join(','))}`);
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const statuses = Array.isArray(data?.statuses) ? data.statuses : [];
    if (isStaleConversationLoad(agentId, null)) {
      return;
    }

    statuses.forEach((status) => {
      const msgId = status.messageId;
      if (!msgId) return;

      const msgEl = document.querySelector(`[data-message-id="${msgId}"]`);
      if (msgEl) {
        applyUserMessageDeliveryState(msgEl, status);
      }

      if (conversationCache.has(agentId)) {
        const cached = conversationCache.get(agentId);
        const msgIndex = cached.findIndex(m => m.messageId === msgId);
        if (msgIndex >= 0) {
          cached[msgIndex].readAt = status.readAt || null;
          cached[msgIndex].deliveryState = status.deliveryState || (status.readAt ? 'read' : 'pending');
          cached[msgIndex].deliveryFailed = status.deliveryFailed === true;
        }
      }
    });
  } catch (error) {
    console.error('Error polling read status:', error);
  }
}

/**
 * Display messages in conversation area
 */
let conversationRendersInFlight = 0;
async function displayMessages(messages, append = false, context = {}) {
  conversationRendersInFlight += 1;
  try {
  const renderAgentId = context.agentId || selectedAgentId;
  const renderRequestToken = context.requestToken ?? null;
  const renderConversationId = context.conversationId || null;
  // Polling and Send can both refresh the same chat while decryption awaits.
  const renderGeneration = append ? conversationRenderGeneration : ++conversationRenderGeneration;
  const isRenderStale = () => isStaleConversationLoad(renderAgentId, renderRequestToken) ||
    renderGeneration !== conversationRenderGeneration ||
    Boolean(renderConversationId && selectedChatContext?.conversationId !== renderConversationId);
  const conversationArea = document.getElementById('conversationArea');
  const preserveScrollPosition = context.preserveScrollPosition === true;
  const previousScrollTop = conversationArea?.scrollTop ?? 0;
  const previousDistanceFromBottom = conversationArea
    ? conversationArea.scrollHeight - conversationArea.clientHeight - conversationArea.scrollTop
    : 0;
  const wasNearBottomBeforeRender = previousDistanceFromBottom < 120;

  if (isRenderStale()) {
    return false;
  }

  if (!messages || messages.length === 0) {
    if (!append) {
      if (isRenderStale()) {
        return false;
      }
      conversationArea.innerHTML = renderAgentId === '__ALL__'
        ? '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm">No messages from any agent yet.</p></div>'
        : '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm">No messages yet. Send a first instruction below.</p></div>';
      triggerConversationEnterIfScheduled();
      resetMainInteractiveSpace();
    }
    return true;
  }

  // Keep an existing transcript mounted while decryption and yielding rebuild
  // it. Clearing or prepending partial history collapses/moves the viewport.
  const replaceExistingTranscript = !append && Boolean(conversationArea.querySelector('[data-message-id]'));

  // Clear conversation area if not appending
  if (!append) {
    if (isRenderStale()) {
      return false;
    }
    // Clean up attachment object URLs from previous messages
    revokeAllAttachmentUrls();
    if (!replaceExistingTranscript) conversationArea.innerHTML = '';
  }

  // Add messages to conversation area
  let renderYieldAt = Date.now();
  const pendingElements = document.createDocumentFragment();
  // Show the newest messages first during a full refresh; prepend older ones
  // into chronological order while leaving time for phone taps and scrolling.
  const renderMessages = append ? messages : [...messages].reverse();
  for (const message of renderMessages) {
    if (isRenderStale()) return false;
    // Skip if this message already exists in the DOM (dedup for append mode)
    if (append && (document.querySelector(`[data-message-id="${message.messageId}"]`) ||
        pendingElements.querySelector(`[data-message-id="${message.messageId}"]`))) {
      continue;
    }

    // Track if message is still encrypted (for display purposes)
    let messageIsEncrypted = false;
    const originalContent = message.content;

    // Check if message content needs decryption:
    // 1. Explicitly marked as encrypted by the server (encrypted flag), OR
    // 2. Heuristic detection via looksLikeEncryptedText (for backwards compatibility)
    const isMarkedEncrypted = message.encrypted === true;
    const looksEncrypted = message.content && typeof message.content === 'string' && looksLikeEncryptedText(message.content);

    if (isMarkedEncrypted || looksEncrypted) {
      if (encryptionKey) {
        try {
          // Only attempt decryption if it looks like iv:tag:ciphertext
          const parts = (message.content || '').split(':');
          if (parts.length === 3) {
            message.content = await window.E2EEncryption.decryptMessage(message.content, encryptionKey);
            if (isRenderStale()) {
              return false;
            }
            // Clear the encrypted flag on the cached object so re-displaying
            // from cache (e.g. when switching back to this chat) won't try to
            // decrypt the already-decrypted content again.
            message.encrypted = false;
          } else if (isMarkedEncrypted) {
            // Server says encrypted but format doesn't match — show placeholder
            messageIsEncrypted = true;
          }
        } catch (e) {
          console.warn('Failed to decrypt message:', message.messageId);
          // Mark as encrypted - decryption failed (wrong password?)
          messageIsEncrypted = true;
        }
      } else {
        // No encryption key available - message will remain encrypted
        messageIsEncrypted = true;
      }
    }

    // If message is still encrypted, replace content with placeholder
    if (messageIsEncrypted) {
      message.content = '🔐';
      message.isEncryptedPlaceholder = true;
    }

    let messageElement;
    try {
      messageElement = createMessageElement(message);
    } catch (err) {
      console.error('Failed to render message', message.messageId, err);
      continue;
    }

    if (isRenderStale()) {
      return false;
    }

    // Add slide-in animation for new agent messages when appending
    if (append && (message.type === 'agent_message' || message.type === 'agent_question')) {
      const bubbleEl = messageElement.querySelector('.message-bubble');
      if (bubbleEl) {
        bubbleEl.classList.add('message-animate-in');
      }
      // Trigger ripple animation on the selected agent's avatar
      triggerAgentRipple(renderAgentId);

    }

    if (append) pendingElements.appendChild(messageElement);
    else pendingElements.prepend(messageElement);

    // Narrate new agent messages with a polished TTS voice
    if (append && (message.type === 'agent_message' || message.type === 'agent_question')) {
      // Regular agents get TTS priority
      // News feed agents are supplementary - their TTS is skipped if the message was already notified
      const isNewsAgent = selectedAgentType === 'news_feed';

      if (!isNewsAgent && shouldNotifyAgentMessage(renderAgentId, message.timestamp, message.messageId)) {
        // Regular agent - always play TTS
        markAgentMessageNotified(renderAgentId, message.timestamp, message.messageId);
        playVoiceNotification(message);
      } else if (isNewsAgent && shouldNotifyAgentMessage(renderAgentId, message.timestamp, message.messageId)) {
        // News feed agent - only play TTS if not already notified by regular agent
        // The global notification check in shouldNotifyAgentMessage handles this
        markAgentMessageNotified(renderAgentId, message.timestamp, message.messageId);
        playVoiceNotification(message);
      }
    }

    // Update last message timestamp
    if (!lastMessageTimestamp || new Date(message.timestamp) > new Date(lastMessageTimestamp)) {
      lastMessageTimestamp = message.timestamp;
    }

    if (message.cursor !== undefined && message.cursor !== null) {
      const cursorValue = Number(message.cursor);
      if (!Number.isNaN(cursorValue)) {
        if (lastMessageCursor === null || cursorValue > lastMessageCursor) {
          lastMessageCursor = cursorValue;
        }
      }
    }
    if (Date.now() - renderYieldAt >= 8) {
      // Insert small batches between yields. Inserting the whole backlog at
      // the end leaves one large style/layout task on slower phones.
      if (append) conversationArea.appendChild(pendingElements);
      else if (!replaceExistingTranscript) conversationArea.prepend(pendingElements);
      // Yield a task rather than waiting for the next animation frame: frames
      // can be heavily throttled on phones and in background tabs.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (isRenderStale()) return false;
      renderYieldAt = Date.now();
    }
  }

  if (isRenderStale()) {
    return false;
  }

  if (append) conversationArea.appendChild(pendingElements);
  else if (replaceExistingTranscript) conversationArea.replaceChildren(pendingElements);
  else conversationArea.prepend(pendingElements);

  window.DashboardHelpers?.updateMessageReceipts?.(messages);

  updateConversationMeta(lastMessageTimestamp);
  updateComposerState();
  refreshVisibleAgentActionStats();

  if (window.RichRendering) {
    updateMainInteractiveSpace();
  }

  // Scroll management
  const shouldForceBottom = !append && (forceScrollToBottomOnNextRender || Date.now() < forceScrollToBottomUntil);
  if (shouldForceBottom) {
    forceScrollToBottomOnNextRender = false;
    agentScrollPositions.delete(renderAgentId);
    scrollToBottom();
  } else if (append && !wasNearBottomBeforeRender) {
    conversationArea.scrollTop = previousScrollTop;
  } else if (append) {
    scrollToBottom();
  } else if (preserveScrollPosition) {
    conversationArea.scrollTop = Math.max(
      0,
      conversationArea.scrollHeight - conversationArea.clientHeight - previousDistanceFromBottom
    );
  } else if (!append && renderAgentId && agentScrollPositions.has(renderAgentId)) {
    // Restore previous position
    conversationArea.scrollTop = agentScrollPositions.get(renderAgentId);
  } else {
    // Scroll to bottom (default behavior for new messages or first load)
    scrollToBottom();
  }

  if (!append) {
    triggerConversationEnterIfScheduled();
  }

  return true;
  } finally { conversationRendersInFlight -= 1; }
}

/**
 * Calculate relative time (e.g. "5 mins ago")
 */
function timeAgo(dateString) {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  const seconds = Math.floor((new Date() - date) / 1000);

  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " years ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " months ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes ago";
  return Math.floor(seconds) + " seconds ago";
}

/**
 * Generate HTML for styled news card
 */
function generateNewsCardHtml(newsData) {
  const statusColors = {
    'Completed': 'bg-emerald-700/50 text-emerald-300 border-emerald-600/50',
    'Running': 'bg-amber-700/50 text-amber-300 border-amber-600/50',
    'Failed': 'bg-red-700/50 text-red-300 border-red-600/50',
    'Info': 'bg-slate-700/50 text-slate-300 border-slate-600/50'
  };

  const statusClass = statusColors[newsData.status] || statusColors['Info'];

  return `
    <div class="news-feed-card min-w-0 max-w-full bg-slate-800/40 rounded-lg p-3 border border-slate-700/50 hover:bg-slate-800/60 transition-colors">
      <div class="news-feed-card__header flex items-center justify-between gap-2 min-w-0 -mx-3 -mt-3 mb-3 px-3 py-2 bg-sky-900/20 rounded-t-lg border-b border-sky-800/30">
        <div class="text-xs font-semibold text-sky-300 shrink-0 max-w-[40%] truncate">
          ${escapeHtml(newsData.agent || 'Agent')}
        </div>
        ${newsData.context ? `
          <div class="news-feed-card__context flex items-center gap-1.5 min-w-0 text-xs font-mono text-sky-400/70 max-w-[60%] ml-auto" title="${escapeHtml(newsData.context)}">
            <svg class="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path>
            </svg>
            <span class="min-w-0 truncate">${escapeHtml(newsData.context)}</span>
          </div>
        ` : ''}
      </div>

      <div class="news-feed-card__summary text-sm text-slate-200 leading-relaxed mb-3">
        ${renderMessageMarkdown(newsData.summary)}
      </div>
      
      <div class="flex items-center justify-end pt-2 border-t border-slate-700/30 mt-2">
        <span class="px-2 py-0.5 rounded text-xs font-medium ${statusClass}">
          ${escapeHtml(newsData.status || 'Info')}
        </span>
      </div>
    </div>
  `;
}

/**
 * Parse news message content into structured data
 * 支持 JSON, pipe-delimited text, newline-delimited text
 */
function parseNewsMessage(content) {
  if (!content) return null;

  // Strip common prefixes that agents may mistakenly include from CLI command
  // Handles: --json, -json, ~json (typo)
  let cleanContent = content;
  const jsonPrefixMatch = cleanContent.match(/^(--json|-json|~json)\s+/);
  if (jsonPrefixMatch) {
    cleanContent = cleanContent.substring(jsonPrefixMatch[0].length).trim();
  }

  // 1. Try Parse JSON
  try {
    const parsed = JSON.parse(cleanContent);
    if (parsed.type === 'news_announcement' || (parsed.agent && parsed.summary && parsed.status)) {
      return parsed;
    }
  } catch (e) {
    // Not JSON
  }

  // 2. Parse Text Format
  const result = {};

  // Clean content: remove markdown bold markers from keys but keep structure
  // We want to normalize "**Agent:** Value" to "Agent: Value" for easier parsing
  // But regex can handle this directly.

  // Helper to extract value for a key
  const extractValue = (text, key) => {
    // Regex matches:
    // (?:^|[\n\|]) -> Start of string, newline, or pipe
    // \s* -> whitespace
    // (?:\*\*)? -> optional bold start
    // Key -> the key name
    // (?::)? -> optional colon (for **Agent:** case where colon is inside bold)
    // (?:\*\*)? -> optional bold end
    // \s*(?::)?\s* -> optional colon (if not matched before) and whitespace
    // (?:(?:\*\*)?)\s* -> optional ** start of value
    // (.*?) -> capture value (non-greedy)
    // (?=$|[\n\|]) -> until end of string, newline, or pipe

    // This complex regex attempts to handle:
    // "Agent: Value"
    // "**Agent:** Value"
    // "**Agent**: Value"
    // "**Agent:** **Value**"
    const regex = new RegExp(`(?:^|[\\n\\|])\\s*(?:\\*\\*)?${key}(?::)?(?:\\*\\*)?\\s*(?::)?\\s*(?:\\*\\*)?\\s*(.*?)(?=$|[\\n\\|])`, 'i');

    const match = text.match(regex);
    if (!match) return null;

    // Clean up the captured value
    // Remove leading/trailing ** and whitespace
    return match[1].trim().replace(/^(\*\*)+|(\*\*)+$/g, '').trim();
  };

  result.agent = extractValue(content, 'Agent');
  result.status = extractValue(content, 'Status');
  result.summary = extractValue(content, 'Summary');
  result.context = extractValue(content, 'Context');
  result.time = extractValue(content, 'Time');

  // Verify we have enough data
  if (result.agent && result.summary && result.status) {
    return result;
  }

  return null;
}

/**
 * Create message element
 */
function renderSharedRichContent(container, richData, conversationId) {
  const element = window.RichRendering.renderRichContent(richData, async messageText => {
    const context = window.InPlaceChat?.getContext?.();
    if (context?.mode !== 'shared' || context.conversationId !== conversationId) {
      throw new Error('Open the conversation containing this form before submitting it.');
    }
    const result = await window.InPlaceChat.sendMessage(messageText);
    if (window.InPlaceChat.getContext()?.conversationId === conversationId) {
      await loadMessages(context.agentId);
    }
    if (result?.preserveDraft) {
      throw new Error('Your previous message was recovered. Submit this form again to send this response.');
    }
  });
  container.appendChild(element);
}

function renderSharedMessageInfo(message) {
  const label = message.sharedAudienceLabel;
  if (!label) return '';
  const scope = message.ownerPrivateHistory || label === 'Owner only' ? 'owner'
    : message.sharedAudienceMode === 'all' || label === 'Everyone' ? 'all' : 'selected';
  const icon = scope === 'owner'
    ? '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'
    : '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>';
  return `<details class="shared-message-visibility"><summary class="shared-message-audience shared-message-audience--${scope}" title="Who can see this message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icon}</svg><span>Visible to ${escapeHtml(label)}</span></summary><p class="shared-message-visibility-hint">${escapeHtml(scope === 'owner' ? 'Only the owner can see this message.' : scope === 'all' ? 'Everyone with access to this conversation can see this message.' : `Only ${label} can see this message.`)}</p></details>`;
}

function createMessageElement(message) {
  const quoted = window.MessageReplies?.decode(message.content);
  if (quoted) message = { ...message, content: quoted.text, reply: quoted.reply };
  const div = document.createElement('div');
  div.className = 'space-y-2';
  div.dataset.messageId = message.messageId; // For deduplication
  if (['agent', 'guest', 'owner', 'participant'].includes(message.sharedSenderKind)) div.dataset.sharedSenderKind = message.sharedSenderKind;
  // Keep long transcripts cheap to lay out while older bubbles are offscreen.
  div.style.contentVisibility = 'auto';
  div.style.containIntrinsicSize = 'auto 160px';

  if (message.type === 'agent_message' || message.type === 'agent_question') {
    // Agent message (left side)
    const priorityClass = `priority-${message.priority}`;
    const urgentClass = message.urgent ? 'urgent-indicator' : '';

    // Generate content HTML - either encrypted placeholder or actual content
    let contentHtml;
    if (message.isEncryptedPlaceholder) {
      contentHtml = `
        <div class="encrypted-message-placeholder">
          <div class="encrypted-message-icon">🔐</div>
          <div class="encrypted-message-text">
            <span class="encrypted-message-title">Encrypted Message</span>
            <button type="button" class="encrypted-set-password-btn" onclick="showDecryptionPasswordModal()">
              Set Password to Decrypt
            </button>
          </div>
        </div>
      `;
    } else if (message.content && message.content.trim()) {
      // Check if this is rich HTML content from agent (forms, interactive content)
      const richData = !message.ownerPrivateHistory && window.RichRendering ? window.RichRendering.detectRichContent(message.content) : null;

      if (richData) {
        // Rich content detected - will be rendered as DOM element below
        contentHtml = ''; // placeholder, replaced by DOM insertion after innerHTML
        message._richData = richData;
      } else {
        // Check if this is a structured news/log message (JSON or Text)
        const newsData = parseNewsMessage(message.content);

        if (newsData && (selectedAgentType === 'news_feed' || (newsData.agent && newsData.summary))) {
          // Render as styled news card
          contentHtml = generateNewsCardHtml(newsData);
        } else {
          contentHtml = renderMessageMarkdown(message.content);
        }
      }
    } else {
      // No text content (image-only message)
      contentHtml = '';
    }

    const hiddenClass = message.hiddenFromAgent ? 'message-bubble--hidden-from-agent' : '';

    const agentNameLabel = message.agentName
      ? `<span class="all-chats-agent-label">${escapeHtml(message.agentName)}</span>`
      : '';

    div.innerHTML = `
      <div class="flex justify-start min-w-0 max-w-full">
        <div class="message-row-body min-w-0 max-w-full">
          ${agentNameLabel}
          <div class="message-bubble p-3 ${priorityClass} ${urgentClass} ${hiddenClass}">
            ${renderSharedMessageInfo(message)}
            ${message.urgent ? '<span class="inline-block px-2 py-0.5 text-xs font-semibold text-red-200 bg-red-500/20 rounded mb-2">URGENT</span>' : ''}
            <div class="message-content text-sm text-slate-100 leading-relaxed space-y-2">${contentHtml}</div>
            <div class="message-footer">
              <p class="message-timestamp text-xs text-slate-400">${formatTimestamp(message.timestamp)}</p>
              <div class="message-utilities" aria-label="Message actions"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const agentBubble = div.querySelector('.message-bubble');
    attachMessageTtsButton(agentBubble, message);
    attachMessageInfoButton(agentBubble, message);
    attachRunCommandTimestamp(div, message);

    // Render rich content (forms, interactive HTML) if detected
    if (message._richData && window.RichRendering) {
      const richData = message._richData;
      const messageContent = agentBubble.querySelector('.message-content');
      if (messageContent) {
        if (message.sharedConversationId) {
          renderSharedRichContent(messageContent, richData, message.sharedConversationId);
        } else {
        // Render placeholder instead of full rich content. Show the agent's
        // real title (when supplied) so the user knows what was sent without
        // having to expand it.
        const badge = richData.badge || 'Interactive Content';
        const hasMeaningfulTitle = richData.title && richData.title !== 'Agent Form';
        const label = hasMeaningfulTitle
          ? `${escapeHtml(badge)}: ${escapeHtml(richData.title)}`
          : `${escapeHtml(badge)} updated`;
        const placeholderHtml = `<div class="chat-tile__rich-placeholder text-cyan-400 font-medium text-[10px] uppercase flex items-center gap-1.5 p-2 bg-slate-900/50 rounded-lg border border-cyan-500/30 w-fit mt-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            ${label} 📌</div>`;
        messageContent.insertAdjacentHTML('beforeend', placeholderHtml);
        }
      }
      delete message._richData;
    }

    // Add attachments if present
    if (message.attachments && message.attachments.length > 0 && !message.isEncryptedPlaceholder) {
      const messageContent = agentBubble.querySelector('.message-content');
      if (messageContent) {
        const attachmentsContainer = createAttachmentsContainer(message.attachments, message.messageId);
        messageContent.appendChild(attachmentsContainer);
        // Load attachments asynchronously
        loadMessageAttachments(attachmentsContainer, message.attachments, message.messageId);
      }
    }

    // Add clickable options if it's a question with options
    if (message.type === 'agent_question' && !message.ownerPrivateHistory && message.options && message.options.length > 0) {
      const optionsDiv = document.createElement('div');
      optionsDiv.className = 'ml-4 space-y-2 options-container';
      optionsDiv.dataset.questionId = message.messageId;

      // Check if question has been answered (disables further clicking)
      const isAnswered = message.selectedOption !== null || message.freeResponse !== null;

      message.options.forEach((option, index) => {
        const optionElement = createOptionElement(option, message.messageId, message.selectedOption, index, isAnswered);
        optionsDiv.appendChild(optionElement);
      });

      div.appendChild(optionsDiv);
    }
  }

  if (message.type === 'user_message') {
    // Add data attributes for polling
    div.dataset.messageType = 'user_message';
    if (message.readAt) {
      div.dataset.read = 'true';
    }

    // Determine if message has been read by agent
    const readIcon = buildUserMessageReadIndicator(message.readAt, message.deliveryState, message.deliveryFailed, message.serverReceived !== false);

    // Generate content HTML - either encrypted placeholder or actual content
    let userContentHtml;
    if (message.isEncryptedPlaceholder) {
      userContentHtml = `
        <div class="encrypted-message-placeholder">
          <div class="encrypted-message-icon">🔐</div>
          <div class="encrypted-message-text">
            <span class="encrypted-message-title">Encrypted Message</span>
            <button type="button" class="encrypted-set-password-btn" onclick="showDecryptionPasswordModal()">
              Set Password to Decrypt
            </button>
          </div>
        </div>
      `;
    } else if (message.messageSubtype === 'queued_self_update') {
      userContentHtml = `
        <div class="rounded-xl border border-amber-500/30 bg-amber-950/30 p-3 space-y-2">
          <p class="text-xs font-semibold uppercase tracking-wide text-amber-300">Agent Update</p>
          <p class="text-sm text-amber-100">${escapeHtml(message.content || 'Self-update queued.')}</p>
          <button type="button"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 transition-colors update-confirm-btn"
                  data-update-agent-id="${escapeHtml(selectedAgentId || '')}">
            Confirm Update
          </button>
        </div>
      `;
    } else if (message.content && message.content.trim()) {
      userContentHtml = renderMessageMarkdown(message.content);
    } else {
      // No text content (image-only message)
      userContentHtml = '';
    }

    // Add hidden-from-agent class if applicable
    const hiddenClass = message.hiddenFromAgent ? ' message-bubble--hidden-from-agent' : '';

    const userAgentNameLabel = message.agentName
      ? `<span class="all-chats-agent-label all-chats-agent-label--user">→ ${escapeHtml(message.agentName)}</span>`
      : '';
    const sharedSenderLabel = message.senderName
      ? `<span class="all-chats-agent-label all-chats-agent-label--user">${message.sharedSenderKind === 'guest' ? 'Guest · ' : ''}${escapeHtml(message.senderName)}</span>`
      : '';

    div.innerHTML = `
      <div class="flex justify-end">
        <div>
          ${userAgentNameLabel}
          <div class="message-bubble message-bubble--user${hiddenClass} p-3 text-right">
            ${sharedSenderLabel}
            ${renderSharedMessageInfo(message)}
            <div class="message-content text-sm text-slate-100 leading-relaxed space-y-2">${userContentHtml}</div>
            <div class="message-footer">
              <p class="message-timestamp text-xs text-slate-400">${formatTimestamp(message.timestamp)}${readIcon}</p>
              <div class="message-utilities" aria-label="Message actions"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const userBubble = div.querySelector('.message-bubble');
    attachMessageTtsButton(userBubble, message);
    attachMessageInfoButton(userBubble, message);

    if (message.messageSubtype === 'queued_self_update') {
      const confirmBtn = userBubble.querySelector('.update-confirm-btn');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          confirmBtn.disabled = true;
          const originalLabel = confirmBtn.textContent;
          confirmBtn.textContent = 'Sending...';
          const result = await sendAgentUpdateConfirmation(selectedAgentId, {
            silentSuccess: false,
            reloadSelectedConversation: true
          });
          if (!result.success) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = originalLabel || 'Confirm Update';
          } else {
            confirmBtn.textContent = 'Confirmed';
          }
        });
      }
    }

    // Add attachments if present
    if (message.attachments && message.attachments.length > 0 && !message.isEncryptedPlaceholder) {
      const messageContent = userBubble.querySelector('.message-content');
      if (messageContent) {
        const attachmentsContainer = createAttachmentsContainer(message.attachments, message.messageId);
        messageContent.appendChild(attachmentsContainer);
        // Load attachments asynchronously
        loadMessageAttachments(attachmentsContainer, message.attachments, message.messageId);
      }
    }
  }

  // Inter-agent DM messages (sent or received)
  if (message.type === 'agent_dm_sent' || message.type === 'agent_dm_received') {
    div.dataset.messageType = message.type;

    const isSent = message.type === 'agent_dm_sent';
    const priorityClass = `priority-${message.priority || 0}`;

    // Generate content HTML
    let dmContentHtml;
    if (message.isEncryptedPlaceholder) {
      dmContentHtml = `
        <div class="encrypted-message-placeholder">
          <div class="encrypted-message-icon">🔐</div>
          <div class="encrypted-message-text">
            <span class="encrypted-message-title">Encrypted Agent Message</span>
            <button type="button" class="encrypted-set-password-btn" onclick="showDecryptionPasswordModal()">
              Set Password to Decrypt
            </button>
          </div>
        </div>
      `;
    } else if (message.content && message.content.trim()) {
      dmContentHtml = renderMessageMarkdown(message.content);
    } else {
      dmContentHtml = '<span class="text-slate-500 italic">Empty message</span>';
    }

    // Direction indicator and styling
    const directionIcon = isSent ? '→' : '←';
    const directionClass = isSent ? 'justify-end' : 'justify-start';
    const bubbleClass = isSent ? 'message-bubble--agent-dm-sent' : 'message-bubble--agent-dm-received';
    const otherAgent = message.otherAgent || (isSent ? message.to : message.from);
    const labelText = isSent ? `To ${otherAgent}` : `From ${otherAgent}`;

    div.innerHTML = `
      <div class="flex ${directionClass}">
        <div class="message-bubble ${bubbleClass} ${priorityClass} p-3">
          ${renderSharedMessageInfo(message)}
          <div class="flex items-center gap-2 mb-1 text-xs">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-medium">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Agent DM ${directionIcon}
            </span>
            <span class="text-slate-400">${labelText}</span>
          </div>
          <div class="message-content text-sm text-slate-100 leading-relaxed space-y-2">${dmContentHtml}</div>
          <div class="message-footer">
            <p class="message-timestamp text-xs text-slate-400">${formatTimestamp(message.timestamp)}</p>
            <div class="message-utilities" aria-label="Message actions"></div>
          </div>
        </div>
      </div>
    `;

    const dmBubble = div.querySelector('.message-bubble');
    attachMessageTtsButton(dmBubble, message);
    attachMessageInfoButton(dmBubble, message);
    attachRunCommandTimestamp(div, message);
  }

  window.MessageReplies?.decorate(div, message, selectedChatContext?.conversationId || selectedAgentId,
    selectedAgentType !== 'news_feed' && !message.ownerPrivateHistory && selectedAgentId &&
      (!selectedChatContext || selectedChatContext.capabilities?.send));
  return div;
}

function attachRunCommandTimestamp(container, message) {
  if (!container || !message?.runCommand) return;

  const timestamp = container.querySelector('.message-timestamp');
  if (!timestamp) return;

  timestamp.classList.add('message-timestamp--interactive');
  timestamp.setAttribute('role', 'button');
  timestamp.setAttribute('tabindex', '0');
  timestamp.setAttribute('title', 'Show the exact command this agent ran');
  timestamp.setAttribute('aria-label', 'Show the exact command this agent ran');

  const openModal = (event) => {
    event?.stopPropagation?.();
    showRunCommandModal(message);
  };

  timestamp.addEventListener('click', openModal);
  timestamp.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openModal(event);
  });
}

function attachMessageInfoButton(bubble, message) {
  if (!bubble || !message) return;

  const utilities = bubble.querySelector('.message-utilities');
  if (!utilities || utilities.querySelector('.message-info-btn')) return;

  const infoButton = document.createElement('button');
  infoButton.type = 'button';
  infoButton.className = 'message-utility-btn message-info-btn';
  infoButton.setAttribute('aria-label', 'Show message run information');
  infoButton.title = 'Message info';
  infoButton.innerHTML = `
    <span class="sr-only">Show message run information</span>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 11v5"></path>
      <path d="M12 8h.01"></path>
    </svg>
  `;
  infoButton.addEventListener('click', (event) => {
    event.stopPropagation();
    showMessageInfoModal(message);
  });

  const ttsButton = utilities.querySelector('.message-tts-btn');
  if (ttsButton && ttsButton.nextSibling) {
    utilities.insertBefore(infoButton, ttsButton.nextSibling);
  } else if (ttsButton) {
    utilities.appendChild(infoButton);
  } else {
    utilities.insertBefore(infoButton, utilities.firstChild);
  }
}

function attachMessageTtsButton(bubble, message) {
  if (!bubble || !message || typeof message.content !== 'string') return;

  let contentToSpeak = message.content;
  if (typeof parseNewsMessage === 'function') {
    const newsData = parseNewsMessage(message.content);
    if (newsData && newsData.summary) {
      contentToSpeak = newsData.summary;
    }
  }

  const normalizedContent = contentToSpeak.replace(/\s+/g, ' ').trim();
  const copyReadyContent = (message.content || '').trim();
  if (!normalizedContent) return;
  bubble.dataset.messageText = normalizedContent;
  const playbackKey = getMessageTtsPlaybackKey(message, normalizedContent);
  bubble.dataset.ttsPlaybackKey = playbackKey;

  let footer = bubble.querySelector('.message-footer');
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'message-footer';
    bubble.appendChild(footer);
  }

  const timestamp = bubble.querySelector('.message-timestamp');
  if (timestamp && timestamp.parentElement !== footer) {
    footer.insertBefore(timestamp, footer.firstChild);
  }

  let utilities = footer.querySelector('.message-utilities') || bubble.querySelector('.message-utilities');
  if (!utilities) {
    utilities = document.createElement('div');
    utilities.className = 'message-utilities';
    utilities.setAttribute('aria-label', 'Message actions');
  } else {
    utilities.setAttribute('aria-label', 'Message actions');
  }

  if (utilities.parentElement !== footer) {
    if (utilities.parentElement) {
      utilities.parentElement.removeChild(utilities);
    }
    footer.appendChild(utilities);
  }

  if (!utilities.querySelector('.message-tts-btn')) {
    const ttsButton = document.createElement('button');
    ttsButton.type = 'button';
    ttsButton.className = 'message-utility-btn message-tts-btn';
    ttsButton.setAttribute('aria-label', 'Read this message aloud');
    ttsButton.title = 'Read this message aloud';
    ttsButton.dataset.defaultLabel = 'Read this message aloud';
    ttsButton.dataset.defaultTitle = 'Read this message aloud';
    ttsButton.innerHTML = `
      <span class="sr-only">Read this message aloud</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 9V15H9L14 19V5L9 9H5Z"></path>
        <path d="M16.5 8.5C17.835 9.835 17.835 14.165 16.5 15.5"></path>
        <path d="M18.5 7C20.433 8.933 20.433 15.067 18.5 17"></path>
      </svg>
    `;
    ttsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const player = ensureMessageTtsPlayer(bubble, normalizedContent, playbackKey, ttsButton);
      setMessageTtsPlayerExpanded(player, true);
      if (activeMessageTtsSession?.key === playbackKey && activeMessageTtsSession.status === 'playing') {
        pauseActiveMessagePlayback();
        return;
      }
      const checkpoint = getMessageTtsCheckpoint(playbackKey, normalizedContent);
      speakMessageText(normalizedContent, ttsButton, {
        playbackKey,
        startOffset: checkpoint?.offset || 0,
        rate: Number(player.dataset.rate || checkpoint?.rate || 1)
      });
    });
    utilities.appendChild(ttsButton);
  }

  const checkpoint = getMessageTtsCheckpoint(playbackKey, normalizedContent);
  const existingTtsButton = utilities.querySelector('.message-tts-btn');
  if (checkpoint?.offset > 0 && existingTtsButton && activeMessageTtsSession?.key !== playbackKey) {
    setTtsButtonState(existingTtsButton, 'paused');
  }

  if (activeMessageTtsSession?.key === playbackKey) {
    const player = ensureMessageTtsPlayer(bubble, normalizedContent, playbackKey, existingTtsButton);
    activeMessageTtsSession.button = existingTtsButton;
    activeMessageTtsSession.player = player;
    setMessageTtsPlayerExpanded(player, true);
    updateMessageTtsUi(activeMessageTtsSession);
  }

  if (copyReadyContent && !utilities.querySelector('.message-copy-btn')) {
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'message-utility-btn message-copy-btn';
    copyButton.setAttribute('aria-label', 'Copy message text');
    copyButton.title = 'Copy message text';
    copyButton.innerHTML = `
      <span class="sr-only">Copy this message</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
    `;
    copyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      copyMessageToClipboard(copyReadyContent, copyButton);
    });
    utilities.appendChild(copyButton);
  }

  // Add delete button
  if (!message.sharedConversationId && !message.ownerPrivateHistory && !utilities.querySelector('.message-delete-btn')) {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'message-utility-btn message-delete-btn';
    deleteButton.setAttribute('aria-label', 'Delete this message');
    deleteButton.title = 'Delete this message';
    deleteButton.innerHTML = `
      <span class="sr-only">Delete this message</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"></path>
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    `;
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (confirm('Delete this message?')) {
        deleteMessage(message.messageId, message.type);
      }
    });
    utilities.appendChild(deleteButton);
  }

  // Add hide from agent toggle button (for both user and agent messages)
  if (!message.sharedConversationId && !message.ownerPrivateHistory && (message.type === 'user_message' || message.type === 'agent_message' || message.type === 'agent_question') && !utilities.querySelector('.message-hide-btn')) {
    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'message-utility-btn message-hide-btn relative overflow-hidden group';
    const isHidden = message.hiddenFromAgent || false;
    hideButton.dataset.hidden = isHidden ? 'true' : 'false';
    hideButton.dataset.messageId = message.messageId;

    // Natural Eye Animation Configuration
    const labelText = isHidden ? 'Show to agent' : 'Hide from agent';
    const titleText = isHidden
      ? 'Click to show this message to the agent'
      : 'Click to hide this message from the agent';

    hideButton.setAttribute('aria-label', labelText);
    hideButton.title = titleText;

    // New Structure: Single SVG with animating parts
    hideButton.innerHTML = `
      <div class="eye-icon-wrapper relative w-5 h-5 flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full overflow-visible">
            <!-- Pupil -->
            <circle class="pupil transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]" cx="12" cy="12" r="3" style="transform-origin: 12px 12px"></circle>
            
            <!-- Top Lid -->
            <path class="lid-top transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]" d="M1 12C1 12 5 4 12 4C19 4 23 12 23 12" style="transform-origin: 12px 12px"></path>
            
            <!-- Bottom Lid -->
            <path class="lid-bottom transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]" d="M1 12C1 12 5 20 12 20C19 20 23 12 23 12" style="transform-origin: 12px 12px"></path>
            
            <!-- Lashes (visible when closed) -->
            <g class="lashes transition-opacity duration-200 ease-in-out" style="opacity: 0">
               <path d="M4 14l1 2M9 16l1 2M14 16l1 2M19 14l1 2" stroke-width="1.5"></path>
            </g>
          </svg>
      </div>
      <span class="sr-only">Toggle Visibility</span>
    `;

    // Helper to apply state styles
    const setEyeState = (element, hidden) => {
      const pupil = element.querySelector('.pupil');
      const lidTop = element.querySelector('.lid-top');
      const lidBottom = element.querySelector('.lid-bottom');
      const lashes = element.querySelector('.lashes');

      if (hidden) {
        // Closed: Lids meet at a slight downward curve (Arch), Pupil shrinks, Lashes appear
        pupil.style.transform = 'scale(0)';
        pupil.style.opacity = '0';

        // Top lid flattens slightly but keeps arch shape (0.15)
        lidTop.style.transform = 'scaleY(0.15)';

        // Bottom lid inverts to match the top lid's arch (-0.15)
        lidBottom.style.transform = 'scaleY(-0.15)';

        lashes.style.opacity = '1';
      } else {
        // Open: Restore defaults
        pupil.style.transform = 'scale(1)';
        pupil.style.opacity = '1';
        lidTop.style.transform = 'scaleY(1)';
        lidBottom.style.transform = 'scaleY(1)';
        lashes.style.opacity = '0';
      }
    };

    // Initialize state
    setEyeState(hideButton, isHidden);

    hideButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const currentlyHidden = hideButton.dataset.hidden === 'true';
      const newHiddenState = !currentlyHidden;

      hideButton.dataset.hidden = newHiddenState ? 'true' : 'false';

      // Update label (same for all message types - we're hiding FROM the agent)
      hideButton.setAttribute('aria-label', newHiddenState ? 'Show to agent' : 'Hide from agent');
      hideButton.title = newHiddenState ? 'Click to show this message to the agent' : 'Click to hide this message from the agent';

      // Animate
      setEyeState(hideButton, newHiddenState);

      try {
        // Determine the correct API endpoint based on message type
        const apiEndpoint = message.type === 'user_message'
          ? `/api/user/messages/${message.messageId}/hidden`
          : `/api/user/agent-messages/${message.messageId}/hidden`;

        const response = await csrfFetch(apiEndpoint, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({ hidden: newHiddenState })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error('API Error Response:', response.status, errorData);
          throw new Error(`Failed to update message visibility: ${response.status} ${errorData.error?.message || ''}`);
        }

        // Update message bubble styling
        const msgElement = document.querySelector(`[data-message-id="${message.messageId}"]`);
        if (msgElement) {
          const bubbleEl = msgElement.querySelector('.message-bubble');
          if (bubbleEl) {
            if (newHiddenState) {
              bubbleEl.classList.add('message-bubble--hidden-from-agent');
            } else {
              bubbleEl.classList.remove('message-bubble--hidden-from-agent');
            }
          }
        }

        // Update cache
        if (selectedAgentId && conversationCache.has(selectedAgentId)) {
          const cached = conversationCache.get(selectedAgentId);
          const msgIndex = cached.findIndex(m => m.messageId === message.messageId);
          if (msgIndex >= 0) {
            cached[msgIndex].hiddenFromAgent = newHiddenState;
          }
        }

        refreshVisibleAgentActionStats();
      } catch (error) {
        console.error('Error toggling message visibility:', error);

        // Revert UI on error
        hideButton.dataset.hidden = currentlyHidden ? 'true' : 'false';
        setEyeState(hideButton, currentlyHidden);

        window.showError('Failed to update message visibility. Please try again.');
      }
    });
    utilities.appendChild(hideButton);
  }
}

function hashMessageTtsText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getMessageTtsPlaybackKey(message, text) {
  const messageId = String(message?.messageId || '').trim();
  return messageId ? `message:${messageId}` : `text:${hashMessageTtsText(text)}`;
}

function readMessageTtsCheckpoints() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MESSAGE_TTS_CHECKPOINT_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getMessageTtsCheckpoint(key, text) {
  const checkpoint = readMessageTtsCheckpoints()[key];
  if (!checkpoint || checkpoint.textHash !== hashMessageTtsText(text)) return null;
  const offset = Math.max(0, Math.min(text.length, Number(checkpoint.offset) || 0));
  if (offset >= text.length) return null;
  return { ...checkpoint, offset };
}

function saveMessageTtsCheckpoint(key, text, offset, rate = 1) {
  if (!key) return;
  try {
    const checkpoints = readMessageTtsCheckpoints();
    const boundedOffset = Math.max(0, Math.min(text.length, Math.floor(Number(offset) || 0)));
    if (boundedOffset <= 0 || boundedOffset >= text.length) {
      delete checkpoints[key];
    } else {
      checkpoints[key] = {
        offset: boundedOffset,
        rate,
        textHash: hashMessageTtsText(text),
        updatedAt: Date.now()
      };
    }
    const entries = Object.entries(checkpoints)
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, MESSAGE_TTS_CHECKPOINT_LIMIT);
    localStorage.setItem(MESSAGE_TTS_CHECKPOINT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch (_error) {
    // Playback still works when storage is unavailable (for example, private mode).
  }
}

function findMessageTtsWordOffset(text, requestedOffset) {
  const bounded = Math.max(0, Math.min(text.length, Math.floor(Number(requestedOffset) || 0)));
  if (bounded === 0 || bounded === text.length) return bounded;
  if (/\s/.test(text[bounded] || '')) {
    const nextWord = text.slice(bounded).search(/\S/);
    return nextWord < 0 ? text.length : bounded + nextWord;
  }
  let wordStart = bounded;
  while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart -= 1;
  return wordStart;
}

function resetTtsButtonState(button) {
  if (!button) return;
  button.classList.remove('is-playing', 'is-paused');
  button.removeAttribute('aria-pressed');
  if (button.dataset.defaultLabel) button.setAttribute('aria-label', button.dataset.defaultLabel);
  if (button.dataset.defaultTitle) button.title = button.dataset.defaultTitle;
}

function setTtsButtonState(button, status) {
  if (!button) return;
  button.classList.toggle('is-playing', status === 'playing');
  button.classList.toggle('is-paused', status === 'paused');
  if (status === 'playing') {
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label', 'Pause reading this message');
    button.title = 'Pause playback';
  } else if (status === 'paused') {
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Continue reading this message');
    button.title = 'Continue playback';
  } else if (status === 'finished') {
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Replay this message');
    button.title = 'Replay message';
  } else {
    resetTtsButtonState(button);
  }
}

function createMessageTtsTranscript(player, text) {
  const transcript = player.querySelector('.message-tts-transcript');
  if (!transcript || transcript.childNodes.length > 0) return;
  const wordPattern = /\S+/g;
  let previousEnd = 0;
  let match;
  while ((match = wordPattern.exec(text))) {
    if (match.index > previousEnd) transcript.appendChild(document.createTextNode(text.slice(previousEnd, match.index)));
    const word = document.createElement('button');
    word.type = 'button';
    word.className = 'message-tts-word';
    word.textContent = match[0];
    word.dataset.offset = String(match.index);
    word.setAttribute('aria-label', `Continue from ${match[0]}`);
    transcript.appendChild(word);
    previousEnd = match.index + match[0].length;
  }
  if (previousEnd < text.length) transcript.appendChild(document.createTextNode(text.slice(previousEnd)));
}

function ensureMessageTtsPlayer(bubble, text, playbackKey, button) {
  let player = bubble.querySelector('.message-tts-player');
  if (player) return player;
  const checkpoint = getMessageTtsCheckpoint(playbackKey, text);
  player = document.createElement('section');
  player.className = 'message-tts-player';
  player.hidden = true;
  player.dataset.playbackKey = playbackKey;
  player.dataset.rate = String(checkpoint?.rate || 1);
  player.setAttribute('aria-label', 'Message audio player');
  player.innerHTML = `
    <div class="message-tts-controls">
      <button type="button" class="message-tts-control message-tts-play-pause" aria-label="Play message">Play</button>
      <button type="button" class="message-tts-control message-tts-restart" aria-label="Restart message">Restart</button>
      <label class="message-tts-progress-label"><span class="sr-only">Playback position</span><input class="message-tts-progress" type="range" min="0" max="${text.length}" value="${checkpoint?.offset || 0}" step="1"></label>
      <output class="message-tts-progress-text" aria-live="polite">0%</output>
      <button type="button" class="message-tts-control message-tts-rate" aria-label="Playback speed">${checkpoint?.rate || 1}&times;</button>
      <button type="button" class="message-tts-control message-tts-transcript-toggle" aria-expanded="false">Choose word</button>
    </div>
    <div class="message-tts-status sr-only" aria-live="polite">Ready</div>
    <div class="message-tts-transcript" hidden aria-label="Choose a word to continue reading"></div>
  `;
  bubble.appendChild(player);
  createMessageTtsTranscript(player, text);

  const playPause = player.querySelector('.message-tts-play-pause');
  const progress = player.querySelector('.message-tts-progress');
  playPause.addEventListener('click', () => {
    if (activeMessageTtsSession?.key === playbackKey && activeMessageTtsSession.status === 'playing') {
      pauseActiveMessagePlayback();
      return;
    }
    const saved = getMessageTtsCheckpoint(playbackKey, text);
    speakMessageText(text, button, { playbackKey, startOffset: Number(progress.value || saved?.offset || 0), rate: Number(player.dataset.rate || 1) });
  });
  player.querySelector('.message-tts-restart').addEventListener('click', () => {
    speakMessageText(text, button, { playbackKey, startOffset: 0, rate: Number(player.dataset.rate || 1) });
  });
  player.querySelector('.message-tts-rate').addEventListener('click', (event) => {
    const rates = [0.8, 1, 1.25, 1.5];
    const current = Number(player.dataset.rate || 1);
    const currentIndex = rates.findIndex((rate) => rate === current);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    player.dataset.rate = String(nextRate);
    event.currentTarget.innerHTML = `${nextRate}&times;`;
    if (activeMessageTtsSession?.key === playbackKey) {
      const resumeOffset = activeMessageTtsSession.offset;
      const wasPlaying = activeMessageTtsSession.status === 'playing';
      pauseActiveMessagePlayback();
      saveMessageTtsCheckpoint(playbackKey, text, resumeOffset, nextRate);
      if (wasPlaying) speakMessageText(text, button, { playbackKey, startOffset: resumeOffset, rate: nextRate });
    }
  });
  const transcriptToggle = player.querySelector('.message-tts-transcript-toggle');
  const transcript = player.querySelector('.message-tts-transcript');
  transcriptToggle.addEventListener('click', () => {
    const expanded = transcript.hidden;
    transcript.hidden = !expanded;
    transcriptToggle.setAttribute('aria-expanded', String(expanded));
    transcriptToggle.textContent = expanded ? 'Hide words' : 'Choose word';
  });
  transcript.addEventListener('click', (event) => {
    const word = event.target.closest('.message-tts-word');
    if (!word) return;
    speakMessageText(text, button, { playbackKey, startOffset: Number(word.dataset.offset || 0), rate: Number(player.dataset.rate || 1) });
  });
  progress.addEventListener('input', () => updateMessageTtsProgress(player, text, Number(progress.value || 0)));
  progress.addEventListener('change', () => {
    const offset = findMessageTtsWordOffset(text, progress.value);
    const wasPlaying = activeMessageTtsSession?.key === playbackKey && activeMessageTtsSession.status === 'playing';
    if (activeMessageTtsSession?.key === playbackKey) pauseActiveMessagePlayback();
    saveMessageTtsCheckpoint(playbackKey, text, offset, Number(player.dataset.rate || 1));
    updateMessageTtsProgress(player, text, offset);
    setTtsButtonState(button, offset > 0 ? 'paused' : 'idle');
    if (wasPlaying) speakMessageText(text, button, { playbackKey, startOffset: offset, rate: Number(player.dataset.rate || 1) });
  });
  updateMessageTtsProgress(player, text, checkpoint?.offset || 0);
  return player;
}

function setMessageTtsPlayerExpanded(player, expanded) {
  if (player) player.hidden = !expanded;
}

function updateMessageTtsProgress(player, text, offset) {
  if (!player) return;
  const bounded = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const progress = player.querySelector('.message-tts-progress');
  if (progress && document.activeElement !== progress) progress.value = String(bounded);
  const output = player.querySelector('.message-tts-progress-text');
  if (output) output.textContent = `${text.length > 0 ? Math.round((bounded / text.length) * 100) : 0}%`;
  const words = [...player.querySelectorAll('.message-tts-word')];
  let activeWord = null;
  words.forEach((word, index) => {
    const wordOffset = Number(word.dataset.offset || 0);
    const nextOffset = Number(words[index + 1]?.dataset.offset || text.length);
    const isCurrent = wordOffset <= bounded && nextOffset > bounded;
    word.classList.toggle('is-read', wordOffset < bounded);
    word.classList.toggle('is-current', isCurrent);
    if (isCurrent) activeWord = word;
  });
  const transcript = player.querySelector('.message-tts-transcript');
  if (activeWord && transcript && !transcript.hidden) activeWord.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function updateMessageTtsUi(session) {
  if (!session) return;
  updateMessageTtsProgress(session.player, session.text, session.offset);
  setTtsButtonState(session.button, session.status);
  const playPause = session.player?.querySelector('.message-tts-play-pause');
  if (playPause) {
    playPause.textContent = session.status === 'playing' ? 'Pause' : session.status === 'finished' ? 'Replay' : 'Play';
    playPause.setAttribute('aria-label', session.status === 'playing' ? 'Pause message' : session.status === 'finished' ? 'Replay message' : 'Play message');
  }
  const status = session.player?.querySelector('.message-tts-status');
  if (status) status.textContent = session.status === 'playing' ? 'Playing' : session.status === 'paused' ? 'Paused' : session.status === 'finished' ? 'Finished' : 'Ready';
}

function stopActiveMessagePlayback({ preserveCheckpoint = false } = {}) {
  const session = activeMessageTtsSession;
  if (preserveCheckpoint && session) {
    session.status = 'paused';
    saveMessageTtsCheckpoint(session.key, session.text, session.offset, session.rate);
    updateMessageTtsUi(session);
  }
  if (activeTtsUtterance) {
    activeTtsUtterance.onboundary = null;
    activeTtsUtterance.onstart = null;
    activeTtsUtterance.onend = null;
    activeTtsUtterance.onerror = null;
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      console.error('Failed to cancel speech synthesis:', error);
    }
  }
  if (activeTtsButton && !preserveCheckpoint) resetTtsButtonState(activeTtsButton);
  activeTtsUtterance = null;
  activeTtsButton = null;
  activeMessageTtsSession = null;
}

function pauseActiveMessagePlayback() {
  const session = activeMessageTtsSession;
  if (!session || session.status !== 'playing') return;
  if (activeTtsUtterance) {
    activeTtsUtterance.onboundary = null;
    activeTtsUtterance.onend = null;
    activeTtsUtterance.onerror = null;
  }
  try {
    window.speechSynthesis.cancel();
  } catch (error) {
    console.error('Failed to pause speech synthesis:', error);
  }
  activeTtsUtterance = null;
  session.status = 'paused';
  saveMessageTtsCheckpoint(session.key, session.text, session.offset, session.rate);
  updateMessageTtsUi(session);
}

function speakMessageText(text, controlButton = null, options = {}) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  if (!('speechSynthesis' in window)) {
    showErrorMessage('Speech synthesis is not supported in this browser.');
    return;
  }
  try {
    stopActiveMessagePlayback({ preserveCheckpoint: true });
    const playbackKey = options.playbackKey || controlButton?.closest('[data-tts-playback-key]')?.dataset.ttsPlaybackKey || `text:${hashMessageTtsText(normalized)}`;
    const startOffset = findMessageTtsWordOffset(normalized, options.startOffset || 0);
    const rate = Math.max(0.8, Math.min(1.5, Number(options.rate) || 1));
    const spokenText = normalized.slice(startOffset);
    if (!spokenText) {
      saveMessageTtsCheckpoint(playbackKey, normalized, 0, rate);
      setTtsButtonState(controlButton, 'finished');
      return;
    }
    const bubble = controlButton?.closest('.message-bubble');
    const player = bubble ? ensureMessageTtsPlayer(bubble, normalized, playbackKey, controlButton) : null;
    const utterance = new SpeechSynthesisUtterance(spokenText);
    activeTtsUtterance = utterance;
    activeMessageTtsSession = { key: playbackKey, text: normalized, offset: startOffset, rate, status: 'playing', button: controlButton, player, lastSavedAt: 0 };
    const preferredVoice = voiceNotificationState?.preferredVoice;
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang || 'en-US';
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = rate;
    utterance.pitch = 1.05;
    utterance.volume = 0.95;
    if (controlButton) {
      if (!controlButton.dataset.defaultLabel) controlButton.dataset.defaultLabel = controlButton.getAttribute('aria-label') || 'Read this message aloud';
      if (!controlButton.dataset.defaultTitle) controlButton.dataset.defaultTitle = controlButton.title || 'Read this message aloud';
      utterance.onstart = () => {
        activeTtsButton = controlButton;
        setMessageTtsPlayerExpanded(player, true);
        updateMessageTtsUi(activeMessageTtsSession);
      };
      utterance.onboundary = (event) => {
        if (activeTtsUtterance !== utterance || !activeMessageTtsSession) return;
        activeMessageTtsSession.offset = Math.min(normalized.length, startOffset + Math.max(0, Number(event.charIndex) || 0));
        updateMessageTtsUi(activeMessageTtsSession);
        const now = Date.now();
        if (now - activeMessageTtsSession.lastSavedAt >= 1000) {
          activeMessageTtsSession.lastSavedAt = now;
          saveMessageTtsCheckpoint(playbackKey, normalized, activeMessageTtsSession.offset, rate);
        }
      };
      const cleanup = () => {
        if (activeTtsUtterance === utterance) activeTtsUtterance = null;
        saveMessageTtsCheckpoint(playbackKey, normalized, 0, rate);
        if (activeMessageTtsSession?.key === playbackKey) {
          activeMessageTtsSession.offset = normalized.length;
          activeMessageTtsSession.status = 'finished';
          updateMessageTtsUi(activeMessageTtsSession);
        }
        setTtsButtonState(controlButton, 'finished');
        if (activeTtsButton === controlButton) activeTtsButton = null;
        activeMessageTtsSession = null;
      };
      utterance.onend = cleanup;
      utterance.onerror = (event) => {
        if (event?.error === 'canceled' || event?.error === 'interrupted') return;
        if (activeTtsUtterance === utterance) activeTtsUtterance = null;
        if (activeMessageTtsSession?.key === playbackKey) {
          activeMessageTtsSession.status = 'paused';
          saveMessageTtsCheckpoint(playbackKey, normalized, activeMessageTtsSession.offset, rate);
          updateMessageTtsUi(activeMessageTtsSession);
        }
        showErrorMessage('Could not play message aloud. Check your browser settings.');
      };
    } else {
      utterance.onerror = () => showErrorMessage('Could not play message aloud. Check your browser settings.');
    }
    if (player) updateMessageTtsUi(activeMessageTtsSession);
    window.speechSynthesis.speak(utterance);
    voiceNotificationState.audioUnlocked = true;
  } catch (error) {
    console.error('Failed to speak message text:', error);
    showErrorMessage('Could not play message aloud. Check your browser settings.');
  }
}

async function copyMessageToClipboard(text, button) {
  const normalized = (text || '').trim();
  if (!normalized) return;
  if (!navigator?.clipboard) {
    showErrorMessage('Clipboard access is not supported in this browser.');
    return;
  }

  if (button && !button.dataset.defaultIcon) {
    button.dataset.defaultIcon = button.innerHTML;
  }

  try {
    if (button) {
      button.disabled = true;
    }
    await navigator.clipboard.writeText(normalized);
    if (button) {
      button.classList.add('copied');
      button.innerHTML = `
        <span class="sr-only">Message copied</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 13l4 4L19 7"></path>
        </svg>
      `;
      setTimeout(() => {
        if (!button.dataset.defaultIcon) return;
        button.classList.remove('copied');
        button.innerHTML = button.dataset.defaultIcon;
        button.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error('Failed to copy message text:', error);
    if (button) {
      button.disabled = false;
      if (button.dataset.defaultIcon) {
        button.innerHTML = button.dataset.defaultIcon;
      }
    }
    showErrorMessage('Failed to copy. Please try again.');
  }
}

function showRunCommandModal(message) {
  const modal = document.getElementById('runCommandModal');
  const title = document.getElementById('runCommandModalTitle');
  const subtitle = document.getElementById('runCommandModalSubtitle');
  const body = document.getElementById('runCommandModalBody');
  const copyBtn = document.getElementById('runCommandModalCopyBtn');
  if (!modal || !title || !subtitle || !body || !copyBtn) return;

  const agentLabel = message.agentName || selectedAgentName || 'Agent';
  title.textContent = `${agentLabel} command`;
  subtitle.textContent = `Triggered at ${formatTimestamp(message.timestamp)}`;
  body.textContent = message.runCommand || 'No command recorded.';
  copyBtn.disabled = !message.runCommand;
  copyBtn.dataset.command = message.runCommand || '';
  modal.classList.remove('hidden');
}

function tokenizeShellCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of String(command || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseRunCommandInfo(command) {
  const tokens = tokenizeShellCommand(command);
  const info = {
    executable: tokens[0] || 'Unknown',
    provider: 'Unknown',
    model: 'Default',
    sandbox: 'Default',
    approval: 'Default',
    permissionMode: 'Default',
    flags: [],
  };

  const basename = (info.executable || '').split('/').filter(Boolean).pop() || info.executable;
  const lowerExecutable = basename.toLowerCase();
  if (lowerExecutable.includes('claude')) info.provider = 'Claude';
  else if (lowerExecutable.includes('gemini')) info.provider = 'Gemini';
  else if (lowerExecutable.includes('copilot')) info.provider = 'Copilot';
  else if (lowerExecutable.includes('pi')) info.provider = 'Pi';
  else if (lowerExecutable.includes('codex')) info.provider = 'Codex';
  else if (lowerExecutable.includes('kilo')) info.provider = 'Kilo';
  else info.provider = basename || 'Unknown';

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) continue;

    let flag = token;
    let value = '';
    const equalIndex = token.indexOf('=');
    if (equalIndex > 0) {
      flag = token.slice(0, equalIndex);
      value = token.slice(equalIndex + 1);
    } else if (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
      value = tokens[index + 1];
    }

    info.flags.push(value ? `${flag} ${value}` : flag);

    if (flag === '--model' || flag === '-m') info.model = value || 'Default';
    if (flag === '--sandbox') info.sandbox = value || 'enabled';
    if (flag === '--no-sandbox') info.sandbox = 'none';
    if (flag === '--approval-mode') info.approval = value || 'Default';
    if (flag === '--permission-mode') info.permissionMode = value || 'Default';
    if (flag === '--dangerously-bypass-approvals-and-sandbox') {
      info.approval = 'full-auto';
      info.sandbox = 'none';
    }
    if (flag === '--dangerously-skip-permissions') {
      info.permissionMode = 'bypass';
      info.sandbox = 'none';
    }
    if (flag === '--yolo') {
      info.approval = 'yolo';
      info.sandbox = 'none';
    }
    if (flag === '-c' && value.includes('model_provider=')) {
      info.provider = value.split('model_provider=').pop().replace(/^["']|["']$/g, '') || info.provider;
    }
  }

  return info;
}

function showMessageInfoModal(message) {
  const modal = document.getElementById('runCommandModal');
  const title = document.getElementById('runCommandModalTitle');
  const subtitle = document.getElementById('runCommandModalSubtitle');
  const body = document.getElementById('runCommandModalBody');
  const copyBtn = document.getElementById('runCommandModalCopyBtn');
  if (!modal || !title || !subtitle || !body || !copyBtn) return;

  modal.querySelector('[data-brief-history-link]')?.remove();
  const linkRevision = (revision) => {
    const agentId = message.agentId || (typeof selectedAgentId === 'undefined' ? null : selectedAgentId);
    if (!Number.isInteger(revision) || revision < 1 || !agentId || !window.AgentBriefUI) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.briefHistoryLink = String(revision);
    button.className = 'agent-brief-entry mx-6 mb-4';
    button.textContent = `Review identity revision ${revision}`;
    button.addEventListener('click', () => {
      hideRunCommandModal();
      window.AgentBriefUI.open(agentId, 'history', revision);
    });
    body.after(button);
  };

  const agentLabel = message.agentName || selectedAgentName || 'Agent';
  if (message.type === 'user_message') {
    const fallbackConfig = loadedAgentConfigs.get(agentLabel) || {};
    const overrides = (message.runOverrides && typeof message.runOverrides === 'object')
      ? message.runOverrides
      : fallbackConfig;
    const providerVal = overrides.model_provider || fallbackConfig.model_provider || 'codex (default)';
    const modelVal = overrides.model || fallbackConfig.model || 'default';
    const sandboxVal = overrides.sandbox_mode || fallbackConfig.sandbox_mode || 'default';
    const approvalVal = overrides.approval_mode || fallbackConfig.approval_mode || 'default';
    const effortVal = overrides.thinking_effort || fallbackConfig.thinking_effort || 'default';
    const deliveryStatus = message.readAt
      ? `Read by agent at ${formatTimestamp(message.readAt)}`
      : 'Queued (will run with these settings)';
    title.textContent = `${agentLabel} message info`;
    subtitle.textContent = `Sent to ${agentLabel} at ${formatTimestamp(message.timestamp)}`;
    const infoText = [
      `Recipient agent: ${agentLabel}`,
      `Message ID: ${message.messageId || 'Unknown'}`,
      `Provider: ${providerVal}`,
      `Model: ${modelVal}`,
      `Permissions / Sandbox: ${sandboxVal}`,
      `Approval mode: ${approvalVal}`,
      `Thinking effort: ${effortVal}`,
      `Identity: ${message.briefRevision ? `revision ${message.briefRevision}` : 'Not recorded'}`,
      `Status: ${deliveryStatus}`
    ].join('\n');
    body.textContent = infoText;
    linkRevision(message.briefRevision);
    copyBtn.disabled = false;
    copyBtn.dataset.command = infoText;
    modal.classList.remove('hidden');
    return;
  }

  title.textContent = `${agentLabel} message info`;
  subtitle.textContent = `Response sent at ${formatTimestamp(message.timestamp)}`;
  const identityLine = `Identity: ${message.briefProvenance?.revision ? `revision ${message.briefProvenance.revision}` : 'Not recorded'}`;
  if (message.runCommand) {
    const parsed = parseRunCommandInfo(message.runCommand);
    body.textContent = [
      `Agent: ${agentLabel}`,
      `Message ID: ${message.messageId || 'Unknown'}`,
      identityLine,
      `Provider: ${parsed.provider}`,
      `Model: ${parsed.model}`,
      `Executable: ${parsed.executable}`,
      `Sandbox: ${parsed.sandbox}`,
      `Approval mode: ${parsed.approval}`,
      `Permission mode: ${parsed.permissionMode}`,
      `Flags: ${parsed.flags.length ? parsed.flags.join(', ') : 'None detected'}`,
      '',
      'Exact command:',
      message.runCommand
    ].join('\n');
  } else {
    body.textContent = [
      `Agent: ${agentLabel}`,
      `Message ID: ${message.messageId || 'Unknown'}`,
      identityLine,
      '',
      'No run command was recorded for this message.',
      '',
      'The agent that sent it did not report which CLI command produced it.',
      'This happens for agents installed from an older agent-cli.sh and for',
      'messages sent outside an agent run (e.g. status notices). Update the',
      'agent to the latest agent-cli.sh to enable run info on new messages.'
    ].join('\n');
  }
  linkRevision(message.briefProvenance?.revision);
  copyBtn.disabled = !message.runCommand;
  copyBtn.dataset.command = message.runCommand || '';
  modal.classList.remove('hidden');
}

function hideRunCommandModal() {
  const modal = document.getElementById('runCommandModal');
  if (!modal) return;
  modal.classList.add('hidden');
}

function setupRunCommandModal() {
  const modal = document.getElementById('runCommandModal');
  const closeBtn = document.getElementById('runCommandModalCloseBtn');
  const dismissBtn = document.getElementById('runCommandModalDismissBtn');
  const copyBtn = document.getElementById('runCommandModalCopyBtn');
  if (!modal) return;

  closeBtn?.addEventListener('click', hideRunCommandModal);
  dismissBtn?.addEventListener('click', hideRunCommandModal);
  copyBtn?.addEventListener('click', async () => {
    const command = copyBtn.dataset.command || '';
    if (!command) return;
    await copyMessageToClipboard(command, copyBtn);
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      hideRunCommandModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideRunCommandModal();
    }
  });
}

window.showRunCommandModal = showRunCommandModal;
window.showMessageInfoModal = showMessageInfoModal;

function readLastMessageAloud() {
  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea) return;
  const bubbles = conversationArea.querySelectorAll('.message-bubble');
  if (!bubbles || bubbles.length === 0) {
    showErrorMessage('No messages to read yet.');
    return;
  }

  const lastBubble = bubbles[bubbles.length - 1];
  const text = lastBubble?.dataset?.messageText;
  if (!text) {
    showErrorMessage('The last message has no readable content.');
    return;
  }

  const ttsButton = lastBubble.querySelector('.message-tts-btn');
  if (ttsButton && ttsButton.classList.contains('is-playing')) {
    stopActiveMessagePlayback();
    return;
  }

  speakMessageText(text, ttsButton || null);
}

function setupMessageTtsShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (!(event.altKey && event.shiftKey && event.code === 'KeyR')) {
      return;
    }

    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    event.preventDefault();
    readLastMessageAloud();
  });
}

/**
 * Create option element for interactive questions
 */
function createOptionElement(option, questionId, selectedOption, optionIndex = 0, isAnswered = false) {
  const div = document.createElement('div');
  const isSelected = selectedOption === option.text;
  // Disable if any answer exists (option selected OR free response)
  const isDisabled = isAnswered || selectedOption !== null;

  let baseClass = 'option-card option-card--interactive';
  if (isSelected) {
    baseClass = 'option-card option-card--selected';
  } else if (isDisabled) {
    baseClass = 'option-card option-card--disabled';
  }
  const defaultHighlight = option.isDefault && !isDisabled ? 'ring-1 ring-sky-400/40' : '';
  div.className = `${baseClass} ${defaultHighlight}`.trim();

  // Make focusable for keyboard navigation
  if (!isDisabled) {
    div.tabIndex = 0;
    div.dataset.optionIndex = optionIndex;
    div.dataset.optionId = option.optionId;
    div.dataset.questionId = questionId;
  }

  div.innerHTML = `
    <div class="flex items-start justify-between">
      <div class="flex-1">
        <p class="text-sm font-semibold text-white">
          ${escapeHtml(option.text)}
          ${option.isDefault && !isDisabled ? '<span class="ml-2 text-xs text-sky-300">(Recommended)</span>' : ''}
          ${isSelected ? '<span class="ml-2 text-xs text-sky-300">✓ Selected</span>' : ''}
        </p>
        ${option.benefits ? `
          <div class="mt-2">
            <p class="text-xs font-semibold text-emerald-300">Benefits:</p>
            <p class="text-xs text-slate-300">${escapeHtml(option.benefits)}</p>
          </div>
        ` : ''}
        ${option.downsides ? `
          <div class="mt-2">
            <p class="text-xs font-semibold text-red-300">Downsides:</p>
            <p class="text-xs text-slate-300">${escapeHtml(option.downsides)}</p>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  // Add click handler if not disabled
  if (!isDisabled) {
    div.addEventListener('click', () => {
      selectOption(questionId, option.optionId, div, option);
    });

    // Add keyboard handler for Enter/Space to select
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectOption(questionId, option.optionId, div, option);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateOptions(div, e.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  return div;
}

/**
 * Navigate between options using arrow keys
 */
function navigateOptions(currentElement, direction) {
  const container = currentElement.closest('.options-container');
  if (!container) return;

  const options = Array.from(container.querySelectorAll('.option-card[tabindex="0"]'));
  const currentIndex = options.indexOf(currentElement);

  if (currentIndex === -1) return;

  let nextIndex = currentIndex + direction;

  // Wrap around
  if (nextIndex < 0) nextIndex = options.length - 1;
  if (nextIndex >= options.length) nextIndex = 0;

  options[nextIndex].focus();
}

/**
 * Handle option selection
 */
async function selectOption(questionId, optionId, optionElement, option = {}) {
  if (selectedChatContext?.privateHistory) {
    showErrorMessage('Earlier private history is read-only.');
    return;
  }
  try {
    // Disable the option element immediately
    optionElement.style.pointerEvents = 'none';
    optionElement.style.opacity = '0.5';

    if (selectedChatContext?.mode === 'shared') {
      const conversationId = selectedChatContext.conversationId;
      try {
        const messages = await window.InPlaceChat.answerQuestion(questionId, { optionId, text: option.text || '' });
        if (selectedChatContext?.conversationId !== conversationId) return;
        conversationCache.set(conversationId, messages);
        await displayMessages(messages, false, { agentId: selectedAgentId, conversationId });
      } catch (error) {
        optionElement.style.pointerEvents = '';
        optionElement.style.opacity = '';
        showErrorMessage(error.message || 'Failed to submit response');
      }
      return;
    }

    const response = await csrfFetch('/api/user/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        questionId: questionId,
        optionId: optionId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Failed to submit response:', errorData);

      // Re-enable the option element
      optionElement.style.pointerEvents = '';
      optionElement.style.opacity = '';

      // Show error message
      showErrorMessage(errorData.error?.message || 'Failed to submit response');
      return;
    }

    // Success - reload messages to show updated state (including the new user_message)
    if (selectedAgentId) {
      lastMessageTimestamp = null; // Reset to reload all messages
      lastMessageCursor = null;
      // Clear cache for this agent to force refresh
      conversationCache.delete(selectedAgentId);
      await loadMessages(selectedAgentId);
    }

  } catch (error) {
    console.error('Error selecting option:', error);

    // Re-enable the option element
    optionElement.style.pointerEvents = '';
    optionElement.style.opacity = '';

    showErrorMessage('Network error. Please try again.');
  }
}

/**
 * Show error message
 */
// window.showError is defined in notifications.js
// We map the old function name for backward compatibility if needed, but we should switch usages
const showErrorMessage = (message) => window.showError(message);

/**
 * Trigger a ripple animation on the agent's avatar
 */
function triggerAgentRipple(agentId) {
  if (!agentId) return;

  const agentSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
  if (!agentSeat) return;

  const avatar = agentSeat.querySelector('.agent-avatar');
  if (!avatar) return;

  // Create ripple element
  const ripple = document.createElement('div');
  ripple.className = 'agent-ripple';
  avatar.appendChild(ripple);

  // Remove ripple after animation completes
  ripple.addEventListener('animationend', () => {
    ripple.remove();
  });
}

/**
 * Scroll conversation area to bottom
 */
function scrollToBottom(options = {}) {
  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea) return;
  const { smooth = false, force = true } = options;

  const getBottomScrollTop = () => Math.max(
    0,
    conversationArea.scrollHeight - conversationArea.clientHeight
  );

  const settleAtBottom = () => {
    syncMobileComposerLayout();
    const bottomScrollTop = getBottomScrollTop();
    conversationArea.scrollTop = bottomScrollTop;

    // Mobile browsers can report a stale max scroll value while the composer,
    // images, or rich placeholders are still resizing. Force the newest rendered
    // message into view as a second anchor, then clamp to the real bottom again.
    const renderedMessages = conversationArea.querySelectorAll('[data-message-id]');
    const latestMessage = renderedMessages[renderedMessages.length - 1];
    if (latestMessage) {
      const latestBottom = latestMessage.offsetTop + latestMessage.offsetHeight;
      const latestTarget = Math.max(0, latestBottom - conversationArea.clientHeight + 16);
      conversationArea.scrollTop = Math.max(conversationArea.scrollTop, latestTarget, getBottomScrollTop());
    }

    window.updateScrollToBottomButton?.();
  };

  if (smooth && !force && typeof conversationArea.scrollTo === 'function') {
    conversationArea.scrollTo({ top: getBottomScrollTop(), behavior: 'smooth' });
    window.updateScrollToBottomButton?.();
  } else {
    settleAtBottom();
  }

  // Rich content, images, and mobile composer measurements can change height
  // after the first paint. Repeat briefly so a just-opened chat settles on the
  // latest message instead of stopping above it.
  requestAnimationFrame(() => {
    settleAtBottom();
    requestAnimationFrame(() => {
      settleAtBottom();
    });
  });
  if (force) {
    setTimeout(settleAtBottom, 120);
    setTimeout(settleAtBottom, 300);
    setTimeout(settleAtBottom, 700);
    setTimeout(settleAtBottom, 1200);
  }
}

function captureSendScrollGuard() {
  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea || !selectedAgentId) {
    return null;
  }

  const distanceFromBottom = Math.max(
    0,
    conversationArea.scrollHeight - conversationArea.clientHeight - conversationArea.scrollTop
  );

  return {
    agentId: selectedAgentId,
    scrollTop: conversationArea.scrollTop,
    wasNearBottom: distanceFromBottom < 160,
    expiresAt: Date.now() + 2500
  };
}

/**
 * Re-arm the send scroll guard once the server has answered. Encrypted,
 * shared, or upload sends can take longer than the guard window measured
 * from the click, and a full re-render would otherwise restore the stale
 * scroll position saved when the user last left this chat.
 */
function rearmSendScrollGuard(guard) {
  if (!guard) return;
  guard.expiresAt = Date.now() + 2500;
  agentScrollPositions.delete(guard.agentId);
  if (guard.wasNearBottom) {
    forceScrollToBottomOnNextRender = true;
    forceScrollToBottomUntil = guard.expiresAt;
  }
}

function settleScrollAfterSend(guard) {
  if (!guard) return;

  pendingSendScrollGuard = guard;

  const settle = () => {
    if (pendingSendScrollGuard !== guard) return;
    if (selectedAgentId !== guard.agentId || Date.now() > guard.expiresAt) {
      if (pendingSendScrollGuard === guard) {
        pendingSendScrollGuard = null;
      }
      return;
    }

    const conversationArea = document.getElementById('conversationArea');
    if (!conversationArea) return;

    if (guard.wasNearBottom) {
      scrollToBottom({ smooth: false, force: true });
      return;
    }

    if (conversationArea.scrollTop < guard.scrollTop) {
      conversationArea.scrollTop = guard.scrollTop;
      window.updateScrollToBottomButton?.();
    }
  };

  settle();
  requestAnimationFrame(() => {
    settle();
    requestAnimationFrame(settle);
  });
  setTimeout(settle, 120);
  setTimeout(() => {
    settle();
    if (pendingSendScrollGuard === guard) {
      pendingSendScrollGuard = null;
    }
  }, 300);
}

/**
 * Human friendly relative time helper
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  const now = new Date();
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diff = now.getTime() - date.getTime();

  // Handle future dates
  if (diff < 0) {
    return 'in the future';
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < minute) {
    return 'just now';
  }
  if (diff < hour) {
    const mins = Math.floor(diff / minute);
    return `${mins} ${mins === 1 ? 'min' : 'mins'} ago`;
  }
  if (diff < day) {
    const hrs = Math.floor(diff / hour);
    return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  }
  if (diff < week) {
    const days = Math.floor(diff / day);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  if (diff < month) {
    const weeks = Math.floor(diff / week);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }
  if (diff < year) {
    const months = Math.floor(diff / month);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }
  const years = Math.floor(diff / year);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

const MARKDOWN_SANITIZE_CONFIG = { USE_PROFILES: { html: true } };

/**
 * Convert message text to sanitized Markdown HTML
 */
function renderMessageMarkdown(text) {
  if (text === null || text === undefined) {
    return '';
  }
  const source = String(text);
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return escapeHtml(source).replace(/\n/g, '<br>');
  }
  const html = marked.parse(source);
  return replaceUnreachableImages(DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG));
}

/**
 * Agents sometimes link an image by its path on their own computer, which the
 * browser cannot load. Show a visible note instead of a silently broken image.
 */
function replaceUnreachableImages(html) {
  if (!html.includes('<img')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('img').forEach(img => {
    const src = (img.getAttribute('src') || '').trim();
    if (/^(https?:|data:image\/|blob:)/i.test(src)) return;
    const name = src.split(/[\\/]/).filter(Boolean).pop() || 'image';
    let label = name;
    try { label = decodeURIComponent(name); } catch (_) { /* Keep the raw name. */ }
    const note = document.createElement('span');
    note.className = 'message-image-unavailable';
    note.textContent = `[Image "${img.getAttribute('alt') || label}" is on the agent's computer and was not uploaded]`;
    img.replaceWith(note);
  });
  return template.innerHTML;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generate styled news card HTML for news feed announcements
 */


/**
 * Attempt to unlock audio playback via a user gesture
 */
function setupAudioUnlock() {
  const unlock = () => {
    const audio = new Audio();
    audio.volume = 0.001;
    audio.play().catch(() => { }).finally(() => {
      voiceNotificationState.audioUnlocked = true;
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    });
  };

  document.addEventListener('click', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}

/**
 * Initialize voice notifications with production-friendly defaults
 */
function initializeVoiceNotifications() {
  if (!('speechSynthesis' in window)) {
    console.warn('Speech synthesis not supported in this browser.');
    return;
  }

  const selectVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) {
      return;
    }

    // Scoring favors cloud voices with female/warm names and neural branding for less robotic output
    const femaleKeywords = ['female', 'aria', 'sonia', 'jenny', 'samantha', 'zoe', 'olivia'];
    const qualityKeywords = ['neural', 'wavenet', 'premium', 'studio', 'natural', 'online', 'hifi', 'hq'];
    const preferredNames = [
      'Microsoft Aria Online',
      'Microsoft Jenny Online',
      'Google US English',
      'Samantha'
    ];

    const scoreVoice = (voice) => {
      let score = 0;
      const name = voice.name.toLowerCase();
      const lang = (voice.lang || '').toLowerCase();

      // Prefer US English explicitly; regional English voices can sound
      // noticeably different on Chrome mobile.
      if (lang === 'en-us') score += 40;
      else if (lang.startsWith('en-')) score -= 20;
      if (preferredNames.some(pref => name.includes(pref.toLowerCase()))) score += 25;
      if (femaleKeywords.some(keyword => name.includes(keyword))) score += 15;
      if (qualityKeywords.some(keyword => name.includes(keyword))) score += 12;
      if (lang.startsWith('en')) score += 8;
      if (!voice.localService) score += 12; // remote voices often higher quality
      return score;
    };

    const englishUsVoices = voices.filter(v => (v.lang || '').toLowerCase() === 'en-us');
    const candidateVoices = englishUsVoices.length > 0
      ? englishUsVoices
      : voices.filter(v => (v.lang || '').toLowerCase().startsWith('en-'));
    const bestVoice = candidateVoices
      .map(v => ({ voice: v, score: scoreVoice(v) }))
      .sort((a, b) => b.score - a.score)[0]?.voice;

    voiceNotificationState = {
      ready: true,
      preferredVoice: bestVoice || null
    };
  };

  // Some browsers load voices asynchronously
  window.speechSynthesis.onvoiceschanged = selectVoice;
  selectVoice();
}

function getTimestampValue(timestamp) {
  if (!timestamp) {
    return null;
  }
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
}

/**
 * Load notified message IDs from sessionStorage
 * Returns a Map of messageId -> timestamp
 */
function loadNotifiedMessagesFromStorage() {
  try {
    const stored = sessionStorage.getItem(NOTIFIED_MESSAGES_STORAGE_KEY);
    if (!stored) return new Map();
    const parsed = JSON.parse(stored);
    const now = Date.now();
    const result = new Map();
    // Filter out expired entries while loading
    for (const [id, ts] of Object.entries(parsed)) {
      if (now - ts < GLOBAL_NOTIFICATION_TTL) {
        result.set(id, ts);
      }
    }
    return result;
  } catch (e) {
    console.warn('Failed to load notified messages from storage:', e);
    return new Map();
  }
}

/**
 * Save notified message IDs to sessionStorage
 */
function saveNotifiedMessagesToStorage(messagesMap) {
  try {
    const obj = Object.fromEntries(messagesMap);
    sessionStorage.setItem(NOTIFIED_MESSAGES_STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn('Failed to save notified messages to storage:', e);
  }
}

/**
 * Check if a message has been notified (checks both in-memory and persistent storage)
 */
function isMessageNotified(messageId) {
  if (!messageId) return false;
  // Check in-memory set first (faster)
  if (globalNotifiedMessages.has(messageId)) return true;
  // Check persistent storage
  const stored = loadNotifiedMessagesFromStorage();
  if (stored.has(messageId)) {
    // Sync to in-memory set for faster future lookups
    globalNotifiedMessages.add(messageId);
    return true;
  }
  return false;
}

/**
 * Mark a message as notified (in both in-memory and persistent storage)
 */
function markMessageAsNotified(messageId) {
  if (!messageId) return;
  const now = Date.now();
  // Add to in-memory set
  globalNotifiedMessages.add(messageId);
  // Add to persistent storage
  const stored = loadNotifiedMessagesFromStorage();
  stored.set(messageId, now);
  saveNotifiedMessagesToStorage(stored);
  // Schedule cleanup from in-memory set (storage cleanup happens on load)
  setTimeout(() => {
    globalNotifiedMessages.delete(messageId);
  }, GLOBAL_NOTIFICATION_TTL);
}

function shouldNotifyAgentMessage(agentId, timestamp, messageId) {
  if (!agentId) {
    return false;
  }

  // Check global notification set first - prevents duplicate TTS across agents
  // This now checks both in-memory and persistent storage
  if (isMessageNotified(messageId)) {
    return false;
  }

  const lastNotified = lastNotifiedAgentMessage.get(agentId);
  if (messageId) {
    return !lastNotified || lastNotified.id !== messageId;
  }
  const messageTime = getTimestampValue(timestamp);
  if (messageTime === null) {
    return false;
  }
  const lastTime = lastNotified?.time || 0;
  return messageTime > lastTime;
}

function markAgentMessageNotified(agentId, timestamp, messageId) {
  if (!agentId) {
    return;
  }
  const messageTime = getTimestampValue(timestamp);
  const lastNotified = lastNotifiedAgentMessage.get(agentId) || { time: 0, id: null };

  if (messageId) {
    // Add to global set AND persistent storage to prevent duplicate TTS across agents
    markMessageAsNotified(messageId);

    lastNotifiedAgentMessage.set(agentId, {
      time: messageTime === null ? lastNotified.time : messageTime,
      id: messageId
    });
    return;
  }

  if (messageTime === null) {
    return;
  }

  if (messageTime > lastNotified.time) {
    lastNotifiedAgentMessage.set(agentId, {
      time: messageTime,
      id: lastNotified.id || null
    });
  }
}

function buildAgentNotificationText(agent) {
  if (!agent) {
    return '';
  }
  const name = agent.name || 'your agent';
  if (agent.lastMessagePriority === 'high') {
    return `Received high priority message from ${name}.`;
  }
  if (agent.unreadCount > 0) {
    return `${name} sent a message.`;
  }
  return `Update from ${name}.`;
}

function playAgentListNotification(agent) {
  if (window.voiceControl && window.voiceControl.voiceEnabled === false) {
    return;
  }

  // Check audio lock to prevent overlapping notifications
  if (ttsAudioLock) {
    console.log('TTS audio lock active, skipping agent list notification');
    return;
  }

  const notificationText = buildAgentNotificationText(agent);
  if (!notificationText) {
    return;
  }
  if (activeMessageTtsSession?.status === 'playing') pauseActiveMessagePlayback();
  if (window.voiceControl && typeof window.voiceControl.speak === 'function') {
    window.voiceControl.speak(notificationText);
    return;
  }
  speakVoiceNotification(notificationText);
}

function handleAgentMessageNotifications(agents, primeOnly = false, excludeAgentIds = new Set()) {
  if (!Array.isArray(agents)) {
    return;
  }

  // Sort agents to prioritize regular (standard) agents - they should get TTS priority
  // News feed notifications are supplementary and should be skipped if regular agent already notified
  const sortedAgents = [...agents].sort((a, b) => {
    const aIsNews = a.agentType === 'news_feed' ? 1 : 0;
    const bIsNews = b.agentType === 'news_feed' ? 1 : 0;
    return aIsNews - bIsNews;
  });

  sortedAgents.forEach((agent) => {
    if (!agent?.agentId || !agent.lastMessageTime) {
      return;
    }

    // Skip notifications for excluded agents (e.g., newly joined agents)
    if (excludeAgentIds.has(agent.agentId)) {
      return;
    }

    // Skip notifications for the currently selected agent - displayMessages handles those
    // with higher quality server-rendered audio notifications
    if (agent.agentId === selectedAgentId) {
      return;
    }

    if (!shouldNotifyAgentMessage(agent.agentId, agent.lastMessageTime, agent.lastMessageId)) {
      return;
    }

    markAgentMessageNotified(agent.agentId, agent.lastMessageTime, agent.lastMessageId);
    if (!primeOnly) {
      playAgentListNotification(agent);
    }
  });
}

/**
 * Play server-rendered audio notification when available, fall back to speech synthesis
 * Uses audio lock to prevent overlapping notifications
 */
function playVoiceNotification(message) {
  if (!('speechSynthesis' in window)) {
    // Still allow server-side audio to play
    if (!message?.notificationAudioUrl) return;
  }

  if (window.voiceControl && window.voiceControl.voiceEnabled === false) {
    return;
  }

  const notificationText = message?.notificationText || '';
  if (!notificationText) {
    return;
  }

  // Prevent overlapping TTS - if audio is already playing, skip
  if (ttsAudioLock) {
    console.log('TTS audio lock active, skipping duplicate notification');
    return;
  }

  if (activeMessageTtsSession?.status === 'playing') pauseActiveMessagePlayback();

  if (message.notificationAudioUrl) {
    try {
      // Acquire audio lock
      ttsAudioLock = true;

      const audio = new Audio(message.notificationAudioUrl);
      audio.volume = 0.9;

      // Release lock when audio ends or errors
      audio.addEventListener('ended', () => {
        ttsAudioLock = false;
      });
      audio.addEventListener('error', () => {
        ttsAudioLock = false;
      });

      audio.play()
        .then(() => {
          voiceNotificationState.audioUnlocked = true;
        })
        .catch((err) => {
          ttsAudioLock = false; // Release lock on play failure
          if (err && err.name === 'NotAllowedError') {
            if (!voiceNotificationState.autoplayBlockedNotified) {
              showErrorMessage('Tap anywhere to enable audio notifications.');
              voiceNotificationState.autoplayBlockedNotified = true;
            }
            return;
          }
          console.warn('Audio notification failed; skipping speech fallback to avoid legacy voice', err);
        });
      return;
    } catch (err) {
      ttsAudioLock = false; // Release lock on error
      console.warn('Audio notification error; skipping speech fallback to avoid legacy voice', err);
    }
  }

  // If no server audio URL is available, skip speech synthesis to avoid legacy voice
}

/**
 * Speak a concise, human-friendly notification string (fallback)
 */
function speakVoiceNotification(text) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  if (!voiceNotificationState.ready) {
    return;
  }

  const preview = (text || '').replace(/\s+/g, ' ').trim();
  if (!preview) {
    return;
  }

  const trimmedPreview = preview.length > 220 ? `${preview.slice(0, 220)}…` : preview;

  if (activeMessageTtsSession?.status === 'playing') pauseActiveMessagePlayback();

  const utterance = new SpeechSynthesisUtterance(trimmedPreview);

  utterance.voice = voiceNotificationState.preferredVoice || null;
  utterance.lang = 'en-US';
  utterance.rate = 0.96; // Slightly slower and warmer
  utterance.pitch = 1.1; // Lifted pitch softens robotic tone
  utterance.volume = 0.9;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/**
 * Play voice notification when a new agent joins the council
 * Uses pre-generated server-side TTS audio (same as message notifications)
 */
function playNewAgentNotification(agent) {
  if (!agent || !agent.name) return;

  // Check if voice is enabled
  if (window.voiceControl && window.voiceControl.voiceEnabled === false) {
    return;
  }

  // Play the chime first
  playNewAgentChime();

  // Use pre-generated audio URL from server (same TTS system as message notifications)
  if (agent.newAgentAudioUrl) {
    try {
      const audio = new Audio(agent.newAgentAudioUrl);
      audio.volume = 0.9;
      audio.play()
        .then(() => {
          voiceNotificationState.audioUnlocked = true;
        })
        .catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            if (!voiceNotificationState.autoplayBlockedNotified) {
              showErrorMessage('Tap anywhere to enable audio notifications.');
              voiceNotificationState.autoplayBlockedNotified = true;
            }
            return;
          }
          console.warn('New agent audio notification failed:', err);
        });
    } catch (err) {
      console.warn('New agent audio notification error:', err);
    }
  }
}

/**
 * Play a subtle chime sound for new agent notification
 */
async function playNewAgentChime() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // Resume the audio context in case it's suspended (browser autoplay restrictions)
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    // Create a pleasant two-tone chime
    const playTone = (frequency, startTime, duration) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';

      // Envelope for smooth attack and decay
      gainNode.gain.setValueAtTime(0, audioContext.currentTime + startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + startTime + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + startTime + duration);

      oscillator.start(audioContext.currentTime + startTime);
      oscillator.stop(audioContext.currentTime + startTime + duration);
    };

    // Play a pleasant ascending two-note chime (E5 -> G5)
    playTone(659.25, 0, 0.3);      // E5
    playTone(783.99, 0.15, 0.4);   // G5

    // Close audio context after sounds complete
    setTimeout(() => {
      audioContext.close();
    }, 1000);

  } catch (err) {
    console.warn('Could not play new agent chime:', err);
  }
}

/**
 * Check if encryption key is available, otherwise try to derive from pending password
 * For Google OAuth users, show a modal to enter their decryption password
 */
async function checkEncryptionKey() {
  // 1. Try to get already derived key from session storage
  encryptionKey = await window.E2EEncryption.getStoredEncryptionKey();

  if (encryptionKey) {
    sessionStorage.removeItem('pendingEncryptionPassword');
    console.log('Encryption key loaded from session');
    return;
  }

  const root = document.getElementById('dashboardRoot');
  const salt = root ? root.getAttribute('data-encryption-salt') : null;
  const isGoogleAuth = root?.getAttribute('data-is-google-auth') === 'true';

  // 2. Try to derive from pending password (set during login)
  const pendingPassword = sessionStorage.getItem('pendingEncryptionPassword');

  if (pendingPassword && salt) {
    try {
      console.log('Deriving encryption key from login password...');
      const candidate = await window.E2EEncryption.deriveKey(pendingPassword, salt);
      if (!await window.E2EEncryption.verifyMessageKey(candidate)) throw new Error('The login password does not match the message encryption password.');
      encryptionKey = candidate;
      await window.E2EEncryption.storeEncryptionKey(encryptionKey);

      // Clear the plaintext password from storage immediately
      sessionStorage.removeItem('pendingEncryptionPassword');
      console.log('Encryption key derived and stored securely');
      return;
    } catch (error) {
      sessionStorage.removeItem('pendingEncryptionPassword');
      console.error('Failed to derive key from pending password:', error);
    }
  }

  console.log('No encryption key available yet. Will prompt when needed.');
}

// Track if we've already prompted for encryption password this session
let encryptionPromptShown = false;
let firstAgentVoicePromptShown = false;
const FIRST_AGENT_VOICE_PROMPT_STORAGE_KEY = 'firstAgentVoicePromptShown';

function updateVoiceToggleButtonUI(isEnabled) {
  if (!voiceToggleBtn) return;

  const label = voiceToggleBtn.querySelector('span');

  if (isEnabled) {
    voiceToggleBtn.classList.remove('text-slate-400');
    voiceToggleBtn.classList.add('text-emerald-400', 'border-emerald-400/50', 'bg-emerald-400/10');
    if (label) label.textContent = 'Voice On';
  } else {
    voiceToggleBtn.classList.add('text-slate-400');
    voiceToggleBtn.classList.remove('text-emerald-400', 'border-emerald-400/50', 'bg-emerald-400/10');
    if (label) label.textContent = 'Voice Off';
  }
}

function triggerFirstAgentVoicePrompt() {
  if (firstAgentVoicePromptShown) return;
  if (localStorage.getItem(FIRST_AGENT_VOICE_PROMPT_STORAGE_KEY) === 'true') {
    firstAgentVoicePromptShown = true;
    return;
  }

  firstAgentVoicePromptShown = true;
  localStorage.setItem(FIRST_AGENT_VOICE_PROMPT_STORAGE_KEY, 'true');

  if (window.voiceControl?.voiceEnabled) {
    return;
  }

  const promptMessage = 'Voice notifications are off by default. You can enable them for agent updates any time.';
  const actions = {
    label: 'Enable voice',
    onClick: () => {
      if (!window.voiceControl) return;
      window.voiceControl.toggleVoiceNotifications(true);
      updateVoiceToggleButtonUI(true);
      window.voiceControl.speak('Voice notifications turned on');
    }
  };

  if (typeof window.showNotification === 'function') {
    window.showNotification(promptMessage, 'info', 'Voice notifications', 8000, actions);
    return;
  }

  showSuccessMessage(promptMessage);
}

/**
 * Check if text looks like encrypted content (base64 iv:tag:ciphertext format)
 * Uses strict validation to minimize false positives
 * @param {string} text - Text to analyze
 * @returns {boolean} True if text appears to be encrypted
 */
function looksLikeEncryptedText(text) {
  if (!text || typeof text !== 'string') return false;

  // Trim whitespace
  const trimmedText = text.trim();

  // Must not be empty
  if (!trimmedText) return false;

  // Must have exactly 3 colon-separated parts (iv:tag:ciphertext)
  const parts = trimmedText.split(':');
  if (parts.length !== 3) return false;

  // Each part must be pure base64 (alphanumeric + / + = padding)
  const base64Pattern = /^[A-Za-z0-9+/]+=*$/;

  // IV is 12 bytes = 16 chars base64, tag is 16 bytes = 22 chars base64
  // Ciphertext can be very short for short messages (e.g., 1 char = ~2-4 chars base64)
  const [iv, tag, ciphertext] = parts;

  // IV should be at least 16 chars (12 bytes base64 encoded)
  if (!base64Pattern.test(iv) || iv.length < 12) return false;
  // Tag should be at least 16 chars (but accept shorter for compatibility)
  if (!base64Pattern.test(tag) || tag.length < 12) return false;
  // Ciphertext can be very short - just require it exists and is valid base64
  if (!base64Pattern.test(ciphertext) || ciphertext.length < 1) return false;

  // Check that the text doesn't contain common readable patterns
  // These would indicate it's NOT encrypted content
  const readablePatterns = [
    /https?:\/\//i,     // URLs
    /[a-z]{5,}/i,       // Words with 5+ consecutive letters
    /\s{2,}/,           // Multiple spaces
    /[.,!?;]$/,         // Ending punctuation
    /^[a-z]/i,          // Starts with a letter (before base64 check)
  ];

  // If the original text (not split) contains readable patterns, it's not encrypted
  // But we need to be careful - base64 can contain letter sequences
  // So we check the ENTIRE string, not just parts

  // The total string shouldn't contain spaces
  if (trimmedText.includes(' ')) return false;

  // Calculate entropy - encrypted data has very high entropy
  const entropy = calculateEntropy(trimmedText.replace(/:/g, ''));

  // Increase threshold to 5.0 to reduce false positives
  // AES-encrypted base64 data typically has entropy > 5.5
  // Regular text with special formatting typically has entropy < 5.0
  return entropy > 5.0;
}

/**
 * Calculate Shannon entropy of a string (bits per character)
 * @param {string} str - String to analyze
 * @returns {number} Entropy value (higher = more random)
 */
function calculateEntropy(str) {
  if (!str || str.length === 0) return 0;

  const freq = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }

  const len = str.length;
  let entropy = 0;

  for (const char in freq) {
    const p = freq[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Trigger the decryption password prompt when first agent is added
 */
function triggerFirstAgentEncryptionPrompt() {
  if (encryptionPromptShown) return;
  encryptionPromptShown = true;

  console.log('First agent added. Showing decryption password modal.');
  showDecryptionPasswordModal();
}

/**
 * Show the decryption password modal for OAuth users
 */
function showDecryptionPasswordModal() {
  const modal = document.getElementById('decryptionPasswordModal');
  const input = document.getElementById('decryptionPasswordInput');
  const submitBtn = document.getElementById('decryptionSubmitBtn');
  const skipBtn = document.getElementById('decryptionSkipBtn');
  const errorDiv = document.getElementById('decryptionPasswordError');
  const form = document.getElementById('decryptionPasswordForm');

  if (!modal) return;

  modal.classList.remove('hidden');
  if (input) input.focus();

  // Handle form submission
  const handleSubmit = async () => {
    const password = input?.value?.trim();
    if (!password) {
      if (errorDiv) {
        errorDiv.querySelector('p').textContent = 'Please enter a password.';
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    const root = document.getElementById('dashboardRoot');
    const salt = root?.getAttribute('data-encryption-salt');

    if (!salt) {
      console.error('No encryption salt available');
      if (errorDiv) {
        errorDiv.querySelector('p').textContent = 'Encryption salt not available. Please refresh the page.';
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Unlocking...';
    if (errorDiv) errorDiv.classList.add('hidden');

    try {
      // Add timeout to prevent infinite hang (30 seconds max)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Key derivation timed out. Please try again.')), 30000);
      });

      // Derive the encryption key from the password
      const candidate = await Promise.race([
        window.E2EEncryption.deriveKey(password, salt),
        timeoutPromise
      ]);

      if (!await window.E2EEncryption.verifyMessageKey(candidate)) throw new Error('This password does not match your existing messages. Use the original message encryption password.');
      encryptionKey = candidate;
      await window.E2EEncryption.storeEncryptionKey(encryptionKey);

      console.log('Encryption key derived and stored from manual password entry');

      // Hide error and close modal
      if (errorDiv) errorDiv.classList.add('hidden');
      modal.classList.add('hidden');

      if (window.MultiChatManager?.refreshAllPanels) {
        await window.MultiChatManager.refreshAllPanels();
      }

      // Refresh messages if an agent is selected
      if (selectedAgentId) {
        conversationCache.delete(selectedAgentId);
        await loadMessages(selectedAgentId);
      }
    } catch (error) {
      console.error('Failed to derive key from entered password:', error);
      if (errorDiv) {
        errorDiv.querySelector('p').textContent = error.message || 'Failed to derive encryption key. Please check your password.';
        errorDiv.classList.remove('hidden');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock Messages';
    }
  };

  // Handle skip
  const handleSkip = () => {
    modal.classList.add('hidden');
    console.log('User skipped decryption password entry. Messages will remain encrypted.');
  };

  // Attach event listeners
  if (submitBtn) {
    submitBtn.onclick = handleSubmit;
  }

  if (skipBtn) {
    skipBtn.onclick = handleSkip;
  }

  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      handleSubmit();
    };
  }

  // Allow Enter key to submit
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    };
  }
}

/**
 * Setup keyboard navigation handlers
 */
function setupKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    // Keep native focus order and leave controls, dialogs and rich editors to
    // their own handlers. Global agent shortcuts must never activate another chat
    // while someone is using a menu, choosing a model or editing a form.
    if (e.defaultPrevented || e.key === 'Tab') return;
    if (e.target.closest?.('.shared-galaxy, .shared-galaxy-dialog, .a2a-group-gateway')) return;
    if (e.target.closest?.('dialog, [role="dialog"], [aria-modal="true"], [id$="Modal"], button, a, select, summary, [contenteditable]:not([contenteditable="false"])')) return;
    // Ignore if user is typing in an input (except Esc and Arrows for scrolling)
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const isEditableTarget = isInput || e.target.isContentEditable === true;
    const isConversation = e.target.id === 'conversationArea';
    const key = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : '';
    const isLetterKey = key >= 'a' && key <= 'z' && !e.ctrlKey && !e.metaKey && !e.altKey;
    const isDeleteShortcut = e.key === 'Delete' || e.key === 'Del';

    if (isDeleteShortcut && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget) {
      const deleteModal = document.getElementById('deleteConfirmationModal');
      if (!deleteModal || deleteModal.classList.contains('hidden')) {
        let targetAgentId = null;
        let targetAgentName = '';

        if (currentFocusArea === 'list') {
          const focusedListItem = document.querySelector('.agent-list-item--list-focused');
          if (focusedListItem) {
            targetAgentId = focusedListItem.getAttribute('data-agent-id') || null;
            targetAgentName = focusedListItem.getAttribute('data-agent-name') || '';
          }
        } else {
          const seats = getVisibleAgentSeats();
          if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
            const seat = seats[focusedAgentIndex];
            targetAgentId = seat.getAttribute('data-agent-id') || null;
            targetAgentName = seat.getAttribute('data-agent-name') || '';
          } else if (selectedAgentId) {
            const selectedSeat = seats.find((seat) => seat.getAttribute('data-agent-id') === selectedAgentId);
            if (selectedSeat) {
              targetAgentId = selectedSeat.getAttribute('data-agent-id') || selectedAgentId;
              targetAgentName = selectedSeat.getAttribute('data-agent-name') || selectedAgentName || '';
            }
          }
        }

        if (targetAgentId) {
          e.preventDefault();
          hideFloatingAgentMenu();
          showDeleteConfirmationModal(targetAgentId, targetAgentName);
          return;
        }
      }
    }

    // Explicit shortcut for the custom council/list navigation, without
    // taking over the browser's Tab / Shift+Tab focus order.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'j' && !isEditableTarget) {
      e.preventDefault();
      if (isMobileListOnlyMode()) {
        setFocusArea(currentFocusArea === 'conversation' ? 'list' : 'conversation');
      } else {
        if (currentFocusArea === 'council') {
          setFocusArea('list');
        } else if (currentFocusArea === 'list') {
          setFocusArea('council');
        } else if (currentFocusArea === 'conversation') {
          // From conversation, Tab goes to council
          setFocusArea('council');
        }
      }
      return;
    }

    if (isInput || isConversation) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.target.blur();
        setFocusArea(getDefaultNonConversationFocusArea());
        const seats = getVisibleAgentSeats();
        if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
          updateAgentFocus();
        }
      } else if (isInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.ctrlKey || e.metaKey)) {
        // Scroll current chat container manually if in input with Ctrl
        const isMultiChat = e.target.closest('.chat-tile');
        const scrollTarget = isMultiChat ? e.target.closest('.chat-tile').querySelector('.chat-tile__messages') : document.getElementById('conversationArea');
        if (scrollTarget) {
          e.preventDefault();
          const scrollAmount = 60; // slightly more for Ctrl
          if (e.key === 'ArrowUp') {
            scrollTarget.scrollTop -= scrollAmount;
          } else {
            scrollTarget.scrollTop += scrollAmount;
          }
        }
      } else if (isInput && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+Left/Right: reorder side-chat tile or switch main-chat agent
        const tileEl = e.target.closest('.chat-tile');
        if (tileEl) {
          // Side chat: move this tile left or right in the container
          const c = tileEl.parentElement;
          if (!c) return;
          const tiles = Array.from(c.querySelectorAll(':scope > .chat-tile'));
          const idx = tiles.indexOf(tileEl);
          if (e.key === 'ArrowLeft' && idx > 0) {
            e.preventDefault();
            c.insertBefore(tileEl, tiles[idx - 1]);
            tileEl.querySelector('.chat-tile__textarea')?.focus();
            // Flash to show the move
            tileEl.classList.add('chat-tile--flash');
            setTimeout(() => tileEl.classList.remove('chat-tile--flash'), 400);
            // Persist the new tile order
            window.MultiChatManager?.saveChatTileOrder?.();
          } else if (e.key === 'ArrowRight' && idx < tiles.length - 1) {
            e.preventDefault();
            c.insertBefore(tiles[idx + 1], tileEl);
            tileEl.querySelector('.chat-tile__textarea')?.focus();
            tileEl.classList.add('chat-tile--flash');
            setTimeout(() => tileEl.classList.remove('chat-tile--flash'), 400);
            // Persist the new tile order
            window.MultiChatManager?.saveChatTileOrder?.();
          }
        } else {
          // Main chat: switch to previous/next agent
          const seats = getVisibleAgentSeats();
          if (seats.length === 0) return;
          const currentId = selectedAgentId;
          let currentIndex = seats.findIndex(s => s.getAttribute('data-agent-id') === currentId);
          if (currentIndex === -1) currentIndex = focusedAgentIndex;
          const delta = e.key === 'ArrowRight' ? 1 : -1;
          const nextIndex = (currentIndex + delta + seats.length) % seats.length;
          if (nextIndex !== currentIndex) {
            e.preventDefault();
            const seat = seats[nextIndex];
            hideFloatingAgentMenu();
            document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
            seat.classList.add('agent-seat--selected');
            focusedAgentIndex = nextIndex;
            updateAgentFocus();
            openAgentWithFeedback(seat.getAttribute('data-agent-id'), seat.getAttribute('data-agent-name'), {
              priority: seat.getAttribute('data-agent-priority'),
              agentType: seat.getAttribute('data-agent-type') || 'standard',
              externalProvider: seat.getAttribute('data-agent-external-provider') || '',
              shouldCollapse: true
            });
            document.getElementById('userMessageInput')?.focus();
          }
        }
      } else if ((isConversation || isInput) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Switch between chats (main + multi-chat)
        const multiTiles = Array.from(document.querySelectorAll('.chat-tile'));
        const inTileIdx = multiTiles.findIndex(t => t.contains(e.target));
        const inMain = e.target.id === 'userMessageInput' || e.target.id === 'conversationArea';

        // If in input, only switch if cursor is at start/end
        if (isInput) {
          const isAtStart = e.target.selectionStart === 0 && e.target.selectionEnd === 0;
          const isAtEnd = e.target.selectionStart === e.target.value.length && e.target.selectionEnd === e.target.value.length;
          if (e.key === 'ArrowLeft' && !isAtStart) return;
          if (e.key === 'ArrowRight' && !isAtEnd) return;
        }

        e.preventDefault();

        const seats = getVisibleAgentSeats();
        if (seats.length === 0) return;

        if (e.key === 'ArrowRight') {
          if (inMain && multiTiles.length > 0) {
            multiTiles[0].querySelector('.chat-tile__textarea')?.focus();
          } else if (inTileIdx !== -1 && inTileIdx < multiTiles.length - 1) {
            multiTiles[inTileIdx + 1].querySelector('.chat-tile__textarea')?.focus();
          } else {
            // Reached right edge (last tile or main chat with no tiles) -> Switch main agent and focus main
            const currentId = selectedAgentId;
            let currentIndex = seats.findIndex(s => s.getAttribute('data-agent-id') === currentId);
            if (currentIndex === -1) currentIndex = focusedAgentIndex;
            const nextIndex = (currentIndex + 1) % seats.length;
            const seat = seats[nextIndex];
            
            hideFloatingAgentMenu();
            document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
            seat.classList.add('agent-seat--selected');
            focusedAgentIndex = nextIndex;
            updateAgentFocus();
            openAgentWithFeedback(seat.getAttribute('data-agent-id'), seat.getAttribute('data-agent-name'), {
              priority: seat.getAttribute('data-agent-priority'),
              agentType: seat.getAttribute('data-agent-type') || 'standard',
              externalProvider: seat.getAttribute('data-agent-external-provider') || '',
              shouldCollapse: true
            });
            // Focus main chat after switching
            document.getElementById('userMessageInput')?.focus();
          }
        } else { // ArrowLeft
          if (inTileIdx > 0) {
            multiTiles[inTileIdx - 1].querySelector('.chat-tile__textarea')?.focus();
          } else if (inTileIdx === 0) {
            document.getElementById('userMessageInput')?.focus();
          } else if (inMain) {
            // Reached left edge (main chat) -> Switch main agent and focus last tile if exists, else main
            const currentId = selectedAgentId;
            let currentIndex = seats.findIndex(s => s.getAttribute('data-agent-id') === currentId);
            if (currentIndex === -1) currentIndex = focusedAgentIndex;
            const prevIndex = (currentIndex - 1 + seats.length) % seats.length;
            const seat = seats[prevIndex];
            
            hideFloatingAgentMenu();
            document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
            seat.classList.add('agent-seat--selected');
            focusedAgentIndex = prevIndex;
            updateAgentFocus();
            openAgentWithFeedback(seat.getAttribute('data-agent-id'), seat.getAttribute('data-agent-name'), {
              priority: seat.getAttribute('data-agent-priority'),
              agentType: seat.getAttribute('data-agent-type') || 'standard',
              externalProvider: seat.getAttribute('data-agent-external-provider') || '',
              shouldCollapse: true
            });
            
            if (multiTiles.length > 0) {
              multiTiles[multiTiles.length - 1].querySelector('.chat-tile__textarea')?.focus();
            } else {
              document.getElementById('userMessageInput')?.focus();
            }
          }
        }
      } else if (isConversation && isLetterKey) {
        e.preventDefault();
        e.target.blur();
        setFocusArea(getDefaultNonConversationFocusArea());
      }
      // Prevent global agent navigation when typing in an input
      if (isInput) {
        // Only allow Escape to fall through if we want it to blur the input
        if (e.key !== 'Escape') {
          return;
        }
      }
      
      // If focused on conversation area, let default Up/Down scroll it.
      // We return here to prevent global agent navigation.
      if (!(isConversation && isLetterKey)) {
        return;
      }
    }

    const seats = getVisibleAgentSeats();
    const listItems = document.querySelectorAll('.agent-list-item');

    // Handle navigation based on current focus area
    if (currentFocusArea === 'list') {
      // List view navigation
      const focusedListItem = document.querySelector('.agent-list-item--list-focused');
      const currentIndex = focusedListItem ? Array.from(listItems).indexOf(focusedListItem) : -1;

      if (isLetterKey) {
        e.preventDefault();
        if (nameInputTimeout) clearTimeout(nameInputTimeout);
        nameInputBuffer += key;
        nameInputTimeout = setTimeout(() => {
          nameInputBuffer = '';
        }, NAME_TYPEAHEAD_TIMEOUT_MS);

        let targetIndex = Array.from(listItems).findIndex(item =>
          (item.getAttribute('data-agent-name') || '').toLowerCase().startsWith(nameInputBuffer)
        );
        if (targetIndex === -1 && nameInputBuffer.length > 1) {
          nameInputBuffer = key;
          targetIndex = Array.from(listItems).findIndex(item =>
            (item.getAttribute('data-agent-name') || '').toLowerCase().startsWith(nameInputBuffer)
          );
        }
        if (targetIndex !== -1) {
          setListFocus(targetIndex);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = currentIndex < listItems.length - 1 ? currentIndex + 1 : 0;
        setListFocus(nextIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : listItems.length - 1;
        setListFocus(prevIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (focusedListItem) {
          const agentId = focusedListItem.getAttribute('data-agent-id');
          const agentName = focusedListItem.getAttribute('data-agent-name');
          const metadata = {
            priority: focusedListItem.getAttribute('data-agent-priority'),
            agentType: focusedListItem.getAttribute('data-agent-type') || 'standard',
            externalProvider: focusedListItem.getAttribute('data-agent-external-provider') || '',
            unread: Number(focusedListItem.getAttribute('data-agent-unread') || 0),
            lastActivity: focusedListItem.getAttribute('data-agent-last-activity'),
            isWorking: focusedListItem.getAttribute('data-agent-working') === 'true',
            lastHeartbeat: focusedListItem.getAttribute('data-agent-last-heartbeat'),
            shouldCollapse: true
          };
          const shouldFocusSidePanel = shouldSelectIntoSidePanel(agentId, metadata);

          hideFloatingAgentMenu();
          openAgentWithFeedback(agentId, agentName, metadata);
          setFocusArea('conversation');

          // Focus the input after selection
          if (!shouldFocusSidePanel) {
            setTimeout(() => {
              if (userMessageInput && !userMessageInput.disabled) {
                userMessageInput.focus();
              }
            }, 100);
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setFocusArea(getDefaultNonConversationFocusArea());
      }
      return;
    }

    // Council chamber navigation (default)
    if (seats.length === 0) return;

    // Initialize focus if none
    if (focusedAgentIndex === -1 && (
      e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
      e.key === 'ArrowUp' || e.key === 'ArrowDown'
    )) {
      focusedAgentIndex = 0;
      updateAgentFocus();
      return;
    }

    if (isLetterKey) {
      e.preventDefault();
      if (nameInputTimeout) clearTimeout(nameInputTimeout);
      nameInputBuffer += key;
      nameInputTimeout = setTimeout(() => {
        nameInputBuffer = '';
      }, NAME_TYPEAHEAD_TIMEOUT_MS);

      let targetIndex = seats.findIndex(seat =>
        (seat.getAttribute('data-agent-name') || '').toLowerCase().startsWith(nameInputBuffer)
      );
      if (targetIndex === -1 && nameInputBuffer.length > 1) {
        nameInputBuffer = key;
        targetIndex = seats.findIndex(seat =>
          (seat.getAttribute('data-agent-name') || '').toLowerCase().startsWith(nameInputBuffer)
        );
      }
      if (targetIndex !== -1) {
        focusedAgentIndex = targetIndex;
        updateAgentFocus();
      }
      return;
    }

    // Handle number keys for jumping to agents
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();

      // Clear any existing timeout
      if (numberInputTimeout) {
        clearTimeout(numberInputTimeout);
      }

      // Append to buffer
      numberInputBuffer += e.key;

      // If buffer has 2 digits or we have more than 9 agents and first digit > seats.length/10
      // process immediately for two-digit numbers
      if (numberInputBuffer.length >= 2) {
        const targetIndex = parseInt(numberInputBuffer, 10) - 1;
        numberInputBuffer = '';
        if (targetIndex >= 0 && targetIndex < seats.length) {
          focusedAgentIndex = targetIndex;
          updateAgentFocus();
        }
      } else {
        // Wait briefly for potential second digit
        const waitTime = seats.length > 9 ? 400 : 100; // Longer wait if we have 10+ agents
        numberInputTimeout = setTimeout(() => {
          const targetIndex = parseInt(numberInputBuffer, 10) - 1;
          numberInputBuffer = '';
          if (targetIndex >= 0 && targetIndex < seats.length) {
            focusedAgentIndex = targetIndex;
            updateAgentFocus();
          }
        }, waitTime);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusedAgentIndex = (focusedAgentIndex + 1) % seats.length;
        updateAgentFocus();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusedAgentIndex = (focusedAgentIndex - 1 + seats.length) % seats.length;
        updateAgentFocus();
        break;
      case 'Backspace':
        if (activeGroupId) {
          e.preventDefault();
          exitGroupView();
        }
        break;
      case 'Enter':
        if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
          e.preventDefault();
          const seat = seats[focusedAgentIndex];
          const groupId = seat.getAttribute('data-group-id');
          if (groupId) {
            hideFloatingAgentMenu();
            enterGroupView(groupId);
            focusedAgentIndex = getVisibleAgentSeats().length > 0 ? 0 : -1;
            previousFocusedIndex = -1;
            updateAgentFocus();
            break;
          }
          const agentId = seat.getAttribute('data-agent-id');
          const agentName = seat.getAttribute('data-agent-name');
          if (!agentId) break;

          // If agent is not already selected, select it
          if (agentId !== selectedAgentId) {
            const metadata = {
              priority: seat.getAttribute('data-agent-priority'),
              agentType: seat.getAttribute('data-agent-type') || 'standard',
              externalProvider: seat.getAttribute('data-agent-external-provider') || '',
              unread: Number(seat.getAttribute('data-agent-unread') || 0),
              lastActivity: seat.getAttribute('data-agent-last-activity'),
              isWorking: seat.getAttribute('data-agent-working') === 'true',
              lastHeartbeat: seat.getAttribute('data-agent-last-heartbeat'),
              shouldCollapse: true
            };
            const shouldFocusSidePanel = shouldSelectIntoSidePanel(agentId, metadata);

            hideFloatingAgentMenu();
            document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
            seat.classList.add('agent-seat--selected');
            openAgentWithFeedback(agentId, agentName, metadata);
            // Move to conversation focus area
            setFocusArea('conversation');

            // Keep side-tile focus when this agent is already pinned there.
            if (!shouldFocusSidePanel) {
              setTimeout(() => {
                if (userMessageInput && !userMessageInput.disabled) {
                  userMessageInput.focus();
                }
              }, 100);
            }
          } else {
            // Move to conversation focus area
            setFocusArea('conversation');

            // Always focus the input after Enter when already in main chat.
            setTimeout(() => {
              if (userMessageInput && !userMessageInput.disabled) {
                userMessageInput.focus();
              }
            }, 100);
          }
        }
        break;
      case 'Escape':
        // Already in council, do nothing special
        break;
      case '/':
        e.preventDefault();
        if (userMessageInput && !userMessageInput.disabled) {
          setFocusArea('conversation');
          userMessageInput.focus();
        }
        break;
    }
  });
}

/**
 * Set the current focus area and update visual indicators
 */
function setFocusArea(area) {
  if (isMobileListOnlyMode() && area === 'council') {
    area = 'list';
  }
  currentFocusArea = area;

  // Remove all focus classes
  const councilChamber = document.querySelector('.council-chamber');
  const agentListPanel = document.getElementById('agentListPanel');
  const conversationPanel = document.querySelector('aside.glass-panel');

  if (councilChamber) councilChamber.classList.remove('council-chamber--focused');
  if (agentListPanel) agentListPanel.classList.remove('agent-list-panel--focused');
  if (conversationPanel) conversationPanel.classList.remove('glass-panel--focused');

  // Clear list focus
  document.querySelectorAll('.agent-list-item--list-focused').forEach(el => {
    el.classList.remove('agent-list-item--list-focused');
  });

  // Apply focus to current area
  if (area === 'council') {
    if (councilChamber) councilChamber.classList.add('council-chamber--focused');
  } else if (area === 'list') {
    if (agentListPanel) agentListPanel.classList.add('agent-list-panel--focused');
    // Focus first list item if none focused
    setListFocus(0);
  } else if (area === 'conversation') {
    if (conversationPanel) conversationPanel.classList.add('glass-panel--focused');
  }
}

/**
 * Set focus on a specific list item
 */
function setListFocus(index) {
  const listItems = document.querySelectorAll('.agent-list-item');
  listItems.forEach((item, i) => {
    if (i === index) {
      item.classList.add('agent-list-item--list-focused');
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      item.classList.remove('agent-list-item--list-focused');
    }
  });
}

/**
 * Get visible agent seats
 */
function getVisibleAgentSeats() {
  const seats = Array.from(document.querySelectorAll('.agent-seat, .group-seat'));
  return seats.filter(
    seat => seat.offsetParent !== null && seat.style.display !== 'none' && seat.style.pointerEvents !== 'none'
  );
}

/**
 * Update visual focus state for agents
 */
function updateAgentFocus() {
  const seats = getVisibleAgentSeats();

  // Remove focus class from all (but keep selected class)
  document.querySelectorAll('.agent-seat, .group-seat').forEach(seat => {
    seat.classList.remove('agent-seat--focused');
  });

  // Add to current. Selection is reserved for Enter/click so arrows only move focus.
  if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
    const seat = seats[focusedAgentIndex];
    seat.classList.add('agent-seat--focused');

    // Determine animation direction (clockwise or counter-clockwise)
    const conversationArea = document.getElementById('conversationArea');
    if (conversationArea && previousFocusedIndex !== -1 && previousFocusedIndex !== focusedAgentIndex) {
      const totalSeats = seats.length;
      const forward = (focusedAgentIndex - previousFocusedIndex + totalSeats) % totalSeats;
      const backward = (previousFocusedIndex - focusedAgentIndex + totalSeats) % totalSeats;

      // Remove any existing animation classes
      conversationArea.classList.remove('slide-in-right', 'slide-in-left');

      // Add appropriate animation class based on shortest path
      if (forward <= backward) {
        // Moving clockwise - slide from right
        conversationArea.classList.add('slide-in-right');
      } else {
        // Moving counter-clockwise - slide from left
        conversationArea.classList.add('slide-in-left');
      }

      // Remove animation class after animation completes
      setTimeout(() => {
        conversationArea.classList.remove('slide-in-right', 'slide-in-left');
      }, 200);
    }

    // Update previous index
    previousFocusedIndex = focusedAgentIndex;

  }
}

/**
 * Navigate through agent list by delta (-1 for previous, +1 for next)
 * Used for swipe gestures and keyboard navigation on mobile
 */
function navigateAgentListBy(delta) {
  // Get all visible agent list items
  const listItems = Array.from(document.querySelectorAll('.agent-list-item[data-agent-id]'));
  if (listItems.length === 0) return;

  // Find currently selected agent
  let currentIndex = listItems.findIndex(item => item.classList.contains('agent-list-item--selected'));
  if (currentIndex === -1) {
    // If no agent selected, start from first
    currentIndex = 0;
  } else {
    // Move by delta with wrapping
    currentIndex = (currentIndex + delta + listItems.length) % listItems.length;
  }

  // Click the target agent to select it
  const targetItem = listItems[currentIndex];
  if (targetItem) {
    targetItem.click();
  }
}

function setupMainPinButton() {
  const pinBtn = document.getElementById('pinToSideBtn');
  if (!pinBtn) return;

  const iconHost = pinBtn.querySelector('.pin-chat-icon');
  if (iconHost && !iconHost.querySelector('svg')) {
    iconHost.innerHTML = getPinChatIconSvg('w-3.5 h-3.5');
  }

  pinBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (shouldSuppressPinControlsForMobile()) return;
    if (!selectedAgentId) return;

    const resolvedName = getResolvedSelectedAgentName() || selectedAgentName || 'Agent';
    const pinned = pinChatToSidePanel(selectedAgentId, resolvedName, selectedAgentExternalProvider || '');
    updateMainPinButtonState();

    if (selectedAgentId) {
      document.querySelectorAll('.agent-list-pin-btn').forEach((btn) => {
        if (btn.getAttribute('data-agent-id') === selectedAgentId) {
          btn.classList.toggle('chat-tile__pin-btn--active', pinned);
        }
      });
    }
  });

  updateMainPinButtonState();
}

function setupSideChatAddPicker() {
  const addBtn = document.getElementById('sideChatAddBtn');
  const picker = document.getElementById('sideChatPicker');
  const closeBtn = document.getElementById('sideChatPickerCloseBtn');
  const search = document.getElementById('sideChatPickerSearch');
  const list = document.getElementById('sideChatPickerList');
  if (!addBtn || !picker || !list) return;

  addBtn.setAttribute('aria-expanded', 'false');

  addBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (picker.classList.contains('hidden')) {
      openSideChatPicker();
    } else {
      closeSideChatPicker();
    }
  });

  closeBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    closeSideChatPicker();
  });

  search?.addEventListener('input', renderSideChatPickerList);

  list.addEventListener('click', (event) => {
    const item = event.target.closest('.side-chat-picker__item');
    if (!item) return;
    chooseSideChatFromPicker(
      item.getAttribute('data-agent-id'),
      item.getAttribute('data-agent-name') || 'Agent',
      item.getAttribute('data-agent-external-provider') || ''
    );
  });

  document.addEventListener('click', (event) => {
    if (picker.classList.contains('hidden')) return;
    if (picker.contains(event.target) || addBtn.contains(event.target)) return;
    closeSideChatPicker();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !picker.classList.contains('hidden')) {
      closeSideChatPicker();
      addBtn.focus();
    }
  });

  window.addEventListener('resize', syncSideChatAddButtonState);
  syncSideChatAddButtonState();
}

/**
 * Setup decryption password modal button
 */
function setupDecryptionModalButton() {
  const openBtn = document.getElementById('openDecryptionModalBtn');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      showDecryptionPasswordModal();
    });
  }
}

/**
 * Setup voice control handlers
 */
function setupVoiceControl() {
  voiceToggleBtn = document.getElementById('voiceToggle');
  const speechSupported = () => window.voiceControl && window.voiceControl.supportsSpeechRecognition;

  if (voiceToggleBtn) {
    const initialState = window.voiceControl ? window.voiceControl.voiceEnabled : false;
    updateVoiceToggleButtonUI(initialState);

    voiceToggleBtn.addEventListener('click', () => {
      if (!window.voiceControl) return;

      const isEnabled = !window.voiceControl.voiceEnabled;
      window.voiceControl.toggleVoiceNotifications(isEnabled);

      // Update UI
      updateVoiceToggleButtonUI(isEnabled);

      if (isEnabled) {
        window.voiceControl.speak('Voice notifications turned on');
      }
    });
  }

  document.addEventListener('voice-notifications-changed', (event) => {
    updateVoiceToggleButtonUI(Boolean(event?.detail?.enabled));
  });

  if (voiceInputBtn) {
    if (!speechSupported()) {
      voiceInputBtn.disabled = true;
      voiceInputBtn.title = 'Voice input needs a Chromium browser (Chrome/Edge) with microphone access enabled.';
    }

    voiceInputBtn.addEventListener('click', () => {
      if (!window.voiceControl || !speechSupported()) {
        showErrorMessage('Voice input is only available in Chrome/Edge with microphone access allowed.');
        return;
      }

      if (window.voiceControl.isListening) {
        window.voiceControl.stopListening();
        voiceInputBtn.classList.remove('text-red-400', 'animate-pulse');
      } else {
        voiceInputBtn.classList.add('text-red-400', 'animate-pulse');

        window.voiceControl.startListening(
          (text) => {
            // On result
            if (userMessageInput) {
              const currentVal = userMessageInput.value;
              userMessageInput.value = currentVal ? currentVal + ' ' + text : text;
              updateComposerState();

              // Auto-send if it's a short command? Maybe not for now, safer to let user review.
            }
          },
          () => {
            // On start
            voiceInputBtn.classList.add('text-red-400', 'animate-pulse');
          },
          () => {
            // On end
            voiceInputBtn.classList.remove('text-red-400', 'animate-pulse');
          },
          (error) => {
            // On error
            console.error('Voice input error:', error);
            if (error) {
              showErrorMessage(error);
            }
            voiceInputBtn.classList.remove('text-red-400', 'animate-pulse');
          }
        );
      }
    });
  }
}

/**
 * Setup copy buttons for agent setup and instructions
 */
function setupCopyButtons() {
  const agentHeaderInfo = document.getElementById('agentHeaderInfo');
  const contextMenu = document.getElementById('agentContextMenu');
  const floatingMenu = document.getElementById('floatingAgentMenu');
  setupAgentCliMenuButtons();

  // Toggle menu on header click
  if (agentHeaderInfo && contextMenu) {
    // The chat tile's glass/blur layers and contained conversation can paint
    // over a menu nested in the header, so the menu lives on <body> as a
    // fixed overlay placed under the agent name.
    document.body.append(contextMenu);
    contextMenu.classList.remove('absolute', 'top-full', 'left-0', 'mt-2', 'z-50', 'overflow-hidden');
    contextMenu.classList.add('agent-header-context-menu');
    // Inline so a stale cached agent-actions.css cannot drop the overlay
    // back under the conversation.
    contextMenu.style.position = 'fixed';
    contextMenu.style.zIndex = '170';
    contextMenu.style.overflowY = 'auto';
    const placeContextMenu = () => {
      if (contextMenu.classList.contains('hidden')) return;
      const margin = 12;
      const anchor = agentHeaderInfo.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      contextMenu.style.maxHeight = `${Math.max(160, height - anchor.bottom - 8 - margin)}px`;
      const menuWidth = contextMenu.getBoundingClientRect().width;
      contextMenu.style.left = `${Math.max(margin, Math.min(anchor.left, width - menuWidth - margin))}px`;
      contextMenu.style.top = `${Math.min(anchor.bottom + 8, height - 160 - margin)}px`;
    };
    const closeContextMenu = () => contextMenu.classList.add('hidden');
    window.addEventListener('resize', closeContextMenu);
    window.visualViewport?.addEventListener('resize', closeContextMenu);

    agentHeaderInfo.addEventListener('click', (e) => {
      // Don't toggle if clicking the buttons themselves
      if (e.target.closest('button')) return;

      e.stopPropagation();
      if (selectedAgentId && selectedAgentId !== '__ALL__') contextMenu.dataset.agentId = selectedAgentId;
      else delete contextMenu.dataset.agentId;
      const shareButton = document.getElementById('shareAgentFromContextMenu');
      if (shareButton) {
        shareButton.hidden = !selectedAgentId || selectedAgentId === '__ALL__' || selectedAgentType === 'news_feed';
        const waiting = findCachedAgentRecord(selectedAgentId)?.accessRequests || 0;
        shareButton.textContent = waiting > 0 ? `Share this agent (${waiting} waiting for approval)` : 'Share this agent';
      }
      updateAgentCliMenuButton('updateAgentBtn', selectedAgentId);
      const openingContextMenu = contextMenu.classList.contains('hidden');
      contextMenu.classList.toggle('hidden');
      placeContextMenu();
      // Hide floating menu when opening header menu
      hideFloatingAgentMenu();
      if (openingContextMenu && selectedAgentId) {
        refreshAgentActionStats(selectedAgentId, resolveAgentStatsMetadata(selectedAgentId), {
          force: true,
          targetMenus: [contextMenu]
        });
      }
    });

    // Close menus when clicking outside
    document.addEventListener('click', (e) => {
      const isAgentSeatClick = e.target.closest('.agent-seat');
      const isFloatingMenuClick = floatingMenu && floatingMenu.contains(e.target);

      // Close header context menu
      if (!contextMenu.classList.contains('hidden') && !agentHeaderInfo.contains(e.target)
        && !contextMenu.contains(e.target) && !isAgentSeatClick) {
        contextMenu.classList.add('hidden');
      }

      // Close floating menu when clicking outside (but not on itself or agent seats)
      if (floatingMenu && !floatingMenu.classList.contains('hidden') && !isAgentSeatClick && !isFloatingMenuClick) {
        hideFloatingAgentMenu();
      }
    });
  }

  // Copy the name belonging to the menu that was opened.
  for (const buttonId of ['copyAgentNameBtn', 'floatingCopyAgentNameBtn']) {
    const button = document.getElementById(buttonId);
    button?.addEventListener('click', async (event) => {
      event.stopPropagation();
      const name = buttonId === 'floatingCopyAgentNameBtn'
        ? document.getElementById('floatingAgentName')?.textContent
        : selectedAgentName;
      if (!name) return;
      try {
        if (!navigator.clipboard?.writeText) {
          showErrorMessage('Clipboard access is not supported in this browser.');
          return;
        }
        await navigator.clipboard.writeText(name);
        showSuccessMessage('Agent name copied');
        contextMenu?.classList.add('hidden');
        hideFloatingAgentMenu();
      } catch (error) {
        showErrorMessage('Could not copy agent name. Please try again.');
      }
    });
  }

  // "N want access" chips in the agent list open that agent's Share panel,
  // where the requests are approved or declined.
  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-open-agent-access-requests]');
    if (!trigger) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const agentId = trigger.dataset.agentId;
    try {
      const openSharing = window.AgentActionsUI?.openSharing || window.AgentChatSharing?.openForAgent;
      if (!openSharing) throw new Error('Agent sharing is still loading. Please try again.');
      await openSharing(agentId, findCachedAgentRecord(agentId)?.name || 'Agent');
    } catch (error) {
      showErrorMessage(error.message || 'Could not open agent sharing.');
    }
  }, true);

  document.getElementById('shareAgentFromContextMenu')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const agentId = selectedAgentId;
    if (!agentId) return;
    const agent = findCachedAgentRecord(agentId);
    try {
      const openSharing = window.AgentActionsUI?.openSharing || window.AgentChatSharing?.openForAgent;
      if (!openSharing) throw new Error('Agent sharing is still loading. Please try again.');
      await openSharing(agentId, agent?.name || selectedAgentName || 'Agent');
      document.getElementById('agentContextMenu')?.classList.add('hidden');
    } catch (error) {
      showErrorMessage(error.message || 'Could not open agent sharing.');
    }
  });

  // Setup floating menu buttons
  const floatingDeleteAgentBtn = document.getElementById('floatingDeleteAgentBtn');

  if (floatingDeleteAgentBtn) {
    floatingDeleteAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      showDeleteConfirmationModal(selectedAgentId, selectedAgentName);
      hideFloatingAgentMenu();
    });
  }

  // Floating Clear Conversation button
  const floatingClearConversationBtn = document.getElementById('floatingClearConversationBtn');
  if (floatingClearConversationBtn) {
    floatingClearConversationBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await clearConversation();
      hideFloatingAgentMenu();
    });
  }

  const floatingHideAllMessagesBtn = document.getElementById('floatingHideAllMessagesBtn');
  if (floatingHideAllMessagesBtn) {
    floatingHideAllMessagesBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideFloatingAgentMenu();
      await hideAllMessages();
    });
  }

  // Clear Conversation button (in agent header context menu)
  const clearConversationBtn = document.getElementById('clearConversationBtn');
  if (clearConversationBtn) {
    clearConversationBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await clearConversation();
      if (contextMenu) {
        contextMenu.classList.add('hidden');
      }
    });
  }

  // Hide All Messages button (in agent header context menu)
  const hideAllMessagesBtn = document.getElementById('hideAllMessagesBtn');
  if (hideAllMessagesBtn) {
    hideAllMessagesBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await hideAllMessages();
      if (contextMenu) {
        contextMenu.classList.add('hidden');
      }
    });
  }

  // Delete agent button
  const deleteAgentBtn = document.getElementById('deleteAgentBtn');
  if (deleteAgentBtn) {
    deleteAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      showDeleteConfirmationModal(selectedAgentId, selectedAgentName);
      // Close menu after deletion attempt
      if (contextMenu) {
        contextMenu.classList.add('hidden');
      }
    });
  }
}

/**
 * ============================================
 * Delete Agent Feature
 * ============================================
 */

function setupDeleteConfirmationModal() {
  const modal = document.getElementById('deleteConfirmationModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('deleteCancelBtn');
  const confirmBtn = document.getElementById('deleteConfirmBtn');
  const nameInput = document.getElementById('deleteAgentNameConfirmInput');

  const updateConfirmState = () => {
    if (!nameInput || !confirmBtn) return;
    const expected = (modal?.dataset?.expectedAgentName || '').trim();
    const actual = (nameInput.value || '').trim();
    const ok = expected.length > 0 && actual === expected;
    confirmBtn.disabled = !ok;
    nameInput.classList.toggle('border-amber-400', ok);
    nameInput.classList.toggle('border-slate-600', !ok);
  };

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideDeleteConfirmationModal();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const agentId = modal?.dataset?.agentId;
      const agentName = modal?.dataset?.agentName || selectedAgentName;
      const expected = (modal?.dataset?.expectedAgentName || '').trim();

      if (!agentId) {
        showErrorMessage('Invalid agent selection');
        return;
      }

      if (nameInput && expected.length > 0) {
        const actual = (nameInput.value || '').trim();
        if (actual !== expected) {
          showErrorMessage(`Type "${expected}" to confirm deletion`);
          nameInput.focus();
          updateConfirmState();
          return;
        }
      }

      hideDeleteConfirmationModal();
      await deleteAgentById(agentId, agentName);
    });
  }

  if (nameInput) {
    nameInput.addEventListener('input', updateConfirmState);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn?.click();
      }
    });
  }

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideDeleteConfirmationModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideDeleteConfirmationModal();
    }
  });
}

function showDeleteConfirmationModal(agentId, agentName) {
  const resolvedAgentId = agentId || selectedAgentId;
  const resolvedAgentName =
    agentName ||
    document.getElementById('selectedAgentName')?.textContent ||
    selectedAgentName ||
    'this agent';
  const expectedAgentName = (resolvedAgentName || '').trim();

  if (!resolvedAgentId) {
    showErrorMessage('No agent selected');
    return;
  }

  const modal = document.getElementById('deleteConfirmationModal');
  const modalLabel = document.getElementById('deleteModalAgentNameLabel');
  const confirmBtn = document.getElementById('deleteConfirmBtn');
  const nameInput = document.getElementById('deleteAgentNameConfirmInput');
  const expectedNameEl = document.getElementById('deleteAgentNameConfirmExpected');

  // Fallback for pages without the modal (e.g., demo/older pages)
  if (!modal) {
    const confirmed = confirm(
      `Are you sure you want to delete "${resolvedAgentName}"?\n\n` +
      `This will permanently remove the agent and ALL associated messages. ` +
      `This action cannot be undone.`
    );
    if (confirmed) {
      deleteAgentById(resolvedAgentId, resolvedAgentName);
    }
    return;
  }

  modal.dataset.agentId = resolvedAgentId;
  modal.dataset.agentName = expectedAgentName;
  modal.dataset.expectedAgentName = expectedAgentName;

  setConfirmationModalAgentNameLabel(modalLabel, 'Delete', expectedAgentName);

  if (expectedNameEl) expectedNameEl.textContent = expectedAgentName;
  if (nameInput) {
    nameInput.value = '';
    confirmBtn && (confirmBtn.disabled = true);
    setTimeout(() => nameInput.focus(), 100);
  }

  modal.classList.remove('hidden');
  if (!nameInput) setTimeout(() => confirmBtn?.focus(), 100);
}

function hideDeleteConfirmationModal() {
  const modal = document.getElementById('deleteConfirmationModal');
  if (!modal) return;

  modal.classList.add('hidden');
  delete modal.dataset.agentId;
  delete modal.dataset.agentName;
  delete modal.dataset.expectedAgentName;

  const confirmBtn = document.getElementById('deleteConfirmBtn');
  const nameInput = document.getElementById('deleteAgentNameConfirmInput');
  if (confirmBtn && nameInput) confirmBtn.disabled = true;
  if (nameInput) nameInput.value = '';
}

function setConfirmationModalAgentNameLabel(labelEl, verb, agentName) {
  if (!labelEl) return;
  labelEl.textContent = `${verb} "`;
  const strong = document.createElement('strong');
  strong.textContent = agentName;
  labelEl.appendChild(strong);
  labelEl.appendChild(document.createTextNode('"?'));
}

/**
 * Delete an agent by ID (expects confirmation handled elsewhere)
 */
async function deleteAgentById(agentId, agentName = null) {
  if (!agentId) {
    showErrorMessage('No agent selected');
    return;
  }

  const resolvedName =
    agentName ||
    document.getElementById('selectedAgentName')?.textContent ||
    selectedAgentName ||
    'this agent';

  try {
    const response = await csrfFetch(`/api/user/agents/${agentId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to delete agent');
    }

    // Optimistically update UI, then force refresh
    removeAgentFromUI(agentId);

    // Refresh agent list (force refresh after deletion)
    await pollAgentList(true);

    window.showSuccess(`Agent "${resolvedName}" deleted`);

  } catch (error) {
    console.error('Error deleting agent:', error);
    showErrorMessage(error.message || 'Failed to delete agent. Please try again.');
  }
}

/**
 * Clear all messages for the currently selected agent
 */
async function clearConversation() {
  if (!selectedAgentId) {
    showErrorMessage('No agent selected');
    return;
  }

  const agentNameEl = document.getElementById('selectedAgentName');
  const agentName = agentNameEl ? agentNameEl.textContent : 'this agent';

  // Show confirmation modal instead of browser confirm()
  showClearConversationModal(selectedAgentId, agentName);
}

/**
 * Execute the actual conversation clear after modal confirmation
 */
async function executeClearConversation(agentId, agentName) {
  try {
    const response = await csrfFetch(`/api/user/agents/${agentId}/messages`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to clear conversation');
    }

    const data = await response.json();

    // Clear conversation area
    const conversationArea = document.getElementById('conversationArea');
    if (conversationArea) {
      conversationArea.innerHTML = '';
    }

    // Clean up attachment object URLs to free memory
    revokeAllAttachmentUrls();

    // Reset message tracking
    lastMessageTimestamp = null;
    lastMessageCursor = null;
    seenMessageIds.clear();

    // Show success message
    window.showSuccess?.(`Conversation cleared (${data.deletedCount} messages removed)`) ||
      console.log(`Conversation cleared (${data.deletedCount} messages removed)`);

  } catch (error) {
    console.error('Error clearing conversation:', error);
    showErrorMessage(error.message || 'Failed to clear conversation. Please try again.');
  }
}

/**
 * Delete a single message by ID
 */
async function deleteMessage(messageId, messageType) {
  if (!messageId) {
    showErrorMessage('No message ID provided');
    return;
  }

  try {
    const response = await csrfFetch(`/api/user/messages/${messageId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to delete message');
    }

    // Clean up attachment object URLs for this message
    revokeAttachmentUrls(messageId);

    // Remove message element from DOM
    const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageEl) {
      messageEl.style.transition = 'opacity 0.2s, transform 0.2s';
      messageEl.style.opacity = '0';
      messageEl.style.transform = 'translateX(-20px)';
      setTimeout(() => {
        messageEl.remove();
      }, 200);
    }

    // Remove from seen set to avoid duplicate detection issues
    seenMessageIds.delete(messageId);

  } catch (error) {
    console.error('Error deleting message:', error);
    showErrorMessage(error.message || 'Failed to delete message. Please try again.');
  }
}

/* ============================================
   Mobile Agent Dock - Horizontal Carousel
   ============================================ */

// Dock state
let dockCenterIndex = 0;
let dockSortedAgents = [];
let dockSuppressAutoCentering = false;
let dockTouchStartX = 0;
let dockTouchMoveX = 0;
let dockIsSwiping = false;
const DOCK_VISIBLE_COUNT = 5; // Number of visible agents
let pendingChatCarouselDirection = 0;
let pendingChatCarouselEnter = null; // { token, direction }
let chatCarouselTokenCounter = 0;
let dockLastAutoCenterAt = 0;
const DOCK_AUTOCENTER_COOLDOWN_MS = 1500;

function setMobileChromeCollapsed() {
  // Scroll-driven mobile chrome collapse is disabled. Keep this helper as a
  // cleanup shim for legacy callers/classes so mobile controls stay visible.
  document.body.classList.remove('mobile-chrome-collapsed');
  document.body.classList.remove('mobile-nav-hidden');
}

function bindMobileListToggleControls() {
  const collapseBtn = document.getElementById('collapseMobileListBtn');
  if (collapseBtn && collapseBtn.dataset.mobileListBound !== 'true') {
    collapseBtn.dataset.mobileListBound = 'true';
    collapseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(10);
      toggleMobileListExpanded();
    });
    collapseBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(10);
      toggleMobileListExpanded();
    }, { passive: false });
  }

  const mobileStatsToggle = document.getElementById('mobileStatsToggle');
  if (mobileStatsToggle && mobileStatsToggle.dataset.mobileListBound !== 'true') {
    mobileStatsToggle.dataset.mobileListBound = 'true';
    mobileStatsToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileListExpanded();
    });
  }

  const fastModeChatListToggle = document.getElementById('fastModeChatListToggle');
  if (fastModeChatListToggle && fastModeChatListToggle.dataset.mobileListBound !== 'true') {
    fastModeChatListToggle.dataset.mobileListBound = 'true';
    fastModeChatListToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(10);
      if (activeGroupId) {
        exitGroupView();
      }
      clearAgentListSearch({ blur: true, update: false });
      const listScroll = document.getElementById('agentListScroll');
      if (listScroll) delete listScroll.dataset.fastModeCleared;
      updateAgentListPanel(currentAgentList);
      setMobileListExpanded(true);
    });
  }

  // "Open Chats" button inside the placeholder (visible when no chat is selected in fast mode)
  const placeholderOpenChats = document.getElementById('fastModePlaceholderOpenChats');
  if (placeholderOpenChats && placeholderOpenChats.dataset.mobileListBound !== 'true') {
    placeholderOpenChats.dataset.mobileListBound = 'true';
    const openChatsList = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(10);
      if (activeGroupId) {
        exitGroupView();
      }
      clearAgentListSearch({ blur: true, update: false });
      const listScroll = document.getElementById('agentListScroll');
      if (listScroll) delete listScroll.dataset.fastModeCleared;
      updateAgentListPanel(currentAgentList);
      setMobileListExpanded(true);
    };
    placeholderOpenChats.addEventListener('click', openChatsList);
    placeholderOpenChats.addEventListener('touchstart', openChatsList, { passive: false });
  }
}

function bindMobileOverflowActionControls() {
  const TOGGLES = [
    {
      buttonId: 'mobileCouncilActionsToggle',
      bodyClass: 'mobile-council-actions-open',
      labelOpen: 'Close council actions',
      labelClosed: 'Open council actions',
      insideSelector: '#mobileCouncilActionsToggle, #councilHeaderActions'
    },
    {
      buttonId: 'mobileNavActionsToggle',
      bodyClass: 'mobile-nav-actions-open',
      labelOpen: 'Close navigation actions',
      labelClosed: 'Open navigation actions',
      insideSelector: '#mobileNavActionsToggle, nav .nav-right-buttons, body.dashboard-fast-mode #councilHeaderActions'
    }
  ];

  const syncAriaState = () => {
    TOGGLES.forEach(({ buttonId, bodyClass, labelOpen, labelClosed }) => {
      const button = document.getElementById(buttonId);
      if (!button) return;
      const isOpen = document.body.classList.contains(bodyClass);
      button.setAttribute('aria-expanded', String(isOpen));
      button.setAttribute('aria-label', isOpen ? labelOpen : labelClosed);
    });
  };

  syncAriaState();

  if (document.body.dataset.mobileOverflowDelegated === 'true') return;
  document.body.dataset.mobileOverflowDelegated = 'true';

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openToggle = TOGGLES.find(({ bodyClass }) => document.body.classList.contains(bodyClass));
    if (!openToggle) return;
    event.preventDefault();
    TOGGLES.forEach(({ bodyClass }) => document.body.classList.remove(bodyClass));
    syncAriaState();
    document.getElementById(openToggle.buttonId)?.focus();
  });

  // Single delegated click handler. Previous versions tried to combine
  // pointerup + click with timing-based dedupe, which produced stale closures
  // when this function ran more than once and intermittently caused the menu
  // to flip open then closed within the same tap. Delegation also means a
  // re-rendered button never loses its binding.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    const clickedNavToggle = target?.closest?.('#mobileNavActionsToggle');
    const clickedCouncilToggle = target?.closest?.('#mobileCouncilActionsToggle');

    if (clickedNavToggle) {
      event.preventDefault();
      event.stopPropagation();
      document.body.classList.toggle('mobile-nav-actions-open');
      syncAriaState();
      return;
    }
    if (clickedCouncilToggle) {
      event.preventDefault();
      event.stopPropagation();
      document.body.classList.toggle('mobile-council-actions-open');
      syncAriaState();
      return;
    }

    const clickedCouncilActions = target?.closest?.('#mobileCouncilActionsToggle, #councilHeaderActions');
    const clickedNavActions = target?.closest?.('#mobileNavActionsToggle, nav .nav-right-buttons, body.dashboard-fast-mode #councilHeaderActions');

    if (!clickedCouncilActions && document.body.classList.contains('mobile-council-actions-open')) {
      document.body.classList.remove('mobile-council-actions-open');
    }
    if (!clickedNavActions && document.body.classList.contains('mobile-nav-actions-open')) {
      document.body.classList.remove('mobile-nav-actions-open');
    }
    syncAriaState();
  });
}

function syncMobilePaperMenuChrome({ dockCollapsed = false, compactHeader = false } = {}) {
  const mobileAgentDock = document.getElementById('mobileAgentDock');
  if (mobileAgentDock) {
    mobileAgentDock.classList.toggle('mobile-agent-dock--collapsed', dockCollapsed);
  }

  const mobileHeader = document.getElementById('mobileHeader');
  if (mobileHeader) {
    mobileHeader.classList.toggle('header--compact-nav-active', compactHeader);
  }
}

function setMobileListExpanded(expanded, { skipBrowserHistory = false } = {}) {
  // Use panel toggling instead of body class
  const agentListPanel = document.getElementById('agentListPanel');
  if (agentListPanel) {
    agentListPanel.classList.toggle('mobile-expanded', expanded);
  }

  // The mobile list extends below its council card. The card's base
  // overflow-hidden would clip the expanded panel, so opt out only while open.
  document.querySelector('.council-chamber')?.classList.toggle('mobile-agent-list-open', expanded);

  // Also toggle body class for other mobile styles if needed, but we prefer checking panel state
  // ideally we remove dependence on body class, but keep it for safety if unrelated things use it
  document.body.classList.toggle('mobile-list-expanded', expanded);

  if (expanded && selectedAgentId && !skipBrowserHistory) {
    writeMobileBrowserNavigationState('list');
  } else if (
    !expanded &&
    selectedAgentId &&
    !skipBrowserHistory &&
    !handlingMobileBrowserNavigation &&
    getMobileBrowserNavigationState()?.view === 'list'
  ) {
    // Closing a list that has its own history entry should consume that entry,
    // so the next hardware Back press still reaches the state before the chat.
    window.history.back();
  }

  if (expanded) {
    // Keep top controls reachable while list is open.
    setMobileChromeCollapsed(false);
    if (isDashboardFastModeActive() && currentAgentList.length > 0) {
      const listScroll = document.getElementById('agentListScroll');
      if (listScroll) delete listScroll.dataset.fastModeCleared;
      updateAgentListPanel(currentAgentList);
    }
  } else {
    clearCollapsedFastModeAgentListPanel();
  }

  // Keep the paper menu in a stable layout while it is open.
  syncMobilePaperMenuChrome({
    dockCollapsed: !expanded,
    compactHeader: false
  });

  const toggleBtn = document.getElementById('collapseMobileListBtn');
  if (toggleBtn) {
    toggleBtn.title = expanded ? 'Collapse List' : 'Expand List';
    toggleBtn.setAttribute('aria-label', expanded ? 'Collapse agent list' : 'Expand agent list');
    toggleBtn.classList.toggle('expanded', expanded);
  }

  for (const id of ['collapseMobileListBtn', 'fastModeChatListToggle', 'fastModePlaceholderOpenChats']) {
    document.getElementById(id)?.setAttribute('aria-expanded', String(expanded || isAgentListDocked()));
  }

  const mobileStatsToggle = document.getElementById('mobileStatsToggle');
  if (mobileStatsToggle) {
    mobileStatsToggle.classList.toggle('expanded', expanded);
  }
}

function toggleMobileListExpanded() {
  const agentListPanel = document.getElementById('agentListPanel');
  const expanded = agentListPanel ? agentListPanel.classList.contains('mobile-expanded') : false;
  setMobileListExpanded(!expanded);
}

function isDockAgentOutsideViewport(agentId, edgePaddingPx = 24) {
  if (!agentId) return false;

  const dockCarousel = document.getElementById('dockCarousel');
  if (!dockCarousel) return false;

  const agentElement = dockCarousel.querySelector(`.dock-agent[data-agent-id="${agentId}"]`);
  if (!agentElement) return false;

  const containerRect = dockCarousel.getBoundingClientRect();
  const agentRect = agentElement.getBoundingClientRect();

  return (
    agentRect.left < containerRect.left + edgePaddingPx ||
    agentRect.right > containerRect.right - edgePaddingPx
  );
}

function maybeAutoCenterDockToSelectedAgent() {
  if (!selectedAgentId) return;
  if (dockSuppressAutoCentering) return;

  const now = Date.now();
  if (now - dockLastAutoCenterAt < DOCK_AUTOCENTER_COOLDOWN_MS) return;

  if (!isDockAgentOutsideViewport(selectedAgentId)) return;

  // Avoid constant "smooth" motion every poll; only jump when the selected agent
  // is genuinely out of view (e.g., after a new agent is appended).
  scrollDockToAgent(selectedAgentId, 'auto');
  dockLastAutoCenterAt = now;
}

/**
 * Initialize the mobile dock functionality
 * Uses arrow buttons to navigate between agents and switch chats
 */
function initializeMobileDock() {
  const dockNavLeft = document.getElementById('dockNavLeft');
  const dockNavRight = document.getElementById('dockNavRight');
  const dockCarousel = document.getElementById('dockCarousel');

  // Header Navigation (for collapsed state)
  const headerNavLeft = document.getElementById('headerNavLeft');
  const headerNavRight = document.getElementById('headerNavRight');
  const mobileHeader = document.getElementById('mobileHeader');

  // Keep the mobile paper menu compact by default. The list is still one tap
  // away, but starting collapsed leaves room for the chat and composer.
  const isMobile = window.matchMedia(MOBILE_LIST_ONLY_MEDIA_QUERY).matches;
  if (isMobile) {
    const hasSelectedAgent =
      Boolean(selectedAgentId) ||
      Boolean(document.querySelector('.agent-list-item--selected[data-agent-id]:not([data-agent-id=""])'));
    setMobileListExpanded(!hasSelectedAgent);
  } else {
    setMobileListExpanded(document.body.classList.contains('mobile-list-expanded'));
  }

  // --- Header Navigation Buttons ---
  if (headerNavLeft) {
    headerNavLeft.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(-1);
    });
  }
  if (headerNavRight) {
    headerNavRight.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(1);
    });
  }

  // --- Dock Navigation Buttons ---
  if (dockNavLeft) {
    const newLeft = dockNavLeft.cloneNode(true);
    dockNavLeft.parentNode.replaceChild(newLeft, dockNavLeft);
    newLeft.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(-1);
    });
    newLeft.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(-1);
    }, { passive: false });
  }

  if (dockNavRight) {
    const newRight = dockNavRight.cloneNode(true);
    dockNavRight.parentNode.replaceChild(newRight, dockNavRight);
    newRight.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(1);
    });
    newRight.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateDockAgent(1);
    }, { passive: false });
  }

  // --- Swipe Detection (Carousel) ---
  if (dockCarousel) {
    dockCarousel.addEventListener('touchstart', () => {
      dockSuppressAutoCentering = true;
    }, { passive: true });

    dockCarousel.addEventListener('touchend', () => {
      setTimeout(() => {
        dockSuppressAutoCentering = false;
      }, 1000);
    });

    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeStartTime = 0;

    dockCarousel.addEventListener('touchstart', (e) => {
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
      swipeStartTime = Date.now();
    }, { passive: true });

    dockCarousel.addEventListener('touchend', (e) => {
      const swipeEndX = e.changedTouches[0].clientX;
      const swipeEndY = e.changedTouches[0].clientY;
      const swipeTime = Date.now() - swipeStartTime;
      const diffX = swipeEndX - swipeStartX;
      const diffY = Math.abs(swipeEndY - swipeStartY);
      const minSwipeDistance = 50;
      const maxSwipeTime = 300;

      if (Math.abs(diffX) > minSwipeDistance && diffY < 50 && swipeTime < maxSwipeTime) {
        navigateDockAgent(diffX < 0 ? 1 : -1);
        if (navigator.vibrate) navigator.vibrate(10);
      }
    }, { passive: true });
  }

  // --- Swipe Detection (Header - for collapsed navigation) ---
  if (mobileHeader) {
    let headerSwipeStartX = 0;
    let headerSwipeStartY = 0;

    mobileHeader.addEventListener('touchstart', (e) => {
      headerSwipeStartX = e.touches[0].clientX;
      headerSwipeStartY = e.touches[0].clientY;
    }, { passive: true });

    mobileHeader.addEventListener('touchend', (e) => {
      const swipeEndX = e.changedTouches[0].clientX;
      const swipeEndY = e.changedTouches[0].clientY;
      const diffX = swipeEndX - headerSwipeStartX;
      const diffY = Math.abs(swipeEndY - headerSwipeStartY);

      // Only handle horizontal swipes on header
      if (Math.abs(diffX) > 50 && diffY < 30) {
        navigateDockAgent(diffX < 0 ? 1 : -1);
        if (navigator.vibrate) navigator.vibrate(10);
      }
    }, { passive: true });
  }

  // --- Vertical Swipe for Mobile List Expand/Collapse ---
  const dockContainer = document.getElementById('mobileAgentDock');
  if (dockContainer) {
    let listSwipeStartY = 0;
    let listSwipeStartX = 0;

    dockContainer.addEventListener('touchstart', (e) => {
      listSwipeStartY = e.touches[0].clientY;
      listSwipeStartX = e.touches[0].clientX;
    }, { passive: true });

    dockContainer.addEventListener('touchend', (e) => {
      const touchEndY = e.changedTouches[0].clientY;
      const touchEndX = e.changedTouches[0].clientX;
      const diffY = touchEndY - listSwipeStartY;
      const diffX = Math.abs(touchEndX - listSwipeStartX);

      if (diffY > 50 && diffX < 30) {
        setMobileListExpanded(true);
      }
    }, { passive: true });
  }

  // --- Collapse Button Handler ---
  bindMobileListToggleControls();

  // --- Interaction behavior ---
  const chatArea = document.querySelector('.grid.gap-5');
  if (chatArea) {
    const messageInput = document.getElementById('userMessageInput');
    if (messageInput) {
      messageInput.addEventListener('focus', () => {
        setMobileListExpanded(false);
      });
    }
  }

  // --- Stable Header Scroll Logic ---
  const listScroll = document.getElementById('agentListScroll');

  if (listScroll && dockContainer && mobileHeader) {
    listScroll.addEventListener('scroll', () => {
      if (!window.matchMedia(MOBILE_LIST_ONLY_MEDIA_QUERY).matches) return;
      syncMobilePaperMenuChrome({
        dockCollapsed: false,
        compactHeader: false
      });
    }, { passive: true });
  }
}

/**
 * Navigate to next/previous agent in the dock and select them
 * @param {number} direction - -1 for previous, 1 for next
 */
function navigateDockAgent(direction) {
  if (!dockSortedAgents || dockSortedAgents.length === 0) return;
  pendingChatCarouselDirection = direction;

  // Find current index
  let currentIndex = -1;
  if (selectedAgentId) {
    currentIndex = dockSortedAgents.findIndex(a => a.agentId === selectedAgentId);
  }

  // Calculate new index with wrapping
  let newIndex;
  if (currentIndex === -1) {
    // If no agent selected, start at beginning (or end if going backwards)
    newIndex = direction > 0 ? 0 : dockSortedAgents.length - 1;
  } else {
    newIndex = (currentIndex + direction + dockSortedAgents.length) % dockSortedAgents.length;
  }

  // Get the target agent
  const targetAgent = dockSortedAgents[newIndex];
  if (!targetAgent) return;

  // Construct metadata for selection
  const metadata = {
    priority: targetAgent.highestPriority,
    agentType: targetAgent.agentType || 'standard',
    externalProvider: targetAgent.externalProvider || '',
    unread: targetAgent.unreadCount || 0,
    lastActivity: targetAgent.lastActivityTime,
    isWorking: targetAgent.isWorking === true,
    lastHeartbeat: targetAgent.lastWorkingHeartbeatTime || ''
  };

  // Ensure dock follows the selection immediately
  dockSuppressAutoCentering = false;

  // Select the agent (this triggers UI updates and chat load)
  openAgentWithFeedback(targetAgent.agentId, targetAgent.name, metadata);

  // Provide haptic feedback if available (mobile friendly)
  if (navigator.vibrate) {
    navigator.vibrate(10);
  }
}

function isMobileDockViewport() {
  return window.matchMedia && window.matchMedia(MOBILE_LIST_ONLY_MEDIA_QUERY).matches;
}

function clearChatCarouselClasses(conversationArea) {
  if (!conversationArea) return;
  conversationArea.classList.remove(
    'chat-carousel-animating',
    'chat-carousel-leave-left',
    'chat-carousel-leave-right',
    'chat-carousel-leave-fade',
    'chat-carousel-enter-from-left',
    'chat-carousel-enter-from-right',
    'chat-carousel-enter-fade'
  );
}

function waitForAnimationEnd(element, timeoutMs = 260) {
  return new Promise((resolve) => {
    if (!element) {
      resolve();
      return;
    }

    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      element.removeEventListener('animationend', onEnd);
      resolve();
    };
    const onEnd = () => done();

    element.addEventListener('animationend', onEnd);
    setTimeout(done, timeoutMs);
  });
}

async function animateConversationLeave(direction) {
  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea || conversationArea.classList.contains('hidden')) return;

  clearChatCarouselClasses(conversationArea);
  conversationArea.classList.add('chat-carousel-animating');
  if (direction > 0) {
    conversationArea.classList.add('chat-carousel-leave-left');
  } else if (direction < 0) {
    conversationArea.classList.add('chat-carousel-leave-right');
  } else {
    conversationArea.classList.add('chat-carousel-leave-fade');
  }

  await waitForAnimationEnd(conversationArea, 240);
  clearChatCarouselClasses(conversationArea);
}

function scheduleConversationEnter(direction) {
  chatCarouselTokenCounter += 1;
  pendingChatCarouselEnter = { token: chatCarouselTokenCounter, direction };
  return chatCarouselTokenCounter;
}

function triggerConversationEnterIfScheduled() {
  const conversationArea = document.getElementById('conversationArea');
  if (!conversationArea || !pendingChatCarouselEnter) return;

  const tokenInDom = Number(conversationArea.dataset.chatCarouselToken || '0');
  if (tokenInDom !== pendingChatCarouselEnter.token) return;

  const { direction } = pendingChatCarouselEnter;
  pendingChatCarouselEnter = null;

  clearChatCarouselClasses(conversationArea);
  conversationArea.classList.add('chat-carousel-animating');
  if (direction > 0) {
    conversationArea.classList.add('chat-carousel-enter-from-right');
  } else if (direction < 0) {
    conversationArea.classList.add('chat-carousel-enter-from-left');
  } else {
    conversationArea.classList.add('chat-carousel-enter-fade');
  }

  waitForAnimationEnd(conversationArea, 340).then(() => {
    clearChatCarouselClasses(conversationArea);
  });
}

/**
 * Sort agents by fixed position for stable ordering in the dock.
 * Position is assigned when agent is created (max + 1).
 * Priority is shown via colors/indicators, not by reordering.
 */
function sortAgentsByPriority(agents) {
  // Sort by position for stable, fixed ordering
  // New agents get the next position number when created
  return [...agents].sort((a, b) => {
    return (a.position || 0) - (b.position || 0);
  });
}

/**
 * Get priority class for dock agent
 */
function getDockPriorityClass(agent) {
  if (agent.lastMessagePriority === 'high' || agent.highestPriority === 'high') {
    return 'dock-agent--urgent';
  }
  if (agent.lastMessagePriority === 'normal' || agent.unreadCount > 0) {
    return 'dock-agent--attention';
  }
  return 'dock-agent--idle';
}

/**
 * Get status indicator HTML for dock agent
 */
function getDockStatusIndicator(agent) {
  if (agent.highestPriority === 'high') {
    return '<div class="dock-agent-status dock-agent-status--urgent">!</div>';
  }
  if (agent.unreadCount > 0) {
    return `<div class="dock-agent-status dock-agent-status--attention">${agent.unreadCount}</div>`;
  }
  if (agent.isWorking === true) {
    return '<div class="dock-agent-status dock-agent-status--attention">🛠️</div>';
  }
  const avail = getAgentAvailability(agent);
  if (avail === 'online') return '<div class="dock-agent-status dock-agent-status--idle"></div>';
  if (avail === 'idle') return '<div class="dock-agent-status dock-agent-status--away"></div>';
  return '<div class="dock-agent-status dock-agent-status--offline">✕</div>';
}

/**
 * Update the mobile dock UI - now uses horizontal scroll instead of carousel
 */
function updateMobileDock(agents, options = {}) {
  const { render = true } = options;
  const dockCarousel = document.getElementById('dockCarousel');
  const dockPositionIndicator = document.getElementById('dockPositionIndicator');

  // Sort agents by fixed position
  dockSortedAgents = sortAgentsByPriority(agents);

  if (!dockCarousel || !render) return;

  if (dockSortedAgents.length === 0) {
    dockCarousel.innerHTML = `
      <div class="text-center text-slate-500 py-4">
        <p class="text-sm">No agents yet</p>
      </div>
    `;
    if (dockPositionIndicator) {
      dockPositionIndicator.innerHTML = '';
    }
    return;
  }

  // Render dock agents
  renderDockAgents();

  // Keep the selected agent visible without causing continuous drift.
  maybeAutoCenterDockToSelectedAgent();

  // Hide position indicators since we're using scroll now
  if (dockPositionIndicator) {
    dockPositionIndicator.innerHTML = '';
  }
}


/**
 * Render dock agents - simple horizontal scrollable list (no carousel rotation)
 * All agents shown in fixed position order, user can scroll horizontally
 */
function renderDockAgents() {
  const dockCarousel = document.getElementById('dockCarousel');
  if (!dockCarousel || dockSortedAgents.length === 0) return;

  // Preserve scroll position across re-renders to avoid "drifting" on mobile.
  const previousScrollLeft = dockCarousel.scrollLeft;
  const previousMaxScroll = Math.max(0, dockCarousel.scrollWidth - dockCarousel.clientWidth);
  const previousScrollRatio = previousMaxScroll > 0 ? (previousScrollLeft / previousMaxScroll) : 0;

  // Determine which agents to show in dock (group-aware)
  let dockAgentsToRender = dockSortedAgents;
  let html = '';

  if (activeGroupId) {
    // Group view: show back button + only group members
    html += `
      <div class="dock-group" data-action="exit-group">
        <div class="dock-group-avatar" style="background: rgba(100,116,139,0.3); border-color: rgba(100,116,139,0.4);">
          <svg class="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </div>
        <span class="dock-group-name" style="color: rgba(148,163,184,0.8);">Back</span>
      </div>
    `;
    const partition = getGroupPartition(currentAgentList);
    const groupData = partition.grouped.get(activeGroupId);
    dockAgentsToRender = groupData ? sortAgentsByPriority(groupData.agents) : [];
  } else if (currentGroups.length > 0) {
    // Main view: show groups first, then ungrouped
    const partition = getGroupPartition(currentAgentList);

    for (const group of currentGroups) {
      const groupData = partition.grouped.get(group.groupId);
      if (!groupData || groupData.agents.length === 0) continue;
      const meta = partition.groupMeta.get(group.groupId);

      // Mini stacked dots for group avatar
      const miniDots = groupData.agents.slice(0, 3).map((a, i) => {
        const colors = ['#8b5cf6', '#a78bfa', '#c4b5fd'];
        return `<div class="dock-group-avatar__mini" style="background:${colors[i % 3]};"></div>`;
      }).join('');

      let badgeHtml = '';
      if (meta?.hasUrgent) {
        badgeHtml = `<div class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 border border-slate-900 animate-pulse flex items-center justify-center"><span class="text-white text-[8px] font-bold">!</span></div>`;
      } else if (meta?.totalUnread > 0) {
        badgeHtml = `<div class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 border border-slate-900 flex items-center justify-center"><span class="text-slate-900 text-[8px] font-bold">${meta.totalUnread}</span></div>`;
      }

      html += `
        <div class="dock-group" data-group-id="${group.groupId}">
          <div class="dock-group-avatar relative">
            <div class="dock-group-avatar__stacked">${miniDots}</div>
            ${badgeHtml}
          </div>
          <span class="dock-group-name">${escapeHtml(group.groupName)}</span>
        </div>
      `;
    }

    dockAgentsToRender = sortAgentsByPriority(partition.ungrouped);
  }

  for (let i = 0; i < dockAgentsToRender.length; i++) {
    const agent = dockAgentsToRender[i];
    const isSelected = agent.agentId === selectedAgentId;
    const priorityClass = getDockPriorityClass(agent);
    const statusIndicator = getDockStatusIndicator(agent);
    const isOpenClaw = isOpenClawAgent(agent);
    const marbleSvg = getCachedMarbleSvg(agent.agentId, 100, agent.name, 'dock');

    html += `
      <div class="dock-agent ${priorityClass} ${isSelected ? 'dock-agent--selected' : ''}"
           data-agent-id="${agent.agentId}"
           data-agent-name="${escapeHtml(agent.name)}"
           data-agent-type="${agent.agentType || 'standard'}"
           data-agent-external-provider="${escapeHtml(agent.externalProvider || '')}">
        <div class="dock-agent-avatar">
          ${isOpenClaw ? `
            <div class="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-950 via-orange-950/30 to-slate-900 rounded-full border border-orange-400/30">
              ${getOpenClawIconSvg('w-[58%] h-[58%] text-orange-300')}
            </div>
          ` : `
            <div class="marble-container">${marbleSvg}</div>
            <div class="dock-agent-initials">${escapeHtml(agent.name.substring(0, 2).toUpperCase())}</div>
          `}
          ${statusIndicator}
        </div>
        ${DeviceBadge.render(agent.device)}
        <span class="dock-agent-name">${escapeHtml(agent.name)}</span>
      </div>
    `;
  }

  dockCarousel.innerHTML = html;

  // Restore scroll position (clamped to new max), which prevents the dock from
  // slowly shifting due to repeated polling and DOM re-renders.
  const maxScroll = Math.max(0, dockCarousel.scrollWidth - dockCarousel.clientWidth);
  if (maxScroll > 0) {
    dockCarousel.scrollLeft = Math.min(maxScroll, Math.max(0, previousScrollRatio * maxScroll));
  } else {
    dockCarousel.scrollLeft = 0;
  }

  // Add click handlers to dock agents
  dockCarousel.querySelectorAll('.dock-agent').forEach(agentEl => {
    agentEl.addEventListener('click', () => {
      const agentId = agentEl.getAttribute('data-agent-id');
      const agentName = agentEl.getAttribute('data-agent-name');

      // Find agent by ID directly (not by index) to avoid stale index bugs
      const agent = dockSortedAgents.find(a => a.agentId === agentId);
      if (agent) {
        const metadata = {
          priority: agent.highestPriority,
          agentType: agent.agentType || 'standard',
          externalProvider: agent.externalProvider || '',
          unread: agent.unreadCount || 0,
          lastActivity: agent.lastActivityTime,
          isWorking: agent.isWorking === true,
          lastHeartbeat: agent.lastWorkingHeartbeatTime || ''
        };

        // Update orbital view selection too
        document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
        const orbitalSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
        if (orbitalSeat) {
          orbitalSeat.classList.add('agent-seat--selected');
        }

        // Also sync list panel selection
        document.querySelectorAll('.agent-list-item').forEach(el => el.classList.remove('agent-list-item--selected'));
        const listItem = document.querySelector(`.agent-list-item[data-agent-id="${agentId}"]`);
        if (listItem) {
          listItem.classList.add('agent-list-item--selected');
        }

        openAgentWithFeedback(agentId, agentName, metadata);
      }
    });
  });

  // Add click handlers for dock group items
  dockCarousel.querySelectorAll('.dock-group[data-group-id]').forEach(groupEl => {
    groupEl.addEventListener('click', () => {
      const groupId = groupEl.getAttribute('data-group-id');
      if (groupId) enterGroupView(groupId);
    });
  });

  // Back button in dock (group view)
  dockCarousel.querySelectorAll('.dock-group[data-action="exit-group"]').forEach(el => {
    el.addEventListener('click', exitGroupView);
  });
}

/**
 * Update the position indicator dots
 */
function updateDockPositionIndicator() {
  const indicator = document.getElementById('dockPositionIndicator');
  if (!indicator || dockSortedAgents.length === 0) return;

  // Only show dots if we have more agents than visible count
  if (dockSortedAgents.length <= DOCK_VISIBLE_COUNT) {
    indicator.innerHTML = '';
    return;
  }

  let html = '';
  dockSortedAgents.forEach((agent, index) => {
    const isActive = index === dockCenterIndex;
    let priorityClass = '';

    if (agent.lastMessagePriority === 'high' || agent.highestPriority === 'high') {
      priorityClass = 'dock-position-dot--urgent';
    } else if (agent.lastMessagePriority === 'normal' || agent.unreadCount > 0) {
      priorityClass = 'dock-position-dot--attention';
    }

    html += `<div class="dock-position-dot ${priorityClass} ${isActive ? 'dock-position-dot--active' : ''}"></div>`;
  });

  indicator.innerHTML = html;
}


/**
 * Scroll the dock to show a specific agent using native scrollIntoView
 */
function scrollDockToAgent(agentId, behavior = 'smooth') {
  if (!agentId) return;

  const dockCarousel = document.getElementById('dockCarousel');
  if (!dockCarousel) return;

  const agentElement = dockCarousel.querySelector(`.dock-agent[data-agent-id="${agentId}"]`);
  if (agentElement) {
    agentElement.scrollIntoView({
      behavior,
      block: 'nearest',
      inline: 'center'
    });
  }
}

// Keep legacy function for backwards compatibility
function syncDockToSelectedAgent(agentId) {
  scrollDockToAgent(agentId);
}

/**
 * ============================================
 * Archive Feature
 * ============================================
 */

let pendingArchive = null; // { agentId, archivedAgentId, timeout }

/**
 * Setup archive feature event listeners
 */
function setupArchiveButtons() {
  const archiveAgentBtn = document.getElementById('archiveAgentBtn');
  const floatingArchiveAgentBtn = document.getElementById('floatingArchiveAgentBtn');
  const contextMenu = document.getElementById('agentContextMenu');
  const archiveCancelBtn = document.getElementById('archiveCancelBtn');
  const archiveConfirmBtn = document.getElementById('archiveConfirmBtn');
  const archiveModal = document.getElementById('archiveConfirmationModal');

  // Archive button in header context menu
  if (archiveAgentBtn) {
    archiveAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      showArchiveConfirmationModal(selectedAgentId, selectedAgentName);
      if (contextMenu) {
        contextMenu.classList.add('hidden');
      }
    });
  }

  // Archive button in floating menu
  if (floatingArchiveAgentBtn) {
    floatingArchiveAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      showArchiveConfirmationModal(selectedAgentId, selectedAgentName);
      hideFloatingAgentMenu();
    });
  }

  // Modal cancel button
  if (archiveCancelBtn) {
    archiveCancelBtn.addEventListener('click', () => {
      hideArchiveConfirmationModal();
    });
  }

  // Modal confirm button
  if (archiveConfirmBtn) {
    archiveConfirmBtn.addEventListener('click', async () => {
      const agentId = archiveModal?.dataset?.agentId;
      const agentName = archiveModal?.dataset?.agentName || selectedAgentName;
      const reason = document.getElementById('archiveReasonInput')?.value?.trim() || null;

      if (!agentId) {
        showErrorMessage('Invalid agent selection');
        return;
      }

      hideArchiveConfirmationModal();
      await archiveAgent(agentId, agentName, reason);
    });
  }

  // Close modal on backdrop click
  if (archiveModal) {
    archiveModal.addEventListener('click', (e) => {
      if (e.target === archiveModal) {
        hideArchiveConfirmationModal();
      }
    });
  }

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && archiveModal && !archiveModal.classList.contains('hidden')) {
      hideArchiveConfirmationModal();
    }
  });
}

/**
 * Show archive confirmation modal
 */
function showArchiveConfirmationModal(agentId, agentName) {
  const modal = document.getElementById('archiveConfirmationModal');
  const modalLabel = document.getElementById('archiveModalAgentNameLabel');
  const reasonInput = document.getElementById('archiveReasonInput');

  if (!modal) return;

  // Set agent info in dataset and label
  modal.dataset.agentId = agentId;
  modal.dataset.agentName = agentName;

  setConfirmationModalAgentNameLabel(modalLabel, 'Archive', agentName);

  // Clear reason input
  if (reasonInput) {
    reasonInput.value = '';
  }

  // Show modal
  modal.classList.remove('hidden');

  // Focus reason input after modal appears
  setTimeout(() => {
    reasonInput?.focus();
  }, 100);
}

/**
 * Hide archive confirmation modal
 */
function hideArchiveConfirmationModal() {
  const modal = document.getElementById('archiveConfirmationModal');
  if (modal) {
    modal.classList.add('hidden');
    delete modal.dataset.agentId;
    delete modal.dataset.agentName;
  }
}

/**
 * Archive an agent
 */
async function archiveAgent(agentId, agentName, reason = null) {
  try {
    // Make API call
    const response = await csrfFetch(`/api/user/agents/${agentId}/archive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({ reason })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.error?.code;

      if (errorCode === 'AGENT_NOT_FOUND') {
        throw new Error('Agent not found');
      } else if (errorCode === 'AGENT_ALREADY_ARCHIVED') {
        throw new Error('Agent is already archived');
      }
      throw new Error(errorData.error?.message || 'Failed to archive agent');
    }

    const data = await response.json();

    // Store undo information
    pendingArchive = {
      agentId: agentId,
      agentName: agentName,
      archivedAgentId: data.archivedAgentId,
      messageCount: data.messageCount || 0,
      timeout: null
    };

    // Remove agent from UI immediately
    removeAgentFromUI(agentId);

    // Show success toast with undo option
    showArchiveSuccessToast(agentName, data.messageCount || 0);

    // Set timeout to clear undo option after 10 seconds
    pendingArchive.timeout = setTimeout(() => {
      pendingArchive = null;
    }, 10000);

  } catch (error) {
    console.error('Error archiving agent:', error);
    showErrorMessage(error.message || 'Failed to archive agent. Please try again.');
  }
}

/**
 * Unarchive (restore) an agent - used for undo
 */
async function unarchiveAgent(agentId, agentName) {
  try {
    // Make API call
    const response = await csrfFetch(`/api/user/agents/${agentId}/archive`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to restore agent');
    }

    // Force refresh agent list
    await pollAgentList(true);

    // Show success message
    showSuccessToast(`${agentName} restored successfully`);

  } catch (error) {
    console.error('Error unarchiving agent:', error);
    showErrorMessage(error.message || 'Failed to restore agent. Please try again.');
  }
}

/**
 * Remove agent from UI with animation
 */
function removeAgentFromUI(agentId) {
  // Remove from agent seats (circular view)
  const agentSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
  if (agentSeat) {
    agentSeat.style.transition = 'opacity 0.3s, transform 0.3s';
    agentSeat.style.opacity = '0';
    agentSeat.style.transform = 'scale(0.8)';
    setTimeout(() => {
      agentSeat.remove();
    }, 300);
  }

  // Remove from agent list panel
  const listItem = document.querySelector(`.agent-list-item[data-agent-id="${agentId}"]`);
  if (listItem) {
    listItem.style.transition = 'opacity 0.3s, transform 0.3s';
    listItem.style.opacity = '0';
    listItem.style.transform = 'translateX(-20px)';
    setTimeout(() => {
      listItem.remove();
    }, 300);
  }

  // Remove from mobile dock
  const dockItem = document.querySelector(`.mobile-dock-item[data-agent-id="${agentId}"]`);
  if (dockItem) {
    dockItem.style.transition = 'opacity 0.3s';
    dockItem.style.opacity = '0';
    setTimeout(() => {
      dockItem.remove();
    }, 300);
  }

  // If this was the selected agent, clear the conversation
  if (selectedAgentId === agentId) {
    selectedAgentId = null;
    selectedAgentName = '';

    const agentPanelHeader = document.getElementById('agentPanelHeader');
    const agentPanelPlaceholder = document.getElementById('agentPanelPlaceholder');
    const conversationArea = document.getElementById('conversationArea');
    const messageInputArea = document.getElementById('messageInputArea');

    if (agentPanelHeader) agentPanelHeader.classList.add('hidden');
    document.getElementById('agentContextMenu')?.classList.add('hidden');
    if (agentPanelPlaceholder) agentPanelPlaceholder?.classList.remove('hidden');
    if (conversationArea) conversationArea.classList.add('hidden');
    if (messageInputArea) messageInputArea.classList.add('hidden');

    // Unmark body so mobile CSS stops forcing input visible
    delete document.body.dataset.agentSelected;

    // Clean up state
    lastMessageTimestamp = null;
    lastMessageCursor = null;
    stopMessagePolling();
  }

  // Update cache
  currentAgentList = currentAgentList.filter(a => a.agentId !== agentId);
  agentListCache.agents = currentAgentList;

  // Remove from known agent IDs to prevent re-animation
  knownAgentIds.delete(agentId);
}

/**
 * Show archive success toast with undo button
 */
function showArchiveSuccessToast(agentName, messageCount) {
  window.notifications.show(
    `Agent "${agentName}" archived (${messageCount} messages saved)`,
    'warning', // Use warning color (amber) for archive
    'Archived',
    10000, // 10 seconds
    {
      label: 'Undo',
      onClick: async () => {
        try {
          const response = await csrfFetch('/api/user/agents/unarchive', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': window.csrfToken
            },
            body: JSON.stringify({ agentName })
          });

          if (response.ok) {
            window.showSuccess(`${agentName} restored successfully`);
            // Refresh lists
            pollAgentList(true);
          } else {
            const data = await response.json();
            window.showError(data.error?.message || 'Failed to restore agent');
          }
        } catch (err) {
          console.error('Error restoring agent:', err);
          window.showError('Failed to restore agent');
        }
      }
    }
  );
}

/**
 * Show success toast notification
 */
function showSuccessToast(message) {
  window.showSuccess(message);
}

function lastChatStorageKey() {
  const userId = document.getElementById('dashboardRoot')?.dataset.userId;
  return userId ? `${LAST_AGENT_STORAGE_KEY}:${userId}` : null;
}

function rememberLastChat(agentId, context) {
  const conversationId = context?.mode === 'shared' ? context.conversationId : null;
  try {
    const key = lastChatStorageKey();
    if (key && agentId !== '__ALL__') {
      // Store identifiers only. Access and current membership are checked again on restore.
      localStorage.setItem(key, JSON.stringify({ agentId, conversationId }));
    }
  } catch (_) { /* Storage restrictions must not prevent opening a chat. */ }
  try {
    const url = new URL(window.location.href);
    if (conversationId) url.searchParams.set('conversationId', conversationId);
    else url.searchParams.delete('conversationId');
    url.searchParams.delete('invitationId');
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, '', url.href);
    }
  } catch (_) { /* The selected chat still works when browser history is unavailable. */ }
}

/** Restore the last private or shared chat without overriding a new selection or direct link. */
function setupLastAgentRestoration() {
  const signalReady = () => {
    dashboardAgentRestorationReady = true;
    signalDashboardReadyWhenInitialized();
  };
  if (EMBEDDED_PREVIEW_MODE) {
    signalReady();
    return;
  }

  // Only attempt restoration once per session
  if (lastAgentRestorationAttempted) {
    return;
  }
  lastAgentRestorationAttempted = true;

  // Explicit conversation and invitation links take precedence over local memory.
  const params = new URLSearchParams(window.location.search);
  if (params.has('conversationId') || params.has('invitationId')) {
    signalReady();
    return;
  }

  const selectionAtStart = sharedChatSelectionRequest;
  let saved;
  try {
    const key = lastChatStorageKey();
    const value = key && localStorage.getItem(key);
    saved = value ? JSON.parse(value) : { agentId: localStorage.getItem(LAST_AGENT_STORAGE_KEY) };
  } catch (_) { signalReady(); return; }
  const lastAgentId = saved?.agentId;

  if (!lastAgentId) {
    // No last agent saved, nothing to restore
    signalReady();
    return;
  }
  if (lastAgentId === '__ALL__') {
    localStorage.removeItem(LAST_AGENT_STORAGE_KEY);
    signalReady();
    return;
  }

  if (saved.conversationId && window.InPlaceChat && window.DashboardHelpers?.selectChatContext) {
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch('/api/user/chat-threads/' + encodeURIComponent(saved.conversationId), {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal
        });
        if (!response.ok) return;
        const context = await response.json();
        if (sharedChatSelectionRequest !== selectionAtStart) return;
        await window.DashboardHelpers.selectChatContext(context);
      } catch (_) { /* Leave the picker usable when offline or access was removed. */ }
      finally { clearTimeout(timeout); signalReady(); }
    })();
    return;
  }

  // Poll for agent list to be available (up to 10 attempts with 500ms delay = 5 seconds max)
  let pollAttempts = 0;
  const maxPollAttempts = 10;

  const restoreInterval = setInterval(() => {
    pollAttempts++;
    if (sharedChatSelectionRequest !== selectionAtStart) {
      clearInterval(restoreInterval);
      signalReady();
      return;
    }

    // Check if we have agents available
    if (currentAgentList && currentAgentList.length > 0) {
      clearInterval(restoreInterval);

      // Check if the last agent still exists
      const lastAgent = currentAgentList.find(a => a.agentId === lastAgentId);

      if (lastAgent) {
        // Auto-select the last agent
        Promise.resolve(selectAgent(lastAgentId, lastAgent.agentName || lastAgent.name, {
          agentType: lastAgent.agentType || 'standard',
          externalProvider: lastAgent.externalProvider || '',
          forceMainSelection: true
        })).catch(() => {}).finally(signalReady);
      } else {
        signalReady();
      }
      // If agent was deleted, just skip restoration (user will see empty state)
      return;
    }

    // Stop polling after max attempts
    if (pollAttempts >= maxPollAttempts) {
      clearInterval(restoreInterval);
      signalReady();
    }
  }, 500);
}

/**
 * ============================================
 * Main Interactive Space
 * ============================================
 */

function setupMainInteractiveSpace() {
  const toggle = document.getElementById('mainInteractiveToggle');
  const sizeBtn = document.getElementById('mainInteractiveSizeBtn');
  const content = document.getElementById('mainInteractiveContent');
  const chevron = document.getElementById('mainInteractiveChevron');
  const interactiveTitle = document.getElementById('mainInteractiveTitle');

  if (!toggle || !content || !chevron) return;

  const setSizeButtonState = (popupOpen) => {
    if (!sizeBtn) return;
    if (popupOpen) {
      sizeBtn.classList.remove('text-slate-400');
      sizeBtn.classList.add('text-emerald-400');
      sizeBtn.title = 'Close expanded view';
      sizeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 14h-4m0 0v4m0-4l5-5m11 5h4m0 0v4m0-4l-5-5M4 10h-4m0 0v-4m0 4l5 5m11-5h4m0 0v-4m0 4l-5 5" /></svg>';
    } else {
      sizeBtn.classList.remove('text-emerald-400');
      sizeBtn.classList.add('text-slate-400');
      sizeBtn.title = 'Expand';
      sizeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>';
    }
  };

  toggle.addEventListener('click', () => {
    const isHidden = content.classList.contains('hidden');
    if (isHidden) {
      setMainInteractiveContentVisibility(true);
    } else {
      setMainInteractiveContentVisibility(false);
      if (window.RichRendering?.closeInteractiveContentPopupFor) {
        const wasClosed = window.RichRendering.closeInteractiveContentPopupFor(content);
        if (wasClosed) setSizeButtonState(false);
      }
    }
  });

  if (sizeBtn) {
    sizeBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent toggle from firing
      if (!window.RichRendering?.toggleInteractiveContentPopup) return;

      const popupOpen = window.RichRendering.toggleInteractiveContentPopup({
        sourceContentEl: content,
        title: interactiveTitle?.textContent?.trim() || 'Agent Space',
        onStateChange: setSizeButtonState
      });
      setSizeButtonState(popupOpen);
    });
  }

  // Rich history navigation buttons
  const prevBtn = document.getElementById('richHistoryPrev');
  const nextBtn = document.getElementById('richHistoryNext');
  const downloadBtn = document.getElementById('richHistoryDownload');

  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateRichHistory(-1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateRichHistory(1);
    });
  }
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadCurrentRichMessage();
    });
  }
}

function setMainInteractiveContentVisibility(isVisible, options = {}) {
  const interactiveContent = document.getElementById('mainInteractiveContent');
  const interactiveChevron = document.getElementById('mainInteractiveChevron');
  if (!interactiveContent) return;

  const shouldPersist = options.persistState !== false;
  const isOpen = Boolean(isVisible);

  if (isOpen) {
    interactiveContent.classList.remove('hidden');
    if (interactiveChevron) interactiveChevron.classList.add('rotate-180');
  } else {
    interactiveContent.classList.add('hidden');
    if (interactiveChevron) interactiveChevron.classList.remove('rotate-180');
  }

  if (shouldPersist && selectedAgentId) {
    setInteractivePanelState(selectedAgentId, isOpen);
  }
}

function collapseMainInteractiveSpaceForMobileFocus() {
  // Fast Mode also runs on touch-landscape shells wider than the list-only
  // breakpoint, so check it explicitly — otherwise an expanded Agent Space
  // would stay open behind the on-screen keyboard and crush the conversation.
  if ((!isMobileListOnlyMode() && !isDashboardFastModeActive()) || !selectedAgentId) return;

  const interactiveContent = document.getElementById('mainInteractiveContent');
  if (!interactiveContent || interactiveContent.classList.contains('hidden')) return;

  if (window.RichRendering?.closeInteractiveContentPopupFor) {
    window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
  }
  setMainInteractiveContentVisibility(false);
}

function resetMainInteractiveSpace() {
  const interactiveTitle = document.getElementById('mainInteractiveTitle');
  const interactiveContent = document.getElementById('mainInteractiveContent');
  const interactiveSizeBtn = document.getElementById('mainInteractiveSizeBtn');
  if (!interactiveContent) return;

  if (window.RichRendering?.closeInteractiveContentPopupFor) {
    window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
  }

  if (interactiveTitle) {
    interactiveTitle.textContent = 'Agent Space';
  }

  // Hide history controls when resetting
  updateRichHistoryControls(0, 0);

  interactiveContent.innerHTML = `
    <div id="mainInteractivePlaceholder" class="flex flex-col items-center justify-center gap-2 py-5 text-slate-500">
      <svg class="w-6 h-6 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
      <span class="text-[10px] text-center leading-relaxed">No interactive content yet.<br>This agent can send interactive content here.</span>
    </div>`;
  const shouldBeOpen = selectedAgentId ? getInteractivePanelState(selectedAgentId) : false;
  setMainInteractiveContentVisibility(shouldBeOpen, { persistState: false });

  if (interactiveSizeBtn) {
    interactiveSizeBtn.classList.remove('text-emerald-400');
    interactiveSizeBtn.classList.add('text-slate-400');
    interactiveSizeBtn.title = 'Expand';
    interactiveSizeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>';
  }
}

function updateMainInteractiveSpace() {
  const interactiveContent = document.getElementById('mainInteractiveContent');

  if (!interactiveContent || !selectedAgentId || !window.RichRendering) return;
  if (selectedChatContext?.mode === 'shared') {
    resetMainInteractiveSpace();
    return;
  }

  const cache = conversationCache.get(selectedAgentId) || [];

  // Collect ALL rich messages in order (oldest first)
  const allRichMessages = [];
  for (let i = 0; i < cache.length; i++) {
    const m = cache[i];
    if (m.isEncryptedPlaceholder) continue;
    const text = m.content || '';
    const richData = window.RichRendering.detectRichContent(text);
    if (richData) {
      allRichMessages.push(richData);
    }
  }

  if (allRichMessages.length > 0) {
    // Update the history for this agent
    const existing = richMessageHistory.get(selectedAgentId);
    const persistedCount = getInteractiveRichMessageCount(selectedAgentId);
    const prevCount = existing
      ? existing.messages.length
      : (typeof persistedCount === 'number' ? persistedCount : allRichMessages.length);
    const wasAtNewest = !existing || existing.currentIndex === prevCount - 1;
    const hasNewRichMessage = allRichMessages.length > prevCount;

    // Default to newest message, but preserve position if user was browsing
    let newIndex;
    if (wasAtNewest || !existing) {
      newIndex = allRichMessages.length - 1;
    } else {
      // Keep current index, clamped to valid range
      newIndex = Math.min(existing.currentIndex, allRichMessages.length - 1);
    }

    richMessageHistory.set(selectedAgentId, {
      messages: allRichMessages,
      currentIndex: newIndex
    });
    setInteractiveRichMessageCount(selectedAgentId, allRichMessages.length);

    if (hasNewRichMessage) {
      setInteractivePanelState(selectedAgentId, true);
    }

    renderCurrentRichMessage();
  } else {
    richMessageHistory.delete(selectedAgentId);
    setInteractiveRichMessageCount(selectedAgentId, 0);
    updateRichHistoryControls(0, 0);
    resetMainInteractiveSpace();
  }
}

/**
 * Render the rich message at the current index for the selected agent.
 */
function renderCurrentRichMessage() {
  const interactiveContent = document.getElementById('mainInteractiveContent');
  const interactiveTitle = document.getElementById('mainInteractiveTitle');
  if (!interactiveContent || !selectedAgentId) return;

  const history = richMessageHistory.get(selectedAgentId);
  if (!history || history.messages.length === 0) {
    updateRichHistoryControls(0, 0);
    resetMainInteractiveSpace();
    return;
  }

  const richData = history.messages[history.currentIndex];

  if (window.RichRendering?.closeInteractiveContentPopupFor) {
    window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
  }
  if (interactiveTitle) {
    interactiveTitle.textContent = richData.title || richData.badge || 'Agent Space';
  }
  interactiveContent.innerHTML = '';
  const el = window.RichRendering.renderRichContent(richData, window.RichRendering.sendFormResponse);
  interactiveContent.appendChild(el);

  const shouldBeOpen = getInteractivePanelState(selectedAgentId);
  setMainInteractiveContentVisibility(shouldBeOpen, { persistState: false });

  updateRichHistoryControls(history.currentIndex + 1, history.messages.length);
}

/**
 * Navigate rich message history for the current agent.
 * @param {number} direction - -1 for previous, +1 for next
 */
function navigateRichHistory(direction) {
  if (!selectedAgentId) return;
  const history = richMessageHistory.get(selectedAgentId);
  if (!history || history.messages.length <= 1) return;

  const newIndex = history.currentIndex + direction;
  if (newIndex < 0 || newIndex >= history.messages.length) return;

  history.currentIndex = newIndex;
  renderCurrentRichMessage();
}

/**
 * Update the visibility and state of the rich history navigation controls.
 * @param {number} current - 1-based current index (0 means no messages)
 * @param {number} total - total number of rich messages
 */
function updateRichHistoryControls(current, total) {
  const controls = document.getElementById('richHistoryControls');
  const counter = document.getElementById('richHistoryCounter');
  const prevBtn = document.getElementById('richHistoryPrev');
  const nextBtn = document.getElementById('richHistoryNext');

  if (!controls) return;

  if (total <= 0) {
    controls.classList.add('hidden');
    return;
  }

  controls.classList.remove('hidden');
  if (counter) counter.textContent = `${current} / ${total}`;
  if (prevBtn) prevBtn.disabled = current <= 1;
  if (nextBtn) nextBtn.disabled = current >= total;
}

/**
 * Download the currently displayed rich HTML message as a standalone HTML file.
 */
function downloadCurrentRichMessage() {
  if (!selectedAgentId) return;
  const history = richMessageHistory.get(selectedAgentId);
  if (!history || history.messages.length === 0) return;

  const richData = history.messages[history.currentIndex];
  const title = richData.title || 'Rich Content';
  const description = richData.description || '';
  const css = (richData.css && typeof richData.css === 'string') ? richData.css : '';
  const html = richData.html || '';

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #0f172a; color: #e2e8f0; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .description { color: #94a3b8; margin-bottom: 1rem; }
    ${css}
  </style>
</head>
<body>
  <div class="container">
    <h1>${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
    ${description ? '<p class="description">' + description.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : ''}
    <div class="content">
      ${html}
    </div>
  </div>
</body>
</html>`;

  // Sanitize filename
  const agentName = (selectedAgentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${agentName}-${safeTitle}-${dateStr}.html`;

  const blob = new Blob([fullHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * ============================================
 * Clear Conversation Modal
 * ============================================
 */

function setupClearConversationModal() {
  const modal = document.getElementById('clearConversationModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('clearCancelBtn');
  const confirmBtn = document.getElementById('clearConfirmBtn');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideClearConversationModal();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const agentId = modal?.dataset?.agentId;
      const agentName = modal?.dataset?.agentName || selectedAgentName;

      if (!agentId) {
        showErrorMessage('Invalid agent selection');
        return;
      }

      hideClearConversationModal();
      await executeClearConversation(agentId, agentName);
    });
  }

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideClearConversationModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideClearConversationModal();
    }
  });
}

function showClearConversationModal(agentId, agentName) {
  const modal = document.getElementById('clearConversationModal');
  const modalLabel = document.getElementById('clearModalAgentNameLabel');

  if (!modal) {
    // Fallback to confirm() for pages without the modal
    const confirmed = confirm(
      `Are you sure you want to clear the conversation with "${agentName}"?\n\n` +
      `This will permanently remove ALL messages but keep the agent. ` +
      `This action cannot be undone.`
    );
    if (confirmed) {
      executeClearConversation(agentId, agentName);
    }
    return;
  }

  modal.dataset.agentId = agentId;
  modal.dataset.agentName = agentName;

  setConfirmationModalAgentNameLabel(modalLabel, 'Clear conversation with', agentName);

  modal.classList.remove('hidden');

  // Focus confirm button after modal appears
  setTimeout(() => {
    const confirmBtn = document.getElementById('clearConfirmBtn');
    confirmBtn?.focus();
  }, 100);
}

function hideClearConversationModal() {
  const modal = document.getElementById('clearConversationModal');
  if (modal) {
    modal.classList.add('hidden');
    delete modal.dataset.agentId;
    delete modal.dataset.agentName;
  }
}

/**
 * ============================================
 * Hide All Messages Modal
 * ============================================
 */

function setupHideMessagesModal() {
  const modal = document.getElementById('hideMessagesModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('hideCancelBtn');
  const confirmBtn = document.getElementById('hideConfirmBtn');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideHideMessagesModal();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const agentId = modal?.dataset?.agentId;
      const agentName = modal?.dataset?.agentName || selectedAgentName;

      if (!agentId) {
        showErrorMessage('Invalid agent selection');
        return;
      }

      hideHideMessagesModal();
      await executeHideAllMessages(agentId, agentName);
    });
  }

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideHideMessagesModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideHideMessagesModal();
    }
  });
}

function showHideMessagesModal(agentId, agentName) {
  const modal = document.getElementById('hideMessagesModal');
  const modalLabel = document.getElementById('hideModalAgentNameLabel');

  if (!modal) {
    // Fallback to confirm() for pages without the modal
    const confirmed = confirm(
      `Hide all messages from "${agentName}"'s context?\n\n` +
      `All existing messages will be hidden from the agent's context. ` +
      `The agent will start responding as if it's a fresh conversation.`
    );
    if (confirmed) {
      executeHideAllMessages(agentId, agentName);
    }
    return;
  }

  modal.dataset.agentId = agentId;
  modal.dataset.agentName = agentName;

  setConfirmationModalAgentNameLabel(modalLabel, 'Hide all messages for', agentName);

  modal.classList.remove('hidden');

  // Focus confirm button after modal appears
  setTimeout(() => {
    const confirmBtn = document.getElementById('hideConfirmBtn');
    confirmBtn?.focus();
  }, 100);
}

function hideHideMessagesModal() {
  const modal = document.getElementById('hideMessagesModal');
  if (modal) {
    modal.classList.add('hidden');
    delete modal.dataset.agentId;
    delete modal.dataset.agentName;
  }
}

/**
 * Hide all messages for an agent from the agent's context
 */
async function hideAllMessages() {
  if (!selectedAgentId) {
    showErrorMessage('No agent selected');
    return;
  }

  const agentNameEl = document.getElementById('selectedAgentName');
  const agentName = agentNameEl ? agentNameEl.textContent : 'this agent';

  showHideMessagesModal(selectedAgentId, agentName);
}

/**
 * Execute the actual hide all messages after modal confirmation
 */
async function executeHideAllMessages(agentId, agentName) {
  try {
    const response = await csrfFetch(`/api/user/agents/${agentId}/messages/hidden`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({ hidden: true })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to hide messages');
    }

    const data = await response.json();

    // Update UI to show messages as hidden
    const conversationArea = document.getElementById('conversationArea');
    if (conversationArea) {
      const messages = conversationArea.querySelectorAll('[data-message-id]');
      messages.forEach(msgEl => {
        // Add visual indicator that message is hidden from agent
        msgEl.classList.add('message-hidden-from-agent');
        // Update eye icon if present
        const eyeBtn = msgEl.querySelector('.hide-from-agent-btn');
        if (eyeBtn) {
          eyeBtn.setAttribute('data-hidden', 'true');
          // Update icon
          const openEye = eyeBtn.querySelector('.eye-open');
          const slashedEye = eyeBtn.querySelector('.eye-slashed');
          if (openEye) openEye.classList.add('hidden');
          if (slashedEye) slashedEye.classList.remove('hidden');
        }
      });
    }

    // Show success message
    window.showSuccess?.(`${data.updatedCount} messages hidden from agent context`) ||
      console.log(`${data.updatedCount} messages hidden from agent context`);

  } catch (error) {
    console.error('Error hiding messages:', error);
    showErrorMessage(error.message || 'Failed to hide messages. Please try again.');
  }
}

// ─── Expose shared helpers for multi-chat.js ──────────────────────────────
window.DashboardHelpers = {
  updateMessageReceipts,
  buildUserMessageReadIndicator,
  applyUserMessageDeliveryState,
  chatHistoryBusy: () => isLoadingMessages || isLoadingOlderMessages || conversationRendersInFlight > 0 || Date.now() < forceScrollToBottomUntil,
  sharedHistoryLoading: (loading) => {
    isLoadingOlderMessages = loading;
    const notice = document.getElementById('chatHistoryStatus');
    if (notice) {
      if (loading) notice.textContent = 'Loading earlier messages…';
      notice.hidden = !loading && notice.textContent === 'Loading earlier messages…';
    }
    document.getElementById('conversationArea')?.setAttribute('aria-busy', String(loading));
  },
  sharedHistoryError: (text) => {
    const notice = document.getElementById('chatHistoryStatus');
    if (notice) { notice.textContent = text; notice.hidden = !text; }
  },
  prependSharedHistory: async (context, messages) => {
    if (selectedChatContext?.conversationId !== context.conversationId) return;
    conversationCache.set(context.conversationId, messages);
    await displayMessages(messages, false, { agentId: context.agentId, conversationId: context.conversationId,
      requestToken: activeConversationLoadToken, preserveScrollPosition: true });
  },
  ownerHistoryStatus: (conversationId, text, failed = false) => {
    if (conversationId && selectedChatContext?.conversationId !== conversationId) return;
    const notice = document.getElementById('ownerHistoryNotice');
    if (!notice) return;
    notice.hidden = !text;
    document.getElementById('ownerHistoryNoticeText').textContent = text;
    document.getElementById('ownerHistoryRetry').hidden = !failed;
  },
  ownerHistoryUpdated: (conversationId, messages) => {
    if (selectedChatContext?.conversationId !== conversationId) return;
    conversationCache.set(conversationId, messages);
    void displayMessages(messages, false, { agentId: selectedAgentId, conversationId, requestToken: activeConversationLoadToken,
      ...liveRefreshScrollOptions(selectedAgentId) });
  },
  hideAgentActionsMenu: () => hideFloatingAgentMenu(),
  loadAgentActionStats: (agentId, target) => refreshAgentActionStats(agentId, {}, { force: true, targetMenus: [target] }),
  getSelectedAgentForActions: () => selectedAgentId && selectedAgentId !== '__ALL__' ? {
    agentId: selectedAgentId, agentName: selectedAgentName, agentType: selectedAgentType
  } : null,
  escapeHtml: (text) => escapeHtml(text),
  renderMarkdown: (text) => renderMessageMarkdown(text),
  formatTimestamp: (ts) => formatTimestamp(ts),
  formatRelativeTime: (ts) => formatRelativeTime(ts),
  looksLikeEncrypted: (text) => looksLikeEncryptedText(text),
  getEncryptionKey: () => encryptionKey,
  unlockEncryption: () => showDecryptionPasswordModal(),
  readErrorPayload: (response) => readErrorPayload(response),
  buildRequestError: (response, errorData = {}, options = {}) => buildRequestError(response, errorData, options),
  notifyRateLimit: (error, options = {}) => notifyRateLimit(error, options),
  getServerPollDelayMs: (response, data, fallback) => getServerPollDelayMs(response, data, fallback),
  openAgentActionsMenu: (agentId, agentName, metadata = {}, anchorEl = null) =>
    selectedChatContext?.mode === 'shared' && selectedChatContext.role !== 'owner'
      ? undefined
      : openFloatingAgentMenuForAgent(agentId, agentName, metadata, anchorEl),
  getSelectedChatContext: () => selectedChatContext,
  getChatSelectionVersion: () => sharedChatSelectionRequest,
  refreshSelectedChatContext: (context, details) => {
    if (context?.mode === 'shared' && context.conversationId === selectedChatContext?.conversationId) {
      selectedChatContext = context;
      updateComposerState();
      if (details) updateSharedChatControl(context, details);
    }
  },
  getSelectedAgentIdentity: () => selectedAgentId && selectedAgentId !== '__ALL__' ? {
    agentId: selectedAgentId, agentName: selectedAgentName, agentType: selectedAgentType,
    conversationId: selectedChatContext?.conversationId || null, mode: selectedChatContext?.mode || 'private',
    role: selectedChatContext?.role || 'owner', privateHistory: Boolean(selectedChatContext?.privateHistory),
    privateHistoryConversationId: selectedChatContext?.privateHistoryConversationId || null
  } : null,
  selectChatContext: async (context) => {
    if (!context || !context.conversationId || !context.agentId || !['private', 'shared'].includes(context.mode)) {
      throw new Error('A conversation context is required.');
    }
    if (context.mode === 'private') {
      if (context.role !== 'owner') throw new Error('Only the owner can open a private agent chat.');
      await selectAgent(context.agentId, context.agentName || 'Agent', { forceMainSelection: true, skipSharedResolve: true,
        ...(context.privateHistory || context.state === 'preparing' ? { chatContext: context } : {}) });
      return;
    }
    selectedChatContext = context;
    window.InPlaceChat?.setContext(context);
    if (context.role !== 'owner') document.getElementById('floatingAgentMenu')?.classList.add('hidden');
    await selectAgent(context.agentId, context.agentName || 'Agent', {
      forceMainSelection: true,
      chatContext: context,
      agentType: 'shared'
    });
    try {
      const detailsResponse = await fetch('/api/user/shared/' + encodeURIComponent(context.conversationId), { credentials: 'same-origin', cache: 'no-store' });
      if (detailsResponse.ok && selectedChatContext?.conversationId === context.conversationId) {
        const details = await detailsResponse.json();
        updateSharedChatControl(context, details);
      }
    } catch (_) { /* The sharing control remains available while the count is loading. */ }
  },
};

// Expose TTS helpers for multi-chat tiles
window.speakMessageText = speakMessageText;
window.stopActiveMessagePlayback = stopActiveMessagePlayback;

/**
 * Setup council minimize/maximize toggle (desktop only)
 */
function setupCouncilMinimize() {
  const minimizeBtn = document.getElementById('minimizeCouncilBtn');
  const maximizeBtn = document.getElementById('maximizeCouncilBtn');
  const dashboardGrid = document.querySelector('.dashboard-main-grid');

  if (!minimizeBtn || !maximizeBtn || !dashboardGrid) return;

  // Restore state from localStorage
  const isMinimized = localStorage.getItem('council_minimized') === 'true';
  if (isMinimized && !isMobileListOnlyMode()) {
    dashboardGrid.classList.add('council-minimized');
  }

  minimizeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dashboardGrid.classList.add('council-minimized');
    localStorage.setItem('council_minimized', 'true');
    // Trigger resize to fix any layout issues
    window.dispatchEvent(new Event('resize'));
  });

  maximizeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dashboardGrid.classList.remove('council-minimized');
    localStorage.setItem('council_minimized', 'false');
    // Trigger resize
    window.dispatchEvent(new Event('resize'));
  });
}

function setupCouncilResizeHandle() {
  const dashboardGrid = document.querySelector('.dashboard-main-grid');
  const councilPanel = dashboardGrid?.querySelector('.council-chamber');
  const chatContainer = document.getElementById('multiChatContainer');
  const resizeHandle = document.getElementById('councilResizeHandle');
  if (!dashboardGrid || !councilPanel || !chatContainer || !resizeHandle) return;

  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  const WIDTH_LIMITS = {
    single: { min: 380, max: 820, fallback: 470 },
    multi: { min: 330, max: 680, fallback: 375 }
  };

  const getModeLimits = () => dashboardGrid.classList.contains('dashboard-main-grid--multi-open')
    ? WIDTH_LIMITS.multi
    : WIDTH_LIMITS.single;

  const clampWidth = (value) => {
    const limits = getModeLimits();
    return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
  };

  const applyWidth = (value, { persist = true } = {}) => {
    const nextWidth = clampWidth(value);
    dashboardGrid.style.setProperty('--council-panel-width', `${nextWidth}px`);
    if (persist) {
      localStorage.setItem(COUNCIL_SPLIT_STORAGE_KEY, String(nextWidth));
    }
  };

  const restoreWidth = () => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) {
      dashboardGrid.style.removeProperty('--council-panel-width');
      return;
    }

    const storedValue = Number(localStorage.getItem(COUNCIL_SPLIT_STORAGE_KEY));
    if (Number.isFinite(storedValue) && storedValue > 0) {
      applyWidth(storedValue, { persist: false });
      return;
    }

    const limits = getModeLimits();
    const measuredWidth = Math.round(councilPanel.getBoundingClientRect().width || limits.fallback);
    applyWidth(measuredWidth || limits.fallback, { persist: false });
  };

  const toggleHandleVisibility = () => {
    const shouldShow = desktopQuery.matches && !dashboardGrid.classList.contains('council-minimized');
    resizeHandle.classList.toggle('hidden', !shouldShow);
    resizeHandle.classList.toggle('xl:flex', shouldShow);
    if (!shouldShow) {
      dashboardGrid.classList.remove('dashboard-main-grid--resizing');
    } else {
      restoreWidth();
    }
  };

  let activePointerId = null;
  let moveFrame = null;
  let pendingClientX = null;

  const finishResize = () => {
    if (activePointerId === null) return;
    const pointerId = activePointerId;
    if (moveFrame) {
      cancelAnimationFrame(moveFrame);
      moveFrame = null;
    }
    activePointerId = null;
    pendingClientX = null;
    dashboardGrid.classList.remove('dashboard-main-grid--resizing');
    try {
      if (pointerId !== null) {
        resizeHandle.releasePointerCapture?.(pointerId);
      }
    } catch (_) { }
    window.dispatchEvent(new Event('resize'));
  };

  const applyWidthFromPointer = (clientX) => {
    const gridRect = dashboardGrid.getBoundingClientRect();
    const panelRect = typeof councilPanel.getBoundingClientRect === 'function' ? councilPanel.getBoundingClientRect() : null;
    const originLeft = (panelRect && Number.isFinite(panelRect.left) && panelRect.left > 0) ? panelRect.left : gridRect.left;
    const desiredWidth = clientX - originLeft - (resizeHandle.offsetWidth / 2);
    // Allow a short drag beyond the minimum before snapping to the collapsed rail.
    if (desiredWidth < getModeLimits().min - 40) {
      dashboardGrid.classList.add('council-minimized');
      localStorage.setItem('council_minimized', 'true');
      toggleHandleVisibility();
      finishResize();
      document.getElementById('maximizeCouncilBtn')?.focus({ preventScroll: true });
      return;
    }
    const chatRect = chatContainer.getBoundingClientRect();
    const rightEdge = (chatRect && Number.isFinite(chatRect.right) && chatRect.right > originLeft) ? chatRect.right : gridRect.right;
    const maxAllowedByViewport = Math.max(getModeLimits().min, rightEdge - originLeft - 340);
    applyWidth(Math.min(desiredWidth, maxAllowedByViewport));
  };

  const queueWidthFromPointer = (clientX) => {
    pendingClientX = clientX;
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = null;
      if (activePointerId !== null) applyWidthFromPointer(pendingClientX);
    });
  };

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) return;
    activePointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(event.pointerId);
    dashboardGrid.classList.add('dashboard-main-grid--resizing');
    event.preventDefault();
  });

  resizeHandle.addEventListener('pointermove', (event) => {
    if (activePointerId !== event.pointerId) return;
    queueWidthFromPointer(event.clientX);
  });

  resizeHandle.addEventListener('pointerup', (event) => {
    if (activePointerId !== event.pointerId) return;
    // A quick drag can finish before the queued animation frame runs.
    applyWidthFromPointer(event.clientX);
    finishResize();
  });
  resizeHandle.addEventListener('pointercancel', finishResize);
  resizeHandle.addEventListener('lostpointercapture', finishResize);

  resizeHandle.addEventListener('keydown', (event) => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) return;
    const delta = event.shiftKey ? 40 : 20;
    const currentWidth = Number.parseFloat(getComputedStyle(dashboardGrid).getPropertyValue('--council-panel-width'))
      || councilPanel.getBoundingClientRect().width
      || getModeLimits().fallback;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      applyWidth(currentWidth - delta);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      applyWidth(currentWidth + delta);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyWidth(getModeLimits().min);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'End') {
      event.preventDefault();
      applyWidth(getModeLimits().max);
      window.dispatchEvent(new Event('resize'));
    }
  });

  toggleHandleVisibility();
  window.addEventListener('resize', toggleHandleVisibility);
  desktopQuery.addEventListener?.('change', toggleHandleVisibility);
  if (window.MultiChatManager && typeof window.MultiChatManager.onPanelsChanged === 'function') {
    window.MultiChatManager.onPanelsChanged(toggleHandleVisibility);
  } else {
    const multiObserver = new MutationObserver(toggleHandleVisibility);
    multiObserver.observe(chatContainer, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] });
  }
}

function setupCouncilListResizeHandle() {
  const dashboardGrid = document.querySelector('.dashboard-main-grid');
  const councilPanel = dashboardGrid?.querySelector('.council-chamber');
  const listSection = document.getElementById('councilListSection');
  const resizeHandle = document.getElementById('councilListResizeHandle');
  const orbitContainer = document.getElementById('councilCircle');
  if (!dashboardGrid || !councilPanel || !listSection || !resizeHandle) return;

  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  const HEIGHT_LIMITS = { min: 180, fallback: 300 };
  const ORBIT_COLLAPSE_BUFFER = 28;
  const ORBIT_CONTAINER_PADDING = 64;
  const ORBIT_MIN_SIZE = 120;
  const ORBIT_MAX_SIZE = 300;

  const getHeaderHeight = () => {
    if (!orbitContainer) return 0;
    const panelRect = councilPanel.getBoundingClientRect();
    const circleRect = orbitContainer.getBoundingClientRect();
    const headerHeight = circleRect.top - panelRect.top;
    if (!Number.isFinite(headerHeight)) return 0;
    return Math.max(0, Math.min(panelRect.height || 0, Math.round(headerHeight)));
  };

  const getHeightLimits = () => {
    const panelHeight = Math.round(councilPanel.getBoundingClientRect().height || 0);
    const headerHeight = getHeaderHeight();
    const handleHeight = Math.round(resizeHandle.getBoundingClientRect().height || 0);
    const dynamicMax = panelHeight > 0
      ? Math.max(0, panelHeight - headerHeight - handleHeight)
      : HEIGHT_LIMITS.fallback;
    const dynamicMin = panelHeight > 0 && panelHeight < 760 ? HEIGHT_LIMITS.min : 220;
    return {
      min: dynamicMin,
      fallback: HEIGHT_LIMITS.fallback,
      max: dynamicMax
    };
  };

  const clampHeight = (value) => {
    const limits = getHeightLimits();
    return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
  };

  const syncOrbitCollapseState = (height) => {
    const { max } = getHeightLimits();
    const shouldCollapse = height >= (max - ORBIT_COLLAPSE_BUFFER);
    councilPanel.classList.toggle('council-chamber--orbit-collapsed', shouldCollapse);
  };

  const computeOrbitSquash = (height) => {
    const { fallback, max } = getHeightLimits();
    const baseline = fallback;
    const clamped = clampHeight(height);
    if (clamped <= baseline) {
      return 1;
    }
    const span = Math.max(1, max - baseline);
    const progress = (clamped - baseline) / span;
    return 1 - (progress * 0.42);
  };

  const applyListSectionHeight = (height) => {
    const nextHeight = clampHeight(height);
    listSection.style.flexBasis = `${nextHeight}px`;
    listSection.style.height = `${nextHeight}px`;
  };

  const clearListSectionHeight = () => {
    listSection.style.removeProperty('flex-basis');
    listSection.style.removeProperty('height');
  };

  const computeOrbitMinSize = (height) => {
    if (!orbitContainer) return null;
    const panelHeight = councilPanel.getBoundingClientRect().height;
    const handleHeight = resizeHandle.getBoundingClientRect().height || 0;
    const headerHeight = getHeaderHeight();
    const available = panelHeight - headerHeight - handleHeight - height;
    if (!Number.isFinite(available)) return null;
    const availableForOrbit = Math.max(0, available - ORBIT_CONTAINER_PADDING);
    if (availableForOrbit <= 0) return 0;
    const target = Math.floor(availableForOrbit * 0.9);
    const clamped = Math.min(ORBIT_MAX_SIZE, Math.max(ORBIT_MIN_SIZE, target));
    return Math.min(clamped, Math.floor(availableForOrbit));
  };

  const applyOrbitMinSize = (height) => {
    const minSize = computeOrbitMinSize(height);
    if (minSize === null) return;
    dashboardGrid.style.setProperty('--council-orbit-min-size', `${minSize}px`);
    const containerMin = Math.max(0, Math.floor(minSize + ORBIT_CONTAINER_PADDING));
    dashboardGrid.style.setProperty('--council-orbit-container-min', `${containerMin}px`);
  };

  const clearOrbitMinSize = () => {
    dashboardGrid.style.removeProperty('--council-orbit-min-size');
    dashboardGrid.style.removeProperty('--council-orbit-container-min');
  };

  const applyHeight = (value, { persist = true } = {}) => {
    const nextHeight = clampHeight(value);
    dashboardGrid.style.setProperty('--council-list-height', `${nextHeight}px`);
    dashboardGrid.style.setProperty('--council-orbit-squash', computeOrbitSquash(nextHeight).toFixed(3));
    applyListSectionHeight(nextHeight);
    applyOrbitMinSize(nextHeight);
    syncOrbitCollapseState(nextHeight);
    if (Array.isArray(currentAgentList) && currentAgentList.length > 0) {
      updateAgentListUI(currentAgentList);
    }
    if (persist) {
      localStorage.setItem(COUNCIL_LIST_SPLIT_STORAGE_KEY, String(nextHeight));
    }
  };

  const restoreHeight = () => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) {
      dashboardGrid.style.removeProperty('--council-list-height');
      dashboardGrid.style.setProperty('--council-orbit-squash', '1');
      councilPanel.classList.remove('council-chamber--orbit-collapsed');
      clearListSectionHeight();
      clearOrbitMinSize();
      return;
    }

    const storedValue = Number(localStorage.getItem(COUNCIL_LIST_SPLIT_STORAGE_KEY));
    if (Number.isFinite(storedValue) && storedValue > 0) {
      applyHeight(storedValue, { persist: false });
      return;
    }

    const measuredHeight = Math.round(listSection.getBoundingClientRect().height || HEIGHT_LIMITS.fallback);
    applyHeight(measuredHeight || HEIGHT_LIMITS.fallback, { persist: false });
  };

  const toggleHandleVisibility = () => {
    const shouldShow = desktopQuery.matches && !dashboardGrid.classList.contains('council-minimized');
    resizeHandle.classList.toggle('hidden', !shouldShow);
    resizeHandle.classList.toggle('xl:flex', shouldShow);
    if (!shouldShow) {
      dashboardGrid.classList.remove('dashboard-main-grid--resizing-row');
      dashboardGrid.style.removeProperty('--council-list-height');
      dashboardGrid.style.setProperty('--council-orbit-squash', '1');
      councilPanel.classList.remove('council-chamber--orbit-collapsed');
      clearListSectionHeight();
      clearOrbitMinSize();
    } else {
      restoreHeight();
    }
  };

  let activePointerId = null;
  let pendingClientY = null;
  let moveFrame = null;

  const finishResize = () => {
    const pointerId = activePointerId;
    if (moveFrame) {
      cancelAnimationFrame(moveFrame);
      moveFrame = null;
    }
    activePointerId = null;
    pendingClientY = null;
    dashboardGrid.classList.remove('dashboard-main-grid--resizing-row');
    try {
      if (pointerId !== null) {
        resizeHandle.releasePointerCapture?.(pointerId);
      }
    } catch (_) { }
    window.dispatchEvent(new Event('resize'));
  };

  const queueHeightFromPointer = (clientY) => {
    pendingClientY = clientY;
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = null;
      const councilRect = councilPanel.getBoundingClientRect();
      const desiredHeight = councilRect.bottom - pendingClientY - (resizeHandle.offsetHeight / 2);
      applyHeight(desiredHeight);
    });
  };

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) return;
    activePointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(event.pointerId);
    dashboardGrid.classList.add('dashboard-main-grid--resizing-row');
    event.preventDefault();
  });

  resizeHandle.addEventListener('pointermove', (event) => {
    if (activePointerId !== event.pointerId) return;
    queueHeightFromPointer(event.clientY);
  });

  resizeHandle.addEventListener('pointerup', finishResize);
  resizeHandle.addEventListener('pointercancel', finishResize);
  resizeHandle.addEventListener('lostpointercapture', finishResize);

  resizeHandle.addEventListener('keydown', (event) => {
    if (!desktopQuery.matches || dashboardGrid.classList.contains('council-minimized')) return;
    const delta = event.shiftKey ? 30 : 15;
    const currentHeight = Number.parseFloat(getComputedStyle(dashboardGrid).getPropertyValue('--council-list-height'))
      || listSection.getBoundingClientRect().height
      || getHeightLimits().fallback;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      applyHeight(currentHeight + delta);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      applyHeight(currentHeight - delta);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyHeight(getHeightLimits().min);
      window.dispatchEvent(new Event('resize'));
    } else if (event.key === 'End') {
      event.preventDefault();
      applyHeight(getHeightLimits().max);
      window.dispatchEvent(new Event('resize'));
    }
  });

  toggleHandleVisibility();
  window.addEventListener('resize', restoreHeight);
  desktopQuery.addEventListener?.('change', toggleHandleVisibility);
}
