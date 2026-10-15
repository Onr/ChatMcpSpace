'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID: uid } = require('crypto');
const { Pool } = require('pg');
const { seedUser } = require('../utils/pgMemTestUtils');
const root = path.join(__dirname, '../..');
const migration = file => fs.readFileSync(path.join(root, 'src/db/migrations', file), 'utf8');
const sql = migration('048_enforce_guest_room_relationships.sql');
const retentionSql = migration('049_retain_guest_history_attribution.sql');
const revisionSql = migration('050_bind_guest_request_revisions.sql');

(process.env.SHARED_TEST_DATABASE_URL ? describe : describe.skip)('real PostgreSQL guest relationship constraints', () => {
  let admin, pool, schema, owners, agents, rooms, shares, guests;
  beforeEach(async () => {
    schema = 'guest_constraints_' + uid().replace(/-/g, '');
    admin = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.SHARED_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await pool.query(fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8'));
    for (const file of ['042_add_shared_conversations.sql', '043_add_agent_devices_and_share_grants.sql', '044_add_shared_task_context.sql', '045_add_guest_principals_and_membership.sql', '047_add_guest_separate_rooms.sql']) await pool.query(migration(file));
    owners = [await seedUser(pool.query.bind(pool), { email: 'constraint-owner@example.test' }), await seedUser(pool.query.bind(pool), { email: 'constraint-other@example.test' })];
    agents = [uid(), uid(), uid()]; rooms = [uid(), uid(), uid(), uid()]; shares = [uid(), uid(), uid()]; guests = [uid(), uid(), uid()];
    await pool.query(`INSERT INTO agents(agent_id,user_id,agent_name,position,allowed_permissions)
      VALUES($1,$4,'Common',0,'{}'),($2,$4,'Separate',1,'{}'),($3,$5,'Other owner',0,'{}')`, [...agents, owners[0].userId, owners[1].userId]);
    await pool.query(`INSERT INTO shared_conversations(id,agent_id,owner_id,title)
      VALUES($1,$5,$8,'Common'),($2,$6,$8,'Separate one'),($3,$6,$8,'Separate two'),($4,$7,$9,'Other owner')`, [...rooms, ...agents, owners[0].userId, owners[1].userId]);
    await pool.query(`INSERT INTO guest_shares(share_id,owner_id,token_hash,room_mode)
      VALUES($1,$4,'common-hash','common'),($2,$4,'separate-hash','separate'),($3,$5,'other-hash','separate')`, [...shares, owners[0].userId, owners[1].userId]);
    await pool.query(`INSERT INTO guest_share_agents(share_id,agent_id,room_id)
      VALUES($1,$4,$7),($2,$5,NULL),($3,$6,NULL)`, [...shares, ...agents, rooms[0]]);
    await pool.query(`INSERT INTO guest_principals(guest_id,share_id,display_name)
      VALUES($1,$4,'Common guest'),($2,$5,'Separate guest'),($3,$5,'Second separate guest')`, [...guests, shares[0], shares[1]]);
    await pool.query(`INSERT INTO guest_share_rooms(share_id,guest_id,agent_id,room_id)
      VALUES($1,$2,$4,$5),($1,$3,$4,$6)`, [shares[1], guests[1], guests[2], agents[1], rooms[1], rooms[2]]);
    await pool.query(`INSERT INTO shared_guest_members(conversation_id,share_id,guest_id)
      VALUES($1,$4,$6),($2,$5,$7),($3,$5,$8)`, [...rooms.slice(0, 3), shares[0], shares[1], ...guests]);
    await pool.query(sql);
  });
  afterEach(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const denied = promise => expect(promise).rejects.toMatchObject({ code: '23503' });

  test('request revision upgrade never promotes legacy guest history to current authority', async () => {
    const guestMessage = await retainedGuestHistory(), accountMessage = uid();
    await pool.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version)
      VALUES($1,$2,$3,'message','{}',1)`, [accountMessage, rooms[0], owners[0].userId]);
    const before = (await pool.query('SELECT id,payload,sender_guest_id,sender_user_id FROM shared_messages ORDER BY seq')).rows;
    await pool.query(revisionSql); await pool.query(revisionSql);
    expect((await pool.query('SELECT id,payload,sender_guest_id,sender_user_id FROM shared_messages ORDER BY seq')).rows).toEqual(before);
    expect((await pool.query('SELECT guest_share_revision FROM shared_messages WHERE id=$1', [guestMessage])).rows[0].guest_share_revision).toBe(0);
    expect((await pool.query('SELECT guest_share_revision FROM shared_messages WHERE id=$1', [accountMessage])).rows[0].guest_share_revision).toBeNull();
    await expect(pool.query('UPDATE shared_messages SET guest_share_revision=-1 WHERE id=$1', [guestMessage])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('UPDATE shared_messages SET guest_share_revision=1 WHERE id=$1', [accountMessage])).rejects.toMatchObject({ code: '23514' });
  });

  test('upgrade is additive and repeatable with existing common and separate memberships', async () => {
    await pool.query(sql);
    expect((await pool.query('SELECT guest_id FROM shared_guest_members')).rows).toHaveLength(3);
    expect((await pool.query('SELECT DISTINCT owner_id FROM guest_share_rooms')).rows).toEqual([{ owner_id: owners[0].userId }]);
    expect((await pool.query('SELECT allowed_permissions FROM agents')).rows.every(agent => JSON.stringify(agent.allowed_permissions) === '{}')).toBe(true);
  });

  test('rejects cross-owner agents, wrong-agent rooms and cross-share guest room mappings', async () => {
    await denied(pool.query('INSERT INTO guest_share_agents(share_id,agent_id) VALUES($1,$2)', [shares[1], agents[2]]));
    await denied(pool.query('INSERT INTO guest_share_agents(share_id,agent_id,room_id) VALUES($1,$2,$3)', [shares[1], agents[0], rooms[3]]));
    await denied(pool.query('INSERT INTO guest_share_rooms(share_id,guest_id,agent_id,room_id) VALUES($1,$2,$3,$4)', [shares[2], guests[1], agents[2], rooms[3]]));
    await denied(pool.query('UPDATE guest_share_rooms SET room_id=$1 WHERE guest_id=$2', [rooms[0], guests[1]]));
  });

  test('rejects another guest room and changes that orphan a common-room audience', async () => {
    await denied(pool.query('INSERT INTO shared_guest_members(conversation_id,share_id,guest_id) VALUES($1,$2,$3)', [rooms[2], shares[1], guests[1]]));
    await denied(pool.query("UPDATE guest_shares SET room_mode='separate' WHERE share_id=$1", [shares[0]]));
    const spare = uid();
    await pool.query("INSERT INTO shared_conversations(id,agent_id,owner_id,title) VALUES($1,$2,$3,'Spare')", [spare, agents[0], owners[0].userId]);
    await denied(pool.query('UPDATE guest_share_agents SET room_id=$1 WHERE share_id=$2', [spare, shares[0]]));
    await pool.query('DELETE FROM guest_shares WHERE share_id=$1', [shares[0]]);
    expect((await pool.query('SELECT guest_id FROM shared_guest_members WHERE share_id=$1', [shares[0]])).rows).toHaveLength(0);
  });

  async function retainedGuestHistory() {
    const messageId = uid();
    await pool.query(`INSERT INTO shared_messages(id,conversation_id,sender_guest_id,kind,payload,key_version)
      VALUES($1,$2,$3,'message','{}',1)`, [messageId, rooms[0], guests[0]]);
    await pool.query(`INSERT INTO shared_audit(conversation_id,actor_kind,actor_guest_id,action,subject_id)
      VALUES($1,'guest',$2,'guest_message',$3)`, [rooms[0], guests[0], messageId]);
    return messageId;
  }

  test('retained guest attribution blocks physical principal/share deletion with a foreign-key error', async () => {
    const messageId = await retainedGuestHistory();
    await pool.query(retentionSql);
    await pool.query(retentionSql);
    await expect(pool.query('DELETE FROM guest_principals WHERE guest_id=$1', [guests[0]])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query('DELETE FROM guest_shares WHERE share_id=$1', [shares[0]])).rejects.toMatchObject({ code: '23503' });
    expect((await pool.query('SELECT sender_guest_id FROM shared_messages WHERE id=$1', [messageId])).rows).toEqual([{ sender_guest_id: guests[0] }]);
    expect((await pool.query('SELECT actor_guest_id FROM shared_audit WHERE subject_id=$1', [messageId])).rows).toEqual([{ actor_guest_id: guests[0] }]);
  });

  test('guest audit attribution is retained even when no message refers to the principal', async () => {
    await pool.query(`INSERT INTO shared_audit(conversation_id,actor_kind,actor_guest_id,action)
      VALUES($1,'guest',$2,'guest_uploaded_file')`, [rooms[0], guests[0]]);
    await pool.query(retentionSql);
    await denied(pool.query('DELETE FROM guest_principals WHERE guest_id=$1', [guests[0]]));
    expect((await pool.query("SELECT actor_guest_id FROM shared_audit WHERE action='guest_uploaded_file'")).rows).toEqual([{ actor_guest_id: guests[0] }]);
  });

  test.each(['principal-first', 'room-first'])('a complete history purge permits %s transaction order', async order => {
    await retainedGuestHistory();
    await pool.query(retentionSql);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (order === 'principal-first') await client.query('DELETE FROM guest_principals WHERE guest_id=$1', [guests[0]]);
      await client.query('DELETE FROM shared_conversations WHERE id=$1', [rooms[0]]);
      if (order === 'room-first') await client.query('DELETE FROM guest_principals WHERE guest_id=$1', [guests[0]]);
      await client.query('DELETE FROM guest_shares WHERE share_id=$1', [shares[0]]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    expect((await pool.query('SELECT id FROM shared_messages')).rows).toHaveLength(0);
    expect((await pool.query('SELECT actor_guest_id FROM shared_audit')).rows).toHaveLength(0);
  });

  test('owner deletion cascades complete guest history without affecting another owner', async () => {
    await retainedGuestHistory();
    await pool.query(retentionSql);
    await pool.query('DELETE FROM users WHERE user_id=$1', [owners[0].userId]);
    expect((await pool.query('SELECT guest_id FROM guest_principals')).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM shared_messages')).rows).toHaveLength(0);
    expect((await pool.query('SELECT agent_id FROM agents')).rows).toEqual([{ agent_id: agents[2] }]);
    expect((await pool.query('SELECT id FROM shared_conversations')).rows).toEqual([{ id: rooms[3] }]);
  });

  test('retention migration preserves existing account, agent and guest sender identities', async () => {
    const guestMessage = await retainedGuestHistory(), userMessage = uid(), agentMessage = uid();
    await pool.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,kind,payload,key_version)
      VALUES($1,$2,$3,'message','{}',1)`, [userMessage, rooms[0], owners[0].userId]);
    await pool.query(`INSERT INTO shared_messages(id,conversation_id,sender_agent_id,kind,payload,key_version)
      VALUES($1,$2,$3,'message','{}',1)`, [agentMessage, rooms[0], agents[0]]);
    const before = (await pool.query('SELECT id,sender_user_id,sender_agent_id,sender_guest_id FROM shared_messages ORDER BY seq')).rows;
    await pool.query(retentionSql);
    await pool.query(retentionSql);
    expect((await pool.query('SELECT id,sender_user_id,sender_agent_id,sender_guest_id FROM shared_messages ORDER BY seq')).rows).toEqual(before);
    expect(before.map(row => row.id)).toEqual([guestMessage, userMessage, agentMessage]);
    const constraints = (await pool.query(`SELECT confdeltype,condeferrable,condeferred FROM pg_constraint
      WHERE conrelid IN ('shared_messages'::regclass,'shared_audit'::regclass)
      AND conname IN ('shared_messages_sender_guest_id_fkey','shared_audit_actor_guest_id_fkey')`)).rows;
    expect(constraints).toEqual([{ confdeltype: 'a', condeferrable: true, condeferred: true }, { confdeltype: 'a', condeferrable: true, condeferred: true }]);
  });
});
