/**
 * Archive Page JavaScript
 * Handles restore and delete actions for archived agents
 */

document.addEventListener('DOMContentLoaded', () => {
  setupArchivePageEventListeners();
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

      await deleteArchivedAgent(agentId, archivedAgentId, agentName, card);
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

    const response = await fetch(`/api/user/agents/${agentId}/archive`, {
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
  // Show confirmation dialog
  const confirmed = confirm(
    `Permanently delete "${agentName}"?\n\n` +
    `This will remove the agent and ALL archived messages forever. ` +
    `This action CANNOT be undone.`
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(`/api/user/archive/${archivedAgentId}`, {
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
