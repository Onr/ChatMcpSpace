/**
 * Archive Page JavaScript
 * Handles restore and delete actions for archived agents
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

document.addEventListener('DOMContentLoaded', () => {
  setupArchivePageEventListeners();
  setupArchiveDeleteConfirmationModal();
});

/**
 * Setup event listeners for archive page
 */
function setupArchivePageEventListeners() {
  // Restore buttons
  const restoreBtns = document.querySelectorAll('.restore-agent-btn');
  restoreBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const card = e.target.closest('[data-agent-id]');
      if (!card) return;

      const agentId = card.dataset.agentId;
      const agentName = card.querySelector('h3')?.textContent?.trim() || 'this agent';

      await restoreAgent(agentId, agentName, card);
    });
  });

  // Delete buttons
  const deleteBtns = document.querySelectorAll('.delete-archived-agent-btn');
  deleteBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const card = e.target.closest('[data-agent-id]');
      if (!card) return;

      const agentId = card.dataset.agentId;
      const archivedAgentId = card.dataset.archivedAgentId;
      const agentName = card.querySelector('h3')?.textContent?.trim() || 'this agent';

      showArchiveDeleteConfirmationModal({ agentId, archivedAgentId, agentName, cardElement: card });
    });
  });

  // Search input
  const searchInput = document.getElementById('archiveSearchInput');
  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const query = e.target.value.toLowerCase();

      // Client-side filtering
      const cards = document.querySelectorAll('[data-archived-agent-id]');
      cards.forEach(card => {
        const agentName = card.querySelector('h3')?.textContent?.toLowerCase() || '';
        const reason = card.querySelector('[data-reason]')?.textContent?.toLowerCase() || '';

        if (agentName.includes(query) || reason.includes(query)) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    });
  }
}

/**
 * Restore an archived agent back to the dashboard
 */
async function restoreAgent(agentId, agentName, cardElement) {
  const restoreBtn = cardElement.querySelector('.restore-agent-btn');
  if (restoreBtn?.disabled) return;
  if (restoreBtn) restoreBtn.disabled = true;

  try {
    const csrfToken = window.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content;
    if (!csrfToken) {
      throw new Error('CSRF token not found');
    }

    const response = await csrfFetch(`/api/user/agents/${agentId}/archive`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to restore agent');
    }

    // Remove card with animation
    cardElement.style.transition = 'opacity 0.3s, transform 0.3s';
    cardElement.style.opacity = '0';
    cardElement.style.transform = 'scale(0.95)';

    setTimeout(() => {
      cardElement.remove();

      // Check if page is now empty
      const remainingCards = document.querySelectorAll('[data-archived-agent-id]');
      if (remainingCards.length === 0) {
        // Reload page to show empty state or previous page
        window.location.reload();
      }
    }, 300);

    // Show success toast
    showSuccessToast(`${agentName} restored successfully`);

  } catch (error) {
    console.error('Error restoring agent:', error);
    showErrorToast(error.message || 'Failed to restore agent');
  } finally {
    if (restoreBtn) restoreBtn.disabled = false;
  }
}

/**
 * Permanently delete an archived agent
 */
