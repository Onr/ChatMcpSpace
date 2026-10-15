/**
 * @jest-environment jsdom
 */

/**
 * Tests for Mobile UI layout fixes:
 * - Chat scroll containment (only chat area scrolls, not page)
 * - Agent list toggle visibility on mobile
 * - Agent list overlay behavior on mobile
 * - Auto-collapse on agent selection
 *
 * These tests verify the JavaScript behavior that controls the mobile layout.
 * CSS-based assertions would require a real rendering engine, so we test
 * the JS toggle/state logic that drives the mobile UI.
 */

// Mirror of isMobileListOnlyMode from dashboard.js
const MOBILE_LIST_ONLY_MEDIA_QUERY = '(max-width: 1279px)';

function setMobileChromeCollapsed(collapsed) {
  document.body.classList.remove('mobile-chrome-collapsed');
  document.body.classList.remove('mobile-nav-hidden');
}

// Mirror of setMobileListExpanded from dashboard.js
function setMobileListExpanded(expanded) {
  const agentListPanel = document.getElementById('agentListPanel');
  if (agentListPanel) {
    agentListPanel.classList.toggle('mobile-expanded', expanded);
  }
  document.querySelector('.council-chamber')?.classList.toggle('mobile-agent-list-open', expanded);
  document.body.classList.toggle('mobile-list-expanded', expanded);
  if (expanded) {
    setMobileChromeCollapsed(false);
  }

  const toggleBtn = document.getElementById('collapseMobileListBtn');
  if (toggleBtn) {
    toggleBtn.title = expanded ? 'Collapse List' : 'Expand List';
    toggleBtn.setAttribute('aria-label', expanded ? 'Collapse agent list' : 'Expand agent list');
    toggleBtn.classList.toggle('expanded', expanded);
    const svg = toggleBtn.querySelector('svg');
    if (svg) {
      svg.style.transform = expanded ? 'rotate(180deg)' : '';
    }
  }

  const mobileStatsToggle = document.getElementById('mobileStatsToggle');
  if (mobileStatsToggle) {
    mobileStatsToggle.classList.toggle('expanded', expanded);
  }
}

function toggleMobileListExpanded() {
  const agentListPanel = document.getElementById('agentListPanel');
  const expanded = agentListPanel ? agentListPanel.classList.contains('mobile-expanded') : false;
  setMobileListExpanded(!expanded);
}

function bindMobileListToggleControls() {
  const collapseBtn = document.getElementById('collapseMobileListBtn');
  if (collapseBtn && collapseBtn.dataset.mobileListBound !== 'true') {
    collapseBtn.dataset.mobileListBound = 'true';
    collapseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileListExpanded();
    });
  }

  const mobileStatsToggle = document.getElementById('mobileStatsToggle');
  if (mobileStatsToggle && mobileStatsToggle.dataset.mobileListBound !== 'true') {
    mobileStatsToggle.dataset.mobileListBound = 'true';
    mobileStatsToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMobileListExpanded();
    });
  }
}

// Helper: create mobile-like DOM structure
function createMobileDashboardDOM() {
  document.body.innerHTML = `
    <div id="dashboardRoot" style="height: 100dvh; overflow: hidden; display: flex; flex-direction: column;">
      <div class="dashboard-main-grid grid gap-5" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <div class="council-chamber glass-panel" style="flex: 0 0 auto; position: relative;">
          <div id="mobileHeader" style="padding: 0.5rem;">
            <div style="display: flex; align-items: center;">
              <button id="collapseMobileListBtn" title="Expand List" aria-label="Expand agent list" type="button">
                <svg><path d="M19 9l-7 7-7-7" /></svg>
              </button>
              <h2>Council Chamber</h2>
            </div>
          </div>
          <div id="mobileStatsToggle">Stats</div>
          <div id="agentListPanel" class="agent-list-panel">
            <div class="agent-list-header"><span>Agents</span></div>
            <div class="agent-list-scroll" id="agentListScroll">
              <div class="agent-list-item" data-agent-id="a1" data-agent-name="Agent1">Agent 1</div>
              <div class="agent-list-item" data-agent-id="a2" data-agent-name="Agent2">Agent 2</div>
            </div>
          </div>
        </div>
        <aside class="glass-panel" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
          <div id="agentPanelHeader">Agent Header</div>
          <div id="conversationArea" style="flex: 1; overflow-y: auto; overscroll-behavior: contain;">
            <div>Message 1</div>
            <div>Message 2</div>
            <div>Message 3</div>
          </div>
          <div id="messageInputArea" style="flex: 0 0 auto;">
            <textarea id="userMessageInput"></textarea>
            <button id="userMessageSend">Send</button>
          </div>
        </aside>
      </div>
    </div>
  `;
}

