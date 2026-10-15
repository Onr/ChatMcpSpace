'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class HistoryImportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function check(ok, status, message) { if (!ok) throw new HistoryImportError(status, message); }
function uuid(value) { check(typeof value === 'string' && UUID.test(value), 400, 'Invalid identifier'); return value; }
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

async function sourceRows(client, agentId, boundary, offset = 0, limit = 100, selection = null, ownerRoom = null) {
  const hiddenColumn = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='messages' AND column_name='hidden_from_agent'`);
  const hiddenExpr = hiddenColumn.rows.length ? 'm.hidden_from_agent' : 'FALSE';
  const userHiddenColumn = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='user_messages' AND column_name='hidden_from_agent'`);
  const userHiddenExpr = userHiddenColumn.rows.length ? 'um.hidden_from_agent' : 'FALSE';
  const archiveTable = (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='archived_messages'`)).rows.length > 0;
  const messageArchiveFilter = archiveTable
    ? 'AND NOT EXISTS (SELECT 1 FROM archived_messages am WHERE am.message_id=m.message_id)' : '';
  const userArchiveFilter = archiveTable
    ? 'AND NOT EXISTS (SELECT 1 FROM archived_messages am WHERE am.user_message_id=um.user_message_id)' : '';
  const messageSelection = selection ? "AND $5='message' AND m.message_id=$6" : '';
  const userSelection = selection ? "AND $5='user_message' AND um.user_message_id=$6" : '';
  const dmTable = ownerRoom && (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='agent_messages'`)).rows.length > 0;
  const result = await client.query(`
    SELECT source_kind,source_id,kind,content,encrypted,created_at,metadata
    FROM (
      SELECT 'message'::text AS source_kind,m.message_id AS source_id,
        CASE WHEN m.message_type='question' THEN 'question' ELSE 'message' END AS kind,
        m.content,m.encrypted,m.created_at,
        jsonb_build_object('priority',m.priority,'urgent',m.urgent,'allowFreeResponse',m.allow_free_response,
          'freeResponseHint',m.free_response_hint,
          'hiddenFromAgent',COALESCE(${hiddenExpr},FALSE),
          'options',COALESCE((SELECT jsonb_agg(jsonb_build_object('optionId',o.option_id,'text',o.option_text,'benefits',o.benefits,'downsides',o.downsides,'default',o.is_default) ORDER BY o.option_order) FROM question_options o WHERE o.message_id=m.message_id),'[]'::jsonb),
          'response', (SELECT jsonb_build_object('freeResponse',r.free_response,'optionId',r.option_id,'createdAt',r.created_at) FROM user_responses r WHERE r.message_id=m.message_id),
          'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',a.attachment_id,'contentType',a.content_type,'fileName',a.file_name,'sizeBytes',a.size_bytes,'encrypted',a.encrypted,'ivBase64',a.iv_base64,'tagBase64',a.auth_tag_base64) ORDER BY ma.attachment_order) FROM message_attachments ma JOIN attachments a ON a.attachment_id=ma.attachment_id WHERE ma.message_id=m.message_id),'[]'::jsonb)) AS metadata
      FROM messages m WHERE m.agent_id=$1 AND ($2::timestamptz IS NULL OR m.created_at <= $2)
        ${messageArchiveFilter} ${messageSelection}
      UNION ALL
      SELECT 'user_message'::text,um.user_message_id,'message'::text,um.content,um.encrypted,um.created_at,
        jsonb_build_object('runOverrides',um.run_overrides,'hiddenFromAgent',COALESCE(${userHiddenExpr},FALSE),
          'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',a.attachment_id,'contentType',a.content_type,'fileName',a.file_name,'sizeBytes',a.size_bytes,'encrypted',a.encrypted,'ivBase64',a.iv_base64,'tagBase64',a.auth_tag_base64) ORDER BY uma.attachment_order) FROM user_message_attachments uma JOIN attachments a ON a.attachment_id=uma.attachment_id WHERE uma.user_message_id=um.user_message_id),'[]'::jsonb)) AS metadata
      FROM user_messages um WHERE um.agent_id=$1 AND ($2::timestamptz IS NULL OR um.created_at <= $2)
        ${userArchiveFilter} ${userSelection}
      ${dmTable ? `UNION ALL
      SELECT 'agent_message'::text,am.agent_message_id,'message'::text,am.content,am.encrypted,am.created_at,
        jsonb_build_object('priority',am.priority,'attachments','[]'::jsonb,
          'messageType',CASE WHEN am.sender_agent_id=$1 THEN 'agent_dm_sent' ELSE 'agent_dm_received' END,
          'otherAgent',CASE WHEN am.sender_agent_id=$1 THEN recipient.agent_name ELSE sender.agent_name END)
      FROM agent_messages am JOIN agents sender ON sender.agent_id=am.sender_agent_id
      JOIN agents recipient ON recipient.agent_id=am.recipient_agent_id
      WHERE (am.sender_agent_id=$1 OR am.recipient_agent_id=$1) AND am.created_at<=$2` : ''}
    ) source
    ${ownerRoom ? `WHERE NOT EXISTS (SELECT 1 FROM shared_history_import_items i
      JOIN shared_history_imports h ON h.import_id=i.import_id
      JOIN shared_messages sm ON sm.id=i.target_message_id AND sm.conversation_id=h.conversation_id
      WHERE h.conversation_id=$5 AND i.source_kind=source.source_kind AND i.source_id=source.source_id)` : ''}
    ORDER BY created_at ${ownerRoom ? 'DESC' : 'ASC'},source_kind,source_id OFFSET $3 LIMIT $4`,
  [agentId, boundary, offset, limit, ...(selection ? [selection.sourceKind, selection.sourceId] : ownerRoom ? [ownerRoom] : [])]);
  return result.rows.map(row => ({
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    kind: row.kind,
    content: row.content,
    encrypted: row.encrypted,
    createdAt: row.created_at,
    metadata: row.metadata || {},
    sourceFingerprint: fingerprint([row.source_kind,row.source_id,row.kind,row.content,row.encrypted,row.created_at,row.metadata])
  }));
}

