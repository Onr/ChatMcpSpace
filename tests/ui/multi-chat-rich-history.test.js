/**
 * @jest-environment jsdom
 */

describe('Multi-chat rich history controls', () => {
  const richOne = JSON.stringify({
    type: 'rich_html',
    title: 'First Card',
    html: '<p>First</p>'
  });

  const richTwo = JSON.stringify({
    type: 'rich_html',
    title: 'Second Card',
    html: '<p>Second</p>'
  });

  const waitFor = async (predicate, timeoutMs = 500) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition');
  };

  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();

    document.body.innerHTML = `
      <div class="dashboard-main-grid">
        <div id="multiChatContainer" class="multi-chat-container--empty"></div>
      </div>
    `;

    window.DashboardHelpers = {
      escapeHtml: (text) => String(text || ''),
      renderMarkdown: (text) => String(text || ''),
      formatTimestamp: () => '10:00',
      looksLikeEncrypted: () => false,
      getEncryptionKey: () => null
    };

    window.RichRendering = {
      detectRichContent: (content) => {
        try {
          const parsed = JSON.parse(content);
          return parsed.type === 'rich_html' ? parsed : null;
        } catch {
          return null;
        }
      },
      renderRichContent: (richData) => {
        const el = document.createElement('div');
        el.className = 'rich-content-wrapper';
        el.textContent = `Rendered: ${richData.title || richData.badge || 'Agent Space'}`;
        return el;
      }
    };

    global.fetch = jest.fn(async (url) => {
      if (String(url).startsWith('/api/user/messages/')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              {
                messageId: 'm1',
                type: 'agent_message',
                content: richOne,
                timestamp: '2026-03-07T10:00:00.000Z',
                cursor: 'c1'
              },
              {
                messageId: 'm2',
                type: 'agent_message',
                content: richTwo,
                timestamp: '2026-03-07T10:01:00.000Z',
                cursor: 'c2'
              }
            ]
          })
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    global.csrfFetch = jest.fn();
    window.csrfToken = 'test-token';
    URL.createObjectURL = jest.fn(() => 'blob:test');
    URL.revokeObjectURL = jest.fn();

    require('../../public/js/multi-chat.js');
  });

  afterEach(async () => {
    if (window.MultiChatManager?.isOpen('agent-1')) {
      window.MultiChatManager.closeSidePanel('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    delete window.MultiChatManager;
    delete window.DashboardHelpers;
    delete window.RichRendering;
    delete global.fetch;
    delete global.csrfFetch;
  });

  it('supports prev/next navigation and download for rich messages in side chat', async () => {
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    window.MultiChatManager.openSidePanel('agent-1', 'Agent One', {});

    await waitFor(() => {
      const counter = document.querySelector('.chat-tile__rich-history-counter');
      return counter && counter.textContent.trim() === '2 / 2';
    });

    const controls = document.querySelector('.chat-tile__rich-history-controls');
    const prevBtn = document.querySelector('.chat-tile__rich-history-prev');
    const nextBtn = document.querySelector('.chat-tile__rich-history-next');
    const downloadBtn = document.querySelector('.chat-tile__rich-history-download');
    const title = document.querySelector('.chat-tile__interactive-title');
    const content = document.querySelector('.chat-tile__interactive-content');
    const counter = document.querySelector('.chat-tile__rich-history-counter');

    expect(controls.classList.contains('hidden')).toBe(false);
    expect(counter.textContent.trim()).toBe('2 / 2');
    expect(prevBtn.disabled).toBe(false);
    expect(nextBtn.disabled).toBe(true);
    expect(title.textContent.trim()).toBe('Second Card');
    expect(content.textContent).toContain('Rendered: Second Card');

    prevBtn.click();

    expect(counter.textContent.trim()).toBe('1 / 2');
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(title.textContent.trim()).toBe('First Card');
    expect(content.textContent).toContain('Rendered: First Card');

    downloadBtn.click();

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });
});
