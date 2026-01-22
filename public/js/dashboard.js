/**
 * Dashboard JavaScript
 * Handles agent list polling, message polling, agent selection, and option selection
 */

// State management
let agentPollingInterval = null;
let messagePollingInterval = null;
let selectedAgentId = null;
let selectedAgentName = '';
let selectedAgentType = 'standard'; // 'standard' or 'news_feed'
let lastMessageTimestamp = null;
let lastMessageCursor = null;
let isLoadingMessages = false; // Flag to prevent polling during message reload
let userMessageForm = null;
let userMessageInput = null;
let userMessageSendButton = null;
let voiceToggleBtn = null;
let voiceInputBtn = null;
let encryptionKey = null; // Store the derived key
let voiceNotificationState = {
  ready: false,
  preferredVoice: null,
  audioUnlocked: false,
  autoplayBlockedNotified: false
};
let lastNotifiedAgentMessage = new Map();
let agentScrollPositions = new Map(); // Store scroll positions for each agent
let focusedAgentIndex = -1; // Track focused agent for keyboard navigation
let previousFocusedIndex = -1; // Track previous index for animation direction
let conversationCache = new Map(); // Cache conversations to avoid redundant API calls
let numberInputBuffer = ''; // Buffer for two-digit number input
let numberInputTimeout = null; // Timeout for resetting number buffer
let agentListCache = { agents: [], timestamp: 0 }; // Cache agent list to avoid redundant API calls
const AGENT_CACHE_TTL = 3000; // Agent cache time-to-live in milliseconds
let knownAgentIds = new Set(); // Track known agent IDs to detect new agents
let initialAgentLoadComplete = false; // Flag to skip the very first poll but allow subsequent new agents
let newAgentIds = new Set(); // Track newly added agents for animation
let pendingResponseAgents = new Set(); // Track agents waiting for response (show construction sign)
let activeTtsButton = null; // Track currently playing TTS button for animation cleanup
let currentFocusArea = 'council'; // Track current focus area: 'council' | 'list' | 'conversation'
let activeTtsUtterance = null; // Track active SpeechSynthesisUtterance instance
let globalNotifiedMessages = new Set(); // Track message IDs globally to prevent duplicate TTS across agents
let ttsAudioLock = false; // Prevent overlapping TTS audio playback
let pendingTtsQueue = []; // Queue TTS requests when audio is locked
const GLOBAL_NOTIFICATION_TTL = 300000; // Clear global notification tracking after 5 minutes
const NOTIFIED_MESSAGES_STORAGE_KEY = 'dashboard_notified_messages'; // sessionStorage key
const LAST_AGENT_STORAGE_KEY = 'dashboard_last_agent_id'; // localStorage key for last opened agent
let currentAgentList = []; // Latest agent list snapshot for orbit layout
let currentOrbitLayout = null; // Computed orbit layout for drag/drop
let orbitDragState = null; // Active drag state for orbit seats
let suppressSeatClickUntil = 0; // Prevent click selection after dragging
let orbitDragHandlersInitialized = false; // Ensure drag handlers are attached once
let pendingImages = []; // Array of {file, previewUrl, status, attachmentId, error} for image uploads
let isUploadingImages = false; // Flag to track if images are currently being uploaded
const MAX_IMAGES_PER_MESSAGE = 10; // Maximum images allowed per message
let lastAgentRestorationAttempted = false; // Flag to ensure we only try to restore once on page load
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

/**
 * Initialize dashboard when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', async () => {
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

  // Start polling agent list
  startAgentPolling();

  // Attempt to restore last opened agent after a short delay to ensure agent list is loaded
  setupLastAgentRestoration();

  // Set up agent selection handlers
  setupAgentSelectionHandlers();

  // Setup drag-to-reposition for orbital seats
  setupOrbitDragHandlers();

  // Prepare the free-text composer
  setupMessageComposer();

  // Setup agent control buttons (stop, config)
  setupAgentControls();

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

  // Setup TTS keyboard shortcuts
  setupMessageTtsShortcuts();

  // Initialize mobile dock
  initializeMobileDock();

  // Initialize feedback widget
  // Feedback widget initialized by feedback.js


  // Setup mobile stats toggle
  const mobileStatsToggle = document.getElementById('mobileStatsToggle');
  const agentListPanel = document.getElementById('agentListPanel');

  if (mobileStatsToggle && agentListPanel) {
    mobileStatsToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileListExpanded();
    });
  }

  // Stop polling when user navigates away
  window.addEventListener('beforeunload', () => {
    stopAgentPolling();
    stopMessagePolling();
  });

  // Re-render agents on window resize to recalculate sphere sizes
  let resizeTimeout = null;
  window.addEventListener('resize', () => {
    // Debounce resize handler
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      if (currentAgentList.length > 0) {
        updateAgentListUI(currentAgentList);
      }
    }, 150);
  });
});

/**
 * Start polling agent list every 3 seconds
 */
function startAgentPolling() {
  // Poll immediately
  pollAgentList();

  // Set up interval for polling every 3 seconds
  agentPollingInterval = setInterval(() => {
    pollAgentList();
  }, 3000);
}

/**
 * Stop polling agent list
 */
function stopAgentPolling() {
  if (agentPollingInterval) {
    clearInterval(agentPollingInterval);
    agentPollingInterval = null;
  }
}

/**
 * Poll agent list from API and update UI
 * @param {boolean} force - Force fetch from server, bypassing cache
 */
