/**
 * Chief of Staff install widget.
 *
 * Used by:
 *   - dashboard.ejs (auto-show first-login modal when not installed and not
 *                    previously dismissed)
 *   - settings.ejs  (install tile with explicit click handler)
 *
 * Endpoints:
 *   GET  /api/user/install-chief-of-staff/status
 *   POST /api/user/install-chief-of-staff   (body: { confirm:true, userPassword, agentName })
 */

(function () {
  'use strict';

  const DISMISS_KEY = 'cos_modal_dismissed_at';

  // Cached DOM references — populated by init() after DOMContentLoaded.
  const dom = {};

  function showError(message) {
    if (!dom.error) return;
    dom.error.textContent = message;
    dom.error.classList.remove('hidden');
  }

  function clearError() {
    if (dom.error) dom.error.classList.add('hidden');
  }

  function showSuccess(bootstrapCommand) {
    if (dom.successWrap && dom.bootstrap) {
      dom.bootstrap.textContent = bootstrapCommand;
      dom.successWrap.classList.remove('hidden');
    }
    if (dom.submit) dom.submit.disabled = true;
    if (dom.passwordWrap) dom.passwordWrap.classList.add('hidden');
  }

  function hideModal() {
    if (dom.modal) dom.modal.classList.add('hidden');
  }

  function openModal() {
    clearError();
    if (dom.modal) dom.modal.classList.remove('hidden');
  }

  function attachDismissHandlers() {
    document.querySelectorAll('[data-cos-dismiss]').forEach((node) => {
      node.addEventListener('click', () => {
        try {
          localStorage.setItem(DISMISS_KEY, new Date().toISOString());
        } catch (_) { /* ignore quota */ }
        hideModal();
      });
    });
  }

  async function fetchStatus() {
    try {
      const res = await fetch('/api/user/install-chief-of-staff/status', {
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin'
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  function copyBootstrapCommand() {
    const cmd = dom.bootstrap ? dom.bootstrap.textContent : '';
    if (navigator.clipboard && cmd && dom.copyBtn) {
      navigator.clipboard.writeText(cmd).then(() => {
        dom.copyBtn.textContent = 'Copied';
      });
    }
  }

  async function submitInstall() {
    clearError();
    const pwd = dom.password ? dom.password.value : '';
    const name = dom.name ? dom.name.value.trim() : '';
    if (!pwd) {
      showError('Please enter your account password.');
      return;
    }
    if (!name) {
      showError('Please enter a distinct Chief of Staff name for this computer.');
      return;
    }
    if (dom.submit) dom.submit.disabled = true;

    try {
      const csrf = window.csrfToken || '';
      const res = await fetch('/api/user/install-chief-of-staff', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-CSRF-Token': csrf
        },
        body: JSON.stringify({ confirm: true, userPassword: pwd, agentName: name })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError((data && data.error && data.error.message) || `Install failed (HTTP ${res.status})`);
        if (dom.submit) dom.submit.disabled = false;
        return;
      }

      showSuccess(data.bootstrap && data.bootstrap.command ? data.bootstrap.command : '(see server response)');
    } catch (e) {
      showError(`Install failed: ${e.message}`);
      if (dom.submit) dom.submit.disabled = false;
    }
  }

  async function maybeShowFirstRunModal() {
    let dismissedAt = null;
    try { dismissedAt = localStorage.getItem(DISMISS_KEY); } catch (_) { /* ignore */ }
    if (dismissedAt) return;
    const status = await fetchStatus();
    if (!status || status.installed) return;
    openModal();
  }

  async function refreshSettingsStatus() {
    if (!dom.settingsStatus) return;
    const status = await fetchStatus();
    if (status && status.installed) {
      dom.settingsStatus.textContent = status.count > 1 ? `${status.count} installed` : 'Installed';
      dom.settingsStatus.classList.remove('text-slate-400');
      dom.settingsStatus.classList.add('text-emerald-300');
      if (dom.settingsInstallBtn) {
        dom.settingsInstallBtn.textContent = 'Install another';
      }
    }
  }

  function init() {
    const g = (id) => document.getElementById(id);
    dom.modal = g('cosInstallModal');
    dom.error = g('cosInstallError');
    dom.name = g('cosInstallName');
    dom.password = g('cosInstallPassword');
    dom.passwordWrap = g('cosInstallPasswordWrap');
    dom.successWrap = g('cosInstallSuccess');
    dom.bootstrap = g('cosInstallBootstrap');
    dom.submit = g('cosInstallSubmit');
    dom.copyBtn = g('cosInstallCopyBootstrap');
    dom.firstRunRoot = g('cosFirstRunRoot');
    dom.settingsStatus = g('cosSettingsStatus');
    dom.settingsInstallBtn = g('cosSettingsInstallBtn');

    attachDismissHandlers();
    if (dom.submit) dom.submit.addEventListener('click', submitInstall);
    if (dom.copyBtn) dom.copyBtn.addEventListener('click', copyBootstrapCommand);
    if (dom.settingsInstallBtn) dom.settingsInstallBtn.addEventListener('click', openModal);

    if (dom.name && !dom.name.value) {
      dom.name.value = 'Local Chief of Staff';
    }

    if (dom.firstRunRoot) {
      maybeShowFirstRunModal();
    }
    if (dom.settingsStatus) {
      refreshSettingsStatus();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