// Original account-encrypted history stays on the owner's authenticated path.
// Imported copies already in this room are omitted so each message appears once.
async function ownerPrivateHistory(ownerId, conversationId, offset = 0, boundary = null, limit = 200) {
  const current = await require('./chatThreadService').getChatContext(uuid(ownerId), uuid(conversationId));
  check(current.role === 'owner' && current.mode === 'shared', 403, 'Only the owner can read private history');
  const pageOffset = Number(offset);
  check(Number.isSafeInteger(pageOffset) && pageOffset >= 0, 400, 'Invalid history offset');
  const pageSize = Number(limit);
  check(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 200, 400, 'Invalid history page size');
  const snapshot = boundary || new Date().toISOString();
  check(Number.isFinite(Date.parse(snapshot)), 400, 'Invalid history boundary');
  const rows = await sourceRows(db, current.agentId, snapshot, pageOffset, pageSize + 1, null, conversationId);
  const messages = rows.slice(0, pageSize).map(row => ({
    ...row.metadata, messageId: row.sourceId,
    type: row.metadata.messageType || (row.sourceKind === 'user_message' ? 'user_message' : row.kind === 'question' ? 'agent_question' : 'agent_message'),
    content: row.content || '', encrypted: row.encrypted, timestamp: row.createdAt,
    attachments: (row.metadata.attachments || []).map(file => ({ ...file,
      downloadUrl: `/api/user/attachments/${file.attachmentId}`,
      encryption: file.encrypted ? { alg: 'AES-GCM', ivBase64: file.ivBase64, tagBase64: file.tagBase64 } : null })),
    selectedOption: null, freeResponse: row.metadata.response?.freeResponse || null,
    ownerPrivateHistory: true, sharedAudienceLabel: 'Owner only · private history'
  }));
  return { messages, hasMore: rows.length > pageSize, nextOffset: pageOffset + messages.length, boundary: snapshot };
}

