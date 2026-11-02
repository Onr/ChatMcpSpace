/** @jest-environment node */

const fs = require('fs');
const path = require('path');

describe('scheduled message composer UI', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');

  test('opens schedule and manager choices after a send-button hold', () => {
    expect(dashboard).toContain('SCHEDULE_HOLD_DELAY_MS = 550');
    expect(dashboard).toContain("addEventListener('pointerdown'");
    expect(dashboard).toContain('openScheduleMessageActions');
    expect(dashboard).toContain('Choose send time');
    expect(dashboard).toContain('View scheduled messages');
  });

  test('opens a date and time picker from the long-press schedule choice', () => {
    expect(dashboard).toContain('type="datetime-local"');
    expect(dashboard).toContain('Schedule message');
  });

  test('submits scheduled messages through the server-backed endpoint', () => {
    expect(dashboard).toContain("'/api/user/messages/schedule'");
    expect(dashboard).toContain('scheduledFor: when.toISOString()');
    expect(dashboard).toContain('Scheduled messages currently support text only');
  });

  test('offers a manager that can edit or cancel pending scheduled messages', () => {
    expect(dashboard).toContain('/api/user/messages/scheduled?agentId=');
    expect(dashboard).toContain("method: 'PATCH'");
    expect(dashboard).toContain("method: 'DELETE'");
    expect(dashboard).toContain('Scheduled messages');
  });

  test('does not retain an always-visible scheduled-message composer button', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../views/dashboard.ejs'), 'utf8');
    expect(view).not.toContain('scheduledMessagesBtn');
    expect(dashboard).not.toContain("getElementById('scheduledMessagesBtn')");
    // The indicator exists but starts hidden; it appears only with pending sends.
    expect(view).toMatch(/id="scheduledMessagesIndicator"[\s\S]{0,80}class="hidden /);
  });

  describe('scheduled messages indicator', () => {
    const { JSDOM } = require('jsdom');
    const source = dashboard.match(/let scheduledIndicatorRequest = 0;[\s\S]*?\n}\n/)[0];

    function setup(responses) {
      const dom = new JSDOM('<button id="scheduledMessagesIndicator" class="hidden"><span data-scheduled-count>0</span></button>');
      const calls = [];
      const env = {
        document: dom.window.document,
        selectedAgentId: 'agent-1',
        openScheduledMessagesDialog: jest.fn(),
        csrfFetch: jest.fn(async (url) => {
          calls.push(url);
          const scheduledMessages = responses.shift() || [];
          return { ok: true, json: async () => ({ scheduledMessages }) };
        })
      };
      // eslint-disable-next-line no-new-func
      const factory = new Function('env', `with (env) { ${source}; return { refresh: refreshScheduledMessagesIndicator, setAgent: (id) => { env.selectedAgentId = id; } }; }`);
      return { env, calls, api: factory(env), indicator: dom.window.document.getElementById('scheduledMessagesIndicator') };
    }

    test('appears with the pending count after a message is scheduled', async () => {
      const { api, indicator, calls } = setup([[{ scheduledMessageId: 'a' }, { scheduledMessageId: 'b' }]]);
      await api.refresh();
      expect(calls[0]).toBe('/api/user/messages/scheduled?agentId=agent-1');
      expect(indicator.classList.contains('hidden')).toBe(false);
      expect(indicator.textContent.trim()).toBe('2');
      expect(indicator.getAttribute('aria-label')).toBe('View 2 scheduled messages');
    });

    test('opens the scheduled list so messages can be reviewed or cancelled', async () => {
      const { api, indicator, env } = setup([[{ scheduledMessageId: 'a' }]]);
      await api.refresh();
      indicator.click();
      expect(env.openScheduledMessagesDialog).toHaveBeenCalledTimes(1);
    });

    test('hides again once the last scheduled message is cancelled or sent', async () => {
      const { api, indicator } = setup([[{ scheduledMessageId: 'a' }], []]);
      await api.refresh();
      expect(indicator.classList.contains('hidden')).toBe(false);
      await api.refresh();
      expect(indicator.classList.contains('hidden')).toBe(true);
    });

    test('ignores a stale response after the user switches agents', async () => {
      const { api, indicator } = setup([[{ scheduledMessageId: 'a' }]]);
      const pending = api.refresh();
      api.setAgent('agent-2');
      await pending;
      expect(indicator.classList.contains('hidden')).toBe(true);
    });
  });

  test('refreshes the indicator after scheduling, list changes and agent switches', () => {
    expect(dashboard).toMatch(/'Scheduled'\);\n\s+refreshScheduledMessagesIndicator\(\);/);
    expect(dashboard).toMatch(/selectedAgentId = agentId;\n\s+refreshScheduledMessagesIndicator\(\);/);
    expect(dashboard).toMatch(/await response\.json\(\);\n\s+refreshScheduledMessagesIndicator\(\);/);
  });

  test('keeps the Send control available to open the manager with an empty draft', () => {
    expect(dashboard).toContain('openScheduleMessageActions();');
    expect(dashboard).toContain('canManageScheduledMessages = hasAgent && !isUploadingImages');
  });

  test('decrypts encrypted scheduled messages locally so they remain viewable and editable', () => {
    expect(dashboard).toContain('prepareScheduledMessageForEditing');
    expect(dashboard).toContain('window.E2EEncryption.decryptMessage(message.content, encryptionKey)');
    expect(dashboard).toContain('window.E2EEncryption.encryptMessage(content, encryptionKey)');
  });

  test('uses a scrollable bottom sheet with touch-friendly controls on mobile', () => {
    expect(dashboard).toContain('max-h-[calc(100dvh-1rem)]');
    expect(dashboard).toContain('min-h-11');
  });
});
