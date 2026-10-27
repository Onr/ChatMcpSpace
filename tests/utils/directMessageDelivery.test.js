const { directMessageDelivery } = require('../../src/utils/directMessageDelivery');
const now = Date.parse('2026-10-23T04:00:00Z');
test('queued messages stay pending even with an online recipient', () => {
  expect(directMessageDelivery(new Date(now - 1000), null, now)).toMatchObject({ state: 'pending', recipientOnline: true, readAt: null });
});
test.each([null, 'invalid', new Date(now - 300001)])('missing, invalid and stale check-ins report offline: %s', lastSeen => {
  expect(directMessageDelivery(lastSeen, null, now)).toMatchObject({ state: 'pending', recipientOnline: false });
});
test('receipt survives the recipient going offline', () => {
  expect(directMessageDelivery(null, new Date(now - 1000), now)).toMatchObject({ state: 'received', recipientOnline: false, readAt: '2026-10-23T03:59:59.000Z' });
});