async function manifest(client, agentId, boundary) {
  const rows = await sourceRows(client, agentId, boundary, 0, 1000000);
  return { rows, fingerprint: fingerprint(rows.map(row => [row.sourceKind,row.sourceId,row.sourceFingerprint])) };
}
function uniqueAttachmentCount(rows) {
  return new Set(rows.flatMap(row => (row.metadata?.attachments || []).map(file => file.attachmentId))).size;
}
async function pendingSchedules(client, agentId) {
  const table = (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='scheduled_user_messages'`)).rows[0];
  if (!table) return 0;
  return Number((await client.query('SELECT COUNT(*)::int AS count FROM scheduled_user_messages WHERE agent_id=$1 AND delivered_at IS NULL',[agentId])).rows[0].count || 0);
}

// A shared runner must have heartbeated recently to publish the agent identity
// and accept the room key before history moves.
function runtimeIsLive(runtime) {
  return Boolean(runtime?.last_seen_at) && Date.now() - new Date(runtime.last_seen_at).getTime() < 120000;
}

async function previewShareHistory(ownerId, conversationId) {
  uuid(ownerId); uuid(conversationId);
  const thread = (await db.query(`SELECT t.*,a.agent_name FROM agent_chat_threads t JOIN agents a ON a.agent_id=t.agent_id
    WHERE t.conversation_id=$1 AND t.owner_id=$2`, [conversationId, ownerId])).rows[0];
  check(thread, 404, 'Conversation not found');
  check(thread.state === 'private' || thread.state === 'preparing', 409, 'This conversation is already shared');
  const boundary = (await db.query('SELECT clock_timestamp()::text AS boundary')).rows[0].boundary;
  const snapshot = await manifest(db, thread.agent_id, boundary);
  const scheduled = await pendingSchedules(db,thread.agent_id);
  const attachments = uniqueAttachmentCount(snapshot.rows);
  const runtime = (await db.query('SELECT last_seen_at FROM shared_runtimes WHERE agent_id=$1', [thread.agent_id])).rows[0];
  return { conversationId, agentId: thread.agent_id, agentName: thread.agent_name, state: thread.state,
    sourceBoundary: boundary, sourceFingerprint: snapshot.fingerprint, includedMessages: snapshot.rows.length,
    includedFiles: Number(attachments), excludedAttachments: 0, pendingScheduledMessages: scheduled,
    runtimeReady: runtimeIsLive(runtime),
    exclusions: [...(scheduled ? ['Pending private scheduled messages must be canceled or delivered before sharing.'] : [])] };
}

async function beginHistoryImport(ownerId, conversationId, requestId, expectedSourceFingerprint) {
  uuid(ownerId); uuid(conversationId); uuid(requestId);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const prior = (await client.query('SELECT * FROM shared_history_imports WHERE owner_id=$1 AND request_id=$2 FOR UPDATE', [ownerId, requestId])).rows[0];
    if (prior) {
      check(prior.conversation_id === conversationId, 409, 'This request belongs to another conversation');
      await client.query('COMMIT'); return publicImport(prior);
    }
    let thread = (await client.query(`SELECT t.*,a.agent_name FROM agent_chat_threads t JOIN agents a ON a.agent_id=t.agent_id
      WHERE t.conversation_id=$1 AND t.owner_id=$2`, [conversationId, ownerId])).rows[0];
    check(thread, 404, 'Conversation not found');
    check(thread.state === 'private', 409, 'Conversation is not available for history preparation');
    const lockedAgent = (await client.query('SELECT agent_id,agent_name,is_working FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE', [thread.agent_id, ownerId])).rows[0];
    check(lockedAgent, 404, 'Agent not found');
    const racedPrior = (await client.query('SELECT * FROM shared_history_imports WHERE owner_id=$1 AND request_id=$2', [ownerId, requestId])).rows[0];
    if (racedPrior) {
      check(racedPrior.conversation_id === conversationId, 409, 'This request belongs to another conversation');
      await client.query('COMMIT'); return publicImport(racedPrior);
    }
    thread = (await client.query(`SELECT t.*,a.agent_name FROM agent_chat_threads t JOIN agents a ON a.agent_id=t.agent_id
      WHERE t.conversation_id=$1 AND t.owner_id=$2 FOR UPDATE OF t`, [conversationId,ownerId])).rows[0];
    check(thread?.state==='private',409,'Conversation is no longer available for history preparation');
    check(lockedAgent.is_working !== true,409,'Wait for the current agent task to finish before sharing');
    check(await pendingSchedules(client,thread.agent_id)===0,409,'Cancel or deliver pending private scheduled messages before sharing');
    const existingRoom = (await client.query('SELECT id FROM shared_conversations WHERE id=$1', [conversationId])).rows[0];
    check(!existingRoom, 409, 'Conversation binding is already occupied');
    const runtime = (await client.query('SELECT last_seen_at,execution_id FROM shared_runtimes WHERE agent_id=$1', [thread.agent_id])).rows[0];
    check(runtimeIsLive(runtime), 409, 'The configured agent runtime is not ready for shared delivery');
    check(!runtime.execution_id,409,'Wait for the current agent task to finish before sharing');
    const identity = (await client.query('SELECT principal FROM shared_identities WHERE principal=$1', [`user:${ownerId}`])).rows[0];
    check(identity, 409, 'Initialize shared encryption identity before preparing history');
    // Capture after acquiring the agent lock. Keep PostgreSQL's microseconds;
    // JavaScript Date truncation can otherwise exclude a just-saved message.
    const boundary = (await client.query('SELECT clock_timestamp()::text AS boundary')).rows[0].boundary;
    const snapshot = await manifest(client, thread.agent_id, boundary);
    if (expectedSourceFingerprint) check(snapshot.fingerprint === expectedSourceFingerprint, 409, 'Private history changed after the preview; review the updated scope');
    const attachmentCount = uniqueAttachmentCount(snapshot.rows);
    await client.query('INSERT INTO shared_conversations(id,agent_id,owner_id,title) VALUES($1,$2,$3,$4)', [conversationId, thread.agent_id, ownerId, lockedAgent.agent_name]);
    await client.query("INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by) VALUES($1,$2,'owner','active',$2)", [conversationId, ownerId]);
    const revision = Number(thread.preparation_revision) + 1;
    await client.query("UPDATE agent_chat_threads SET state='preparing',preparation_revision=$2,updated_at=NOW() WHERE conversation_id=$1", [conversationId, revision]);
    const row = (await client.query(`INSERT INTO shared_history_imports(conversation_id,owner_id,agent_id,request_id,source_boundary,source_fingerprint,revision,expected_items,expected_files,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8=0 AND $9=0 THEN 'ready' ELSE 'importing' END) RETURNING *`, [conversationId,ownerId,thread.agent_id,requestId,boundary,snapshot.fingerprint,revision,snapshot.rows.length,Number(attachmentCount)])).rows[0];
    await client.query('COMMIT');
    return publicImport(row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function publicImport(row) {
  return { importId: row.import_id, conversationId: row.conversation_id, sourceBoundary: row.source_boundary,
    state: row.state, revision: Number(row.revision), expectedItems: Number(row.expected_items), importedItems: Number(row.imported_items),
    expectedFiles: Number(row.expected_files || 0), importedFiles: Number(row.imported_files || 0), checkpoint: row.checkpoint };
}

async function ownedImport(ownerId, importId, client = db) {
  const row = (await client.query(`SELECT *,source_boundary::text AS source_boundary FROM shared_history_imports WHERE import_id=$1 AND owner_id=$2${client === db ? '' : ' FOR UPDATE'}`, [uuid(importId),uuid(ownerId)])).rows[0];
  check(row, 404, 'History import not found');
  return row;
}
async function getHistoryImport(ownerId, importId) { return publicImport(await ownedImport(ownerId, importId)); }
async function getActiveHistoryImport(ownerId, conversationId) {
  uuid(ownerId); uuid(conversationId);
  const thread = (await db.query(`SELECT state FROM agent_chat_threads
    WHERE conversation_id=$1 AND owner_id=$2`, [conversationId, ownerId])).rows[0];
  check(thread, 404, 'Conversation not found');
  if (thread.state !== 'preparing') return null;
  const row = (await db.query(`SELECT i.*,source_boundary::text AS source_boundary
    FROM shared_history_imports i WHERE i.conversation_id=$1 AND i.owner_id=$2
      AND i.state IN ('importing','ready') ORDER BY i.revision DESC LIMIT 1`, [conversationId, ownerId])).rows[0];
  check(row, 409, 'Saved history preparation is unavailable; contact support before retrying.');
  return publicImport(row);
}
async function readImportSourcePage(ownerId, importId, offset = 0, limit = 100) {
  check(Number.isInteger(Number(offset)) && Number(offset) >= 0, 400, 'Invalid history cursor');
  check(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 200, 400, 'Invalid page size');
  const row = await ownedImport(ownerId, importId);
  check(['importing','ready'].includes(row.state), 409, 'History source is no longer available');
  const snapshot = await manifest(db, row.agent_id, row.source_boundary);
  check(snapshot.fingerprint === row.source_fingerprint, 409, 'Private history changed after preparation; restart sharing');
  return { items: await sourceRows(db, row.agent_id, row.source_boundary, Number(offset), Number(limit)), nextOffset: Math.min(Number(offset)+Number(limit), Number(row.expected_items)), total: Number(row.expected_items) };
}

function validEnvelope(value) {
  return value && typeof value === 'object' && value.v === 1 && typeof value.iv === 'string' && typeof value.data === 'string';
}
async function importHistoryChunk(ownerId, importId, revision, items) {
  uuid(ownerId); uuid(importId);
  check(Array.isArray(items) && items.length > 0 && items.length <= 100, 400, 'Import a bounded non-empty chunk');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = await ownedImport(ownerId, importId, client);
    check(['importing','ready'].includes(row.state) && Number(row.revision) === Number(revision), 409, 'History import revision changed');
    const room = (await client.query('SELECT key_version FROM shared_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [row.conversation_id, ownerId])).rows[0];
    check(room, 404, 'Conversation not found');
    for (const item of items) {
      check(item && ['message','user_message'].includes(item.sourceKind), 400, 'Unsupported source item');
      uuid(item.sourceId); uuid(item.targetMessageId);
      check(validEnvelope(item.payload) && Number(item.keyVersion) === Number(room.key_version), 400, 'Invalid encrypted imported message');
      const actual = (await sourceRows(client, row.agent_id, row.source_boundary, 0, 1, item))[0];
      check(actual, 400, 'Source item is outside the captured history');
      const sourceFingerprint = actual.sourceFingerprint;
      check(sourceFingerprint === item.sourceFingerprint, 409, 'Source item changed during history conversion');
      const sourceAttachments = actual.metadata?.attachments || [];
      check(Array.isArray(item.fileIds || []) && (item.fileIds || []).length === sourceAttachments.length, 409, 'Every source attachment must be imported before its message');
      for (const sourceFile of sourceAttachments) {
        const mapping = (await client.query('SELECT target_file_id FROM shared_history_import_files WHERE import_id=$1 AND source_attachment_id=$2', [importId,sourceFile.attachmentId])).rows[0];
        check(mapping && item.fileIds.includes(mapping.target_file_id), 409, 'An imported attachment mapping is missing');
      }
      const prior = (await client.query('SELECT * FROM shared_history_import_items WHERE import_id=$1 AND source_kind=$2 AND source_id=$3', [importId,item.sourceKind,item.sourceId])).rows[0];
      if (prior) {
        check(prior.target_message_id === item.targetMessageId && prior.source_fingerprint === sourceFingerprint, 409, 'Conflicting retry for imported history item');
        const saved = (await client.query('SELECT payload,key_version FROM shared_messages WHERE id=$1 AND conversation_id=$2',
          [prior.target_message_id, row.conversation_id])).rows[0];
        check(saved && Number(saved.key_version) === Number(item.keyVersion)
          && saved.payload.v === item.payload.v && saved.payload.iv === item.payload.iv
          && saved.payload.data === item.payload.data, 409, 'Conflicting encrypted retry for imported history item');
        continue;
      }
      check(row.state === 'importing', 409, 'Ready history imports accept only an exact retry');
      const senderUserId = item.sourceKind === 'user_message' ? ownerId : null;
      const senderAgentId = item.sourceKind === 'message' ? row.agent_id : null;
      const agentContextEligible = actual.metadata?.hiddenFromAgent !== true;
      await client.query(`INSERT INTO shared_messages(id,conversation_id,sender_user_id,sender_agent_id,kind,payload,key_version,created_at,import_id,dispatch_eligible,agent_context_eligible)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10)`, [item.targetMessageId,row.conversation_id,senderUserId,senderAgentId,actual.kind,item.payload,room.key_version,actual.createdAt,importId,agentContextEligible]);
      for (const fileId of item.fileIds || []) await client.query('UPDATE shared_files SET message_id=$2 WHERE id=$1 AND conversation_id=$3', [fileId,item.targetMessageId,row.conversation_id]);
      await client.query('INSERT INTO shared_history_import_items(import_id,source_kind,source_id,source_fingerprint,target_message_id) VALUES($1,$2,$3,$4,$5)', [importId,item.sourceKind,item.sourceId,sourceFingerprint,item.targetMessageId]);
    }
    const imported = (await client.query('SELECT COUNT(*)::int AS count FROM shared_history_import_items WHERE import_id=$1', [importId])).rows[0].count;
    const importedFiles = Number((await client.query('SELECT COUNT(*)::int AS count FROM shared_history_import_files WHERE import_id=$1',[importId])).rows[0].count);
    const state = Number(imported) === Number(row.expected_items) && importedFiles === Number(row.expected_files) ? 'ready' : 'importing';
    const updated = (await client.query(`UPDATE shared_history_imports SET imported_items=$2,imported_files=$3,state=$4,checkpoint=jsonb_build_object('importedItems',$2::int,'importedFiles',$3::int),updated_at=NOW()
      WHERE import_id=$1 RETURNING *`, [importId,imported,importedFiles,state])).rows[0];
    await client.query('COMMIT');
    return publicImport(updated);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function importHistoryFile(ownerId, importId, revision, sourceAttachmentId, targetFileId, bytes) {
  uuid(ownerId); uuid(importId); uuid(sourceAttachmentId); uuid(targetFileId);
  check(Buffer.isBuffer(bytes) && bytes.length >= 28 && bytes.length <= require('./service').MAX_FILE_BYTES + 28, 400, 'Invalid encrypted attachment size');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = await ownedImport(ownerId, importId, client);
    check(['importing','ready'].includes(row.state) && Number(row.revision) === Number(revision), 409, 'History import revision changed');
    const room = (await client.query('SELECT key_version FROM shared_conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [row.conversation_id,ownerId])).rows[0];
    check(room,404,'Conversation not found');
    const source = await sourceRows(client,row.agent_id,row.source_boundary,0,1000000);
    const sourceFile = source.flatMap(item => item.metadata?.attachments || []).find(item => item.attachmentId === sourceAttachmentId);
    check(sourceFile,404,'Source attachment is outside the captured history');
    const sourceFingerprint = fingerprint(sourceFile);
    const encryptedFingerprint = crypto.createHash('sha256').update(bytes).digest('hex');
    const previous = (await client.query('SELECT * FROM shared_history_import_files WHERE import_id=$1 AND source_attachment_id=$2', [importId,sourceAttachmentId])).rows[0];
    if (previous) {
      check(previous.target_file_id === targetFileId && previous.source_fingerprint === sourceFingerprint && previous.encrypted_fingerprint === encryptedFingerprint,409,'Conflicting retry for imported attachment');
      await client.query('COMMIT');
      return { fileId: previous.target_file_id, importedFiles: Number(row.imported_files) };
    }
    check(row.state === 'importing',409,'Ready history imports accept only an exact retry');
    await client.query('INSERT INTO shared_files(id,conversation_id,uploader,key_version,bytes) VALUES($1,$2,$3,$4,$5)', [targetFileId,row.conversation_id,`user:${ownerId}`,room.key_version,bytes]);
    await client.query(`INSERT INTO shared_history_import_files(import_id,source_attachment_id,source_fingerprint,target_file_id,encrypted_fingerprint)
      VALUES($1,$2,$3,$4,$5)`, [importId,sourceAttachmentId,sourceFingerprint,targetFileId,encryptedFingerprint]);
    const updated = (await client.query(`UPDATE shared_history_imports SET imported_files=imported_files+1,
      state=CASE WHEN imported_items=expected_items AND imported_files+1=expected_files THEN 'ready' ELSE 'importing' END,updated_at=NOW()
      WHERE import_id=$1 RETURNING imported_files`, [importId])).rows[0];
    await client.query('COMMIT');
    return { fileId: targetFileId, importedFiles: Number(updated.imported_files) };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function validateHistoryImport(ownerId, importId) {
  const row = await ownedImport(ownerId, importId);
  if (row.state === 'activated') return publicImport(row);
  check(row.state === 'ready' && Number(row.imported_items) === Number(row.expected_items), 409, 'History import is incomplete');
  check(Number(row.imported_files) === Number(row.expected_files),409,'History import is missing encrypted attachments');
  const snapshot = await manifest(db,row.agent_id,null);
  check(snapshot.fingerprint === row.source_fingerprint, 409, 'Private history changed during conversion');
  return publicImport(row);
}
async function activateSharedThread(ownerId, importId, revision) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = await ownedImport(ownerId, importId, client);
    check(Number(row.revision) === Number(revision), 409, 'History import revision changed');
    if (row.state === 'activated') { await client.query('COMMIT'); return publicImport(row); }
    check(row.state === 'ready' && Number(row.imported_items) === Number(row.expected_items), 409, 'History import is incomplete');
    check(Number(row.imported_files) === Number(row.expected_files),409,'History import is missing encrypted attachments');
    const agent = (await client.query('SELECT agent_id,is_working FROM agents WHERE agent_id=$1 AND user_id=$2 FOR UPDATE', [row.agent_id,ownerId])).rows[0];
    check(agent,404,'Agent not found');
    const runtime = (await client.query('SELECT execution_id FROM shared_runtimes WHERE agent_id=$1', [row.agent_id])).rows[0];
    check(agent.is_working !== true && !runtime?.execution_id,409,'Wait for the current agent task to finish before sharing');
    const snapshot = await manifest(client,row.agent_id,null);
    check(snapshot.fingerprint === row.source_fingerprint,409,'Private history changed during conversion');
    const binding = (await client.query('SELECT * FROM agent_chat_threads WHERE conversation_id=$1 AND owner_id=$2 FOR UPDATE', [row.conversation_id,ownerId])).rows[0];
    check(binding?.state === 'preparing' && Number(binding.preparation_revision) === Number(row.revision),409,'Chat binding is no longer preparing');
    const activated = (await client.query("UPDATE shared_history_imports SET state='activated',activated_at=NOW(),updated_at=NOW() WHERE import_id=$1 RETURNING *", [importId])).rows[0];
    await client.query("UPDATE agent_chat_threads SET state='shared',activated_at=NOW(),updated_at=NOW() WHERE conversation_id=$1", [row.conversation_id]);
    await client.query('COMMIT');
    return publicImport(activated);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function abortHistoryImport(ownerId, importId) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = await ownedImport(ownerId, importId, client);
    check(row.state !== 'activated',409,'Activated shared history cannot be discarded');
    await client.query("UPDATE shared_history_imports SET state='aborted',updated_at=NOW() WHERE import_id=$1",[importId]);
    await client.query("UPDATE agent_chat_threads SET state='private',updated_at=NOW() WHERE conversation_id=$1 AND state='preparing'",[row.conversation_id]);
    await client.query('DELETE FROM shared_conversations WHERE id=$1 AND owner_id=$2',[row.conversation_id,ownerId]);
    await client.query('COMMIT');
    return { conversationId: row.conversation_id, state: 'private' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { HistoryImportError, ownerPrivateHistory, previewShareHistory, beginHistoryImport, getHistoryImport, getActiveHistoryImport, readImportSourcePage,
  importHistoryChunk, importHistoryFile, validateHistoryImport, activateSharedThread, abortHistoryImport };
