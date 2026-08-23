/**
 * @jest-environment jsdom
 */

/**
 * Mirrors the side-panel focus guard introduced in dashboard.js.
 */
function shouldSelectIntoSidePanel(agentId, metadata = {}, multiChatManager = null) {
  if (!agentId || metadata.forceMainSelection === true) {
    return false;
  }
  return Boolean(
    multiChatManager &&
    typeof multiChatManager.isOpen === 'function' &&
    multiChatManager.isOpen(agentId)
  );
}

/**
 * Mirrors the post-selection focus behavior used by council/list click handlers.
 */
function applyPostSelectionFocus({ agentId, metadata = {}, multiChatManager = null }) {
  const sideInput = document.getElementById('sideChatInput');
  const mainInput = document.getElementById('userMessageInput');
  const focusSidePanel = shouldSelectIntoSidePanel(agentId, metadata, multiChatManager);

  // Simulate selectAgent() behavior when the side panel is already open.
  if (focusSidePanel) {
    sideInput?.focus();
  }

  // Mirrors the new guard: main input focus is skipped when side panel should own focus.
  if (!focusSidePanel && mainInput && !mainInput.disabled) {
    mainInput.focus();
  }
}

describe('Agent selection focus routing', () => {
  const agentId = 'agent-123';

  beforeEach(() => {
    document.body.innerHTML = `
      <textarea id="userMessageInput"></textarea>
      <textarea id="sideChatInput"></textarea>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses side chat input when selected agent is already open in side panel', () => {
    const manager = { isOpen: (id) => id === agentId };

    applyPostSelectionFocus({ agentId, metadata: {}, multiChatManager: manager });

    expect(document.activeElement?.id).toBe('sideChatInput');
  });

  it('focuses main input when selected agent is not open in side panel', () => {
    const manager = { isOpen: () => false };

    applyPostSelectionFocus({ agentId, metadata: {}, multiChatManager: manager });

    expect(document.activeElement?.id).toBe('userMessageInput');
  });

  it('respects forceMainSelection even when side panel is open', () => {
    const manager = { isOpen: (id) => id === agentId };

    applyPostSelectionFocus({
      agentId,
      metadata: { forceMainSelection: true },
      multiChatManager: manager
    });

    expect(document.activeElement?.id).toBe('userMessageInput');
  });
});
