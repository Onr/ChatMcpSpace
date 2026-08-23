/**
 * Rich Agent Rendering Module
 * Secure HTML form rendering for E2E encrypted agent messages
 * 
 * Phase 1: Safe HTML with Forms (MVP)
 * - DOMPurify-based sanitization with form tag allowlist
 * - Form submission interception (captures data as chat messages)
 * - External link confirmation modal
 * - Agent content badge and visual boundaries
 * - Expand/collapse UI for rich content
 * - Inline styles support (sanitized)
 * 
 * Security model: ALL validation happens client-side after E2E decryption.
 * Server is blind to message content.
 */

// ============================================================================
// Rich Content Schema & Detection
// ============================================================================

/**
 * Schema for rich content messages.
 * Agents send JSON with { type: "rich_html", html: "...", title?: "...", description?: "..." }
 * This is embedded inside the encrypted message content.
 */
const RICH_CONTENT_SCHEMA = {
  requiredFields: ['type', 'html'],
  validTypes: ['rich_html', 'rich_interactive'],
  maxHtmlLength: 100000,     // 100KB max HTML content
  maxTitleLength: 200,
  maxDescriptionLength: 500
};

/**
 * Detect if decrypted message content is rich HTML content
 * @param {string} content - Decrypted message content
 * @returns {object|null} Parsed rich content object, or null if not rich content
 */
function detectRichContent(content) {
  if (!content || typeof content !== 'string') return null;

  const trimmed = content.trim();

  // Must start with { to be JSON
  if (!trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed);

    // Validate required fields
    if (!parsed.type || !RICH_CONTENT_SCHEMA.validTypes.includes(parsed.type)) return null;
    if (!parsed.html || typeof parsed.html !== 'string') return null;

    // Validate field lengths
    if (parsed.html.length > RICH_CONTENT_SCHEMA.maxHtmlLength) return null;
    if (parsed.title && (typeof parsed.title !== 'string' || parsed.title.length > RICH_CONTENT_SCHEMA.maxTitleLength)) return null;
    if (parsed.description && (typeof parsed.description !== 'string' || parsed.description.length > RICH_CONTENT_SCHEMA.maxDescriptionLength)) return null;

    // Reject agent template stubs (e.g. "__REPLACE_WITH_TITLE__") so they fall
    // back to plain-text rendering. Otherwise the chat shows an "Interactive
    // Content" placeholder hiding raw template tokens behind a popup.
    const TEMPLATE_TOKEN = /_{0,2}REPLACE_WITH_[A-Z0-9_]+_{0,2}/;
    if (TEMPLATE_TOKEN.test(parsed.title || '')) return null;
    if (TEMPLATE_TOKEN.test(parsed.html)) return null;

    return {
      type: parsed.type,
      html: parsed.html,
      css: parsed.css || null,          // Optional embedded CSS (scoped to container)
      title: parsed.title || 'Agent Form',
      description: parsed.description || null,
      badge: parsed.badge || null        // Optional badge label (default: auto-detected)
    };
  } catch (e) {
    return null;
  }
}

// ============================================================================
// DOMPurify Sanitization Configuration
// ============================================================================

/**
 * DOMPurify configuration for rich HTML with form support.
 * Allows form elements while blocking dangerous content.
 * No script, no iframe, no event handlers.
 */
