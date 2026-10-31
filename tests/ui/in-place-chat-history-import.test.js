/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const script = fs.readFileSync(path.join(__dirname, '../../public/js/chat-history-import.js'), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
const importId = '22222222-2222-4222-8222-222222222222';
function response(body, status=200) { return { ok:status<300,status,json:async()=>body }; }
function tick() { return new Promise(resolve=>setTimeout(resolve,5)); }


test('a participant count opens the same sharing controls with a read-only audience for members', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites"><input id="shareInviteEmail"></div><div id="shareGuestControls"></div><button id="shareInviteSubmit"></button><button id="shareExistingChatPrepare"></button></div><button id="headerShareExistingChatBtn" hidden></button><button id="selectedChatContextStatus"><svg></svg><span>3</span></button>`;
  window.DashboardHelpers = { getSelectedAgentIdentity: () => ({ agentId: id, conversationId: id, mode: 'shared', role: 'participant' }) };
  window.fetch = jest.fn(async url => {
    if (url === `/api/user/shared/${id}`) return response({ members: [
      { display_name: 'Host', role: 'owner', status: 'active' }, { display_name: 'Reviewer', status: 'active' }
    ], guests: [{ display_name: 'Guest', status: 'active' }] });
    throw new Error(`Member must not request owner controls: ${url}`);
  });
  window.eval(script);
  const count = document.getElementById('selectedChatContextStatus');
  count.focus();
  count.click();
  await tick();
  expect(document.getElementById('shareExistingChatPreview').textContent).toBe('Host · OwnerReviewer · JoinedGuest · Joined');
  expect(document.getElementById('shareExistingChatInvites').hidden).toBe(true);
  expect(document.getElementById('shareGuestControls').hidden).toBe(true);
  expect(document.getElementById('shareExistingChatPrepare').hidden).toBe(true);
  expect(window.fetch).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.getElementById('shareExistingChatDialog').classList.contains('hidden')).toBe(true);
  expect(count.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(count);
});