async function pollAgentList(force = false) {
  try {
    // Check if cache is still valid (unless force refresh)
    const now = Date.now();
    if (!force && agentListCache.agents.length > 0 && (now - agentListCache.timestamp) < AGENT_CACHE_TTL) {
      // Use cached data
      updateAgentListUI(agentListCache.agents);
      return;
    }

    const response = await fetch('/api/user/agents');

    if (!response.ok) {
      console.error('Failed to fetch agents:', response.status);
      return;
    }

    const data = await response.json();
    const agents = data.agents || [];
    const isInitialLoad = !initialAgentLoadComplete;

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

function getOrbitRingKey(agent) {
  if (agent.lastMessagePriority === 'high') {
    return 'urgent';
  }
  if (agent.lastMessagePriority === 'normal') {
    return 'attention';
  }
  return 'idle';
}

function buildOrbitLayout(agents) {
  const orderedAgents = Array.isArray(agents) ? [...agents] : [];
  orderedAgents.sort((a, b) => (a.position || 0) - (b.position || 0));
  const layout = new Map();
  const order = orderedAgents.map(agent => agent.agentId);
  const total = orderedAgents.length;

  if (total === 0) {
    return { layout, order };
  }

  orderedAgents.forEach((agent, index) => {
    const ringKey = getOrbitRingKey(agent);
    const radius = ORBIT_CONFIG.ringRadii[ringKey] ?? ORBIT_CONFIG.ringRadii.idle;
    const ringIndex = ORBIT_CONFIG.ringIndex[ringKey] ?? ORBIT_CONFIG.ringIndex.idle;
    const angle = (index * 360 / total) - 90;
    const x = 50 + radius * Math.cos(angle * Math.PI / 180);
    const y = 50 + radius * Math.sin(angle * Math.PI / 180);

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
 * Update agent list UI with new data (Council Chamber version)
 */
function updateAgentListUI(agents) {
  const agentSeatsContainer = document.getElementById('agentSeats');
  const statsTotal = document.getElementById('statsTotal');
  const statsAttention = document.getElementById('statsAttention');
  const statsUrgent = document.getElementById('statsUrgent');

  if (!agentSeatsContainer) {
    return;
  }

  currentAgentList = Array.isArray(agents) ? agents : [];
  currentOrbitLayout = buildOrbitLayout(currentAgentList);

  // Update stats
  if (statsTotal) statsTotal.textContent = currentAgentList.length;
  if (statsAttention) {
    statsAttention.textContent = currentAgentList.filter(a => getOrbitRingKey(a) === 'attention').length;
  }
  if (statsUrgent) {
    statsUrgent.textContent = currentAgentList.filter(a => getOrbitRingKey(a) === 'urgent').length;
  }

  // Update mobile dock
  updateMobileDock(currentAgentList);

  if (currentAgentList.length === 0) {
    agentSeatsContainer.innerHTML = `
      <div class="absolute -top-40 left-1/2 -translate-x-1/2 w-full text-center text-slate-500">
        <div class="text-center">
          <svg class="w-16 h-16 mx-auto mb-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
          </svg>
          <p class="text-sm">No agents in your council yet</p>
          <p class="text-xs text-slate-600 mt-1">Agents will appear here once they connect</p>
        </div>
      </div>
    `;
    return;
  }

  const html = currentAgentList.map((agent, index) => {
    const isSelected = agent.agentId === selectedAgentId;
    const totalAgents = currentAgentList.length;
    const positionValue = Number.isFinite(agent.position) ? agent.position : Number(agent.position);
    const safePosition = Number.isFinite(positionValue) ? positionValue : (index + 1);
    const orbitMeta = currentOrbitLayout?.layout?.get(agent.agentId);
    const ringKey = orbitMeta?.ringKey || getOrbitRingKey(agent);
    const ringIndex = orbitMeta?.ringIndex ?? ORBIT_CONFIG.ringIndex[ringKey];
    const x = orbitMeta?.x ?? 50;
    const y = orbitMeta?.y ?? 50;

    // statusLabel uses lastMessagePriority for ring styling, needsAttention for visual indicators
    const statusLabel = ringKey;
    const needsAttention = agent.highestPriority === 'high' || agent.unreadCount > 0;
    const isNewAgent = newAgentIds.has(agent.agentId);
    const isNewsAgent = agent.agentType === 'news_feed';

    // Marble selection
    // Marbles are now generated SVGs
    // Use a unique suffix for each render to prevent SVG ID collisions
    const renderTimestamp = Date.now();
    const marbleSvg = MarbleGenerator.generateMarble(agent.agentId, 100, agent.name, `update-${renderTimestamp}`);

    // Dynamic sizing based on agent count and container size
    // Calculate the maximum sphere size that prevents overlapping
    const sphereSize = calculateDynamicSphereSize(totalAgents);
    const sizeStyle = `width: ${sphereSize}px; height: ${sphereSize}px;`;

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
        data-agent-ring="${ringKey}"
        data-agent-ring-index="${ringIndex}"
        data-agent-index="${index}"
        style="left: ${x}%; top: ${y}%; transform: translate(-50%, -50%);"
      >
        <!-- Agent Number Badge -->
        <div class="agent-number-badge absolute -top-6 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <span class="text-[10px] font-mono font-bold text-sky-400/70 bg-slate-900/80 px-1.5 py-0.5 rounded border border-sky-400/30">${safePosition}</span>
        </div>
        <div class="agent-avatar relative group flex justify-center">
          ${isNewsAgent ? `
            <div class="agent-badge-news" title="News Feed">
              <span>i</span>
            </div>
          ` : ''}
          <div class="rounded-full relative z-10 transition-transform duration-300 group-hover:scale-110 overflow-hidden border-2 border-white/10 shadow-2xl bg-slate-900" style="${sizeStyle}">
            <div class="w-full h-full marble-container">
                ${marbleSvg}
            </div>
            <!-- Agent Initials Overlay -->
            <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span class="text-white font-bold opacity-90" style="font-size: ${Math.max(sphereSize * 0.32, 10)}px; text-shadow: 0 2px 4px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.5);">
                ${escapeHtml(agent.name.substring(0, 2).toUpperCase())}
              </span>
            </div>
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
          ` : pendingResponseAgents.has(agent.agentId) ? `
            <div class="absolute bottom-0 right-0 z-20 w-5 h-5 rounded-md bg-amber-500 border-2 border-slate-900 flex items-center justify-center shadow-[0_0_10px_rgba(245,158,11,0.6)] animate-pulse" title="Agent is working...">
              <span class="text-[8px]">🛠️</span>
            </div>
          ` : `
            <div class="absolute bottom-0 right-0 z-20 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-slate-900 shadow-[0_0_10px_rgba(52,211,153,0.6)]" title="Waiting for instructions"></div>
          `}
        </div>
        
        <div class="mt-2 text-center opacity-80 ${isSelected ? 'opacity-100' : 'group-hover:opacity-100'} transition-opacity w-full absolute top-full left-1/2 -translate-x-1/2 w-max">
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

  agentSeatsContainer.innerHTML = html;
  setupAgentSelectionHandlers();

  // Update the agent list panel below the orbit
  updateAgentListPanel(currentAgentList);
}

/**
 * Update the agent list panel below the orbital view
 * This syncs with the orbit selection and provides an alternative way to select agents
 */
function updateAgentListPanel(agents) {
  const listScroll = document.getElementById('agentListScroll');
  const listCount = document.getElementById('agentListCount');

  if (!listScroll) return;

  const agentList = Array.isArray(agents) ? agents : [];

  // Update count badge
  if (listCount) {
    listCount.textContent = agentList.length;
  }

  if (agentList.length === 0) {
    listScroll.innerHTML = `
      <div class="agent-list-empty">
        <p>No agents connected</p>
      </div>
    `;
    return;
  }

  // Sort by lastMessageTime (most recent first), fallback to position
  const orderedAgents = [...agentList].sort((a, b) => {
    const aTime = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
    const bTime = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return (a.position || 0) - (b.position || 0);
  });

  const html = orderedAgents.map((agent) => {
    const ringKey = getOrbitRingKey(agent);
    const needsAttention = agent.highestPriority === 'high' || agent.unreadCount > 0;
    const isSelected = agent.agentId === selectedAgentId;
    const isNewsAgent = agent.agentType === 'news_feed';
    const renderTimestamp = Date.now();
    const marbleSvg = MarbleGenerator.generateMarble(agent.agentId, 100, agent.name, `list-${renderTimestamp}`);

    // Status display
    let statusHtml = '';
    if (agent.highestPriority === 'high') {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--urgent">!</span> Urgent`;
    } else if (agent.unreadCount > 0) {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--unread">${agent.unreadCount}</span> Unread`;
    } else {
      statusHtml = `<span class="agent-list-item__badge agent-list-item__badge--idle"></span> Ready`;
    }

    return `
      <div class="agent-list-item agent-list-item--${ringKey} ${needsAttention ? 'agent-list-item--attention' : ''} ${isSelected ? 'agent-list-item--selected' : ''}"
           data-agent-id="${agent.agentId}"
           data-agent-name="${escapeHtml(agent.name)}"
           data-agent-type="${agent.agentType || 'standard'}"
           data-agent-priority="${agent.highestPriority}"
           data-agent-unread="${agent.unreadCount}"
           data-agent-last-activity="${agent.lastActivityTime || ''}"
           data-agent-last-message="${agent.lastMessageTime || ''}">
        <div class="agent-list-item__avatar">
          <div class="agent-list-item__marble">${marbleSvg}</div>
          <span class="agent-list-item__initials">${escapeHtml(agent.name.substring(0, 2).toUpperCase())}</span>
          ${isNewsAgent ? `
            <div class="agent-badge-news">
              <span>i</span>
            </div>
          ` : ''}
        </div>
        <div class="agent-list-item__info">
          <span class="agent-list-item__name">${escapeHtml(agent.name)}</span>
          <div class="agent-list-item__status-row">
            <span class="agent-list-item__status">${statusHtml}</span>
            <div class="agent-list-item__timestamps">
               ${agent.lastActivityTime ? `<span class="agent-list-item__time" title="Last Active">Active ${formatRelativeTime(agent.lastActivityTime)}</span>` : ''}
               ${agent.lastMessageTime ? `<span class="agent-list-item__time" title="Last Message">Msg ${formatRelativeTime(agent.lastMessageTime)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="agent-list-item__arrow">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" class="w-4 h-4">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    `;
  }).join('');

  listScroll.innerHTML = html;

  // Setup click handlers for list items
  setupAgentListHandlers();
}

/**
 * Setup click handlers for agent list items (below orbit)
 */
function setupAgentListHandlers() {
  const listItems = document.querySelectorAll('.agent-list-item');

  listItems.forEach(item => {
    item.addEventListener('click', () => {
      const agentId = item.getAttribute('data-agent-id');
      const agentName = item.getAttribute('data-agent-name');
      const metadata = {
        priority: item.getAttribute('data-agent-priority'),
        agentType: item.getAttribute('data-agent-type') || 'standard',
        unread: Number(item.getAttribute('data-agent-unread') || 0),
        lastActivity: item.getAttribute('data-agent-last-activity'),
        shouldCollapse: true
      };

      // Update list selection
      document.querySelectorAll('.agent-list-item').forEach(el => el.classList.remove('agent-list-item--selected'));
      item.classList.add('agent-list-item--selected');

      // Also update orbit selection
      document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
      const orbitSeat = document.querySelector(`.agent-seat[data-agent-id="${agentId}"]`);
      if (orbitSeat) {
        orbitSeat.classList.add('agent-seat--selected');
      }

      // Hide any floating menu
      hideFloatingAgentMenu();

      // Select the agent
      selectAgent(agentId, agentName, metadata);

      // Focus message input
      setTimeout(() => {
        const messageInput = document.getElementById('userMessageInput');
        if (messageInput && !messageInput.disabled) {
          messageInput.focus();
        }
      }, 100);
    });
  });
}

/**
 * Translate agent metadata into status copy/colors
 */
function getStatusFromMetadata({ priority, unread }) {
  if (priority === 'high') {
    return { label: 'Needs Attention', className: 'status-pill--danger' };
  }
  if (unread && unread > 0) {
    return { label: 'Awaiting Reply', className: 'status-pill--warn' };
  }
  if (priority === 'normal') {
    return { label: 'Connected', className: 'status-pill--ok' };
  }
  return { label: 'Idle', className: 'status-pill--neutral' };
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
        unread: Number(seat.getAttribute('data-agent-unread') || 0),
        lastActivity: seat.getAttribute('data-agent-last-activity'),
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

      selectAgent(agentId, agentName, metadata);

      // Focus the message input for real mouse clicks (not programmatic clicks from keyboard nav)
      if (e.isTrusted) {
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
  }

  const rect = getOrbitContainerRect();
  if (!rect) {
    return;
  }

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
  const radius = ORBIT_CONFIG.ringRadii[ringKey] ?? ORBIT_CONFIG.ringRadii.idle;
  const x = 50 + radius * Math.cos(angle);
  const y = 50 + radius * Math.sin(angle);

  seat.style.left = `${x}%`;
  seat.style.top = `${y}%`;
}

function handleOrbitPointerUp(event) {
  if (!orbitDragState) {
    return;
  }

  const { seat, ringKey, agentId, active, pointerId } = orbitDragState;

  if (seat.hasPointerCapture(pointerId)) {
    seat.releasePointerCapture(pointerId);
  }

  seat.classList.remove('agent-seat--dragging');
  document.body.classList.remove('orbit-dragging');

  orbitDragState = null;

  if (!active) {
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
  const degrees = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
  const angleFromTop = (degrees + 90 + 360) % 360;
  const step = 360 / total;
  const targetIndex = Math.floor((angleFromTop + step / 2) / step) % total;
  const fromIndex = orbitOrder.indexOf(agentId);

  if (fromIndex === -1 || targetIndex === fromIndex) {
    updateAgentListUI(currentAgentList);
    return;
  }

  orbitOrder.splice(fromIndex, 1);
  orbitOrder.splice(targetIndex, 0, agentId);

  const sortedPositions = currentAgentList
    .map(agent => Number.isFinite(agent.position) ? agent.position : Number(agent.position))
    .filter(position => Number.isInteger(position) && position > 0)
    .sort((a, b) => a - b);

  const positionsForOrder = sortedPositions.length === orbitOrder.length
    ? sortedPositions
    : orbitOrder.map((_, index) => index + 1);

  const updates = orbitOrder.map((id, index) => ({
    agentId: id,
    position: positionsForOrder[index]
  }));

  applyOrbitPositionUpdates(updates);
}

function getOrbitContainerRect() {
  const container = document.getElementById('agentSeats');
  if (!container) {
    return null;
  }
  return container.getBoundingClientRect();
}

async function applyOrbitPositionUpdates(updates) {
  try {
    const response = await fetch('/api/user/agents/positions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({ updates })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to update agent positions');
    }

    const agentMap = new Map(currentAgentList.map(agent => [agent.agentId, { ...agent }]));
    updates.forEach(update => {
      if (agentMap.has(update.agentId)) {
        agentMap.get(update.agentId).position = update.position;
      }
    });

    currentAgentList = Array.from(agentMap.values());
    agentListCache.agents = currentAgentList;
    agentListCache.timestamp = Date.now();
    updateAgentListUI(currentAgentList);
  } catch (error) {
    console.error('Failed to update orbit positions:', error);
    showErrorMessage(error.message || 'Failed to update agent positions.');
    updateAgentListUI(currentAgentList);
  }
}

/**
 * Show the floating agent menu near the clicked agent
 */
function showFloatingAgentMenu(event, seatElement) {
  const floatingMenu = document.getElementById('floatingAgentMenu');
  if (!floatingMenu) return;

  // Get the seat's bounding rect
  const rect = seatElement.getBoundingClientRect();

  // Position the menu below and to the right of the agent
  let left = rect.left + rect.width / 2;
  let top = rect.bottom + 10;

  // Ensure menu doesn't go off-screen
  const menuWidth = 192; // w-48 = 12rem = 192px
  const menuHeight = 150; // approximate height

  if (left + menuWidth > window.innerWidth) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (left < 10) {
    left = 10;
  }
  if (top + menuHeight > window.innerHeight) {
    top = rect.top - menuHeight - 10;
  }

  floatingMenu.style.left = `${left}px`;
  floatingMenu.style.top = `${top}px`;
  floatingMenu.classList.remove('hidden');

  event.stopPropagation();
}

/**
 * Hide the floating agent menu
 */
function hideFloatingAgentMenu() {
  const floatingMenu = document.getElementById('floatingAgentMenu');
  if (floatingMenu) {
    floatingMenu.classList.add('hidden');
  }
}

/**
 * Initialize the free-text composer controls
 */
function setupMessageComposer() {
  userMessageForm = document.getElementById('userMessageForm');
  userMessageInput = document.getElementById('userMessageInput');
  userMessageSendButton = document.getElementById('userMessageSend');
  voiceInputBtn = document.getElementById('voiceInputBtn');

  if (userMessageForm) {
    userMessageForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await sendUserMessage();
    });
  }

  if (userMessageInput) {
    userMessageInput.addEventListener('input', () => {
      updateComposerState();
    });

    // Add Ctrl+Enter to send
    userMessageInput.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!userMessageSendButton.disabled) {
          await sendUserMessage();
        }
      }
    });
  }

  // Initialize image upload functionality
  setupImageUpload();

  updateComposerState();
}