const RICH_HTML_SANITIZE_CONFIG = {
  // Allowed HTML tags - standard HTML + form elements
  ALLOWED_TAGS: [
    // Structure
    'div', 'span', 'p', 'br', 'hr',
    // Headings
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Text formatting
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark',
    'small', 'sub', 'sup', 'abbr', 'code', 'pre', 'kbd', 'var',
    'blockquote', 'cite', 'q',
    // Lists
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    // Links and images
    'a', 'img',
    // Form elements (Phase 1 core feature)
    'form', 'input', 'textarea', 'select', 'option', 'optgroup',
    'button', 'label', 'fieldset', 'legend', 'datalist', 'output',
    'progress', 'meter',
    // Semantic
    'details', 'summary', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
    // Style blocks are not allowed in inline rich HTML.
    // Agent-provided CSS should use the top-level richData.css channel.
  ],

  // Allowed attributes
  ALLOWED_ATTR: [
    // Global attributes
    'class', 'id', 'style', 'title', 'role', 'aria-label', 'aria-describedby',
    'aria-hidden', 'aria-required', 'aria-invalid', 'aria-expanded',
    'data-*',
    // Link attributes
    'href', 'target', 'rel',
    // Image attributes
    'src', 'alt', 'width', 'height', 'loading',
    // Form attributes
    'type', 'name', 'value', 'placeholder', 'required', 'disabled', 'readonly',
    'checked', 'selected', 'multiple', 'min', 'max', 'minlength', 'maxlength',
    'pattern', 'step', 'size', 'rows', 'cols', 'wrap', 'autocomplete',
    'autofocus', 'form', 'formaction', 'list', 'for',
    // Table attributes
    'colspan', 'rowspan', 'scope', 'headers',
    // Media
    'controls',
    // Data-action attributes for interactive buttons (no JS needed)
    'data-send-message', 'data-toggle', 'data-show', 'data-hide',
    'data-toggle-class', 'data-add-class', 'data-remove-class', 'data-target',
    'data-tab', 'data-tab-group', 'data-set-text', 'data-set-html',
    'data-copy', 'data-value', 'data-confirm', 'data-active-class',
    'data-form-title', 'data-dismiss'
  ],

  // Allow data: URIs only for images (not links)
  ALLOW_DATA_ATTR: true,

  // Force all links to open in new tab with noopener
  ADD_ATTR: ['target'],

  // Allow inline styles but sanitize them
  ALLOW_UNKNOWN_PROTOCOLS: false,

  // Forbid dangerous tags explicitly
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'applet', 'base', 'link', 'meta', 'style'],

  // Forbid dangerous attributes explicitly
  FORBID_ATTR: [
    // Event handlers
    'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onmousedown',
    'onmouseup', 'onkeydown', 'onkeyup', 'onkeypress', 'onfocus', 'onblur',
    'onchange', 'onsubmit', 'onreset', 'oninput', 'onselect', 'ondrag',
    'ondrop', 'onabort', 'oncanplay', 'oncuechange', 'ondurationchange',
    'onemptied', 'onended', 'oninvalid', 'onpause', 'onplay', 'onplaying',
    'onprogress', 'onratechange', 'onseeked', 'onseeking', 'onstalled',
    'onsuspend', 'ontimeupdate', 'onvolumechange', 'onwaiting',
    // Dangerous form attributes
    'action', 'method', 'enctype', 'formmethod', 'formenctype', 'formtarget',
    // XSS vectors
    'srcdoc', 'sandbox', 'allow', 'allowfullscreen'
  ]
};

/**
 * CSS property allowlist for inline styles
 * Only safe visual properties are allowed
 */
const ALLOWED_CSS_PROPERTIES = new Set([
  // Layout
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'justify-content', 'align-items', 'align-self', 'align-content',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'gap', 'grid-gap',
  'order', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
  // Box model
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-sizing',
  // Typography
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
  'text-transform', 'text-indent', 'text-overflow', 'white-space', 'word-break', 'word-wrap',
  'overflow-wrap',
  // Visual
  'color', 'background', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',
  'box-shadow', 'opacity', 'visibility',
  // Position (limited)
  'position', 'top', 'right', 'bottom', 'left', 'z-index',
  // Transform (safe ones)
  'transform', 'transition', 'animation',
  // Cursor
  'cursor', 'pointer-events',
  // List
  'list-style', 'list-style-type', 'list-style-position',
  // Table
  'border-collapse', 'border-spacing', 'table-layout', 'vertical-align',
  // Misc
  'resize', 'appearance', 'user-select'
]);

/**
 * Sanitize inline CSS styles - remove dangerous properties
 * @param {string} styleString - CSS style string
 * @returns {string} Sanitized CSS style string
 */
function sanitizeInlineStyles(styleString) {
  if (!styleString || typeof styleString !== 'string') return '';

  // Block url() values that could load external resources (except safe gradients)
  // Block expression(), behavior(), and -moz-binding
  const dangerousPatterns = [
    /expression\s*\(/gi,
    /behavior\s*:/gi,
    /-moz-binding\s*:/gi,
    /javascript\s*:/gi,
    /vbscript\s*:/gi,
  ];

  let clean = styleString;
  for (const pattern of dangerousPatterns) {
    if (pattern.test(clean)) return '';
  }

  // Parse and filter individual properties
  const properties = clean.split(';').filter(Boolean);
  const safeProperties = [];

  for (const prop of properties) {
    const colonIndex = prop.indexOf(':');
    if (colonIndex === -1) continue;

    const name = prop.substring(0, colonIndex).trim().toLowerCase();
    let value = prop.substring(colonIndex + 1).trim();

    // Check if property is allowed
    if (!ALLOWED_CSS_PROPERTIES.has(name)) continue;

    // Block url() in values except for safe gradients
    if (/url\s*\(/i.test(value) && !/^(linear|radial|conic)-gradient/i.test(value)) continue;

    safeProperties.push(`${name}: ${value}`);
  }

  return safeProperties.join('; ');
}

/**
 * Sanitize rich HTML content using DOMPurify with form allowlist
 * @param {string} html - Raw HTML content from agent
 * @returns {string} Sanitized HTML safe for rendering
 */
function sanitizeRichHtml(html) {
  if (!html || typeof html !== 'string') return '';
  if (typeof DOMPurify === 'undefined') {
    console.error('DOMPurify not loaded - cannot render rich content safely');
    return '<p class="text-red-400">⚠️ Cannot render rich content: security library not loaded.</p>';
  }

  // Set up DOMPurify hook to sanitize inline styles
  const hookId = DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style') {
      data.attrValue = sanitizeInlineStyles(data.attrValue);
    }
  });

  // Sanitize <style> tag contents (scope CSS and block dangerous patterns)
  const styleHookId = DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = sanitizeStyleTagContent(node.textContent);
    }
  });

  // Set up hook to force safe link attributes
  const linkHookId = DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Force all links to have safe attributes
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      // Mark external links for interception
      node.classList.add('rich-content-link');
    }
    // Remove form action/method to prevent actual submission
    if (node.tagName === 'FORM') {
      node.removeAttribute('action');
      node.removeAttribute('method');
      node.removeAttribute('enctype');
      node.classList.add('rich-content-form');
    }
    // Ensure images don't load from untrusted sources
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      // Only allow data: URIs and relative paths for images
      if (src && !src.startsWith('data:') && !src.startsWith('/')) {
        node.removeAttribute('src');
        node.setAttribute('alt', '[External image blocked]');
      }
    }
  });

  const sanitized = DOMPurify.sanitize(html, RICH_HTML_SANITIZE_CONFIG);

  // Remove hooks after use to avoid affecting other DOMPurify calls
  DOMPurify.removeHook('uponSanitizeAttribute');
  DOMPurify.removeHook('uponSanitizeElement');
  DOMPurify.removeHook('afterSanitizeAttributes');

  return sanitized;
}

