const { fetchServer, retryStartup } = require('../../scripts/shared-agent-runner');

test('network diagnostics identify the server and cause without printing tokens or request data', async () => {
  const cause = Object.assign(new TypeError('fetch failed SECRET'), { cause: { code: 'ENOTFOUND' } });
  const operation = () => fetchServer('https://example.test/api?secret=TOKEN', { headers: { 'x-agent-token': 'SECRET' } }, async () => { throw cause; });
  await expect(operation()).rejects.toThrow('example.test (ENOTFOUND)');
  try { await operation(); } catch (error) {
    expect(error.message).not.toMatch(/TOKEN|SECRET|secret=/);
    expect(error.retryable).toBe(true);
  }
});
test('startup reconnects after transport and server errors without invoking a provider', async () => {
  const operation = jest.fn().mockRejectedValueOnce({ message: 'DNS unavailable', retryable: true })
    .mockRejectedValueOnce({ message: 'Busy', status: 503 }).mockResolvedValue('connected');
  const wait = jest.fn(), report = jest.fn();
  await expect(retryStartup(operation, { wait, report })).resolves.toBe('connected');
  expect(wait.mock.calls).toEqual([[2000], [4000]]);
  expect(operation).toHaveBeenCalledTimes(3);
});
test.each([401, 403, 409])('authorization or conflicting runtime HTTP %s fails immediately', async status => {
  const operation = jest.fn().mockRejectedValue({ status });
  const wait = jest.fn();
  await expect(retryStartup(operation, { wait })).rejects.toEqual({ status });
  expect(operation).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});
test('unavailable startup stops after bounded retries with its state untouched', async () => {
  const operation = jest.fn().mockRejectedValue({ message: 'Offline', retryable: true });
  await expect(retryStartup(operation, { wait: jest.fn(), report: jest.fn() })).rejects.toMatchObject({ message: 'Offline' });
  expect(operation).toHaveBeenCalledTimes(4);
});