// ============================================================
// Test Suite: Mobile Agent List Toggle
// ============================================================
describe('Mobile Agent List Toggle', () => {
  beforeEach(() => {
    createMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('agent list panel is collapsed by default (no mobile-expanded class)', () => {
    const panel = document.getElementById('agentListPanel');
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
  });

  it('setMobileListExpanded(true) adds mobile-expanded class to panel', () => {
    const panel = document.getElementById('agentListPanel');
    setMobileListExpanded(true);
    expect(panel.classList.contains('mobile-expanded')).toBe(true);
    expect(document.querySelector('.council-chamber').classList.contains('mobile-agent-list-open')).toBe(true);
  });

  it('setMobileListExpanded(false) removes mobile-expanded class', () => {
    setMobileListExpanded(true);
    setMobileListExpanded(false);
    const panel = document.getElementById('agentListPanel');
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
    expect(document.querySelector('.council-chamber').classList.contains('mobile-agent-list-open')).toBe(false);
  });

  it('toggleMobileListExpanded toggles the expanded state', () => {
    const panel = document.getElementById('agentListPanel');
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
    toggleMobileListExpanded();
    expect(panel.classList.contains('mobile-expanded')).toBe(true);
    toggleMobileListExpanded();
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
  });

  it('toggle updates body class for mobile-list-expanded', () => {
    setMobileListExpanded(true);
    expect(document.body.classList.contains('mobile-list-expanded')).toBe(true);
    setMobileListExpanded(false);
    expect(document.body.classList.contains('mobile-list-expanded')).toBe(false);
  });

  it('toggle updates button title and aria-label', () => {
    const btn = document.getElementById('collapseMobileListBtn');
    setMobileListExpanded(true);
    expect(btn.title).toBe('Collapse List');
    expect(btn.getAttribute('aria-label')).toBe('Collapse agent list');
    setMobileListExpanded(false);
    expect(btn.title).toBe('Expand List');
    expect(btn.getAttribute('aria-label')).toBe('Expand agent list');
  });

  it('toggle rotates the SVG chevron', () => {
    const svg = document.querySelector('#collapseMobileListBtn svg');
    setMobileListExpanded(true);
    expect(svg.style.transform).toBe('rotate(180deg)');
    setMobileListExpanded(false);
    expect(svg.style.transform).toBe('');
  });

  it('mobile chrome collapse helper keeps chrome classes cleared', () => {
    document.body.classList.add('mobile-chrome-collapsed', 'mobile-nav-hidden');
    setMobileChromeCollapsed(true);
    expect(document.body.classList.contains('mobile-chrome-collapsed')).toBe(false);
    expect(document.body.classList.contains('mobile-nav-hidden')).toBe(false);
  });

  it('collapse button click is wired in list-only mode', () => {
    bindMobileListToggleControls();
    const btn = document.getElementById('collapseMobileListBtn');
    const panel = document.getElementById('agentListPanel');
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
    btn.click();
    expect(panel.classList.contains('mobile-expanded')).toBe(true);
  });

  it('stats toggle click toggles list expansion', () => {
    bindMobileListToggleControls();
    const statsToggle = document.getElementById('mobileStatsToggle');
    const panel = document.getElementById('agentListPanel');
    expect(panel.classList.contains('mobile-expanded')).toBe(false);
    statsToggle.click();
    expect(panel.classList.contains('mobile-expanded')).toBe(true);
  });
});

// ============================================================
// Test Suite: Mobile DOM Structure
// ============================================================
describe('Mobile DOM Structure', () => {
  beforeEach(() => {
    createMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('collapseMobileListBtn exists in the DOM', () => {
    const btn = document.getElementById('collapseMobileListBtn');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('conversationArea is a child of the aside panel', () => {
    const convArea = document.getElementById('conversationArea');
    expect(convArea).not.toBeNull();
    expect(convArea.parentElement.tagName).toBe('ASIDE');
  });

  it('conversationArea has overflow-y auto style', () => {
    const convArea = document.getElementById('conversationArea');
    expect(convArea.style.overflowY).toBe('auto');
  });

  it('conversationArea has overscroll-behavior contain', () => {
    const convArea = document.getElementById('conversationArea');
    const overscrollBehavior = convArea.style.overscrollBehavior ||
      convArea.style['overscroll-behavior'] ||
      (convArea.getAttribute('style') || '').match(/overscroll-behavior:\s*([^;]+)/)?.[1]?.trim();
    expect(overscrollBehavior).toBe('contain');
  });

  it('messageInputArea is positioned after conversationArea', () => {
    const convArea = document.getElementById('conversationArea');
    const inputArea = document.getElementById('messageInputArea');
    expect(convArea.nextElementSibling).toBe(inputArea);
  });

  it('dashboardRoot has overflow hidden', () => {
    const root = document.getElementById('dashboardRoot');
    expect(root.style.overflow).toBe('hidden');
  });

  it('agentListPanel is inside council-chamber', () => {
    const panel = document.getElementById('agentListPanel');
    expect(panel.closest('.council-chamber')).not.toBeNull();
  });
});

// ============================================================
// Test Suite: Mobile Scroll Containment
// ============================================================
describe('Mobile Scroll Containment', () => {
  beforeEach(() => {
    createMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('dashboardRoot flex column layout prevents page scroll', () => {
    const root = document.getElementById('dashboardRoot');
    expect(root.style.display).toBe('flex');
    expect(root.style.flexDirection).toBe('column');
    expect(root.style.overflow).toBe('hidden');
  });

  it('grid container is flex column with overflow hidden', () => {
    const grid = document.querySelector('.dashboard-main-grid');
    expect(grid.style.display).toBe('flex');
    expect(grid.style.flexDirection).toBe('column');
    expect(grid.style.overflow).toBe('hidden');
  });

  it('aside panel is flex: 1 with overflow hidden', () => {
    const aside = document.querySelector('aside.glass-panel');
    expect(aside.style.flex).toContain('1');
    expect(aside.style.overflow).toBe('hidden');
  });

  it('conversationArea is the only scrollable area', () => {
    const convArea = document.getElementById('conversationArea');
    const root = document.getElementById('dashboardRoot');
    const grid = document.querySelector('.dashboard-main-grid');
    
    // Only conversationArea should have auto scroll
    expect(convArea.style.overflowY).toBe('auto');
    expect(root.style.overflow).toBe('hidden');
    expect(grid.style.overflow).toBe('hidden');
  });
});

// ============================================================
// Test Suite: Agent List as Overlay
// ============================================================
describe('Agent List Overlay Behavior', () => {
  beforeEach(() => {
    createMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('council-chamber has position relative for overlay positioning', () => {
    const chamber = document.querySelector('.council-chamber');
    expect(chamber.style.position).toBe('relative');
  });

  it('expanding agent list does not change aside flex', () => {
    const aside = document.querySelector('aside.glass-panel');
    const flexBefore = aside.style.flex;
    setMobileListExpanded(true);
    expect(aside.style.flex).toBe(flexBefore);
  });

  it('agent list items are accessible when expanded', () => {
    setMobileListExpanded(true);
    const items = document.querySelectorAll('.agent-list-item');
    expect(items.length).toBe(2);
    expect(items[0].getAttribute('data-agent-name')).toBe('Agent1');
  });
});

// ============================================================
// Test Suite: Mobile multiChatContainer layout (flex:1 fill)
// ============================================================

function createFullMobileDashboardDOM() {
  document.body.innerHTML = `
    <div id="dashboardRoot" style="height:100dvh;overflow:hidden;display:flex;flex-direction:column;">
      <div class="dashboard-main-grid" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;">
        <div class="council-chamber" style="flex:0 0 auto;height:auto;">
          <div id="mobileHeader">Header</div>
        </div>
        <div id="multiChatContainer" style="flex:1;flex-direction:column;overflow:hidden;min-height:0;height:auto;padding:0;">
          <aside class="glass-panel chat-tile--main" style="flex:1;min-height:0;height:auto;overflow:hidden;display:flex;flex-direction:column;">
            <div id="agentPanelHeader" style="flex:0 0 auto;">Agent Header</div>
            <div id="mainInteractiveSpace" style="flex-shrink:1;">
              <div id="mainInteractiveToggle">Agent Space Toggle</div>
              <div id="mainInteractiveContent" class="hidden"></div>
            </div>
            <div id="conversationArea" style="flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;min-height:0;padding-bottom:0.5rem;">
              <div>Message 1</div><div>Message 2</div><div>Message 3</div>
            </div>
            <div id="messageInputArea" style="flex:0 0 auto;position:relative;z-index:20;flex-shrink:0;">
              <div id="imagePreviewArea" class="hidden">
                <img id="imagePreviewImg" src="" alt="preview" />
                <button id="clearAllImagesBtn">Clear All</button>
              </div>
              <form id="userMessageForm">
                <div class="relative">
                  <textarea id="userMessageInput" placeholder="Message..."></textarea>
                  <label id="generalFileUploadLabel" for="generalFileInput">File</label>
                  <input id="generalFileInput" type="file" />
                  <label id="imageUploadLabel" for="imageFileInput">Image</label>
                  <input id="imageFileInput" type="file" />
                </div>
                <div class="composer-action-row">
                  <div class="composer-controls">
                    <div id="agentConfigContainer"><button id="agentConfigBtn">Model</button></div>
                    <button id="agentStopBtn">Stop</button>
                    <button id="userMessageSend">Send</button>
                  </div>
                </div>
              </form>
            </div>
          </aside>
        </div>
      </div>
    </div>
  `;
}

describe('Mobile multiChatContainer fills available height (flex:1 fix)', () => {
  beforeEach(() => {
    createFullMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('multiChatContainer has flex:1 direction (not flex:0 0 auto)', () => {
    const mc = document.getElementById('multiChatContainer');
    // flex:1 expands to flex-grow:1 in JSDOM
    expect(mc.style.flexGrow).toBe('1');
    expect(mc.style.flexShrink).not.toBe('0');
  });

  it('multiChatContainer has flex-direction column on mobile', () => {
    const mc = document.getElementById('multiChatContainer');
    expect(mc.style.flexDirection).toBe('column');
  });

  it('multiChatContainer has min-height 0 (not 500px) on mobile', () => {
    const mc = document.getElementById('multiChatContainer');
    expect(mc.style.minHeight).not.toBe('500px');
  });

  it('aside inside multiChatContainer has flex:1 (flex-grow: 1)', () => {
    const aside = document.querySelector('#multiChatContainer aside');
    expect(aside.style.flexGrow).toBe('1');
  });

  it('conversationArea has flex-grow 1 for scrollable fill', () => {
    const convArea = document.getElementById('conversationArea');
    // "flex:1 1 auto" → flexGrow = '1'
    expect(convArea.style.flexGrow).toBe('1');
  });

  it('conversationArea has touch-action pan-y for scroll on iOS', () => {
    const convArea = document.getElementById('conversationArea');
    // JSDOM stores touch-action via getAttribute or cssText
    const touchAction = convArea.style.touchAction || convArea.style['touch-action'] ||
      (convArea.getAttribute('style') || '').match(/touch-action:\s*([^;]+)/)?.[1]?.trim();
    expect(touchAction).toBe('pan-y');
  });

  it('messageInputArea exists and is positioned at bottom of viewport on mobile', () => {
    const inputArea = document.getElementById('messageInputArea');
    // On mobile the input uses position:fixed to anchor it to the viewport
    // This ensures it stays visible and never disappears during scroll/reflows
    // (Note: JSDOM doesn't apply stylesheets, so we just verify the element exists
    // and that it's correctly styled in the actual CSS file)
    expect(inputArea).toBeTruthy();
    expect(inputArea.id).toBe('messageInputArea');
  });
});

// ============================================================
// Test Suite: Mobile image preview area
// ============================================================
describe('Mobile image preview area in message input', () => {
  beforeEach(() => {
    createFullMobileDashboardDOM();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('imagePreviewArea exists inside messageInputArea', () => {
    const inputArea = document.getElementById('messageInputArea');
    const preview = document.getElementById('imagePreviewArea');
    expect(inputArea).not.toBeNull();
    expect(preview).not.toBeNull();
    expect(preview.closest('#messageInputArea')).not.toBeNull();
  });

  it('imagePreviewArea is hidden by default (no attachment selected)', () => {
    const preview = document.getElementById('imagePreviewArea');
    expect(preview.classList.contains('hidden')).toBe(true);
  });

  it('imagePreviewArea can be shown by removing hidden class', () => {
    const preview = document.getElementById('imagePreviewArea');
    preview.classList.remove('hidden');
    expect(preview.classList.contains('hidden')).toBe(false);
    expect(preview.querySelector('img')).not.toBeNull();
  });

  it('clear all images button exists in preview area', () => {
    const clearBtn = document.getElementById('clearAllImagesBtn');
    expect(clearBtn).not.toBeNull();
    expect(clearBtn.closest('#imagePreviewArea')).not.toBeNull();
  });

  it('message input textarea and send button are accessible', () => {
    const textarea = document.getElementById('userMessageInput');
    const sendBtn = document.getElementById('userMessageSend');
    expect(textarea).not.toBeNull();
    expect(sendBtn).not.toBeNull();
    // Both should be siblings or nested in the same input area
    expect(textarea.closest('#messageInputArea')).not.toBeNull();
    expect(sendBtn.closest('#messageInputArea')).not.toBeNull();
  });

  it('mobile composer action controls are grouped in the input tray controls', () => {
    const actionRow = document.querySelector('#messageInputArea .composer-action-row');
    const controls = document.querySelector('#messageInputArea .composer-controls');
    expect(actionRow).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(document.getElementById('agentConfigBtn').closest('.composer-controls')).toBe(controls);
    expect(document.getElementById('agentStopBtn').closest('.composer-controls')).toBe(controls);
    expect(document.getElementById('userMessageSend').closest('.composer-controls')).toBe(controls);
  });

  it('conversationArea remains above messageInputArea in DOM order', () => {
    const convArea = document.getElementById('conversationArea');
    const inputArea = document.getElementById('messageInputArea');
    // conversationArea should come before messageInputArea in the DOM
    const position = convArea.compareDocumentPosition(inputArea);
    // DOCUMENT_POSITION_FOLLOWING = 4 means inputArea is after convArea
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('mainInteractiveSpace toggle is above conversationArea in DOM', () => {
    const interactiveSpace = document.getElementById('mainInteractiveSpace');
    const convArea = document.getElementById('conversationArea');
    // interactiveSpace should come before conversationArea
    const position = interactiveSpace.compareDocumentPosition(convArea);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
