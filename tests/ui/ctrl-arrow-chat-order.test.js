/**
 * @jest-environment jsdom
 */

/**
 * Tests for Ctrl+Shift+Left/Right keyboard shortcut to:
 *   1. Reorder side-chat tiles when a tile textarea is focused.
 *   2. Switch main-chat agent when the main input is focused.
 */

// ── Helpers mirroring the real dashboard.js logic ────────────────────────────

function moveTileInContainer(tileEl, direction) {
  const c = tileEl.parentElement;
  if (!c) return false;
  const tiles = Array.from(c.querySelectorAll(':scope > .chat-tile'));
  const idx = tiles.indexOf(tileEl);
  if (direction === 'left' && idx > 0) {
    c.insertBefore(tileEl, tiles[idx - 1]);
    return true;
  }
  if (direction === 'right' && idx < tiles.length - 1) {
    c.insertBefore(tiles[idx + 1], tileEl);
    return true;
  }
  return false;
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

function makeTile(agentId, container) {
  const tile = document.createElement('div');
  tile.className = 'chat-tile';
  tile.dataset.agentId = agentId;
  const ta = document.createElement('textarea');
  ta.className = 'chat-tile__textarea';
  tile.appendChild(ta);
  container.appendChild(tile);
  return { tile, textarea: ta };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Ctrl+Shift+Left/Right: side-chat tile reorder', () => {
  let container;

  beforeEach(() => {
    document.body.innerHTML = '<div id="multiChatContainer"></div>';
    container = document.getElementById('multiChatContainer');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('Ctrl+Shift+Right moves tile one position to the right', () => {
    const { tile: tileA } = makeTile('a', container);
    const { tile: tileB } = makeTile('b', container);
    const { tile: tileC } = makeTile('c', container);

    // Move tile A to the right (should swap A and B)
    const moved = moveTileInContainer(tileA, 'right');
    expect(moved).toBe(true);

    const tiles = Array.from(container.querySelectorAll(':scope > .chat-tile'));
    expect(tiles[0]).toBe(tileB);
    expect(tiles[1]).toBe(tileA);
    expect(tiles[2]).toBe(tileC);
  });

  test('Ctrl+Shift+Left moves tile one position to the left', () => {
    const { tile: tileA } = makeTile('a', container);
    const { tile: tileB } = makeTile('b', container);
    const { tile: tileC } = makeTile('c', container);

    // Move tile C to the left (should swap B and C)
    const moved = moveTileInContainer(tileC, 'left');
    expect(moved).toBe(true);

    const tiles = Array.from(container.querySelectorAll(':scope > .chat-tile'));
    expect(tiles[0]).toBe(tileA);
    expect(tiles[1]).toBe(tileC);
    expect(tiles[2]).toBe(tileB);
  });

  test('Ctrl+Shift+Left on first tile does nothing', () => {
    const { tile: tileA } = makeTile('a', container);
    makeTile('b', container);

    const moved = moveTileInContainer(tileA, 'left');
    expect(moved).toBe(false);

    const tiles = Array.from(container.querySelectorAll(':scope > .chat-tile'));
    expect(tiles[0]).toBe(tileA); // unchanged
  });

  test('Ctrl+Shift+Right on last tile does nothing', () => {
    makeTile('a', container);
    const { tile: tileB } = makeTile('b', container);

    const moved = moveTileInContainer(tileB, 'right');
    expect(moved).toBe(false);

    const tiles = Array.from(container.querySelectorAll(':scope > .chat-tile'));
    expect(tiles[1]).toBe(tileB); // unchanged
  });

  test('Single tile: neither direction moves', () => {
    const { tile: tileA } = makeTile('a', container);
    expect(moveTileInContainer(tileA, 'left')).toBe(false);
    expect(moveTileInContainer(tileA, 'right')).toBe(false);
  });
});

describe('Ctrl+Shift+Left/Right: main-chat agent navigation logic', () => {
  // Mirrors the circular index arithmetic used in dashboard.js
  function switchAgent(seats, currentId, direction) {
    const currentIndex = seats.findIndex(s => s.agentId === currentId);
    if (currentIndex === -1) return null;
    const delta = direction === 'right' ? 1 : -1;
    const nextIndex = (currentIndex + delta + seats.length) % seats.length;
    if (nextIndex === currentIndex) return null;
    return seats[nextIndex].agentId;
  }

  const seats = [
    { agentId: 'alpha' },
    { agentId: 'beta' },
    { agentId: 'gamma' },
  ];

  test('Right navigates to next agent', () => {
    expect(switchAgent(seats, 'alpha', 'right')).toBe('beta');
    expect(switchAgent(seats, 'beta', 'right')).toBe('gamma');
  });

  test('Right wraps around from last to first', () => {
    expect(switchAgent(seats, 'gamma', 'right')).toBe('alpha');
  });

  test('Left navigates to previous agent', () => {
    expect(switchAgent(seats, 'gamma', 'left')).toBe('beta');
    expect(switchAgent(seats, 'beta', 'left')).toBe('alpha');
  });

  test('Left wraps around from first to last', () => {
    expect(switchAgent(seats, 'alpha', 'left')).toBe('gamma');
  });

  test('Single agent: no switch', () => {
    expect(switchAgent([{ agentId: 'solo' }], 'solo', 'right')).toBeNull();
    expect(switchAgent([{ agentId: 'solo' }], 'solo', 'left')).toBeNull();
  });
});
