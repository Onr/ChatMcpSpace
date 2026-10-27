const { newDb } = require('pg-mem');
const { listFeedback } = require('../../scripts/review-feedback');

test('future feedback reviews exclude closed records by default and retain their evidence in history', async () => {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const db = new Pool();
  memory.public.registerFunction({ name: 'octet_length', args: ['bytea'], returns: 'integer', implementation: bytes => bytes?.length ?? null });
  try {
    await db.query('CREATE TABLE feedback (feedback_id text, created_at timestamp, triage_status text, message text, triage_note text, image_content_type text, image_data bytea)');
    for (const status of ['new', 'in_progress', 'resolved', 'not_relevant']) {
      await db.query('INSERT INTO feedback (feedback_id, created_at, triage_status, message, triage_note) VALUES ($1, $2, $3, $4, $5)', [status, '2026-10-22', status, 'Feedback', 'Verification evidence']);
    }
    expect((await listFeedback(db)).map(row => row.triage_status).sort()).toEqual(['in_progress', 'new']);
    const history = await listFeedback(db, { all: true });
    expect(history).toHaveLength(4);
    expect(history.find(row => row.triage_status === 'resolved').triage_note).toBe('Verification evidence');
  } finally { await db.end(); }
});
