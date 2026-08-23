/**
 * @jest-environment jsdom
 */

// Mirrors the interactive-space visibility behavior in dashboard.js
function setMainInteractiveContentVisibility(isVisible, selectedAgentId, stateMap) {
  const content = document.getElementById('mainInteractiveContent');
  const chevron = document.getElementById('mainInteractiveChevron');
  if (!content) return;

  if (isVisible) {
    content.classList.remove('hidden');
    chevron?.classList.add('rotate-180');
  } else {
    content.classList.add('hidden');
    chevron?.classList.remove('rotate-180');
  }

  if (selectedAgentId) {
    stateMap.set(selectedAgentId, Boolean(isVisible));
  }
}

function applyRichUpdate({
  selectedAgentId,
  richMessageHistory,
  interactivePanelStateByAgent,
  interactiveRichCountByAgent,
  allRichMessages
}) {
  const existing = richMessageHistory.get(selectedAgentId);
  const persistedCount = interactiveRichCountByAgent.has(selectedAgentId)
    ? interactiveRichCountByAgent.get(selectedAgentId)
    : null;
  const prevCount = existing
    ? existing.messages.length
    : (typeof persistedCount === 'number' ? persistedCount : allRichMessages.length);
  const wasAtNewest = !existing || existing.currentIndex === prevCount - 1;
  const hasNewRichMessage = allRichMessages.length > prevCount;

  let newIndex;
  if (wasAtNewest || !existing) {
    newIndex = allRichMessages.length - 1;
  } else {
    newIndex = Math.min(existing.currentIndex, allRichMessages.length - 1);
  }

  richMessageHistory.set(selectedAgentId, {
    messages: allRichMessages,
    currentIndex: newIndex
  });
  interactiveRichCountByAgent.set(selectedAgentId, allRichMessages.length);

  if (hasNewRichMessage) {
    interactivePanelStateByAgent.set(selectedAgentId, true);
  }

  const shouldBeOpen = interactivePanelStateByAgent.get(selectedAgentId) === true;
  setMainInteractiveContentVisibility(shouldBeOpen, null, interactivePanelStateByAgent);
}

describe('Interactive space panel state behavior', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="mainInteractiveContent" class="hidden"></div>
      <div id="mainInteractiveChevron"></div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps panel collapsed when user collapsed it and no new rich message arrived', () => {
    const history = new Map();
    const panelState = new Map();
    const richCount = new Map();
    const agentId = 'agent-1';

    history.set(agentId, { messages: [{ id: 1 }, { id: 2 }], currentIndex: 1 });
    panelState.set(agentId, false);
    richCount.set(agentId, 2);

    applyRichUpdate({
      selectedAgentId: agentId,
      richMessageHistory: history,
      interactivePanelStateByAgent: panelState,
      interactiveRichCountByAgent: richCount,
      allRichMessages: [{ id: 1 }, { id: 2 }]
    });

    const content = document.getElementById('mainInteractiveContent');
    const chevron = document.getElementById('mainInteractiveChevron');
    expect(content.classList.contains('hidden')).toBe(true);
    expect(chevron.classList.contains('rotate-180')).toBe(false);
    expect(panelState.get(agentId)).toBe(false);
  });

  it('auto-opens panel when a new rich message arrives', () => {
    const history = new Map();
    const panelState = new Map();
    const richCount = new Map();
    const agentId = 'agent-1';

    history.set(agentId, { messages: [{ id: 1 }, { id: 2 }], currentIndex: 1 });
    panelState.set(agentId, false);
    richCount.set(agentId, 2);

    applyRichUpdate({
      selectedAgentId: agentId,
      richMessageHistory: history,
      interactivePanelStateByAgent: panelState,
      interactiveRichCountByAgent: richCount,
      allRichMessages: [{ id: 1 }, { id: 2 }, { id: 3 }]
    });

    const content = document.getElementById('mainInteractiveContent');
    const chevron = document.getElementById('mainInteractiveChevron');
    expect(content.classList.contains('hidden')).toBe(false);
    expect(chevron.classList.contains('rotate-180')).toBe(true);
    expect(panelState.get(agentId)).toBe(true);
    expect(history.get(agentId).currentIndex).toBe(2);
  });

  it('stays collapsed after refresh when no new rich message arrived', () => {
    const history = new Map();
    const panelState = new Map();
    const richCount = new Map();
    const agentId = 'agent-1';

    panelState.set(agentId, false);
    richCount.set(agentId, 2);

    applyRichUpdate({
      selectedAgentId: agentId,
      richMessageHistory: history,
      interactivePanelStateByAgent: panelState,
      interactiveRichCountByAgent: richCount,
      allRichMessages: [{ id: 1 }, { id: 2 }]
    });

    const content = document.getElementById('mainInteractiveContent');
    expect(content.classList.contains('hidden')).toBe(true);
    expect(panelState.get(agentId)).toBe(false);
  });

  it('auto-opens after refresh when rich message count increased', () => {
    const history = new Map();
    const panelState = new Map();
    const richCount = new Map();
    const agentId = 'agent-1';

    panelState.set(agentId, false);
    richCount.set(agentId, 2);

    applyRichUpdate({
      selectedAgentId: agentId,
      richMessageHistory: history,
      interactivePanelStateByAgent: panelState,
      interactiveRichCountByAgent: richCount,
      allRichMessages: [{ id: 1 }, { id: 2 }, { id: 3 }]
    });

    const content = document.getElementById('mainInteractiveContent');
    expect(content.classList.contains('hidden')).toBe(false);
    expect(panelState.get(agentId)).toBe(true);
  });
});
