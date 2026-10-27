const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { createTestDatabase, seedUser, applyLineageSchema, applyArchiveSchema } = require('../utils/pgMemTestUtils');

async function setup() {
  jest.resetModules();
  const { pool, query } = createTestDatabase();
  await applyLineageSchema(query);
  await applyArchiveSchema(query);
  const owner = await seedUser(query);
  const other = await seedUser(query, { email: 'other@example.test', apiKey: 'other-key', scriptToken: 'other-token' });
  const agentId = uuidv4();
  await query('INSERT INTO agents (agent_id, user_id, agent_name, position) VALUES ($1,$2,$3,$4)', [agentId, owner.userId, 'Alpha', 1]);
  jest.doMock('../../src/db/connection', () => ({ query, getClient: () => pool.connect(), pool }));
  const userRoutes = require('../../src/routes/agentBriefUserRoutes');
  const agentRoutes = require('../../src/routes/agentBriefAgentRoutes');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { userId: req.headers['x-test-user'] || owner.userId }; next(); });
  app.use('/api/user/agents', userRoutes);
  app.use('/api/agent/brief', agentRoutes);
  return { app, query, pool, owner, other, agentId };
}

const empty = { role: '', purpose: '', workspace: '', preferences: '', boundaries: '', instructions: '', references: '', goals: [], activeGoalId: null };
const off = { enabled: false, paused: false, goalId: null, maxRuns: 4, intervalMinutes: 30, expiresAt: null };

async function reportRunner(query, agentId, version = '1.5.27') {
  await query('UPDATE agents SET reported_cli_version=$2, reported_cli_version_at=NOW()::timestamp WHERE agent_id=$1', [agentId, version]);
}