// ============================================================================
// Form Submission Interception
// ============================================================================

/**
 * Intercept form submissions within rich content and convert to chat messages.
 * Forms never actually POST - data is captured and sent as a user message.
 * 
 * @param {HTMLElement} container - The container with rendered rich content
 * @param {Function} sendMessageCallback - Function to send message: (text) => Promise<void>
 */
function interceptFormSubmissions(container, sendMessageCallback) {
  if (!container) return;

  const forms = container.querySelectorAll('form.rich-content-form');

  forms.forEach(form => {
    // Prevent default form submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const formData = collectFormData(form);
      if (!formData) return;

      // Convert form data to readable message text
      const messageText = formatFormDataAsMessage(formData, form);

      // Visual feedback
      const submitBtn = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
      if (submitBtn) {
        const originalText = submitBtn.textContent || submitBtn.value;
        submitBtn.disabled = true;
        if (submitBtn.tagName === 'INPUT') {
          submitBtn.value = 'Sending...';
        } else {
          submitBtn.textContent = 'Sending...';
        }

        try {
          await sendMessageCallback(messageText);
          // Success feedback
          if (submitBtn.tagName === 'INPUT') {
            submitBtn.value = '✓ Sent';
          } else {
            submitBtn.textContent = '✓ Sent';
          }
          submitBtn.classList.add('rich-form-submitted');

          // Disable entire form after successful submission
          disableForm(form);
        } catch (error) {
          console.error('Failed to send form response:', error);
          submitBtn.disabled = false;
          if (submitBtn.tagName === 'INPUT') {
            submitBtn.value = originalText;
          } else {
            submitBtn.textContent = originalText;
          }
        }
      } else {
        // No submit button - just send
        try {
          await sendMessageCallback(messageText);
          disableForm(form);
        } catch (error) {
          console.error('Failed to send form response:', error);
        }
      }
    });

    // Non-submit, non-reset buttons inside forms: only prevent default form submission
    // but allow data-action handlers to work (handled by interceptDataActions)
    form.querySelectorAll('button').forEach(btn => {
      if (btn.type === 'reset' || btn.type === 'submit') return;
      // Buttons with data-actions are handled by interceptDataActions - don't block them
      const hasDataAction = btn.hasAttribute('data-send-message') ||
        btn.hasAttribute('data-toggle') || btn.hasAttribute('data-show') ||
        btn.hasAttribute('data-hide') || btn.hasAttribute('data-toggle-class') ||
        btn.hasAttribute('data-tab') || btn.hasAttribute('data-copy') ||
        btn.hasAttribute('data-set-text') || btn.hasAttribute('data-dismiss') ||
        btn.hasAttribute('data-add-class') || btn.hasAttribute('data-remove-class');
      if (!hasDataAction) {
        // Only prevent default for plain buttons without data-actions
        btn.addEventListener('click', (e) => {
          e.preventDefault();
        });
      }
    });
  });
}

/**
 * Collect form data from a form element
 * @param {HTMLFormElement} form 
 * @returns {object|null} Form data as key-value pairs
 */
function collectFormData(form) {
  const data = {};
  const formData = new FormData(form);
  let hasData = false;

  for (const [key, value] of formData.entries()) {
    // Sanitize keys and values
    const cleanKey = String(key).trim().substring(0, 200);
    const cleanValue = String(value).trim().substring(0, 5000);

    if (cleanKey) {
      // Handle multiple values for same key (checkboxes, multi-select)
      if (data[cleanKey] !== undefined) {
        if (Array.isArray(data[cleanKey])) {
          data[cleanKey].push(cleanValue);
        } else {
          data[cleanKey] = [data[cleanKey], cleanValue];
        }
      } else {
        data[cleanKey] = cleanValue;
      }
      hasData = true;
    }
  }

  return hasData ? data : null;
}

