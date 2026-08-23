/**
 * @jest-environment jsdom
 */

function getAgentMenuStatsSections(targetMenus = []) {
  if (targetMenus.length > 0) {
    return targetMenus
      .map((menu) => menu?.querySelector?.('.agent-menu-stats'))
      .filter(Boolean);
  }
  return Array.from(document.querySelectorAll('.agent-menu-stats'));
}

function updateAgentMenuStatsDisplay({ messageCount = '\u2014', lastHeartbeat = '\u2014', visibleChars = '\u2014' }, targetMenus = []) {
  const sections = getAgentMenuStatsSections(targetMenus);
  sections.forEach((section) => {
    const messageCountEl = section.querySelector('[data-agent-stat="message-count"]');
    const lastHeartbeatEl = section.querySelector('[data-agent-stat="last-heartbeat"]');
    const visibleCharsEl = section.querySelector('[data-agent-stat="visible-chars"]');
    if (messageCountEl) messageCountEl.textContent = messageCount;
    if (lastHeartbeatEl) lastHeartbeatEl.textContent = lastHeartbeat;
    if (visibleCharsEl) visibleCharsEl.textContent = visibleChars;
  });
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

function formatAgentStatsHeartbeat(lastHeartbeat, formatRelativeTimeFn) {
  if (!lastHeartbeat) return 'No heartbeat yet';
  const asDate = new Date(lastHeartbeat);
  if (Number.isNaN(asDate.getTime())) return 'No heartbeat yet';
  return formatRelativeTimeFn(lastHeartbeat);
}

describe('Agent action menu stats', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('counts all messages but only visible characters from non-hidden text', () => {
    const stats = calculateConversationVisibilityStats([
      { content: 'alpha', hiddenFromAgent: false },
      { content: 'beta', hiddenFromAgent: true },
      { content: 'gamma', hiddenFromAgent: false },
      { content: { rich: true }, hiddenFromAgent: false },
      null
    ]);

    expect(stats).toEqual({
      totalMessages: 5,
      visibleChars: 'alpha'.length + 'gamma'.length
    });
  });

  it('updates every stats panel instance with the same values', () => {
    document.body.innerHTML = `
      <div id="floatingAgentMenu"><div class="agent-menu-stats">
        <span data-agent-stat="message-count">\u2014</span>
        <span data-agent-stat="last-heartbeat">\u2014</span>
        <span data-agent-stat="visible-chars">\u2014</span>
      </div></div>
      <div id="agentContextMenu"><div class="agent-menu-stats">
        <span data-agent-stat="message-count">\u2014</span>
        <span data-agent-stat="last-heartbeat">\u2014</span>
        <span data-agent-stat="visible-chars">\u2014</span>
      </div></div>
    `;

    updateAgentMenuStatsDisplay({
      messageCount: '12',
      lastHeartbeat: '2m ago',
      visibleChars: '345'
    });

    const sections = document.querySelectorAll('.agent-menu-stats');
    expect(sections).toHaveLength(2);
    sections.forEach((section) => {
      expect(section.querySelector('[data-agent-stat="message-count"]').textContent).toBe('12');
      expect(section.querySelector('[data-agent-stat="last-heartbeat"]').textContent).toBe('2m ago');
      expect(section.querySelector('[data-agent-stat="visible-chars"]').textContent).toBe('345');
    });
  });

  it('falls back cleanly when heartbeat is missing or invalid', () => {
    const formatter = jest.fn(() => 'formatted');

    expect(formatAgentStatsHeartbeat('', formatter)).toBe('No heartbeat yet');
    expect(formatAgentStatsHeartbeat('not-a-date', formatter)).toBe('No heartbeat yet');
    expect(formatAgentStatsHeartbeat('2026-03-07T12:00:00.000Z', formatter)).toBe('formatted');
    expect(formatter).toHaveBeenCalledTimes(1);
  });
});
