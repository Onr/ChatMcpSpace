/**
 * @jest-environment jsdom
 */

describe('Multi-chat attachment errors', () => {
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

    window.showError = jest.fn();
    window.DashboardHelpers = {
      escapeHtml: (text) => String(text || ''),
      renderMarkdown: (text) => String(text || ''),
      formatTimestamp: () => '10:00',
      looksLikeEncrypted: () => false,
      getEncryptionKey: () => 'test-key',
      readErrorPayload: async (response) => response.json(),
      buildRequestError: (response, errorData, options = {}) => {
        const error = new Error(errorData?.error?.message || options.fallbackMessage || `Request failed (${response.status})`);
        error.status = response.status;
        return error;
      },
      notifyRateLimit: jest.fn()
    };

    window.E2EEncryption = {
      encryptBinaryWithKey: jest.fn(async (arrayBuffer) => ({
        ciphertext: new Uint8Array(arrayBuffer),
        iv: new Uint8Array(12),
        authTag: new Uint8Array(16)
      })),
      arrayBufferToBase64: jest.fn(() => 'dGVzdA==')
    };

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [] })
    }));

    global.csrfFetch = jest.fn(async (url) => {
      if (url === '/api/user/attachments') {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              message: 'This workspace currently allows image uploads only.'
            }
          })
        };
      }

      return {
        ok: true,
        json: async () => ({})
      };
    });

    URL.createObjectURL = jest.fn(() => 'blob:test');
    URL.revokeObjectURL = jest.fn();

    require('../../public/js/multi-chat.js');
  });

  afterEach(async () => {
    if (window.MultiChatManager?.isOpen('agent-1')) {
      window.MultiChatManager.closeSidePanel('agent-1');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    delete window.MultiChatManager;
    delete window.DashboardHelpers;
    delete window.E2EEncryption;
    delete window.showError;
    delete global.fetch;
    delete global.csrfFetch;
  });

  it('shows the server upload error with the failed filename', async () => {
    window.MultiChatManager.openSidePanel('agent-1', 'Agent One', {});

    await waitFor(() => document.querySelector('.chat-tile[data-agent-id="agent-1"]'));

    const fileInput = document.querySelector('.chat-tile[data-agent-id="agent-1"] .chat-tile__file-input');
    const sendButton = document.querySelector('.chat-tile[data-agent-id="agent-1"] .chat-tile__send-btn');
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    file.arrayBuffer = jest.fn(async () => Uint8Array.from([104, 101, 108, 108, 111]).buffer);

    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file]
    });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    sendButton.click();

    await waitFor(() => window.showError.mock.calls.length > 0);

    expect(window.showError).toHaveBeenCalledWith(
      'This workspace currently allows image uploads only. Failed: notes.txt.'
    );
  });
});