/**
 * Format form data as a human-readable message
 * @param {object} data - Form data key-value pairs
 * @param {HTMLFormElement} form - The form element (for title extraction)
 * @returns {string} Formatted message text
 */
function formatFormDataAsMessage(data, form) {
  const formTitle = form.getAttribute('data-form-title') ||
    form.querySelector('legend')?.textContent?.trim() ||
    form.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() ||
    'Form Response';

  let message = `📋 **${formTitle}**\n\n`;

  for (const [key, value] of Object.entries(data)) {
    const displayKey = key.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (Array.isArray(value)) {
      message += `**${displayKey}:** ${value.join(', ')}\n`;
    } else {
      message += `**${displayKey}:** ${value}\n`;
    }
  }

  return message.trim();
}

/**
 * Disable all inputs in a form after successful submission
 * @param {HTMLFormElement} form 
 */
function disableForm(form) {
  const inputs = form.querySelectorAll('input, textarea, select, button');
  inputs.forEach(input => {
    input.disabled = true;
  });
  form.classList.add('rich-form-disabled');
}

// ============================================================================
// External Link Handling
// ============================================================================

/**
 * Intercept external link clicks in rich content and show confirmation modal
 * @param {HTMLElement} container - The container with rendered rich content
 */
function interceptExternalLinks(container) {
  if (!container) return;

  container.addEventListener('click', (e) => {
    const link = e.target.closest('a.rich-content-link');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Allow anchor links
    if (href.startsWith('#')) return;

    // Allow relative links
    if (href.startsWith('/') && !href.startsWith('//')) return;

    // External link - show confirmation
    e.preventDefault();
    e.stopPropagation();
    showExternalLinkModal(href);
  });
}

/**
 * Show confirmation modal for external links
 * @param {string} url - The external URL
 */
