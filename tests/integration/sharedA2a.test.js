const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const express = require('express');
const request = require('supertest');
const suite = process.env.SHARED_TEST_DATABASE_URL ? describe : describe.skip;
suite('shared A2A on isolated real PostgreSQL', () => {
  let admin, pool, schema, access, app, owner, member, caller, target, room, viewer, runtimeId;
  const id = () => crypto.randomUUID();
  const ciphertext = require('../../scripts/external-agent-bridge').seal('Encrypted shared task', crypto.randomBytes(32).toString('base64'));
  const query = (sql,args) => pool.query(sql,args);
  beforeAll(async () => {
    process.env.FEATURE_SHARED_CONVERSATIONS = 'true';
    schema = 'a2a_test_' + id().replace(/-/g,'');
    admin = new Pool({connectionString:process.env.SHARED_TEST_DATABASE_URL});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString:process.env.SHARED_TEST_DATABASE_URL, options:`-c search_path=${schema}`});
    await query(`CREATE TABLE agents(agent_id UUID PRIMARY KEY,user_id UUID,agent_name TEXT,agent_type TEXT DEFAULT 'standard', inter_agent_mode TEXT DEFAULT 'listen_all', last_seen_at TIMESTAMP, stop_requested_at TIMESTAMP);
      CREATE TABLE archived_agents(agent_id UUID);
      CREATE TABLE agent_chat_threads(conversation_id UUID,state TEXT);
      CREATE TABLE shared_runtimes(agent_id UUID,runtime_id UUID,capabilities JSONB);
      CREATE TABLE shared_conversations(id UUID PRIMARY KEY,agent_id UUID,owner_id UUID,rotation_required BOOLEAN DEFAULT FALSE);
      CREATE TABLE shared_members(conversation_id UUID,user_id UUID,status TEXT,expires_at TIMESTAMPTZ);
      CREATE TABLE shared_audit(conversation_id UUID,actor_id UUID,action TEXT);
      CREATE TABLE agent_groups(group_id UUID,group_name TEXT);
      CREATE TABLE agent_group_members(group_id UUID,agent_id UUID);
      CREATE TABLE agent_messages(agent_message_id UUID PRIMARY KEY,sender_agent_id UUID,recipient_agent_id UUID,content TEXT,encrypted BOOLEAN,priority INTEGER,created_at TIMESTAMP DEFAULT NOW(),read_at TIMESTAMP);
      CREATE TABLE attachments(attachment_id UUID PRIMARY KEY,agent_id UUID,content_type TEXT,file_name TEXT,size_bytes BIGINT,encrypted BOOLEAN,iv_base64 TEXT,auth_tag_base64 TEXT,storage_provider TEXT,storage_key TEXT,width INTEGER,height INTEGER,encryption_peer_id UUID);
      CREATE TABLE agent_message_attachments(agent_message_id UUID,attachment_id UUID,attachment_order INTEGER);
      CREATE TABLE messages(message_id UUID,agent_id UUID);
      CREATE TABLE message_attachments(message_id UUID,attachment_id UUID);
      CREATE TABLE user_messages(user_message_id UUID,agent_id UUID);
      CREATE TABLE user_message_attachments(user_message_id UUID,attachment_id UUID);`);
    await query(fs.readFileSync(path.join(__dirname,'../../src/db/migrations/060_shared_agent_a2a.sql'),'utf8'));
    jest.resetModules();
    jest.doMock('../../src/db/connection', () => ({query, getClient:()=>pool.connect(), pool}));
    jest.doMock('../../src/storage',()=>({initializeStorage:async()=>({name:'fixture',retrieve:async()=>Buffer.from('encrypted-file-bytes')})}));
    jest.doMock('../../src/middleware/authMiddleware',()=>({requireApiKey:(req,res,next)=>{req.user={userId:viewer};next();},attachUserFromSession:(_req,_res,next)=>next()}));
    jest.doMock('../../src/middleware/rateLimitMiddleware',()=>Object.fromEntries(['agentPollingRateLimiter','agentApiRateLimiter','agentMessageIngressRateLimiter','feedbackRateLimiter','userPollingRateLimiter'].map(k=>[k,(_req,_res,next)=>next()])));
    access=require('../../src/shared/a2aAccess');
    app=express();app.use(express.json());
    app.use((req,res,next)=>{req.user={userId:viewer};if(req.get('x-fixture-agent'))req.authContext={type:'agent_token',agentId:req.get('x-fixture-agent'),scopes:['agent.dm.read','agent.attachments.read']};next();});
    app.use('/api/agent',require('../../src/routes/agentApiRoutes'));
    app.use('/api/user/shared',require('../../src/shared/routes').users);
    app.use('/api/user',require('../../src/routes/userApiRoutes'));
  });
  afterAll(async()=>{if(pool)await pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}delete process.env.FEATURE_SHARED_CONVERSATIONS;});
  beforeEach(async()=>{
    await query('TRUNCATE agents,archived_agents,shared_conversations,shared_members,shared_audit,agent_messages,shared_runtimes,agent_chat_threads,attachments,agent_message_attachments');
    owner=id();member=id();caller=id();target=id();room=id();runtimeId=id();viewer=member;
    await query("INSERT INTO agents(agent_id,user_id,agent_name) VALUES($1,$2,'Same Name'),($3,$4,'Same Name')",[caller,member,target,owner]);
    await query('INSERT INTO shared_conversations(id,agent_id,owner_id) VALUES($1,$2,$3)',[room,target,owner]);
    await query("INSERT INTO shared_runtimes VALUES($1,$2,'{\"executionMode\":\"trusted\"}')",[target,runtimeId]);
    await query("INSERT INTO shared_members VALUES($1,$2,'active',NULL)",[room,member]);
  });
  const enable=()=>access.settings(owner,room,true);
  test('new shares deny agent messaging until the owner opts in',async()=>{
    expect(await access.peers(member,caller)).toEqual([]);await enable();
    expect((await access.peers(member,caller)).map(a=>a.agent_id)).toEqual([target]);
    expect((await access.peers(owner,target)).map(a=>a.agent_id)).toEqual([caller]);
  });
  test.each(['removed','pending','invited','recovering'])('%s members cannot delegate agents',async status=>{
    await enable();await query('UPDATE shared_members SET status=$1',[status]);expect(await access.peers(member,caller)).toEqual([]);
  });
  test('expired membership, key rotation, archive, and disabled modes each deny access',async()=>{
    await enable();
    for(const [deny,restore] of [
      ["UPDATE shared_members SET expires_at=NOW()-INTERVAL '1 minute'","UPDATE shared_members SET expires_at=NULL"],
      ['UPDATE shared_conversations SET rotation_required=TRUE','UPDATE shared_conversations SET rotation_required=FALSE'],
      ["UPDATE agents SET inter_agent_mode='groups'","UPDATE agents SET inter_agent_mode='listen_all'"],
      ["UPDATE shared_runtimes SET capabilities='{\"executionMode\":\"restricted\"}'","UPDATE shared_runtimes SET capabilities='{\"executionMode\":\"trusted\"}'"],
      [`INSERT INTO archived_agents VALUES('${target}')`,'DELETE FROM archived_agents'],
      [`INSERT INTO agent_chat_threads VALUES('${room}','preparing')`,'DELETE FROM agent_chat_threads'],
      [`INSERT INTO shared_runtimes VALUES('${caller}','${id()}','{\"executionMode\":\"restricted\"}')`,`DELETE FROM shared_runtimes WHERE agent_id='${caller}'`]]){
      await query(deny);expect(await access.peers(member,caller)).toEqual([]);await query(restore);
    }
  });
  test('a different user cannot impersonate the calling agent or change the owner switch',async()=>{
    await enable();expect(await access.peers(id(),caller)).toEqual([]);
    await expect(access.settings(member,room,false)).rejects.toMatchObject({status:404});
    const response=await request(app).put(`/api/user/shared/${room}/agent-messaging`).send({enabled:true});expect(response.status).toBe(404);
  });
  test('discovery exposes UUID addresses and separate encryption requirements',async()=>{
    await enable();const response=await request(app).get('/api/agent/discover').set('X-Agent-Name','Same Name');
    expect(response.status).toBe(200);expect(response.body.agents).toEqual(expect.arrayContaining([expect.objectContaining({agentId:target,address:target,shared:true,encryption:'shared_dm_password'})]));
  });
  async function send(extra={}) {return request(app).post('/api/agent/messages/direct').set('X-Agent-Name','Same Name').send({toAgentName:target,content:ciphertext,encrypted:true,priority:1,encryptionScope:'shared_dm_password',...extra});}
  test('cross-account encrypted delivery and replies use unambiguous IDs, then revocation denies unread delivery',async()=>{
    await enable();const sent=await send();expect(sent.status).toBe(201);
    viewer=owner;let inbox=await request(app).get('/api/agent/messages/direct?markRead=false').set('X-Agent-Name','Same Name').set('x-shared-runtime',runtimeId);
    expect(inbox.status).toBe(200);expect(inbox.body.messages[0]).toMatchObject({fromAgent:caller,fromAgentName:'Same Name',shared:true,content:ciphertext});
    await access.settings(owner,room,false);
    inbox=await request(app).get('/api/agent/messages/direct?markRead=false').set('X-Agent-Name','Same Name').set('x-shared-runtime',runtimeId);expect(inbox.body.messages).toEqual([]);
    viewer=member;expect((await send()).status).toBe(400);
  });
  test('account-key payloads and plaintext cannot cross account boundaries',async()=>{
    await enable();expect((await send({encryptionScope:undefined})).status).toBe(400);
    expect((await send({encrypted:false})).status).toBe(400);
    expect((await send({content:'plain text despite the encryption flag'})).status).toBe(400);
    expect((await query('SELECT * FROM agent_messages')).rows).toEqual([]);
  });
  test('shared attachments require the correct encryption audience and current membership',async()=>{
    await enable(); const attachment=id();
    await query("INSERT INTO attachments(attachment_id,agent_id,content_type,file_name,size_bytes,encrypted,iv_base64,auth_tag_base64,encryption_peer_id) VALUES($1,$2,'application/pdf','shared.pdf',20,TRUE,$3,$4,$5)", [attachment,caller,Buffer.alloc(12).toString('base64'),Buffer.alloc(16).toString('base64'),target]);
    const sent=await send({attachmentIds:[attachment]});expect(sent.status).toBe(201);
    viewer=owner;
    const inbox=await request(app).get('/api/agent/messages/direct?markRead=false').set('X-Agent-Name','Same Name').set('x-shared-runtime',runtimeId);
    expect(inbox.body.messages[0].attachments[0].attachmentId).toBe(attachment);
    await request(app).get(`/api/agent/attachments/${attachment}/metadata`).set('x-fixture-agent',target).set('x-shared-runtime',runtimeId).expect(200);
    const file=await request(app).get(`/api/agent/attachments/${attachment}`).set('x-fixture-agent',target).set('x-shared-runtime',runtimeId).expect(200);
    expect(file.body).toEqual(Buffer.from('encrypted-file-bytes'));
    await access.settings(owner,room,false);
    await request(app).get(`/api/agent/attachments/${attachment}/metadata`).set('x-fixture-agent',target).set('x-shared-runtime',runtimeId).expect(404);
    await request(app).get(`/api/agent/attachments/${attachment}`).set('x-fixture-agent',target).set('x-shared-runtime',runtimeId).expect(404);
  });
  test('visualization exposes authorized cross-account metadata only, with no ciphertext',async()=>{
    await enable();expect((await send()).status).toBe(201);
    let response=await request(app).get('/api/user/agent-messages');
    expect(response.status).toBe(200);expect(response.body.connections).toHaveLength(1);
    expect(response.body.connections[0].lastSenderId).toBe(caller);expect(response.body.messages[0].content).toBeNull();
    viewer=id();response=await request(app).get('/api/user/agent-messages');expect(response.body.connections).toEqual([]);
    viewer=member;await access.settings(owner,room,false);
    response=await request(app).get('/api/user/agent-messages');expect(response.body.connections).toEqual([]);
  });
  test('owner switch changes are audited and type checked',async()=>{
    viewer=owner;
    expect((await request(app).put(`/api/user/shared/${room}/agent-messaging`).send({enabled:'true'})).status).toBe(400);
    expect((await request(app).put(`/api/user/shared/${room}/agent-messaging`).send({enabled:true})).body.enabled).toBe(true);
    expect((await query('SELECT action FROM shared_audit')).rows[0].action).toBe('a2a_enabled');
  });
});
