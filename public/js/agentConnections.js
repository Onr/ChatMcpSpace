/**
 * agentConnections.js
 * Frontend module for rendering inter-agent communication lines and chat list on the dashboard
 */

(function () {
    'use strict';

    // Configuration
    const CONFIG = {
        pollIntervalMs: 30000,  // Poll every 30 seconds
        hoursToShow: 24,        // Show messages from last 24 hours for chat list
        lineHoursToShow: 1,     // Show lines from last 1 hour
        lineColor: 'rgba(56, 189, 248, 0.6)',  // Sky-400 with opacity
        lineColorActive: 'rgba(56, 189, 248, 0.9)',
        lineWidth: 2,
        lineWidthActive: 3,
        dashArray: '6,4',
        animationDuration: 1000
    };

    let resizeObserver = null;
    let renderFrame = null;
    function scheduleRender() {
        if (renderFrame !== null) return;
        renderFrame = requestAnimationFrame(() => { renderFrame = null; renderConnections(); });
    }
    let pollTimer = null;
    let currentConnections = [];
    let currentMessages = [];
    let activeConversation = null;  // { agent1Id, agent2Id }
    let eventHandlersBound = false;

    /**
     * Initialize the agent connections module
     */
    function init() {
        // Create SVG container for connection lines if it doesn't exist
        ensureSvgContainer();

        // Bind event handlers
        if (!eventHandlersBound) {
            bindEventHandlers();
            eventHandlersBound = true;
        }

        window.addEventListener('council:layout', scheduleRender);
        window.addEventListener('resize', scheduleRender);
        if (window.ResizeObserver && !resizeObserver) {
            resizeObserver = new ResizeObserver(scheduleRender);
            const circle = document.getElementById('councilCircle');
            if (circle) resizeObserver.observe(circle);
        }
        // Initial fetch
        fetchAndRenderConnections();

        // Start polling
        if (pollTimer) {
            clearInterval(pollTimer);
        }
        pollTimer = setInterval(fetchAndRenderConnections, CONFIG.pollIntervalMs);

        console.log('[AgentConnections] Initialized with chat panel support');
    }

    /**
     * Bind event handlers for the Agent Chats panel
     */
    function bindEventHandlers() {
        // Refresh button
        const refreshBtn = document.getElementById('agentChatsRefresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                refreshBtn.classList.add('animate-spin');
                fetchAndRenderConnections().then(() => {
                    setTimeout(() => refreshBtn.classList.remove('animate-spin'), 300);
                });
            });
        }
    }

    /**
     * Ensure the SVG container exists in the council chamber
     */
    function ensureSvgContainer() {
        const councilCircle = document.getElementById('councilCircle');
        if (!councilCircle) {
            console.warn('[AgentConnections] Council circle not found');
            return;
        }

        let svg = document.getElementById('agentConnectionLines');
        if (!svg) {
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = 'agentConnectionLines';
            svg.setAttribute('class', 'absolute inset-0 w-full h-full pointer-events-none');
            svg.setAttribute('style', 'z-index: 5;');

            // Add gradient definition for line styling
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            defs.innerHTML = `
        <marker id="a2aArrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a5f3fc"/></marker>
        <linearGradient id="agentConnectionGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:rgba(56, 189, 248, 0.3);stop-opacity:1" />
          <stop offset="50%" style="stop-color:rgba(56, 189, 248, 0.8);stop-opacity:1" />
          <stop offset="100%" style="stop-color:rgba(56, 189, 248, 0.3);stop-opacity:1" />
        </linearGradient>
        <filter id="connectionGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      `;
            svg.appendChild(defs);

            // Insert before agent seats but after other background elements
            councilCircle.insertBefore(svg, councilCircle.firstChild);
        }
    }

    /**
     * Fetch agent connections from API and render them
     */
    async function fetchAndRenderConnections() {
        if (document.hidden) return;
        try {
            const response = await fetch(`/api/user/agent-messages?hours=${CONFIG.hoursToShow}`, {
                credentials: 'same-origin'
            });

            if (!response.ok) {
                if (response.status === 401) {
                    // Not authenticated, stop polling
                    if (pollTimer) {
                        clearInterval(pollTimer);
                        pollTimer = null;
                    }
                    return;
                }
                console.warn('[AgentConnections] Failed to fetch:', response.status);
                return;
            }

            const data = await response.json();
            currentConnections = data.connections || [];
            currentMessages = data.messages || [];
            window.CouncilSharing?.updateConnections(currentConnections);

            renderConnections();
            renderChatsList();
            // Refresh receipts without replacing the user's reading position.
            if (activeConversation) {
                const byId = new Map(currentMessages.map(msg => [msg.messageId, msg]));
                document.querySelectorAll('[data-direct-message-id]').forEach(bubble => {
                    const msg = byId.get(bubble.dataset.directMessageId);
                    const receipt = bubble.querySelector('.agent-dm-receipt');
                    if (msg && receipt) receipt.textContent = deliveryLabel(msg);
                });
            }

        } catch (error) {
            console.warn('[AgentConnections] Error fetching connections:', error);
        }
    }

    /**
     * Get the center position of an agent seat element
     */
    function getAgentPosition(agentId, positions) {
        return positions.get(agentId) || null;
    }

    // Use the normal to the segment: opposite seats remain finite and curves
    // have consistent direction even when the midpoint is the circle center.
    function createCurvedPath(x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        return `M ${x1} ${y1} Q ${(x1 + x2) / 2 - dy * .18} ${(y1 + y2) / 2 + dx * .18} ${x2} ${y2}`;
    }

    function renderConnections() {
        ensureSvgContainer();
        const svg = document.getElementById('agentConnectionLines');
        const circle = document.getElementById('councilCircle');
        if (!svg || !circle) return;
        svg.querySelectorAll('.a2a-link').forEach(el => el.remove());
        const bounds = circle.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        // Pixel coordinates keep strokes and arrowheads proportional on narrow panels.
        svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        const positions = window.CouncilSharing?.positions(circle, bounds) || new Map();
        circle.querySelectorAll('.agent-seat[data-agent-id]').forEach(seat => {
            const ball = seat.querySelector('.agent-avatar') || seat;
            const rect = ball.getBoundingClientRect();
            if (rect.width && rect.height) positions.set(seat.dataset.agentId, {
                x: rect.left + rect.width / 2 - bounds.left,
                y: rect.top + rect.height / 2 - bounds.top,
                key: 'agent:' + seat.dataset.agentId
            });
        });
        const cutoff = Date.now() - CONFIG.lineHoursToShow * 3600000;
        const routes = new Map();
        currentConnections.filter(c => new Date(c.lastMessage).getTime() > cutoff).forEach(conn => {
            const reverse = conn.lastSenderId === conn.agent2Id;
            const from = getAgentPosition(reverse ? conn.agent2Id : conn.agent1Id, positions);
            const to = getAgentPosition(reverse ? conn.agent1Id : conn.agent2Id, positions);
            if (!from || !to || from.key === to.key) return;
            const key = [from.key, to.key].sort().join('|');
            const selected = activeConversation && [conn.agent1Id,conn.agent2Id].includes(activeConversation.agent1Id) && [conn.agent1Id,conn.agent2Id].includes(activeConversation.agent2Id);
            const existing = routes.get(key);
            if (existing) { existing.count += conn.messageCount; existing.pairs++; existing.selected ||= selected; return; }
            routes.set(key, {from, to, count: conn.messageCount, pairs: 1, selected});
        });
        // Bound SVG work even in a busy workspace. No per-frame JS or blur filters.
        [...routes.values()].slice(0, 80).forEach(route => {
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('class', 'a2a-link' + (route.selected ? ' a2a-link--selected' : ''));
            const title = document.createElementNS(svg.namespaceURI, 'title');
            title.textContent = `${route.count} messages · ${route.pairs} agent connection${route.pairs === 1 ? '' : 's'}`;
            group.appendChild(title);
            const d = createCurvedPath(route.from.x, route.from.y, route.to.x, route.to.y);
            for (const kind of ['track', 'flow']) {
                const path = document.createElementNS(svg.namespaceURI, 'path');
                path.setAttribute('d', d);
                path.setAttribute('class', `a2a-link__${kind}`);
                path.setAttribute('fill', 'none');
                if (kind === 'flow') path.setAttribute('marker-end', 'url(#a2aArrow)');
                group.appendChild(path);
            }
            if (svg.querySelectorAll('.a2a-link__packet').length < 12) {
                const packet = document.createElementNS(svg.namespaceURI, 'circle');
                packet.setAttribute('class', 'a2a-link__packet');
                packet.setAttribute('r', '2.5');
                packet.style.offsetPath = `path('${d}')`;
                group.appendChild(packet);
            }
            svg.appendChild(group);
        });
        updateConnectionBadge();
    }

    /**
     * Render the Agent Chats panel list
     */
    function renderChatsList() {
        const scrollContainer = document.getElementById('agentChatsScroll');
        const countBadge = document.getElementById('agentChatsCount');
        const emptyState = document.getElementById('agentChatsEmpty');

        if (!scrollContainer) return;

        // Clear existing items (keep empty state element)
        scrollContainer.querySelectorAll('.agent-chat-item').forEach(el => el.remove());

        // Update count badge
        if (countBadge) {
            countBadge.textContent = currentConnections.length;
        }

        // Show/hide empty state
        if (emptyState) {
            emptyState.style.display = currentConnections.length === 0 ? 'flex' : 'none';
        }

        // Sort connections by most recent message
        const sortedConnections = [...currentConnections].sort((a, b) =>
            new Date(b.lastMessage) - new Date(a.lastMessage)
        );

        // Create chat items
        sortedConnections.forEach(conn => {
            const item = createChatItem(conn);
            scrollContainer.appendChild(item);
        });
    }

    /**
     * Create a chat item element for a connection
     */
    function createChatItem(conn) {
        const item = document.createElement('div');
        item.className = 'agent-chat-item';
        item.dataset.agent1Id = conn.agent1Id;
        item.dataset.agent2Id = conn.agent2Id;

        // Check if this is the active conversation
        if (activeConversation &&
            ((activeConversation.agent1Id === conn.agent1Id && activeConversation.agent2Id === conn.agent2Id) ||
                (activeConversation.agent1Id === conn.agent2Id && activeConversation.agent2Id === conn.agent1Id))) {
            item.classList.add('agent-chat-item--active');
        }

        // Format relative time
        const timeAgo = formatRelativeTime(conn.lastMessage);

        item.innerHTML = `
            <div class="agent-chat-avatars">
                <div class="agent-chat-avatar">${escapeHtml(conn.agent1Name.substring(0, 2).toUpperCase())}</div>
                <div class="agent-chat-avatar">${escapeHtml(conn.agent2Name.substring(0, 2).toUpperCase())}</div>
            </div>
            <div class="agent-chat-info">
                <div class="agent-chat-names">
                    ${escapeHtml(conn.agent1Name)}<span class="agent-chat-separator">↔</span>${escapeHtml(conn.agent2Name)}
                </div>
                <div class="agent-chat-meta">
                    <span class="agent-chat-count">${conn.messageCount} message${conn.messageCount !== 1 ? 's' : ''}${conn.pendingCount ? ` · ${conn.pendingCount} pending` : ''}</span>
                    <span class="agent-chat-time">${timeAgo}</span>
                </div>
            </div>
            ${conn.messageCount > 0 ? `<span class="agent-chat-badge">${conn.messageCount}</span>` : ''}
        `;

        // Click handler to show conversation
        item.addEventListener('click', () => {
            showConversation(conn);
        });

        return item;
    }

    /**
     * Show a conversation between two agents in the message panel
     */
    function showConversation(conn) {
        activeConversation = { agent1Id: conn.agent1Id, agent2Id: conn.agent2Id };
        scheduleRender();

        // Update active state in list
        document.querySelectorAll('.agent-chat-item').forEach(el => {
            el.classList.remove('agent-chat-item--active');
        });
        const activeItem = document.querySelector(
            `.agent-chat-item[data-agent1-id="${conn.agent1Id}"][data-agent2-id="${conn.agent2Id}"]`
        );
        if (activeItem) {
            activeItem.classList.add('agent-chat-item--active');
        }

        // Filter messages for this conversation
        const conversationMessages = currentMessages.filter(msg =>
            (msg.senderId === conn.agent1Id && msg.recipientId === conn.agent2Id) ||
            (msg.senderId === conn.agent2Id && msg.recipientId === conn.agent1Id)
        ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Show in message panel
        displayAgentConversation(conn, conversationMessages);
    }

    let cachedAgentEncryptionKey = null;
    let cachedAgentEncryptionKeyLoaded = false;

    async function getAgentEncryptionKey() {
        if (cachedAgentEncryptionKeyLoaded) return cachedAgentEncryptionKey;
        cachedAgentEncryptionKeyLoaded = true;
        if (window.E2EEncryption && typeof window.E2EEncryption.getStoredEncryptionKey === 'function') {
            cachedAgentEncryptionKey = await window.E2EEncryption.getStoredEncryptionKey();
        }
        return cachedAgentEncryptionKey;
    }

    function looksLikeEncryptedTextForAgent(text) {
        if (typeof window.looksLikeEncryptedText === 'function') {
            return window.looksLikeEncryptedText(text);
        }
        if (!text || typeof text !== 'string') return false;
        const parts = text.trim().split(':');
        if (parts.length !== 3) return false;
        const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
        return parts.every(part => base64Pattern.test(part) && part.length > 0);
    }

    /**
     * Display agent conversation in the message panel
     */
    async function displayAgentConversation(conn, messages) {
        const header = document.getElementById('agentPanelHeader');
        const conversationArea = document.getElementById('conversationArea');
        const inputBox = document.getElementById('agentInputBox');

        if (!header || !conversationArea) return;

        // Update header
        header.classList.remove('hidden');
        header.innerHTML = `
            <div class="flex items-start gap-3">
                <div class="flex -space-x-2">
                    <div class="w-10 h-10 rounded-full bg-cyan-900/50 border-2 border-slate-800 flex items-center justify-center text-sm font-bold text-cyan-300">
                        ${escapeHtml(conn.agent1Name.substring(0, 2).toUpperCase())}
                    </div>
                    <div class="w-10 h-10 rounded-full bg-cyan-900/50 border-2 border-slate-800 flex items-center justify-center text-sm font-bold text-cyan-300">
                        ${escapeHtml(conn.agent2Name.substring(0, 2).toUpperCase())}
                    </div>
                </div>
                <div class="flex-1 min-w-0">
                    <h2 class="text-sm font-bold text-white truncate">
                        ${escapeHtml(conn.agent1Name)} ↔ ${escapeHtml(conn.agent2Name)}
                    </h2>
                    <p class="text-xs text-cyan-400">Agent-to-Agent Chat • ${messages.length} messages</p>
                </div>
                <button id="closeAgentChat" class="p-2 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-700/50">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        `;

        // Bind close button
        document.getElementById('closeAgentChat').addEventListener('click', () => {
            closeAgentConversation();
        });

        // Render messages
        conversationArea.innerHTML = '';

        if (messages.length === 0) {
            conversationArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-slate-500 text-sm">
                    No messages in this conversation yet
                </div>
            `;
        } else {
            const encryptionKey = await getAgentEncryptionKey();
            const decryptedMessages = [];

            for (const msg of messages) {
                let messageIsEncrypted = msg.content === null && msg.encrypted === true;
                if (msg.content && typeof msg.content === 'string' && looksLikeEncryptedTextForAgent(msg.content)) {
                    if (encryptionKey && window.E2EEncryption && typeof window.E2EEncryption.decryptMessage === 'function') {
                        try {
                            const parts = msg.content.split(':');
                            if (parts.length === 3) {
                                msg.content = await window.E2EEncryption.decryptMessage(msg.content, encryptionKey);
                                msg.wasEncrypted = true;
                            }
                        } catch (e) {
                            messageIsEncrypted = true;
                        }
                    } else {
                        messageIsEncrypted = true;
                    }
                }

                if (messageIsEncrypted) {
                    msg.content = '🔐';
                    msg.isEncryptedPlaceholder = true;
                }

                decryptedMessages.push(msg);
            }

            decryptedMessages.forEach(msg => {
                const bubble = createMessageBubble(msg, conn);
                conversationArea.appendChild(bubble);
            });

            // Scroll to bottom
            conversationArea.scrollTop = conversationArea.scrollHeight;
        }

        // Hide input box (read-only view for agent chats)
        if (inputBox) {
            inputBox.dataset.originalDisplay = inputBox.style.display;
            inputBox.style.display = 'none';
        }
    }

    /**
     * Create a message bubble for an agent message
     */
    function createMessageBubble(msg, conn) {
        const isFromAgent1 = msg.senderId === conn.agent1Id;
        const senderName = isFromAgent1 ? conn.agent1Name : conn.agent2Name;

        const bubble = document.createElement('div');
        bubble.className = `message-bubble p-3 mb-3 ${isFromAgent1 ? '' : 'message-bubble--user'}`;
        bubble.dataset.directMessageId = msg.messageId;

        const priorityClass = msg.priority === 2 ? 'priority-high' :
            msg.priority === 1 ? 'priority-normal' : 'priority-low';
        bubble.classList.add(priorityClass);

        const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let contentHtml;
        if (msg.isEncryptedPlaceholder) {
            const buttonHtml = typeof window.showDecryptionPasswordModal === 'function'
                ? '<button type="button" class="encrypted-set-password-btn" onclick="showDecryptionPasswordModal()">Set Password to Decrypt</button>'
                : '';
            contentHtml = `
                <div class="encrypted-message-placeholder">
                    <div class="encrypted-message-icon">🔐</div>
                    <div class="encrypted-message-text">
                        <span class="encrypted-message-title">Encrypted Message</span>
                        ${buttonHtml}
                    </div>
                </div>
            `;
        } else {
            contentHtml = escapeHtml(msg.content || '[Encrypted message]');
        }

        const receipt = deliveryLabel(msg);
        bubble.innerHTML = `
            <div class="message-header">
                <p class="message-title text-xs font-semibold text-cyan-300">${escapeHtml(senderName)}</p>
                <span class="text-[10px] text-slate-500">${time}</span>
            </div>
            <div class="message-content text-sm text-slate-200">
                ${contentHtml}
            </div>
            <div class="agent-dm-receipt message-footer text-xs text-slate-400" role="status">${receipt}</div>
            ${msg.wasEncrypted ? '<div class="message-footer" style="margin-top:0.4rem"><span class="encrypted-badge" title="This message was sent encrypted">🔒 Encrypted</span></div>' : ''}
        `;

        return bubble;
    }

    function deliveryLabel(msg) {
        if (msg.delivery?.state === 'received') return 'Received by agent';
        if (msg.delivery?.state !== 'pending') return '';
        return msg.delivery.recipientOnline === false ? 'Queued · recipient offline' : 'Waiting for agent receipt';
    }

    /**
     * Close the agent conversation view and return to normal state
     */
    function closeAgentConversation() {
        activeConversation = null;
        scheduleRender();

        // Remove active state from list
        document.querySelectorAll('.agent-chat-item--active').forEach(el => {
            el.classList.remove('agent-chat-item--active');
        });

        // Hide header
        const header = document.getElementById('agentPanelHeader');
        if (header) {
            header.classList.add('hidden');
        }

        // Clear conversation area
        const conversationArea = document.getElementById('conversationArea');
        if (conversationArea) {
            conversationArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-slate-500 text-sm">
                    Select an agent or agent chat to view messages
                </div>
            `;
        }

        // Restore input box
        const inputBox = document.getElementById('agentInputBox');
        if (inputBox && inputBox.dataset.originalDisplay !== undefined) {
            inputBox.style.display = inputBox.dataset.originalDisplay || '';
            delete inputBox.dataset.originalDisplay;
        }
    }

    /**
     * Format relative time string
     */
    function formatRelativeTime(timestamp) {
        const now = new Date();
        const then = new Date(timestamp);
        const diffMs = now - then;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
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
     * Update the connection count badge in the UI
     */
    function updateConnectionBadge() {
        const badge = document.getElementById('agentConnectionCount');
        if (badge) {
            const count = currentConnections.length;
            badge.textContent = count;
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
    }

    /**
     * Manual refresh of connections
     */
    function refresh() {
        return fetchAndRenderConnections();
    }

    /**
     * Get current connections data
     */
    function getConnections() {
        return currentConnections;
    }

    /**
     * Stop polling
     */
    function destroy() {
        window.removeEventListener('council:layout', scheduleRender);
        window.removeEventListener('resize', scheduleRender);
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (renderFrame !== null) cancelAnimationFrame(renderFrame);
        renderFrame = null;
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // Expose module to window
    window.AgentConnections = {
        init,
        refresh,
        getConnections,
        renderConnections,
        destroy,
        showConversation,
        closeConversation: closeAgentConversation
    };

    // Auto-initialize when DOM is ready
    const shouldAutoInit = !window.__dashboardLoopPaused;
    if (shouldAutoInit) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            // DOM already loaded
            setTimeout(init, 100);
        }
    } else {
        console.log('[AgentConnections] Auto-init skipped (dashboard loop paused)');
    }

})();
