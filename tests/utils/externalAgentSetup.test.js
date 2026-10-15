const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '../../public/js/external-agent-setup.js'), 'utf8');

async function copy(writeText) {
  const dom = new JSDOM('<textarea id="externalAgentSetupPrompt">Connect at https://example.test</textarea><button id="copyExternalAgentSetup"></button><span id="externalAgentCopyStatus" role="status"></span>', { runScripts: 'outside-only' });
  if (writeText) Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText } });
  dom.window.eval(script);
  await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  dom.window.document.getElementById('copyExternalAgentSetup').click();
  await new Promise(resolve => setImmediate(resolve));
  return dom;
}

test('copies the setup request', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  const dom = await copy(writeText);
  expect(writeText).toHaveBeenCalledWith('Connect at https://example.test');
  expect(dom.window.document.getElementById('externalAgentCopyStatus').textContent).toContain('Copied');
  dom.window.close();
});

test.each([undefined, jest.fn().mockRejectedValue(new Error('denied'))])('selects instructions when clipboard is unavailable or denied', async writeText => {
  const dom = await copy(writeText);
  const prompt = dom.window.document.getElementById('externalAgentSetupPrompt');
  expect(dom.window.document.activeElement).toBe(prompt);
  expect(prompt.selectionEnd).toBe(prompt.value.length);
  expect(dom.window.document.getElementById('externalAgentCopyStatus').textContent).toContain('highlighted');
  dom.window.close();
});

test('updates the prompt and approval link for the selected provider and identity', async () => {
  const dom = new JSDOM(`
    <select id="externalAgentProvider"><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select>
    <input id="externalAgentName" value="Field Agent">
    <textarea id="externalAgentSetupPrompt" data-base-url="https://space.example/">old</textarea>
    <button id="copyExternalAgentSetup"></button><span id="externalAgentCopyStatus"></span>
    <a id="externalAgentApproveLink"></a>`, { runScripts: 'outside-only' });
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const provider = dom.window.document.getElementById('externalAgentProvider');
  provider.value = 'openclaw';
  provider.dispatchEvent(new dom.window.Event('change'));
  dom.window.document.getElementById('externalAgentName').value = 'Field Agent';
  dom.window.document.getElementById('externalAgentName').dispatchEvent(new dom.window.Event('input'));
  const prompt = dom.window.document.getElementById('externalAgentSetupPrompt').value;
  const link = dom.window.document.getElementById('externalAgentApproveLink');
  expect(prompt).toContain('https://space.example/api/agent/connect-guide');
  expect(prompt).toContain('OpenClaw agent named "Field Agent"');
  expect(link.textContent).toBe('Approve Field Agent');
  expect(link.getAttribute('href')).toBe('/settings/external-agents/approve?provider=openclaw&agentName=Field%20Agent');
  dom.window.close();
});

test('tracks provider defaults until the user chooses a custom identity', async () => {
  const dom = new JSDOM(`
    <select id="externalAgentProvider"><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select>
    <input id="externalAgentName" value="Hermes">
    <textarea id="externalAgentSetupPrompt" data-base-url="https://space.example"></textarea>
    <button id="copyExternalAgentSetup"></button><span id="externalAgentCopyStatus"></span>
    <a id="externalAgentApproveLink"></a>`, { runScripts: 'outside-only' });
  dom.window.eval(script);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const provider = dom.window.document.getElementById('externalAgentProvider');
  const name = dom.window.document.getElementById('externalAgentName');
  provider.value = 'openclaw';
  provider.dispatchEvent(new dom.window.Event('change'));
  expect(name.value).toBe('OpenClaw');
  name.value = 'Personal Scout';
  name.dispatchEvent(new dom.window.Event('input'));
  provider.value = 'hermes';
  provider.dispatchEvent(new dom.window.Event('change'));
  expect(name.value).toBe('Personal Scout');
  dom.window.close();
});