test('ordinary dashboard Share flow previews, browser-reencrypts a source row, and activates the same conversation', async () => {
  document.body.innerHTML = `
    <div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button>
      <p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites" hidden></div>
      <button id="shareExistingChatPrepare"></button><input id="shareInviteEmail"><button id="shareInviteSubmit"></button><p id="shareInviteDelivery"></p><div id="shareInviteSignupResult" hidden><input id="shareInviteSignupLink"><button id="shareInviteSignupCopy"></button></div><div id="shareInviteList"></div>
    </div><button id="headerShareExistingChatBtn"></button><button id="selectedChatContextStatus"><svg></svg><span>3</span></button><textarea id="userMessageInput">unsent draft</textarea><div id="conversationArea"></div>`;
  window.crypto = webcrypto;
  window.csrfToken = 'csrf';
  const calls=[];
  const selected=[];
  let activeSelection = { agentId:id,agentName:'Mira',agentType:'standard',mode:'private',role:'owner' };
  let encryptedPayloadValue;
  window.DashboardHelpers = {
    getSelectedAgentIdentity:()=>activeSelection,
    getEncryptionKey:()=>null,
    selectChatContext:async context=>{ selected.push(context); activeSelection=context; }
  };
  window.InPlaceChat = {
    ensureIdentity:async()=>{},
    prepareOwnerShare:async context=>({ context,room:{ key_version:1 } }),
    encryptImportedPayload:async (_conversationId,value,keyVersion)=>{ encryptedPayloadValue=value; return { v:1,iv:'iv',data:'ciphertext-envelope',keyVersion }; },
    encryptImportedFile:async()=>new Uint8Array([1,2,3,4])
  };
  window.SharedCrypto = { b64:()=> 'AQIDBA==', bytes:()=>new Uint8Array([1,2,3,4]) };
  window.fetch = jest.fn(async (url, options={})=>{
    calls.push({url,options});
    if (url==='/api/user/chat-threads/resolve') return response({ conversationId:id,agentId:id,ownerId:'owner',state:'private' });
    if (url===`/api/user/chat-threads/${id}/share-preview`) return response({ conversationId:id,agentName:'Mira',includedMessages:1,excludedAttachments:0,sourceFingerprint:'source-fingerprint' });
    if (url===`/api/user/chat-threads/${id}/imports`) return response({ importId,conversationId:id,revision:1,state:'importing',expectedItems:1,importedItems:0,expectedFiles:1,importedFiles:0 });
    if (url===`/api/user/chat-threads/${id}/invitations` && options.method==='POST') return response({invitationId:'d91ee648-e242-4db7-a82a-0f9cad64dd93',recipientEmail:'new@example.com',deliveryState:'in_app_only'});
    if (url===`/api/user/chat-threads/${id}/invitations`) return response([]);
    if (url===`/api/user/shared/${id}`) return response({ members:[{ user_id:'66666666-6666-4666-8666-666666666666',role:'participant',status:'active',display_name:'Reviewer' }], guests:[] });
    if (url===`/api/user/shared/${id}/members/66666666-6666-4666-8666-666666666666` && options.method==='DELETE') return response({ok:true});
    if (url===`/api/user/chat-threads/imports/${importId}/source?offset=0&limit=40`) return response({items:[{sourceKind:'user_message',sourceId:'33333333-3333-4333-8333-333333333333',sourceFingerprint:'row-fingerprint',content:'private source',encrypted:false,metadata:{attachments:[{attachmentId:'44444444-4444-4444-8444-444444444444',fileName:'notes.txt',contentType:'text/plain',sizeBytes:4,encrypted:false}]}}],nextOffset:1,total:1});
    if (url==='/api/user/attachments/44444444-4444-4444-8444-444444444444') return { ok:true,status:200,arrayBuffer:async()=>new Uint8Array([9,8,7,6]).buffer };
    if (url===`/api/user/chat-threads/imports/${importId}/files/44444444-4444-4444-8444-444444444444`) return response({fileId:'55555555-5555-4555-8555-555555555555'});
    if (url===`/api/user/chat-threads/imports/${importId}/messages`) return response({importId,revision:1,state:'ready',expectedItems:1,importedItems:1});
    if (url===`/api/user/chat-threads/imports/${importId}/validate`) return response({state:'ready'});
    if (url===`/api/user/chat-threads/imports/${importId}/activate`) return response({state:'activated'});
    if (url===`/api/user/chat-threads/${id}`) return response({conversationId:id,agentId:id,mode:'shared',state:'shared',role:'owner',capabilities:{read:true,send:true}});
    throw new Error(`Unexpected request ${url}`);
  });
  window.eval(script);
  document.getElementById('headerShareExistingChatBtn').click();
  await tick();
  expect(document.getElementById('shareExistingChatPrepare').disabled).toBe(false);
  document.getElementById('shareInviteEmail').value = 'new@example.com';
  document.getElementById('shareExistingChatPrepare').click();
  for(let i=0;i<40 && !selected.length;i++) await tick();
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({conversationId:id,mode:'shared'});
  const chunk = calls.find(call=>call.url.endsWith('/messages') && call.options.method==='POST');
  expect(JSON.parse(chunk.options.body).items[0]).toMatchObject({sourceKind:'user_message',payload:{v:1,data:'ciphertext-envelope',keyVersion:1}});
  expect(chunk.options.body).not.toContain('private source');
  expect(JSON.parse(chunk.options.body).items[0].fileIds).toEqual([expect.any(String)]);
  expect(encryptedPayloadValue.text).toBe('private source');
  expect(encryptedPayloadValue.files).toEqual([{id:expect.any(String),name:'notes.txt',type:'text/plain',size:4}]);
  const upload = calls.find(call=>call.url.includes('/files/44444444-4444-4444-8444-444444444444'));
  expect(upload.options.body).toBeInstanceOf(FormData);
  expect(upload.options.body.get('targetFileId')).toBe(JSON.parse(chunk.options.body).items[0].fileIds[0]);
  expect(calls.find(call=>call.url===`/api/user/chat-threads/${id}/imports`).options.body).toContain('source-fingerprint');
  expect(document.getElementById('userMessageInput').value).toBe('unsent draft');
  for(let i=0;i<20 && document.getElementById('shareInviteSignupResult').hidden;i++) await tick();
  const invitePost = calls.filter(call=>call.url===`/api/user/chat-threads/${id}/invitations` && call.options.method==='POST');
  expect(invitePost).toHaveLength(1);
  expect(invitePost[0].options.body).toContain('new@example.com');
  expect(document.getElementById('shareInviteEmail').value).toBe('');
  expect(document.getElementById('shareInviteSignupResult').hidden).toBe(false);
  expect(document.getElementById('shareInviteSignupLink').value).toBe(`http://localhost/join/invitation/d91ee648-e242-4db7-a82a-0f9cad64dd93`);
  const countButton = document.getElementById('selectedChatContextStatus');
  countButton.focus();
  countButton.click();
  await tick();
  expect(document.getElementById('shareExistingChatDialog').classList.contains('hidden')).toBe(false);
  expect(countButton.getAttribute('aria-expanded')).toBe('true');
  expect(countButton.querySelector('svg')).not.toBeNull();
  expect(document.getElementById('shareExistingChatPrepare').hidden).toBe(true);
  expect(document.getElementById('shareExistingChatCancel').textContent).toBe('Done');
  expect(document.getElementById('shareInviteList').textContent).toContain('Reviewer · Joined');
  document.querySelector('#shareInviteList button[aria-label="Remove Reviewer"]').click();
  await tick();
  expect(calls.some(call=>call.url===`/api/user/shared/${id}/members/66666666-6666-4666-8666-666666666666` && call.options.method==='DELETE')).toBe(true);
});

