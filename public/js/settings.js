/**
 * Settings Page JavaScript
 * Handles API key copying, CLI script copying, and API key regeneration
 */

/**
 * Copy API key to clipboard
 */
function copyApiKey() {
  const apiKeyInput = document.getElementById('apiKeyInput');

  // Select the text
  apiKeyInput.select();
  apiKeyInput.setSelectionRange(0, 99999); // For mobile devices

  // Copy to clipboard
  navigator.clipboard.writeText(apiKeyInput.value)
    .then(() => {
      showSuccessMessage('API key copied to clipboard!');
    })
    .catch(err => {
      console.error('Failed to copy API key:', err);

      // Fallback for older browsers
      try {
        document.execCommand('copy');
        showSuccessMessage('API key copied to clipboard!');
      } catch (e) {
        showErrorMessage('Failed to copy API key. Please copy manually.');
      }
    });
}

/**
 * Copy direct setup script to clipboard (legacy)
 */
function copyDirectSetupScript() {
  const agentName = document.getElementById('guideAgentName')?.value || window.apiGuideConfig?.defaultAgentName || 'Your Agent Name';

  fetch('/settings/generate-guide', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': window.csrfToken
    },
    body: JSON.stringify({
      agentName: sanitizeAgentName(agentName),
      variant: 'direct'
    })
  })
    .then(response => {
      if (!response.ok) {
        throw new Error('Failed to fetch direct setup script');
      }
      return response.json();
    })
    .then(data => {
      const scriptText = data.guide || '';
      const directScriptElement = document.getElementById('directSetupScript');
      if (directScriptElement) {
        directScriptElement.textContent = scriptText;
      }

      if (!scriptText) {
        showErrorMessage('No setup script available to copy.');
        return;
      }

      return navigator.clipboard.writeText(scriptText)
        .then(() => showSuccessMessage('Direct setup script copied! Paste into your terminal.'))
        .catch(() => {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = scriptText;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);

            showSuccessMessage('Direct setup script copied! Paste into your terminal.');
          } catch (e) {
            showErrorMessage('Failed to copy setup script. Please try again.');
          }
        });
    })
    .catch(error => {
      console.error(error);
      showErrorMessage('Failed to fetch direct setup script');
    });
}

/**
 * Copy agent instructions to clipboard
 */
async function copyAgentInstructions() {
  const agentInput = document.getElementById('guideAgentName');
  const sanitizedAgentName = sanitizeAgentName(agentInput?.value) || window.apiGuideConfig?.defaultAgentName || 'Your Agent Name';

  let instructionsText = '';

  try {
    const response = await fetch('/settings/generate-guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({
        agentName: sanitizedAgentName,
        variant: 'full'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch agent instructions');
    }

    const data = await response.json();
    instructionsText = data.guide || '';

    const instructionsElement = document.getElementById('agentInstructions');
    if (instructionsElement) {
      instructionsElement.textContent = instructionsText;
    }
  } catch (error) {
    console.error('Failed to fetch agent instructions for copy:', error);
    showErrorMessage('Failed to fetch agent instructions');
    return;
  }

  const terminalSafe = buildTerminalSafeInstructions(instructionsText);

  if (!terminalSafe) {
    showErrorMessage('No agent instructions available to copy.');
    return;
  }

  // Copy to clipboard
  navigator.clipboard.writeText(terminalSafe)
    .then(() => {
      showSuccessMessage('Terminal-safe agent instructions copied!');
    })
    .catch(err => {
      console.error('Failed to copy agent instructions:', err);

      // Fallback for older browsers
      try {
        // Create a temporary textarea
        const textarea = document.createElement('textarea');
        textarea.value = terminalSafe;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);

        showSuccessMessage('Terminal-safe agent instructions copied!');
      } catch (e) {
        showErrorMessage('Failed to copy agent instructions. Please copy manually.');
      }
    });
}

/**
 * Handle API key regeneration with confirmation dialog
 */
