/**
 * Settings Page JavaScript
 * Handles API key copying, CLI script copying, and API key regeneration
 */

async function refreshCsrfToken() {
  const res = await fetch('/csrf-token', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to refresh CSRF token');
  const data = await res.json();
  window.csrfToken = data.csrfToken;
  return data.csrfToken;
}

async function csrfFetch(url, options = {}) {
  if (options.headers && ('X-CSRF-Token' in options.headers)) {
    options.headers['X-CSRF-Token'] = window.csrfToken;
  }
  let res = await fetch(url, options);
  if (res.status === 403) {
    const clone = res.clone();
    try {
      const body = await clone.json();
      if (body?.error?.code?.startsWith('CSRF_TOKEN')) {
        await refreshCsrfToken();
        if (options.headers) {
          options.headers['X-CSRF-Token'] = window.csrfToken;
        }
        res = await fetch(url, options);
      }
    } catch (_) { /* not JSON, return original */ }
  }
  return res;
}

/**
 * Mask an API key for display
 */
function maskApiKey(apiKey) {
  if (!apiKey) return '';
  // Show masked version like ••••••••-••••-••••-••••-••••••••••••
  const parts = apiKey.split('-');
  if (parts.length === 5) {
    // UUID format
    return parts.map(part => '•'.repeat(part.length)).join('-');
  }
  // Generic masking
  return '•'.repeat(Math.min(apiKey.length, 32));
}

/**
 * Toggle API key visibility
 */
let apiKeyVisible = false;

function toggleApiKeyVisibility() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  const eyeClosedIcon = document.getElementById('eyeClosedIcon');
  const eyeOpenIcon = document.getElementById('eyeOpenIcon');

  if (!apiKeyInput) return;

  const realKey = apiKeyInput.dataset.realKey || '';
  apiKeyVisible = !apiKeyVisible;

  if (apiKeyVisible) {
    // Show the real key
    apiKeyInput.value = realKey;
    eyeClosedIcon.classList.add('hidden');
    eyeOpenIcon.classList.remove('hidden');
  } else {
    // Hide with masked version
    apiKeyInput.value = maskApiKey(realKey);
    eyeClosedIcon.classList.remove('hidden');
    eyeOpenIcon.classList.add('hidden');
  }
}

/**
 * Initialize API key display (masked by default)
 */
function initApiKeyDisplay() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput && apiKeyInput.dataset.realKey) {
    apiKeyInput.value = maskApiKey(apiKeyInput.dataset.realKey);
  }
}

/**
 * Copy API key to clipboard
 */
function copyApiKey() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (!apiKeyInput) return;

  // Always copy the real key, not the masked version
  const realKey = apiKeyInput.dataset.realKey || apiKeyInput.value;

  // Copy to clipboard
  navigator.clipboard.writeText(realKey)
    .then(() => {
      showSuccessMessage('API key copied to clipboard!');
    })
    .catch(err => {
      console.error('Failed to copy API key:', err);

      // Fallback for older browsers
      try {
        const textarea = document.createElement('textarea');
        textarea.value = realKey;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showSuccessMessage('API key copied to clipboard!');
      } catch (e) {
        showErrorMessage('Failed to copy API key. Please copy manually.');
      }
    });
}

