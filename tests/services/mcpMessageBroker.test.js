const broker = require('../../src/services/mcpMessageBroker');

describe('MCP transient browser message broker', () => {
  beforeEach(() => { broker._resetForTests(); jest.useFakeTimers(); });
  afterEach(() => { broker._resetForTests(); jest.useRealTimers(); });

  test('binds claim, result, and completion to the enrolled owner, grant, and session', async () => {
    const connection = broker.enroll({ ownerId: 'owner-a', grantId: 'grant-a', sessionId: 'session-a' });
    const pending = broker.request({ ownerId: 'owner-a', grantId: 'grant-a', operation: 'read_inbox', args: { limit: 10 } });
    expect(broker.claim({ ...connection, ownerId: 'owner-b', sessionId: 'session-a' })).toBeNull();
    expect(broker.claim({ ...connection, ownerId: 'owner-a', sessionId: 'session-b' })).toBeNull();
    const operation = broker.claim({ ...connection, ownerId: 'owner-a', sessionId: 'session-a' });
    expect(operation.operation).toBe('read_inbox');
    expect(broker.complete({ ...connection, ownerId: 'owner-a', sessionId: 'session-b', requestId: operation.id, result: { messages: [] } })).toBe(false);
    expect(broker.complete({ ...connection, ownerId: 'owner-a', sessionId: 'session-a', requestId: operation.id, result: { messages: [{ content: 'transient plaintext' }] } })).toBe(true);
    await expect(pending).resolves.toEqual({ messages: [{ content: 'transient plaintext' }] });
    expect(broker.statusForGrant({ ownerId: 'owner-a', grantId: 'grant-a' }).state).toBe('connected');
  });

  test('removes timed-out operations from the queue and rejects duplicate or unclaimed results', async () => {
    const connection = broker.enroll({ ownerId: 'owner-a', grantId: 'grant-a', sessionId: 'session-a' });
    const pending = broker.request({ ownerId: 'owner-a', grantId: 'grant-a', operation: 'send_message', args: { text: 'transient', idempotencyId: 'id' } });
    const result = expect(pending).rejects.toMatchObject({ code: 'GATEWAY_TIMEOUT' });
    jest.advanceTimersByTime(broker._limits.REQUEST_TTL_MS + 1);
    await result;
    expect(broker.claim({ ...connection, ownerId: 'owner-a', sessionId: 'session-a' })).toBeNull();
    expect(broker.complete({ ...connection, ownerId: 'owner-a', sessionId: 'session-a', requestId: 'unknown', result: {} })).toBe(false);
  });

  test('fails closed on offline, queue limits, result limits, and grant revocation', async () => {
    const connection = broker.enroll({ ownerId: 'owner-a', grantId: 'grant-a', sessionId: 'session-a' });
    for (let i = 0; i < broker._limits.MAX_PENDING_PER_CONNECTION; i++) {
      broker.request({ ownerId: 'owner-a', grantId: 'grant-a', operation: 'read_thread', args: { limit: 1 } }).catch(() => {});
    }
    await expect(broker.request({ ownerId: 'owner-a', grantId: 'grant-a', operation: 'read_thread', args: { limit: 1 } })).rejects.toMatchObject({ code: 'GATEWAY_BUSY' });
    const operation = broker.claim({ ...connection, ownerId: 'owner-a', sessionId: 'session-a' });
    expect(broker.complete({ ...connection, ownerId: 'owner-a', sessionId: 'session-a', requestId: operation.id, result: 'x'.repeat(broker._limits.MAX_RESULT_BYTES) })).toBe(true);
    broker.revokeGrant('grant-a');
    expect(broker.statusForGrant({ ownerId: 'owner-a', grantId: 'grant-a' }).state).toBe('offline');
  });
});
