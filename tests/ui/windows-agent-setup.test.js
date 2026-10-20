/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ejs = require('ejs');
const markup = fs.readFileSync(path.join(__dirname, '../../views/partials/agent-setup-dialog.ejs'), 'utf8');
let api;

beforeEach(() => {
  jest.resetModules();
  document.body.innerHTML = '<button id="launcher" data-open-agent-setup data-setup-os="windows">Windows setup</button>' + markup;
  const dialog = document.querySelector('dialog');
  dialog.showModal = jest.fn(() => { dialog.open = true; });
  dialog.close = jest.fn(() => { dialog.open = false; dialog.dispatchEvent(new Event('close')); });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue() } });
  api = require('../../public/js/setup-platform');
  document.dispatchEvent(new Event('DOMContentLoaded'));
});

test('Windows opens native PowerShell setup with optional prerequisites', async () => {
  document.getElementById('launcher').click();
  expect(document.querySelector('dialog').showModal).toHaveBeenCalled();
  const section = document.querySelector('[data-setup-steps] section');
  expect(section.textContent).toContain('PowerShell');
  expect(section.textContent).not.toMatch(/WSL|Ubuntu/);
  expect(document.querySelector('details').open).toBe(false);
  section.querySelector('button').click();
  await Promise.resolve();
  const command = section.querySelector('textarea').value;
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(command);
  expect(command).toContain('/setup.ps1');
  expect(command).not.toMatch(/API_KEY|ENCRYPTION|wsl --install/);
  expect(document.querySelector('[role=status]').textContent).toContain('PowerShell');
});

test('OS buttons switch commands and closing restores launcher focus', () => {
  const launcher = document.getElementById('launcher');
  launcher.focus(); launcher.click();
  const button = document.querySelector('[data-setup-os-choice="unix"]');
  button.click();
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('[data-setup-os-choice="windows"]').getAttribute('aria-pressed')).toBe('false');
  expect(document.querySelectorAll('[data-setup-steps] section')).toHaveLength(1);
  expect(document.querySelector('textarea').value).toContain('curl -fsSL');
  expect(document.querySelector('[data-setup-windows-note]').hidden).toBe(true);
  document.querySelector('[data-setup-close]').click();
  expect(document.activeElement).toBe(launcher);
});

test('clipboard rejection selects the command with an actionable fallback', async () => {
  navigator.clipboard.writeText.mockRejectedValue(new Error('denied'));
  api.open({ platform: 'windows', baseUrl: 'https://example.test' });
  document.querySelector('[data-setup-steps] button').click();
  await Promise.resolve(); await Promise.resolve();
  const textarea = document.querySelector('textarea');
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionEnd).toBe(textarea.value.length);
  expect(document.querySelector('[role=status]').textContent).toContain('Copy the selected command');
});

test('Windows Chief of Staff entry explains its availability without copying Bash', () => {
  api.open({ platform: 'windows', chiefOfStaff: true, baseUrl: 'https://example.test' });
  expect(document.querySelector('[data-setup-cos-note]').hidden).toBe(false);
  expect(document.querySelector('textarea').value).toContain('/setup.ps1');
  document.querySelector('[data-setup-os-choice="unix"]').click();
  expect(document.querySelector('[data-setup-cos-note]').hidden).toBe(true);
  expect([...document.querySelectorAll('textarea')].at(-1).value).toBe('bash agent-cli.sh --local-cos');
});

test.each([
  [{ platform: 'Win32' }, 'windows'],
  [{ userAgentData: { platform: 'Windows' }, platform: 'Linux' }, 'windows'],
  [{ platform: 'MacIntel' }, 'unix'],
  [{ platform: 'Linux x86_64' }, 'unix'],
  [{}, 'unix']
])('detects browser platform %j with manual override available', (info, expected) => {
  expect(api.detectPlatform(info)).toBe(expected);
});

test.each(['javascript:alert(1)', 'https://user:secret@example.test'])('rejects unsafe server address %s', url => {
  expect(() => api.setupSteps(url, 'windows')).toThrow();
});

test('Linux/macOS commands remain valid Bash and Windows URL is PowerShell quoted', () => {
  const url = "https://example.test/a'quote/$(never-execute)";
  for (const step of api.setupSteps(url, 'unix', true)) execFileSync('bash', ['-n'], { input: step.command });
  const command = api.setupSteps(url, 'windows')[0].command;
  expect(command).toContain("-Uri 'https://example.test/a''quote/$(never-execute)/setup.ps1'");
  expect(command).toContain('Invoke-RestMethod');
  expect(command).toContain('-ErrorAction Stop');
  expect(command).toContain('Set-ExecutionPolicy -Scope Process Bypass -Force');
  expect(command).not.toContain('Set-ExecutionPolicy -Scope CurrentUser');
});

test('Windows entry points are gated for immediate rollback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../views/partials/cos-install-modal.ejs'), 'utf8');
  const old = process.env.WINDOWS_AGENT_SETUP_ENABLED;
  try {
    process.env.WINDOWS_AGENT_SETUP_ENABLED = 'false';
    expect(ejs.render(source)).not.toContain('data-open-agent-setup');
    process.env.WINDOWS_AGENT_SETUP_ENABLED = 'true';
    expect(ejs.render(source)).toContain('data-open-agent-setup');
  } finally {
    if (old === undefined) delete process.env.WINDOWS_AGENT_SETUP_ENABLED;
    else process.env.WINDOWS_AGENT_SETUP_ENABLED = old;
  }
});