test('Share stays disabled with runner guidance when the agent runtime is offline', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button>
    <p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><button id="shareExistingChatRetry" hidden></button><div id="shareExistingChatInvites" hidden></div>
    <button id="shareExistingChatPrepare"></button><input id="shareInviteEmail"><button id="shareInviteSubmit"></button><p id="shareInviteDelivery"></p><div id="shareInviteList"></div>
    </div><button id="headerShareExistingChatBtn"></button>`;
  window.DashboardHelpers = { getSelectedAgentIdentity:()=>({ agentId:id,agentName:'Mira',agentType:'standard',mode:'private',role:'owner' }) };
  window.fetch = jest.fn(async url=>{
    if (url==='/api/user/chat-threads/resolve') return response({ conversationId:id,agentId:id,ownerId:'owner',state:'private' });
    if (url===`/api/user/chat-threads/${id}/share-preview`) return response({ conversationId:id,agentName:'Mira',includedMessages:1,excludedAttachments:0,runtimeReady:false });
    throw new Error(`Unexpected request ${url}`);
  });
  window.eval(script);
  document.getElementById('headerShareExistingChatBtn').click();
  await tick();
  expect(document.getElementById('shareExistingChatPrepare').disabled).toBe(true);
  expect(document.getElementById('shareExistingChatStatus').textContent).toContain('Start or update this agent');
  expect(document.getElementById('shareRuntimeRecovery').textContent).toContain('you do not need a second runner');
  expect(document.getElementById('shareRuntimeRecovery').textContent).toContain('Native Windows agents currently support private chats only');
  expect(document.getElementById('shareInviteSubmit').disabled).toBe(false);
  document.getElementById('shareInviteEmail').value = 'later@example.com';
  document.getElementById('shareInviteSubmit').click();
  await tick();
  expect(document.getElementById('shareInviteDelivery').textContent).toContain('later@example.com will be invited');
  expect(window.fetch.mock.calls.some(([url])=>url.includes('/invitations'))).toBe(false);
});

test('a delayed private preview cannot populate the Share panel after selection changes', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites" hidden></div><button id="shareInviteSubmit"></button><button id="shareExistingChatPrepare" disabled></button></div><button id="headerShareExistingChatBtn"></button>`;
  let selection = { agentId:id, agentName:'Mira', agentType:'standard', mode:'private' };
  let finishResolve;
  window.DashboardHelpers = { getSelectedAgentIdentity:()=>selection };
  window.fetch = jest.fn(()=>new Promise(resolve=>{ finishResolve=resolve; }));
  window.eval(script);
  document.getElementById('headerShareExistingChatBtn').click();
  await tick();
  selection = { agentId:'99999999-9999-4999-8999-999999999999', agentName:'Other', agentType:'standard', mode:'private' };
  finishResolve(response({conversationId:id,agentId:id,ownerId:'owner',state:'private'}));
  await tick();
  expect(document.getElementById('shareExistingChatPreview').textContent).toBe('');
  expect(document.getElementById('shareExistingChatPrepare').disabled).toBe(true);
});

