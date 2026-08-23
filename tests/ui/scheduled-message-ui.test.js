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

  test('does not retain a separate scheduled-message composer button', () => {
    const view = fs.readFileSync(path.join(__dirname, '../../views/dashboard.ejs'), 'utf8');
    expect(view).not.toContain('scheduledMessagesBtn');
    expect(dashboard).not.toContain("getElementById('scheduledMessagesBtn')");
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