describe('versioned agent identity', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  test('owner saves, history records changes, and another user cannot read or restore', async () => {
    const { app, pool, agentId, other } = await setup();
    const first = await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, displayName: 'Release guide', avatar: '🚀', role: 'Release assistant' }, policy: off }).expect(200);
    expect(first.body.revision).toBe(1);
    expect(first.body.changedFields).toContain('role');
    expect(first.body.changedFields).toContain('displayName');
    expect(first.body.document.avatar).toBe('🚀');
    const stale = await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, role: 'Monitor' }, policy: off }).expect(409);
    expect(stale.body.error.code).toBe('REVISION_CONFLICT');
    const second = await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 1, document: { ...empty, role: 'Reviewer' }, policy: off }).expect(200);
    expect(second.body.revision).toBe(2);
    const history = await request(app).get(`/api/user/agents/${agentId}/brief/history`).expect(200);
    expect(history.body.revisions.map(r => r.revision)).toEqual([2, 1]);
    await request(app).get(`/api/user/agents/${agentId}/brief`).set('x-test-user', other.userId).expect(404);
    await request(app).post(`/api/user/agents/${agentId}/brief/restore`).set('x-test-user', other.userId).send({ revision: 1, expectedRevision: 2 }).expect(404);
    const restored = await request(app).post(`/api/user/agents/${agentId}/brief/restore`).send({ revision: 1, expectedRevision: 2 }).expect(200);
    expect(restored.body).toMatchObject({ revision: 3, document: { displayName: 'Release guide', avatar: '🚀', role: 'Release assistant' }, policy: { enabled: false, paused: true } });
    await pool.end();
  });

  test('agent suggestion cannot change boundaries and requires owner acceptance', async () => {
    const { app, pool, agentId } = await setup();
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, boundaries: 'Ask before publishing' }, policy: off }).expect(200);
    await request(app).post('/api/agent/brief/suggestions').send({ agentName: 'Alpha', reason: 'I should publish', document: { ...empty, boundaries: 'Publish freely' } }).expect(400);
    const proposed = await request(app).post('/api/agent/brief/suggestions').send({ agentName: 'Alpha', reason: 'Clarify the role', document: { ...empty, boundaries: 'Ask before publishing', role: 'Release reviewer' } }).expect(201);
    expect((await request(app).get(`/api/user/agents/${agentId}/brief`).expect(200)).body.document.role).toBe('');
    await request(app).post(`/api/user/agents/${agentId}/brief/suggestions/${proposed.body.suggestionId}/decision`).send({ decision: 'accept' }).expect(200);
    expect((await request(app).get(`/api/user/agents/${agentId}/brief`).expect(200)).body).toMatchObject({ revision: 2, document: { role: 'Release reviewer', boundaries: 'Ask before publishing' } });
    const revised = await request(app).post('/api/agent/brief/suggestions').send({ agentName: 'Alpha', reason: 'Clarify the role again', document: { ...empty, boundaries: 'Ask before publishing', role: 'Suggested role' } }).expect(201);
    await request(app).post(`/api/user/agents/${agentId}/brief/suggestions/${revised.body.suggestionId}/decision`).send({ decision: 'accept', document: { ...empty, boundaries: 'Ask before publishing', role: 'Owner revised role' } }).expect(200);
    expect((await request(app).get(`/api/user/agents/${agentId}/brief`).expect(200)).body).toMatchObject({ revision: 3, document: { role: 'Owner revised role' } });
    await pool.end();
  });

  test('queued snapshots remain stable by default and can be deliberately updated', async () => {
    const { app, query, pool, agentId } = await setup();
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, role: 'First' }, policy: off }).expect(200);
    await query('INSERT INTO user_messages (agent_id, content, brief_snapshot) VALUES ($1,$2,$3::jsonb)', [agentId, 'queued', JSON.stringify({ revision: 1, document: { ...empty, role: 'First' }, policy: off })]);
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 1, document: { ...empty, role: 'Second' }, policy: off }).expect(200);
    let rows = await query('SELECT brief_snapshot FROM user_messages WHERE agent_id=$1', [agentId]);
    expect(rows.rows[0].brief_snapshot.revision).toBe(1);
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 2, document: { ...empty, role: 'Third' }, policy: off, applyQueued: true }).expect(200);
    rows = await query('SELECT brief_snapshot FROM user_messages WHERE agent_id=$1', [agentId]);
    expect(rows.rows[0].brief_snapshot.revision).toBe(3);
    await pool.end();
  });

  test('proactive activation fails closed until the runner can enforce it', async () => {
    const { app, pool, agentId } = await setup();
    const goalId = uuidv4();
    const response = await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, goals: [{ id: goalId, title: 'Check release' }], activeGoalId: goalId }, policy: { ...off, enabled: true, goalId, expiresAt: new Date(Date.now() + 86400000).toISOString() } }).expect(409);
    expect(response.body.error.code).toBe('WAKE_UNAVAILABLE');
    await pool.end();
  });

  test('automatic work cannot target a different goal from the active one', async () => {
    const { app, query, pool, agentId } = await setup();
    const { claimWake } = require('../../src/services/agentProactiveService');
    await reportRunner(query, agentId);
    await claimWake(agentId);
    const active = uuidv4();
    const other = uuidv4();
    const response = await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0,
      document: { ...empty, goals: [{ id: active, title: 'Active' }, { id: other, title: 'Other' }], activeGoalId: active },
      policy: { ...off, enabled: true, goalId: other, expiresAt: new Date(Date.now() + 3600000).toISOString() }
    }).expect(400);
    expect(response.body.error.message).toMatch(/active goal/i);
    await pool.end();
  });

  test('wake admission requires a recently reported supported local runner', async () => {
    const { app, query, pool, agentId } = await setup();
    await request(app).post('/api/agent/brief/wake/claim').send({ agentName: 'Alpha' }).expect(409);
    await reportRunner(query, agentId, '1.5.26');
    await request(app).post('/api/agent/brief/wake/claim').send({ agentName: 'Alpha' }).expect(409);
    await reportRunner(query, agentId);
    const offClaim = await request(app).post('/api/agent/brief/wake/claim').send({ agentName: 'Alpha' }).expect(200);
    expect(offClaim.body).toMatchObject({ admitted: false, reason: 'off' });
    expect((await request(app).get(`/api/user/agents/${agentId}/brief`).expect(200)).body.proactiveAvailable).toBe(true);
    await query('UPDATE agents SET reported_cli_version_at=$2 WHERE agent_id=$1', [agentId, new Date(Date.now() - 11 * 60 * 1000)]);
    await request(app).post('/api/agent/brief/wake/claim').send({ agentName: 'Alpha' }).expect(409);
    expect((await request(app).get(`/api/user/agents/${agentId}/brief`).expect(200)).body.proactiveAvailable).toBe(false);
    await pool.end();
  });

  test('supported runner reserves one turn, gives user messages priority, and respects pause', async () => {
    const { app, query, pool, agentId } = await setup();
    const { claimWake, completeWake } = require('../../src/services/agentProactiveService');
    expect((await claimWake(agentId)).reason).toBe('off');
    await reportRunner(query, agentId);
    const goalId = uuidv4();
    const expiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const enabled = { ...off, enabled: true, goalId, expiresAt: expiry };
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, goals: [{ id: goalId, title: 'Check release', finishedWhen: 'Checks pass' }], activeGoalId: goalId }, policy: enabled }).expect(200);
    await query('INSERT INTO user_messages (agent_id, content) VALUES ($1,$2)', [agentId, 'User work first']);
    expect((await claimWake(agentId)).reason).toBe('user_messages_first');
    await query('UPDATE user_messages SET read_at=NOW()::timestamp WHERE agent_id=$1', [agentId]);
    const first = await claimWake(agentId);
    expect(first).toMatchObject({ admitted: true, trigger: 'periodic', remainingRuns: 3, briefRevision: 1 });
    expect(first.prompt).toContain('Active goal: Check release');
    expect((await claimWake(agentId)).reason).toBe('run_in_progress');
    const finished = await completeWake(agentId, first.runId, { outcome: 'progress', reason: 'One check passed' });
    expect(finished.status).toBe('active');
    const second = await claimWake(agentId, { now: new Date(Date.parse(finished.nextWakeAt) + 1000) });
    expect(second.admitted).toBe(true);
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 1, document: { ...empty, goals: [{ id: goalId, title: 'Check release', finishedWhen: 'Checks pass' }], activeGoalId: goalId }, policy: { ...enabled, paused: true } }).expect(200);
    const afterPause = await completeWake(agentId, second.runId, { outcome: 'progress' });
    expect(afterPause).toMatchObject({ status: 'paused', nextWakeAt: null });
    expect((await claimWake(agentId)).reason).toBe('paused');
    await pool.end();
  });

  test('check once expires while offline and an unknown run is never replayed', async () => {
    const { app, query, pool, agentId } = await setup();
    const { claimWake } = require('../../src/services/agentProactiveService');
    await claimWake(agentId);
    await reportRunner(query, agentId);
    const goalId = uuidv4();
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, goals: [{ id: goalId, title: 'Inspect package' }], activeGoalId: goalId }, policy: off }).expect(200);
    await request(app).post(`/api/user/agents/${agentId}/brief/check-once`).send({}).expect(200);
    const first = await claimWake(agentId);
    expect(first.trigger).toBe('check_once');
    const later = await claimWake(agentId, { now: new Date(Date.now() + 3 * 60 * 60 * 1000) });
    expect(later).toMatchObject({ admitted: false, reason: 'off' });
    const activity = await request(app).get(`/api/user/agents/${agentId}/brief/activity`).expect(200);
    expect(activity.body.activity.some(item => item.event_type === 'outcome_unknown')).toBe(true);
    await pool.end();
  });

  test('timed sleep resumes when due, while event waits and repeated no-progress checks stay asleep', async () => {
    const { app, query, pool, agentId } = await setup();
    const { claimWake, completeWake } = require('../../src/services/agentProactiveService');
    await claimWake(agentId);
    await reportRunner(query, agentId);
    const goalId = uuidv4();
    const document = { ...empty, goals: [{ id: goalId, title: 'Watch release checks' }], activeGoalId: goalId };
    const policy = { ...off, enabled: true, goalId, maxRuns: 4, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() };
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document, policy }).expect(200);
    const first = await claimWake(agentId);
    const sleepUntil = new Date(Date.now() + 31 * 60 * 1000).toISOString();
    expect((await completeWake(agentId, first.runId, { outcome: 'sleep_until', sleepUntil, reason: 'Result is due then' })).status).toBe('sleeping');
    expect((await claimWake(agentId)).reason).toBe('not_due');
    const second = await claimWake(agentId, { now: new Date(Date.parse(sleepUntil) + 1000) });
    expect(second.admitted).toBe(true);
    expect((await completeWake(agentId, second.runId, { outcome: 'wait_event', reason: 'Waiting for CI result' })).status).toBe('waiting_event');
    expect((await claimWake(agentId, { now: new Date(Date.parse(sleepUntil) + 61 * 60 * 1000) })).reason).toBe('waiting_event');
    await pool.end();
  });

  test('two no-progress outcomes stop further automatic polling', async () => {
    const { app, query, pool, agentId } = await setup();
    const { claimWake, completeWake } = require('../../src/services/agentProactiveService');
    await claimWake(agentId);
    await reportRunner(query, agentId);
    const goalId = uuidv4();
    const document = { ...empty, goals: [{ id: goalId, title: 'Monitor package' }], activeGoalId: goalId };
    const policy = { ...off, enabled: true, goalId, expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() };
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document, policy }).expect(200);
    const first = await claimWake(agentId);
    expect((await completeWake(agentId, first.runId, { outcome: 'no_progress' })).status).toBe('active');
    const state = (await query('SELECT state FROM agent_briefs WHERE agent_id=$1', [agentId])).rows[0].state;
    await query('UPDATE agent_briefs SET state=$2::jsonb WHERE agent_id=$1', [agentId, JSON.stringify({ ...state, nextWakeAt: new Date(Date.now() - 1000).toISOString() })]);
    const second = await claimWake(agentId);
    expect(second.admitted).toBe(true);
    expect((await completeWake(agentId, second.runId, { outcome: 'no_progress' })).status).toBe('sleeping');
    expect((await claimWake(agentId)).reason).toBe('sleeping');
    await pool.end();
  });

  test('shared manager sees redacted fields and can edit goals only; participant is view-only', async () => {
    const { app, query, pool, agentId, other } = await setup();
    const participant = await seedUser(query, { email: 'viewer@example.test', apiKey: 'viewer-key', scriptToken: 'viewer-token' });
    await query('CREATE TABLE shared_conversations (id UUID PRIMARY KEY, agent_id UUID)');
    await query('CREATE TABLE shared_members (conversation_id UUID, user_id UUID, role TEXT, status TEXT)');
    const roomId = uuidv4();
    await query('INSERT INTO shared_conversations (id, agent_id) VALUES ($1,$2)', [roomId, agentId]);
    await query('INSERT INTO shared_members (conversation_id,user_id,role,status) VALUES ($1,$2,$3,$4)', [roomId, other.userId, 'manager', 'active']);
    await query('INSERT INTO shared_members (conversation_id,user_id,role,status) VALUES ($1,$2,$3,$4)', [roomId, participant.userId, 'participant', 'active']);
    const goalId = uuidv4();
    await request(app).put(`/api/user/agents/${agentId}/brief`).send({ expectedRevision: 0, document: { ...empty, role: 'Reviewer', workspace: '/private/path', privateFields: ['workspace'], goals: [{ id: goalId, title: 'Review' }], activeGoalId: goalId }, policy: off }).expect(200);
    const manager = await request(app).get(`/api/user/agents/${agentId}/brief`).set('x-test-user', other.userId).expect(200);
    expect(manager.body.document.workspace).toBe('');
    expect(manager.body.document).not.toHaveProperty('privateFields');
    expect(manager.body.permissions).toMatchObject({ editIdentity: false, editGoals: true, pause: true });
    const edited = await request(app).put(`/api/user/agents/${agentId}/brief`).set('x-test-user', other.userId).send({ expectedRevision: 1, document: { ...manager.body.document, role: 'Unauthorized rename', goals: [{ id: goalId, title: 'Review and report' }] }, policy: off }).expect(200);
    expect(edited.body.document).toMatchObject({ role: 'Reviewer', workspace: '', goals: [{ title: 'Review and report' }] });
    const history = await request(app).get(`/api/user/agents/${agentId}/brief/history`).set('x-test-user', other.userId).expect(200);
    expect(history.body.revisions.every(row => row.document.workspace === '')).toBe(true);
    await query('INSERT INTO agent_brief_activity (agent_id,event_type,detail) VALUES ($1,$2,$3::jsonb)', [agentId, 'run_finished', JSON.stringify({ outcome: 'blocked', reason: 'Private release target' })]);
    const managerActivity = await request(app).get(`/api/user/agents/${agentId}/brief/activity`).set('x-test-user', other.userId).expect(200);
    expect(JSON.stringify(managerActivity.body)).not.toContain('Private release target');
    const ownerActivity = await request(app).get(`/api/user/agents/${agentId}/brief/activity`).expect(200);
    expect(JSON.stringify(ownerActivity.body)).toContain('Private release target');
    const viewer = await request(app).get(`/api/user/agents/${agentId}/brief`).set('x-test-user', participant.userId).expect(200);
    expect(viewer.body.permissions).toMatchObject({ editIdentity: false, editGoals: false, history: false });
    await request(app).put(`/api/user/agents/${agentId}/brief`).set('x-test-user', participant.userId).send({ expectedRevision: 2, document: viewer.body.document, policy: off }).expect(403);
    await pool.end();
  });
});