function showExternalLinkModal(url) {
  // Remove existing modal if any
  const existing = document.getElementById('richExternalLinkModal');
  if (existing) existing.remove();

  // Sanitize URL for display
  let displayUrl;
  try {
    const parsed = new URL(url);
    displayUrl = parsed.hostname + parsed.pathname;
    if (displayUrl.length > 60) {
      displayUrl = displayUrl.substring(0, 57) + '...';
    }
  } catch {
    displayUrl = url.substring(0, 60);
  }

  const modal = document.createElement('div');
  modal.id = 'richExternalLinkModal';
  modal.className = 'rich-link-modal-overlay';
  modal.innerHTML = `
    <div class="rich-link-modal">
      <div class="rich-link-modal-header">
        <div class="rich-link-modal-icon">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </div>
        <div>
          <h3 class="text-lg font-semibold text-white">External Link</h3>
          <p class="text-xs text-slate-400">This link was sent by an agent</p>
        </div>
      </div>
      <div class="rich-link-modal-body">
        <div class="rich-link-modal-warning">
          <p class="text-xs text-amber-300 leading-relaxed">
            <span class="font-semibold">⚠️ Caution:</span> You are about to leave this page and visit an external website. 
            Only proceed if you trust this agent and the destination.
          </p>
        </div>
        <div class="rich-link-modal-url">
          <span class="text-xs text-slate-400">Destination:</span>
          <code class="text-sm text-cyan-300 break-all">${escapeHtml(displayUrl)}</code>
        </div>
      </div>
      <div class="rich-link-modal-footer">
        <button type="button" class="rich-link-cancel-btn">Cancel</button>
        <button type="button" class="rich-link-proceed-btn">Open Link</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Event handlers
  const cancelBtn = modal.querySelector('.rich-link-cancel-btn');
  const proceedBtn = modal.querySelector('.rich-link-proceed-btn');

  const closeModal = () => modal.remove();

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  proceedBtn.addEventListener('click', () => {
    window.open(url, '_blank', 'noopener,noreferrer');
    closeModal();
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

// ============================================================================
// Rich Content Popup Viewer
// ============================================================================

let activeInteractiveContentPopup = null;

function closeInteractiveContentPopup() {
  const state = activeInteractiveContentPopup;
  if (!state) return false;

  const {
    overlay,
    popupBody,
    sourceContentEl,
    escHandler,
    onStateChange
  } = state;

  if (popupBody && sourceContentEl && sourceContentEl.isConnected) {
    const fragment = document.createDocumentFragment();
    while (popupBody.firstChild) {
      fragment.appendChild(popupBody.firstChild);
    }
    sourceContentEl.appendChild(fragment);
    sourceContentEl.scrollTop = state.scrollTop || 0;
  }

  if (overlay) overlay.remove();
  document.body.classList.remove('rich-popup-open');
  if (escHandler) document.removeEventListener('keydown', escHandler);
  if (typeof onStateChange === 'function') onStateChange(false);

  activeInteractiveContentPopup = null;
  return true;
}

function closeInteractiveContentPopupFor(sourceContentEl) {
  if (!activeInteractiveContentPopup || activeInteractiveContentPopup.sourceContentEl !== sourceContentEl) {
    return false;
  }
  return closeInteractiveContentPopup();
}

function isInteractiveContentPopupOpenFor(sourceContentEl) {
  return Boolean(activeInteractiveContentPopup && activeInteractiveContentPopup.sourceContentEl === sourceContentEl);
}

function openInteractiveContentPopup({ sourceContentEl, title = 'Interactive Content', onStateChange } = {}) {
  if (!(sourceContentEl instanceof HTMLElement)) return false;

  // Single active popup at a time.
  closeInteractiveContentPopup();

  const overlay = document.createElement('div');
  overlay.className = 'rich-content-popup-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title || 'Interactive Content');
  overlay.innerHTML = `
    <div class="rich-content-popup-panel">
      <div class="rich-content-popup-header">
        <div class="rich-content-popup-title-wrap">
          <span class="rich-content-popup-kicker">Interactive View</span>
          <h3 class="rich-content-popup-title">${escapeHtml(title || 'Interactive Content')}</h3>
        </div>
        <button type="button" class="rich-content-popup-close-btn" aria-label="Close expanded view">Close</button>
      </div>
      <div class="rich-content-popup-body"></div>
    </div>
  `;

  const popupPanel = overlay.querySelector('.rich-content-popup-panel');
  const popupBody = overlay.querySelector('.rich-content-popup-body');
  const closeBtn = overlay.querySelector('.rich-content-popup-close-btn');
  if (!popupPanel || !popupBody || !closeBtn) return false;

  const scrollTop = sourceContentEl.scrollTop || 0;
  const fragment = document.createDocumentFragment();
  while (sourceContentEl.firstChild) {
    fragment.appendChild(sourceContentEl.firstChild);
  }
  popupBody.appendChild(fragment);
  popupBody.scrollTop = scrollTop;

  const escHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeInteractiveContentPopup();
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeInteractiveContentPopup();
  });
  closeBtn.addEventListener('click', () => closeInteractiveContentPopup());

  document.body.appendChild(overlay);
  document.body.classList.add('rich-popup-open');
  document.addEventListener('keydown', escHandler);

  activeInteractiveContentPopup = {
    overlay,
    popupBody,
    sourceContentEl,
    escHandler,
    scrollTop,
    onStateChange
  };

  if (typeof onStateChange === 'function') onStateChange(true);
  return true;
}

function toggleInteractiveContentPopup({ sourceContentEl, title = 'Interactive Content', onStateChange } = {}) {
  if (isInteractiveContentPopupOpenFor(sourceContentEl)) {
    closeInteractiveContentPopup();
    return false;
  }
  return openInteractiveContentPopup({ sourceContentEl, title, onStateChange });
}

// ============================================================================
// Rich Content UI Component
// ============================================================================

/**
 * Create the rich content container with agent badge and scoped content.
 * Visibility is controlled by the surrounding Agent Space panel so rich messages
 * have one fold/unfold path across main chat and side chats.
 * @param {object} richData - Parsed rich content data
 * @returns {HTMLElement} The rich content container element
 */
function createRichContentElement(richData) {
  const container = document.createElement('div');
  container.className = 'rich-content-wrapper';

  // Agent content badge - auto-detect label from content
  const badgeLabel = richData.badge || detectBadgeLabel(richData);
  const badge = document.createElement('div');
  badge.className = 'rich-content-badge';
  badge.innerHTML = `
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
    <span>${escapeHtml(badgeLabel)}</span>
  `;

  // Title and description
  const header = document.createElement('div');
  header.className = 'rich-content-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'rich-content-title-row';

  const title = document.createElement('h4');
  title.className = 'rich-content-title';
  title.textContent = richData.title;

  titleRow.appendChild(title);
  header.appendChild(titleRow);

  if (richData.description) {
    const desc = document.createElement('p');
    desc.className = 'rich-content-description';
    desc.textContent = richData.description;
    header.appendChild(desc);
  }

  // Rich HTML content area
  const contentArea = document.createElement('div');
  contentArea.className = 'rich-content-body';

  // Inject scoped CSS if provided
  if (richData.css && typeof richData.css === 'string') {
    const scopedCss = sanitizeStyleTagContent(richData.css);
    if (scopedCss) {
      const styleEl = document.createElement('style');
      styleEl.textContent = scopedCss;
      contentArea.appendChild(styleEl);
    }
  }

  // Sanitize and inject HTML
  const sanitizedHtml = sanitizeRichHtml(richData.html);
  contentArea.innerHTML += sanitizedHtml;

  // Assemble
  container.appendChild(badge);
  container.appendChild(header);
  container.appendChild(contentArea);

  return container;
}

/**
 * Render rich HTML content into a message bubble.
 * This is the main entry point called from createMessageElement().
 * 
 * @param {object} richData - Parsed rich content data from detectRichContent()
 * @param {Function} sendMessageCallback - Function to send form responses as chat messages
 * @returns {HTMLElement} Complete rich content element with all interception handlers
 */
function renderRichContent(richData, sendMessageCallback) {
  const element = createRichContentElement(richData);

  // Set up data-attribute based interactive actions (toggle, show, hide, tabs, etc.)
  interceptDataActions(element, sendMessageCallback);

  // Set up form submission interception
  interceptFormSubmissions(element, sendMessageCallback);

  // Set up external link interception
  interceptExternalLinks(element);

  return element;
}

// ============================================================================
// Style Tag Sanitization
// ============================================================================

/**
 * Sanitize CSS inside <style> tags.
 * Blocks @import, @charset, url() to external resources, expression(), behavior().
 * Scopes all selectors under .rich-content-body to prevent style leaks.
 */
function sanitizeStyleTagContent(cssText) {
  if (!cssText || typeof cssText !== 'string') return '';

  // Block dangerous at-rules
  let clean = cssText
    .replace(/@import\b[^;]*;?/gi, '/* @import blocked */')
    .replace(/@charset\b[^;]*;?/gi, '/* @charset blocked */')
    .replace(/@namespace\b[^;]*;?/gi, '/* @namespace blocked */');

  // Block expression(), behavior(), -moz-binding
  clean = clean
    .replace(/expression\s*\(/gi, '/* expression blocked */ (')
    .replace(/behavior\s*:/gi, '/* behavior blocked */ _:')
    .replace(/-moz-binding\s*:/gi, '/* moz-binding blocked */ _:')
    .replace(/javascript\s*:/gi, '/* js blocked */ _:')
    .replace(/vbscript\s*:/gi, '/* vbs blocked */ _:');

  // Block url() that loads external resources (allow data: and gradients)
  clean = clean.replace(/url\s*\(\s*['"]?(?!data:)([^)]+?)['"]?\s*\)/gi, (match, url) => {
    // Allow data: URIs and relative paths starting with /
    if (url.trim().startsWith('data:') || url.trim().startsWith('/')) return match;
    return '/* external url blocked */';
  });

  // Scope all selectors under .rich-content-body to prevent style leaks
  // Parse CSS rules and prefix selectors
  try {
    const scopePrefix = '.rich-content-body';
    // Handle @keyframes and @media specially
    clean = clean.replace(/([^{}]+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, selector, body) => {
      const trimmedSelector = selector.trim();
      // Don't scope @keyframes, @media, etc.
      if (trimmedSelector.startsWith('@keyframes') || trimmedSelector.startsWith('@media') ||
          trimmedSelector.startsWith('@supports') || trimmedSelector.startsWith('@font-face')) {
        return match;
      }
      // Scope each selector in the comma-separated list
      const scopedSelectors = trimmedSelector.split(',').map(sel => {
        sel = sel.trim();
        if (!sel) return sel;
        // Don't double-scope
        if (sel.includes(scopePrefix)) return sel;
        // Scope it
        return `${scopePrefix} ${sel}`;
      }).join(', ');
      return `${scopedSelectors} {${body}}`;
    });
  } catch (e) {
    // If scoping fails, return the cleaned but unscoped CSS
    console.warn('CSS scoping failed, using unscoped:', e);
  }

  // Length limit
  if (clean.length > 50000) {
    clean = clean.substring(0, 50000);
  }

  return clean;
}

/**
 * Detect appropriate badge label based on content
 */
function detectBadgeLabel(richData) {
  const html = (richData.html || '').toLowerCase();
  if (html.includes('<form')) return 'Interactive Form';
  if (html.includes('data-tab-group') || html.includes('data-tab=')) return 'Interactive Content';
  if (html.includes('data-send-message')) return 'Agent Actions';
  if (html.includes('<table')) return 'Agent Table';
  if (html.includes('<img')) return 'Agent Media';
  if (html.includes('data-toggle') || html.includes('data-show') || html.includes('data-hide')) return 'Interactive Content';
  return 'Interactive Form';
}

/**
 * Simple HTML escape for safe string insertion
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================================
// Data-Attribute Action System
// ============================================================================

/**
 * Intercept clicks on elements with data-action attributes within rich content.
 * This provides interactive behavior WITHOUT requiring JavaScript event handlers
 * (which are stripped by DOMPurify).
 *
 * Supported data attributes:
 *   data-send-message="text"    - Send a chat message with the given text
 *   data-toggle="targetId"      - Toggle visibility of element with that ID
 *   data-show="targetId"        - Show element with that ID
 *   data-hide="targetId"        - Hide element with that ID
 *   data-toggle-class="cls"     - Toggle a CSS class (use with data-target)
 *   data-add-class="cls"        - Add a CSS class (use with data-target)
 *   data-remove-class="cls"     - Remove a CSS class (use with data-target)
 *   data-target="targetId"      - Target element for class operations
 *   data-tab="panelId"          - Show this tab panel, hide others in same group
 *   data-tab-group="groupName"  - Tab group identifier
 *   data-set-text="targetId"    - Set text content of target (use with data-value)
 *   data-value="text"           - Value to set
 *   data-copy="text"            - Copy text to clipboard
 *   data-dismiss="targetId"     - Remove element from DOM
 *   data-confirm="message"      - Show confirmation before action
 *   data-active-class="cls"     - Class to toggle on the clicked element itself
 *
 * @param {HTMLElement} container - Rich content container
 * @param {Function} sendMessageCallback - Function to send chat messages
 */
function interceptDataActions(container, sendMessageCallback) {
  if (!container) return;

  // Use event delegation on the container
  container.addEventListener('click', async (e) => {
    // Find the closest actionable element (button, a, or any element with data-actions)
    const actionEl = e.target.closest('[data-send-message], [data-toggle], [data-show], [data-hide], [data-toggle-class], [data-add-class], [data-remove-class], [data-tab], [data-set-text], [data-copy], [data-dismiss]');
    if (!actionEl) return;

    // Don't interfere with form submit buttons or links with href
    if (actionEl.tagName === 'A' && actionEl.hasAttribute('href') && !actionEl.hasAttribute('data-send-message')) return;

    e.preventDefault();
    e.stopPropagation();

    // Confirmation check
    const confirmMsg = actionEl.getAttribute('data-confirm');
    if (confirmMsg && !confirm(confirmMsg)) return;

    // Resolve target elements within this container only (security: no escaping the container)
    const resolveTarget = (id) => id ? container.querySelector(`#${CSS.escape(id)}`) : null;

    // --- data-send-message: Send a chat message ---
    if (actionEl.hasAttribute('data-send-message')) {
      const msgText = actionEl.getAttribute('data-send-message');
      if (msgText && sendMessageCallback) {
        // Visual feedback
        const origText = actionEl.textContent;
        actionEl.disabled = true;
        actionEl.textContent = 'Sending...';
        actionEl.classList.add('rich-action-sending');
        try {
          await sendMessageCallback(msgText);
          actionEl.textContent = '✓ Sent';
          actionEl.classList.remove('rich-action-sending');
          actionEl.classList.add('rich-action-sent');
          // Keep disabled after send
        } catch (err) {
          console.error('data-send-message failed:', err);
          actionEl.textContent = origText;
          actionEl.disabled = false;
          actionEl.classList.remove('rich-action-sending');
        }
      }
    }

    // --- data-toggle: Toggle visibility ---
    if (actionEl.hasAttribute('data-toggle')) {
      const targetId = actionEl.getAttribute('data-toggle');
      const target = resolveTarget(targetId);
      if (target) {
        const isHidden = target.classList.contains('rich-hidden');
        target.classList.toggle('rich-hidden');
        target.classList.toggle('rich-visible', isHidden);
        actionEl.setAttribute('aria-expanded', String(isHidden));
      }
    }

    // --- data-show: Show element ---
    if (actionEl.hasAttribute('data-show')) {
      const targetId = actionEl.getAttribute('data-show');
      const target = resolveTarget(targetId);
      if (target) {
        target.classList.remove('rich-hidden');
        target.classList.add('rich-visible');
      }
    }

    // --- data-hide: Hide element ---
    if (actionEl.hasAttribute('data-hide')) {
      const targetId = actionEl.getAttribute('data-hide');
      const target = resolveTarget(targetId);
      if (target) {
        target.classList.add('rich-hidden');
        target.classList.remove('rich-visible');
      }
    }

    // --- data-toggle-class: Toggle CSS class on target ---
    if (actionEl.hasAttribute('data-toggle-class')) {
      const className = actionEl.getAttribute('data-toggle-class');
      const targetId = actionEl.getAttribute('data-target');
      const target = targetId ? resolveTarget(targetId) : actionEl;
      if (target && className) {
        className.split(/\s+/).forEach(cls => target.classList.toggle(cls));
      }
    }

    // --- data-add-class: Add CSS class to target ---
    if (actionEl.hasAttribute('data-add-class')) {
      const className = actionEl.getAttribute('data-add-class');
      const targetId = actionEl.getAttribute('data-target');
      const target = targetId ? resolveTarget(targetId) : actionEl;
      if (target && className) {
        className.split(/\s+/).forEach(cls => target.classList.add(cls));
      }
    }

    // --- data-remove-class: Remove CSS class from target ---
    if (actionEl.hasAttribute('data-remove-class')) {
      const className = actionEl.getAttribute('data-remove-class');
      const targetId = actionEl.getAttribute('data-target');
      const target = targetId ? resolveTarget(targetId) : actionEl;
      if (target && className) {
        className.split(/\s+/).forEach(cls => target.classList.remove(cls));
      }
    }

    // --- data-tab: Tab switching ---
    if (actionEl.hasAttribute('data-tab')) {
      const panelId = actionEl.getAttribute('data-tab');
      const groupName = actionEl.getAttribute('data-tab-group');

      if (groupName) {
        // Deactivate all tabs in the same group
        const groupTabs = container.querySelectorAll(`[data-tab-group="${CSS.escape(groupName)}"]`);
        groupTabs.forEach(tab => {
          tab.classList.remove('rich-tab-active');
          tab.setAttribute('aria-selected', 'false');
          // Hide the panel this tab points to
          const tabPanelId = tab.getAttribute('data-tab');
          const tabPanel = resolveTarget(tabPanelId);
          if (tabPanel) {
            tabPanel.classList.add('rich-hidden');
            tabPanel.classList.remove('rich-visible');
          }
        });
      }

      // Activate clicked tab
      actionEl.classList.add('rich-tab-active');
      actionEl.setAttribute('aria-selected', 'true');

      // Show the target panel
      const panel = resolveTarget(panelId);
      if (panel) {
        panel.classList.remove('rich-hidden');
        panel.classList.add('rich-visible');
      }
    }

    // --- data-set-text: Set text content of target ---
    if (actionEl.hasAttribute('data-set-text')) {
      const targetId = actionEl.getAttribute('data-set-text');
      const value = actionEl.getAttribute('data-value') || '';
      const target = resolveTarget(targetId);
      if (target) {
        target.textContent = value;
      }
    }

    // --- data-copy: Copy text to clipboard ---
    if (actionEl.hasAttribute('data-copy')) {
      const textToCopy = actionEl.getAttribute('data-copy');
      if (textToCopy) {
        try {
          await navigator.clipboard.writeText(textToCopy);
          const origText = actionEl.textContent;
          actionEl.textContent = '✓ Copied';
          actionEl.classList.add('rich-action-copied');
          setTimeout(() => {
            actionEl.textContent = origText;
            actionEl.classList.remove('rich-action-copied');
          }, 2000);
        } catch (err) {
          console.error('Copy to clipboard failed:', err);
        }
      }
    }

    // --- data-dismiss: Remove element from DOM ---
    if (actionEl.hasAttribute('data-dismiss')) {
      const targetId = actionEl.getAttribute('data-dismiss');
      if (targetId === 'self') {
        actionEl.remove();
      } else {
        const target = resolveTarget(targetId);
        if (target) target.remove();
      }
    }

    // --- data-active-class: Toggle class on the clicked element itself ---
    if (actionEl.hasAttribute('data-active-class')) {
      const activeClass = actionEl.getAttribute('data-active-class');
      if (activeClass) {
        activeClass.split(/\s+/).forEach(cls => actionEl.classList.toggle(cls));
      }
    }
  });
}

