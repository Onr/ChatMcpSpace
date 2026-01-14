const express = require('express');
const request = require('supertest');

describe('Error middleware', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  function buildApp() {
    jest.doMock('../../src/utils/logger', () => ({
      logError: jest.fn(),
      logWarn: jest.fn(),
    }));

    const { globalErrorHandler, notFoundHandler } = require('../../src/middleware/errorMiddleware');

    const app = express();
    app.use(express.json());

    app.get('/throw/validation', (_req, _res, next) => {
      const err = new Error('bad input');
      err.name = 'ValidationError';
      next(err);
    });

    app.get('/throw/unauthorized', (_req, _res, next) => {
      const err = new Error('nope');
      err.name = 'UnauthorizedError';
      next(err);
    });

    app.get('/throw/forbidden', (_req, _res, next) => {
      const err = new Error('no access');
      err.name = 'ForbiddenError';
      next(err);
    });

    app.get('/throw/generic', (_req, _res, next) => {
      const err = new Error('boom');
      err.stack = 'STACK_SHOULD_NOT_LEAK';
      next(err);
    });

    app.use(notFoundHandler);
    app.use(globalErrorHandler);

    return { app };
  }

  it('returns ENDPOINT_NOT_FOUND for missing API endpoints', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('ENDPOINT_NOT_FOUND');
    expect(res.body.error.message).toMatch(/API endpoint not found/i);
  });

  it('maps ValidationError to 400/VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/throw/validation').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('bad input');
  });

  it('maps UnauthorizedError to 401/AUTH_INVALID_CREDENTIALS', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/throw/unauthorized').expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(res.body.error.message).toBe('nope');
  });

  it('maps ForbiddenError to 403/FORBIDDEN_RESOURCE', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/throw/forbidden').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN_RESOURCE');
    expect(res.body.error.message).toBe('no access');
  });

  it('does not leak error stacks in JSON responses', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/throw/generic').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.text).not.toContain('STACK_SHOULD_NOT_LEAK');
    expect(res.body.error.stack).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  });
});

