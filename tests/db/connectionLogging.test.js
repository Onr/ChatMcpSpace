const mockQuery = jest.fn();
const mockOn = jest.fn();
const mockLogDebug = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: mockQuery, on: mockOn })),
}));
jest.mock('../../src/utils/logger', () => ({
  logDebug: mockLogDebug,
  logWarn: mockLogWarn,
  logError: mockLogError,
}));

describe('database query logging', () => {
  beforeEach(() => {
    jest.resetModules();
    mockQuery.mockReset();
    mockLogDebug.mockReset();
    mockLogWarn.mockReset();
    mockLogError.mockReset();
    delete process.env.SLOW_QUERY_LOG_THRESHOLD_MS;
  });

  afterAll(() => {
    delete process.env.SLOW_QUERY_LOG_THRESHOLD_MS;
  });

  test('keeps routine query logs at debug level', async () => {
    mockQuery.mockResolvedValue({ rowCount: 2 });
    const { query } = require('../../src/db/connection');

    await query('SELECT 1');

    expect(mockLogDebug).toHaveBeenCalledWith('db.query', expect.objectContaining({ rows: 2 }));
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  test('warns for queries above the configured slow-query threshold', async () => {
    process.env.SLOW_QUERY_LOG_THRESHOLD_MS = '0';
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const { query } = require('../../src/db/connection');

    await query('SELECT 1');

    expect(mockLogWarn).toHaveBeenCalledWith('db.slow_query', expect.objectContaining({ rows: 1, thresholdMs: 0 }));
    expect(mockLogDebug).not.toHaveBeenCalled();
  });
});
