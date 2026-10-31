const { providerFailure, providerFailureMessage, providerHttpError } = require('../../scripts/external-agent-bridge');

const now = Date.parse('2030-04-03T06:00:00Z');

test('preserves the actual Antigravity quota cause and reset time without copying diagnostics', () => {
  const diagnostics = 'private prompt and token=DO_NOT_SHARE\nAGY_ERROR: ' + JSON.stringify({
    short_error: 'Individual quota reached. Resets in 38h2m6s.', status: 'RESOURCE_EXHAUSTED', error_code: 429
  });
  const failure = providerFailure(new Error('Provider execution did not complete successfully'), diagnostics, { now });
  expect(failure).toEqual({ category: 'quota', retryAt: '2030-04-04T20:02:06.000Z' });
  const notice = providerFailureMessage(failure);
  expect(notice).toContain('usage or credit limit');
  expect(notice).toContain('2030-04-04 20:02:06 UTC');
  expect(notice).toContain('preserved');
  expect(JSON.stringify(failure) + notice).not.toMatch(/DO_NOT_SHARE|private prompt|AGY_ERROR/);
});

test.each([
  [401, '{"error":{"type":"authentication_error","message":"private"}}', 'authentication'],
  [429, '{"error":{"code":"insufficient_quota"}}', 'quota'],
  [429, '{"error":{"type":"rate_limit_error"}}', 'rate_limit'],
  [404, '{"error":{"code":"model_not_found"}}', 'model_unavailable'],
  [400, 'invalid model selection: model conflicts with --effort=medium', 'model_configuration'],
  [400, 'maximum context length exceeded', 'context_limit'],
  [403, 'permission denied', 'permission'],
  [503, 'private upstream details', 'unavailable'],
  [undefined, 'jetski: no output produced — a tool required the command permission; auto-denied', 'permission'],
  [undefined, 'fetch failed: ECONNRESET', 'network'],
  [undefined, 'unfamiliar future provider failure', 'unknown']
])('classifies status %s / %s as %s', (status, diagnostics, category) => {
  expect(providerFailure({ status }, diagnostics).category).toBe(category);
});

test('Retry-After works with seconds and dates; invalid or implausible retry times stay out of notices', async () => {
  expect(providerFailure({ status: 429 }, '', { now, retryAfter: '90' }).retryAt).toBe('2030-04-03T06:01:30.000Z');
  expect(providerFailure({ status: 429 }, '', { now, retryAfter: 'Wed, 03 Apr 2030 06:01:00 GMT' }).retryAt).toBe('2030-04-03T06:01:00.000Z');
  expect(providerFailure({}, 'reset in 999999d private', { now }).retryAt).toBeUndefined();
  expect(providerFailure({}, 'retry after javascript:private', { now }).retryAt).toBeUndefined();
  const error = await providerHttpError(new Response('{"error":{"code":"insufficient_quota","message":"SECRET"}}', { status: 429, headers: { 'retry-after': '60' } }));
  expect(error.providerFailure.category).toBe('quota');
  expect(JSON.stringify(error)).not.toContain('SECRET');
});

test('shared notices omit owner model choices and private metadata; unknown errors remain actionable', () => {
  const failure = { category: 'quota', alternatives: ['future-model-low', 'bad\nSECRET'], modelsRefreshed: true };
  expect(providerFailureMessage(failure)).toContain('`future-model-low`');
  expect(providerFailureMessage(failure)).toContain('have not been tested');
  const shared = providerFailureMessage(failure, { shared: true });
  expect(shared).toContain('agent owner');
  expect(shared).not.toMatch(/future-model|SECRET/);
  expect(providerFailureMessage({ category: 'new_provider_code', raw: 'SECRET' })).toContain('runner log');
  expect(providerFailureMessage({ category: 'timeout' }, { timeoutMs: 1800000 })).toContain('30-minute time limit');
});

test('structured usage limits and RetryInfo remain useful as provider error formats change', () => {
  const quota = JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: (now + 3600000) / 1000 } });
  expect(providerFailure({}, quota, { now })).toEqual({ category: 'quota', retryAt: '2030-04-03T07:00:00.000Z' });
  const throttle = JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }] } });
  expect(providerFailure({}, throttle, { now })).toEqual({ category: 'rate_limit', retryAt: '2030-04-03T06:00:31.000Z' });
});
