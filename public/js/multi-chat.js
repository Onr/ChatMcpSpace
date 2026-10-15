/**
 * multi-chat.js
 * Manages multiple pinned agent chat panels displayed side-by-side to the right
 * of the main chat panel. Each panel polls independently and can send messages.
 */

(function () {
    'use strict';

    // ─── Config ───────────────────────────────────────────────────────────────
    const TILE_MIN_WIDTH = 340;   // px — matches CSS min-width on .chat-tile
    const TILE_MAX_WIDTH = 594;   // px — matches CSS max-width on .chat-tile
    const TILE_GAP = 8;           // px — matches CSS gap (0.5rem)
    const POLL_INTERVAL_MS = 3000;  // ms — base scheduler cadence
    const MAX_ADAPTIVE_POLL_INTERVAL_MS = 18000;
    const BACKGROUND_TAB_POLL_INTERVAL_MS = 25000;
    const HEAVY_PANEL_COUNT = 4;
    const VERY_HEAVY_PANEL_COUNT = 7;
    const MAX_TILE_ATTACHMENTS = 4;
    const MAX_TILE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
    const TILE_MESSAGE_HISTORY_STORAGE_KEY = 'dashboard_tile_message_history_v1';

    // ─── State ────────────────────────────────────────────────────────────────
    // Map<agentId, { panelEl, pollingTimer, cache: Message[], lastCursor, agentName, metadata }>
    const openPanels = new Map();
    let providerModelsCache = { codex: [{ value: 'default', label: 'Default' }] };
    let providerModelsLoaded = false;

    // Message history for arrow-key recall (last 4 sent messages per agent)
    const tileMessageHistory = new Map(); // agentId -> string[]

    function loadPersistedTileMessageHistory() {
        try {
            const raw = localStorage.getItem(TILE_MESSAGE_HISTORY_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            Object.entries(parsed).forEach(([agentId, history]) => {
                if (!agentId || !Array.isArray(history)) return;
                const cleaned = history
                    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
                    .slice(0, 4);
                if (cleaned.length > 0) {
                    tileMessageHistory.set(agentId, cleaned);
                }
            });
        } catch (error) {
            console.warn('[MultiChat] Failed to restore tile message history:', error);
        }
    }

    function persistTileMessageHistory() {
        try {
            const serialized = {};
            tileMessageHistory.forEach((history, agentId) => {
                if (!agentId || !Array.isArray(history) || history.length === 0) return;
                serialized[agentId] = history.slice(0, 4);
            });
            localStorage.setItem(TILE_MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify(serialized));
        } catch (error) {
            console.warn('[MultiChat] Failed to persist tile message history:', error);
        }
    }

    loadPersistedTileMessageHistory();

    // ─── Container bootstrap ──────────────────────────────────────────────────
    let container = null;

    let lastPerformanceNoticeKey = '';
    let lastPerformanceNoticeAt = 0;

    function getAdaptiveTilePollIntervalMs(panelCount = openPanels.size) {
        const effectivePanelCount = Math.max(1, Number(panelCount) || 0);
        let interval = POLL_INTERVAL_MS;
        if (effectivePanelCount >= VERY_HEAVY_PANEL_COUNT) {
            interval = Math.min(MAX_ADAPTIVE_POLL_INTERVAL_MS, POLL_INTERVAL_MS * 6);
        } else if (effectivePanelCount >= HEAVY_PANEL_COUNT) {
            interval = Math.min(MAX_ADAPTIVE_POLL_INTERVAL_MS, POLL_INTERVAL_MS * 3);
        } else if (effectivePanelCount >= 2) {
            interval = Math.min(MAX_ADAPTIVE_POLL_INTERVAL_MS, POLL_INTERVAL_MS * 2);
        }

        if (document.hidden) {
            interval = Math.max(interval, BACKGROUND_TAB_POLL_INTERVAL_MS);
        }

        return interval;
    }

    function maybeNotifyPerformanceMode() {
        const panelCount = openPanels.size;
        if (panelCount < HEAVY_PANEL_COUNT) {
            lastPerformanceNoticeKey = '';
            return;
        }

        const degraded = panelCount >= VERY_HEAVY_PANEL_COUNT;
        const intervalSeconds = Math.round(getAdaptiveTilePollIntervalMs(panelCount) / 1000);
        const noticeKey = `${panelCount}:${intervalSeconds}:${degraded ? 'degraded' : 'heavy'}`;
        const now = Date.now();
        if (noticeKey === lastPerformanceNoticeKey && now - lastPerformanceNoticeAt < 45000) {
            return;
        }

        lastPerformanceNoticeKey = noticeKey;
        lastPerformanceNoticeAt = now;

        const message = degraded
            ? `Pinned chats are in performance mode (${panelCount} open). Side chats now refresh about every ${intervalSeconds} seconds to keep the dashboard responsive. Close a few pinned chats if you want faster updates.`
            : `Several pinned chats are open (${panelCount}). Side chats are polling a bit slower, about every ${intervalSeconds} seconds, to keep responsiveness stable.`;

        if (typeof window.showNotification === 'function') {
            window.showNotification(message, 'warning', 'Performance Mode', 9000);
        } else if (typeof window.showWarning === 'function') {
            window.showWarning(message);
        }
    }

    function scheduleTileTimers(agentId) {
        const tile = openPanels.get(agentId);
        if (!tile) return;

        clearTimeout(tile.pollingTimer);
        clearTimeout(tile.readStatusTimer);

        const intervalMs = Math.max(getAdaptiveTilePollIntervalMs(), Number(tile.serverPollDelayMs) || 0);
        tile.pollingTimer = setTimeout(async () => {
            await pollTileMessages(agentId);
            scheduleTileTimers(agentId);
        }, intervalMs);

        tile.readStatusTimer = setTimeout(async () => {
            await pollTileReadStatus(agentId);
        }, intervalMs + 800);
    }

    function rescheduleAllTileTimers() {
        for (const agentId of openPanels.keys()) {
            scheduleTileTimers(agentId);
        }
    }

    function getContainer() {
        if (!container) {
            container = document.getElementById('multiChatContainer');
        }
        return container;
    }

    // ─── Drag-and-drop shared state ───────────────────────────────────────────
    let _dropIndicator = null;      // the between-tile drop line element
    let _edgeScrollRaf = null;      // requestAnimationFrame handle for edge scroll
    let _edgeScrollDir = 0;         // -1 = left, 0 = none, 1 = right
    let _lastDropTarget = null;
    let _lastDropBefore = null;

    function getDropIndicator() {
        if (!_dropIndicator) {
            _dropIndicator = document.createElement('div');
            _dropIndicator.className = 'chat-drop-indicator';
        }
        return _dropIndicator;
    }

    function removeDropIndicator() {
        if (_dropIndicator && _dropIndicator.parentNode) {
            _dropIndicator.parentNode.removeChild(_dropIndicator);
        }
        _lastDropTarget = null;
        _lastDropBefore = null;
    }

    function stopEdgeScroll() {
        if (_edgeScrollRaf) {
            cancelAnimationFrame(_edgeScrollRaf);
            _edgeScrollRaf = null;
        }
        _edgeScrollDir = 0;
    }

    function startEdgeScrollLoop() {
        if (_edgeScrollRaf) return; // already running
        function tick() {
            const c = getContainer();
            if (!c || _edgeScrollDir === 0) { _edgeScrollRaf = null; return; }
            c.scrollLeft += _edgeScrollDir * 12;
            _edgeScrollRaf = requestAnimationFrame(tick);
        }
        _edgeScrollRaf = requestAnimationFrame(tick);
    }

    // ─── Helpers (mirrors from dashboard.js exposed on window) ────────────────
    function escapeHtml(text) {
        if (window.DashboardHelpers?.escapeHtml) return window.DashboardHelpers.escapeHtml(text);
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return String(text || '').replace(/[&<>"']/g, m => map[m]);
    }

    function findAgentNameInDom(agentId) {
        if (!agentId) return '';
        const nodes = document.querySelectorAll('[data-agent-id][data-agent-name]');
        for (const node of nodes) {
            if (node.getAttribute('data-agent-id') !== agentId) continue;
            const name = node.getAttribute('data-agent-name');
            if (name && String(name).trim()) return name;
        }
        return '';
    }

    function resolveAgentName(agentId, agentName) {
        const trimmed = String(agentName || '').trim();
        if (trimmed) return trimmed;
        const domName = findAgentNameInDom(agentId);
        if (domName) return domName;
        return 'Agent';
    }

    function renderText(text) {
        if (window.DashboardHelpers?.renderMarkdown) return window.DashboardHelpers.renderMarkdown(text);
        // Minimal fallback: escape and preserve newlines
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    function buildTileRequestError(response, errorData, fallbackMessage) {
        if (typeof window.DashboardHelpers?.buildRequestError === 'function') {
            return window.DashboardHelpers.buildRequestError(response, errorData, { fallbackMessage });
        }

        return new Error(errorData?.error?.message || fallbackMessage || `Request failed (${response?.status || 'unknown'})`);
    }

    function formatTime(ts) {
        if (window.DashboardHelpers?.formatTimestamp) return window.DashboardHelpers.formatTimestamp(ts);
        try {
            return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    }

    function looksEncrypted(text) {
        if (window.DashboardHelpers?.looksLikeEncrypted) return window.DashboardHelpers.looksLikeEncrypted(text);
        if (typeof text !== 'string') return false;
        const parts = text.split(':');
        return parts.length === 3 && parts.every(p => /^[A-Za-z0-9+/=]+$/.test(p));
    }

    async function tryDecrypt(content) {
        const key = window.DashboardHelpers?.getEncryptionKey?.();
        if (!key || !window.E2EEncryption) return null;
        try {
            const parts = content.split(':');
            if (parts.length !== 3) return null;
            return await window.E2EEncryption.decryptMessage(content, key);
        } catch {
            return null;
        }
    }

    async function ensureProviderModelsLoaded() {
        if (providerModelsLoaded) return;
        try {
            const res = await fetch('/dashboard/models');
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.models && typeof data.models === 'object') {
                providerModelsCache = data.models;
                providerModelsLoaded = true;
            }
        } catch (err) {
            console.warn('[MultiChat] Failed to load provider models:', err);
        }
    }

    // ─── Calculate how many tiles can fit ─────────────────────────────────────
    function getMaxTiles() {
        return 99; // Unlimited tiles, rely on horizontal scrolling
    }

    function syncTileSizing() {
        // Obsolete: CSS handles tile sizing with flex clamp and overflow auto
        return;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Open (or focus) a side-panel for the given agent.
     * @param {string} agentId
     * @param {string} agentName
     * @param {object} metadata  – same shape as selectAgent() metadata
     */
    function openSidePanel(agentId, agentName, metadata = {}) {
        if (!agentId) return;

        agentName = resolveAgentName(agentId, agentName);

        // Already open → flash/focus
        if (openPanels.has(agentId)) {
            const existing = openPanels.get(agentId);
            existing.panelEl.classList.add('chat-tile--flash');
            setTimeout(() => existing.panelEl.classList.remove('chat-tile--flash'), 600);
            return;
        }

        // Check capacity
        const maxTiles = getMaxTiles();
        if (maxTiles < 1) {
            // Not enough space — inform gracefully (browser too narrow)
            console.info('[MultiChat] Not enough horizontal space for a side panel.');
            return;
        }

        // Keep additional panels open; container can scroll horizontally when needed.

        const tile = buildTile(agentId, agentName, metadata);
        getContainer().appendChild(tile.panelEl);
        openPanels.set(agentId, tile);

        // Show the container
        updateContainerVisibility();
        syncTileSizing();
        requestAnimationFrame(syncTileSizing);
        saveOpenPanels();

        // Load messages and start polling
        loadTileMessages(agentId);
        maybeNotifyPerformanceMode();
        rescheduleAllTileTimers();
    }

    /**
     * Close and destroy the side-panel for the given agent.
     */
    function closeSidePanel(agentId) {
        if (!openPanels.has(agentId)) return;
        const tile = openPanels.get(agentId);
        clearTimeout(tile.pollingTimer);
        clearTimeout(tile.readStatusTimer);
        const interactiveContent = tile.panelEl?.querySelector('.chat-tile__interactive-content');
        if (interactiveContent && window.RichRendering?.closeInteractiveContentPopupFor) {
            window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
        }

        // Animate out
        tile.panelEl.classList.add('chat-tile--leaving');
        setTimeout(() => {
            tile.panelEl.remove();
            openPanels.delete(agentId);
            updateContainerVisibility();
            maybeNotifyPerformanceMode();
            rescheduleAllTileTimers();
            syncTileSizing();
            saveOpenPanels();
        }, 250);
    }

    /**
     * Returns true if a side-panel is open for the given agent.
     */
    function isOpen(agentId) {
        return openPanels.has(agentId);
    }

    // ─── DOM construction ─────────────────────────────────────────────────────

    function buildTile(agentId, agentName, metadata) {
        const panelEl = document.createElement('div');
        panelEl.className = 'chat-tile glass-panel';
        panelEl.draggable = true;
        panelEl.dataset.agentId = agentId;

        const initials = (agentName || '??').substring(0, 2).toUpperCase();
        const externalProvider = (metadata.externalProvider || '').toLowerCase();
        const isOpenClaw = externalProvider === 'openclaw';

        const marbleSvg = (!isOpenClaw && window.MarbleGenerator?.generateMarble)
            ? window.MarbleGenerator.generateMarble(agentId, 100, agentName, `tile-${agentId}-${Date.now()}`)
            : '';

        const avatarHtml = isOpenClaw
            ? `<div class="chat-tile__avatar-oc">
           <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" class="w-full h-full text-orange-300">
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M12 38c5-7 11-10 20-10s15 3 20 10"/>
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M20 28l-6-10M32 24V12M44 28l6-10"/>
             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" d="M24 37l-5 13M32 39v13M40 37l5 13"/>
             <circle cx="24" cy="33" r="2.4" fill="currentColor" stroke="none"/>
             <circle cx="40" cy="33" r="2.4" fill="currentColor" stroke="none"/>
           </svg>
         </div>`
            : (marbleSvg
                ? `<div class="chat-tile__avatar-marble">${marbleSvg}</div>`
                : `<div class="chat-tile__avatar-initials">${escapeHtml(initials)}</div>`);

        panelEl.innerHTML = `
      <div class="chat-tile__header">
        <div class="chat-tile__agent-info">
          <div class="chat-tile__avatar">${avatarHtml}</div>
          <div class="chat-tile__agent-text">
            <div class="chat-tile__name-row">
              <span class="chat-tile__name chat-tile__name--menu-trigger" role="button" tabindex="0" title="${escapeHtml(agentName)}" aria-label="Open actions menu for ${escapeHtml(agentName)}">${escapeHtml(agentName)}</span>
              <span class="chat-tile__working-indicator" style="display:none;" title="Agent is working..."></span>
            </div>
            <button type="button" class="chat-tile__a2a-btn" title="Toggle agent-to-agent communication">
              <span class="chat-tile__a2a-status text-slate-400">A2A Off</span>
            </button>
          </div>
        </div>
        <button class="chat-tile__close-btn" title="Close panel" aria-label="Close ${escapeHtml(agentName)} panel">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Agent Space (Always visible, starts collapsed) -->
      <div class="chat-tile__interactive-space border-b border-white/5 bg-slate-900/60 overflow-hidden transition-all duration-300">
        <div class="flex items-center justify-between px-3 py-1.5 bg-slate-800/80 cursor-pointer hover:bg-slate-700/50 transition chat-tile__interactive-toggle text-slate-300">
          <div class="flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase">
            <svg class="w-3.5 h-3.5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <span class="chat-tile__interactive-title">Agent Space</span>
          </div>
          <div class="flex items-center gap-1.5">
             <div class="chat-tile__rich-history-controls hidden flex items-center gap-1 mr-1">
               <button type="button"
                 class="chat-tile__rich-history-prev w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 transition disabled:opacity-30 disabled:cursor-not-allowed"
                 title="Previous rich message">
                 <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                 </svg>
               </button>
               <span class="chat-tile__rich-history-counter text-[10px] text-slate-500 tabular-nums min-w-[28px] text-center select-none">1 / 1</span>
               <button type="button"
                 class="chat-tile__rich-history-next w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-white/10 transition disabled:opacity-30 disabled:cursor-not-allowed"
                 title="Next rich message">
                 <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                 </svg>
               </button>
               <button type="button"
                 class="chat-tile__rich-history-download w-5 h-5 flex items-center justify-center rounded text-slate-400 hover:text-cyan-400 hover:bg-white/10 transition ml-0.5"
                 title="Download as HTML">
                 <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                 </svg>
               </button>
             </div>
             <button type="button" class="chat-tile__interactive-size-btn p-1 hover:text-emerald-400 hover:bg-white/5 rounded transition text-slate-400" title="Expand">
                 <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
             </button>
             <svg class="w-3.5 h-3.5 transform transition-transform duration-200 chat-tile__interactive-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
             </svg>
          </div>
        </div>
        <div class="chat-tile__interactive-content max-h-[40vh] overflow-y-auto overflow-x-hidden text-xs hidden">
          <div class="chat-tile__interactive-placeholder flex flex-col items-center justify-center gap-2 py-5 text-slate-500">
            <svg class="w-6 h-6 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
            <span class="text-[10px] text-center leading-relaxed">No interactive content yet.<br>This agent can send interactive content here.</span>
          </div>
        </div>
      </div>
      
      <div class="chat-tile__messages" data-agent-id="${agentId}">
        <div class="chat-tile__loading">Loading…</div>
      </div>
      <div class="chat-tile__input-area relative border-t border-white/10 px-3 py-3 bg-slate-900/40">
        <form class="chat-tile__form space-y-2">
            <!-- Image Preview Area -->
            <div class="chat-tile__image-preview-area hidden">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-[10px] text-slate-400 uppercase tracking-wider font-medium">Attachments</span>
                    <button type="button" class="chat-tile__clear-images-btn text-[10px] text-red-400 hover:text-red-300 transition">
                        Clear All
                    </button>
                </div>
                <div class="chat-tile__image-preview-container flex flex-wrap gap-2 p-2 bg-white/5 rounded-lg border border-white/10 max-h-24 overflow-y-auto overflow-x-hidden">
                </div>
            </div>
            
            <div class="relative">
                <textarea class="chat-tile__textarea w-full bg-white/5 border border-white/10 focus:border-emerald-400/70 focus:ring-0 text-xs text-slate-100 rounded-xl p-2.5 pr-16 placeholder:text-slate-500 transition resize-none" rows="1" placeholder="Message ${escapeHtml(agentName)}…"></textarea>

                <label class="chat-tile__file-upload-label absolute right-9 bottom-2 w-6 h-6 flex items-center justify-center rounded-lg bg-white/10 hover:bg-sky-500/20 hover:text-sky-400 text-slate-400 cursor-pointer transition disabled:opacity-40 disabled:cursor-not-allowed" title="Attach files">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <input type="file" class="chat-tile__file-input hidden" multiple />
                </label>

                <!-- Photo/Video Input Button -->
                <label class="chat-tile__image-upload-label absolute right-2 bottom-2 w-6 h-6 flex items-center justify-center rounded-lg bg-white/10 hover:bg-emerald-500/20 hover:text-emerald-400 text-slate-400 cursor-pointer transition disabled:opacity-40 disabled:cursor-not-allowed" title="Attach photos or videos">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <input type="file" class="chat-tile__image-input hidden" accept="image/*,video/*" multiple />
                </label>
            </div>
            
            <div class="flex justify-between items-center mt-3">
                <p class="text-[10px] text-slate-500 uppercase tracking-wider hidden xl:block">Ctrl+Enter to send • ESC to close</p>
                <div class="flex items-center gap-2 ml-auto">
                    <!-- Agent Config Button -->
                    <div class="relative chat-tile__config-container shrink max-w-[140px] sm:max-w-none">
                        <button type="button" class="chat-tile__config-btn px-2.5 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/50 hover:bg-slate-700/80 hover:border-slate-600 transition flex items-center gap-1.5 group w-full" title="Agent Configuration">
                            <div class="flex items-center gap-1 text-[10px] overflow-hidden whitespace-nowrap">
                                <span class="chat-tile__config-provider text-emerald-400 font-medium truncate shrink">-</span>
                                <span class="text-slate-600 shrink-0">|</span>
                                <span class="chat-tile__config-mode text-sky-400 font-medium truncate shrink">-</span>
                            </div>
                            <div class="w-px h-3 bg-slate-700 shrink-0"></div>
                            <svg class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-200 transition-colors shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </button>
                        
                        <!-- Config Dropdown Panel -->
                        <div class="chat-tile__config-dropdown hidden absolute bottom-full right-0 mb-2 w-72 max-h-[70vh] overflow-y-auto bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-50 text-left">
                            <div class="px-4 py-3 border-b border-slate-700/50 bg-slate-900/50">
                                <h4 class="text-xs font-semibold text-white">Agent Configuration</h4>
                                <p class="text-[9px] text-slate-400">Changes apply next message</p>
                            </div>
                            <div class="p-4 space-y-3">
                                <div>
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">Provider</label>
                                    <select class="chat-tile__config-provider-select w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="codex">Codex (Default)</option>
                                        <option value="claude">Claude</option>
                                        <option value="gemini">Gemini</option>
                                        <option value="copilot">Copilot (GitHub)</option>
                                        <option value="antigravity">Antigravity</option>
                                        <option value="pi">Pi</option>
                                        <option value="ollama">Ollama</option>
                                        <option value="openrouter">OpenRouter</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block mb-1">Model</label>
                                    <select class="chat-tile__config-model-select w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="default">Default</option>
                                    </select>
                                </div>

                                <!-- Codex-specific options -->
                                <div class="chat-tile__codex-options space-y-2">
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block">Codex Sandbox</label>
                                    <select class="chat-tile__config-codex-sandbox w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="read-only">Read Only</option>
                                        <option value="workspace-write">Workspace Write</option>
                                        <option value="danger-full-access">Full Access (Danger)</option>
                                    </select>
                                    <label class="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
                                        <input type="checkbox" class="chat-tile__config-codex-bypass rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-emerald-500/50">
                                        Bypass All (--yolo)
                                    </label>
                                </div>

                                <!-- Claude-specific options -->
                                <div class="chat-tile__claude-options hidden space-y-2">
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block">Claude Permission Mode</label>
                                    <select class="chat-tile__config-claude-mode w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="default">Default</option>
                                        <option value="acceptEdits">Accept Edits</option>
                                        <option value="plan">Plan Only</option>
                                        <option value="bypassPermissions" selected>Bypass Permissions</option>
                                    </select>
                                    <label class="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
                                        <input type="checkbox" class="chat-tile__config-claude-skip rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-emerald-500/50" checked>
                                        Skip All Permissions (Dangerous)
                                    </label>
                                </div>

                                <!-- Gemini-specific options -->
                                <div class="chat-tile__gemini-options hidden space-y-2">
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block">Gemini Mode</label>
                                    <select class="chat-tile__config-gemini-mode w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="sandbox">Sandboxed</option>
                                        <option value="no-sandbox">No Sandbox</option>
                                    </select>
                                    <label class="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
                                        <input type="checkbox" class="chat-tile__config-gemini-yolo rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-emerald-500/50">
                                        YOLO Mode (Auto-approve all)
                                    </label>
                                </div>

                                <!-- Copilot-specific options -->
                                <div class="chat-tile__copilot-options hidden space-y-2">
                                    <label class="text-[10px] text-slate-400 uppercase tracking-wider block">Copilot Permission Mode</label>
                                    <select class="chat-tile__config-copilot-mode w-full bg-slate-900/50 border border-slate-600 text-white text-xs rounded-lg px-2 py-1.5">
                                        <option value="default">Default (Manual approve)</option>
                                        <option value="allow-all-tools">Allow All Tools</option>
                                        <option value="allow-all">Allow All (Full Access)</option>
                                    </select>
                                    <label class="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
                                        <input type="checkbox" class="chat-tile__config-copilot-yolo rounded bg-slate-900 border-slate-600 text-emerald-500 focus:ring-emerald-500/50">
                                        YOLO Mode (--allow-all / --yolo)
                                    </label>
                                </div>

                                <div class="pt-2">
                                    <button type="button" class="chat-tile__save-config-btn w-full px-3 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/30 transition">Save Config</button>
                                </div>
                            </div>
                        </div>
                    </div>
                
                    <!-- Stop Button -->
                    <button type="button" class="chat-tile__stop-btn w-8 h-8 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition flex items-center justify-center shrink-0" title="Stop Agent">
                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                    </button>
                    <!-- Send Button -->
                    <button type="submit" class="chat-tile__send-btn w-8 h-8 rounded-full bg-emerald-400 text-slate-950 hover:bg-emerald-300 transition flex items-center justify-center shadow-lg shadow-emerald-500/30 shrink-0" title="Send (Ctrl+Enter)">
                        <svg class="w-4 h-4 ml-[-2px] mt-[1px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                    </button>
                </div>
            </div>
        </form>
      </div>`;


        // Wire close button
        panelEl.querySelector('.chat-tile__close-btn').addEventListener('click', () => closeSidePanel(agentId));

        // Wire side-panel agent actions menu trigger
        const nameMenuTrigger = panelEl.querySelector('.chat-tile__name--menu-trigger');
        const openSideAgentActionsMenu = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof window.DashboardHelpers?.openAgentActionsMenu !== 'function') return;
            await window.DashboardHelpers.openAgentActionsMenu(agentId, agentName, metadata, nameMenuTrigger);
        };
        if (nameMenuTrigger) {
            nameMenuTrigger.addEventListener('click', openSideAgentActionsMenu);
            nameMenuTrigger.addEventListener('keydown', async (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                await openSideAgentActionsMenu(event);
            });
        }

        // Wire send
        const textarea = panelEl.querySelector('.chat-tile__textarea');
        const sendBtn = panelEl.querySelector('.chat-tile__send-btn');
        const a2aBtn = panelEl.querySelector('.chat-tile__a2a-btn');
        const a2aStatus = panelEl.querySelector('.chat-tile__a2a-status');
        let interAgentMode = 'disabled';

        function applyA2AStatus(mode) {
            interAgentMode = mode || 'disabled';
            if (!a2aStatus || !a2aBtn) return;
            const enabled = interAgentMode !== 'disabled';
            a2aStatus.textContent = enabled ? 'A2A On' : 'A2A Off';
            a2aStatus.classList.toggle('text-cyan-400', enabled);
            a2aStatus.classList.toggle('text-slate-400', !enabled);
            a2aBtn.classList.toggle('chat-tile__a2a-btn--on', enabled);
        }

        async function loadA2AStatus() {
            if (!agentName) return;
            try {
                const res = await fetch(`/dashboard/config?agentName=${encodeURIComponent(agentName)}`);
                if (!res.ok) return;
                const data = await res.json();
                applyA2AStatus(data.interAgentMode || 'disabled');
            } catch (err) {
                console.error('[MultiChat] Failed to load A2A status:', err);
            }
        }

        if (a2aBtn) {
            a2aBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!agentName) return;
                const newMode = interAgentMode === 'disabled' ? 'listen_all' : 'disabled';

                a2aBtn.disabled = true;
                try {
                    const res = await csrfFetch('/dashboard/config', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': window.csrfToken || ''
                        },
                        body: JSON.stringify({
                            agentName,
                            inter_agent_mode: newMode
                        })
                    });

                    if (res.ok) {
                        applyA2AStatus(newMode);
                    }
                } catch (err) {
                    console.error('[MultiChat] Failed to toggle A2A:', err);
                } finally {
                    a2aBtn.disabled = false;
                }
            });
        }

        loadA2AStatus();

        let tilePendingImages = [];
        const imageFileInput = panelEl.querySelector('.chat-tile__image-input');
        const generalFileInput = panelEl.querySelector('.chat-tile__file-input');
        const imagePreviewArea = panelEl.querySelector('.chat-tile__image-preview-area');
        const imagePreviewContainer = panelEl.querySelector('.chat-tile__image-preview-container');
        const clearImagesBtn = panelEl.querySelector('.chat-tile__clear-images-btn');

        function renderTileImagePreviews() {
            imagePreviewContainer.innerHTML = '';
            if (tilePendingImages.length === 0) {
                imagePreviewArea.classList.add('hidden');
                return;
            }
            imagePreviewArea.classList.remove('hidden');

            tilePendingImages.forEach((img, index) => {
                const previewEl = document.createElement('div');
                previewEl.className = 'relative group w-12 h-12 rounded-lg overflow-hidden border border-white/10 bg-slate-900 flex-shrink-0 flex items-center justify-center';

                let contentHtml = '';
                if (img.status === 'uploading') {
                    contentHtml = `<div class="absolute inset-0 bg-slate-900/80 flex items-center justify-center z-10"><span class="animate-spin w-3 h-3 border-2 border-emerald-400 border-t-transparent rounded-full"></span></div>`;
                } else if (img.status === 'error') {
                    contentHtml = `<div class="absolute inset-0 bg-red-900/80 flex flex-col items-center justify-center z-10" title="${escapeHtml(img.error || 'Error')}"><svg class="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg></div>`;
                } else if (img.status === 'success') {
                    contentHtml = `<div class="absolute top-0.5 right-0.5 bg-emerald-500 rounded-full p-0.5 z-10"><svg class="w-1.5 h-1.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></div>`;
                }

                const isImage = String(img.file?.type || '').startsWith('image/') && img.previewUrl;
                const isVideo = String(img.file?.type || '').startsWith('video/') && img.previewUrl;
                const fileExt = (img.file?.name || '').split('.').pop()?.slice(0, 6).toUpperCase() || 'FILE';
                previewEl.innerHTML = `
                    ${isImage
                        ? `<img src="${img.previewUrl}" class="w-full h-full object-cover">`
                        : isVideo
                        ? `<video src="${img.previewUrl}" class="w-full h-full object-cover" muted playsinline preload="metadata"></video>`
                        : `<div class="w-full h-full flex flex-col items-center justify-center gap-0.5 text-sky-300 bg-slate-950/60">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                            </svg>
                            <span class="text-[7px] font-semibold">${escapeHtml(fileExt)}</span>
                          </div>`}
                    ${contentHtml}
                    <button type="button" class="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white rounded-bl opacity-0 group-hover:opacity-100 transition flex items-center justify-center z-20" title="Remove">
                        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                `;

                previewEl.querySelector('button').addEventListener('click', (e) => {
                    e.preventDefault();
                    URL.revokeObjectURL(img.previewUrl);
                    tilePendingImages.splice(index, 1);
                    renderTileImagePreviews();
                    updateTileComposerState();
                });
                imagePreviewContainer.appendChild(previewEl);
            });
        }

        function updateTileComposerState() {
            const text = textarea.value.trim();
            const hasImages = tilePendingImages.length > 0;
            const isUploading = tilePendingImages.some(img => img.status === 'uploading');
            sendBtn.disabled = (!text && !hasImages) || isUploading;
        }

        function clearTileImages() {
            tilePendingImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
            tilePendingImages = [];
            if (imageFileInput) imageFileInput.value = '';
            renderTileImagePreviews();
            updateTileComposerState();
        }

        if (clearImagesBtn) clearImagesBtn.addEventListener('click', clearTileImages);

        function handleTileAttachmentAdd(files, { imagesOnly = false } = {}) {
            let addedCount = 0;
            let rejectedCount = 0;
            for (const file of files) {
                if (tilePendingImages.length >= MAX_TILE_ATTACHMENTS) {
                    if (window.showError) window.showError(`You can only attach ${MAX_TILE_ATTACHMENTS} files per side chat message.`);
                    break;
                }
                const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
                const isVideo = String(file.type || '').startsWith('video/');
                if (imagesOnly && !isImage && !isVideo) {
                    rejectedCount++;
                    if (window.showError) window.showError(`${file.name || 'File'}: only images or videos can be added from this button.`);
                    continue;
                }
                if (file.size > MAX_TILE_ATTACHMENT_BYTES) {
                    rejectedCount++;
                    if (window.showError) window.showError(`${file.name || 'File'}: file is too large. Maximum size is 20MB.`);
                    continue;
                }

                tilePendingImages.push({
                    id: crypto.randomUUID(),
                    file,
                    previewUrl: (String(file.type || '').startsWith('image/') || String(file.type || '').startsWith('video/')) ? URL.createObjectURL(file) : null,
                    status: 'pending',
                    attachmentId: null,
                    error: null
                });
                addedCount++;
            }
            if (addedCount > 0) {
                renderTileImagePreviews();
                updateTileComposerState();
            } else if (rejectedCount > 0) {
                updateTileComposerState();
            }
        }

        if (imageFileInput) {
            imageFileInput.addEventListener('change', (e) => {
                handleTileAttachmentAdd(Array.from(e.target.files), { imagesOnly: true });
                e.target.value = '';
            });
        }

        if (generalFileInput) {
            generalFileInput.addEventListener('change', (e) => {
                handleTileAttachmentAdd(Array.from(e.target.files), { imagesOnly: false });
                e.target.value = '';
            });
        }

        textarea.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const imageFiles = [];
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                }
            }
            if (imageFiles.length > 0) {
                e.preventDefault();
                handleTileAttachmentAdd(imageFiles, { imagesOnly: true });
            }
        });

        textarea.addEventListener('input', updateTileComposerState);

        // Per-panel message history browsing state
        let tileHistoryIndex = -1;
        let tileHistoryDraft = '';

        async function doSend() {
            const text = textarea.value.trim();
            const hasImages = tilePendingImages.length > 0;
            if (!text && !hasImages) return;

            sendBtn.disabled = true;
            textarea.disabled = true;
            const encryptionKey = window.DashboardHelpers?.getEncryptionKey?.();
            const attachmentIds = [];
            let uploadError = false;

            if (hasImages) {
                if (!encryptionKey) {
                    if (window.showError) window.showError('Encryption key required for images.');
                    sendBtn.disabled = false;
                    textarea.disabled = false;
                    return;
                }

                for (let i = 0; i < tilePendingImages.length; i++) {
                    const img = tilePendingImages[i];
                    if (img.status === 'success' && img.attachmentId) {
                        attachmentIds.push(img.attachmentId);
                        continue;
                    }
                    try {
                        img.status = 'uploading';
                        renderTileImagePreviews();
                        updateTileComposerState();

                        const arrayBuffer = await img.file.arrayBuffer();
                        const { ciphertext, iv, authTag } = await window.E2EEncryption.encryptBinaryWithKey(arrayBuffer, encryptionKey);

                        let dimensions = { w: 0, h: 0 };
                        if (img.previewUrl && String(img.file?.type || '').startsWith('image/')) {
                            dimensions = await new Promise(resolve => {
                                const imageObj = new Image();
                                imageObj.onload = () => resolve({ w: imageObj.naturalWidth, h: imageObj.naturalHeight });
                                imageObj.onerror = () => resolve({ w: 0, h: 0 });
                                imageObj.src = img.previewUrl;
                            });
                        }

                        const formData = new FormData();
                        formData.append('agentId', agentId);
                        formData.append('file', new Blob([ciphertext], { type: 'application/octet-stream' }), img.file.name);
                        formData.append('ivBase64', window.E2EEncryption.arrayBufferToBase64(iv.buffer));
                        formData.append('authTagBase64', window.E2EEncryption.arrayBufferToBase64(authTag.buffer));
                        formData.append('contentType', String(img.file?.type || '').trim() || 'application/octet-stream');
                        if (dimensions.w > 0) formData.append('width', dimensions.w.toString());
                        if (dimensions.h > 0) formData.append('height', dimensions.h.toString());

                        const res = await csrfFetch('/api/user/attachments', {
                            method: 'POST',
                            headers: { 'X-CSRF-Token': window.csrfToken },
                            credentials: 'same-origin',
                            body: formData
                        });
                        if (!res.ok) {
                            const errorData = await window.DashboardHelpers?.readErrorPayload?.(res);
                            throw buildTileRequestError(res, errorData, `Failed to upload ${img.file?.name || 'attachment'}`);
                        }
                        const data = await res.json();

                        img.status = 'success';
                        img.attachmentId = data.attachment.attachmentId;
                        attachmentIds.push(img.attachmentId);
                    } catch (err) {
                        img.status = 'error';
                        img.error = err.message || 'Upload error';
                        if (window.DashboardHelpers?.notifyRateLimit) {
                            window.DashboardHelpers.notifyRateLimit(err, { scope: 'tile-upload-attachment', title: 'Upload Delayed' });
                        }
                        uploadError = true;
                    }
                }
                renderTileImagePreviews();
            }

            if (uploadError) {
                const failedNames = tilePendingImages
                    .filter(img => img.status === 'error')
                    .map(img => img.file?.name || 'attachment');
                const firstError = tilePendingImages.find(img => img.status === 'error')?.error || 'Attachment upload failed.';
                if (window.showError) {
                    const failedLabel = failedNames.length > 0 ? ` Failed: ${failedNames.join(', ')}.` : '';
                    window.showError(`${firstError}${failedLabel}`);
                }
                sendBtn.disabled = false;
                textarea.disabled = false;
                updateTileComposerState();
                return;
            }

            // Save to message history (most recent first, max 4)
            if (text) {
                const history = tileMessageHistory.get(agentId) || [];
                if (history[0] !== text) {
                    history.unshift(text);
                    if (history.length > 4) history.pop();
                }
                tileMessageHistory.set(agentId, history);
                persistTileMessageHistory();
            }
            tileHistoryIndex = -1;
            tileHistoryDraft = '';

            const sendSucceeded = await sendTileMessage(agentId, text, attachmentIds, tilePendingImages);
            if (sendSucceeded) {
                textarea.value = '';
                textarea.style.height = '';
                clearTileImages();
                textarea.focus();
            }

            textarea.disabled = false;
            sendBtn.disabled = false;
            updateTileComposerState();
        }

        sendBtn.addEventListener('click', (e) => {
            e.preventDefault();
            doSend();
        });

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                doSend();
                return;
            }

            // Arrow key message history (without Ctrl = history, with Ctrl = scroll)
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey) {
                const history = tileMessageHistory.get(agentId) || [];
                if (history.length === 0) return;

                if (tileHistoryIndex === -1 && textarea.value.trim() !== '') return;

                e.preventDefault();

                if (e.key === 'ArrowUp') {
                    if (tileHistoryIndex === -1) {
                        tileHistoryDraft = textarea.value;
                        tileHistoryIndex = 0;
                    } else if (tileHistoryIndex < history.length - 1) {
                        tileHistoryIndex++;
                    }
                    textarea.value = history[tileHistoryIndex];
                } else {
                    if (tileHistoryIndex === -1) return;
                    if (tileHistoryIndex > 0) {
                        tileHistoryIndex--;
                        textarea.value = history[tileHistoryIndex];
                    } else {
                        tileHistoryIndex = -1;
                        textarea.value = tileHistoryDraft;
                    }
                }
                updateTileComposerState();
            }
        });

        // Auto-grow textarea
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 80) + 'px';
        });

        // Wire Stop Button
        const stopBtn = panelEl.querySelector('.chat-tile__stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                if (stopBtn.disabled) return;
                try {
                    stopBtn.disabled = true;
                    stopBtn.innerHTML = '<span class="animate-spin inline-block w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full"></span>';

                    const res = await csrfFetch(`/api/user/agents/${agentId}/stop`, {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': window.csrfToken },
                        credentials: 'same-origin'
                    });
                    if (!res.ok) throw new Error('Failed to stop agent');

                    // Show success state briefly
                    stopBtn.innerHTML = '<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
                    setTimeout(() => {
                        stopBtn.innerHTML = '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>';
                        stopBtn.disabled = false;
                    }, 2000);
                } catch (err) {
                    console.error('[MultiChat] Stop agent error:', err);
                    stopBtn.innerHTML = '<svg class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>';
                    stopBtn.disabled = false;
                }
            });
        }

        // Wire Config Dropdown
        const configBtn = panelEl.querySelector('.chat-tile__config-btn');
        const configDropdown = panelEl.querySelector('.chat-tile__config-dropdown');
        const providerSelect = panelEl.querySelector('.chat-tile__config-provider-select');
        const modelSelect = panelEl.querySelector('.chat-tile__config-model-select');
        const saveConfigBtn = panelEl.querySelector('.chat-tile__save-config-btn');
        const configProviderDisplay = panelEl.querySelector('.chat-tile__config-provider');
        const modeDisplay = panelEl.querySelector('.chat-tile__config-mode');

        // Provider-specific option containers
        const codexOptions = panelEl.querySelector('.chat-tile__codex-options');
        const claudeOptions = panelEl.querySelector('.chat-tile__claude-options');
        const geminiOptions = panelEl.querySelector('.chat-tile__gemini-options');
        const copilotOptions = panelEl.querySelector('.chat-tile__copilot-options');

        let currentConfig = null;

        function updateModelSelect(provider, selectedModel = 'default') {
            modelSelect.innerHTML = '';
            const models = providerModelsCache[provider] || providerModelsCache.codex || [{ value: 'default', label: 'Default' }];
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.value;
                option.textContent = model.label;
                modelSelect.appendChild(option);
            });

            if (Array.from(modelSelect.options).some(opt => opt.value === selectedModel)) {
                modelSelect.value = selectedModel;
            } else {
                modelSelect.value = 'default';
            }
        }

        function showProviderOptions(provider) {
            codexOptions?.classList.add('hidden');
            claudeOptions?.classList.add('hidden');
            geminiOptions?.classList.add('hidden');
            copilotOptions?.classList.add('hidden');

            if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
                codexOptions?.classList.remove('hidden');
            } else if (provider === 'claude' || provider === 'antigravity') {
                claudeOptions?.classList.remove('hidden');
            } else if (provider === 'gemini') {
                geminiOptions?.classList.remove('hidden');
            } else if (provider === 'copilot') {
                copilotOptions?.classList.remove('hidden');
            }
        }

        function formatProviderDisplay(provider) {
            const value = String(provider || 'codex').trim().toLowerCase();
            return value ? (value.charAt(0).toUpperCase() + value.slice(1)) : 'Codex';
        }

        function formatModeDisplay(model) {
            const value = String(model || 'default').trim();
            if (!value || value === 'default') return 'default-mode';
            return value.length > 10 ? `${value.substring(0, 10)}...` : value;
        }

        function applyConfigDisplay(provider, model) {
            configProviderDisplay.textContent = formatProviderDisplay(provider);
            if (modeDisplay) {
                modeDisplay.textContent = formatModeDisplay(model);
            }
        }

        providerSelect.addEventListener('change', () => {
            const provider = providerSelect.value;
            updateModelSelect(provider);
            showProviderOptions(provider);
        });

        async function loadConfig() {
            try {
                await ensureProviderModelsLoaded();
                const res = await fetch(`/dashboard/config?agentName=${encodeURIComponent(agentName)}`);
                if (!res.ok) throw new Error('Failed to load config');
                const data = await res.json();
                const config = data.config || {};
                currentConfig = config;

                const provider = config.model_provider || 'codex';
                const model = config.model || 'default';
                providerSelect.value = provider;
                updateModelSelect(provider, model);
                showProviderOptions(provider);

                // Populate provider-specific fields from config
                const sandboxMode = config.sandbox_mode || 'workspace-write';
                const approvalMode = config.approval_mode || '';

                // Codex options
                const codexSandbox = panelEl.querySelector('.chat-tile__config-codex-sandbox');
                const codexBypass = panelEl.querySelector('.chat-tile__config-codex-bypass');
                if (codexSandbox) {
                    if (sandboxMode === 'none') codexSandbox.value = 'danger-full-access';
                    else codexSandbox.value = sandboxMode;
                }
                if (codexBypass) codexBypass.checked = approvalMode === 'full-auto';

                // Claude options
                const claudeMode = panelEl.querySelector('.chat-tile__config-claude-mode');
                const claudeSkip = panelEl.querySelector('.chat-tile__config-claude-skip');
                if (claudeMode) claudeMode.value = approvalMode || 'bypassPermissions';
                if (claudeSkip) claudeSkip.checked = sandboxMode === 'none';

                // Gemini options
                const geminiMode = panelEl.querySelector('.chat-tile__config-gemini-mode');
                const geminiYolo = panelEl.querySelector('.chat-tile__config-gemini-yolo');
                if (geminiMode) geminiMode.value = sandboxMode === 'none' ? 'no-sandbox' : 'sandbox';
                if (geminiYolo) geminiYolo.checked = approvalMode === 'full-auto';

                // Copilot options
                const copilotMode = panelEl.querySelector('.chat-tile__config-copilot-mode');
                const copilotYolo = panelEl.querySelector('.chat-tile__config-copilot-yolo');
                if (copilotMode) {
                    if (approvalMode === 'full-auto' && sandboxMode === 'none') copilotMode.value = 'allow-all';
                    else if (approvalMode === 'full-auto') copilotMode.value = 'allow-all-tools';
                    else copilotMode.value = 'default';
                }
                if (copilotYolo) copilotYolo.checked = approvalMode === 'full-auto' && sandboxMode === 'none';

                applyConfigDisplay(provider, model);
            } catch (err) {
                console.error('[MultiChat] Failed to load config:', err);
                applyConfigDisplay('codex', 'default');
            }
        }

        configBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent closing immediately
            const isOpen = !configDropdown.classList.contains('hidden');

            // Close all other dropdowns first
            document.querySelectorAll('.chat-tile__config-dropdown').forEach(el => el.classList.add('hidden'));

            if (!isOpen) {
                configDropdown.classList.remove('hidden');
                if (!currentConfig) {
                    loadConfig();
                }
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (configDropdown && !configDropdown.classList.contains('hidden') && !configBtn.contains(e.target) && !configDropdown.contains(e.target)) {
                configDropdown.classList.add('hidden');
            }
        });

        saveConfigBtn.addEventListener('click', async () => {
            const originalText = saveConfigBtn.textContent;
            try {
                saveConfigBtn.disabled = true;
                saveConfigBtn.textContent = 'Saving...';

                const provider = providerSelect.value || 'codex';
                const model = modelSelect.value || 'default';

                // Build config matching main chat format
                let configData = {
                    agentName,
                    model_provider: provider,
                    model: model
                };

                // Add provider-specific settings (same logic as main chat)
                if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
                    let sandbox = panelEl.querySelector('.chat-tile__config-codex-sandbox')?.value || 'workspace-write';
                    if (sandbox === 'danger-full-access') sandbox = 'none';
                    const bypass = panelEl.querySelector('.chat-tile__config-codex-bypass')?.checked || false;
                    configData.sandbox_mode = sandbox;
                    if (bypass) {
                        configData.approval_mode = 'full-auto';
                        configData.sandbox_mode = 'none';
                    }
                } else if (provider === 'claude' || provider === 'antigravity') {
                    const perm = panelEl.querySelector('.chat-tile__config-claude-mode')?.value || 'bypassPermissions';
                    const skip = panelEl.querySelector('.chat-tile__config-claude-skip')?.checked ?? true;
                    configData.approval_mode = perm;
                    if (skip) configData.sandbox_mode = 'none';
                } else if (provider === 'gemini') {
                    const mode = panelEl.querySelector('.chat-tile__config-gemini-mode')?.value || 'sandbox';
                    const yolo = panelEl.querySelector('.chat-tile__config-gemini-yolo')?.checked || false;
                    configData.sandbox_mode = mode === 'no-sandbox' ? 'none' : 'workspace-write';
                    if (yolo) configData.approval_mode = 'full-auto';
                } else if (provider === 'copilot') {
                    const copilotMode = panelEl.querySelector('.chat-tile__config-copilot-mode')?.value || 'default';
                    const copilotYolo = panelEl.querySelector('.chat-tile__config-copilot-yolo')?.checked || false;
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

                const res = await csrfFetch('/dashboard/config', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': window.csrfToken || ''
                    },
                    body: JSON.stringify(configData)
                });

                if (!res.ok) throw new Error('Failed to save config');

                saveConfigBtn.textContent = 'Saved!';
                saveConfigBtn.classList.replace('text-emerald-400', 'text-white');
                saveConfigBtn.classList.replace('bg-emerald-500/20', 'bg-emerald-500');

                // Update display
                applyConfigDisplay(provider, model);

                setTimeout(() => {
                    configDropdown.classList.add('hidden');
                    saveConfigBtn.textContent = originalText;
                    saveConfigBtn.classList.replace('text-white', 'text-emerald-400');
                    saveConfigBtn.classList.replace('bg-emerald-500', 'bg-emerald-500/20');
                    saveConfigBtn.disabled = false;
                }, 1000);

            } catch (err) {
                console.error('[MultiChat] Failed to save config:', err);
                saveConfigBtn.textContent = 'Error';
                saveConfigBtn.classList.replace('text-emerald-400', 'text-red-400');
                setTimeout(() => {
                    saveConfigBtn.textContent = originalText;
                    saveConfigBtn.classList.replace('text-red-400', 'text-emerald-400');
                    saveConfigBtn.disabled = false;
                }, 2000);
            }
        });


        // Initial fetch of config provider name to display on the button
        loadConfig();

        // ─── Drag and Drop Reordering ──────────────────────────────────────────
        panelEl.addEventListener('dragstart', (e) => {
            // Only allow dragging the tile itself, not the textarea
            if (e.target.tagName.toLowerCase() === 'textarea' || e.target.tagName.toLowerCase() === 'input') {
                e.preventDefault();
                return;
            }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', agentId);
            panelEl.classList.add('opacity-50', 'ring-2', 'ring-emerald-400');
            // Give DOM time to take snapshot before hiding/fading visually
            setTimeout(() => {
                if (panelEl) panelEl.style.opacity = '0.4';
            }, 0);
        });

        panelEl.addEventListener('dragend', () => {
            panelEl.classList.remove('opacity-50', 'ring-2', 'ring-emerald-400');
            panelEl.style.opacity = '';
            removeDropIndicator();
            stopEdgeScroll();
        });

        panelEl.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('text/plain')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';

                // Edge-scroll: if pointer is within 80px of container edges, scroll
                const c = getContainer();
                if (c) {
                    const cRect = c.getBoundingClientRect();
                    const edgeZone = 80;
                    if (e.clientX < cRect.left + edgeZone) {
                        _edgeScrollDir = -1;
                        startEdgeScrollLoop();
                    } else if (e.clientX > cRect.right - edgeZone) {
                        _edgeScrollDir = 1;
                        startEdgeScrollLoop();
                    } else {
                        stopEdgeScroll();
                    }
                }

                // Show drop indicator between tiles instead of highlighting the tile
                const rect = panelEl.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                const indicator = getDropIndicator();
                const cont = getContainer();

                const before = e.clientX < midX;
                if (_lastDropTarget === panelEl && _lastDropBefore === before) return;
                _lastDropTarget = panelEl;
                _lastDropBefore = before;
                if (before) {
                    // Insert indicator before this tile
                    if (indicator.nextSibling !== panelEl) {
                        cont.insertBefore(indicator, panelEl);
                    }
                } else {
                    // Insert indicator after this tile
                    if (panelEl.nextSibling !== indicator) {
                        cont.insertBefore(indicator, panelEl.nextSibling);
                    }
                }
            }
        });

        panelEl.addEventListener('dragleave', (e) => {
            // Only remove indicator if we're leaving into something outside the container
            // (dragover on another tile will immediately re-place it)
        });

        panelEl.addEventListener('drop', (e) => {
            e.preventDefault();
            removeDropIndicator();
            stopEdgeScroll();

            const draggedAgentId = e.dataTransfer.getData('text/plain');
            if (!draggedAgentId || draggedAgentId === agentId) return;

            const draggedTile = openPanels.get(draggedAgentId);
            if (!draggedTile) return;

            const container = getContainer();
            const rect = panelEl.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;

            // Insert before or after based on pointer position relative to middle
            if (e.clientX < midX) {
                container.insertBefore(draggedTile.panelEl, panelEl);
            } else {
                container.insertBefore(draggedTile.panelEl, panelEl.nextSibling);
            }

            // Persist the new tile order
            saveChatTileOrder();
        });

        // Wire interactive space toggle
        const interactiveToggle = panelEl.querySelector('.chat-tile__interactive-toggle');
        const interactiveSizeBtn = panelEl.querySelector('.chat-tile__interactive-size-btn');
        const interactiveChevron = panelEl.querySelector('.chat-tile__interactive-chevron');
        const interactiveContent = panelEl.querySelector('.chat-tile__interactive-content');
        const interactiveTitleLabel = panelEl.querySelector('.chat-tile__interactive-title');
        const richHistoryControls = panelEl.querySelector('.chat-tile__rich-history-controls');
        const richHistoryPrevBtn = panelEl.querySelector('.chat-tile__rich-history-prev');
        const richHistoryNextBtn = panelEl.querySelector('.chat-tile__rich-history-next');
        const richHistoryCounter = panelEl.querySelector('.chat-tile__rich-history-counter');
        const richHistoryDownloadBtn = panelEl.querySelector('.chat-tile__rich-history-download');

        const setInteractiveSizeButtonState = (popupOpen) => {
            if (!interactiveSizeBtn) return;
            if (popupOpen) {
                interactiveSizeBtn.classList.remove('text-slate-400');
                interactiveSizeBtn.classList.add('text-emerald-400');
                interactiveSizeBtn.title = 'Close expanded view';
                interactiveSizeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 14h-4m0 0v4m0-4l5-5m11 5h4m0 0v4m0-4l-5-5M4 10h-4m0 0v-4m0 4l5 5m11-5h4m0 0v-4m0 4l-5 5" /></svg>';
            } else {
                interactiveSizeBtn.classList.remove('text-emerald-400');
                interactiveSizeBtn.classList.add('text-slate-400');
                interactiveSizeBtn.title = 'Expand';
                interactiveSizeBtn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>';
            }
        };

        // Starts collapsed — chevron points down (no rotate-180)
        let interactiveExpanded = false;
        let richHistory = { messages: [], currentIndex: -1 };

        const getInteractivePlaceholderHtml = () => `
          <div class="chat-tile__interactive-placeholder flex flex-col items-center justify-center gap-2 py-5 text-slate-500">
            <svg class="w-6 h-6 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
            <span class="text-[10px] text-center leading-relaxed">No interactive content yet.<br>This agent can send interactive content here.</span>
          </div>`;

        const updateInteractiveHistoryControls = (current, total) => {
            if (!richHistoryControls) return;
            if (total <= 0) {
                richHistoryControls.classList.add('hidden');
                return;
            }
            richHistoryControls.classList.remove('hidden');
            if (richHistoryCounter) richHistoryCounter.textContent = `${current} / ${total}`;
            if (richHistoryPrevBtn) richHistoryPrevBtn.disabled = current <= 1;
            if (richHistoryNextBtn) richHistoryNextBtn.disabled = current >= total;
        };

        const renderCurrentInteractiveMessage = () => {
            if (!window.RichRendering || !interactiveContent) return;
            if (!richHistory.messages.length || richHistory.currentIndex < 0) {
                if (window.RichRendering?.closeInteractiveContentPopupFor) {
                    const closed = window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
                    if (closed) setInteractiveSizeButtonState(false);
                }
                interactiveTitleLabel.textContent = 'Agent Space';
                interactiveContent.innerHTML = getInteractivePlaceholderHtml();
                updateInteractiveHistoryControls(0, 0);
                return;
            }

            const richData = richHistory.messages[richHistory.currentIndex];
            if (!richData) return;

            if (window.RichRendering?.closeInteractiveContentPopupFor) {
                const closed = window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
                if (closed) setInteractiveSizeButtonState(false);
            }

            interactiveTitleLabel.textContent = richData.title || richData.badge || 'Agent Space';
            interactiveContent.innerHTML = '';
            const sendCallback = (text) => sendTileMessage(agentId, text);
            const viewEl = window.RichRendering.renderRichContent(richData, sendCallback);
            interactiveContent.appendChild(viewEl);
            updateInteractiveHistoryControls(richHistory.currentIndex + 1, richHistory.messages.length);
        };

        const syncInteractiveHistory = (allRichMessages) => {
            if (!Array.isArray(allRichMessages) || allRichMessages.length === 0) {
                richHistory = { messages: [], currentIndex: -1 };
                renderCurrentInteractiveMessage();
                return;
            }

            const prevCount = richHistory.messages.length;
            const wasAtNewest = prevCount === 0 || richHistory.currentIndex === prevCount - 1;
            const hasNewRichMessage = allRichMessages.length > prevCount;

            let newIndex;
            if (wasAtNewest) {
                newIndex = allRichMessages.length - 1;
            } else {
                newIndex = Math.min(richHistory.currentIndex, allRichMessages.length - 1);
            }

            richHistory = {
                messages: allRichMessages,
                currentIndex: newIndex
            };

            if (hasNewRichMessage && !interactiveExpanded) {
                interactiveExpanded = true;
                interactiveContent.classList.remove('hidden');
                interactiveChevron.classList.add('rotate-180');
            }

            renderCurrentInteractiveMessage();
        };

        const downloadCurrentInteractiveMessage = () => {
            if (!richHistory.messages.length || richHistory.currentIndex < 0) return;
            const richData = richHistory.messages[richHistory.currentIndex];
            if (!richData) return;

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

            const safeAgentName = (agentName || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeTitle = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            const dateStr = new Date().toISOString().slice(0, 10);
            const filename = `${safeAgentName}-${safeTitle}-${dateStr}.html`;

            const blob = new Blob([fullHtml], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(url);
        };

        interactiveToggle.addEventListener('click', () => {
            interactiveExpanded = !interactiveExpanded;
            if (interactiveExpanded) {
                interactiveContent.classList.remove('hidden');
                interactiveChevron.classList.add('rotate-180');
            } else {
                interactiveContent.classList.add('hidden');
                interactiveChevron.classList.remove('rotate-180');
                if (window.RichRendering?.closeInteractiveContentPopupFor) {
                    const closed = window.RichRendering.closeInteractiveContentPopupFor(interactiveContent);
                    if (closed) setInteractiveSizeButtonState(false);
                }
            }
        });

        if (interactiveSizeBtn) {
            interactiveSizeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!window.RichRendering?.toggleInteractiveContentPopup) return;
                const popupOpen = window.RichRendering.toggleInteractiveContentPopup({
                    sourceContentEl: interactiveContent,
                    title: interactiveTitleLabel?.textContent?.trim() || 'Agent Space',
                    onStateChange: setInteractiveSizeButtonState
                });
                setInteractiveSizeButtonState(popupOpen);
            });
        }

        if (richHistoryPrevBtn) {
            richHistoryPrevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!richHistory.messages.length) return;
                const newIndex = richHistory.currentIndex - 1;
                if (newIndex < 0) return;
                richHistory.currentIndex = newIndex;
                renderCurrentInteractiveMessage();
            });
        }

        if (richHistoryNextBtn) {
            richHistoryNextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!richHistory.messages.length) return;
                const newIndex = richHistory.currentIndex + 1;
                if (newIndex >= richHistory.messages.length) return;
                richHistory.currentIndex = newIndex;
                renderCurrentInteractiveMessage();
            });
        }

        if (richHistoryDownloadBtn) {
            richHistoryDownloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                downloadCurrentInteractiveMessage();
            });
        }

        updateInteractiveHistoryControls(0, 0);

        return {
            panelEl,
            pollingTimer: null,
            readStatusTimer: null,
            cache: [],
            lastCursor: null,
            serverPollDelayMs: POLL_INTERVAL_MS,
            lastMessagePollAt: 0,
            lastReadStatusPollAt: 0,
            updateInteractiveHistory: syncInteractiveHistory,
            agentName,
            metadata
        };
    }

    // ─── Message loading & rendering ─────────────────────────────────────────

    async function loadTileMessages(agentId) {
        const tile = openPanels.get(agentId);
        if (!tile) return;

        try {
            const res = await fetch(`/api/user/messages/${agentId}?limit=50`);
            if (!res.ok) {
                const errorData = await window.DashboardHelpers?.readErrorPayload?.(res);
                throw window.DashboardHelpers?.buildRequestError?.(res, errorData, { fallbackMessage: 'Failed to load side chat messages' }) || new Error(String(res.status));
            }
            const data = await res.json();
            tile.serverPollDelayMs = window.DashboardHelpers?.getServerPollDelayMs?.(res, data, POLL_INTERVAL_MS) || tile.serverPollDelayMs;
            tile.cache = data.messages || [];
            tile.hasMore = data.hasMore === true;
            if (tile.cache.length) {
                tile.lastCursor = tile.cache[tile.cache.length - 1].cursor || null;
            }
            await renderTileMessages(agentId, tile.cache, false);

            // Load remaining messages in background if needed
            if (tile.hasMore) {
                loadOlderTileMessages(agentId);
            }
        } catch (err) {
            console.error('[MultiChat] Failed to load messages for', agentId, err);
            window.DashboardHelpers?.notifyRateLimit?.(err, { scope: 'tile-load-messages' });
            const msgArea = getTileMessagesEl(agentId);
            if (msgArea) msgArea.innerHTML = '<div class="chat-tile__error">Failed to load messages</div>';
        }
    }

    async function loadOlderTileMessages(agentId) {
        const tile = openPanels.get(agentId);
        if (!tile) return;
        try {
            const res = await fetch(`/api/user/messages/${agentId}`);
            if (!res.ok) return;
            const data = await res.json();
            tile.cache = data.messages || [];
            tile.hasMore = false;
            if (tile.cache.length) {
                tile.lastCursor = tile.cache[tile.cache.length - 1].cursor || null;
            }
            await renderTileMessages(agentId, tile.cache, false);
        } catch (err) {
            console.warn('[MultiChat] Failed to load older messages for', agentId, err);
        }
    }

    async function pollTileMessages(agentId) {
        const tile = openPanels.get(agentId);
        if (!tile) return;

        const now = Date.now();
        const minInterval = getAdaptiveTilePollIntervalMs();
        if (now - (tile.lastMessagePollAt || 0) < minInterval) {
            return;
        }
        tile.lastMessagePollAt = now;

        try {
            let url = `/api/user/messages/${agentId}`;
            if (tile.lastCursor) url += `?cursor=${encodeURIComponent(tile.lastCursor)}`;

            const res = await fetch(url);
            if (!res.ok) {
                const errorData = await window.DashboardHelpers?.readErrorPayload?.(res);
                const requestError = window.DashboardHelpers?.buildRequestError?.(res, errorData, { fallbackMessage: 'Failed to poll side chat messages' });
                tile.serverPollDelayMs = window.DashboardHelpers?.getServerPollDelayMs?.(
                    res,
                    errorData,
                    tile.serverPollDelayMs || getAdaptiveTilePollIntervalMs()
                ) || tile.serverPollDelayMs;
                window.DashboardHelpers?.notifyRateLimit?.(requestError, { scope: 'tile-poll-messages' });
                return;
            }
            const data = await res.json();
            const newMsgs = data.messages || [];
            tile.serverPollDelayMs = window.DashboardHelpers?.getServerPollDelayMs?.(
                res,
                data,
                newMsgs.length > 0 ? POLL_INTERVAL_MS : (tile.serverPollDelayMs || getAdaptiveTilePollIntervalMs())
            ) || tile.serverPollDelayMs;

            if (newMsgs.length > 0) {
                const existingIds = new Set(tile.cache.map(m => m.messageId));
                const fresh = newMsgs.filter(m => !existingIds.has(m.messageId));
                if (fresh.length > 0) {
                    tile.cache.push(...fresh);
                    tile.lastCursor = tile.cache[tile.cache.length - 1].cursor || tile.lastCursor;
                    await renderTileMessages(agentId, fresh, true);
                }
            }
        } catch (err) {
            // Silently ignore polling errors
        }
    }

    async function pollTileReadStatus(agentId) {
        const tile = openPanels.get(agentId);
        if (!tile) return;

        const now = Date.now();
        const minInterval = getAdaptiveTilePollIntervalMs();
        if (now - (tile.lastReadStatusPollAt || 0) < minInterval) {
            return;
        }
        tile.lastReadStatusPollAt = now;

        const msgArea = getTileMessagesEl(agentId);
        if (!msgArea) return;

        // Find all user-message elements not yet confirmed read
        const unread = msgArea.querySelectorAll('[data-tile-msg-id]:not([data-read="true"])');
        const userUnread = Array.from(unread).filter(el => {
            const bubble = el.querySelector('.chat-tile__bubble--user');
            return !!bubble;
        });

        const wrappersById = new Map();
        userUnread.forEach((wrapper) => {
            const msgId = wrapper.dataset.tileMsgId;
            if (msgId) wrappersById.set(msgId, wrapper);
        });
        const messageIds = Array.from(wrappersById.keys());
        if (messageIds.length === 0) return;

        try {
            const res = await fetch(`/api/user/messages/${agentId}/status?ids=${encodeURIComponent(messageIds.join(','))}`);
            if (!res.ok) return;
            const data = await res.json();
            const statuses = Array.isArray(data?.statuses) ? data.statuses : [];

            statuses.forEach((status) => {
                const msgId = status.messageId;
                const wrapper = wrappersById.get(msgId);
                if (!wrapper) return;

                const checkSpan = wrapper.querySelector('.message-read-indicator');
                if (!checkSpan) return;

                if (window.DashboardHelpers?.applyUserMessageDeliveryState) {
                    window.DashboardHelpers.applyUserMessageDeliveryState(wrapper, status);
                } else {
                    const read = Boolean(status.readAt);
                    if (read) wrapper.setAttribute('data-read', 'true');
                    else wrapper.removeAttribute('data-read');
                    const mode = read ? 'read' : 'delivered';
                    checkSpan.className = 'message-read-indicator message-read-indicator--' + mode;
                    checkSpan.title = read ? 'Read by agent' : 'Received by server; not yet read by agent';
                    checkSpan.textContent = '✓✓';
                }

                const cached = tile.cache.find(m => m.messageId === msgId);
                if (cached) {
                    cached.readAt = status.readAt || null;
                    cached.deliveryState = status.deliveryState || (status.readAt ? 'read' : 'pending');
                    cached.deliveryFailed = status.deliveryFailed === true;
                }
            });
        } catch (_) {
            // Silently ignore status polling errors
        }
    }

    async function renderTileMessages(agentId, messages, append) {
        const tile = openPanels.get(agentId);
        const msgArea = getTileMessagesEl(agentId);
        if (!tile || !msgArea) return;

        if (!append) {
            msgArea.innerHTML = '';
        }

        // Remove loading placeholder on first render
        const loading = msgArea.querySelector('.chat-tile__loading');
        if (loading) loading.remove();

        if (!messages || messages.length === 0) {
            if (!append) {
                msgArea.innerHTML = '<div class="chat-tile__empty">No messages yet</div>';
            }
            return;
        }

        const wasAtBottom = isScrolledToBottom(msgArea);

        for (const message of messages) {
            // Dedup
            if (msgArea.querySelector(`[data-tile-msg-id="${message.messageId}"]`)) continue;

            // Decrypt if needed
            let content = message.content || '';
            let isEncryptedPlaceholder = false;

            if (message.encrypted || looksEncrypted(content)) {
                const decrypted = await tryDecrypt(content);
                if (decrypted !== null) {
                    content = decrypted;
                } else {
                    isEncryptedPlaceholder = true;
                }
            }

            const el = createTileMessageEl({ ...message, content, isEncryptedPlaceholder });
            msgArea.appendChild(el);
        }

        // Process rich interactive messages specifically for the top space
        if (window.RichRendering) {
            // Build full rich message history in chronological order.
            const allDecrypted = await Promise.all(tile.cache.map(async (m) => {
                let text = m.content || '';
                if (m.encrypted || looksEncrypted(text)) {
                    const dec = await tryDecrypt(text);
                    text = dec || '';
                }
                return { ...m, _decryptedText: text };
            }));

            const allRichMessages = [];
            for (let i = 0; i < allDecrypted.length; i++) {
                const m = allDecrypted[i];
                if (!m._decryptedText) continue;
                const richData = window.RichRendering.detectRichContent(m._decryptedText);
                if (richData) {
                    allRichMessages.push(richData);
                }
            }

            if (tile.updateInteractiveHistory) {
                tile.updateInteractiveHistory(allRichMessages);
            }
        }

        // Auto-scroll to bottom if user was at bottom before append
        if (!append || wasAtBottom) {
            msgArea.scrollTop = msgArea.scrollHeight;
        }
    }

    function createTileMessageEl(message) {
        const wrapper = document.createElement('div');
        wrapper.dataset.tileMsgId = message.messageId;
        wrapper.className = 'chat-tile__msg-wrapper';

        const isUser = message.type === 'user_message';
        const isAgent = message.type === 'agent_message' || message.type === 'agent_question';
        const isDm = message.type === 'agent_dm_sent' || message.type === 'agent_dm_received';

        let contentHtml;
        if (message.isEncryptedPlaceholder) {
            contentHtml = `<span class="chat-tile__encrypted">🔐 Encrypted — set password to view</span>`;
        } else {
            // Check if it's a rich message. If so, render a placeholder instead of raw JSON.
            let isRich = false;
            let badge = 'Interactive Content';
            let richTitle = '';
            if (window.RichRendering) {
                const richData = window.RichRendering.detectRichContent(message.content);
                if (richData) {
                    isRich = true;
                    badge = richData.badge || 'Interactive Content';
                    if (richData.title && richData.title !== 'Agent Form') {
                        richTitle = richData.title;
                    }
                }
            }

            if (isRich) {
                const label = richTitle
                    ? `${escapeHtml(badge)}: ${escapeHtml(richTitle)}`
                    : `${escapeHtml(badge)} updated`;
                contentHtml = `<div class="chat-tile__rich-placeholder text-cyan-400 font-medium text-[10px] uppercase flex items-center gap-1.5 p-2 bg-slate-900/50 rounded-lg border border-cyan-500/30"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>${label} 📌</div>`;
            } else {
                contentHtml = renderText(message.content);
            }
        }

        const hiddenClass = message.hiddenFromAgent ? ' chat-tile__bubble--hidden-from-agent' : '';

        // Build read indicator for user messages
        const serverReceived = message.serverReceived !== false && !String(message.messageId).startsWith('opt-');
        const readIcon = isUser
            ? (window.DashboardHelpers?.buildUserMessageReadIndicator
                ? window.DashboardHelpers.buildUserMessageReadIndicator(message.readAt, message.deliveryState, message.deliveryFailed, serverReceived)
                : `<span class="message-read-indicator message-read-indicator--${message.readAt ? 'read' : serverReceived ? 'delivered' : 'pending'}" title="${message.readAt ? 'Read by agent' : serverReceived ? 'Received by server; not yet read by agent' : 'Sending to server'}">${message.readAt || serverReceived ? '✓✓' : '✓'}</span>`)
            : '';

        // Build footer with timestamp + utility buttons placeholder
        const footerHtml = `
          <div class="message-footer chat-tile__footer">
            <span class="chat-tile__ts">${formatTime(message.timestamp)}${readIcon}</span>
            <div class="message-utilities" aria-label="Message actions"></div>
          </div>`;

        if (isUser) {
            wrapper.innerHTML = `
        <div class="chat-tile__msg chat-tile__msg--user">
          <div class="chat-tile__bubble chat-tile__bubble--user${hiddenClass}">
            <div class="chat-tile__content message-content">${contentHtml}</div>
            ${footerHtml}
          </div>
        </div>`;
        } else if (isAgent) {
            wrapper.innerHTML = `
        <div class="chat-tile__msg chat-tile__msg--agent">
          <div class="chat-tile__bubble chat-tile__bubble--agent${hiddenClass}">
            <div class="chat-tile__content message-content">${contentHtml}</div>
            ${footerHtml}
          </div>
        </div>`;
        } else if (isDm) {
            const isSent = message.type === 'agent_dm_sent';
            const other = message.otherAgent || (isSent ? message.to : message.from) || '';
            wrapper.innerHTML = `
        <div class="chat-tile__msg chat-tile__msg--dm">
          <div class="chat-tile__bubble chat-tile__bubble--dm${hiddenClass}">
            <span class="chat-tile__dm-label">${isSent ? `→ ${escapeHtml(other)}` : `← ${escapeHtml(other)}`}</span>
            <div class="chat-tile__content message-content">${contentHtml}</div>
            ${footerHtml}
          </div>
        </div>`;
        } else {
            // Fallback for unknown types
            wrapper.innerHTML = `
        <div class="chat-tile__msg chat-tile__msg--agent">
          <div class="chat-tile__bubble chat-tile__bubble--agent${hiddenClass}">
            <div class="chat-tile__content message-content">${contentHtml}</div>
            ${footerHtml}
          </div>
        </div>`;
        }

        // Attach action buttons to the utilities bar
        attachTileMessageButtons(wrapper, message);
        attachTileRunCommandTimestamp(wrapper, message);

        // Render attachments (images) if present
        if (message.attachments && message.attachments.length > 0 && !message.isEncryptedPlaceholder) {
            const contentEl = wrapper.querySelector('.chat-tile__content');
            if (contentEl) {
                // Optimistic messages (opt-*) use a local blob URL as downloadUrl and have no
                // real encryption metadata yet — render them directly to avoid a decrypt error.
                const isOptimistic = String(message.messageId || '').startsWith('opt-');
                if (isOptimistic) {
                    const imgContainer = document.createElement('div');
                    imgContainer.className = 'message-attachments';
                    message.attachments.forEach(att => {
                        const isImage = String(att.contentType || '').startsWith('image/') && att.downloadUrl;
                        const isVideo = String(att.contentType || '').startsWith('video/') && att.downloadUrl;
                        if (isImage) {
                            const img = document.createElement('img');
                            img.src = att.downloadUrl;
                            img.className = 'attachment-image cursor-pointer';
                            img.alt = 'image';
                            img.style.cssText = 'max-width:200px;max-height:200px;border-radius:8px;object-fit:contain;';
                            imgContainer.appendChild(img);
                            return;
                        }
                        if (isVideo) {
                            const video = document.createElement('video');
                            video.src = att.downloadUrl;
                            video.className = 'message-attachment-video';
                            video.controls = true;
                            video.playsInline = true;
                            video.preload = 'metadata';
                            imgContainer.appendChild(video);
                            return;
                        }

                        const fileCard = document.createElement('div');
                        fileCard.className = 'message-attachment-item';
                        const fileExt = (att.fileName || '').split('.').pop()?.slice(0, 6).toUpperCase() || 'FILE';
                        fileCard.innerHTML = `
                          <div class="message-attachment-file">
                            <div class="message-attachment-file-icon">
                              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                              </svg>
                            </div>
                            <div class="message-attachment-file-meta">
                              <span class="message-attachment-file-ext">${escapeHtml(fileExt)}</span>
                              <span class="message-attachment-file-type">${escapeHtml(att.contentType || 'application/octet-stream')}</span>
                            </div>
                          </div>
                          <div class="message-attachment-info">
                            <span class="message-attachment-filename">${escapeHtml(att.fileName || 'attachment')}</span>
                          </div>`;
                        imgContainer.appendChild(fileCard);
                    });
                    contentEl.appendChild(imgContainer);
                } else if (typeof createAttachmentsContainer === 'function') {
                    const attachmentsContainer = createAttachmentsContainer(message.attachments, message.messageId);
                    contentEl.appendChild(attachmentsContainer);
                    if (typeof loadMessageAttachments === 'function') {
                        loadMessageAttachments(attachmentsContainer, message.attachments, message.messageId);
                    }
                }
            }
        }

        return wrapper;
    }

    /**
     * Attach TTS, copy, delete, and hide-from-agent buttons to a tile message.
     * Mirrors attachMessageTtsButton from dashboard.js but adapted for tile context.
     */
    function attachTileMessageButtons(wrapper, message) {
        const bubble = wrapper.querySelector('.chat-tile__bubble');
        if (!bubble) return;

        const utilities = bubble.querySelector('.message-utilities');
        if (!utilities) return;

        const contentToSpeak = (message.content || '').replace(/\s+/g, ' ').trim();
        const copyReadyContent = (message.content || '').trim();

        // ── TTS button ──
        if (contentToSpeak && !message.isEncryptedPlaceholder) {
            const ttsButton = document.createElement('button');
            ttsButton.type = 'button';
            ttsButton.className = 'message-utility-btn message-tts-btn';
            ttsButton.setAttribute('aria-label', 'Read this message aloud');
            ttsButton.title = 'Read aloud';
            ttsButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 9V15H9L14 19V5L9 9H5Z"></path>
              <path d="M16.5 8.5C17.835 9.835 17.835 14.165 16.5 15.5"></path>
              <path d="M18.5 7C20.433 8.933 20.433 15.067 18.5 17"></path>
            </svg>`;
            ttsButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (ttsButton.classList.contains('is-playing')) {
                    if (typeof window.stopActiveMessagePlayback === 'function') window.stopActiveMessagePlayback();
                    else speechSynthesis.cancel();
                    ttsButton.classList.remove('is-playing');
                    return;
                }
                if (typeof window.speakMessageText === 'function') {
                    window.speakMessageText(contentToSpeak, ttsButton);
                } else {
                    const utter = new SpeechSynthesisUtterance(contentToSpeak);
                    ttsButton.classList.add('is-playing');
                    utter.onend = () => ttsButton.classList.remove('is-playing');
                    utter.onerror = () => ttsButton.classList.remove('is-playing');
                    speechSynthesis.speak(utter);
                }
            });
            utilities.appendChild(ttsButton);
        }

        // ── Message info button ──
        if (typeof window.showMessageInfoModal === 'function') {
            const infoButton = document.createElement('button');
            infoButton.type = 'button';
            infoButton.className = 'message-utility-btn message-info-btn';
            infoButton.setAttribute('aria-label', 'Show message run information');
            infoButton.title = 'Message info';
            infoButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 11v5"></path>
              <path d="M12 8h.01"></path>
            </svg>`;
            infoButton.addEventListener('click', (e) => {
                e.stopPropagation();
                window.showMessageInfoModal(message);
            });
            utilities.appendChild(infoButton);
        }

        // ── Copy button ──
        if (copyReadyContent && !message.isEncryptedPlaceholder) {
            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.className = 'message-utility-btn message-copy-btn';
            copyButton.setAttribute('aria-label', 'Copy message text');
            copyButton.title = 'Copy';
            copyButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>`;
            copyButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await navigator.clipboard.writeText(copyReadyContent);
                    copyButton.classList.add('copied');
                    setTimeout(() => copyButton.classList.remove('copied'), 1500);
                } catch (err) {
                    console.error('[MultiChat] Copy failed:', err);
                }
            });
            utilities.appendChild(copyButton);
        }

        // ── Delete button ──
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'message-utility-btn message-delete-btn';
        deleteButton.setAttribute('aria-label', 'Delete this message');
        deleteButton.title = 'Delete';
        deleteButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>`;
        deleteButton.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Delete this message?')) return;
            // Resolve the ID at click time: a just-sent message starts with an
            // optimistic opt-* ID that is swapped for the server ID on success.
            const liveId = wrapper.dataset.tileMsgId || message.messageId;
            const removeLocally = () => {
                wrapper.style.transition = 'opacity 0.2s, transform 0.2s';
                wrapper.style.opacity = '0';
                wrapper.style.transform = 'translateX(-20px)';
                setTimeout(() => wrapper.remove(), 200);
                const agentId = wrapper.closest('.chat-tile__messages')?.dataset?.agentId;
                if (agentId && openPanels.has(agentId)) {
                    const tile = openPanels.get(agentId);
                    tile.cache = tile.cache.filter(m => m.messageId !== liveId && m.messageId !== message.messageId);
                }
            };
            if (String(liveId).startsWith('opt-')) {
                // Never persisted (send failed or still in flight) — nothing to delete server-side.
                removeLocally();
                return;
            }
            try {
                const res = await csrfFetch(`/api/user/messages/${liveId}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken }
                });
                if (!res.ok) throw new Error('Delete failed');
                removeLocally();
            } catch (err) {
                console.error('[MultiChat] Delete error:', err);
                if (window.showError) window.showError('Failed to delete message');
            }
        });
        utilities.appendChild(deleteButton);

        // ── Hide from agent toggle ──
        if (message.type === 'user_message' || message.type === 'agent_message' || message.type === 'agent_question') {
            const hideButton = document.createElement('button');
            hideButton.type = 'button';
            hideButton.className = 'message-utility-btn message-hide-btn';
            const isHidden = message.hiddenFromAgent || false;
            hideButton.dataset.hidden = isHidden ? 'true' : 'false';
            hideButton.dataset.messageId = message.messageId;
            hideButton.setAttribute('aria-label', isHidden ? 'Show to agent' : 'Hide from agent');
            hideButton.title = isHidden ? 'Show to agent' : 'Hide from agent';

            hideButton.innerHTML = `
              <div class="eye-icon-wrapper relative w-5 h-5 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full overflow-visible">
                  <circle class="pupil transition-all duration-200" cx="12" cy="12" r="3" style="transform-origin:12px 12px"></circle>
                  <path class="lid-top transition-all duration-200" d="M1 12C1 12 5 4 12 4C19 4 23 12 23 12" style="transform-origin:12px 12px"></path>
                  <path class="lid-bottom transition-all duration-200" d="M1 12C1 12 5 20 12 20C19 20 23 12 23 12" style="transform-origin:12px 12px"></path>
                  <g class="lashes transition-opacity duration-200" style="opacity:0">
                    <path d="M4 14l1 2M9 16l1 2M14 16l1 2M19 14l1 2" stroke-width="1.5"></path>
                  </g>
                </svg>
              </div>`;

            const setEyeState = (el, hidden) => {
                const pupil = el.querySelector('.pupil');
                const lidTop = el.querySelector('.lid-top');
                const lidBottom = el.querySelector('.lid-bottom');
                const lashes = el.querySelector('.lashes');
                if (hidden) {
                    pupil.style.transform = 'scale(0)'; pupil.style.opacity = '0';
                    lidTop.style.transform = 'scaleY(0.15)';
                    lidBottom.style.transform = 'scaleY(-0.15)';
                    lashes.style.opacity = '1';
                } else {
                    pupil.style.transform = 'scale(1)'; pupil.style.opacity = '1';
                    lidTop.style.transform = 'scaleY(1)';
                    lidBottom.style.transform = 'scaleY(1)';
                    lashes.style.opacity = '0';
                }
            };
            setEyeState(hideButton, isHidden);

            hideButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                const currentlyHidden = hideButton.dataset.hidden === 'true';
                const newHiddenState = !currentlyHidden;
                hideButton.dataset.hidden = newHiddenState ? 'true' : 'false';
                hideButton.setAttribute('aria-label', newHiddenState ? 'Show to agent' : 'Hide from agent');
                hideButton.title = newHiddenState ? 'Show to agent' : 'Hide from agent';
                setEyeState(hideButton, newHiddenState);

                try {
                    // Same as delete: resolve the live ID in case this message was
                    // rendered optimistically and later assigned its server ID.
                    const liveId = wrapper.dataset.tileMsgId || message.messageId;
                    const apiEndpoint = message.type === 'user_message'
                        ? `/api/user/messages/${liveId}/hidden`
                        : `/api/user/agent-messages/${liveId}/hidden`;
                    const response = await csrfFetch(apiEndpoint, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.csrfToken },
                        body: JSON.stringify({ hidden: newHiddenState })
                    });
                    if (!response.ok) throw new Error('Failed to update visibility');

                    // Update bubble styling
                    if (newHiddenState) {
                        bubble.classList.add('chat-tile__bubble--hidden-from-agent');
                    } else {
                        bubble.classList.remove('chat-tile__bubble--hidden-from-agent');
                    }

                    // Update tile cache
                    const agentId = wrapper.closest('.chat-tile__messages')?.dataset?.agentId;
                    if (agentId && openPanels.has(agentId)) {
                        const tile = openPanels.get(agentId);
                        const msg = tile.cache.find(m => m.messageId === liveId || m.messageId === message.messageId);
                        if (msg) msg.hiddenFromAgent = newHiddenState;
                    }
                } catch (err) {
                    console.error('[MultiChat] Hide toggle error:', err);
                    // Revert
                    hideButton.dataset.hidden = currentlyHidden ? 'true' : 'false';
                    setEyeState(hideButton, currentlyHidden);
                    if (window.showError) window.showError('Failed to update message visibility');
                }
            });
            utilities.appendChild(hideButton);
        }
    }

    function attachTileRunCommandTimestamp(wrapper, message) {
        if (!wrapper || !message?.runCommand) return;

        const timestamp = wrapper.querySelector('.chat-tile__ts');
        if (!timestamp) return;

        timestamp.classList.add('message-timestamp--interactive');
        timestamp.setAttribute('role', 'button');
        timestamp.setAttribute('tabindex', '0');
        timestamp.setAttribute('title', 'Show the exact command this agent ran');
        timestamp.setAttribute('aria-label', 'Show the exact command this agent ran');

        const openModal = (event) => {
            event?.stopPropagation?.();
            if (typeof window.showRunCommandModal === 'function') {
                window.showRunCommandModal(message);
            }
        };

        timestamp.addEventListener('click', openModal);
        timestamp.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openModal(event);
        });
    }

    // ─── Sending ──────────────────────────────────────────────────────────────

    async function sendTileMessage(agentId, text, attachmentIds = [], pendingImages = []) {
        const tile = openPanels.get(agentId);
        if (!tile) return false;

        let contentToSend = text || null;
        let isEncrypted = false;
        const encryptionKey = window.DashboardHelpers?.getEncryptionKey?.();

        if (text && encryptionKey) {
            try {
                contentToSend = await window.E2EEncryption.encryptMessage(text, encryptionKey);
                isEncrypted = true;
            } catch (err) {
                console.error('[MultiChat] Text encryption failed:', err);
                return false;
            }
        }

        // Optimistic render (we use standard placeholders since the true attachment URL needs decrypt keys)
        const optimisticMsg = {
            messageId: `opt-${Date.now()}`,
            serverReceived: false, deliveryState: 'sending',
            type: 'user_message',
            content: isEncrypted ? contentToSend : text,
            encrypted: isEncrypted,
            timestamp: new Date().toISOString(),
            readAt: null,
            attachments: pendingImages.map(img => ({
                attachmentId: img.attachmentId,
                contentType: img.file.type,
                encryption: {}, // Placeholder
                fileName: img.file.name,
                downloadUrl: img.previewUrl // Use local preview URL for optimistic render
            }))
        };
        await renderTileMessages(agentId, [optimisticMsg], true);

        try {
            const reqBody = { agentId, encrypted: isEncrypted };
            if (contentToSend) reqBody.content = contentToSend;
            if (attachmentIds && attachmentIds.length > 0) reqBody.attachmentIds = attachmentIds;

            const res = await csrfFetch(`/api/user/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.csrfToken
                },
                credentials: 'same-origin',
                body: JSON.stringify(reqBody),
            });

            if (!res.ok) {
                const errorData = await window.DashboardHelpers?.readErrorPayload?.(res);
                const requestError = window.DashboardHelpers?.buildRequestError?.(res, errorData, { fallbackMessage: 'Failed to send message' }) || new Error(`Failed to send message (${res.status})`);
                console.error('[MultiChat] Failed to send message:', res.status, requestError.message);
                // Remove optimistic element
                const msgArea = getTileMessagesEl(agentId);
                const opt = msgArea?.querySelector(`[data-tile-msg-id="${optimisticMsg.messageId}"]`);
                opt?.remove();
                window.DashboardHelpers?.notifyRateLimit?.(requestError, { scope: 'tile-send-message', title: 'Send Delayed' });
                if (!requestError.isRateLimit && window.showError) {
                    window.showError(requestError.message || 'Failed to send message.');
                }
                return false;
            } else {
                // Replace optimistic ID with real server ID so poll dedup catches it
                const result = await res.json();
                if (result.messageId) {
                    const msgArea = getTileMessagesEl(agentId);
                    const opt = msgArea?.querySelector(`[data-tile-msg-id="${optimisticMsg.messageId}"]`);
                    if (opt) opt.dataset.tileMsgId = result.messageId;
                    // Mutate in place: the tile's delete/hide button handlers hold a
                    // reference to this object, so they must see the real server ID —
                    // deleting with the stale opt-* ID makes the API return 400.
                    optimisticMsg.messageId = result.messageId;
                    optimisticMsg.serverReceived = true;
                    optimisticMsg.deliveryState = 'delivered';
                    if (opt) {
                        if (window.DashboardHelpers?.applyUserMessageDeliveryState) {
                            window.DashboardHelpers.applyUserMessageDeliveryState(opt, optimisticMsg);
                        } else {
                            const receipt = opt.querySelector('.message-read-indicator');
                            if (receipt) {
                                receipt.className = 'message-read-indicator message-read-indicator--delivered';
                                receipt.dataset.receiptState = 'delivered';
                                receipt.textContent = '✓✓';
                                receipt.title = 'Received by server; not yet read by agent';
                                receipt.setAttribute('role', 'img');
                                receipt.setAttribute('aria-label', receipt.title);
                            }
                        }
                    }
                    // Add to cache so polling dedup skips this message
                    tile.cache.push({ ...optimisticMsg });
                }
                return true;
            }
        } catch (err) {
            console.error('[MultiChat] Send error:', err);
            const msgArea = getTileMessagesEl(agentId);
            const opt = msgArea?.querySelector(`[data-tile-msg-id="${optimisticMsg.messageId}"]`);
            opt?.remove();
            if (window.showError) window.showError(err.message || 'Failed to send message.');
            return false;
        }
        return false;
    }

    // ─── Utilities ────────────────────────────────────────────────────────────

    function getTileMessagesEl(agentId) {
        return document.querySelector(`.chat-tile__messages[data-agent-id="${agentId}"]`);
    }

    function isScrolledToBottom(el) {
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    }

    function updateContainerVisibility() {
        const c = getContainer();
        if (!c) return;
        const dashboardGrid = c.closest('.dashboard-main-grid');
        if (openPanels.size > 0) {
            c.classList.remove('multi-chat-container--empty');
            dashboardGrid?.classList.add('dashboard-main-grid--multi-open');
        } else {
            c.classList.add('multi-chat-container--empty');
            dashboardGrid?.classList.remove('dashboard-main-grid--multi-open');
        }

        syncTileSizing();
        requestAnimationFrame(syncTileSizing);
    }

    // Re-check widths on resize; keep all open panels.
    window.addEventListener('resize', () => {
        updateContainerVisibility();
        requestAnimationFrame(syncTileSizing);
    });

    document.addEventListener('visibilitychange', () => {
        rescheduleAllTileTimers();
    });

    // ─── Persistence ──────────────────────────────────────────────────────────
    function saveOpenPanels() {
        const panels = [];
        for (const [id, tile] of openPanels.entries()) {
            panels.push({
                agentId: id,
                agentName: tile.agentName,
                metadata: tile.metadata
            });
        }
        localStorage.setItem('multiChat_openPanels', JSON.stringify(panels));
    }

    /**
     * Save the current tile order from the DOM.
     * Called after manually reordering tiles (e.g., via Ctrl+Shift+Arrow).
     */
    function saveChatTileOrder() {
        const c = getContainer();
        if (!c) return;
        const tiles = Array.from(c.querySelectorAll(':scope > .chat-tile[data-agent-id]'));
        const order = tiles.map(t => t.getAttribute('data-agent-id')).filter(Boolean);
        localStorage.setItem('multiChat_tileOrder', JSON.stringify(order));
    }

    function restoreOpenPanels() {
        updateContainerVisibility();
        try {
            const saved = localStorage.getItem('multiChat_openPanels');
            if (!saved) return;
            const panels = JSON.parse(saved);

            // Get the saved tile order if available
            let savedOrder = [];
            try {
                const orderStr = localStorage.getItem('multiChat_tileOrder');
                if (orderStr) {
                    savedOrder = JSON.parse(orderStr);
                }
            } catch (e) {
                // Ignore order restore errors
            }

            // If we have a saved order, restore in that order
            if (savedOrder.length > 0) {
                // Create a map for quick lookup
                const panelMap = new Map(panels.map(p => [p.agentId, p]));

                // Restore in saved order, skip any that are no longer in the panels list
                for (const agentId of savedOrder) {
                    const p = panelMap.get(agentId);
                    if (p) {
                        openSidePanel(p.agentId, p.agentName, p.metadata);
                    }
                }

                // Restore any panels that weren't in the order (shouldn't happen normally)
                for (const p of panels) {
                    if (!savedOrder.includes(p.agentId)) {
                        openSidePanel(p.agentId, p.agentName, p.metadata);
                    }
                }
            } else {
                // No saved order, use the original order from panels
                for (const p of panels) {
                    openSidePanel(p.agentId, p.agentName, p.metadata);
                }
            }
            updateContainerVisibility();
        } catch (e) {
            console.error('[MultiChat] Failed to restore open panels', e);
            updateContainerVisibility();
        }
    }

    /**
     * Sync working indicators on all open side-panel tiles.
     * Called from dashboard.js during agent list polling.
     */
    function syncWorkingStatus(agents) {
        if (!Array.isArray(agents)) return;
        const agentMap = new Map(agents.map(a => [a.agentId, a]));
        for (const [agentId, tile] of openPanels) {
            const agent = agentMap.get(agentId);
            const indicator = tile.panelEl.querySelector('.chat-tile__working-indicator');
            if (!indicator) continue;
            if (agent && agent.isWorking === true) {
                indicator.style.display = '';
                const fmt = window.DashboardHelpers?.formatRelativeTime;
                indicator.title = agent.lastWorkingHeartbeatTime && fmt
                    ? `Working \u2022 heartbeat ${fmt(agent.lastWorkingHeartbeatTime)}`
                    : 'Agent is working...';
            } else {
                indicator.style.display = 'none';
            }
        }
    }

    async function refreshAllPanels() {
        for (const [agentId, tile] of openPanels) {
            if (!tile) continue;
            try {
                await renderTileMessages(agentId, tile.cache || [], false);
            } catch (error) {
                console.error('[MultiChat] Failed to refresh panel after encryption update:', agentId, error);
            }
        }
    }

    // ─── Export ───────────────────────────────────────────────────────────────
    window.MultiChatManager = {
        openSidePanel,
        closeSidePanel,
        isOpen,
        getOpenPanelCount: () => openPanels.size,
        syncWorkingStatus,
        refreshAllPanels,
        saveChatTileOrder
    };

    // Init restore
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restoreOpenPanels);
    } else {
        restoreOpenPanels();
    }
})();