function regenerateApiKey() {
  // Show confirmation dialog
  const confirmed = confirm(
    'Are you sure you want to regenerate your API key?\n\n' +
    'This will invalidate your current API key and break existing agent connections. ' +
    'You will need to update all your agents with the new key.'
  );

  if (!confirmed) {
    return;
  }

  // Submit form to regenerate API key with CSRF token
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/settings/regenerate-key';

  // Add CSRF token
  const csrfInput = document.createElement('input');
  csrfInput.type = 'hidden';
  csrfInput.name = '_csrf';
  csrfInput.value = window.csrfToken;
  form.appendChild(csrfInput);

  document.body.appendChild(form);
  form.submit();
}

/**
 * Copy curl command to clipboard
 */
function copyCurlCommand() {
  const text = document.getElementById('curlCommand').textContent;
  navigator.clipboard.writeText(text).then(() => {
    // Visual feedback on the button
    const btn = document.getElementById('copyBtn');
    const originalText = btn.textContent;
    const originalBg = btn.style.background;

    btn.textContent = '✓ Copied!';
    btn.style.background = '#10b981'; // Green
    btn.disabled = true;

    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = originalBg;
      btn.disabled = false;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    showErrorMessage('Failed to copy to clipboard');
  });
}

/**
 * Handle script token regeneration with confirmation dialog
 * DEPRECATED: No longer used with universal /setup URL
 */
// function regenerateScriptToken() {
//   // Show confirmation dialog
//   const confirmed = confirm(
//     'Are you sure you want to regenerate your script URL?\n\n' +
//     'This will invalidate the current short URL. ' +
//     'Any bookmarks or scripts using the old URL will stop working.'
//   );
//
//   if (!confirmed) {
//     return;
//   }
//
//   // Submit form to regenerate script token with CSRF token
//   const form = document.createElement('form');
//   form.method = 'POST';
//   form.action = '/settings/regenerate-script-token';
//
//   // Add CSRF token
//   const csrfInput = document.createElement('input');
//   csrfInput.type = 'hidden';
//   csrfInput.name = '_csrf';
//   csrfInput.value = window.csrfToken;
//   form.appendChild(csrfInput);
//
//   document.body.appendChild(form);
//   form.submit();
// }

/**
 * Show success message
 */
function showSuccessMessage(message) {
  // Create success toast
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg z-50 flex items-center gap-2';
  toast.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
    </svg>
    <span>${message}</span>
  `;

  document.body.appendChild(toast);

  // Remove after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

/**
 * Show error message
 */
function showErrorMessage(message) {
  // Create error toast
  const toast = document.createElement('div');
  toast.className = 'fixed top-4 right-4 bg-red-600 text-white px-4 py-3 rounded-lg shadow-lg z-50 flex items-center gap-2';
  toast.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
    </svg>
    <span>${message}</span>
  `;

  document.body.appendChild(toast);

  // Remove after 3 seconds
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Expose to window for use by other scripts (e.g., setup-script.js)
window.showSuccessMessage = showSuccessMessage;
window.showErrorMessage = showErrorMessage;

/**
 * Lightweight new-agent monitor so settings page still gets voice alerts
 */
const SETTINGS_AGENT_POLL_INTERVAL = 3000;
let settingsAgentPollHandle = null;
let settingsKnownAgentIds = new Set();
let settingsVisibilityHandlerAttached = false;
const settingsVoiceNotificationState = {
  audioUnlocked: false,
  autoplayBlockedNotified: false
};

function startSettingsNewAgentMonitor() {
  if (settingsAgentPollHandle) {
    return;
  }

  // Prime known agents without triggering audio
  pollSettingsAgents(true);
  settingsAgentPollHandle = setInterval(() => pollSettingsAgents(false), SETTINGS_AGENT_POLL_INTERVAL);

  if (!settingsVisibilityHandlerAttached) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        pollSettingsAgents(false);
      }
    });
    settingsVisibilityHandlerAttached = true;
  }

  window.addEventListener('beforeunload', stopSettingsNewAgentMonitor);
}

function stopSettingsNewAgentMonitor() {
  if (settingsAgentPollHandle) {
    clearInterval(settingsAgentPollHandle);
    settingsAgentPollHandle = null;
  }
}

