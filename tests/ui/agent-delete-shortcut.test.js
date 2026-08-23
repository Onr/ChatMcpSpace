/**
 * @jest-environment jsdom
 */

function resolveDeleteShortcutTarget({
  currentFocusArea = 'council',
  focusedAgentIndex = -1,
  seats = [],
  selectedAgentId = null,
  selectedAgentName = '',
  focusedListItem = null
}) {
  if (currentFocusArea === 'list') {
    if (!focusedListItem) return null;
    const agentId = focusedListItem.getAttribute('data-agent-id') || null;
    if (!agentId) return null;
    return {
      agentId,
      agentName: focusedListItem.getAttribute('data-agent-name') || ''
    };
  }

  if (focusedAgentIndex >= 0 && focusedAgentIndex < seats.length) {
    const seat = seats[focusedAgentIndex];
    const agentId = seat.getAttribute('data-agent-id') || null;
    if (!agentId) return null;
    return {
      agentId,
      agentName: seat.getAttribute('data-agent-name') || ''
    };
  }

  if (selectedAgentId) {
    const selectedSeat = seats.find((seat) => seat.getAttribute('data-agent-id') === selectedAgentId);
    if (selectedSeat) {
      return {
        agentId: selectedSeat.getAttribute('data-agent-id') || selectedAgentId,
        agentName: selectedSeat.getAttribute('data-agent-name') || selectedAgentName || ''
      };
    }
  }

  return null;
}

function shouldHandleDeleteShortcut(event) {
  const isInput = event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA';
  const isEditableTarget = isInput || event.target?.isContentEditable === true;
  const isDeleteShortcut = event.key === 'Delete' || event.key === 'Del';

  return (
    isDeleteShortcut &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isEditableTarget
  );
}

describe('Agent delete keyboard shortcut target resolution', () => {
  function createSeat(agentId, agentName) {
    const seat = document.createElement('button');
    seat.className = 'agent-seat';
    seat.setAttribute('data-agent-id', agentId);
    seat.setAttribute('data-agent-name', agentName);
    return seat;
  }

  function createListItem(agentId, agentName, focused = false) {
    const item = document.createElement('button');
    item.className = focused ? 'agent-list-item agent-list-item--list-focused' : 'agent-list-item';
    item.setAttribute('data-agent-id', agentId);
    item.setAttribute('data-agent-name', agentName);
    return item;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('targets focused list item when focus area is list', () => {
    const listItem = createListItem('agent-list-1', 'List Agent', true);

    const target = resolveDeleteShortcutTarget({
      currentFocusArea: 'list',
      focusedListItem: listItem
    });

    expect(target).toEqual({
      agentId: 'agent-list-1',
      agentName: 'List Agent'
    });
  });

  it('targets focused council seat when focus area is council', () => {
    const seats = [createSeat('agent-a', 'Agent A'), createSeat('agent-b', 'Agent B')];

    const target = resolveDeleteShortcutTarget({
      currentFocusArea: 'council',
      focusedAgentIndex: 1,
      seats
    });

    expect(target).toEqual({
      agentId: 'agent-b',
      agentName: 'Agent B'
    });
  });

  it('falls back to selected seat when council focus index is unset', () => {
    const seats = [createSeat('agent-a', 'Agent A'), createSeat('agent-b', 'Agent B')];

    const target = resolveDeleteShortcutTarget({
      currentFocusArea: 'council',
      focusedAgentIndex: -1,
      seats,
      selectedAgentId: 'agent-a',
      selectedAgentName: 'Agent A'
    });

    expect(target).toEqual({
      agentId: 'agent-a',
      agentName: 'Agent A'
    });
  });

  it('returns null when no focused or selected agent can be resolved', () => {
    const target = resolveDeleteShortcutTarget({
      currentFocusArea: 'council',
      focusedAgentIndex: -1,
      seats: []
    });

    expect(target).toBeNull();
  });
});

describe('Agent delete keyboard shortcut guards', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('handles Delete on non-editable targets', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);

    const shouldHandle = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target
    });

    expect(shouldHandle).toBe(true);
  });

  it('ignores Delete while typing in inputs or textareas', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');

    const inputResult = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: input
    });

    const textareaResult = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: textarea
    });

    expect(inputResult).toBe(false);
    expect(textareaResult).toBe(false);
  });

  it('ignores Delete with modifier keys', () => {
    const target = document.createElement('div');

    const withCtrl = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      target
    });

    const withMeta = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      target
    });

    const withAlt = shouldHandleDeleteShortcut({
      key: 'Delete',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      target
    });

    expect(withCtrl).toBe(false);
    expect(withMeta).toBe(false);
    expect(withAlt).toBe(false);
  });
});
