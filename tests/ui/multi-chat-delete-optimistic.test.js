/**
 * @jest-environment jsdom
 *
 * Regression test: deleting a just-sent tile message must use the real server
 * message ID, not the optimistic opt-* placeholder ID (which the API rejects
 * with 400 "Invalid message ID format").
 */

describe('Multi-chat delete after optimistic send', () => {
  const waitFor = async (predicate, timeoutMs = 1000) => {
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

    window.confirm = jest.fn(() => true);
    window.showError = jest.fn();
    window.DashboardHelpers = {
      escapeHtml: (text) => String(text || ''),
      renderMarkdown: (text) => String(text || ''),
      formatTimestamp: () => '10:00',
      looksLikeEncrypted: () => false,
      getEncryptionKey: () => null,
      readErrorPayload: async (response) => response.json(),
      buildRequestError: (response, errorData, options = {}) => {
        const error = new Error(errorData?.error?.message || options.fallbackMessage || `Request failed (${response.status})`);
        error.status = response.status;
        return error;
      },
      notifyRateLimit: jest.fn()
    };

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [] })
    }));

    global.csrfFetch = jest.fn(async (url, options = {}) => {
      if (url === '/api/user/messages' && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ messageId: 'real-123' })
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true })
      };
    });

    require('../../public/js/multi-chat.js');
  });

  afterEach(async () => {
    if (window.MultiChatManager?.isOpen('agent-1')) {
      window.MultiChatManager.closeSidePanel('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    delete window.MultiChatManager;
    delete window.DashboardHelpers;
    delete window.showError;
    delete window.confirm;
    delete global.fetch;
    delete global.csrfFetch;
  });

  it('deletes a sent message with the server ID, never the opt-* ID', async () => {
    window.MultiChatManager.openSidePanel('agent-1', 'Agent One', {});

    await waitFor(() => document.querySelector('.chat-tile[data-agent-id="agent-1"]'));

    const tile = document.querySelector('.chat-tile[data-agent-id="agent-1"]');
    const textarea = tile.querySelector('.chat-tile__textarea');
    const sendButton = tile.querySelector('.chat-tile__send-btn');

    textarea.value = 'hello there';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => !sendButton.disabled);
    sendButton.click();

    // Wait for the optimistic element to be re-labelled with the server ID
    await waitFor(() => document.querySelector('[data-tile-msg-id="real-123"]'));

    const wrapper = document.querySelector('[data-tile-msg-id="real-123"]');
    const deleteButton = wrapper.querySelector('.message-delete-btn');
    expect(deleteButton).toBeTruthy();

    deleteButton.click();

    await waitFor(() => global.csrfFetch.mock.calls.some(
      ([url, options]) => options?.method === 'DELETE'
    ));

    const deleteCalls = global.csrfFetch.mock.calls.filter(
      ([, options]) => options?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe('/api/user/messages/real-123');
    expect(window.showError).not.toHaveBeenCalled();
  });

  it('uses one check while sending and two gray checks immediately after server acceptance', async () => {
    let accept;
    const baseFetch = global.csrfFetch;
    global.csrfFetch = jest.fn((url, options) => url === '/api/user/messages' && options?.method === 'POST'
      ? new Promise(resolve => { accept = () => resolve({ ok: true, json: async () => ({ messageId: 'receipt-123' }) }); })
      : baseFetch(url, options));
    window.MultiChatManager.openSidePanel('agent-1', 'Agent One', {});
    await waitFor(() => document.querySelector('.chat-tile[data-agent-id="agent-1"]'));
    const tile = document.querySelector('.chat-tile[data-agent-id="agent-1"]');
    const textarea = tile.querySelector('.chat-tile__textarea');
    const send = tile.querySelector('.chat-tile__send-btn');
    textarea.value = 'Receipt verification';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => !send.disabled);
    send.click();
    await waitFor(() => Boolean(accept));
    const indicator = tile.querySelector('.message-read-indicator');
    expect(indicator.textContent).toBe('✓');
    expect(indicator.classList.contains('message-read-indicator--pending')).toBe(true);
    accept();
    await waitFor(() => document.querySelector('[data-tile-msg-id="receipt-123"]'));
    expect(tile.querySelector('.message-read-indicator')).toBe(indicator);
    expect(indicator.textContent).toBe('✓✓');
    expect(indicator.classList.contains('message-read-indicator--delivered')).toBe(true);
  });
});
