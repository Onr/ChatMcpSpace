const express = require('express');
const request = require('supertest');

describe('errorHandler.handleDatabaseError', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildApp({ error, operation } = {}) {
    const { handleDatabaseError } = require('../../src/utils/errorHandler');

    const app = express();
    app.get('/db-error', (_req, res) => {
      handleDatabaseError(res, error, operation);
    });

    return app;
  }

  it('maps users_email_key unique violations to DUPLICATE_EMAIL', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '23505', constraint: 'users_email_key' },
      operation: 'create user',
    });
    const res = await request(app).get('/db-error').expect(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('maps user_responses_message_id_key unique violations to DUPLICATE_RESPONSE', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '23505', constraint: 'user_responses_message_id_key' },
      operation: 'create response',
    });
    const res = await request(app).get('/db-error').expect(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESPONSE');
  });

  it('maps generic unique violations to DATABASE_ERROR', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '23505', constraint: 'other_unique' },
      operation: 'insert row',
    });
    const res = await request(app).get('/db-error').expect(409);
    expect(res.body.error.code).toBe('DATABASE_ERROR');
    expect(res.body.error.message).toMatch(/duplicate/i);
  });

  it('maps foreign key violations to 400/VALIDATION_ERROR', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '23503' },
      operation: 'insert row',
    });
    const res = await request(app).get('/db-error').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/related record not found/i);
  });

  it('maps not-null violations to 400/VALIDATION_ERROR', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '23502' },
      operation: 'insert row',
    });
    const res = await request(app).get('/db-error').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/required field/i);
  });

  it('maps invalid text representations to 400/VALIDATION_ERROR', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '22P02' },
      operation: 'parse id',
    });
    const res = await request(app).get('/db-error').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/invalid data format/i);
  });

  it('maps too-long strings to 400/VALIDATION_ERROR', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '22001' },
      operation: 'insert row',
    });
    const res = await request(app).get('/db-error').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/maximum length/i);
  });

  it('falls back to 500/DATABASE_ERROR for unknown codes and includes the operation in the message', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({
      error: { code: '99999' },
      operation: 'mystery op',
    });
    const res = await request(app).get('/db-error').expect(500);
    expect(res.body.error.code).toBe('DATABASE_ERROR');
    expect(res.body.error.message).toMatch(/mystery op/);
  });
});

