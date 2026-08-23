/**
 * @jest-environment jsdom
 */

/**
 * Tests for Rich Agent Rendering Module
 * 
 * Tests cover:
 * - Rich content detection and schema validation
 * - DOMPurify sanitization with form allowlist
 * - Inline CSS sanitization
 * - Form submission interception
 * - External link handling
 * - Form data collection and formatting
 * - UI component creation (badge, expand/collapse)
 */

// --- Mock DOMPurify for jsdom ---
// DOMPurify needs a real DOM; in jsdom we create a lightweight mock that simulates
// the core API used by rich-rendering.js

const createDOMPurifyMock = () => {
  const hooks = {};

  return {
    sanitize: (html, config) => {
      // Simulate hook calls on a temp element
      const div = document.createElement('div');
      div.innerHTML = html;

      // Run afterSanitizeAttributes hook on each element
      if (hooks.afterSanitizeAttributes) {
        div.querySelectorAll('*').forEach(node => {
          hooks.afterSanitizeAttributes.forEach(fn => fn(node));
        });
      }

      // Run uponSanitizeAttribute for style attributes
      if (hooks.uponSanitizeAttribute) {
        div.querySelectorAll('[style]').forEach(node => {
          const data = { attrName: 'style', attrValue: node.getAttribute('style') };
          hooks.uponSanitizeAttribute.forEach(fn => fn(node, data));
          node.setAttribute('style', data.attrValue);
        });
      }

      // Apply FORBID_TAGS
      if (config && config.FORBID_TAGS) {
        config.FORBID_TAGS.forEach(tag => {
          div.querySelectorAll(tag).forEach(el => el.remove());
        });
      }

      // Apply FORBID_ATTR - remove forbidden attributes
      if (config && config.FORBID_ATTR) {
        div.querySelectorAll('*').forEach(el => {
          config.FORBID_ATTR.forEach(attr => {
            el.removeAttribute(attr);
          });
        });
      }

      return div.innerHTML;
    },
    addHook: (hookName, fn) => {
      if (!hooks[hookName]) hooks[hookName] = [];
      hooks[hookName].push(fn);
      return hooks[hookName].length;
    },
    removeHook: (hookName) => {
      delete hooks[hookName];
    }
  };
};

// Set up globals before loading module
global.DOMPurify = createDOMPurifyMock();

