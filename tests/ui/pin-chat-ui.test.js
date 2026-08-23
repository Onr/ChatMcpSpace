const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const dashboardViewPath = path.join(repoRoot, 'views', 'dashboard.ejs');
const dashboardScriptPath = path.join(repoRoot, 'public', 'js', 'dashboard.js');
const dashboardStylePath = path.join(repoRoot, 'public', 'css', 'style.css');

const PIN_ICON_PATH = 'M12 17.5V22m0-4.5l4.2-4.2a6 6 0 10-8.4 0L12 17.5z';

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('Pin chat controls', () => {
  let dashboardView;
  let dashboardScript;
  let dashboardStyle;

  beforeAll(() => {
    dashboardView = fs.readFileSync(dashboardViewPath, 'utf8');
    dashboardScript = fs.readFileSync(dashboardScriptPath, 'utf8');
    dashboardStyle = fs.readFileSync(dashboardStylePath, 'utf8');
  });

  it('renders a Pin Chat button in the main chat header', () => {
    expect(dashboardView).toContain('id="pinToSideBtn"');
    expect(dashboardView).toContain('class="hidden chat-header__pin-btn"');
    expect(dashboardView).toContain('<span class="pin-chat-label">Pin Chat</span>');
  });

  it('uses the same pin icon in both main header and agent list controls', () => {
    expect(dashboardScript).toContain(`const PIN_CHAT_ICON_PATH = '${PIN_ICON_PATH}'`);
    expect(countOccurrences(dashboardView, PIN_ICON_PATH)).toBeGreaterThanOrEqual(2);
  });

  it('wires main-header and agent-list pin actions through shared pin logic', () => {
    expect(dashboardScript).toContain('function pinChatToSidePanel(agentId, agentName, externalProvider = \'\')');
    expect(dashboardScript).toContain('function setupMainPinButton()');
    expect(dashboardScript).toContain("const pinButtons = document.querySelectorAll('.agent-list-pin-btn');");
    expect(dashboardScript).toContain('const pinned = pinChatToSidePanel(id, name, externalProvider);');
  });

  it('replaces the passive side-chat hint with a desktop add-chat picker', () => {
    expect(dashboardView).not.toContain('id="sideChatHint"');
    expect(dashboardView).not.toContain('Pin an agent to add side chats');
    expect(dashboardStyle).not.toContain('.side-chat-hint');
    expect(dashboardView).toContain('id="sideChatAddBtn"');
    expect(dashboardView).toContain('id="sideChatPicker"');
    expect(dashboardView).toContain('id="sideChatPickerList"');
    expect(dashboardStyle).toMatch(/\.side-chat-add-btn\s*\{[\s\S]*?display:\s*none;/);
    expect(dashboardStyle).toMatch(/@media \(min-width:\s*1024px\)[\s\S]*?\.side-chat-add-btn\s*\{[\s\S]*?position:\s*absolute;/);
    expect(dashboardStyle).toMatch(/@media \(min-width:\s*1024px\)[\s\S]*?\.side-chat-add-btn\s*\{[\s\S]*?right:\s*calc\(-2rem - 0\.65rem\);/);
    expect(dashboardScript).toContain('function setupSideChatAddPicker()');
    expect(dashboardScript).toContain('function openSideChatPicker()');
    expect(dashboardScript).toContain('chooseSideChatFromPicker(');
    expect(dashboardScript).toContain('pinChatToSidePanel(agentId, agentName || \'Agent\', externalProvider || \'\')');
  });

  it('keeps the main chat surface stable instead of repainting on hover/focus', () => {
    expect(dashboardStyle).toMatch(/\.glass-panel--focused:not\(\.chat-tile--main\)/);
    expect(dashboardStyle).toMatch(/\.chat-tile--main\s*\{[\s\S]*?animation:\s*none;/);
    expect(dashboardStyle).toMatch(/\.chat-tile--main:hover\s*\{[\s\S]*?transform:\s*none;/);
    expect(dashboardStyle).toMatch(/#multiChatContainer\s*\{[\s\S]*?transition:\s*[\s\S]*?margin-left 0\.28s[\s\S]*?padding-left 0\.28s[\s\S]*?gap 0\.2s ease;/);
  });
});
