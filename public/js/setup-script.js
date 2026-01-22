(function () {
  function resolveTriggerButton(trigger) {
    if (!trigger) {
      return document.getElementById('navCopySetupButton');
    }

    if (trigger instanceof Event) {
      if (trigger.currentTarget instanceof HTMLElement) {
        return trigger.currentTarget;
      }
      if (trigger.target instanceof HTMLElement) {
        return trigger.target;
      }
      return document.getElementById('navCopySetupButton');
    }

    if (trigger instanceof HTMLElement) {
      return trigger;
    }

    return document.getElementById('navCopySetupButton');
  }

  function showSetupSuccess(message) {
    if (typeof window.showSuccess === 'function') {
      window.showSuccess(message);
      return;
    }
    // Fallback if notifications.js not loaded (unlikely)
    console.log('Success:', message);
  }

  function showSetupError(message) {
    if (typeof window.showError === 'function') {
      window.showError(message);
      return;
    }
    // Fallback
    console.error('Error:', message);
  }

  function createToast(type, message) {
    if (type === 'success') {
      if (typeof window.showSuccess === 'function') {
        window.showSuccess(message);
      } else {
        console.warn('showSuccess handler not available:', message);
      }
    } else {
      if (typeof window.showError === 'function') {
        window.showError(message);
      } else {
        console.error('Error:', message);
      }
    }
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        return true;
      } catch (fallbackErr) {
        console.error('Fallback copy failed:', fallbackErr);
        return false;
      }
    }
  }

  async function fetchMainScript() {
    const csrfToken = window.csrfToken || '';
    const response = await fetch('/settings/generate-guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ variant: 'main' })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch CLI script');
    }

    const data = await response.json();
    return data.guide || '';
  }

  window.copyMainCLIScript = async function copyMainCLIScript(trigger) {
    const button = resolveTriggerButton(trigger);
    const originalLabel = button ? button.innerHTML : null;
    const originalDisabled = button ? button.disabled : null;

    try {
      if (button) {
        button.disabled = true;
        button.classList.add('opacity-70');
        button.innerHTML = '<span class="flex items-center gap-2 text-xs tracking-wide uppercase"><span class="animate-pulse">Copying...</span></span>';
      }

      // Use the same simple curl command as the Settings page
      const baseUrl = window.location.origin;
      const curlCommand = `curl -sL ${baseUrl}/setup | bash`;

      const copied = await copyTextToClipboard(curlCommand);
      if (!copied) {
        throw new Error('Failed to copy setup command. Please try again.');
      }

      showSetupSuccess('Setup command copied! Paste into your terminal.');
    } catch (error) {
      console.error('copyMainCLIScript error:', error);
      showSetupError(error.message || 'Failed to copy setup command.');
    } finally {
      if (button) {
        button.disabled = originalDisabled ?? false;
        button.classList.remove('opacity-70');
        if (originalLabel !== null) {
          button.innerHTML = originalLabel;
        }
      }
    }
  };
})();
