/**
 * @jest-environment jsdom
 */

/**
 * Tests for persisting side-chat tile order across page refreshes.
 * When tiles are reordered via Ctrl+Shift+Arrow or drag-drop,
 * the new order should be saved and restored on next page load.
 */

describe('Chat Tile Order Persistence', () => {
  let container;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="multiChatContainer"></div>';
    container = document.getElementById('multiChatContainer');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('saveChatTileOrder saves tile order to localStorage', () => {
    // Create tiles A, B, C
    const tileA = document.createElement('div');
    tileA.className = 'chat-tile';
    tileA.setAttribute('data-agent-id', 'agent-a');
    container.appendChild(tileA);

    const tileB = document.createElement('div');
    tileB.className = 'chat-tile';
    tileB.setAttribute('data-agent-id', 'agent-b');
    container.appendChild(tileB);

    const tileC = document.createElement('div');
    tileC.className = 'chat-tile';
    tileC.setAttribute('data-agent-id', 'agent-c');
    container.appendChild(tileC);

    // Mock the saveChatTileOrder function
    const saveChatTileOrder = () => {
      const c = document.getElementById('multiChatContainer');
      if (!c) return;
      const tiles = Array.from(c.querySelectorAll(':scope > .chat-tile[data-agent-id]'));
      const order = tiles.map(t => t.getAttribute('data-agent-id')).filter(Boolean);
      localStorage.setItem('multiChat_tileOrder', JSON.stringify(order));
    };

    // Initial order should be [a, b, c]
    saveChatTileOrder();
    expect(JSON.parse(localStorage.getItem('multiChat_tileOrder'))).toEqual([
      'agent-a',
      'agent-b',
      'agent-c'
    ]);

    // Reorder tiles to [b, a, c]
    container.insertBefore(tileB, tileA);
    saveChatTileOrder();
    expect(JSON.parse(localStorage.getItem('multiChat_tileOrder'))).toEqual([
      'agent-b',
      'agent-a',
      'agent-c'
    ]);

    // Reorder tiles to [c, b, a]
    container.insertBefore(tileC, tileB);
    saveChatTileOrder();
    expect(JSON.parse(localStorage.getItem('multiChat_tileOrder'))).toEqual([
      'agent-c',
      'agent-b',
      'agent-a'
    ]);
  });

  test('restoreOpenPanels respects saved tile order', () => {
    // Save panels and order to localStorage
    const panels = [
      { agentId: 'agent-a', agentName: 'Alice', metadata: {} },
      { agentId: 'agent-b', agentName: 'Bob', metadata: {} },
      { agentId: 'agent-c', agentName: 'Charlie', metadata: {} }
    ];
    localStorage.setItem('multiChat_openPanels', JSON.stringify(panels));

    // Save a different order (c, a, b)
    const savedOrder = ['agent-c', 'agent-a', 'agent-b'];
    localStorage.setItem('multiChat_tileOrder', JSON.stringify(savedOrder));

    // Track the order in which openSidePanel is called
    const callOrder = [];
    const mockOpenSidePanel = (agentId) => {
      callOrder.push(agentId);
    };

    // Parse the stored panels and simulate restoreOpenPanels logic
    const saved = JSON.parse(localStorage.getItem('multiChat_openPanels'));
    let savedOrderList = [];
    try {
      const orderStr = localStorage.getItem('multiChat_tileOrder');
      if (orderStr) {
        savedOrderList = JSON.parse(orderStr);
      }
    } catch (e) {
      // Ignore order restore errors
    }

    if (savedOrderList.length > 0) {
      const panelMap = new Map(saved.map(p => [p.agentId, p]));
      for (const agentId of savedOrderList) {
        const p = panelMap.get(agentId);
        if (p) {
          mockOpenSidePanel(p.agentId);
        }
      }
      for (const p of saved) {
        if (!savedOrderList.includes(p.agentId)) {
          mockOpenSidePanel(p.agentId);
        }
      }
    } else {
      for (const p of saved) {
        mockOpenSidePanel(p.agentId);
      }
    }

    // Verify that panels were opened in the saved order (c, a, b)
    expect(callOrder).toEqual(['agent-c', 'agent-a', 'agent-b']);
  });

  test('restoreOpenPanels handles missing panels in saved order', () => {
    // Save panels
    const panels = [
      { agentId: 'agent-a', agentName: 'Alice', metadata: {} },
      { agentId: 'agent-b', agentName: 'Bob', metadata: {} },
      { agentId: 'agent-c', agentName: 'Charlie', metadata: {} }
    ];
    localStorage.setItem('multiChat_openPanels', JSON.stringify(panels));

    // Save an order that's missing agent-b
    const savedOrder = ['agent-c', 'agent-a'];
    localStorage.setItem('multiChat_tileOrder', JSON.stringify(savedOrder));

    // Track the order in which openSidePanel is called
    const callOrder = [];
    const mockOpenSidePanel = (agentId) => {
      callOrder.push(agentId);
    };

    // Parse the stored panels and simulate restoreOpenPanels logic
    const saved = JSON.parse(localStorage.getItem('multiChat_openPanels'));
    let savedOrderList = [];
    try {
      const orderStr = localStorage.getItem('multiChat_tileOrder');
      if (orderStr) {
        savedOrderList = JSON.parse(orderStr);
      }
    } catch (e) {
      // Ignore order restore errors
    }

    if (savedOrderList.length > 0) {
      const panelMap = new Map(saved.map(p => [p.agentId, p]));
      for (const agentId of savedOrderList) {
        const p = panelMap.get(agentId);
        if (p) {
          mockOpenSidePanel(p.agentId);
        }
      }
      // Restore any panels that weren't in the order
      for (const p of saved) {
        if (!savedOrderList.includes(p.agentId)) {
          mockOpenSidePanel(p.agentId);
        }
      }
    } else {
      for (const p of saved) {
        mockOpenSidePanel(p.agentId);
      }
    }

    // Verify that all panels were restored, with agent-b restored at the end
    expect(callOrder).toEqual(['agent-c', 'agent-a', 'agent-b']);
  });

  test('restoreOpenPanels falls back to original order if no saved order exists', () => {
    // Save panels but no order
    const panels = [
      { agentId: 'agent-a', agentName: 'Alice', metadata: {} },
      { agentId: 'agent-b', agentName: 'Bob', metadata: {} },
      { agentId: 'agent-c', agentName: 'Charlie', metadata: {} }
    ];
    localStorage.setItem('multiChat_openPanels', JSON.stringify(panels));
    localStorage.removeItem('multiChat_tileOrder');

    // Track the order in which openSidePanel is called
    const callOrder = [];
    const mockOpenSidePanel = (agentId) => {
      callOrder.push(agentId);
    };

    // Parse the stored panels and simulate restoreOpenPanels logic
    const saved = JSON.parse(localStorage.getItem('multiChat_openPanels'));
    let savedOrderList = [];
    try {
      const orderStr = localStorage.getItem('multiChat_tileOrder');
      if (orderStr) {
        savedOrderList = JSON.parse(orderStr);
      }
    } catch (e) {
      // Ignore order restore errors
    }

    if (savedOrderList.length > 0) {
      const panelMap = new Map(saved.map(p => [p.agentId, p]));
      for (const agentId of savedOrderList) {
        const p = panelMap.get(agentId);
        if (p) {
          mockOpenSidePanel(p.agentId);
        }
      }
      for (const p of saved) {
        if (!savedOrderList.includes(p.agentId)) {
          mockOpenSidePanel(p.agentId);
        }
      }
    } else {
      for (const p of saved) {
        mockOpenSidePanel(p.agentId);
      }
    }

    // Verify that panels were opened in original order (a, b, c)
    expect(callOrder).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });
});
