/**
 * @jest-environment jsdom
 */

/**
 * Tests for Agent Availability Detection and UI Rendering
 *
 * Tests cover:
 * - getAgentAvailability() time-based availability classification
 * - Orbit view availability dot HTML rendering
 * - Agent list panel status badge rendering
 * - Mobile dock status indicator rendering
 *
 * Note: getAgentAvailability is a global browser function in dashboard.js,
 * not exported as a module. The implementation below mirrors the production
 * code for pure unit testing.
 */

// ---------------------------------------------------------------------------
// Mirror of production getAgentAvailability from public/js/dashboard.js ~L890
// ---------------------------------------------------------------------------
function getAgentAvailability(agent) {
  if (!agent.lastActivityTime) return 'offline';
  const ageMs = Date.now() - new Date(agent.lastActivityTime).getTime();
  if (ageMs <= 5 * 60 * 1000) return 'online';    // within 5 minutes
  if (ageMs <= 60 * 60 * 1000) return 'idle';      // within 1 hour
  return 'offline';                                  // over 1 hour
}

// ---------------------------------------------------------------------------
// Mirror of production getDockStatusIndicator from dashboard.js ~L7562
// ---------------------------------------------------------------------------
function getDockStatusIndicator(agent) {
  if (agent.highestPriority === 'high') {
    return '<div class="dock-agent-status dock-agent-status--urgent">!</div>';
  }
  if (agent.unreadCount > 0) {
    return `<div class="dock-agent-status dock-agent-status--attention">${agent.unreadCount}</div>`;
  }
  if (agent.isWorking === true) {
    return '<div class="dock-agent-status dock-agent-status--attention">&#x1F6E0;&#xFE0F;</div>';
  }
  const avail = getAgentAvailability(agent);
  if (avail === 'online') return '<div class="dock-agent-status dock-agent-status--idle"></div>';
  if (avail === 'idle') return '<div class="dock-agent-status dock-agent-status--away"></div>';
  return '<div class="dock-agent-status dock-agent-status--offline">\u2715</div>';
}

// ---------------------------------------------------------------------------
// Helper: build the orbit availability dot HTML (mirrors dashboard.js ~L1079)
// ---------------------------------------------------------------------------
function formatRelativeTime(ts) {
  return ts ? 'recently' : '';
}

function getOrbitAvailabilityDot(agent) {
  const avail = getAgentAvailability(agent);
  if (avail === 'online') {
    return `<div class="absolute bottom-0 right-0 z-20 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-slate-900 shadow-[0_0_10px_rgba(52,211,153,0.6)]" title="Online${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"></div>`;
  }
  if (avail === 'idle') {
    return `<div class="absolute bottom-0 right-0 z-20 w-3.5 h-3.5 rounded-full bg-slate-400 border-2 border-slate-900 shadow-[0_0_6px_rgba(148,163,184,0.4)]" title="Idle${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"></div>`;
  }
  return `<div class="absolute bottom-0 right-0 z-20 agent-status-disconnected" title="Disconnected${agent.lastSeenAt ? ` – last poll ${formatRelativeTime(agent.lastSeenAt)}` : agent.lastActivityTime ? ` – last seen ${formatRelativeTime(agent.lastActivityTime)}` : ''}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><line x1="5" y1="5" x2="11" y2="11"/></svg></div>`;
}

// ---------------------------------------------------------------------------
// Helper: build the agent list panel status HTML (mirrors dashboard.js ~L1207)
// ---------------------------------------------------------------------------
function getAgentListStatusHtml(agent) {
  const avail = getAgentAvailability(agent);
  const isWorking = agent.isWorking === true;

  if (agent.highestPriority === 'high') {
    return `<span class="agent-list-item__badge agent-list-item__badge--urgent">!</span> Urgent`;
  }
  if (agent.unreadCount > 0) {
    return `<span class="agent-list-item__badge agent-list-item__badge--unread">${agent.unreadCount}</span> Unread`;
  }
  if (isWorking) {
    return `<span class="agent-list-item__badge agent-list-item__badge--working"></span> Working`;
  }
  if (avail === 'online') {
    return `<span class="agent-list-item__badge agent-list-item__badge--idle"></span> Online`;
  }
  if (avail === 'idle') {
    return `<span class="agent-list-item__badge agent-list-item__badge--away"></span> Away`;
  }
  return `<span class="agent-list-item__badge agent-list-item__badge--offline"></span> Offline`;
}

function getAgentListTimestampsHtml(agent) {
  return [
    agent.isWorking === true && agent.lastWorkingHeartbeatTime ? `<span class="agent-list-item__time" title="Last Working Heartbeat">Working ${formatRelativeTime(agent.lastWorkingHeartbeatTime)}</span>` : '',
    agent.lastSeenAt ? `<span class="agent-list-item__time" title="Last Poll">Poll ${formatRelativeTime(agent.lastSeenAt)}</span>` : agent.lastActivityTime ? `<span class="agent-list-item__time" title="Last Active">Active ${formatRelativeTime(agent.lastActivityTime)}</span>` : '',
    agent.lastMessageTime ? `<span class="agent-list-item__time" title="Last Message">Msg ${formatRelativeTime(agent.lastMessageTime)}</span>` : ''
  ].join('');
}

