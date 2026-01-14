const express = require('express');
const request = require('supertest');

describe('CSRF middleware', () => {
  afterEach(() => {
    jest.resetModules();
    delete process.env.CSRF_TOKEN_TTL_MS;
  });

  function buildApp({ sessionToken, sessionIssuedAt } = {}) {
    const csrfMiddleware = require('../../src/middleware/csrfMiddleware');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { csrfToken: sessionToken, csrfTokenIssuedAt: sessionIssuedAt };
      next();
    });

    app.get('/form', csrfMiddleware.csrfProtection, (req, res) => {
      res.status(200).json({ csrfToken: res.locals.csrfToken });
    });

    app.post('/submit', csrfMiddleware.validateCsrfToken, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    app.post('/api/agent/messages', csrfMiddleware.validateCsrfToken, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    return { app, csrfMiddleware };
  }

  it('generates and attaches a CSRF token to session and locals', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/form').expect(200);
    expect(res.body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(res.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringMatching(/^csrfToken=/)])
    );
  });

  it('accepts a valid token from body', async () => {
    const { app } = buildApp({ sessionToken: 'token-123' });
    await request(app).post('/submit').send({ _csrf: 'token-123' }).expect(200);
  });

  it('supports double-submit cookie validation when session token is missing', async () => {
    const { app } = buildApp();
    await request(app)
      .post('/submit')
      .set('Cookie', 'csrfToken=token-123')
      .send({ _csrf: 'token-123' })
      .expect(200);
  });

  it('rejects missing tokens on state-changing methods', async () => {
    jest.doMock('../../src/utils/securityLogger', () => ({ logCsrfViolation: jest.fn() }));
    const { app } = buildApp({ sessionToken: 'token-123' });
    const res = await request(app).post('/submit').send({}).expect(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_MISSING');
  });

  it('rejects expired tokens', async () => {
    process.env.CSRF_TOKEN_TTL_MS = '1000';
    jest.doMock('../../src/utils/securityLogger', () => ({ logCsrfViolation: jest.fn() }));

    const { app } = buildApp({ sessionToken: 'token-123', sessionIssuedAt: Date.now() - 2000 });
    const res = await request(app).post('/submit').send({ _csrf: 'token-123' }).expect(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_EXPIRED');
  });

  it('rejects invalid tokens', async () => {
    jest.doMock('../../src/utils/securityLogger', () => ({ logCsrfViolation: jest.fn() }));
    const { app } = buildApp({ sessionToken: 'token-123' });
    const res = await request(app).post('/submit').send({ csrfToken: 'wrong' }).expect(403);
    expect(res.body.error.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('skips validation for API paths', async () => {
    const { app } = buildApp({ sessionToken: 'token-123' });
    await request(app).post('/api/agent/messages').send({}).expect(200);
  });
});
