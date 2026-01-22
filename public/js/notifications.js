/**
 * Centralized Notification System
 * Replaces scattered toast/alert implementations with a unified, themed design.
 */
class NotificationSystem {
    constructor() {
        this.container = null;
        this.queue = [];
        this.isProcessing = false;
        this.init();
    }

    init() {
        // Create container if it doesn't exist
        if (!document.getElementById('toast-container')) {
            this.container = document.createElement('div');
            this.container.id = 'toast-container';
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        } else {
            this.container = document.getElementById('toast-container');
        }

        // Expose globally
        window.showNotification = this.show.bind(this);
        window.showError = this.error.bind(this);
        window.showSuccess = this.success.bind(this);
        window.showWarning = this.warning.bind(this);
        window.showInfo = this.info.bind(this);
    }

    /**
     * Show a notification
     * @param {string} message - The message body
     * @param {string} type - 'success', 'error', 'warning', 'info'
     * @param {string} title - Optional title (defaults based on type)
     * @param {number} duration - Duration in ms (default 4000)
     * @param {object} actions - Optional actions { label: 'Undo', onClick: () => {} }
     */
    show(message, type = 'info', title = null, duration = 4000, actions = null) {
        const toast = this.createToastElement(message, type, title, actions);
        this.container.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto remove
        if (duration > 0) {
            setTimeout(() => {
                this.dismiss(toast);
            }, duration);
        }

        return toast;
    }

    success(message, title = 'Success', duration = 4000) {
        return this.show(message, 'success', title, duration);
    }

    error(message, title = 'Error', duration = 5000) {
        return this.show(message, 'error', title, duration);
    }

    warning(message, title = 'Warning', duration = 5000) {
        return this.show(message, 'warning', title, duration);
    }

    info(message, title = 'Info', duration = 4000) {
        return this.show(message, 'info', title, duration);
    }

    dismiss(toast) {
        if (!toast || toast.classList.contains('hiding')) return;
        toast.classList.remove('show');
        toast.classList.add('hiding');

        const cleanup = () => {
            if (toast.parentElement) {
                toast.remove();
            }
        };

        toast.addEventListener('transitionend', cleanup, { once: true });
        // Fallback if no transition defined
        setTimeout(cleanup, 300);
    }

    createToastElement(message, type, title, actions) {
        const el = document.createElement('div');
        el.className = `toast-notification toast-${type}`;
        
        // Icon based on type
        let iconSvg = '';
        switch(type) {
            case 'success':
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
                break;
            case 'error':
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />';
                break;
            case 'warning':
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />';
                break;
            default: // info
                iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
        }

        // Create icon container using DOM methods
        const iconDiv = document.createElement('div');
        iconDiv.className = 'toast-icon';
        const iconSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        iconSvgEl.setAttribute('class', 'w-6 h-6');
        iconSvgEl.setAttribute('fill', 'none');
        iconSvgEl.setAttribute('stroke', 'currentColor');
        iconSvgEl.setAttribute('viewBox', '0 0 24 24');
        iconSvgEl.innerHTML = iconSvg; // Safe: iconSvg is hardcoded, not user input
        iconDiv.appendChild(iconSvgEl);

        // Create content container using DOM methods
        const contentDiv = document.createElement('div');
        contentDiv.className = 'toast-content';

        // Title - use textContent to prevent XSS
        if (title) {
            const titleSpan = document.createElement('span');
            titleSpan.className = 'toast-title';
            titleSpan.textContent = title; // Safe: textContent escapes HTML
            contentDiv.appendChild(titleSpan);
        }

        // Message - use textContent to prevent XSS
        const messageP = document.createElement('p');
        messageP.className = 'toast-message';
        messageP.textContent = message; // Safe: textContent escapes HTML
        contentDiv.appendChild(messageP);

        // Actions - use textContent for label to prevent XSS
        let actionBtn = null;
        if (actions) {
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'toast-actions';
            actionBtn = document.createElement('button');
            actionBtn.className = 'toast-action-btn';
            actionBtn.textContent = actions.label; // Safe: textContent escapes HTML
            actionsDiv.appendChild(actionBtn);
            contentDiv.appendChild(actionsDiv);
        }

        // Create close button using DOM methods
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Close');
        const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        closeSvg.setAttribute('class', 'w-4 h-4');
        closeSvg.setAttribute('fill', 'none');
        closeSvg.setAttribute('stroke', 'currentColor');
        closeSvg.setAttribute('viewBox', '0 0 24 24');
        closeSvg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />'; // Safe: hardcoded SVG
        closeBtn.appendChild(closeSvg);

        // Assemble the toast element
        el.appendChild(iconDiv);
        el.appendChild(contentDiv);
        el.appendChild(closeBtn);

        // Event listeners
        closeBtn.onclick = () => this.dismiss(el);

        if (actions && actionBtn) {
            actionBtn.onclick = () => {
                if (typeof actions.onClick === 'function') {
                    actions.onClick();
                }
                this.dismiss(el);
            };
        }

        return el;
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    window.notifications = new NotificationSystem();
});