// ============================================================================
// getAgentAvailability Unit Tests
// ============================================================================

describe('getAgentAvailability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns "offline" when lastActivityTime is null', () => {
    expect(getAgentAvailability({ lastActivityTime: null })).toBe('offline');
  });

  test('returns "offline" when lastActivityTime is undefined', () => {
    expect(getAgentAvailability({})).toBe('offline');
  });

  test('returns "online" when agent was active 1 minute ago', () => {
    const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: oneMinAgo })).toBe('online');
  });

  test('returns "online" at the exact 5-minute boundary', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: fiveMinAgo })).toBe('online');
  });

  test('returns "idle" when agent was active 10 minutes ago', () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: tenMinAgo })).toBe('idle');
  });

  test('returns "idle" when agent was active 30 minutes ago', () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: thirtyMinAgo })).toBe('idle');
  });

  test('returns "idle" at the exact 1-hour boundary', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: oneHourAgo })).toBe('idle');
  });

  test('returns "offline" when agent was active 2 hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: twoHoursAgo })).toBe('offline');
  });

  test('returns "offline" when agent was active days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgentAvailability({ lastActivityTime: threeDaysAgo })).toBe('offline');
  });

  test('returns "offline" for invalid date string (NaN comparison)', () => {
    // new Date('not-a-date').getTime() returns NaN; NaN comparisons are false
    // so both <= checks fail, falling through to 'offline'
    expect(getAgentAvailability({ lastActivityTime: 'not-a-valid-date' })).toBe('offline');
  });
});

// ============================================================================
// Orbit View Availability Dot Rendering
// ============================================================================

describe('Orbit View Availability Dot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('online agent gets green dot with bg-emerald-400', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 60 * 1000).toISOString(),
      lastSeenAt: new Date(Date.now() - 30 * 1000).toISOString()
    };
    const html = getOrbitAvailabilityDot(agent);
    expect(html).toContain('bg-emerald-400');
    expect(html).toContain('rounded-full');
    expect(html).toContain('title="Online – last poll recently');
  });

  test('idle agent gets gray dot with bg-slate-400', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    };
    const html = getOrbitAvailabilityDot(agent);
    expect(html).toContain('bg-slate-400');
    expect(html).toContain('rounded-full');
    expect(html).toContain('title="Idle – last poll recently');
  });

  test('offline agent gets SVG disconnected icon', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    };
    const html = getOrbitAvailabilityDot(agent);
    expect(html).toContain('agent-status-disconnected');
    expect(html).toContain('<svg');
    expect(html).toContain('title="Disconnected – last poll recently');
  });
});

// ============================================================================
// Agent List Panel Status Badges
// ============================================================================

describe('Agent List Panel Status Badges', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('online agent shows "Online" with badge--idle class', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--idle');
    expect(html).toContain('Online');
  });

  test('idle/away agent shows "Away" with badge--away class', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--away');
    expect(html).toContain('Away');
  });

  test('offline agent shows "Offline" with badge--offline class', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--offline');
    expect(html).toContain('Offline');
  });

  test('working agents show "Working" regardless of availability', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: true
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--working');
    expect(html).toContain('Working');
    expect(html).not.toContain('Offline');
  });

  test('urgent badge takes priority over availability', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 60 * 1000).toISOString(),
      highestPriority: 'high',
      unreadCount: 0,
      isWorking: false
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--urgent');
    expect(html).toContain('Urgent');
    expect(html).not.toContain('Online');
  });

  test('unread badge takes priority over availability', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 3,
      isWorking: false
    };
    const html = getAgentListStatusHtml(agent);
    expect(html).toContain('badge--unread');
    expect(html).toContain('Unread');
    expect(html).toContain('3');
    expect(html).not.toContain('Online');
  });
});

describe('Agent List Panel Timestamps', () => {
  test('prefers Poll label when lastSeenAt is available', () => {
    const html = getAgentListTimestampsHtml({
      lastSeenAt: new Date('2025-06-15T11:59:00Z').toISOString(),
      lastActivityTime: new Date('2025-06-15T11:58:00Z').toISOString()
    });

    expect(html).toContain('title="Last Poll"');
    expect(html).toContain('Poll recently');
    expect(html).not.toContain('Active recently');
  });

  test('falls back to Active label when lastSeenAt is missing', () => {
    const html = getAgentListTimestampsHtml({
      lastActivityTime: new Date('2025-06-15T11:58:00Z').toISOString()
    });

    expect(html).toContain('title="Last Active"');
    expect(html).toContain('Active recently');
  });
});

// ============================================================================
// Mobile Dock Status Indicators
// ============================================================================

describe('Mobile Dock Status Indicators', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('online agent returns dock-agent-status--idle div', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getDockStatusIndicator(agent);
    expect(html).toContain('dock-agent-status--idle');
  });

  test('idle agent returns dock-agent-status--away div', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getDockStatusIndicator(agent);
    expect(html).toContain('dock-agent-status--away');
  });

  test('offline agent returns dock-agent-status--offline with cross mark', () => {
    const agent = {
      lastActivityTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      highestPriority: 'normal',
      unreadCount: 0,
      isWorking: false
    };
    const html = getDockStatusIndicator(agent);
    expect(html).toContain('dock-agent-status--offline');
    expect(html).toContain('\u2715');
  });
});