async function deleteArchivedAgent(agentId, archivedAgentId, agentName, cardElement) {
  try {
    const response = await csrfFetch(`/api/user/archive/${archivedAgentId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Failed to delete archived agent');
    }

    // Remove card with animation
    cardElement.style.transition = 'opacity 0.3s, transform 0.3s';
    cardElement.style.opacity = '0';
    cardElement.style.transform = 'translateX(-20px)';

    setTimeout(() => {
      cardElement.remove();

      // Check if page is now empty
      const remainingCards = document.querySelectorAll('[data-archived-agent-id]');
      if (remainingCards.length === 0) {
        // Reload page to show empty state
        window.location.reload();
      }
    }, 300);

    // Show success toast
    showSuccessToast(`${agentName} permanently deleted`);

  } catch (error) {
    console.error('Error deleting archived agent:', error);
    showErrorToast(error.message || 'Failed to delete archived agent');
  }
}

let pendingArchiveDelete = null;

function setupArchiveDeleteConfirmationModal() {
  const modal = document.getElementById('archiveDeleteConfirmationModal');
  if (!modal) return;

  const cancelBtn = document.getElementById('archiveDeleteCancelBtn');
  const confirmBtn = document.getElementById('archiveDeleteConfirmBtn');
  const nameInput = document.getElementById('archiveDeleteAgentNameConfirmInput');

  const updateConfirmState = () => {
    if (!nameInput || !confirmBtn) return;
    const expected = (modal?.dataset?.expectedAgentName || '').trim();
    const actual = (nameInput.value || '').trim();
    const ok = expected.length > 0 && actual === expected;
    confirmBtn.disabled = !ok;
    nameInput.classList.toggle('border-amber-400', ok);
    nameInput.classList.toggle('border-slate-600', !ok);
  };

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      hideArchiveDeleteConfirmationModal();
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!pendingArchiveDelete?.archivedAgentId) return;

      const expected = (modal?.dataset?.expectedAgentName || '').trim();
      if (nameInput && expected.length > 0) {
        const actual = (nameInput.value || '').trim();
        if (actual !== expected) {
          showErrorToast(`Type "${expected}" to confirm deletion`);
          nameInput.focus();
          updateConfirmState();
          return;
        }
      }

      const { agentId, archivedAgentId, agentName, cardElement } = pendingArchiveDelete;
      hideArchiveDeleteConfirmationModal();
      await deleteArchivedAgent(agentId, archivedAgentId, agentName, cardElement);
    });
  }

  if (nameInput) {
    nameInput.addEventListener('input', updateConfirmState);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn?.click();
      }
    });
  }

  // Close modal on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideArchiveDeleteConfirmationModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      hideArchiveDeleteConfirmationModal();
    }
  });
}

function showArchiveDeleteConfirmationModal({ agentId, archivedAgentId, agentName, cardElement }) {
  const modal = document.getElementById('archiveDeleteConfirmationModal');
  const modalLabel = document.getElementById('archiveDeleteModalAgentNameLabel');
  const confirmBtn = document.getElementById('archiveDeleteConfirmBtn');
  const nameInput = document.getElementById('archiveDeleteAgentNameConfirmInput');
  const expectedNameEl = document.getElementById('archiveDeleteAgentNameConfirmExpected');
  const expectedAgentName = (agentName || '').trim();

  // Fallback for unexpected pages without the modal
  if (!modal) {
    const confirmed = confirm(
      `Permanently delete "${agentName}"?\n\n` +
      `This will remove the agent and ALL archived messages forever. ` +
      `This action CANNOT be undone.`
    );
    if (confirmed) {
      deleteArchivedAgent(agentId, archivedAgentId, agentName, cardElement);
    }
    return;
  }

  pendingArchiveDelete = { agentId, archivedAgentId, agentName, cardElement };

  modal.dataset.expectedAgentName = expectedAgentName;
  if (expectedNameEl) expectedNameEl.textContent = expectedAgentName;

  setConfirmationModalAgentNameLabel(modalLabel, 'Delete', expectedAgentName);
  modal.classList.remove('hidden');

  if (nameInput) {
    nameInput.value = '';
    confirmBtn && (confirmBtn.disabled = true);
    setTimeout(() => nameInput.focus(), 100);
  } else {
    setTimeout(() => confirmBtn?.focus(), 100);
  }
}

function hideArchiveDeleteConfirmationModal() {
  const modal = document.getElementById('archiveDeleteConfirmationModal');
  if (!modal) return;

  modal.classList.add('hidden');
  pendingArchiveDelete = null;
  delete modal.dataset.expectedAgentName;

  const confirmBtn = document.getElementById('archiveDeleteConfirmBtn');
  const nameInput = document.getElementById('archiveDeleteAgentNameConfirmInput');
  if (confirmBtn && nameInput) confirmBtn.disabled = true;
  if (nameInput) nameInput.value = '';
}

function setConfirmationModalAgentNameLabel(labelEl, verb, agentName) {
  if (!labelEl) return;
  labelEl.textContent = `${verb} "`;
  const strong = document.createElement('strong');
  strong.textContent = agentName;
  labelEl.appendChild(strong);
  labelEl.appendChild(document.createTextNode('"?'));
}

/**
 * Show success toast notification
 */
function showSuccessToast(message) {
  if (typeof window.showSuccess === 'function') {
    window.showSuccess(message);
  } else {
    console.warn('showSuccess handler not available:', message);
  }
}

/**
 * Show error toast notification
 */
function showErrorToast(message) {
  if (typeof window.showError === 'function') {
    window.showError(message);
  } else {
    console.error('Error:', message);
  }
}
