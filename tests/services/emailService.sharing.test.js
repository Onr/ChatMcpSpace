'use strict';

jest.mock('../../src/db/connection', () => ({ query: jest.fn() }));

const { sendConversationInvitationEmail } = require('../../src/services/emailService');

test('sends an invitation email with an escaped agent name and the signup continuation URL', async () => {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'fake-message-id' });
  const result = await sendConversationInvitationEmail({
    to: 'person@example.test',
    agentName: '<script>alert(1)</script>',
    expiresAt: new Date('2026-10-16T12:00:00Z'),
    joinUrl: 'https://chat.example.test/join/invitation/11111111-1111-4111-8111-111111111111'
  }, { transport: { sendMail } });

  expect(result).toEqual({ success: true, messageId: 'fake-message-id' });
  expect(sendMail).toHaveBeenCalledTimes(1);
  const message = sendMail.mock.calls[0][0];
  expect(message.to).toBe('person@example.test');
  expect(message.text).toContain('https://chat.example.test/join/invitation/11111111-1111-4111-8111-111111111111');
  expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(message.html).not.toContain('<script>alert(1)</script>');
  expect(message.headers['X-Email-Type']).toBe('shared-conversation-invitation');
});
