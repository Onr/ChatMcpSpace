const { parseArgs, pruneAuthEvents } = require('../../scripts/prune_auth_events');

describe('prune_auth_events', () => {
  test('defaults keep successes 30 days and other events 90 days', () => {
    expect(parseArgs([])).toEqual({ successDays: 30, otherDays: 90, batchSize: 10000, dryRun: false });
    expect(parseArgs(['--success-days', '0.5', '--batch-size', '500', '--dry-run']))
      .toMatchObject({ successDays: 0.5, batchSize: 500, dryRun: true });
  });

  test.each([[['--success-days', '-1']], [['--batch-size', '0']], [['--other-days']], [['--nope']]])(
    'rejects invalid arguments %j', (argv) => {
      expect(() => parseArgs(argv)).toThrow();
    });

  test('deletes in batches until a short batch, per event class', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const result = await pruneAuthEvents(query, { batchSize: 2 });
    expect(result).toEqual({ dryRun: false, authSuccess: 3, other: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    const [successSql, successParams] = query.mock.calls[0];
    expect(successParams).toEqual([30, 2]);
    expect(successSql).toMatch(/event_type = 'auth_success'/);
    expect(successSql).toMatch(/MAX\(created_at\) AS newest_at/);
    expect(successSql).toMatch(/e\.created_at < newest\.newest_at/);
    const [otherSql, otherParams] = query.mock.calls[2];
    expect(otherParams).toEqual([90, 2]);
    expect(otherSql).toMatch(/event_type <> 'auth_success'/);
  });

  test('dry run only counts', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: 7 }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });
    await expect(pruneAuthEvents(query, { dryRun: true })).resolves
      .toEqual({ dryRun: true, authSuccess: 7, other: 1 });
    query.mock.calls.forEach(([sql]) => expect(sql).not.toMatch(/DELETE/));
  });
});
