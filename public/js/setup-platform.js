/* Shared setup instructions. Public URLs only; secrets are entered in the installer. */
(function (root) {
  'use strict';

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function powershellQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function setupSteps(baseUrl, platform, chiefOfStaff = false) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use an HTTP or HTTPS server address without credentials.');
    }
    const setupUrl = shellQuote(url.href.replace(/\/+$/, '') + '/setup');
    if (platform !== 'windows') {
      const steps = [{ title: 'Install the CLI in your project folder', shell: 'Bash (Linux / macOS)', command: `curl -fsSL ${setupUrl} | bash` }];
      if (chiefOfStaff) steps.push({ title: 'Install the Chief of Staff in the same folder', shell: 'Bash (Linux / macOS)', command: 'bash agent-cli.sh --local-cos' });
      return steps;
    }
    return [
      { title: 'Set up your Windows agent', shell: 'PowerShell', command: `Set-ExecutionPolicy -Scope Process Bypass -Force
& ([scriptblock]::Create((Invoke-RestMethod -Uri ${powershellQuote(url.href.replace(/\/+$/, '') + '/setup.ps1')} -ErrorAction Stop)))`, note: 'Open PowerShell in your project folder. Install and sign in to Codex, Claude, or Gemini on Windows first. Enter credentials only in the installer. Agents keep working in the background; use jetspace stop to stop them.' },
      { title: 'Need Node.js? Install it first', shell: 'PowerShell', command: 'winget install --id OpenJS.NodeJS.LTS --exact --source winget', note: 'Requires Node.js 22 or newer. Skip this if it is already installed. Reopen PowerShell after installation, then run setup above.', optional: true }
    ];
  }

  function detectPlatform(navigatorInfo) {
    const platform = navigatorInfo?.userAgentData?.platform || navigatorInfo?.platform || navigatorInfo?.userAgent || '';
    return /win/i.test(platform) ? 'windows' : 'unix';
  }

  let previousFocus;
  let currentBaseUrl;
  let chiefOfStaff = false;

  function fitCommands() {
    const dialog = document.getElementById('agentSetupDialog');
    if (!dialog?.open) return;
    dialog.querySelectorAll('textarea').forEach(code => {
      code.style.height = 'auto';
      code.style.height = Math.max(44, code.scrollHeight + 2) + 'px';
    });
  }

  function render() {
    const dialog = document.getElementById('agentSetupDialog');
    if (!dialog) return;
    const platform = dialog.querySelector('[data-setup-platform]').value;
    const container = dialog.querySelector('[data-setup-steps]');
    container.replaceChildren();
    dialog.querySelector('[data-setup-windows-note]').hidden = platform !== 'windows';
    dialog.querySelector('[data-setup-cos-note]').hidden = platform !== 'windows' || !chiefOfStaff;
    dialog.querySelectorAll('[data-setup-os-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.setupOsChoice === platform));
    });
    dialog.querySelector('[data-setup-status]').textContent = '';
    for (const step of setupSteps(currentBaseUrl, platform, chiefOfStaff)) {
      const section = document.createElement(step.optional ? 'details' : 'section');
      section.className = 'agent-setup-card';
      const title = document.createElement(step.optional ? 'summary' : 'h3');
      title.className = 'text-sm font-semibold text-slate-100';
      title.textContent = step.title;
      const shell = document.createElement('p');
      shell.className = 'text-xs text-emerald-300';
      shell.textContent = step.shell;
      const code = document.createElement('textarea');
      code.readOnly = true;
      code.rows = Math.max(2, Math.ceil(step.command.length / 65));
      code.setAttribute('aria-label', step.title + ' — ' + step.shell);
      code.className = 'w-full p-2 rounded-lg bg-slate-950 text-slate-200 font-mono text-xs border border-slate-700';
      code.style.overflowWrap = 'anywhere';
      code.style.resize = 'vertical';
      code.value = step.command;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'px-3 py-1 rounded-lg border border-slate-600 text-sm text-emerald-300';
      button.textContent = 'Copy command';
      button.setAttribute('aria-label', 'Copy: ' + step.title);
      button.addEventListener('click', async () => {
        const status = dialog.querySelector('[data-setup-status]');
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(step.command);
          status.textContent = 'Copied. Paste into ' + step.shell + '.';
        } catch (_) {
          code.focus();
          code.select();
          status.textContent = 'Copy the selected command, then paste into ' + step.shell + '.';
        }
      });
      section.append(title, shell, code, button);
      if (step.optional) section.addEventListener('toggle', fitCommands);
      if (step.note) {
        const note = document.createElement('p');
        note.className = 'text-xs text-slate-400';
        note.textContent = step.note;
        section.append(note);
      }
      container.append(section);
    }
    fitCommands();
  }

  function open(options = {}) {
    const dialog = document.getElementById('agentSetupDialog');
    if (!dialog) return false;
    previousFocus = document.activeElement;
    currentBaseUrl = options.baseUrl || location.origin;
    chiefOfStaff = options.chiefOfStaff === true;
    const select = dialog.querySelector('[data-setup-platform]');
    select.value = options.platform || detectPlatform(navigator);
    render();
    if (!dialog.open) dialog.showModal();
    fitCommands();
    dialog.querySelector(`[data-setup-os-choice="${select.value}"]`).focus();
    return true;
  }

  function init() {
    const dialog = document.getElementById('agentSetupDialog');
    if (!dialog) return;
    dialog.querySelector('[data-setup-platform]').addEventListener('change', render);
    dialog.querySelectorAll('[data-setup-os-choice]').forEach(button => {
      button.addEventListener('click', () => {
        dialog.querySelector('[data-setup-platform]').value = button.dataset.setupOsChoice;
        render();
      });
    });
    dialog.querySelector('[data-setup-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => previousFocus?.focus());
    root.addEventListener('resize', fitCommands);
    document.querySelectorAll('[data-open-agent-setup]').forEach(button => {
      button.addEventListener('click', () => open({
        platform: button.dataset.setupOs,
        chiefOfStaff: button.dataset.setupCos === 'true',
        baseUrl: button.dataset.setupBaseUrl || location.origin
      }));
    });
  }

  const api = { setupSteps, detectPlatform, open };
  if (typeof module !== 'undefined') module.exports = api;
  root.ChatMCPSetup = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
}(typeof window !== 'undefined' ? window : globalThis));
