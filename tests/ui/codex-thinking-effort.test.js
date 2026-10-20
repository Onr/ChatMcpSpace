/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../../views/dashboard.ejs'), 'utf8');
const saveHandler = source.slice(source.indexOf('  // Save config handler'), source.indexOf('/**\n * Load agent config and update status display'));
const loadEffort = source.slice(source.indexOf('      // Reset effort when switching agents'), source.indexOf('      // Set provider-specific values'));

beforeEach(() => {
  const select = template.match(/<select id="configCodexThinkingEffort"[\s\S]*?<\/select>/)[0];
  document.body.innerHTML = `<div id="codexOptions">${select}</div><button id="save"></button>`;
});

test.each(['codex', 'default'])('%s saves selected effort in the agent config request', async provider => {
  let callback;
  const csrfFetch = jest.fn(async () => ({ ok: true }));
  const loadAgentConfig = jest.fn();
  const showErrorMessage = jest.fn();
  const context = vm.createContext({
    document, window: { csrfToken: 'test' }, console,
    saveConfigBtn: { addEventListener: (_, fn) => { callback = fn; } },
    configProvider: { value: provider }, configDropdown: null,
    getResolvedSelectedAgentName: () => 'Agent', csrfFetch, loadAgentConfig,
    showSuccessMessage: jest.fn(), showErrorMessage
  });
  vm.runInContext('function install() {\n' + saveHandler + '\ninstall();', context);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    document.getElementById('configCodexThinkingEffort').value = effort;
    await callback();
    expect(JSON.parse(csrfFetch.mock.calls.at(-1)[1].body)).toMatchObject({
      model_provider: provider, thinking_effort: effort
    });
  }
  expect(showErrorMessage).not.toHaveBeenCalled();
  expect(loadAgentConfig).toHaveBeenCalledTimes(5);
});

test('loads saved effort and resets it for an agent without a saved choice', () => {
  vm.runInNewContext(loadEffort, { document, config: { thinking_effort: 'xhigh' } });
  expect(document.getElementById('configCodexThinkingEffort').value).toBe('xhigh');
  vm.runInNewContext(loadEffort, { document, config: {} });
  expect(document.getElementById('configCodexThinkingEffort').value).toBe('medium');
});
