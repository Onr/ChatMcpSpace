/**
 * Feedback Widget Logic
 * Handles open/close, draft preservation, keyboard shortcuts, and submission
 * Moved from dashboard.js to support global top-bar placement
 */
document.addEventListener('DOMContentLoaded', () => {
    initializeFeedbackWidget();
});

function initializeFeedbackWidget() {
    const triggerBtn = document.getElementById('feedbackTriggerBtn');
    const closeBtn = document.getElementById('feedbackCloseBtn');
    const panel = document.getElementById('feedbackPanel');
    const textarea = document.getElementById('feedbackTextarea');
    const charCount = document.getElementById('feedbackCharCount');
    const sendBtn = document.getElementById('feedbackSendBtn');
    const loveBtn = document.getElementById('feedbackLoveBtn');
    const successEl = document.getElementById('feedbackSuccess');

    if (!triggerBtn || !panel || !textarea || !sendBtn || !loveBtn) {
        console.warn('Feedback widget elements not found');
        return;
    }

    const DRAFT_STORAGE_KEY = 'feedback_draft';
    let isSubmitting = false;

    // Restore draft from localStorage
    const savedDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (savedDraft) {
        textarea.value = savedDraft;
        updateCharCount();
        updateSendButtonState();
    }

    // Toggle panel open/close
    function openPanel() {
        panel.classList.add('is-open');
        panel.classList.remove('hidden'); // Ensure it's visible
        triggerBtn.classList.add('is-active');
        setTimeout(() => {
            textarea.focus();
        }, 100);
    }

    function closePanel() {
        panel.classList.remove('is-open');
        panel.classList.add('hidden'); // Hide it
        triggerBtn.classList.remove('is-active');
    }

    function isOpen() {
        return panel.classList.contains('is-open');
    }

    // Update character count
    function updateCharCount() {
        if (charCount) {
            charCount.textContent = textarea.value.length;
        }
    }

    // Update send button enabled state
    function updateSendButtonState() {
        const hasContent = textarea.value.trim().length > 0;
        sendBtn.disabled = !hasContent || isSubmitting;
    }

    // Save draft to localStorage
    function saveDraft() {
        const content = textarea.value;
        if (content.trim()) {
            localStorage.setItem(DRAFT_STORAGE_KEY, content);
        } else {
            localStorage.removeItem(DRAFT_STORAGE_KEY);
        }
    }

    // Clear draft
    function clearDraft() {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
        textarea.value = '';
        updateCharCount();
        updateSendButtonState();
    }

    // Show success state
    function showSuccess() {
        if (successEl) {
            successEl.classList.remove('hidden');
        }
        // Auto-collapse after 1.5 seconds
        setTimeout(() => {
            if (successEl) {
                successEl.classList.add('hidden');
            }
            closePanel();
        }, 1500);
    }

    // Submit feedback
    async function submitFeedback(kind) {
        if (isSubmitting) return;

        const message = kind === 'feedback' ? textarea.value.trim() : null;

        // Validate for feedback kind
        if (kind === 'feedback' && !message) {
            return;
        }

        isSubmitting = true;
        sendBtn.disabled = true;

        try {
            const response = await fetch('/api/user/feedback', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': window.csrfToken || ''
                },
                body: JSON.stringify({
                    kind: kind,
                    message: message,
                    pageUrl: window.location.href
                })
            });

            if (response.ok) {
                clearDraft();
                showSuccess();
            } else {
                let errorMessage = 'Failed to send feedback. Please try again.';
                try {
                    const data = await response.json();
                    console.error('Feedback submission failed:', data);
                    errorMessage = data.error?.message || errorMessage;
                } catch {
                    console.error('Feedback submission failed with status:', response.status);
                }
                // Show error briefly in the hint area
                const hint = document.querySelector('.feedback-panel-hint');
                if (hint) {
                    const originalText = hint.textContent;
                    hint.textContent = errorMessage;
                    hint.style.color = '#f87171';
                    setTimeout(() => {
                        hint.textContent = originalText;
                        hint.style.color = '';
                    }, 3000);
                }
            }
        } catch (error) {
            console.error('Feedback submission error:', error);
            const hint = document.querySelector('.feedback-panel-hint');
            if (hint) {
                const originalText = hint.textContent;
                hint.textContent = 'Network error. Please check your connection and try again.';
                hint.style.color = '#f87171';
                setTimeout(() => {
                    hint.textContent = originalText;
                    hint.style.color = '';
                }, 3000);
            }
        } finally {
            isSubmitting = false;
            updateSendButtonState();
        }
    }

    // Event listeners
    triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent immediate close by document listener
        if (isOpen()) {
            closePanel();
        } else {
            openPanel();
        }
    });

    if (closeBtn) {
        closeBtn.addEventListener('click', closePanel);
    }

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (isOpen() && !panel.contains(e.target) && !triggerBtn.contains(e.target)) {
            closePanel();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;

        // Escape to close
        if (e.key === 'Escape') {
            e.preventDefault();
            closePanel();
            return;
        }

        // Cmd/Ctrl+Enter to send
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && textarea === document.activeElement) {
            e.preventDefault();
            if (!sendBtn.disabled) {
                submitFeedback('feedback');
            }
        }
    });

    // Textarea events
    textarea.addEventListener('input', () => {
        updateCharCount();
        updateSendButtonState();
        saveDraft();
    });

    // Send button
    sendBtn.addEventListener('click', () => {
        submitFeedback('feedback');
    });

    // Love button
    loveBtn.addEventListener('click', () => {
        submitFeedback('love');
    });
}