async function pollSettingsAgents(skipNotifications) {
  try {
    const response = await fetch('/api/user/agents', {
      headers: {
        'Accept': 'application/json'
      },
      credentials: 'same-origin'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch agents: ${response.status}`);
    }

    const data = await response.json();
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    const currentIds = new Set();
    const agentLookup = new Map();

    agents.forEach((agent) => {
      if (agent?.agentId) {
        currentIds.add(agent.agentId);
        agentLookup.set(agent.agentId, agent);
      }
    });

    const newAgents = [];
    currentIds.forEach((agentId) => {
      if (!settingsKnownAgentIds.has(agentId) && agentLookup.has(agentId)) {
        newAgents.push(agentLookup.get(agentId));
      }
    });

    if (!skipNotifications && settingsKnownAgentIds.size > 0 && newAgents.length > 0) {
      newAgents.forEach((agent) => playSettingsNewAgentNotification(agent));
    }

    settingsKnownAgentIds = currentIds;
  } catch (error) {
    console.error('Settings agent poll error:', error);
  }
}

function playSettingsNewAgentNotification(agent) {
  if (!agent || !agent.name) return;
  if (window.voiceControl && window.voiceControl.voiceEnabled === false) {
    return;
  }

  playSettingsNewAgentChime();

  if (agent.newAgentAudioUrl) {
    try {
      const audio = new Audio(agent.newAgentAudioUrl);
      audio.volume = 0.9;
      audio.play()
        .then(() => {
          settingsVoiceNotificationState.audioUnlocked = true;
        })
        .catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            if (!settingsVoiceNotificationState.autoplayBlockedNotified) {
              showErrorMessage('Tap anywhere to enable audio notifications.');
              settingsVoiceNotificationState.autoplayBlockedNotified = true;
            }
            return;
          }
          console.warn('Settings page new agent audio failed:', err);
        });
    } catch (err) {
      console.warn('Settings page new agent audio error:', err);
    }
    return;
  }

  const fallbackMessage = `New agent ${agent.name} connected.`;
  if (window.voiceControl && typeof window.voiceControl.speak === 'function') {
    window.voiceControl.speak(fallbackMessage);
  }
}

function playSettingsNewAgentChime() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    const playTone = (frequency, startTime, duration) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = frequency;
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0, audioContext.currentTime + startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + startTime + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + startTime + duration);

      oscillator.start(audioContext.currentTime + startTime);
      oscillator.stop(audioContext.currentTime + startTime + duration);
    };

    playTone(659.25, 0, 0.3);
    playTone(783.99, 0.15, 0.4);

    setTimeout(() => audioContext.close(), 1000);
  } catch (err) {
    console.warn('Settings page new agent chime error:', err);
  }
}

/**
 * Initialize agent instructions customization when settings page loads
 */
document.addEventListener('DOMContentLoaded', () => {
  if (window.apiGuideConfig) {
    initializeAgentInstructionsCustomization();
  }

  // Setup collapsible sections with smooth animations
  const toggleButtons = document.querySelectorAll('.toggle-collapse');

  toggleButtons.forEach(button => {
    button.addEventListener('click', () => {
      const collapsibleContent = button.nextElementSibling;
      const chevronIcon = button.querySelector('.chevron-icon');

      if (collapsibleContent && collapsibleContent.classList.contains('collapsible-content')) {
        const isCollapsed = collapsibleContent.style.maxHeight === '0px' || collapsibleContent.style.maxHeight === '';

        if (isCollapsed) {
          // Expand
          collapsibleContent.style.maxHeight = collapsibleContent.scrollHeight + 'px';
          if (chevronIcon) {
            chevronIcon.style.transform = 'rotate(180deg)';
          }
        } else {
          // Collapse
          collapsibleContent.style.maxHeight = '0px';
          if (chevronIcon) {
            chevronIcon.style.transform = 'rotate(0deg)';
          }
        }
      }
    });
  });

  // Setup voice settings
  setupVoiceSettings();
  setupEncryptionSettings();
  startSettingsNewAgentMonitor();
});

/**
 * Setup encryption password settings
 */
async function setupEncryptionSettings() {
  const passwordInput = document.getElementById('settingsDecryptionPassword');
  const saveBtn = document.getElementById('settingsDecryptionSaveBtn');
  const clearBtn = document.getElementById('clearEncryptionKeyBtn');
  const statusIcon = document.getElementById('encryptionKeyStatusIcon');
  const statusText = document.getElementById('encryptionKeyStatusText');

  if (!passwordInput || !saveBtn) return;

  // Check current encryption key status
  await updateEncryptionKeyStatus();

  // Save button handler
  saveBtn.addEventListener('click', async () => {
    const password = passwordInput.value?.trim();
    if (!password) {
      showErrorMessage('Please enter a password');
      return;
    }

    const salt = window.apiGuideConfig?.encryptionSalt;
    if (!salt) {
      showErrorMessage('Encryption salt not available. Please refresh the page.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      // Derive and store the encryption key
      const key = await window.E2EEncryption.deriveKey(password, salt);
      await window.E2EEncryption.storeEncryptionKey(key);

      passwordInput.value = '';
      showSuccessMessage('Encryption key saved successfully! Messages will now be decrypted.');
      await updateEncryptionKeyStatus();
    } catch (error) {
      console.error('Failed to save encryption key:', error);
      showErrorMessage('Failed to save encryption key. Please try again.');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  // Clear button handler
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to clear your saved encryption key?')) {
        return;
      }

      try {
        await window.E2EEncryption.clearEncryptionKey();
        showSuccessMessage('Encryption key cleared.');
        await updateEncryptionKeyStatus();
      } catch (error) {
        console.error('Failed to clear encryption key:', error);
        showErrorMessage('Failed to clear encryption key.');
      }
    });
  }

  // Enter key to save
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  async function updateEncryptionKeyStatus() {
    if (!statusIcon || !statusText) return;

    try {
      const hasKey = await window.E2EEncryption.getStoredEncryptionKey();

      if (hasKey) {
        statusIcon.className = 'w-2 h-2 rounded-full bg-emerald-400';
        statusText.textContent = 'Encryption key is saved. Messages will be decrypted.';
        statusText.className = 'text-xs text-emerald-400';
      } else {
        statusIcon.className = 'w-2 h-2 rounded-full bg-amber-400';
        statusText.textContent = 'No encryption key saved. Set a password to decrypt messages.';
        statusText.className = 'text-xs text-amber-400';
      }
    } catch (error) {
      statusIcon.className = 'w-2 h-2 rounded-full bg-red-400';
      statusText.textContent = 'Error checking encryption key status.';
      statusText.className = 'text-xs text-red-400';
    }
  }
}

function setupVoiceSettings() {
  const toggleBtn = document.getElementById('voiceSettingsToggle');
  const knob = document.getElementById('voiceSettingsKnob');

  if (!toggleBtn || !knob) return;

  // Initialize state
  const isEnabled = window.voiceControl && window.voiceControl.voiceEnabled;
  updateToggleState(toggleBtn, knob, isEnabled);

  toggleBtn.addEventListener('click', () => {
    const newState = !window.voiceControl.voiceEnabled;
    window.voiceControl.toggleVoiceNotifications(newState);
    updateToggleState(toggleBtn, knob, newState);

    if (newState) {
      window.voiceControl.speak('Voice notifications turned on');
    }
  });

  function updateToggleState(btn, knobElement, enabled) {
    btn.setAttribute('aria-checked', enabled);
    if (enabled) {
      btn.classList.remove('bg-slate-700'); // Changed from bg-gray-200 to match dark theme default
      btn.classList.add('bg-emerald-600'); // Changed from bg-blue-600 to match theme
      knobElement.classList.remove('translate-x-0');
      knobElement.classList.add('translate-x-5');
    } else {
      btn.classList.remove('bg-emerald-600');
      btn.classList.add('bg-slate-700');
      knobElement.classList.remove('translate-x-5');
      knobElement.classList.add('translate-x-0');
    }
  }
}

function initializeAgentInstructionsCustomization() {
  const agentInput = document.getElementById('guideAgentName');
  if (!agentInput) {
    return;
  }

  const startingName = window.apiGuideConfig.defaultAgentName || 'Your Agent Name';

  agentInput.value = startingName;
  agentInput.addEventListener('input', () => {
    updateAgentInstructions(agentInput.value);
    updateDirectSetupScript(agentInput.value);
  });

  updateAgentInstructions(startingName);
  updateDirectSetupScript(startingName);
}

async function updateAgentInstructions(agentName) {
  const sanitizedAgentName = sanitizeAgentName(agentName) || window.apiGuideConfig.defaultAgentName || 'Your Agent Name';

  try {
    // Fetch agent instructions from the server
    const response = await fetch('/settings/generate-guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({
        agentName: sanitizedAgentName,
        variant: 'full'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch agent instructions');
    }

    const data = await response.json();

    const instructionsElement = document.getElementById('agentInstructions');
    if (instructionsElement) {
      instructionsElement.textContent = data.guide;
    }
  } catch (error) {
    console.error('Failed to update agent instructions:', error);
    showErrorMessage('Failed to update agent instructions');
  }
}

function buildTerminalSafeInstructions(instructionsText = '') {
  const trimmed = instructionsText.trim();
  if (!trimmed) {
    return '';
  }
  return `\n${trimmed}\nAGENT_INSTRUCTIONS\n`;
}

async function updateDirectSetupScript(agentName) {
  const sanitizedAgentName = sanitizeAgentName(agentName) || window.apiGuideConfig.defaultAgentName || 'Your Agent Name';

  try {
    const response = await fetch('/settings/generate-guide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({
        agentName: sanitizedAgentName,
        variant: 'direct'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to fetch direct setup script');
    }

    const data = await response.json();
    const scriptElement = document.getElementById('directSetupScript');
    if (scriptElement) {
      scriptElement.textContent = data.guide;
    }
  } catch (error) {
    console.error('Failed to update direct setup script:', error);
    showErrorMessage('Failed to update direct setup script');
  }
}

function sanitizeAgentName(name) {
  if (!name || typeof name !== 'string') {
    return '';
  }
  return name.trim().slice(0, 255);
}

/**
 * Show delete account confirmation modal
 */
function showDeleteAccountModal() {
  const modal = document.getElementById('deleteAccountModal');
  const confirmInput = document.getElementById('confirmEmailInput');
  const errorDiv = document.getElementById('deleteAccountError');

  if (modal) {
    modal.classList.remove('hidden');
    // Clear previous input and errors
    if (confirmInput) {
      confirmInput.value = '';
    }
    if (errorDiv) {
      errorDiv.classList.add('hidden');
    }
  }
}

/**
 * Hide delete account confirmation modal
 */
function hideDeleteAccountModal() {
  const modal = document.getElementById('deleteAccountModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * Confirm and process account deletion
 */
async function confirmDeleteAccount() {
  const confirmInput = document.getElementById('confirmEmailInput');
  const errorDiv = document.getElementById('deleteAccountError');
  const errorText = document.getElementById('deleteAccountErrorText');
  const confirmBtn = document.getElementById('confirmDeleteBtn');

  const confirmEmail = confirmInput?.value?.trim();

  if (!confirmEmail) {
    if (errorDiv && errorText) {
      errorText.textContent = 'Please enter your email address to confirm.';
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  // Disable button and show loading state
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting...';
  }

  try {
    const response = await fetch('/settings/delete-account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken
      },
      body: JSON.stringify({
        confirmEmail: confirmEmail
      })
    });

    const data = await response.json();

    if (data.success) {
      // Show success message and redirect
      showSuccessMessage(data.message || 'Account deleted successfully.');

      // Redirect to home page after a short delay
      setTimeout(() => {
        window.location.href = data.redirect || '/';
      }, 1500);
    } else {
      // Show error
      if (errorDiv && errorText) {
        errorText.textContent = data.error || 'Failed to delete account. Please try again.';
        errorDiv.classList.remove('hidden');
      }

      // Re-enable button
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete My Account';
      }
    }
  } catch (error) {
    console.error('Account deletion error:', error);

    if (errorDiv && errorText) {
      errorText.textContent = 'An error occurred. Please try again.';
      errorDiv.classList.remove('hidden');
    }

    // Re-enable button
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete My Account';
    }
  }
}
