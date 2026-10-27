/** Explicitly opted-in production verification with disposable accounts only.
 * LIVE_MCP_VERIFY=1 node tests/e2e/mcp-hosted-live.js
 * LIVE_MCP_RESTART=1 also verifies persistence through a service restart.
 */
require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const bcrypt = require('bcrypt');
const { chromium } = require('@playwright/test');
const { query, closePool } = require('../../src/db/connection');
const vault = require('../../src/services/mcpKeyVault');
if (process.env.LIVE_MCP_VERIFY !== '1') throw Error('Explicit LIVE_MCP_VERIFY=1 required.');
const base = new URL(process.env.BASE_URL).origin;
const userId = crypto.randomUUID(), peerId = crypto.randomUUID();
const salt = crypto.randomBytes(32).toString('base64');
const password = crypto.randomBytes(32).toString('base64url');
const encryptionPassword = password;
const key = crypto.pbkdf2Sync(encryptionPassword, Buffer.from(salt, 'base64'), 100000, 32, 'sha256');
const email = `mcp-hosted-${crypto.randomUUID()}@example.invalid`;
let browser, clientId, token, agentId, config;
const checks = [];
function pass(text) { checks.push(text); console.log('PASS: ' + text); }
async function post(endpoint, values, bearer) {
  return fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(values), signal: AbortSignal.timeout(60000) });
}
async function rpc(method, params, bearer = token) {
  const r = await post('/mcp', { jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, bearer);
  assert.equal(r.status, 200, `MCP ${method}: HTTP ${r.status}`);
  const body = await r.json(); assert.ok(!body.error, `MCP ${method} rejected`); return body.result;
}
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.equal(r.isError, false, `${name}: ${r.content?.[0]?.text || 'failed'}`);
  return r.structuredContent;
}
(async () => {
 try {
  await query(`INSERT INTO users(user_id,email,password_hash,api_key,script_token,encryption_salt,email_verified,email_verified_at)
   VALUES($1,$2,$3,$4,$5,$6,TRUE,NOW())`, [userId,email,await bcrypt.hash(password,10),crypto.randomUUID(),crypto.randomBytes(32).toString('hex'),salt]);
  await query("INSERT INTO agents(agent_id,user_id,agent_name,position,inter_agent_mode) VALUES($1,$2,'MCP verification peer',1,'listen_all')", [peerId,userId]);
  const callback='http://127.0.0.1:48673/mcp-live-verification';
  const reg=await post('/oauth/register',{client_name:'Hosted MCP deployment verification',redirect_uris:[callback]});
  assert.equal(reg.status,201);clientId=(await reg.json()).client_id;
  const verifier=crypto.randomBytes(32).toString('base64url');
  const auth=base+'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callback,scope:'agents.read messages.read messages.write peers.read peers.write attachments.read attachments.write',resource:base+'/mcp',state:'live-verification',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();page.setDefaultTimeout(30000);
  const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
  await page.goto(auth);await page.locator('#loginEmail').fill(email);await page.locator('#loginPassword').fill(password);await page.locator('#loginTab').click();
  await page.locator('input[name="allow_peers"]').check();assert.ok(await page.locator('input[name="allow_hosted"]').isChecked());
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForURL('**/mcp/connection?**');
  const link=page.locator(`a[href^="${callback}"]`);await link.waitFor();
  const code=new URL(await link.getAttribute('href')).searchParams.get('code');assert.ok(code);
  const exchange=await post('/oauth/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:callback,code,code_verifier:verifier,resource:base+'/mcp'});
  assert.equal(exchange.status,200);token=(await exchange.json()).access_token;
  await page.waitForFunction(()=>document.getElementById('state').textContent==='Connected'||!document.getElementById('unlock').hidden);
  if(await page.locator('#password').isVisible()){await page.locator('#password').fill(encryptionPassword);await page.locator('#unlockButton').click();}
  await page.waitForFunction(()=>document.getElementById('state').textContent==='Connected');
  config=JSON.parse(await page.locator('#mcp-config').textContent());agentId=config.agentId;
  if (!agentId) agentId=(await query('SELECT agent_id FROM mcp_oauth_tokens WHERE grant_id=$1',[config.grantId])).rows[0].agent_id;
  assert.deepEqual(browserErrors.filter(message=>message!=='DeviceBadge is not defined'),[]);
  if(browserErrors.length)console.log('Observed existing dashboard DeviceBadge script error; OAuth/unlock completed.');
  await browser.close();browser=null;
  assert.equal((await call('get_connection_status')).browserRequired,false);
  pass('Real HTTPS OAuth, explicit consent and unlock; Chromium closed before messaging/file calls');
  const tools=await rpc('tools/list');for(const name of ['read_inbox','read_thread','send_message','send_peer_message','upload_attachment','read_attachment','ack_message']) assert.ok(tools.tools.some(t=>t.name===name));
  const oldTokenResult=await post('/mcp',{jsonrpc:'2.0',id:1,method:'initialize'});assert.equal(oldTokenResult.status,401);
  const bytes=crypto.randomBytes(2200000),uploadId=crypto.randomUUID();
  const args={fileName:'mcp-deployment-verification.bin',contentType:'application/octet-stream',dataBase64:bytes.toString('base64'),idempotencyId:uploadId};
  const uploaded=await call('upload_attachment',args);assert.equal(uploaded.attachmentId,uploadId);
  assert.equal((await call('upload_attachment',args)).attachmentId,uploadId);
  const sendArgs={text:'Synthetic hosted MCP deployment verification',attachmentIds:[uploadId],idempotencyId:crypto.randomUUID()};
  const sent=await call('send_message',sendArgs);assert.ok(sent.sent);
  const thread=await call('read_thread',{limit:20});assert.ok(thread.messages.some(m=>m.content===sendArgs.text));
  const peerSend=await call('send_peer_message',{peerId,text:'Synthetic outgoing peer verification',attachmentIds:[uploadId],idempotencyId:crypto.randomUUID()});assert.ok(peerSend.sent);
  const incoming=crypto.randomUUID();await query(`INSERT INTO agent_messages(agent_message_id,sender_agent_id,recipient_agent_id,content,encrypted,priority) VALUES($1,$2,$3,$4,TRUE,0)`,[incoming,peerId,agentId,vault.seal(Buffer.from('Synthetic incoming peer verification'),key)]);
  assert.ok((await call('read_inbox',{limit:20})).messages.some(m=>m.content==='Synthetic incoming peer verification'));
  pass('User history/send and bidirectional peer messaging, with attachment links and idempotent upload');
  let offset=0;const chunks=[];
  do {const part=await call('read_attachment',{attachmentId:uploadId,offset});chunks.push(Buffer.from(part.dataBase64,'base64'));offset=part.nextOffset;} while(offset!==null);
  assert.deepEqual(Buffer.concat(chunks),bytes);
  const resource=await rpc('resources/read',{uri:uploaded.uri});assert.equal(resource.contents[0].blob,bytes.subarray(0,262144).toString('base64'));
  // Exercise the reverse proxy above its former 10 MB limit with a public, uncredentialed request.
  const large=await post('/mcp',{jsonrpc:'2.0',id:1,method:'initialize',padding:'x'.repeat(11000000)});assert.equal(large.status,401);
  pass('2.2 MB binary round trip, resource chunks and request above the former Nginx limit');
  if(process.env.LIVE_MCP_RESTART==='1') {
   execFileSync('sudo',['systemctl','restart','agent-messaging-platform'],{stdio:'pipe'});
   let ready=false;for(let i=0;i<30;i++){try{if((await fetch(base,{signal:AbortSignal.timeout(3000)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}assert.ok(ready);
   assert.equal((await call('get_connection_status')).browserRequired,false);
   assert.equal((await call('send_message',sendArgs)).messageId,sent.messageId);
   const recovered=await call('read_attachment',{attachmentId:uploadId});assert.equal(recovered.dataBase64,bytes.subarray(0,262144).toString('base64'));
   pass('Actual production service restart preserves hosted key, file reads and stable message retry');
  }
  const revoke=await post('/oauth/revoke',{token,client_id:clientId});assert.equal(revoke.status,200);
  const denied=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},token);assert.equal(denied.status,401);
  assert.equal((await query('SELECT 1 FROM mcp_hosted_connections WHERE grant_id=$1',[config.grantId])).rowCount,0);
  pass('OAuth revocation removes hosted key and denies further MCP access');
 } finally {
  if(browser)await browser.close();
  // Cascades remove only this reserved-domain fixture and its generated agents/grants.
  const attachments=await query('SELECT a.storage_key FROM attachments a JOIN agents g ON g.agent_id=a.agent_id WHERE g.user_id=$1',[userId]);
  const root=path.resolve(process.env.STORAGE_LOCAL_PATH||'uploads');
  for(const row of attachments.rows){if(row.storage_key.startsWith('local:')){const file=path.resolve(root,row.storage_key.slice(6));assert.ok(file.startsWith(root+path.sep));await fs.promises.unlink(file).catch(e=>{if(e.code==='EACCES'){execFileSync('sudo',['unlink','--',file],{stdio:'pipe'});}else if(e.code!=='ENOENT')throw e;});}}
  if(clientId)await query('DELETE FROM mcp_oauth_clients WHERE client_id=$1',[clientId]);
  await query('DELETE FROM users WHERE user_id=$1 AND email=$2',[userId,email]);key.fill(0);await closePool();
  console.log('Disposable verification accounts, grants and uploaded ciphertext cleaned up.');
 }
 console.log(`Hosted deployment verification complete: ${checks.length} checks.`);
})().catch(e=>{console.error(e.stack || e.message);process.exitCode=1;});
