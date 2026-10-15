/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/settings.js'), 'utf8');
function loadFunction(name, next) { window.eval(source.slice(source.indexOf('function ' + name), source.indexOf(next, source.indexOf('function ' + name))) ); }
test('MCP copy sends only the public server address to the clipboard', async () => {
  document.body.innerHTML = '<code id="mcpServerAddress">https://chat.example/mcp</code><span id="mcpCopyStatus"></span>';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue() } });
  const start = source.indexOf('async function copyMcpAddress');
  window.eval(source.slice(start, source.indexOf("document.addEventListener('DOMContentLoaded'", start)));
  await window.copyMcpAddress();
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://chat.example/mcp');
  expect(document.getElementById('mcpCopyStatus').textContent).toBe('Address copied');
});
test('per-agent usage renders closed disclosures and escapes agent names', () => {
  document.body.innerHTML = '<div id="usageLimitsAccount"></div><div id="usageLimitsAgents"></div>';
  window.escapeHtml = value => { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; };
  window.eval(source.slice(source.indexOf('function usageLimitBarColor(')));
  window.renderUsageLimits({ account: { limits: [] }, agents: [{ agentName: '<script>bad</script>', limits: [] }] });
  const disclosure = document.querySelector('#usageLimitsAgents details');
  expect(disclosure.open).toBe(false); expect(disclosure.querySelector('script')).toBeNull();
  expect(disclosure.querySelector('summary').textContent).toBe('<script>bad</script>');
});
test('Pi onboarding keeps credentials out of the copyable setup request', () => {
  const { setupPrompt, providerLabel } = require('../../public/js/external-agent-setup');
  expect(providerLabel('pi')).toBe('Pi');
  expect(setupPrompt('https://chat.example', 'pi', 'My Pi')).toContain('as my Pi agent named "My Pi"');
});