test('the owner can set a strong optional guest passphrase without putting it in the link', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites" hidden></div><button id="shareInviteSubmit"></button><button id="shareExistingChatPrepare" disabled></button><div id="shareGuestControls" hidden><input id="shareGuestPasscode"><button id="shareGuestPasscodeGenerate"></button><button id="shareGuestPasscodeReveal"></button><button id="shareGuestPasscodeCopy"></button><button id="shareGuestLinkCreate"></button><p id="shareGuestLinkStatus"></p><div id="shareGuestLinkResult" hidden><input id="shareGuestLinkValue"><button id="shareGuestLinkCopy"></button></div></div></div><button id="headerShareExistingChatBtn"></button>`;
  window.csrfToken='csrf';
  window.DashboardHelpers={getSelectedAgentIdentity:()=>({agentId:id,agentName:'Mira',agentType:'standard',mode:'shared',role:'owner',conversationId:id})};
  const calls=[];
  window.fetch=jest.fn(async (url,options={})=>{
    calls.push({url,options});
    if(url===`/api/user/chat-threads/${id}/invitations`) return response([]);
    if(url===`/api/user/shared/${id}`) return response({members:[],guests:[]});
    if(url==='/api/user/shared/guest-shares' && options.method==='GET') return response([]);
    if(url==='/api/user/shared/guest-shares' && options.method==='POST') return response({shareId:'share-1',linkSecret:'one-time-secret'});
    throw new Error(`Unexpected request ${url}`);
  });
  window.eval(script);
  document.getElementById('headerShareExistingChatBtn').click();
  for (let index = 0; index < 20 && document.getElementById('shareGuestLinkCreate').disabled; index += 1) await tick();
  document.getElementById('shareGuestPasscode').value='CorrectHorseBatteryStaple42';
  document.getElementById('shareGuestLinkCreate').click();
  await tick();
  const create=calls.find(call=>call.options.method==='POST');
  expect(JSON.parse(create.options.body)).toMatchObject({conversationId:id,roomMode:'common',password:'CorrectHorseBatteryStaple42'});
  expect(document.getElementById('shareGuestLinkValue').value).toBe('http://localhost/guest#one-time-secret');
  expect(document.getElementById('shareGuestLinkValue').value).not.toContain('CorrectHorseBatteryStaple42');
});