/**
 * Enable/disable composer controls based on current state
 */
function updateComposerState() {
  if (!userMessageInput || !userMessageSendButton) {
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

  // For news feed agents, show read-only activity log placeholder
  if (isNewsFeed) {
    userMessageInput.disabled = false; // Allow typing notes
    userMessageInput.placeholder = '📋 Activity Log — Type a note (agents only post here)';
    userMessageSendButton.disabled = !hasContent || isUploadingImages;
    userMessageSendButton.textContent = isUploadingImages ? 'Uploading...' : 'Add Note';
    // Disable image upload for news feed
    if (imageFileInput) imageFileInput.disabled = true;
    if (imageUploadLabel) imageUploadLabel.classList.add('disabled');
  } else {
    userMessageInput.disabled = !hasAgent;
    userMessageInput.placeholder = hasAgent
      ? 'Write a message...'
      : 'Select an agent to start typing...';

    // Enable send if there's content OR images (or both)
    const canSend = hasAgent && (hasContent || hasImages) && !isUploadingImages;
    userMessageSendButton.disabled = !canSend;

    // Update button text based on state
    if (isUploadingImages) {
      userMessageSendButton.textContent = 'Uploading...';
      userMessageSendButton.classList.add('uploading');
    } else if (hasImages && !hasContent) {
      userMessageSendButton.textContent = `Send ${pendingImages.length} Image${pendingImages.length > 1 ? 's' : ''}`;
      userMessageSendButton.classList.remove('uploading');
    } else {
      userMessageSendButton.textContent = 'Send';
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
        imageUploadLabel.title = `Maximum ${MAX_IMAGES_PER_MESSAGE} images allowed`;
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

  // Enable/disable stop and config buttons (disable for news feed)
  const stopBtn = document.getElementById('agentStopBtn');
  const configBtn = document.getElementById('agentConfigBtn');
  const configContainer = document.getElementById('agentConfigContainer');
  if (stopBtn) stopBtn.disabled = !hasAgent || isNewsFeed;
  if (configBtn) configBtn.disabled = !hasAgent || isNewsFeed;
  // Hide the entire config container when no agent is selected to avoid showing the green "-" text
  if (configContainer) {
    if (!hasAgent || isNewsFeed) {
      configContainer.style.display = 'none';
    } else {
      configContainer.style.display = '';
    }
  }
}

/**
 * Setup agent control buttons (stop, config)
 */
function setupAgentControls() {
  const stopBtn = document.getElementById('agentStopBtn');
  const configBtn = document.getElementById('agentConfigBtn');
  const configDropdown = document.getElementById('agentConfigDropdown');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const configProvider = document.getElementById('configProvider');
  const configModel = document.getElementById('configModel');

  // Provider-specific option containers
  const codexOptions = document.getElementById('codexOptions');
  const claudeOptions = document.getElementById('claudeOptions');
  const geminiOptions = document.getElementById('geminiOptions');

  // Models per provider (verified current models as of Dec 2025)
  const PROVIDER_MODELS = {
    codex: [
      { value: 'default', label: 'Default (gpt-5.2-codex)' },
      { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex - Latest frontier agentic' },
      { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max - Deep & fast reasoning' },
      { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini - Cheaper, faster' },
      { value: 'gpt-5.2', label: 'gpt-5.2 - Latest frontier model' }
    ],
    claude: [
      { value: 'default', label: 'Default' },
      { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5 - Most intelligent' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 - Agents & coding' },
      { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' }
    ],
    gemini: [
      { value: 'default', label: 'Default (Auto)' },
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' }
    ],
    ollama: [
      { value: 'default', label: 'Default' },
      { value: 'llama3.3:70b', label: 'Llama 3.3 70B - Meta flagship' },
      { value: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B - Versatile' },
      { value: 'deepseek-r1', label: 'DeepSeek R1 - Open reasoning' },
      { value: 'deepseek-coder-v2:33b', label: 'DeepSeek Coder v2 33B' },
      { value: 'codellama:34b', label: 'CodeLlama 34B' },
      { value: 'qwen3-coder:30b', label: 'Qwen 3 Coder 30B - Agentic' }
    ],
    openrouter: [
      { value: 'default', label: 'Default' },
      { value: 'anthropic/claude-opus-4.5', label: 'Claude Opus 4.5' },
      { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { value: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
      { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { value: 'qwen/qwen-3-coder-30b', label: 'Qwen 3 Coder 30B' }
    ]
  };

  // Update model dropdown based on provider
  function updateModelDropdown(provider) {
    if (!configModel) return;
    const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS['codex'];
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

      // Show relevant options
      if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
        codexOptions?.classList.remove('hidden');
      } else if (provider === 'claude') {
        claudeOptions?.classList.remove('hidden');
      } else if (provider === 'gemini') {
        geminiOptions?.classList.remove('hidden');
      }
    });
  }

  // Stop button handler
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      if (!selectedAgentName) return;

      stopBtn.disabled = true;
      stopBtn.innerHTML = '<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';

      try {
        const response = await fetch('/dashboard/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({ agentName: selectedAgentName })
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
    configBtn.addEventListener('click', async () => {
      configDropdown.classList.toggle('hidden');

      // Load current config when opening
      if (!configDropdown.classList.contains('hidden') && selectedAgentName) {
        await loadAgentConfig();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!configBtn.contains(e.target) && !configDropdown.contains(e.target)) {
        configDropdown.classList.add('hidden');
      }
    });
  }

  // Save config handler
  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      if (!selectedAgentName) return;

      saveConfigBtn.disabled = true;
      saveConfigBtn.textContent = 'Saving...';

      try {
        const provider = configProvider?.value || 'codex';
        const model = document.getElementById('configModel')?.value || 'default';

        // Build config based on provider
        let configData = {
          agentName: selectedAgentName,
          model_provider: provider,
          model: model
        };

        // Add provider-specific settings
        if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
          const sandbox = document.getElementById('configCodexSandbox')?.value || 'workspace-write';
          const bypass = document.getElementById('configCodexBypass')?.checked || false;
          configData.sandbox_mode = sandbox;
          if (bypass) {
            configData.approval_mode = 'full-auto';
            configData.sandbox_mode = 'none';
          }
        } else if (provider === 'claude') {
          const perm = document.getElementById('configClaudeMode')?.value || 'default';
          const skip = document.getElementById('configClaudeSkip')?.checked || false;
          configData.approval_mode = perm;
          if (skip) configData.sandbox_mode = 'none';
        } else if (provider === 'gemini') {
          const mode = document.getElementById('configGeminiMode')?.value || 'sandbox';
          const yolo = document.getElementById('configGeminiYolo')?.checked || false;
          configData.sandbox_mode = mode === 'no-sandbox' ? 'none' : 'workspace-write';
          if (yolo) configData.approval_mode = 'full-auto';
        }

        const response = await fetch('/dashboard/config', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify(configData)
        });

        if (response.ok) {
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
async function loadAgentConfig() {
  if (!selectedAgentName) return;

  const configProvider = document.getElementById('configProvider');
  const statusProvider = document.getElementById('configStatusProvider');
  const statusMode = document.getElementById('configStatusMode');

  try {
    const response = await fetch(`/dashboard/config?agentName=${encodeURIComponent(selectedAgentName)}`);
    if (response.ok) {
      const data = await response.json();
      const config = data.config || {};
      const allowedPermissions = data.allowedPermissions || {};
      const allowedProviders = Object.keys(allowedPermissions);

      // Filter provider dropdown based on allowed permissions
      if (configProvider && allowedProviders.length > 0) {
        // Store all options first time
        if (!configProvider.dataset.allOptions) {
          const allOpts = [];
          for (const opt of configProvider.options) {
            allOpts.push({ value: opt.value, text: opt.text });
          }
          configProvider.dataset.allOptions = JSON.stringify(allOpts);
        }

        // Filter to only allowed providers
        const allOptions = JSON.parse(configProvider.dataset.allOptions);
        configProvider.innerHTML = '';
        for (const opt of allOptions) {
          if (allowedProviders.includes(opt.value)) {
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
          if (config.sandbox_mode === 'none') modeStr = 'FULL ACCESS';
          else modeStr = config.sandbox_mode || 'workspace-write';
        } else if (config.model_provider === 'gemini') {
          if (config.approval_mode === 'full-auto') modeStr = 'YOLO';
          else modeStr = config.sandbox_mode === 'none' ? 'No Sandbox' : 'Sandboxed';
        } else if (config.model_provider === 'claude') {
          if (config.sandbox_mode === 'none') modeStr = 'Bypass Permissions';
          else modeStr = config.approval_mode || 'default';
        }

        statusMode.textContent = modeStr;
      }

      // Set provider-specific values
      if (config.model_provider === 'codex' || config.model_provider === 'default') {
        const sandboxEl = document.getElementById('configCodexSandbox');
        if (sandboxEl && config.sandbox_mode) {
          sandboxEl.value = config.sandbox_mode === 'none' ? 'danger-full-access' : config.sandbox_mode;
        }
      } else if (config.model_provider === 'gemini') {
        const geminiMode = document.getElementById('configGeminiMode');
        const geminiYolo = document.getElementById('configGeminiYolo');
        if (geminiMode) geminiMode.value = config.sandbox_mode === 'none' ? 'no-sandbox' : 'sandbox';
        if (geminiYolo) geminiYolo.checked = config.approval_mode === 'full-auto';
      } else if (config.model_provider === 'claude') {
        const claudeMode = document.getElementById('configClaudeMode');
        if (claudeMode && config.approval_mode) claudeMode.value = config.approval_mode;
      }

      // Apply permission restrictions to UI elements (disable disallowed options)
      applyPermissionRestrictions(allowedPermissions, config.model_provider);
    }
  } catch (e) {
    console.error('Failed to load agent config:', e);
  }
}

/**
 * Apply permission restrictions to UI elements
 * Disables/dims options that are not allowed by CLI permissions
 */
function applyPermissionRestrictions(allowedPermissions, currentProvider) {
  // If no restrictions, enable everything
  const noRestrictions = !allowedPermissions || Object.keys(allowedPermissions).length === 0;

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
}

/**
 * Show success message toast
 */
function showSuccessMessage(message) {
  window.showSuccess(message);
}

/**
 * Submit the free-text reply on behalf of the user
 */
async function sendUserMessage() {
  if (!userMessageInput || !userMessageSendButton) {
    return;
  }

  if (!selectedAgentId) {
    showErrorMessage('Please select an agent before sending a reply.');
    return;
  }

  const trimmedContent = userMessageInput.value.trim();
  const hasImages = pendingImages.length > 0;

  // Allow sending if there's content OR images (or both)
  if (!trimmedContent && !hasImages) {
    showErrorMessage('Please enter a message or attach images.');
    return;
  }

  userMessageSendButton.disabled = true;
  userMessageSendButton.textContent = hasImages ? 'Uploading...' : 'Sending...';

  try {
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
        const failedCount = pendingImages.filter(img => img.status === 'error').length;
        showErrorMessage(`${failedCount} image(s) failed to upload. Please remove or retry.`);
        userMessageSendButton.disabled = false;
        updateComposerState();
        return;
      }
    }

    // Encrypt the message content if there is any
    let contentToSend = trimmedContent || null;
    let isEncrypted = false;

    if (trimmedContent && encryptionKey) {
      try {
        contentToSend = await window.E2EEncryption.encryptMessage(trimmedContent, encryptionKey);
        isEncrypted = true;
      } catch (encryptError) {
        console.error('Failed to encrypt message:', encryptError);
        showErrorMessage('Failed to encrypt message. Please refresh and try again.');
        userMessageSendButton.disabled = false;
        userMessageSendButton.textContent = 'Send';
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

    const response = await fetch('/api/user/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Unable to send message');
    }

    const data = await response.json();

    // Mark agent as pending response (show construction sign)
    pendingResponseAgents.add(selectedAgentId);
    // Force UI update to show construction sign
    if (agentListCache.agents.length > 0) {
      updateAgentListUI(agentListCache.agents);
    }

    // Reload full message history so we rely on
    // server-side ordering/cursors and avoid duplicates
    if (selectedAgentId) {
      lastMessageTimestamp = null;
      lastMessageCursor = null;
      // Clear cache for this agent to force refresh
      conversationCache.delete(selectedAgentId);
      // Clear saved scroll position so we scroll to bottom after sending
      agentScrollPositions.delete(selectedAgentId);
      await loadMessages(selectedAgentId);
    }

    // Clear the input and any pending images
    userMessageInput.value = '';
    clearAllImages();
    updateComposerState();

  } catch (error) {
    console.error('Error sending user message:', error);
    showErrorMessage(error.message || 'Failed to send message');
  } finally {
    // Note: Don't reset button styling here - displayMessages() handles that
    // based on whether there are more unanswered questions
    updateComposerState();
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

  // Handle file selection
  imageFileInput.addEventListener('change', (event) => {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;

    // Check if adding these would exceed the limit
    const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
    if (files.length > remainingSlots) {
      showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} images per message. ${remainingSlots} slots remaining.`);
      // Only take what we can
      files.splice(remainingSlots);
    }

    // Add files to pending images
    files.forEach(file => {
      // Validate file type
      const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
      if (!allowedTypes.includes(file.type)) {
        showErrorMessage(`${file.name}: Invalid file type. Only PNG, JPEG, WebP, and GIF are allowed.`);
        return;
      }

      // Validate file size (5MB max)
      const maxSize = 5 * 1024 * 1024;
      if (file.size > maxSize) {
        showErrorMessage(`${file.name}: File too large. Maximum size is 5MB.`);
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
        // Validate file size (20MB max for general files)
        const maxSize = 20 * 1024 * 1024;
        if (file.size > maxSize) {
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

    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
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

      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length > 0) {
        // Check remaining slots
        const remainingSlots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
        if (files.length > remainingSlots) {
          showErrorMessage(`You can only attach ${MAX_IMAGES_PER_MESSAGE} images per message. ${remainingSlots} slots remaining.`);
          files.splice(remainingSlots);
        }

        // Process each image file
        for (const file of files) {
          // Validate file type
          const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
          if (!allowedTypes.includes(file.type)) {
            showErrorMessage(`${file.name}: Invalid file type. Only PNG, JPEG, WebP, and GIF are allowed.`);
            continue;
          }

          // Validate file size (5MB max)
          const maxSize = 5 * 1024 * 1024;
          if (file.size > maxSize) {
            showErrorMessage(`${file.name}: File too large. Maximum size is 5MB.`);
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
          showSuccessMessage(`Added ${addedCount} image${addedCount > 1 ? 's' : ''} from drag & drop`);
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
    return;
  }

  imagePreviewArea.classList.remove('hidden');

  // Update count badge on upload button
  if (imageUploadLabel) {
    let badge = imageUploadLabel.querySelector('.image-upload-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'image-upload-count';
      imageUploadLabel.style.position = 'relative';
      imageUploadLabel.appendChild(badge);
    }
    badge.textContent = pendingImages.length;
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

    // Content to display (image preview or file icon)
    let contentHtml;
    if (isImage) {
      contentHtml = `<img src="${img.previewUrl}" alt="${escapeHtml(img.file.name)}" />`;
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

    // Get image dimensions
    const dimensions = await getImageDimensions(imageEntry.file);

    // Encrypt the image data
    const { ciphertext, iv, authTag } = await window.E2EEncryption.encryptBinaryWithKey(arrayBuffer, encryptionKey);

    // Create FormData for upload
    const formData = new FormData();
    formData.append('agentId', selectedAgentId);
    formData.append('file', new Blob([ciphertext], { type: 'application/octet-stream' }), imageEntry.file.name);
    formData.append('ivBase64', window.E2EEncryption.arrayBufferToBase64(iv.buffer));
    formData.append('authTagBase64', window.E2EEncryption.arrayBufferToBase64(authTag.buffer));
    formData.append('contentType', imageEntry.file.type);
    formData.append('width', dimensions.width.toString());
    formData.append('height', dimensions.height.toString());

    // Upload to server
    const response = await fetch('/api/user/attachments', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Upload failed: ${response.status}`);
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
    const blob = new Blob([decryptedBuffer], { type: attachment.contentType || 'image/png' });
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

  const img = document.createElement('img');
  img.className = 'message-attachment-image';
  img.src = objectUrl;
  img.alt = attachment.filename || 'Image attachment';
  img.loading = 'lazy';
  img.onclick = () => openImageLightbox(objectUrl, attachment.filename, attachment.contentType);

  const infoBar = document.createElement('div');
  infoBar.className = 'message-attachment-info';

  const filename = document.createElement('span');
  filename.className = 'message-attachment-filename';
  filename.textContent = attachment.filename || 'image';
  filename.title = attachment.filename || 'image';

  const actions = document.createElement('div');
  actions.className = 'message-attachment-actions';

  // Expand button
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'message-attachment-btn';
  expandBtn.title = 'View full size';
  expandBtn.innerHTML = `
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
    </svg>
  `;
  expandBtn.onclick = () => openImageLightbox(objectUrl, attachment.filename, attachment.contentType);

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
  downloadBtn.onclick = () => downloadDecryptedImage(objectUrl, attachment.filename, attachment.contentType);

  actions.appendChild(expandBtn);
  actions.appendChild(downloadBtn);
  infoBar.appendChild(filename);
  infoBar.appendChild(actions);
  item.appendChild(img);
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

/**
 * Handle agent selection (Council Chamber version)
 */
async function selectAgent(agentId, agentName, metadata = {}) {
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

  // Update selected agent
  selectedAgentId = agentId;
  selectedAgentName = agentName || '';
  selectedAgentType = metadata.agentType || 'standard';
  lastMessageTimestamp = null;
  lastMessageCursor = null;

  // Save this agent as the last opened conversation
  localStorage.setItem(LAST_AGENT_STORAGE_KEY, agentId);

  // Show agent panel
  const placeholder = document.getElementById('agentPanelPlaceholder');
  const header = document.getElementById('agentPanelHeader');
  const conversationArea = document.getElementById('conversationArea');
  const messageInputArea = document.getElementById('messageInputArea');

  if (placeholder) placeholder.classList.add('hidden');
  // Header styling logic is now handled below with isNewsAgent check

  if (conversationArea) {
    conversationArea.classList.remove('hidden');
    conversationArea.innerHTML = '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm">Loading messages...</p></div>';
    if (useCarouselTransition) {
      const token = scheduleConversationEnter(carouselDirection);
      conversationArea.dataset.chatCarouselToken = String(token);
    } else {
      delete conversationArea.dataset.chatCarouselToken;
    }
  }
  if (messageInputArea) messageInputArea.classList.remove('hidden');

  // Update agent header
  const initialsEl = document.getElementById('selectedAgentInitials');
  const imageEl = document.getElementById('selectedAgentImage');
  const nameEl = document.getElementById('selectedAgentName');
  const lastActiveEl = document.getElementById('agentLastActive');
  const statusPill = document.getElementById('agentStatusPill');
  const unreadBadge = document.getElementById('agentUnreadBadge');

  const isNewsAgent = selectedAgentType === 'news_feed' || (selectedAgentName || '').toLowerCase().includes('local news');

  if (header) {
    header.classList.remove('hidden');
    // Apply styling for News Feed
    if (isNewsAgent) {
      // Blue theme for News Agents
      header.classList.add('bg-blue-900/40', 'border-blue-700/40', 'shadow-lg', 'shadow-blue-900/20');
      header.classList.remove('bg-blue-950/60', 'border-blue-800/50');
      header.classList.remove('bg-sky-900/20', 'border-sky-800/30', 'border-white/5');
    } else {
      // Default theme
      header.classList.remove('bg-blue-900/40', 'border-blue-700/40', 'shadow-lg', 'shadow-blue-900/20');
      header.classList.remove('bg-blue-950/60', 'border-blue-800/50');
      header.classList.remove('bg-sky-900/20', 'border-sky-800/30');
      header.classList.add('border-white/5');
    }
  }

  // Ensure avatar marble renders for the selected agent
  if (imageEl) {
    imageEl.innerHTML = MarbleGenerator.generateMarble(agentId, 100, agentName, `selected-${Date.now()}`);
  }

  // Update image border for News Agents
  if (imageEl && imageEl.parentElement) {
    if (isNewsAgent) {
      imageEl.parentElement.classList.remove('border-emerald-400/60', 'shadow-emerald-500/30');
      imageEl.parentElement.classList.add('border-sky-400/60', 'shadow-sky-500/30');
    } else {
      imageEl.parentElement.classList.add('border-emerald-400/60', 'shadow-emerald-500/30');
      imageEl.parentElement.classList.remove('border-sky-400/60', 'shadow-sky-500/30');
    }
  }

  // Update text color for News Agents
  if (nameEl) {
    nameEl.textContent = agentName;
    if (isNewsAgent) {
      nameEl.classList.remove('text-white');
      nameEl.classList.add('text-sky-100');
    } else {
      nameEl.classList.add('text-white');
      nameEl.classList.remove('text-sky-100');
    }
  }
  if (lastActiveEl) {
    lastActiveEl.textContent = metadata.lastActivity
      ? `Last active ${formatRelativeTime(metadata.lastActivity)}`
      : 'No recent activity';
  }
  if (statusPill) {
    const status = getStatusFromMetadata(metadata);
    statusPill.textContent = status.label;
    statusPill.className = `status-pill ${status.className} text-[10px]`;
  }
  if (unreadBadge) {
    if (metadata.unread > 0) {
      unreadBadge.textContent = `${metadata.unread} unread`;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }

  // Load messages for selected agent
  loadMessages(agentId);

  // Start polling messages for selected agent
  startMessagePolling(agentId);

  updateComposerState();

  // Load and display agent config
  loadAgentConfig();

  // Update agent list UI from cache to reflect the selection
  // No need to fetch from server - the cache is updated by the regular polling interval
  if (agentListCache.agents.length > 0) {
    updateAgentListUI(agentListCache.agents);
  }

  // Update mobile dock center to show selected agent
  syncDockToSelectedAgent(agentId);

  // Auto-collapse mobile list when an agent is directly selected (not via nav buttons)
  if (metadata.shouldCollapse) {
    setMobileListExpanded(false);
  }
}



/**
 * Start polling messages for selected agent every 3 seconds
 */
function startMessagePolling(agentId) {
  // Poll immediately first
  pollMessages(agentId);

  // Set up interval for polling every 3 seconds
  messagePollingInterval = setInterval(() => {
    pollMessages(agentId);
  }, 3000);
}

/**
 * Stop polling messages
 */
function stopMessagePolling() {
  if (messagePollingInterval) {
    clearInterval(messagePollingInterval);
    messagePollingInterval = null;
  }
}

/**
 * Load messages for selected agent (initial load)
 */
async function loadMessages(agentId) {
  // Check cache first - display cached messages immediately for responsiveness
  if (conversationCache.has(agentId)) {
    const cachedMessages = conversationCache.get(agentId);
    displayMessages(cachedMessages, false);
    // Don't return - still fetch fresh data in background via polling
    // The pollMessages call in startMessagePolling will pick up any new messages
    return;
  }

  // Set loading flag to prevent polling interference
  isLoadingMessages = true;

  try {
    const response = await fetch(`/api/user/messages/${agentId}`);

    if (!response.ok) {
      console.error('Failed to fetch messages:', response.status);
      document.getElementById('conversationArea').innerHTML = '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm text-red-300">Failed to load messages</p></div>';
      return;
    }

    const data = await response.json();

    // Cache the messages
    conversationCache.set(agentId, data.messages);

    displayMessages(data.messages, false);

  } catch (error) {
    console.error('Error loading messages:', error);
    document.getElementById('conversationArea').innerHTML = '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm text-red-300">Error loading messages</p></div>';
  } finally {
    isLoadingMessages = false;
  }
}

/**
 * Poll messages for selected agent (with 'since' parameter)
 */
async function pollMessages(agentId) {
  // Skip polling if we're in the middle of a full reload
  if (isLoadingMessages) {
    return;
  }

  try {
    let url = `/api/user/messages/${agentId}`;

    // Add 'since' parameter if we have a last message timestamp
    if (lastMessageCursor !== null) {
      url += `?cursor=${encodeURIComponent(lastMessageCursor)}`;
    } else if (lastMessageTimestamp) {
      url += `?since=${encodeURIComponent(lastMessageTimestamp)}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      console.error('Failed to poll messages:', response.status);
      return;
    }

    const data = await response.json();

    // Only update UI if we have new messages
    if (data.messages && data.messages.length > 0) {
      // Update cache with new messages (with deduplication)
      if (conversationCache.has(agentId)) {
        const cached = conversationCache.get(agentId);
        const existingIds = new Set(cached.map(m => m.messageId));
        const newMessages = data.messages.filter(m => !existingIds.has(m.messageId));

        if (newMessages.length > 0) {
          conversationCache.set(agentId, [...cached, ...newMessages]);
          displayMessages(newMessages, true);
        }
      } else {
        conversationCache.set(agentId, data.messages);
        displayMessages(data.messages, true);
      }
    }

    // Also check for readAt updates on existing user messages
    await pollReadStatus(agentId);

  } catch (error) {
    console.error('Error polling messages:', error);
  }
}

/**
 * Poll for read status updates on user messages
 */
async function pollReadStatus(agentId) {
  try {
    // Find all user message elements that don't have the read indicator yet
    const unreadMessages = document.querySelectorAll('[data-message-id][data-message-type="user_message"]:not([data-read="true"])');

    if (unreadMessages.length === 0) {
      return;
    }

    // Fetch fresh status for these messages
    const messageIds = Array.from(unreadMessages).map(el => el.getAttribute('data-message-id'));

    for (const msgId of messageIds) {
      const response = await fetch(`/api/user/messages/${agentId}/status/${msgId}`);
      if (response.ok) {
        const status = await response.json();
        if (status.readAt) {
          // Update the UI to show double-check mark
          const msgEl = document.querySelector(`[data-message-id="${msgId}"]`);
          if (msgEl) {
            msgEl.setAttribute('data-read', 'true');
            // Update the check mark - find the pending indicator and update it to read
            const checkSpan = msgEl.querySelector('.message-read-indicator--pending');
            if (checkSpan) {
              checkSpan.classList.remove('message-read-indicator--pending');
              checkSpan.classList.add('message-read-indicator--read');
              checkSpan.title = 'Read by agent';
              checkSpan.textContent = '✓✓';
            }
            // Also update cache
            if (conversationCache.has(agentId)) {
              const cached = conversationCache.get(agentId);
              const msgIndex = cached.findIndex(m => m.messageId === msgId);
              if (msgIndex >= 0) {
                cached[msgIndex].readAt = status.readAt;
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error polling read status:', error);
  }
}

/**
 * Display messages in conversation area
 */
async function displayMessages(messages, append = false) {
  const conversationArea = document.getElementById('conversationArea');

  if (!messages || messages.length === 0) {
    if (!append) {
      conversationArea.innerHTML = '<div class="flex items-center justify-center h-full text-slate-500"><p class="text-sm">No messages yet. Send a first instruction below.</p></div>';
      triggerConversationEnterIfScheduled();
    }
    return;
  }

  // Clear conversation area if not appending
  if (!append) {
    // Clean up attachment object URLs from previous messages
    revokeAllAttachmentUrls();
    conversationArea.innerHTML = '';
  }

  // Add messages to conversation area
  for (const message of messages) {
    // Skip if this message already exists in the DOM (dedup for append mode)
    if (append && document.querySelector(`[data-message-id="${message.messageId}"]`)) {
      continue;
    }

    // Track if message is still encrypted (for display purposes)
    let messageIsEncrypted = false;
    const originalContent = message.content;

    // Check if message content looks like encrypted data
    if (message.content && typeof message.content === 'string' && looksLikeEncryptedText(message.content)) {
      if (encryptionKey) {
        try {
          // Only attempt decryption if it looks like iv:tag:ciphertext
          const parts = message.content.split(':');
          if (parts.length === 3) {
            message.content = await window.E2EEncryption.decryptMessage(message.content, encryptionKey);
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

    const messageElement = createMessageElement(message);

    // Add slide-in animation for new agent messages when appending
    if (append && (message.type === 'agent_message' || message.type === 'agent_question')) {
      const bubbleEl = messageElement.querySelector('.message-bubble');
      if (bubbleEl) {
        bubbleEl.classList.add('message-animate-in');
      }
      // Trigger ripple animation on the selected agent's avatar
      triggerAgentRipple(selectedAgentId);

      // Clear pending response status when agent responds - show green dot again
      if (selectedAgentId && pendingResponseAgents.has(selectedAgentId)) {
        pendingResponseAgents.delete(selectedAgentId);
        // Update UI to show green dot instead of construction sign
        if (agentListCache.agents.length > 0) {
          updateAgentListUI(agentListCache.agents);
        }
      }
    }

    conversationArea.appendChild(messageElement);

    // Narrate new agent messages with a polished TTS voice
    if (append && (message.type === 'agent_message' || message.type === 'agent_question')) {
      // Regular agents get TTS priority
      // News feed agents are supplementary - their TTS is skipped if the message was already notified
      const isNewsAgent = selectedAgentType === 'news_feed';

      if (!isNewsAgent && shouldNotifyAgentMessage(selectedAgentId, message.timestamp, message.messageId)) {
        // Regular agent - always play TTS
        markAgentMessageNotified(selectedAgentId, message.timestamp, message.messageId);
        playVoiceNotification(message);
      } else if (isNewsAgent && shouldNotifyAgentMessage(selectedAgentId, message.timestamp, message.messageId)) {
        // News feed agent - only play TTS if not already notified by regular agent
        // The global notification check in shouldNotifyAgentMessage handles this
        markAgentMessageNotified(selectedAgentId, message.timestamp, message.messageId);
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
  }

  updateConversationMeta(lastMessageTimestamp);
  updateComposerState();

  // Scroll management
  if (!append && selectedAgentId && agentScrollPositions.has(selectedAgentId)) {
    // Restore previous position
    conversationArea.scrollTop = agentScrollPositions.get(selectedAgentId);
  } else {
    // Scroll to bottom (default behavior for new messages or first load)
    scrollToBottom();
  }

  if (!append) {
    triggerConversationEnterIfScheduled();
  }
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
    <div class="news-feed-card bg-slate-800/40 rounded-lg p-3 border border-slate-700/50 hover:bg-slate-800/60 transition-colors">
      <div class="flex items-center justify-between -mx-3 -mt-3 mb-3 px-3 py-2 bg-sky-900/20 rounded-t-lg border-b border-sky-800/30">
        <div class="text-xs font-semibold text-sky-300">
          ${escapeHtml(newsData.agent || 'Agent')}
        </div>
        ${newsData.context ? `
          <div class="flex items-center gap-1.5 text-xs font-mono text-sky-400/70 max-w-[60%] ml-auto" title="${escapeHtml(newsData.context)}">
            <svg class="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path>
            </svg>
            <span class="truncate dir-rtl">${escapeHtml(newsData.context)}</span>
          </div>
        ` : ''}
      </div>

      <div class="text-sm text-slate-200 leading-relaxed mb-3">
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
function createMessageElement(message) {
  const div = document.createElement('div');
  div.className = 'space-y-2';
  div.dataset.messageId = message.messageId; // For deduplication

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
      // Check if this is a structured news/log message (JSON or Text)
      const newsData = parseNewsMessage(message.content);

      if (newsData && (selectedAgentType === 'news_feed' || (newsData.agent && newsData.summary))) {
        // Render as styled news card
        contentHtml = generateNewsCardHtml(newsData);
      } else {
        contentHtml = renderMessageMarkdown(message.content);
      }
    } else {
      // No text content (image-only message)
      contentHtml = '';
    }

    const hiddenClass = message.hiddenFromAgent ? 'message-bubble--hidden-from-agent' : '';

    div.innerHTML = `
      <div class="flex justify-start">
        <div class="message-bubble p-3 ${priorityClass} ${urgentClass} ${hiddenClass}">
          ${message.urgent ? '<span class="inline-block px-2 py-0.5 text-xs font-semibold text-red-200 bg-red-500/20 rounded mb-2">URGENT</span>' : ''}
          <div class="message-content text-sm text-slate-100 leading-relaxed space-y-2">${contentHtml}</div>
          <div class="message-footer">
            <p class="message-timestamp text-xs text-slate-400">${formatTimestamp(message.timestamp)}</p>
            <div class="message-utilities" aria-label="Message actions"></div>
          </div>
        </div>
      </div>
    `;

    const agentBubble = div.querySelector('.message-bubble');
    attachMessageTtsButton(agentBubble, message);

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
    if (message.type === 'agent_question' && message.options && message.options.length > 0) {
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
    const readIcon = message.readAt
      ? '<span class="message-read-indicator message-read-indicator--read" title="Read by agent">✓✓</span>'
      : '<span class="message-read-indicator message-read-indicator--pending" title="Not yet read">✓</span>';

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
    } else if (message.content && message.content.trim()) {
      userContentHtml = renderMessageMarkdown(message.content);
    } else {
      // No text content (image-only message)
      userContentHtml = '';
    }

    // Add hidden-from-agent class if applicable
    const hiddenClass = message.hiddenFromAgent ? ' message-bubble--hidden-from-agent' : '';

    div.innerHTML = `
      <div class="flex justify-end">
        <div class="message-bubble message-bubble--user${hiddenClass} p-3 text-right">
          <div class="message-content text-sm text-slate-100 leading-relaxed space-y-2">${userContentHtml}</div>
          <div class="message-footer">
            <p class="message-timestamp text-xs text-slate-400">${formatTimestamp(message.timestamp)}${readIcon}</p>
            <div class="message-utilities" aria-label="Message actions"></div>
          </div>
        </div>
      </div>
    `;

    const userBubble = div.querySelector('.message-bubble');
    attachMessageTtsButton(userBubble, message);

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

  return div;
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
      if (ttsButton.classList.contains('is-playing')) {
        stopActiveMessagePlayback();
        return;
      }
      speakMessageText(normalizedContent, ttsButton);
    });
    utilities.appendChild(ttsButton);
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
  if (!utilities.querySelector('.message-delete-btn')) {
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
  if ((message.type === 'user_message' || message.type === 'agent_message' || message.type === 'agent_question') && !utilities.querySelector('.message-hide-btn')) {
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

        const response = await fetch(apiEndpoint, {
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

function resetTtsButtonState(button) {
  if (!button) return;
  button.classList.remove('is-playing');
  button.removeAttribute('aria-pressed');
  if (button.dataset.defaultLabel) {
    button.setAttribute('aria-label', button.dataset.defaultLabel);
  }
  if (button.dataset.defaultTitle) {
    button.title = button.dataset.defaultTitle;
  }
}

function stopActiveMessagePlayback() {
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      console.error('Failed to cancel speech synthesis:', error);
    }
  }
  if (activeTtsUtterance) {
    activeTtsUtterance.onend = null;
    activeTtsUtterance.onerror = null;
    activeTtsUtterance = null;
  }
  if (activeTtsButton) {
    resetTtsButtonState(activeTtsButton);
    activeTtsButton = null;
  }
}

function speakMessageText(text, controlButton = null) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  if (!('speechSynthesis' in window)) {
    showErrorMessage('Speech synthesis is not supported in this browser.');
    return;
  }
  try {
    stopActiveMessagePlayback();
    const utterance = new SpeechSynthesisUtterance(normalized);
    activeTtsUtterance = utterance;
    const preferredVoice = voiceNotificationState?.preferredVoice;
    if (preferredVoice) {
      utterance.voice = preferredVoice;
      utterance.lang = preferredVoice.lang || 'en-US';
    } else {
      utterance.lang = 'en-US';
    }
    utterance.rate = 0.98;
    utterance.pitch = 1.05;
    utterance.volume = 0.95;
    if (controlButton) {
      if (!controlButton.dataset.defaultLabel) {
        controlButton.dataset.defaultLabel = controlButton.getAttribute('aria-label') || 'Read this message aloud';
      }
      if (!controlButton.dataset.defaultTitle) {
        controlButton.dataset.defaultTitle = controlButton.title || 'Read this message aloud';
      }
      utterance.onstart = () => {
        activeTtsButton = controlButton;
        controlButton.classList.add('is-playing');
        controlButton.setAttribute('aria-pressed', 'true');
        controlButton.setAttribute('aria-label', 'Stop reading this message');
        controlButton.title = 'Stop playback';
      };
      const cleanup = () => {
        if (activeTtsUtterance === utterance) {
          activeTtsUtterance = null;
        }
        resetTtsButtonState(controlButton);
        if (activeTtsButton === controlButton) {
          activeTtsButton = null;
        }
      };
      utterance.onend = cleanup;
      utterance.onerror = () => {
        cleanup();
        showErrorMessage('Could not play message aloud. Check your browser settings.');
      };
    } else {
      utterance.onerror = () => {
        showErrorMessage('Could not play message aloud. Check your browser settings.');
      };
    }
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
      selectOption(questionId, option.optionId, div);
    });

    // Add keyboard handler for Enter/Space to select
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectOption(questionId, option.optionId, div);
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
async function selectOption(questionId, optionId, optionElement) {
  try {
    // Disable the option element immediately
    optionElement.style.pointerEvents = 'none';
    optionElement.style.opacity = '0.5';

    const response = await fetch('/api/user/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
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
function scrollToBottom() {
  const conversationArea = document.getElementById('conversationArea');
  conversationArea.scrollTop = conversationArea.scrollHeight;
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
  return DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
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
      'Microsoft Sonia Online',
      'Microsoft Jenny Online',
      'Google UK English Female',
      'Google US English',
      'Samantha'
    ];

    const scoreVoice = (voice) => {
      let score = 0;
      const name = voice.name.toLowerCase();
      const lang = (voice.lang || '').toLowerCase();

      if (preferredNames.some(pref => name.includes(pref.toLowerCase()))) score += 25;
      if (femaleKeywords.some(keyword => name.includes(keyword))) score += 15;
      if (qualityKeywords.some(keyword => name.includes(keyword))) score += 12;
      if (lang.startsWith('en')) score += 8;
      if (!voice.localService) score += 12; // remote voices often higher quality
      return score;
    };

    const bestVoice = voices
      .map(v => ({ voice: v, score: scoreVoice(v) }))
      .sort((a, b) => b.score - a.score)[0]?.voice;

    voiceNotificationState = {
      ready: true,
      preferredVoice: bestVoice || voices[0]
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

  const utterance = new SpeechSynthesisUtterance(trimmedPreview);

  utterance.voice = voiceNotificationState.preferredVoice || null;
  utterance.lang = utterance.voice?.lang || 'en-US';
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
      encryptionKey = await window.E2EEncryption.deriveKey(pendingPassword, salt);
      await window.E2EEncryption.storeEncryptionKey(encryptionKey);

      // Clear the plaintext password from storage immediately
      sessionStorage.removeItem('pendingEncryptionPassword');
      console.log('Encryption key derived and stored securely');
      return;
    } catch (error) {
      console.error('Failed to derive key from pending password:', error);
    }
  }

  console.log('No encryption key available yet. Will prompt when needed.');
}

// Track if we've already prompted for encryption password this session
let encryptionPromptShown = false;

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
      encryptionKey = await Promise.race([
        window.E2EEncryption.deriveKey(password, salt),
        timeoutPromise
      ]);

      await window.E2EEncryption.storeEncryptionKey(encryptionKey);

      console.log('Encryption key derived and stored from manual password entry');

      // Hide error and close modal
      if (errorDiv) errorDiv.classList.add('hidden');
      modal.classList.add('hidden');

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
    // Ignore if user is typing in an input (except Esc and Arrows for scrolling)
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    const isConversation = e.target.id === 'conversationArea';

    // Handle Tab to toggle between council and list focus areas
    if (e.key === 'Tab' && !isInput) {
      e.preventDefault();
      if (currentFocusArea === 'council') {
        setFocusArea('list');
      } else if (currentFocusArea === 'list') {
        setFocusArea('council');
      } else if (currentFocusArea === 'conversation') {
        // From conversation, Tab goes to council
        setFocusArea('council');
      }
      return;
    }

    if (isInput || isConversation) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.target.blur();
        // Return focus to council chamber
        setFocusArea('council');
        const seats = getVisibleAgentSeats();
        if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
          updateAgentFocus();
        }
      } else if (isInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Scroll conversation area manually if in input
        const conversationArea = document.getElementById('conversationArea');
        if (conversationArea) {
          const scrollAmount = 40; // px
          if (e.key === 'ArrowUp') {
            conversationArea.scrollTop -= scrollAmount;
          } else {
            conversationArea.scrollTop += scrollAmount;
          }
        }
      } else if (isConversation && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'h' || e.key === 'l')) {
        // If in conversation list, Left/Right (or h/l) returns focus to agent ring
        e.preventDefault();
        e.target.blur();
        setFocusArea('council');
        const seats = getVisibleAgentSeats();
        if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
          updateAgentFocus();
        }
      } else if (isConversation && e.key === 'i') {
        // 'i' from conversation also focuses input
        e.preventDefault();
        if (userMessageInput && !userMessageInput.disabled) {
          userMessageInput.focus();
        }
      }
      // If focused on conversation area, let default Up/Down scroll it.
      // We return here to prevent global agent navigation.
      return;
    }

    const seats = getVisibleAgentSeats();
    const listItems = document.querySelectorAll('.agent-list-item');

    // Handle navigation based on current focus area
    if (currentFocusArea === 'list') {
      // List view navigation
      const focusedListItem = document.querySelector('.agent-list-item--list-focused');
      const currentIndex = focusedListItem ? Array.from(listItems).indexOf(focusedListItem) : -1;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const nextIndex = currentIndex < listItems.length - 1 ? currentIndex + 1 : 0;
        setListFocus(nextIndex);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
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
            unread: Number(focusedListItem.getAttribute('data-agent-unread') || 0),
            lastActivity: focusedListItem.getAttribute('data-agent-last-activity'),
            shouldCollapse: true
          };

          hideFloatingAgentMenu();
          selectAgent(agentId, agentName, metadata);
          setFocusArea('conversation');

          // Focus the input after selection
          setTimeout(() => {
            if (userMessageInput && !userMessageInput.disabled) {
              userMessageInput.focus();
            }
          }, 100);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setFocusArea('council');
      }
      return;
    }

    // Council chamber navigation (default)
    if (seats.length === 0) return;

    // Initialize focus if none
    if (focusedAgentIndex === -1 && (
      e.key === 'ArrowRight' || e.key === 'ArrowLeft' ||
      e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
      e.key === 'h' || e.key === 'j' || e.key === 'k' || e.key === 'l'
    )) {
      focusedAgentIndex = 0;
      updateAgentFocus();
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
      case 'l':
      case 'j':
        focusedAgentIndex = (focusedAgentIndex + 1) % seats.length;
        updateAgentFocus();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'h':
      case 'k':
        focusedAgentIndex = (focusedAgentIndex - 1 + seats.length) % seats.length;
        updateAgentFocus();
        break;
      case 'Enter':
        if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
          const seat = seats[focusedAgentIndex];
          const agentId = seat.getAttribute('data-agent-id');
          const agentName = seat.getAttribute('data-agent-name');

          // If agent is not already selected, select it
          if (agentId !== selectedAgentId) {
            const metadata = {
              priority: seat.getAttribute('data-agent-priority'),
              unread: Number(seat.getAttribute('data-agent-unread') || 0),
              lastActivity: seat.getAttribute('data-agent-last-activity'),
              shouldCollapse: true
            };

            hideFloatingAgentMenu();
            document.querySelectorAll('.agent-seat').forEach(el => el.classList.remove('agent-seat--selected'));
            seat.classList.add('agent-seat--selected');
            selectAgent(agentId, agentName, metadata);
          }

          // Move to conversation focus area
          setFocusArea('conversation');

          // Always focus the input after Enter
          setTimeout(() => {
            if (userMessageInput && !userMessageInput.disabled) {
              userMessageInput.focus();
            }
          }, 100);
        }
        break;
      case 'Escape':
        // Already in council, do nothing special
        break;
      case '/':
      case 'i':
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
  const seats = Array.from(document.querySelectorAll('.agent-seat'));
  return seats.filter(seat => seat.style.display !== 'none' && seat.style.pointerEvents !== 'none');
}

/**
 * Update visual focus state for agents
 */
function updateAgentFocus() {
  const seats = getVisibleAgentSeats();

  // Remove focus class from all (but keep selected class)
  document.querySelectorAll('.agent-seat').forEach(seat => {
    seat.classList.remove('agent-seat--focused');
  });

  // Add to current and auto-select immediately
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

    // Auto-select immediately for fast navigation (but only if not already selected)
    const agentId = seat.getAttribute('data-agent-id');
    if (agentId !== selectedAgentId) {
      seat.click();
    }
  }
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

  const updateVoiceToggleUI = (isEnabled) => {
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
  };

  if (voiceToggleBtn) {
    const initialState = window.voiceControl ? window.voiceControl.voiceEnabled : true;
    updateVoiceToggleUI(initialState);

    voiceToggleBtn.addEventListener('click', () => {
      if (!window.voiceControl) return;

      const isEnabled = !window.voiceControl.voiceEnabled;
      window.voiceControl.toggleVoiceNotifications(isEnabled);

      // Update UI
      updateVoiceToggleUI(isEnabled);

      if (isEnabled) {
        window.voiceControl.speak('Voice notifications turned on');
      }
    });
  }

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
  const copyInstructionBtn = document.getElementById('copyInstructionBtn');
  const agentHeaderInfo = document.getElementById('agentHeaderInfo');
  const contextMenu = document.getElementById('agentContextMenu');
  const floatingMenu = document.getElementById('floatingAgentMenu');

  // Toggle menu on header click
  if (agentHeaderInfo && contextMenu) {
    agentHeaderInfo.addEventListener('click', (e) => {
      // Don't toggle if clicking the buttons themselves
      if (e.target.closest('button')) return;

      e.stopPropagation();
      contextMenu.classList.toggle('hidden');
      // Hide floating menu when opening header menu
      hideFloatingAgentMenu();
    });

    // Close menus when clicking outside
    document.addEventListener('click', (e) => {
      const isAgentSeatClick = e.target.closest('.agent-seat');
      const isFloatingMenuClick = floatingMenu && floatingMenu.contains(e.target);

      // Close header context menu
      if (!contextMenu.classList.contains('hidden') && !agentHeaderInfo.contains(e.target) && !isAgentSeatClick) {
        contextMenu.classList.add('hidden');
      }

      // Close floating menu when clicking outside (but not on itself or agent seats)
      if (floatingMenu && !floatingMenu.classList.contains('hidden') && !isAgentSeatClick && !isFloatingMenuClick) {
        floatingMenu.classList.add('hidden');
      }
    });
  }

  // Setup floating menu buttons
  const floatingCopyInstructionBtn = document.getElementById('floatingCopyInstructionBtn');
  const floatingDeleteAgentBtn = document.getElementById('floatingDeleteAgentBtn');

  if (floatingCopyInstructionBtn) {
    floatingCopyInstructionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAgentInstructions();
      hideFloatingAgentMenu();
    });
  }

  if (floatingDeleteAgentBtn) {
    floatingDeleteAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteAgent();
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

  if (copyInstructionBtn) {
    copyInstructionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyAgentInstructions();
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

  // Delete agent button
  const deleteAgentBtn = document.getElementById('deleteAgentBtn');
  if (deleteAgentBtn) {
    deleteAgentBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteAgent();
      // Close menu after deletion attempt
      if (contextMenu) {
        contextMenu.classList.add('hidden');
      }
    });
  }
}

/**
 * Copy agent setup or instruction to clipboard
 */
async function copyAgentInstructions() {
  const agentNameEl = document.getElementById('selectedAgentName');
  if (!agentNameEl) return;

  const agentName = agentNameEl.textContent;
  if (!agentName) return;

  const btn = document.getElementById('copyInstructionBtn');
  if (!btn) return;

  const originalHtml = btn.innerHTML;

  try {
    btn.disabled = true;
    // Keep width to prevent layout shift if possible, or just change text
    btn.innerHTML = '<span class="animate-pulse">Fetching...</span>';

    const response = await fetch('/settings/generate-guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({
        agentName: agentName,
        variant: 'default'
      })
    });

    if (!response.ok) throw new Error('Failed to generate guide');

    const data = await response.json();

    if (data.guide) {
      await navigator.clipboard.writeText(data.guide);

      // Show success state
      btn.innerHTML = `
        <svg class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        Copied!
      `;
      btn.classList.remove('text-slate-300', 'border-slate-700');
      btn.classList.add('text-emerald-400', 'border-emerald-500/50');

      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
        btn.classList.add('text-slate-300', 'border-slate-700');
        btn.classList.remove('text-emerald-400', 'border-emerald-500/50');
      }, 2000);
    }

  } catch (error) {
    console.error('Error copying agent data:', error);
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    showErrorMessage('Failed to copy. Please try again.');
  }
}

/**
 * Delete the currently selected agent after confirmation
 */
async function deleteAgent() {
  if (!selectedAgentId) {
    showErrorMessage('No agent selected');
    return;
  }

  const agentNameEl = document.getElementById('selectedAgentName');
  const agentName = agentNameEl ? agentNameEl.textContent : 'this agent';

  // Show confirmation dialog
  const confirmed = confirm(
    `Are you sure you want to delete "${agentName}"?\n\n` +
    `This will permanently remove the agent and ALL associated messages. ` +
    `This action cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(`/api/user/agents/${selectedAgentId}`, {
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

    // Success - clear selected agent and refresh UI
    const agentIdToDelete = selectedAgentId;
    selectedAgentId = null;
    lastMessageTimestamp = null;
    lastMessageCursor = null;

    // Hide agent panel and show placeholder
    const placeholder = document.getElementById('agentPanelPlaceholder');
    const header = document.getElementById('agentPanelHeader');
    const conversationArea = document.getElementById('conversationArea');
    const messageInputArea = document.getElementById('messageInputArea');

    if (placeholder) placeholder.classList.remove('hidden');
    if (header) header.classList.add('hidden');
    if (conversationArea) conversationArea.classList.add('hidden');
    if (messageInputArea) messageInputArea.classList.add('hidden');

    // Refresh agent list (force refresh after deletion)
    await pollAgentList(true);

    // Show success message
    const toast = document.createElement('div');
    toast.className = 'fixed top-4 right-4 bg-emerald-500/90 text-white px-4 py-3 rounded-xl shadow-2xl z-50 border border-emerald-400/50 backdrop-blur';
    toast.textContent = `Agent "${agentName}" has been deleted successfully`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);

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

  // Show confirmation dialog
  const confirmed = confirm(
    `Are you sure you want to clear the conversation with "${agentName}"?\n\n` +
    `This will permanently remove ALL messages but keep the agent. ` +
    `This action cannot be undone.`
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(`/api/user/agents/${selectedAgentId}/messages`, {
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
    const toast = document.createElement('div');
    toast.className = 'fixed top-4 right-4 bg-emerald-500/90 text-white px-4 py-3 rounded-xl shadow-2xl z-50 border border-emerald-400/50 backdrop-blur';
    toast.textContent = `Conversation cleared (${data.deletedCount} messages removed)`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);

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
    const response = await fetch(`/api/user/messages/${messageId}`, {
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

function setMobileListExpanded(expanded) {
  // Use panel toggling instead of body class
  const agentListPanel = document.getElementById('agentListPanel');
  if (agentListPanel) {
    agentListPanel.classList.toggle('mobile-expanded', expanded);
  }

  // Also toggle body class for other mobile styles if needed, but we prefer checking panel state
  // ideally we remove dependence on body class, but keep it for safety if unrelated things use it
  document.body.classList.toggle('mobile-list-expanded', expanded);

  // Collapse/expand the agent dock (spheres section) along with the list
  const mobileAgentDock = document.getElementById('mobileAgentDock');
  if (mobileAgentDock) {
    // When list is collapsed, also collapse the dock
    // When list is expanded, show the dock
    mobileAgentDock.classList.toggle('mobile-agent-dock--collapsed', !expanded);
  }

  const toggleBtn = document.getElementById('collapseMobileListBtn');
  if (toggleBtn) {
    toggleBtn.title = expanded ? 'Collapse List' : 'Expand List';
    toggleBtn.setAttribute('aria-label', expanded ? 'Collapse agent list' : 'Expand agent list');

    // Rotate the chevron inside the button
    const svg = toggleBtn.querySelector('svg');
    if (svg) {
      svg.style.transform = expanded ? 'rotate(180deg)' : '';
      svg.style.transition = 'transform 0.3s';
    }
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

  // Auto-expand list view on mobile by default
  const isMobile = window.matchMedia('(max-width: 1023px)').matches;
  if (isMobile) {
    setMobileListExpanded(true);
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
  document.addEventListener('click', (e) => {
    if (e.target.closest('#collapseMobileListBtn')) {
      if (navigator.vibrate) navigator.vibrate(10);
      toggleMobileListExpanded();
    }
  });

  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('#collapseMobileListBtn')) {
      e.preventDefault();
      e.stopPropagation();
      if (navigator.vibrate) navigator.vibrate(10);
      toggleMobileListExpanded();
    }
  }, { passive: false });

  // --- Auto-collapse on Interaction ---
  const chatArea = document.querySelector('.grid.gap-5');
  if (chatArea) {
    const conversationArea = document.getElementById('conversationArea');
    if (conversationArea) {
      conversationArea.addEventListener('scroll', () => {
        if (document.body.classList.contains('mobile-list-expanded') && conversationArea.scrollTop > 20) {
          setMobileListExpanded(false);
        }
      }, { passive: true });
    }
    const messageInput = document.getElementById('userMessageInput');
    if (messageInput) {
      messageInput.addEventListener('focus', () => {
        setMobileListExpanded(false);
      });
    }
  }

  // --- Folding Header Scroll Logic ---
  const listScroll = document.getElementById('agentListScroll');

  if (listScroll && dockContainer && mobileHeader) {
    let lastScrollTop = 0;

    listScroll.addEventListener('scroll', () => {
      if (!window.matchMedia('(max-width: 1023px)').matches) return;

      const scrollTop = listScroll.scrollTop;
      if (Math.abs(scrollTop - lastScrollTop) < 10) return;

      if (scrollTop < 10) {
        // At top: Show Dock, Hide Header Nav
        dockContainer.classList.remove('mobile-agent-dock--collapsed');
        mobileHeader.classList.remove('header--compact-nav-active');
      } else if (scrollTop > lastScrollTop && scrollTop > 50) {
        // Scrolling Down: Collapse Dock, Show Header Nav
        dockContainer.classList.add('mobile-agent-dock--collapsed');
        mobileHeader.classList.add('header--compact-nav-active');
      } else if (scrollTop < lastScrollTop) {
        // Scrolling Up: Show Dock, Hide Header Nav
        dockContainer.classList.remove('mobile-agent-dock--collapsed');
        mobileHeader.classList.remove('header--compact-nav-active');
      }

      lastScrollTop = scrollTop;
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
    unread: targetAgent.unreadCount || 0,
    lastActivity: targetAgent.lastActivityTime
  };

  // Ensure dock follows the selection immediately
  dockSuppressAutoCentering = false;

  // Select the agent (this triggers UI updates and chat load)
  selectAgent(targetAgent.agentId, targetAgent.name, metadata);

  // Provide haptic feedback if available (mobile friendly)
  if (navigator.vibrate) {
    navigator.vibrate(10);
  }
}

function isMobileDockViewport() {
  return window.matchMedia && window.matchMedia('(max-width: 1023px)').matches;
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
  return '<div class="dock-agent-status dock-agent-status--idle"></div>';
}

/**
 * Update the mobile dock UI - now uses horizontal scroll instead of carousel
 */
function updateMobileDock(agents) {
  const dockCarousel = document.getElementById('dockCarousel');
  const dockPositionIndicator = document.getElementById('dockPositionIndicator');

  if (!dockCarousel) return;

  // Sort agents by fixed position
  dockSortedAgents = sortAgentsByPriority(agents);

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

  // Show ALL agents in their fixed position order (no rotation/carousel)
  let html = '';

  for (let i = 0; i < dockSortedAgents.length; i++) {
    const agent = dockSortedAgents[i];
    const isSelected = agent.agentId === selectedAgentId;
    const priorityClass = getDockPriorityClass(agent);
    const statusIndicator = getDockStatusIndicator(agent);
    const marbleSvg = MarbleGenerator.generateMarble(agent.agentId, 100, agent.name, `dock-${agent.agentId}-${Date.now()}`);

    html += `
      <div class="dock-agent ${priorityClass} ${isSelected ? 'dock-agent--selected' : ''}"
           data-agent-id="${agent.agentId}"
           data-agent-name="${escapeHtml(agent.name)}"
           data-agent-type="${agent.agentType || 'standard'}">
        <div class="dock-agent-avatar">
          <div class="marble-container">${marbleSvg}</div>
          <div class="dock-agent-initials">${escapeHtml(agent.name.substring(0, 2).toUpperCase())}</div>
          ${statusIndicator}
        </div>
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
          unread: agent.unreadCount || 0,
          lastActivity: agent.lastActivityTime
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

        selectAgent(agentId, agentName, metadata);
      }
    });
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

  if (modalLabel) {
    modalLabel.innerHTML = `Archive "<strong>${agentName}</strong>"?`;
  }

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
    const response = await fetch(`/api/user/agents/${agentId}/archive`, {
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
    const response = await fetch(`/api/user/agents/${agentId}/archive`, {
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
    if (agentPanelPlaceholder) agentPanelPlaceholder?.classList.remove('hidden');
    if (conversationArea) conversationArea.classList.add('hidden');
    if (messageInputArea) messageInputArea.classList.add('hidden');

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
          const response = await fetch('/api/user/agents/unarchive', {
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

/**
 * Setup restoration of the last opened agent on page load
 * Waits for the agent list to load, then attempts to restore the previously viewed agent
 */
function setupLastAgentRestoration() {
  // Only attempt restoration once per session
  if (lastAgentRestorationAttempted) {
    return;
  }
  lastAgentRestorationAttempted = true;

  // Get the last agent ID from localStorage
  const lastAgentId = localStorage.getItem(LAST_AGENT_STORAGE_KEY);

  if (!lastAgentId) {
    // No last agent saved, nothing to restore
    return;
  }

  // Poll for agent list to be available (up to 10 attempts with 500ms delay = 5 seconds max)
  let pollAttempts = 0;
  const maxPollAttempts = 10;

  const restoreInterval = setInterval(() => {
    pollAttempts++;

    // Check if we have agents available
    if (currentAgentList && currentAgentList.length > 0) {
      clearInterval(restoreInterval);

      // Check if the last agent still exists
      const lastAgent = currentAgentList.find(a => a.agentId === lastAgentId);

      if (lastAgent) {
        // Auto-select the last agent
        selectAgent(lastAgentId, lastAgent.agentName, {
          agentType: lastAgent.agentType || 'standard'
        });
      }
      // If agent was deleted, just skip restoration (user will see empty state)
      return;
    }

    // Stop polling after max attempts
    if (pollAttempts >= maxPollAttempts) {
      clearInterval(restoreInterval);
    }
  }, 500);
}