// ============================================================================
// Integration Helper
// ============================================================================

/**
 * Helper to send a form response as a user message.
 * Integrates with the existing sendUserMessage flow.
 * 
 * @param {string} messageText - The formatted form response text
 * @returns {Promise<void>}
 */
async function sendFormResponse(messageText) {
  if (!selectedAgentId) {
    throw new Error('No agent selected');
  }

  // Encrypt if key is available
  let contentToSend = messageText;
  let isEncrypted = false;

  if (encryptionKey) {
    try {
      contentToSend = await window.E2EEncryption.encryptMessage(messageText, encryptionKey);
      isEncrypted = true;
    } catch (encryptError) {
      console.error('Failed to encrypt form response:', encryptError);
      throw new Error('Failed to encrypt form response');
    }
  }

  const fetchWithCsrf = typeof csrfFetch === 'function' ? csrfFetch : fetch;
  const response = await fetchWithCsrf('/api/user/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': window.csrfToken
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      agentId: selectedAgentId,
      content: contentToSend,
      encrypted: isEncrypted
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || 'Failed to send form response');
  }

  // Mark agent as pending response
  pendingResponseAgents.add(selectedAgentId);
  if (agentListCache.agents.length > 0) {
    updateAgentListUI(agentListCache.agents);
  }

  // Refresh messages to show the sent response
  lastMessageTimestamp = null;
  lastMessageCursor = null;
  conversationCache.delete(selectedAgentId);
  agentScrollPositions.delete(selectedAgentId);
  await loadMessages(selectedAgentId);
}

// ============================================================================
// Export to global scope
// ============================================================================

window.RichRendering = {
  detectRichContent,
  sanitizeRichHtml,
  renderRichContent,
  sendFormResponse,
  interceptFormSubmissions,
  interceptExternalLinks,
  interceptDataActions,
  createRichContentElement,
  collectFormData,
  formatFormDataAsMessage,
  sanitizeInlineStyles,
  sanitizeStyleTagContent,
  detectBadgeLabel,
  escapeHtml,
  openInteractiveContentPopup,
  closeInteractiveContentPopup,
  closeInteractiveContentPopupFor,
  toggleInteractiveContentPopup,
  isInteractiveContentPopupOpenFor,
  // Exposed for testing
  RICH_CONTENT_SCHEMA,
  RICH_HTML_SANITIZE_CONFIG,
  ALLOWED_CSS_PROPERTIES
};