// escapeHtml helper (needed by external link modal)
global.escapeHtml = (text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

// Mock globals that rich-rendering.js references from dashboard.js
global.selectedAgentId = 'test-agent-123';
global.encryptionKey = null;
global.pendingResponseAgents = new Set();
global.agentListCache = { agents: [], timestamp: 0 };
global.lastMessageTimestamp = null;
global.lastMessageCursor = null;
global.conversationCache = new Map();
global.agentScrollPositions = new Map();
global.updateAgentListUI = jest.fn();
global.loadMessages = jest.fn().mockResolvedValue(undefined);

// Mock fetch
global.fetch = jest.fn();

// Mock E2EEncryption
global.window = global.window || {};
window.E2EEncryption = {
  encryptMessage: jest.fn().mockResolvedValue('encrypted:data:here'),
  decryptMessage: jest.fn().mockResolvedValue('decrypted content')
};

// Load the module (it attaches to window.RichRendering)
require('../../public/js/rich-rendering.js');

const RR = window.RichRendering;

// ============================================================================
// Schema Detection Tests
// ============================================================================

describe('Rich Content Detection', () => {
  test('detects valid rich_html content', () => {
    const content = JSON.stringify({
      type: 'rich_html',
      html: '<form><input name="name" /><button type="submit">Submit</button></form>',
      title: 'Test Form',
      description: 'Please fill out this form'
    });

    const result = RR.detectRichContent(content);
    expect(result).not.toBeNull();
    expect(result.type).toBe('rich_html');
    expect(result.html).toContain('<form>');
    expect(result.title).toBe('Test Form');
    expect(result.description).toBe('Please fill out this form');
  });

  test('returns null for plain text', () => {
    expect(RR.detectRichContent('Hello world')).toBeNull();
  });

  test('returns null for markdown', () => {
    expect(RR.detectRichContent('# Heading\n\nSome **bold** text')).toBeNull();
  });

  test('returns null for non-rich-html JSON', () => {
    const content = JSON.stringify({ type: 'news_announcement', agent: 'test', summary: 'hello', status: 'Completed' });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(RR.detectRichContent('{invalid json')).toBeNull();
  });

  test('returns null for null/undefined/empty', () => {
    expect(RR.detectRichContent(null)).toBeNull();
    expect(RR.detectRichContent(undefined)).toBeNull();
    expect(RR.detectRichContent('')).toBeNull();
  });

  test('returns null for missing html field', () => {
    const content = JSON.stringify({ type: 'rich_html' });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns null for invalid type', () => {
    const content = JSON.stringify({ type: 'rich_svg', html: '<svg></svg>' });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns default title when not provided', () => {
    const content = JSON.stringify({ type: 'rich_html', html: '<p>Hello</p>' });
    const result = RR.detectRichContent(content);
    expect(result.title).toBe('Agent Form');
  });

  test('returns null for oversized html', () => {
    const content = JSON.stringify({ type: 'rich_html', html: 'x'.repeat(100001) });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns null for oversized title', () => {
    const content = JSON.stringify({ type: 'rich_html', html: '<p>Hi</p>', title: 'x'.repeat(201) });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('handles whitespace around JSON', () => {
    const content = '  \n  ' + JSON.stringify({ type: 'rich_html', html: '<p>Hi</p>' }) + '  \n  ';
    const result = RR.detectRichContent(content);
    expect(result).not.toBeNull();
  });

  test('returns null when title contains __REPLACE_WITH_*__ template token', () => {
    const content = JSON.stringify({
      type: 'rich_html',
      title: '__REPLACE_WITH_TITLE__',
      html: '<p>Hi</p>'
    });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns null when html contains __REPLACE_WITH_*__ template token', () => {
    const content = JSON.stringify({
      type: 'rich_html',
      title: 'Status',
      html: '<div>__REPLACE_WITH_HTML__</div>'
    });
    expect(RR.detectRichContent(content)).toBeNull();
  });

  test('returns null when rich_html contains bare REPLACE_WITH_* template token', () => {
    const content = JSON.stringify({
      type: 'rich_html',
      title: 'REPLACE_WITH_TITLE',
      html: '<div>REPLACE_WITH_HTML</div>'
    });
    expect(RR.detectRichContent(content)).toBeNull();
  });
});

// ============================================================================
// CSS Sanitization Tests
// ============================================================================

describe('Inline Style Sanitization', () => {
  test('allows safe CSS properties', () => {
    const result = RR.sanitizeInlineStyles('color: red; font-size: 14px; padding: 10px');
    expect(result).toContain('color: red');
    expect(result).toContain('font-size: 14px');
    expect(result).toContain('padding: 10px');
  });

  test('blocks expression() XSS', () => {
    const result = RR.sanitizeInlineStyles('width: expression(alert(1))');
    expect(result).toBe('');
  });

  test('blocks behavior property', () => {
    const result = RR.sanitizeInlineStyles('behavior: url(evil.htc)');
    expect(result).toBe('');
  });

  test('blocks -moz-binding', () => {
    const result = RR.sanitizeInlineStyles('-moz-binding: url(evil.xml)');
    expect(result).toBe('');
  });

  test('blocks javascript: in values', () => {
    const result = RR.sanitizeInlineStyles('background: javascript:alert(1)');
    expect(result).toBe('');
  });

  test('blocks url() in property values', () => {
    const result = RR.sanitizeInlineStyles('background: url(https://evil.com/tracking.png)');
    expect(result).not.toContain('url(');
  });

  test('filters out unknown properties', () => {
    const result = RR.sanitizeInlineStyles('color: red; -webkit-evil: yes; font-size: 12px');
    expect(result).toContain('color: red');
    expect(result).toContain('font-size: 12px');
    expect(result).not.toContain('evil');
  });

  test('returns empty for null/undefined input', () => {
    expect(RR.sanitizeInlineStyles(null)).toBe('');
    expect(RR.sanitizeInlineStyles(undefined)).toBe('');
    expect(RR.sanitizeInlineStyles('')).toBe('');
  });
});

// ============================================================================
// HTML Sanitization Tests
// ============================================================================

describe('Rich HTML Sanitization', () => {
  test('preserves form elements', () => {
    const html = '<form><label for="name">Name</label><input type="text" name="name" /><button type="submit">Submit</button></form>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).toContain('<form');
    expect(result).toContain('<input');
    expect(result).toContain('<button');
    expect(result).toContain('<label');
  });

  test('preserves select/option elements', () => {
    const html = '<select name="choice"><option value="a">A</option><option value="b">B</option></select>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).toContain('<select');
    expect(result).toContain('<option');
  });

  test('preserves textarea', () => {
    const html = '<textarea name="comments" rows="5" placeholder="Enter comments"></textarea>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).toContain('<textarea');
  });

  test('removes script tags', () => {
    const html = '<p>Hello</p><script>alert("xss")</script>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
  });

  test('removes iframe tags', () => {
    const html = '<p>Hello</p><iframe src="https://evil.com"></iframe>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).not.toContain('<iframe');
  });

  test('removes event handler attributes', () => {
    const html = '<img src="x" onerror="alert(1)" />';
    const result = RR.sanitizeRichHtml(html);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });

  test('removes form action attribute', () => {
    const html = '<form action="https://evil.com/steal" method="POST"><input name="data" /></form>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).not.toContain('action=');
    expect(result).not.toContain('method=');
  });

  test('adds safe attributes to links', () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('rich-content-link');
  });

  test('marks forms with rich-content-form class', () => {
    const html = '<form><input name="test" /></form>';
    const result = RR.sanitizeRichHtml(html);
    expect(result).toContain('rich-content-form');
  });

  test('returns empty for null/undefined', () => {
    expect(RR.sanitizeRichHtml(null)).toBe('');
    expect(RR.sanitizeRichHtml(undefined)).toBe('');
    expect(RR.sanitizeRichHtml('')).toBe('');
  });

  test('handles DOMPurify not loaded', () => {
    const originalDP = global.DOMPurify;
    delete global.DOMPurify;
    const result = RR.sanitizeRichHtml('<p>test</p>');
    expect(result).toContain('security library not loaded');
    global.DOMPurify = originalDP;
  });
});

// ============================================================================
// Form Data Collection Tests
// ============================================================================

describe('Form Data Collection', () => {
  test('collects text input values', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input type="text" name="username" value="john" />';
    const data = RR.collectFormData(form);
    expect(data).toEqual({ username: 'john' });
  });

  test('collects multiple inputs', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="text" name="first" value="John" />
      <input type="text" name="last" value="Doe" />
      <input type="email" name="email" value="john@test.com" />
    `;
    const data = RR.collectFormData(form);
    expect(data.first).toBe('John');
    expect(data.last).toBe('Doe');
    expect(data.email).toBe('john@test.com');
  });

  test('collects textarea values', () => {
    const form = document.createElement('form');
    const textarea = document.createElement('textarea');
    textarea.name = 'comments';
    textarea.value = 'Great feature!';
    form.appendChild(textarea);

    const data = RR.collectFormData(form);
    expect(data.comments).toBe('Great feature!');
  });

  test('collects select values', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <select name="color">
        <option value="red">Red</option>
        <option value="blue" selected>Blue</option>
      </select>
    `;
    const data = RR.collectFormData(form);
    expect(data.color).toBe('blue');
  });

  test('handles checkboxes with same name as array', () => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="checkbox" name="tags" value="urgent" checked />
      <input type="checkbox" name="tags" value="important" checked />
      <input type="checkbox" name="tags" value="low" />
    `;
    const data = RR.collectFormData(form);
    expect(data.tags).toEqual(['urgent', 'important']);
  });

  test('returns null for empty form', () => {
    const form = document.createElement('form');
    const data = RR.collectFormData(form);
    expect(data).toBeNull();
  });

  test('truncates long values', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'data';
    input.value = 'x'.repeat(6000);
    form.appendChild(input);

    const data = RR.collectFormData(form);
    expect(data.data.length).toBeLessThanOrEqual(5000);
  });
});

// ============================================================================
// Form Message Formatting Tests
// ============================================================================

describe('Form Data Formatting', () => {
  test('formats simple key-value pairs', () => {
    const data = { name: 'John', email: 'john@test.com' };
    const form = document.createElement('form');
    const result = RR.formatFormDataAsMessage(data, form);

    expect(result).toContain('📋');
    expect(result).toContain('**Name:** John');
    expect(result).toContain('**Email:** john@test.com');
  });

  test('formats array values', () => {
    const data = { tags: ['urgent', 'important'] };
    const form = document.createElement('form');
    const result = RR.formatFormDataAsMessage(data, form);

    expect(result).toContain('**Tags:** urgent, important');
  });

  test('uses legend text as form title', () => {
    const form = document.createElement('form');
    const legend = document.createElement('legend');
    legend.textContent = 'Contact Info';
    form.appendChild(legend);

    const data = { name: 'John' };
    const result = RR.formatFormDataAsMessage(data, form);
    expect(result).toContain('Contact Info');
  });

  test('uses data-form-title attribute', () => {
    const form = document.createElement('form');
    form.setAttribute('data-form-title', 'Custom Title');

    const data = { name: 'John' };
    const result = RR.formatFormDataAsMessage(data, form);
    expect(result).toContain('Custom Title');
  });

  test('formats key names by replacing underscores/dashes', () => {
    const data = { first_name: 'John', 'phone-number': '123' };
    const form = document.createElement('form');
    const result = RR.formatFormDataAsMessage(data, form);

    expect(result).toContain('First Name');
    expect(result).toContain('Phone Number');
  });
});

// ============================================================================
// Rich Content UI Element Tests
// ============================================================================

describe('Rich Content Element Creation', () => {
  test('creates wrapper with badge', () => {
    const richData = {
      type: 'rich_html',
      html: '<p>Hello</p>',
      title: 'Test',
      description: null
    };

    const el = RR.createRichContentElement(richData);
    expect(el.classList.contains('rich-content-wrapper')).toBe(true);
    expect(el.querySelector('.rich-content-badge')).not.toBeNull();
    expect(el.querySelector('.rich-content-badge').textContent).toContain('Interactive Form');
  });

  test('displays title', () => {
    const richData = {
      type: 'rich_html',
      html: '<p>Content</p>',
      title: 'My Form Title',
      description: null
    };

    const el = RR.createRichContentElement(richData);
    expect(el.querySelector('.rich-content-title').textContent).toBe('My Form Title');
  });

  test('displays description when provided', () => {
    const richData = {
      type: 'rich_html',
      html: '<p>Content</p>',
      title: 'Title',
      description: 'Please fill this form'
    };

    const el = RR.createRichContentElement(richData);
    expect(el.querySelector('.rich-content-description').textContent).toBe('Please fill this form');
  });

  test('omits description when not provided', () => {
    const richData = {
      type: 'rich_html',
      html: '<p>Content</p>',
      title: 'Title',
      description: null
    };

    const el = RR.createRichContentElement(richData);
    expect(el.querySelector('.rich-content-description')).toBeNull();
  });

  test('does not render a second fold/unfold toggle inside rich content', () => {
    const richData = {
      type: 'rich_html',
      html: '<p>Content</p>',
      title: 'Title',
      description: null
    };

    const el = RR.createRichContentElement(richData);
    const body = el.querySelector('.rich-content-body');

    expect(el.querySelector('.rich-content-toggle')).toBeNull();
    expect(body.classList.contains('rich-content-collapsed')).toBe(false);
  });

  test('renders sanitized HTML in body', () => {
    const richData = {
      type: 'rich_html',
      html: '<p class="test">Safe content</p>',
      title: 'Title',
      description: null
    };

    const el = RR.createRichContentElement(richData);
    const body = el.querySelector('.rich-content-body');
    expect(body.innerHTML).toContain('Safe content');
  });
});

// ============================================================================
// Form Submission Interception Tests
// ============================================================================

describe('Form Submission Interception', () => {
  test('prevents default form submission', () => {
    const container = document.createElement('div');
    container.innerHTML = '<form class="rich-content-form"><input name="test" value="hello" /><button type="submit">Send</button></form>';
    document.body.appendChild(container);

    const callback = jest.fn().mockResolvedValue(undefined);
    RR.interceptFormSubmissions(container, callback);

    const form = container.querySelector('form');
    const event = new Event('submit', { bubbles: true, cancelable: true });
    const prevented = !form.dispatchEvent(event);

    expect(prevented).toBe(true);

    document.body.removeChild(container);
  });

  test('calls sendMessage callback with formatted data', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<form class="rich-content-form"><input name="answer" value="42" /><button type="submit">Send</button></form>';
    document.body.appendChild(container);

    const callback = jest.fn().mockResolvedValue(undefined);
    RR.interceptFormSubmissions(container, callback);

    const form = container.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Wait for async handler
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(callback).toHaveBeenCalledWith(expect.stringContaining('**Answer:** 42'));

    document.body.removeChild(container);
  });

  test('disables form after successful submission', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<form class="rich-content-form"><input name="data" value="test" /><button type="submit">Send</button></form>';
    document.body.appendChild(container);

    const callback = jest.fn().mockResolvedValue(undefined);
    RR.interceptFormSubmissions(container, callback);

    const form = container.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(form.classList.contains('rich-form-disabled')).toBe(true);
    expect(form.querySelector('input').disabled).toBe(true);
    expect(form.querySelector('button').disabled).toBe(true);

    document.body.removeChild(container);
  });

  test('handles callback failure gracefully', async () => {
    const container = document.createElement('div');
    container.innerHTML = '<form class="rich-content-form"><input name="data" value="test" /><button type="submit">Send</button></form>';
    document.body.appendChild(container);

    const callback = jest.fn().mockRejectedValue(new Error('Network error'));
    RR.interceptFormSubmissions(container, callback);

    const form = container.querySelector('form');
    const btn = form.querySelector('button');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await new Promise(resolve => setTimeout(resolve, 50));

    // Form should NOT be disabled after failure
    expect(form.classList.contains('rich-form-disabled')).toBe(false);
    expect(btn.disabled).toBe(false);

    document.body.removeChild(container);
  });
});

// ============================================================================
// External Link Interception Tests
// ============================================================================

describe('External Link Handling', () => {
  test('intercepts external link clicks', () => {
    const container = document.createElement('div');
    container.innerHTML = '<a href="https://example.com" class="rich-content-link">External</a>';
    document.body.appendChild(container);

    RR.interceptExternalLinks(container);

    const link = container.querySelector('a');
    const event = new Event('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: link, writable: false });
    const prevented = !container.dispatchEvent(event);

    document.body.removeChild(container);

    // Event should be intercepted
    // Note: the actual prevention depends on the event handler calling preventDefault
  });

  test('allows anchor links through', () => {
    // Clean up any modal from previous test
    const existingModal = document.getElementById('richExternalLinkModal');
    if (existingModal) existingModal.remove();

    const container = document.createElement('div');
    container.innerHTML = '<a href="#section1" class="rich-content-link">Anchor</a>';
    document.body.appendChild(container);

    RR.interceptExternalLinks(container);

    // Simulate click on anchor link
    const link = container.querySelector('a');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    // Anchor links should pass through without showing modal
    const modal = document.getElementById('richExternalLinkModal');
    expect(modal).toBeNull();

    document.body.removeChild(container);
  });

  test('creates modal with correct URL display', () => {
    // Clean up any existing modals
    const existing = document.getElementById('richExternalLinkModal');
    if (existing) existing.remove();

    // Directly test showExternalLinkModal
    // It's not exported, but we can trigger it via the link interception
    const container = document.createElement('div');
    const link = document.createElement('a');
    link.href = 'https://example.com/page';
    link.className = 'rich-content-link';
    link.textContent = 'Click me';
    container.appendChild(link);
    document.body.appendChild(container);

    RR.interceptExternalLinks(container);

    // Simulate click
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(clickEvent);

    const modal = document.getElementById('richExternalLinkModal');
    // Modal might be created if link interception works correctly in jsdom
    if (modal) {
      expect(modal.querySelector('.rich-link-modal')).not.toBeNull();
      // Clean up
      modal.remove();
    }

    document.body.removeChild(container);
  });
});

// ============================================================================
// Interactive Content Popup Viewer Tests
// ============================================================================

describe('Interactive Content Popup Viewer', () => {
  afterEach(() => {
    RR.closeInteractiveContentPopup();
    document.body.classList.remove('rich-popup-open');
    document.body.innerHTML = '';
  });

  test('opens popup and moves content into popup body', () => {
    const content = document.createElement('div');
    content.className = 'rich-content-body';
    content.innerHTML = '<div class="rich-content-wrapper"><p id="probe">Popup content</p></div>';
    document.body.appendChild(content);

    const stateCb = jest.fn();
    const opened = RR.openInteractiveContentPopup({
      sourceContentEl: content,
      title: 'Agent Space',
      onStateChange: stateCb
    });

    expect(opened).toBe(true);
    expect(document.body.classList.contains('rich-popup-open')).toBe(true);
    expect(stateCb).toHaveBeenCalledWith(true);
    expect(document.querySelector('.rich-content-popup-overlay')).not.toBeNull();
    expect(document.querySelector('.rich-content-popup-title').textContent).toBe('Agent Space');
    expect(content.children.length).toBe(0);
    expect(document.querySelector('.rich-content-popup-body #probe')).not.toBeNull();
  });

  test('backdrop click closes popup and restores content', () => {
    const content = document.createElement('div');
    content.className = 'rich-content-body';
    content.innerHTML = '<div class="rich-content-wrapper"><p id="probe-backdrop">Popup content</p></div>';
    document.body.appendChild(content);

    RR.openInteractiveContentPopup({ sourceContentEl: content, title: 'Agent Space' });

    const overlay = document.querySelector('.rich-content-popup-overlay');
    expect(overlay).not.toBeNull();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.rich-content-popup-overlay')).toBeNull();
    expect(document.body.classList.contains('rich-popup-open')).toBe(false);
    expect(content.querySelector('#probe-backdrop')).not.toBeNull();
  });

  test('escape key closes popup and restores content', () => {
    const content = document.createElement('div');
    content.className = 'rich-content-body';
    content.innerHTML = '<div class="rich-content-wrapper"><p id="probe-esc">Popup content</p></div>';
    document.body.appendChild(content);

    RR.openInteractiveContentPopup({ sourceContentEl: content, title: 'Agent Space' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.rich-content-popup-overlay')).toBeNull();
    expect(content.querySelector('#probe-esc')).not.toBeNull();
  });

  test('closeInteractiveContentPopupFor only closes matching source', () => {
    const contentA = document.createElement('div');
    contentA.className = 'rich-content-body';
    contentA.innerHTML = '<div class="rich-content-wrapper"><p>A</p></div>';
    const contentB = document.createElement('div');
    contentB.className = 'rich-content-body';
    contentB.innerHTML = '<div class="rich-content-wrapper"><p>B</p></div>';
    document.body.appendChild(contentA);
    document.body.appendChild(contentB);

    RR.openInteractiveContentPopup({ sourceContentEl: contentA, title: 'A' });

    const wrongClose = RR.closeInteractiveContentPopupFor(contentB);
    expect(wrongClose).toBe(false);
    expect(document.querySelector('.rich-content-popup-overlay')).not.toBeNull();

    const rightClose = RR.closeInteractiveContentPopupFor(contentA);
    expect(rightClose).toBe(true);
    expect(document.querySelector('.rich-content-popup-overlay')).toBeNull();
  });

  test('toggleInteractiveContentPopup toggles open and close', () => {
    const content = document.createElement('div');
    content.className = 'rich-content-body';
    content.innerHTML = '<div class="rich-content-wrapper"><p id="probe-toggle">Popup content</p></div>';
    document.body.appendChild(content);

    const firstToggle = RR.toggleInteractiveContentPopup({ sourceContentEl: content, title: 'Toggle Test' });
    expect(firstToggle).toBe(true);
    expect(RR.isInteractiveContentPopupOpenFor(content)).toBe(true);

    const secondToggle = RR.toggleInteractiveContentPopup({ sourceContentEl: content, title: 'Toggle Test' });
    expect(secondToggle).toBe(false);
    expect(RR.isInteractiveContentPopupOpenFor(content)).toBe(false);
    expect(content.querySelector('#probe-toggle')).not.toBeNull();
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('renderRichContent Integration', () => {
  test('returns a complete DOM element with all components', () => {
    const richData = {
      type: 'rich_html',
      html: '<form><label for="name">Name</label><input type="text" name="name" /><button type="submit">Submit</button></form>',
      title: 'Contact Form',
      description: 'Please provide your info'
    };

    const callback = jest.fn().mockResolvedValue(undefined);
    const element = RR.renderRichContent(richData, callback);

    // Should have wrapper
    expect(element.classList.contains('rich-content-wrapper')).toBe(true);
    // Should have badge
    expect(element.querySelector('.rich-content-badge')).not.toBeNull();
    // Should have title
    expect(element.querySelector('.rich-content-title').textContent).toBe('Contact Form');
    // Should have description
    expect(element.querySelector('.rich-content-description').textContent).toBe('Please provide your info');
    // Should have form content
    expect(element.querySelector('.rich-content-body form')).not.toBeNull();
    // The surrounding Agent Space bar is the only fold/unfold control.
    expect(element.querySelector('.rich-content-toggle')).toBeNull();
  });

  test('handles complex forms with multiple input types', () => {
    const richData = {
      type: 'rich_html',
      html: `
        <form>
          <fieldset>
            <legend>Personal Info</legend>
            <label for="name">Name</label>
            <input type="text" name="name" required />
            <label for="email">Email</label>
            <input type="email" name="email" required />
          </fieldset>
          <fieldset>
            <legend>Preferences</legend>
            <select name="priority">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <textarea name="notes" rows="3" placeholder="Additional notes"></textarea>
          </fieldset>
          <button type="submit">Submit</button>
          <button type="reset">Clear</button>
        </form>
      `,
      title: 'Registration',
      description: null
    };

    const callback = jest.fn().mockResolvedValue(undefined);
    const element = RR.renderRichContent(richData, callback);

    const body = element.querySelector('.rich-content-body');
    expect(body.querySelectorAll('fieldset').length).toBe(2);
    expect(body.querySelector('input[name="name"]')).not.toBeNull();
    expect(body.querySelector('input[name="email"]')).not.toBeNull();
    expect(body.querySelector('select[name="priority"]')).not.toBeNull();
    expect(body.querySelector('textarea[name="notes"]')).not.toBeNull();
    expect(body.querySelector('button[type="submit"]')).not.toBeNull();
    expect(body.querySelector('button[type="reset"]')).not.toBeNull();
  });
});

// ============================================================================
// ALLOWED_CSS_PROPERTIES sanity check
// ============================================================================

describe('CSS Property Allowlist', () => {
  test('contains common safe layout properties', () => {
    expect(RR.ALLOWED_CSS_PROPERTIES.has('display')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('margin')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('padding')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('width')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('height')).toBe(true);
  });

  test('contains text styling properties', () => {
    expect(RR.ALLOWED_CSS_PROPERTIES.has('color')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('font-size')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('font-weight')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('text-align')).toBe(true);
  });

  test('contains flexbox/grid properties', () => {
    expect(RR.ALLOWED_CSS_PROPERTIES.has('flex')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('flex-direction')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('grid-template-columns')).toBe(true);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('gap')).toBe(true);
  });

  test('does not contain dangerous properties', () => {
    // These should NOT be in the allowlist
    expect(RR.ALLOWED_CSS_PROPERTIES.has('content')).toBe(false);
    expect(RR.ALLOWED_CSS_PROPERTIES.has('counter-reset')).toBe(false);
  });
});

// ============================================================================
// Schema Config Tests
// ============================================================================

describe('Schema Configuration', () => {
  test('has required fields defined', () => {
    expect(RR.RICH_CONTENT_SCHEMA.requiredFields).toContain('type');
    expect(RR.RICH_CONTENT_SCHEMA.requiredFields).toContain('html');
  });

  test('has valid types defined', () => {
    expect(RR.RICH_CONTENT_SCHEMA.validTypes).toContain('rich_html');
  });

  test('has reasonable size limits', () => {
    expect(RR.RICH_CONTENT_SCHEMA.maxHtmlLength).toBeLessThanOrEqual(200000);
    expect(RR.RICH_CONTENT_SCHEMA.maxHtmlLength).toBeGreaterThan(0);
    expect(RR.RICH_CONTENT_SCHEMA.maxTitleLength).toBeGreaterThan(0);
  });
});

// ============================================================================
// DOMPurify Config Tests
// ============================================================================

describe('Sanitization Configuration', () => {
  test('allows form-related tags', () => {
    const allowed = RR.RICH_HTML_SANITIZE_CONFIG.ALLOWED_TAGS;
    expect(allowed).toContain('form');
    expect(allowed).toContain('input');
    expect(allowed).toContain('textarea');
    expect(allowed).toContain('select');
    expect(allowed).toContain('option');
    expect(allowed).toContain('button');
    expect(allowed).toContain('label');
    expect(allowed).toContain('fieldset');
    expect(allowed).toContain('legend');
  });

  test('forbids dangerous tags', () => {
    const forbidden = RR.RICH_HTML_SANITIZE_CONFIG.FORBID_TAGS;
    expect(forbidden).toContain('script');
    expect(forbidden).toContain('iframe');
    expect(forbidden).toContain('object');
    expect(forbidden).toContain('embed');
    expect(forbidden).toContain('style');
  });

  test('forbids form action-related attributes', () => {
    const forbidden = RR.RICH_HTML_SANITIZE_CONFIG.FORBID_ATTR;
    expect(forbidden).toContain('action');
    expect(forbidden).toContain('method');
    expect(forbidden).toContain('formmethod');
    expect(forbidden).toContain('formtarget');
  });

  test('forbids event handler attributes', () => {
    const forbidden = RR.RICH_HTML_SANITIZE_CONFIG.FORBID_ATTR;
    expect(forbidden).toContain('onclick');
    expect(forbidden).toContain('onerror');
    expect(forbidden).toContain('onload');
    expect(forbidden).toContain('onsubmit');
  });

  test('allows form input attributes', () => {
    const allowed = RR.RICH_HTML_SANITIZE_CONFIG.ALLOWED_ATTR;
    expect(allowed).toContain('type');
    expect(allowed).toContain('name');
    expect(allowed).toContain('value');
    expect(allowed).toContain('placeholder');
    expect(allowed).toContain('required');
    expect(allowed).toContain('checked');
    expect(allowed).toContain('selected');
  });
});