test('guest-link discovery is bound to the selected conversation when switching agents', async () => {
  const agentA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const agentB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><h2 id="shareExistingChatTitle"></h2><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites" hidden><input id="shareInviteEmail"><button id="shareInviteSubmit"></button><p id="shareInviteDelivery"></p><div id="shareInviteSignupResult" hidden><input id="shareInviteSignupLink"></div><div id="shareInviteList"></div></div><div id="shareGuestControls" hidden><input id="shareGuestPasscode"><input id="shareGuestExpiresAt"><button id="shareGuestLinkCreate" disabled>Create guest link</button><p id="shareGuestLinkStatus"></p><div id="shareGuestLinkResult" hidden><input id="shareGuestLinkValue"></div><button id="shareGuestLinkDisable" hidden></button></div><button id="shareExistingChatPrepare"></button></div><button id="headerShareExistingChatBtn"></button>`;
  let selected = { agentId: agentA, agentName: 'Agent A', agentType: 'standard', mode: 'shared', role: 'owner', conversationId: 'room-a' };
  window.DashboardHelpers = { getSelectedAgentIdentity: () => selected };
  const calls = [];
  window.fetch = jest.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/user/shared/guest-shares' && options.method !== 'POST') return response([{ shareId: 'share-a', room_mode: 'common', agents: [{ agent_id: agentA, room_id: 'room-a' }] }]);
    if (url === '/api/user/shared/guest-shares' && options.method === 'POST') return response({ shareId: 'share-b', linkSecret: 'secret-b' });
    if (url === '/api/user/chat-threads/room-a/invitations') return response([]);
    if (url === '/api/user/shared/room-a') return response({ members: [], guests: [] });
    if (url === '/api/user/chat-threads/room-b/invitations') return response([]);
    if (url === '/api/user/shared/room-b') return response({ members: [], guests: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  window.confirm = jest.fn(() => true);
  window.eval(script);
  const trigger = document.getElementById('headerShareExistingChatBtn');
  trigger.click();
  for (let index = 0; index < 20 && document.getElementById('shareGuestLinkCreate').disabled; index += 1) await tick();
  document.getElementById('shareExistingChatClose').click();
  selected = { agentId: agentB, agentName: 'Agent B', agentType: 'standard', mode: 'shared', role: 'owner', conversationId: 'room-b' };
  trigger.click();
  await tick();
  expect(document.getElementById('shareExistingChatTitle').textContent).toBe('Share Agent B');
  expect(document.getElementById('shareGuestLinkCreate').textContent).toBe('Create guest link');
  document.getElementById('shareGuestLinkCreate').click();
  await tick();
  expect(calls.some(call => call.url.endsWith('/share-a') && call.options.method === 'PATCH')).toBe(false);
  const create = calls.find(call => call.url === '/api/user/shared/guest-shares' && call.options.method === 'POST');
  expect(JSON.parse(create.options.body)).toMatchObject({ conversationId: 'room-b', agentIds: [agentB] });
  expect(window.confirm).not.toHaveBeenCalled();
});

test('opening sharing recovers a stale private selection when the server already has a shared conversation', async () => {
  document.body.innerHTML = `<div id="shareExistingChatDialog" class="hidden"><button id="shareExistingChatClose"></button><button id="shareExistingChatCancel"></button><p id="shareExistingChatStatus"></p><div id="shareExistingChatPreview"></div><div id="shareExistingChatInvites"><input id="shareInviteEmail"><button id="shareInviteSubmit"></button><div id="shareInviteList"></div></div><button id="shareExistingChatPrepare"></button></div><button id="headerShareExistingChatBtn"></button>`;
  let selected = { agentId: id, agentName: 'Mira', mode: 'private', role: 'owner' };
  window.DashboardHelpers = { getSelectedAgentIdentity: () => selected,
    selectChatContext: jest.fn(async context => { selected = context; }) };
  window.fetch = jest.fn(async url => {
    if (url.endsWith('/resolve')) return response({ agentId: id, conversationId: id, agentName: 'Mira', mode: 'shared', state: 'shared', role: 'owner' });
    if (url.endsWith('/invitations')) return response([]);
    return response({ room: { sharing_enabled: true }, members: [], guests: [] });
  });
  window.eval(script);
  document.getElementById('headerShareExistingChatBtn').click();
  await tick();
  expect(window.DashboardHelpers.selectChatContext).toHaveBeenCalledTimes(1);
  expect(document.getElementById('shareExistingChatPrepare').hidden).toBe(true);
  expect(document.getElementById('shareExistingChatStatus').textContent).not.toContain('not available');
  expect(document.getElementById('shareExistingChatInvites').hidden).toBe(false);
});