async function copyMcpAddress() {
  const address = document.getElementById('mcpServerAddress');
  const status = document.getElementById('mcpCopyStatus');
  if (!address || !status) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(address.textContent.trim());
    status.textContent = 'Address copied';
  } catch (_) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(address);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Select and copy the highlighted address';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('copyMcpAddress')?.addEventListener('click', copyMcpAddress);
});

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
    const response = await csrfFetch('/settings/generate-guide', {
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
  if (window.ChatMCPSetup?.open()) return;
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
  if (typeof window.showSuccess === 'function') {
    window.showSuccess(message);
  } else {
    console.warn('showSuccess handler not available:', message);
  }
}

/**
 * Show error message
 */
function showErrorMessage(message) {
  if (typeof window.showError === 'function') {
    window.showError(message);
  } else {
    console.error('Error:', message);
  }
}

// Expose to window for use by other scripts (e.g., setup-script.js)
window.showSuccessMessage = showSuccessMessage;
window.showErrorMessage = showErrorMessage;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const OPENCLAW_BOT_INSTRUCTIONS = `Try to connect to my council at chatmcp.space please set it up.
Read the setup instructions at https://chatmcp.space/setup and run:
curl -sL https://chatmcp.space/setup | bash
Prompt me for API key and account password only when needed.
If I do not have an account, guide me to https://chatmcp.space/register first.`;

function copyOpenClawInstruction() {
  navigator.clipboard.writeText(OPENCLAW_BOT_INSTRUCTIONS)
    .then(() => showSuccessMessage('OpenClaw instructions copied to clipboard.'))
    .catch((err) => {
      console.error('Failed to copy OpenClaw instructions:', err);
      showErrorMessage('Failed to copy OpenClaw instructions');
    });
}

window.copyOpenClawInstruction = copyOpenClawInstruction;

async function fetchOpenClawConnections() {
  const listEl = document.getElementById('openClawConnectionsList');
  if (!listEl) return;

  try {
    const response = await fetch('/api/user/external-bots', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });

    if (response.status === 404) {
      listEl.innerHTML = '<p class="text-slate-500">OpenClaw integration is currently disabled.</p>';
      return;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch connections (${response.status})`);
    }

    const data = await response.json();
    const connections = Array.isArray(data?.connections) ? data.connections : [];

    if (connections.length === 0) {
      listEl.innerHTML = '<p class="text-slate-500">No OpenClaw connections yet.</p>';
      return;
    }

    listEl.innerHTML = connections.map((connection) => `
      <div class="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="text-slate-200 font-medium truncate">${escapeHtml(connection.agent?.name || 'Unnamed')}</p>
            <p class="text-slate-400">status: ${escapeHtml(connection.status || 'unknown')} · mode: ${escapeHtml(connection.agent?.interAgentMode || 'disabled')}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" data-action="verify-openclaw" data-connection-id="${escapeHtml(connection.connectionId)}"
              class="px-2 py-1 rounded border border-slate-600 text-slate-300 hover:text-white text-[11px]">
              Verify
            </button>
            <button type="button" data-action="rotate-openclaw" data-connection-id="${escapeHtml(connection.connectionId)}"
              class="px-2 py-1 rounded border border-amber-700 text-amber-300 hover:text-amber-200 text-[11px]">
              Rotate Token
            </button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to fetch OpenClaw connections:', error);
    listEl.innerHTML = '<p class="text-red-400">Failed to load OpenClaw connections.</p>';
  }
}

async function initializeOpenClawIntegration() {
  const refreshBtn = document.getElementById('refreshOpenClawConnectionsBtn');
  const listEl = document.getElementById('openClawConnectionsList');

  if (!listEl) {
    return;
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchOpenClawConnections());
  }

  listEl.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const action = target.getAttribute('data-action');
    const connectionId = target.getAttribute('data-connection-id');
    if (!action || !connectionId) return;

    target.setAttribute('disabled', 'true');

    try {
      let response = null;
      if (action === 'verify-openclaw') {
        response = await csrfFetch(`/api/user/external-bots/${encodeURIComponent(connectionId)}/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          credentials: 'same-origin'
        });
      } else if (action === 'rotate-openclaw') {
        response = await csrfFetch(`/api/user/external-bots/${encodeURIComponent(connectionId)}/rotate-credential`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          credentials: 'same-origin'
        });
      }

      if (!response) return;
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error?.message || `Request failed (${response.status})`);
      }

      if (action === 'rotate-openclaw' && data?.credential?.oneTimeAgentToken) {
        await navigator.clipboard.writeText(data.credential.oneTimeAgentToken);
      }

      showSuccessMessage(
        action === 'verify-openclaw'
          ? 'Connection verified.'
          : 'Token rotated successfully. New token copied to clipboard.'
      );
      await fetchOpenClawConnections();
    } catch (error) {
      console.error('OpenClaw action failed:', error);
      showErrorMessage(error.message || 'OpenClaw action failed');
    } finally {
      target.removeAttribute('disabled');
    }
  });

  await fetchOpenClawConnections();
}

/**
 * Lightweight new-agent monitor so settings page still gets voice alerts
 */
const SETTINGS_AGENT_POLL_INTERVAL = 3000;
const SETTINGS_AGENT_POLL_INTERVAL_MAX = 30000;
const SETTINGS_AGENT_POLL_JITTER = 1000;
let settingsAgentPollHandle = null;
let settingsAgentPollNextDelayMs = SETTINGS_AGENT_POLL_INTERVAL;
let settingsAgentPollInFlight = false;
let settingsKnownAgentIds = new Set();
let settingsVisibilityHandlerAttached = false;
const settingsVoiceNotificationState = {
  audioUnlocked: false,
  autoplayBlockedNotified: false
};

function getSettingsRetryAfterMs(response) {
  const retryAfter = response?.headers?.get('Retry-After');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const retryDate = Date.parse(retryAfter);
  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }
  return null;
}

function getSettingsServerPollDelayMs(response, payload, fallbackMs = SETTINGS_AGENT_POLL_INTERVAL) {
  const retryAfterMs = getSettingsRetryAfterMs(response);
  const headerMs = Number(response?.headers?.get('X-Poll-Interval-Ms'));
  const bodyMs = Number(payload?.poll?.nextPollMs);
  const jitterHeaderMs = Number(response?.headers?.get('X-Poll-Jitter-Ms'));
  const jitterBodyMs = Number(payload?.poll?.jitterMs);
  const baseMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs
    : (Number.isFinite(headerMs) && headerMs > 0 ? headerMs : bodyMs);
  const jitterMs = Number.isFinite(jitterHeaderMs) && jitterHeaderMs > 0
    ? jitterHeaderMs
    : (Number.isFinite(jitterBodyMs) && jitterBodyMs > 0 ? jitterBodyMs : SETTINGS_AGENT_POLL_JITTER);
  const nextMs = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : fallbackMs;
  const withJitter = nextMs + Math.floor(Math.random() * Math.max(1, jitterMs));
  return Math.max(SETTINGS_AGENT_POLL_INTERVAL, Math.min(SETTINGS_AGENT_POLL_INTERVAL_MAX, withJitter));
}

function startSettingsNewAgentMonitor() {
  if (settingsAgentPollHandle) {
    return;
  }

  // Prime known agents without triggering audio
  pollSettingsAgents(true);
  settingsAgentPollNextDelayMs = SETTINGS_AGENT_POLL_INTERVAL;
  scheduleSettingsAgentPoll(false, SETTINGS_AGENT_POLL_INTERVAL);

  if (!settingsVisibilityHandlerAttached) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        settingsAgentPollNextDelayMs = SETTINGS_AGENT_POLL_INTERVAL;
        pollSettingsAgents(false);
      }
    });
    settingsVisibilityHandlerAttached = true;
  }

  window.addEventListener('beforeunload', stopSettingsNewAgentMonitor);
}

function scheduleSettingsAgentPoll(skipNotifications, delayMs) {
  clearTimeout(settingsAgentPollHandle);
  settingsAgentPollHandle = setTimeout(async () => {
    if (settingsAgentPollInFlight) {
      scheduleSettingsAgentPoll(skipNotifications, settingsAgentPollNextDelayMs);
      return;
    }
    settingsAgentPollInFlight = true;
    try {
      await pollSettingsAgents(skipNotifications);
    } finally {
      settingsAgentPollInFlight = false;
      scheduleSettingsAgentPoll(false, settingsAgentPollNextDelayMs);
    }
  }, Math.max(0, delayMs));
}

function stopSettingsNewAgentMonitor() {
  if (settingsAgentPollHandle) {
    clearTimeout(settingsAgentPollHandle);
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
      settingsAgentPollNextDelayMs = getSettingsServerPollDelayMs(
        response,
        null,
        settingsAgentPollNextDelayMs * 2
      );
      throw new Error(`Failed to fetch agents: ${response.status}`);
    }

    const data = await response.json();
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    settingsAgentPollNextDelayMs = getSettingsServerPollDelayMs(
      response,
      data,
      agents.length > 0 ? SETTINGS_AGENT_POLL_INTERVAL : settingsAgentPollNextDelayMs
    );
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
  // Initialize API key with masked display
  initApiKeyDisplay();

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
  setupTwoFactorAuth();
  setupEncryptionSettings();
  initializeOpenClawIntegration();
  startSettingsNewAgentMonitor();
  const usageDetails = document.getElementById('usageLimitsDetails');
  if (usageDetails) {
    let requested = false;
    usageDetails.addEventListener('toggle', () => {
      if (usageDetails.open && !requested) { requested = true; void loadUsageLimits(); }
    });
  } else loadUsageLimits();
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
    const response = await csrfFetch('/settings/generate-guide', {
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
    const response = await csrfFetch('/settings/generate-guide', {
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

function setMfaEnabled(enabled) {
  if (!window.mfaConfig) {
    window.mfaConfig = {};
  }
  window.mfaConfig.enabled = enabled === true;

  const statusBadge = document.getElementById('mfaStatusBadge');
  const statusText = document.getElementById('mfaStatusText');
  const startBtn = document.getElementById('startMfaSetupBtn');
  const setupPanel = document.getElementById('mfaSetupPanel');
  const disablePanel = document.getElementById('mfaDisablePanel');

  if (statusBadge) {
    statusBadge.textContent = enabled ? 'Enabled' : 'Disabled';
    statusBadge.className = `inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${enabled
      ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
      : 'bg-slate-700/70 text-slate-300 border border-slate-600'}`;
  }

  if (statusText) {
    statusText.textContent = enabled
      ? 'Enabled. You will be prompted for a 6-digit code after sign-in.'
      : 'Disabled. Sign-in works exactly as it does today until you opt in.';
  }

  if (startBtn) {
    startBtn.classList.toggle('hidden', enabled);
  }

  if (disablePanel) {
    disablePanel.classList.toggle('hidden', !enabled);
  }

  if (setupPanel && enabled) {
    setupPanel.classList.add('hidden');
  }
}

function resetMfaSetupPanel() {
  const secretInput = document.getElementById('mfaSecretInput');
  const verifyInput = document.getElementById('mfaVerifyCodeInput');
  const setupPanel = document.getElementById('mfaSetupPanel');
  const recoveryCodesPanel = document.getElementById('mfaRecoveryCodesPanel');
  const recoveryCodesInput = document.getElementById('mfaRecoveryCodesInput');

  if (secretInput) {
    secretInput.value = '';
    delete secretInput.dataset.otpauthUrl;
  }

  if (verifyInput) {
    verifyInput.value = '';
  }

  if (setupPanel) {
    setupPanel.classList.add('hidden');
  }

  if (recoveryCodesInput) {
    recoveryCodesInput.value = '';
  }

  if (recoveryCodesPanel) {
    recoveryCodesPanel.classList.add('hidden');
  }
}

function setupTwoFactorAuth() {
  const startBtn = document.getElementById('startMfaSetupBtn');
  const confirmBtn = document.getElementById('confirmMfaSetupBtn');
  const cancelBtn = document.getElementById('cancelMfaSetupBtn');
  const copyBtn = document.getElementById('copyMfaSecretBtn');
  const copyRecoveryCodesBtn = document.getElementById('copyMfaRecoveryCodesBtn');
  const dismissRecoveryCodesBtn = document.getElementById('dismissMfaRecoveryCodesBtn');
  const disableBtn = document.getElementById('disableMfaBtn');
  const setupPanel = document.getElementById('mfaSetupPanel');
  const secretInput = document.getElementById('mfaSecretInput');
  const verifyInput = document.getElementById('mfaVerifyCodeInput');
  const disableInput = document.getElementById('mfaDisableCodeInput');
  const recoveryCodesPanel = document.getElementById('mfaRecoveryCodesPanel');
  const recoveryCodesInput = document.getElementById('mfaRecoveryCodesInput');

  if (!startBtn && !disableBtn) {
    return;
  }

  setMfaEnabled(window.mfaConfig?.enabled === true);

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.textContent = 'Preparing...';

      try {
        const response = await csrfFetch('/settings/2fa/setup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({})
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to start two-factor setup');
        }

        if (secretInput) {
          secretInput.value = data.secret || '';
          secretInput.dataset.otpauthUrl = data.otpauthUrl || '';
        }

        if (verifyInput) {
          verifyInput.value = '';
          verifyInput.focus();
        }

        if (setupPanel) {
          setupPanel.classList.remove('hidden');
        }
      } catch (error) {
        console.error('2FA setup start error:', error);
        showErrorMessage(error.message || 'Failed to start two-factor setup');
      } finally {
        startBtn.disabled = false;
        startBtn.textContent = 'Set Up Authenticator App';
      }
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const value = secretInput?.value?.trim();
      if (!value) {
        showErrorMessage('No secret available to copy yet.');
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        showSuccessMessage('Authenticator secret copied.');
      } catch (error) {
        console.error('Failed to copy authenticator secret:', error);
        showErrorMessage('Failed to copy the secret.');
      }
    });
  }

  if (copyRecoveryCodesBtn) {
    copyRecoveryCodesBtn.addEventListener('click', async () => {
      const value = recoveryCodesInput?.value?.trim();
      if (!value) {
        showErrorMessage('No recovery codes are available to copy.');
        return;
      }

      try {
        await navigator.clipboard.writeText(value);
        showSuccessMessage('Recovery codes copied. Store them somewhere private.');
      } catch (error) {
        console.error('Failed to copy recovery codes:', error);
        showErrorMessage('Failed to copy the recovery codes.');
      }
    });
  }

  if (dismissRecoveryCodesBtn) {
    dismissRecoveryCodesBtn.addEventListener('click', () => {
      if (recoveryCodesPanel) {
        recoveryCodesPanel.classList.add('hidden');
      }
      if (recoveryCodesInput) {
        recoveryCodesInput.value = '';
      }
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      resetMfaSetupPanel();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const code = verifyInput?.value?.trim();
      if (!/^\d{6}$/.test(code || '')) {
        showErrorMessage('Enter the 6-digit code from your authenticator app.');
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Enabling...';

      try {
        const response = await csrfFetch('/settings/2fa/enable', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({ code })
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to enable two-factor authentication');
        }

        setMfaEnabled(true);
        resetMfaSetupPanel();
        const recoveryCodes = Array.isArray(data.recoveryCodes) ? data.recoveryCodes.filter(Boolean) : [];
        if (recoveryCodes.length && recoveryCodesInput && recoveryCodesPanel) {
          recoveryCodesInput.value = recoveryCodes.join('\n');
          recoveryCodesPanel.classList.remove('hidden');
          recoveryCodesInput.focus({ preventScroll: true });
        }
        if (disableInput) {
          disableInput.value = '';
        }
        showSuccessMessage(data.message || 'Two-factor authentication enabled.');
      } catch (error) {
        console.error('2FA enable error:', error);
        showErrorMessage(error.message || 'Failed to enable two-factor authentication');
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Enable 2FA';
      }
    });
  }

  if (disableBtn) {
    disableBtn.addEventListener('click', async () => {
      const code = disableInput?.value?.trim();
      if (!/^\d{6}$/.test(code || '')) {
        showErrorMessage('Enter one current 6-digit code to disable 2FA.');
        return;
      }

      disableBtn.disabled = true;
      disableBtn.textContent = 'Disabling...';

      try {
        const response = await csrfFetch('/settings/2fa/disable', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.csrfToken
          },
          body: JSON.stringify({ code })
        });
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to disable two-factor authentication');
        }

        setMfaEnabled(false);
        if (disableInput) {
          disableInput.value = '';
        }
        showSuccessMessage(data.message || 'Two-factor authentication disabled.');
      } catch (error) {
        console.error('2FA disable error:', error);
        showErrorMessage(error.message || 'Failed to disable two-factor authentication');
      } finally {
        disableBtn.disabled = false;
        disableBtn.textContent = 'Disable';
      }
    });
  }
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
    const response = await csrfFetch('/settings/delete-account', {
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

/**
 * Fetch and render the "Usage & Limits" card
 */
async function loadUsageLimits() {
  const loadingEl = document.getElementById('usageLimitsLoading');
  const errorEl = document.getElementById('usageLimitsError');
  const contentEl = document.getElementById('usageLimitsContent');
  if (!loadingEl || !errorEl || !contentEl) return;

  try {
    const response = await fetch('/api/user/usage-limits', {
      headers: { 'Accept': 'application/json' },
      credentials: 'same-origin'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch usage limits: ${response.status}`);
    }

    const data = await response.json();
    renderUsageLimits(data);

    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (error) {
    console.error('Usage limits fetch error:', error);
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');
  }
}

function usageLimitBarColor(remaining, limit) {
  const ratio = limit > 0 ? remaining / limit : 1;
  if (ratio <= 0.15) return 'bg-red-500';
  if (ratio <= 0.4) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function renderUsageLimitRow(item) {
  const limit = Number(item.limit) || 0;
  const used = Number(item.used) || 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const barColor = usageLimitBarColor(item.remaining, limit);

  return `
    <div>
      <div class="flex items-center justify-between text-xs text-slate-400 mb-1">
        <span>${escapeHtml(item.label || item.scope)}</span>
        <span>${used} / ${limit} per minute</span>
      </div>
      <div class="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
        <div class="h-full ${barColor}" style="width: ${percent}%"></div>
      </div>
    </div>
  `;
}

function renderUsageLimits(data) {
  const accountEl = document.getElementById('usageLimitsAccount');
  const agentsEl = document.getElementById('usageLimitsAgents');
  if (!accountEl || !agentsEl) return;

  const accountLimits = Array.isArray(data?.account?.limits) ? data.account.limits : [];
  accountEl.innerHTML = accountLimits.length
    ? accountLimits.map(renderUsageLimitRow).join('')
    : '<p class="text-xs text-slate-500">No account-wide limits to show.</p>';

  const agents = Array.isArray(data?.agents) ? data.agents : [];
  agentsEl.innerHTML = agents.length
    ? agents.map((agent) => `
        <details class="rounded-xl bg-slate-800/50 p-4 settings-agent-usage">
          <summary class="text-sm font-medium text-slate-200 cursor-pointer">${escapeHtml(agent.agentName)}</summary>
          <div class="mt-3 space-y-3">${(agent.limits || []).map(renderUsageLimitRow).join('')}</div>
        </details>
      `).join('')
    : '<p class="text-xs text-slate-500">No agents yet.</p>';
}
