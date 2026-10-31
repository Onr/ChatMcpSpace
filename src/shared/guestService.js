'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db/connection');
const s = require('./service');
const MAX_GUESTS_PER_SHARE = 100;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function guestStorageLimits() {
  function limit(name, fallback, minimum) {
    const value = process.env[name] ?? String(fallback);
    const number = Number(value);
    s.check(/^[1-9]\d*$/.test(value) && Number.isSafeInteger(number) && number >= minimum,
      503, 'Guest file storage configuration is unavailable');
    return number;
  }
  return {
    bytes: limit('GUEST_FILE_STORAGE_MAX_BYTES', 100_000_000, 29),
    files: limit('GUEST_FILE_STORAGE_MAX_FILES', 1000, 1)
  };
}

async function reserveGuestFileStorage(client, limits, addedBytes, addedFiles) {
  const usage = await one(client, `SELECT COUNT(*) AS files,
    COALESCE(SUM(octet_length(bytes)),0) AS bytes FROM shared_files WHERE uploader LIKE 'guest:%'`);
  const bytes = Number(usage.bytes), files = Number(usage.files);
  s.check(Number.isSafeInteger(bytes) && Number.isSafeInteger(files), 503, 'Guest file storage is unavailable');
  // Lowering a configured limit must not prevent shrinking/rekeying an existing
  // file without increasing storage. Deletes also remain available when full.
  s.check((addedBytes <= 0 && addedFiles === 0) ||
    (Number.isSafeInteger(bytes + addedBytes) && bytes + addedBytes <= limits.bytes &&
      files + addedFiles <= limits.files),
    409, 'Guest attachment storage quota reached; remove unused attachments or contact the owner');
}

function assertGuestUploadUnexpired(access) {
  // PostgreSQL NOW() uses transaction start time. A storage-lock wait can cross
  // a session/share expiry even though the locked rows cannot be revoked yet.
  s.check(shareExpiry(access.share) && new Date(access.session.expires_at).getTime() > Date.now(),
    404, 'Guest session unavailable');
}

function tx(fn) {
  return (async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })();
}

async function one(client, sql, params) {
  return (await client.query(sql, params)).rows[0];
}

function text(value, max = 120) {
  s.check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 400, 'Invalid guest text');
  return value.trim();
}

function hash(value, name) {
  s.check(typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value), 400, `Invalid ${name}`);
  return value;
}

function tokenHash(secret) {
  return crypto.createHash('sha256').update(secret).digest('base64url');
}

function newLinkSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function listIds(value) {
  s.check(Array.isArray(value) && value.length > 0 && value.length <= 100, 400, 'Select one or more agents');
  return [...new Set(value.map(id => s.uuid(id)))];
}

function futureExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  s.check(Number.isFinite(date.getTime()) && date.getTime() > Date.now(), 400, 'Share expiry must be in the future');
  return date;
}

function messageLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  s.check(Number.isInteger(limit) && limit > 0 && limit <= 100000, 400, 'Message limit must be a whole number from 1 to 100000');
  return limit;
}

function accessMode(value) {
  if (value === undefined || value === null || value === '') return 'join';
  s.check(['join', 'request'].includes(value), 400, 'Invalid guest link type');
  return value;
}

function requestNote(value) {
  if (value === undefined || value === null) return null;
  s.check(typeof value === 'string' && value.length <= 500, 400, 'Request note must be at most 500 characters');
  return value.trim() || null;
}

function passwordValue(value) {
  if (value === undefined || value === null || value === '') return null;
  s.check(typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 72, 400, 'Guest password must be 12–72 UTF-8 bytes');
  return value;
}

function publicShare(share) {
  if (!share) return null;
  const {
    token_hash: _tokenHash,
    password_hash: _passwordHash,
    ...safe
  } = share;
  return {
    ...safe,
    shareId: share.share_id
  };
}

async function ownerShare(client, ownerId, shareId, lock = false) {
  const share = await one(client, `SELECT * FROM guest_shares WHERE share_id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`, [s.uuid(shareId), s.uuid(ownerId)]);
  s.check(share, 404, 'Guest share unavailable');
  return share;
}

async function ownerAgents(client, ownerId, agentIds) {
  const ids = listIds(agentIds);
  const agents = [];
  for (const id of ids) {
    const agent = await one(client, 'SELECT agent_id,agent_name,user_id FROM agents WHERE agent_id=$1 AND user_id=$2', [id, s.uuid(ownerId)]);
    s.check(agent, 403, 'Every selected agent must belong to the owner');
    agents.push(agent);
  }
  return agents;
}

async function createOwnerRoom(client, ownerId, agent, title) {
  const room = await one(client, `INSERT INTO shared_conversations(agent_id,owner_id,title)
    VALUES($1,$2,$3) RETURNING id,agent_id,owner_id,title,key_version,membership_version,rotation_required,created_at`, [agent.agent_id, ownerId, text(title, 120)]);
  await client.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
    VALUES($1,$2,'owner','active',$2)`, [room.id, ownerId]);
  return room;
}

async function recordShareEvents(client, ownerId, shareId, agents, eventType) {
  for (const agent of agents) await client.query(`INSERT INTO shared_security_events
    (agent_id,owner_id,actor_kind,actor_id,event_type,metadata)
    VALUES($1,$2,'user',$2,$3,$4)`, [agent.agent_id, ownerId, eventType, JSON.stringify({ shareId })]);
}

async function createOwnerShare(ownerId, body = {}) {
  const password = passwordValue(body.password);
  const roomMode = body.roomMode || 'separate';
  s.check(['separate', 'common'].includes(roomMode), 400, 'Invalid guest room mode');
  const expiresAt = futureExpiry(body.expiresAt);
  const maxMessages = messageLimit(body.maxMessages);
  const mode = accessMode(body.accessMode);
  const title = body.title || 'Guest shared work';
  const rawSecret = newLinkSecret();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  return tx(async client => {
    let linkedConversation = null;
    let agents;
    if (body.conversationId) {
      s.check(roomMode === 'common', 400, 'An existing conversation can only use common guest access');
      const conversationId = s.uuid(body.conversationId);
      linkedConversation = await one(client, `SELECT c.id,c.agent_id,c.owner_id,a.agent_name FROM shared_conversations c
        JOIN agents a ON a.agent_id=c.agent_id JOIN shared_members m ON m.conversation_id=c.id
        WHERE c.id=$1 AND c.owner_id=$2 AND m.user_id=$2 AND m.role='owner' AND m.status='active' FOR UPDATE`,[conversationId,s.uuid(ownerId)]);
      s.check(linkedConversation,404,'Shared conversation not found');
      const bindingTable=await one(client,`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='agent_chat_threads'`);
      if(bindingTable) {
        const binding=await one(client,'SELECT state FROM agent_chat_threads WHERE conversation_id=$1 AND owner_id=$2',[conversationId,s.uuid(ownerId)]);
        s.check(!binding || binding.state==='shared',409,'Finish preparing this conversation before creating guest access');
      }
      agents = await ownerAgents(client,ownerId,[linkedConversation.agent_id]);
    } else {
      agents = await ownerAgents(client, ownerId, body.agentIds);
    }
    const share = await one(client, `INSERT INTO guest_shares(owner_id,token_hash,password_hash,room_mode,expires_at,max_messages,access_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [s.uuid(ownerId), tokenHash(rawSecret), passwordHash, roomMode, expiresAt, maxMessages, mode]);
    for (const agent of agents) {
      const room = roomMode === 'common'
        ? linkedConversation && linkedConversation.agent_id === agent.agent_id
          ? linkedConversation
          : await createOwnerRoom(client, ownerId, agent, `${title} — ${agent.agent_name}`)
        : null;
      await client.query('INSERT INTO guest_share_agents(share_id,agent_id,room_id) VALUES($1,$2,$3)', [share.share_id, agent.agent_id, room?.id || null]);
    }
    await recordShareEvents(client, ownerId, share.share_id, agents, 'guest_share_created');
    return {
      ...publicShare(share),
      linkSecret: rawSecret,
      ...(linkedConversation ? { conversationId: linkedConversation.id } : {}),
      agents: agents.map(agent => ({
        agentId: agent.agent_id,
        agentName: agent.agent_name
      }))
    };
  });
}

async function shareAgents(client, shareId) {
  return (await client.query(`SELECT sa.share_id,sa.agent_id,sa.room_id,sa.selected_at,sa.removed_at,a.agent_name,sc.title,
    sr.capabilities->>'executionMode' AS execution_mode
    FROM guest_share_agents sa JOIN agents a ON a.agent_id=sa.agent_id
    LEFT JOIN shared_conversations sc ON sc.id=sa.room_id
    LEFT JOIN shared_runtimes sr ON sr.agent_id=sa.agent_id
    WHERE sa.share_id=$1 ORDER BY a.agent_name`, [shareId])).rows;
}

async function listOwnerShares(ownerId) {
  const shares = (await db.query('SELECT * FROM guest_shares WHERE owner_id=$1 ORDER BY created_at DESC', [s.uuid(ownerId)])).rows;
  return Promise.all(shares.map(async share => ({
    ...publicShare(share),
    agents: await db.query(`SELECT sa.agent_id,sa.room_id,sa.selected_at,sa.removed_at,a.agent_name,sc.title,
      sr.capabilities->>'executionMode' AS execution_mode
      FROM guest_share_agents sa JOIN agents a ON a.agent_id=sa.agent_id
      LEFT JOIN shared_conversations sc ON sc.id=sa.room_id
      LEFT JOIN shared_runtimes sr ON sr.agent_id=sa.agent_id
      WHERE sa.share_id=$1 ORDER BY a.agent_name`, [share.share_id]).then(result => result.rows),
    guestCount: await db.query('SELECT COUNT(*)::integer AS count FROM guest_principals WHERE share_id=$1 AND status<>\'revoked\'', [share.share_id]).then(result => result.rows[0].count)
  })));
}

async function getOwnerShare(ownerId, shareId) {
  return tx(async client => {
    const share = await ownerShare(client, ownerId, shareId);
    const guests = (await client.query(`SELECT guest_id,display_name,public_key,status,created_at,updated_at FROM guest_principals
      WHERE share_id=$1 ORDER BY created_at`, [share.share_id])).rows;
    for (const guest of guests) {
      guest.rooms = (await client.query(`SELECT sc.id AS room_id,sc.agent_id,a.agent_name
        FROM shared_guest_members gm
        JOIN shared_conversations sc ON sc.id=gm.conversation_id
        JOIN guest_share_agents sa ON sa.share_id=gm.share_id AND sa.agent_id=sc.agent_id
        JOIN agents a ON a.agent_id=sc.agent_id
        WHERE gm.share_id=$1 AND gm.guest_id=$2 AND gm.status<>'removed' AND sa.removed_at IS NULL`, [share.share_id, guest.guest_id])).rows;
    }
    return {
      ...publicShare(share),
      agents: await shareAgents(client, share.share_id),
      guests
    };
  });
}

async function updateOwnerShare(ownerId, shareId, body = {}) {
  return tx(async client => {
    const current = await ownerShare(client, ownerId, shareId, true);
    const changes = [];
    const values = [];
    let bumpRevision = false;
    // Extending or clearing the expiry and changing the message limit keep
    // current guests signed in; an earlier deadline re-checks queued work.
    let extendSessions = null;
    if (body.expiresAt !== undefined) {
      const expiresAt = futureExpiry(body.expiresAt);
      values.push(expiresAt);
      changes.push(`expires_at=$${values.length}`);
      if (expiresAt && (!current.expires_at || expiresAt < new Date(current.expires_at))) bumpRevision = true;
      else extendSessions = expiresAt;
    }
    if (body.maxMessages !== undefined) {
      values.push(messageLimit(body.maxMessages));
      changes.push(`max_messages=$${values.length}`);
    }
    // The link type only changes what new visitors see; nobody is signed out.
    if (body.accessMode !== undefined) {
      values.push(accessMode(body.accessMode));
      changes.push(`access_mode=$${values.length}`);
    }
    let rawSecret = null;
    if (body.replaceLink === true) {
      rawSecret = newLinkSecret();
      values.push(tokenHash(rawSecret));
      changes.push(`token_hash=$${values.length}`);
      bumpRevision = true;
    }
    if (body.password !== undefined) {
      const password = passwordValue(body.password);
      values.push(password ? await bcrypt.hash(password, 12) : null);
      changes.push(`password_hash=$${values.length}`);
      changes.push('password_revision=password_revision+1');
      bumpRevision = true;
    }
    if (body.revoked === true) {
      await rotateRemovedGuestRooms(client, current.share_id, null);
      changes.push('revoked_at=NOW()');
      bumpRevision = true;
    }
    if (bumpRevision) changes.push('revision=revision+1');
    if (!changes.length) return {
      ...publicShare(current),
      agents: await shareAgents(client, current.share_id)
    };
    values.push(current.share_id);
    const updated = await one(client, `UPDATE guest_shares SET ${changes.join(',')},updated_at=NOW()
      WHERE share_id=$${values.length} RETURNING *`, values);
    if (!bumpRevision && body.expiresAt !== undefined) {
      const sessions = (await client.query(`SELECT session_id,created_at FROM guest_sessions
        WHERE share_id=$1 AND revoked_at IS NULL AND expires_at>NOW()`, [current.share_id])).rows;
      for (const session of sessions) await client.query('UPDATE guest_sessions SET expires_at=$2 WHERE session_id=$1', [session.session_id,
        new Date(Math.min(new Date(session.created_at).getTime() + SESSION_MAX_AGE_MS, extendSessions ? extendSessions.getTime() : Infinity))]);
    }
    if (bumpRevision) {
      await client.query(`UPDATE guest_sessions SET revoked_at=NOW()
        WHERE share_id=$1 AND revoked_at IS NULL`, [current.share_id]);
      await invalidateGuestWork(client, current.share_id, null, 'Guest share authority changed');
    }
    if (body.revoked === true) {
      await client.query('UPDATE guest_principals SET status=\'revoked\',updated_at=NOW() WHERE share_id=$1 AND status<>\'revoked\'', [current.share_id]);
      await client.query('UPDATE shared_guest_members SET status=\'removed\',removed_at=NOW() WHERE share_id=$1 AND status<>\'removed\'', [current.share_id]);
    }
    return {
      ...publicShare(updated),
      agents: await shareAgents(client, current.share_id),
      ...(rawSecret ? { linkSecret: rawSecret } : {})
    };
  });
}

async function replaceShareAgents(ownerId, shareId, body = {}) {
  const roomMode = body.roomMode;
  return tx(async client => {
    const share = await ownerShare(client, ownerId, shareId, true);
    s.check(!share.revoked_at && shareExpiry(share), 409, 'Guest share is unavailable');
    if (roomMode !== undefined) s.check(roomMode === share.room_mode, 409, 'Room mode cannot change after creation');
    const agents = await ownerAgents(client, ownerId, body.agentIds);
    const selected = new Set(agents.map(agent => agent.agent_id));
    const existing = (await client.query('SELECT * FROM guest_share_agents WHERE share_id=$1 FOR UPDATE', [share.share_id])).rows;
    const removed = new Set(existing.filter(row => !selected.has(row.agent_id) && !row.removed_at).map(row => row.agent_id));
    if (removed.size) {
      await rotateRemovedGuestRooms(client, share.share_id, null, removed);
      const members = (await client.query(`SELECT gm.conversation_id,gm.guest_id,sc.agent_id FROM shared_guest_members gm
        JOIN shared_conversations sc ON sc.id=gm.conversation_id WHERE gm.share_id=$1 AND gm.status<>'removed'`, [share.share_id])).rows;
      for (const member of members.filter(member => removed.has(member.agent_id))) await client.query(`UPDATE shared_guest_members
        SET status='removed',removed_at=NOW() WHERE conversation_id=$1 AND guest_id=$2`, [member.conversation_id, member.guest_id]);
    }
    for (const row of existing) if (!selected.has(row.agent_id)) {
      await client.query('UPDATE guest_share_agents SET removed_at=NOW() WHERE share_id=$1 AND agent_id=$2', [share.share_id, row.agent_id]);
    }
    for (const agent of agents) {
      const row = existing.find(existingRow => existingRow.agent_id === agent.agent_id);
      if (row) {
        await client.query('UPDATE guest_share_agents SET removed_at=NULL WHERE share_id=$1 AND agent_id=$2', [share.share_id, agent.agent_id]);
      } else {
        const room = share.room_mode === 'common' ? await createOwnerRoom(client, ownerId, agent, `Guest shared work — ${agent.agent_name}`) : null;
        await client.query('INSERT INTO guest_share_agents(share_id,agent_id,room_id) VALUES($1,$2,$3)', [share.share_id, agent.agent_id, room?.id || null]);
      }
    }
    await client.query('UPDATE guest_shares SET revision=revision+1,updated_at=NOW() WHERE share_id=$1', [share.share_id]);
    await client.query('UPDATE guest_sessions SET revoked_at=NOW() WHERE share_id=$1 AND revoked_at IS NULL', [share.share_id]);
    await invalidateGuestWork(client, share.share_id, null, 'Guest agent selection changed');
    await recordShareEvents(client, ownerId, share.share_id, agents, 'guest_share_agents_updated');
    return {
      shareId: share.share_id,
      agents: await shareAgents(client, share.share_id)
    };
  });
}

async function removeGuest(ownerId, shareId, id) {
  return tx(async client => {
    const share = await ownerShare(client, ownerId, shareId, true);
    const guest = await guestForShare(client, share.share_id, id, false);
    await rotateRemovedGuestRooms(client, share.share_id, guest.guest_id);
    await client.query("UPDATE guest_principals SET status='revoked',updated_at=NOW() WHERE guest_id=$1", [guest.guest_id]);
    await client.query('UPDATE guest_sessions SET revoked_at=NOW() WHERE guest_id=$1 AND revoked_at IS NULL', [guest.guest_id]);
    await client.query("UPDATE shared_guest_members SET status='removed',removed_at=NOW() WHERE share_id=$1 AND guest_id=$2 AND status<>'removed'", [share.share_id, guest.guest_id]);
    await invalidateGuestWork(client, share.share_id, guest.guest_id, 'Guest access removed');
    for (const row of await shareAgents(client, share.share_id)) await client.query(`INSERT INTO shared_security_events
      (agent_id,owner_id,actor_kind,actor_id,event_type,metadata)
      VALUES($1,$2,'user',$2,'guest_removed',$3)`, [row.agent_id, ownerId, JSON.stringify({ shareId: share.share_id, guestId: guest.guest_id })]);
    return {
      ok: true,
      guestId: guest.guest_id
    };
  });
}

async function invalidateGuestWork(client, shareId, id, reason) {
  // Queued work has not started. Active work is only cancellation-requested;
  // revocation cannot certify stopped processes or erase uncertain effects.
  const authorization = JSON.stringify({ state: 'revoked', shareId, reason });
  const tasks = (await client.query(`UPDATE shared_tasks SET
    state=CASE WHEN state IN ('running','waiting_for_approval','paused','cancellation_requested') THEN 'cancellation_requested'
      WHEN state='outcome_uncertain' THEN 'outcome_uncertain' ELSE 'cancellation_confirmed' END,
    current_authorization=$3,
    completed_at=CASE WHEN state IN ('running','waiting_for_approval','paused','cancellation_requested','outcome_uncertain') THEN completed_at ELSE NOW() END
    WHERE requester_kind='guest' AND requester_id IN
      (SELECT guest_id FROM guest_principals WHERE share_id=$1 AND ($2::uuid IS NULL OR guest_id=$2))
      AND state IN ('queued','unsupported_runtime','waiting_for_approval','paused','running','cancellation_requested','outcome_uncertain')
    RETURNING task_id`, [shareId, id, authorization])).rows;
  for (const task of tasks) await client.query(`UPDATE shared_task_actions SET approval_state='revoked'
    WHERE task_id=$1 AND approval_state IN ('pending','approved')`, [task.task_id]);
}

async function rotateRemovedGuestRooms(client, shareId, guestId, agentIds = null) {
  const rooms = (await client.query(`SELECT gm.conversation_id,sc.agent_id FROM shared_guest_members gm
    JOIN shared_conversations sc ON sc.id=gm.conversation_id
    WHERE gm.share_id=$1 AND gm.status<>'removed'${guestId ? ' AND gm.guest_id=$2' : ''}
    ORDER BY gm.conversation_id`, guestId ? [shareId, guestId] : [shareId])).rows;
  const uniqueRooms = new Map(rooms.map(room => [room.conversation_id, room]));
  for (const room of [...uniqueRooms.values()].filter(room => !agentIds || agentIds.has(room.agent_id))) {
    await client.query('SELECT id FROM shared_conversations WHERE id=$1 FOR UPDATE', [room.conversation_id]);
    await client.query('UPDATE shared_conversations SET rotation_required=TRUE,membership_version=membership_version+1 WHERE id=$1', [room.conversation_id]);
    if (guestId) await client.query('DELETE FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [room.conversation_id, `guest:${guestId}`]);
    else await client.query(`DELETE FROM shared_key_envelopes WHERE conversation_id=$1 AND principal IN
      (SELECT 'guest:' || guest_id::text FROM shared_guest_members WHERE conversation_id=$1 AND share_id=$2)`, [room.conversation_id, shareId]);
  }
}

function guestId(value) {
  return s.uuid(value);
}

function shareExpiry(share) {
  return !share.revoked_at && (!share.expires_at || new Date(share.expires_at).getTime() > Date.now());
}

async function activeShare(client, shareId, revision = null, exclusive = false) {
  const share = await one(client, `SELECT * FROM guest_shares WHERE share_id=$1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`, [s.uuid(shareId)]);
  s.check(share && shareExpiry(share), 404, 'Guest share unavailable');
  if (revision !== null) s.check(Number(share.revision) === Number(revision), 404, 'Guest share has changed');
  return share;
}

async function findShareByLinkSecret(secret) {
  s.check(typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret), 400, 'Invalid guest link');
  return db.query(`SELECT * FROM guest_shares
    WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())`, [tokenHash(secret)]).then(result => result.rows[0] || null);
}

async function previewGuestLink(secret) {
  const share = await findShareByLinkSecret(secret);
  s.check(share, 404, 'This guest invitation has expired or is no longer available');
  const agents = await shareAgents(db, share.share_id);
  const owner = await one(db, `SELECT display_name FROM shared_identities WHERE principal=$1`, [`user:${share.owner_id}`]);
  return {
    ownerDisplayName: owner?.display_name || 'The conversation owner',
    agents: agents.filter(agent => !agent.removed_at).map(agent => ({ agentName: agent.agent_name, title: agent.title || null })),
    expiresAt: share.expires_at || null,
    maxMessages: share.max_messages || null,
    requiresCode: Boolean(share.password_hash),
    accessMode: share.access_mode || 'join',
    // Signed-in visitors can only join a conversation the owner already shares.
    accountRequests: share.room_mode === 'common'
  };
}

async function guestForShare(client, shareId, id, activeOnly = true) {
  const guest = await one(client, 'SELECT * FROM guest_principals WHERE guest_id=$1 AND share_id=$2 FOR UPDATE', [guestId(id), s.uuid(shareId)]);
  s.check(guest && (!activeOnly || guest.status !== 'revoked'), 404, 'Guest principal unavailable');
  return guest;
}

function publicIdentity(publicKey) {
  if (publicKey === undefined || publicKey === null) return null;
  s.check(publicKey && typeof publicKey === 'object' && !Array.isArray(publicKey) && !publicKey.d && !publicKey.p && !publicKey.q, 400, 'Invalid guest public identity');
  s.check(typeof publicKey.n === 'string' && publicKey.n.length >= 128 && publicKey.n.length <= 1024, 400, 'Invalid guest public identity');
  return publicKey;
}

function guestIdentity(publicKey) {
  s.check(publicKey && typeof publicKey === 'object' && !Array.isArray(publicKey)
    && publicKey.kty === 'RSA' && publicKey.e === 'AQAB'
    && !publicKey.d && !publicKey.p && !publicKey.q, 400, 'RSA-3072 guest public key required');
  s.check(typeof publicKey.n === 'string' && publicKey.n.length === 512, 400, 'RSA-3072 guest public key required');
  try {
    crypto.createPublicKey({ key: publicKey, format: 'jwk' });
  } catch (_error) {
    throw new s.SharedError(400, 'Invalid guest public key');
  }
  return {
    kty: 'RSA',
    n: publicKey.n,
    e: 'AQAB',
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['wrapKey']
  };
}

async function createGuestPrincipal({ shareId, displayName, publicKey = null }) {
  return tx(async client => {
    await activeShare(client, shareId, null, true);
    return insertPrincipal(client, { shareId, displayName, publicKey });
  });
}

async function insertPrincipal(client, { shareId, displayName, publicKey = null, note = null }) {
  const count = await one(client, 'SELECT COUNT(*) AS total FROM guest_principals WHERE share_id=$1', [shareId]);
  s.check(Number(count.total) < MAX_GUESTS_PER_SHARE, 429, 'Guest identity limit reached; create a new share');
  return one(client, `INSERT INTO guest_principals(share_id,display_name,public_key,request_note)
    VALUES($1,$2,$3,$4) RETURNING guest_id,share_id,display_name,status,created_at,updated_at`, [shareId, text(displayName, 80), publicKey ? JSON.stringify(publicIdentity(publicKey)) : null, requestNote(note)]);
}

// The password check happens outside the transaction. Bind its successful result
// to the exact share snapshot, then create both records under the same lock.
async function createUnlockedGuestSession({ verifiedShare, displayName, note = null, sessionTokenHash, csrfSecretHash }) {
  return tx(async client => {
    const share = await activeShare(client, verifiedShare.share_id, verifiedShare.revision, true);
    s.check(share.token_hash === verifiedShare.token_hash && share.password_hash === verifiedShare.password_hash &&
      Number(share.password_revision) === Number(verifiedShare.password_revision), 409, 'Guest share has changed');
    const guest = await insertPrincipal(client, { shareId: share.share_id, displayName, note });
    const expiry = new Date(Math.min(Date.now() + SESSION_MAX_AGE_MS, share.expires_at ? new Date(share.expires_at).getTime() : Infinity));
    const session = await insertSession(client, share, guest, sessionTokenHash, csrfSecretHash, expiry);
    return { guest, session, share };
  });
}

async function setGuestIdentity({ shareId, guestId: id, publicKey }) {
  const key = publicIdentity(publicKey);
  return tx(async client => {
    await activeShare(client, shareId);
    const guest = await guestForShare(client, shareId, id);
    if (guest.public_key) {
      s.check(JSON.stringify(guest.public_key) === JSON.stringify(key), 409, 'Guest identity already registered; recovery requires a new principal');
      return guest;
    }
    return one(client, 'UPDATE guest_principals SET public_key=$2,status=\'active\',updated_at=NOW() WHERE guest_id=$1 RETURNING guest_id,share_id,display_name,status,public_key,created_at,updated_at', [id, JSON.stringify(key)]);
  });
}

async function createGuestSession({ shareId, guestId: id, sessionTokenHash, csrfSecretHash = null, expiresAt }) {
  return tx(async client => {
    const share = await activeShare(client, shareId);
    const guest = await guestForShare(client, shareId, id);
    return insertSession(client, share, guest, sessionTokenHash, csrfSecretHash, new Date(expiresAt));
  });
}

async function insertSession(client, share, guest, sessionTokenHash, csrfSecretHash, expiry) {
    s.check(Number.isFinite(expiry.getTime()) && expiry.getTime() > Date.now() && expiry.getTime() <= Date.now() + SESSION_MAX_AGE_MS, 400, 'Invalid guest session expiry');
    if (share.expires_at) s.check(expiry.getTime() <= new Date(share.expires_at).getTime(), 400, 'Guest session exceeds share expiry');
    return one(client, `INSERT INTO guest_sessions
      (share_id,guest_id,session_token_hash,share_revision,password_revision,csrf_secret_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING session_id,share_id,guest_id,share_revision,password_revision,expires_at,created_at,last_seen_at`, [share.share_id, guest.guest_id, hash(sessionTokenHash, 'session token hash'), share.revision, share.password_revision, csrfSecretHash ? hash(csrfSecretHash, 'CSRF hash') : null, expiry]);
}

async function revokeGuestSession(sessionId) {
  return db.query('UPDATE guest_sessions SET revoked_at=NOW() WHERE session_id=$1 RETURNING session_id,revoked_at', [s.uuid(sessionId)]).then(result => result.rows[0] || null);
}

async function guestSessionAccess(client, sessionId, sessionTokenHash) {
  const candidate = await one(client, `SELECT share_id,guest_id FROM guest_sessions
    WHERE session_id=$1 AND session_token_hash=$2`, [s.uuid(sessionId), hash(sessionTokenHash, 'session token hash')]);
  s.check(candidate, 404, 'Guest session unavailable');
  // Share -> principal -> session is also the owner lifecycle lock order. The
  // principal lock serializes the retained-file quota across all of its rooms.
  const share = await activeShare(client, candidate.share_id);
  const principal = await guestForShare(client, share.share_id, candidate.guest_id);
  const session = await one(client, `SELECT * FROM guest_sessions
    WHERE session_id=$1 AND session_token_hash=$2 AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE`, [sessionId, sessionTokenHash]);
  s.check(session && Number(session.share_revision) === Number(share.revision), 404, 'Guest session unavailable');
  s.check(Number(session.password_revision) === Number(share.password_revision), 404, 'Guest session requires unlock');
  return {
    share,
    session,
    guest: {
      guest_id: session.guest_id,
      share_id: session.share_id,
      display_name: principal.display_name,
      public_key: principal.public_key,
      status: principal.status
    }
  };
}

async function currentGuestAccess({ sessionId, sessionTokenHash, roomId = null, requireActiveMember = true }) {
  return tx(async client => {
    const access = await guestSessionAccess(client, sessionId, sessionTokenHash);
    let room = null;
    let member = null;
    if (roomId) {
      const mapping = await one(client, `SELECT sa.*,CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END AS resolved_room_id,
          sc.title,sc.agent_id,sc.owner_id,sc.key_version,sc.membership_version,sc.rotation_required,sc.sharing_enabled
        FROM guest_share_agents sa
        JOIN guest_shares gs ON gs.share_id=sa.share_id
        LEFT JOIN guest_share_rooms gsr ON gsr.share_id=sa.share_id AND gsr.guest_id=$2 AND gsr.agent_id=sa.agent_id
        JOIN shared_conversations sc ON sc.id=CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END
        WHERE sa.share_id=$1 AND sc.id=$3 AND sa.removed_at IS NULL`, [access.share.share_id, access.session.guest_id, s.uuid(roomId)]);
      s.check(mapping, 404, 'Guest conversation unavailable');
      s.check(mapping.sharing_enabled !== false, 403, 'Sharing is turned off by the owner');
      member = await one(client, `SELECT * FROM shared_guest_members
        WHERE share_id=$1 AND guest_id=$2 AND conversation_id=$3`, [access.share.share_id, access.session.guest_id, mapping.resolved_room_id]);
      s.check(member && (!requireActiveMember || member.status === 'active'), 404, 'Guest conversation membership unavailable');
      room = { ...mapping, room_id: mapping.resolved_room_id };
    }
    await client.query('UPDATE guest_sessions SET last_seen_at=NOW() WHERE session_id=$1', [access.session.session_id]);
    return {
      ...access,
      room,
      member
    };
  });
}

async function guestRoomsInTransaction(client, access) {
  await client.query(`SELECT agent_id FROM guest_share_agents WHERE share_id=$1 AND removed_at IS NULL
    ORDER BY agent_id FOR UPDATE`, [access.share.share_id]);
  const mappings = (await client.query(`SELECT sa.*,gs.room_mode,a.agent_name
    FROM guest_share_agents sa
    JOIN guest_shares gs ON gs.share_id=sa.share_id
    JOIN agents a ON a.agent_id=sa.agent_id
    WHERE sa.share_id=$1 AND sa.removed_at IS NULL ORDER BY a.agent_name,sa.agent_id`, [access.share.share_id])).rows;
  const rooms = [];
  for (const mapping of mappings) {
    let roomId = mapping.room_id;
    if (mapping.room_mode === 'separate') {
      const scopedRoom = await one(client, `SELECT room_id FROM guest_share_rooms
        WHERE share_id=$1 AND guest_id=$2 AND agent_id=$3`, [access.share.share_id, access.guest.guest_id, mapping.agent_id]);
      roomId = scopedRoom?.room_id || null;
    }
    let room;
    if (!roomId) {
      room = await createOwnerRoom(client, access.share.owner_id, {
        agent_id: mapping.agent_id,
        agent_name: mapping.agent_name
      }, `Guest ${access.guest.display_name} — ${mapping.agent_name}`);
      roomId = room.id;
      if (mapping.room_mode === 'separate') {
        await client.query(`INSERT INTO guest_share_rooms(share_id,guest_id,agent_id,room_id)
          VALUES($1,$2,$3,$4)`, [access.share.share_id, access.guest.guest_id, mapping.agent_id, roomId]);
      } else {
        await client.query('UPDATE guest_share_agents SET room_id=$2 WHERE share_id=$1 AND agent_id=$3', [access.share.share_id, roomId, mapping.agent_id]);
      }
    } else {
      room = await one(client, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [roomId]);
      s.check(room, 409, 'Guest conversation is unavailable');
    }
    if (room.sharing_enabled === false) continue;
    let member = await one(client, 'SELECT * FROM shared_guest_members WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3', [roomId, access.share.share_id, access.guest.guest_id]);
    if (!member) {
      member = await one(client, `INSERT INTO shared_guest_members(conversation_id,share_id,guest_id,status)
        VALUES($1,$2,$3,'pending') RETURNING *`, [roomId, access.share.share_id, access.guest.guest_id]);
    } else {
      s.check(member.status !== 'removed', 403, 'Guest conversation membership was removed');
    }
    const key = await one(client, 'SELECT key_version FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [roomId, room.key_version, `guest:${access.guest.guest_id}`]);
    rooms.push({
      roomId,
      agentId: room.agent_id,
      agentName: mapping.agent_name,
      title: room.title,
      status: member.status,
      keyVersion: room.key_version,
      membershipVersion: room.membership_version,
      rotationRequired: room.rotation_required,
      keyReady: !room.rotation_required && Boolean(key)
    });
  }
  return rooms;
}

async function guestWorkspace({ sessionId, sessionTokenHash }) {
  return tx(async client => {
    const access = await guestSessionAccess(client, sessionId, sessionTokenHash);
    const rooms = await guestRoomsInTransaction(client, access);
    await client.query('UPDATE guest_sessions SET last_seen_at=NOW() WHERE session_id=$1', [access.session.session_id]);
    return {
      guest: access.guest,
      share: {
        shareId: access.share.share_id,
        roomMode: access.share.room_mode,
        revision: access.share.revision,
        expiresAt: access.share.expires_at || null,
        ...await messageAllowance(client, access)
      },
      rooms
    };
  });
}

async function guestRoomContext({ sessionId, sessionTokenHash, roomId }) {
  return tx(async client => {
    const access = await guestSessionAccess(client, sessionId, sessionTokenHash);
    await guestRoomsInTransaction(client, access);
    const roomAccess = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId, false);
    const room = roomAccess.room;
    const members = (await client.query(`SELECT sm.user_id,sm.role,sm.status,si.display_name,si.public_key
      FROM shared_members sm LEFT JOIN shared_identities si ON si.principal=('user:' || sm.user_id::text)
      WHERE sm.conversation_id=$1 AND sm.status <> 'removed' ORDER BY sm.user_id`, [room.id])).rows.map(member => ({
      kind: 'user',
      id: member.user_id,
      displayName: member.display_name || 'Registered participant',
      role: member.role,
      status: member.status,
      publicKey: member.public_key || null
    }));
    const guests = (await client.query(`SELECT sgm.guest_id,gp.display_name,sgm.status,sgm.last_read_seq
      FROM shared_guest_members sgm JOIN guest_principals gp ON gp.guest_id=sgm.guest_id
      WHERE sgm.conversation_id=$1 AND sgm.share_id=$2 AND sgm.status <> 'removed' ORDER BY sgm.invited_at`, [room.id, roomAccess.share.share_id])).rows.map(member => ({
      kind: 'guest',
      id: member.guest_id,
      displayName: member.display_name,
      role: 'participant',
      status: member.status,
      lastReadSeq: member.last_read_seq
    }));
    const keys = (await client.query(`SELECT key_version,wrapped_key FROM shared_key_envelopes
      WHERE conversation_id=$1 AND principal=$2 ORDER BY key_version`, [room.id, `guest:${roomAccess.guest.guest_id}`])).rows;
    const agentIdentity = await one(client, 'SELECT principal,public_key,display_name FROM shared_identities WHERE principal=$1', [`agent:${room.agent_id}`]);
    const runtime = await one(client, 'SELECT last_seen_at,execution_uncertain FROM shared_runtimes WHERE agent_id=$1', [room.agent_id]);
    const taskSchema = await one(client, `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='shared_tasks' AND column_name='held_result'`);
    return {
      taskSupport: Boolean(taskSchema),
      room: {
        id: room.id,
        agentId: room.agent_id,
        title: room.title,
        keyVersion: room.key_version,
        membershipVersion: room.membership_version,
        rotationRequired: room.rotation_required,
        runtimeLastSeenAt: runtime?.last_seen_at || null,
        executionUncertain: Boolean(runtime?.execution_uncertain)
      },
      member: {
        kind: 'guest',
        id: roomAccess.guest.guest_id,
        displayName: roomAccess.guest.display_name,
        role: 'participant',
        status: roomAccess.member.status,
        lastReadSeq: roomAccess.member.last_read_seq
      },
      members,
      guests,
      keys,
      agentIdentity
    };
  });
}

async function registerGuestIdentity({ sessionId, sessionTokenHash, publicKey }) {
  const key = guestIdentity(publicKey);
  return tx(async client => {
    const access = await guestSessionAccess(client, sessionId, sessionTokenHash);
    const current = await guestForShare(client, access.share.share_id, access.guest.guest_id);
    if (current.public_key) {
      s.check(current.public_key.n === key.n, 409, 'Guest identity already registered; start a new guest session to rejoin');
    }
    const principal = `guest:${access.guest.guest_id}`;
    const existing = await one(client, 'SELECT * FROM shared_identities WHERE principal=$1', [principal]);
    if (existing) s.check(existing.public_key.n === key.n, 409, 'Guest identity already registered; start a new guest session to rejoin');
    if (!existing) {
      await client.query(`INSERT INTO shared_identities(principal,public_key,private_key,display_name)
        VALUES($1,$2,NULL,$3)`, [principal, JSON.stringify(key), access.guest.display_name]);
    }
    await client.query('UPDATE guest_principals SET public_key=$2,status=\'active\',updated_at=NOW() WHERE guest_id=$1', [access.guest.guest_id, JSON.stringify(key)]);
    const rooms = await guestRoomsInTransaction(client, {
      ...access,
      guest: {
        ...access.guest,
        public_key: key,
        status: 'active'
      }
    });
    return {
      guestId: access.guest.guest_id,
      principal,
      publicKey: key,
      rooms
    };
  });
}

function wrappedKey(value) {
  s.check(typeof value === 'string' && /^[A-Za-z0-9+/]{512}$/.test(value), 400, 'Invalid wrapped conversation key');
  return value;
}

async function provisionGuestKeys(ownerId, shareId, body = {}) {
  const guest = s.uuid(body.guestId);
  s.check(Array.isArray(body.envelopes) && body.envelopes.length <= 2000, 400, 'Invalid guest key envelopes');
  s.check(Array.isArray(body.rooms) && body.rooms.length > 0 && body.rooms.length <= 100, 400, 'Guest room snapshots required');
  return tx(async client => {
    const share = await ownerShare(client, ownerId, shareId, true);
    s.check(shareExpiry(share), 409, 'Guest share is unavailable');
    const principal = `guest:${guest}`;
    const guestRow = await guestForShare(client, share.share_id, guest);
    s.check(guestRow.public_key, 409, 'Guest identity is not registered');
    s.check(await one(client, 'SELECT principal FROM shared_identities WHERE principal=$1', [`user:${ownerId}`]), 409, 'Owner shared identity is unavailable');
    const mappings = (await client.query(`SELECT sa.*,CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END AS resolved_room_id,
        sc.agent_id,sc.owner_id,sc.key_version,sc.membership_version,sc.rotation_required,sc.title
      FROM guest_share_agents sa
      JOIN guest_shares gs ON gs.share_id=sa.share_id
      LEFT JOIN guest_share_rooms gsr ON gsr.share_id=sa.share_id AND gsr.guest_id=$2 AND gsr.agent_id=sa.agent_id
      JOIN shared_conversations sc ON sc.id=CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END
      WHERE sa.share_id=$1 AND sa.removed_at IS NULL ORDER BY sa.agent_id`, [share.share_id, guest])).rows.map(mapping => ({
        ...mapping,
        room_id: mapping.resolved_room_id
      }));
    s.check(mappings.length > 0 && mappings.every(mapping => mapping.room_id), 409, 'Guest workspace is not ready');
    s.check(body.rooms.length === mappings.length && new Set(body.rooms.map(room => room.roomId)).size === mappings.length, 400, 'Guest room snapshots must match the selected rooms');
    const rooms = new Map();
    for (const mapping of mappings) {
      const currentRoom = await one(client, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [mapping.room_id]);
      Object.assign(mapping, currentRoom);
      const snapshot = body.rooms.find(room => room.roomId === mapping.room_id);
      s.check(snapshot && snapshot.keyVersion === mapping.key_version && snapshot.membershipVersion === mapping.membership_version &&
        snapshot.rotationRequired === mapping.rotation_required, 409, 'Guest room changed; refresh before provisioning');
      s.check(await one(client, 'SELECT principal FROM shared_identities WHERE principal=$1', [`agent:${mapping.agent_id}`]), 409, 'Agent shared identity is unavailable');
      const retained = (await client.query('SELECT DISTINCT key_version FROM shared_messages WHERE conversation_id=$1 AND deleted_at IS NULL', [mapping.room_id])).rows;
      const targetVersion = Number(mapping.key_version) + (mapping.rotation_required ? 1 : 0);
      const versions = new Set([targetVersion, ...retained.map(row => Number(row.key_version))]);
      const allowed = new Set([`user:${ownerId}`, `agent:${mapping.agent_id}`, principal]);
      const accountMembers = (await client.query(`SELECT user_id FROM shared_members
        WHERE conversation_id=$1 AND status IN ('pending','active') AND (expires_at IS NULL OR expires_at>NOW())`, [mapping.room_id])).rows;
      for (const member of accountMembers) allowed.add(`user:${member.user_id}`);
      for (const member of await s.eligibleGuestMembers(client, mapping.room_id)) allowed.add(`guest:${member.guest_id}`);
      rooms.set(mapping.room_id, { mapping, versions, allowed });
      const member = await one(client, 'SELECT * FROM shared_guest_members WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3', [mapping.room_id, share.share_id, guest]);
      s.check(member && member.status !== 'removed', 403, 'Guest conversation membership unavailable');
    }
    for (const entry of body.envelopes) {
      const roomId = s.uuid(entry.roomId);
      const room = rooms.get(roomId);
      s.check(room, 403, 'Conversation is outside this guest share');
      const version = Number(entry.keyVersion);
      s.check(Number.isInteger(version) && room.versions.has(version), 400, 'Invalid guest key version');
      s.check(room.allowed.has(entry.principal), 403, 'Guest key recipient is outside this room');
      wrappedKey(entry.wrappedKey);
    }
    for (const { mapping, versions, allowed } of rooms.values()) {
      for (const version of versions) {
        for (const recipient of allowed) {
          const existing = await one(client, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [mapping.room_id, version, recipient]);
          const incoming = body.envelopes.find(entry => entry.roomId === mapping.room_id && Number(entry.keyVersion) === version && entry.principal === recipient);
          s.check(existing || incoming, 409, 'Every owner, agent and guest needs keys for retained history');
        }
      }
    }
    for (const entry of body.envelopes) {
      await client.query(`INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [entry.roomId, Number(entry.keyVersion), entry.principal, entry.wrappedKey]);
    }
    for (const mapping of mappings) {
      await client.query(`UPDATE shared_guest_members SET status='active',activated_at=COALESCE(activated_at,NOW()),
        approved_at=COALESCE(approved_at,NOW()),removed_at=NULL
        WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3`, [mapping.room_id, share.share_id, guest]);
      await client.query('UPDATE shared_conversations SET key_version=$2,rotation_required=FALSE,membership_version=membership_version+1 WHERE id=$1', [mapping.room_id, Number(mapping.key_version) + (mapping.rotation_required ? 1 : 0)]);
      await client.query(`INSERT INTO shared_audit(conversation_id,actor_id,actor_kind,action,subject_id)
        VALUES($1,$2,'user',$3,$4)`, [mapping.room_id, ownerId, mapping.rotation_required ? 'guest_keys_rotated' : 'guest_keys_provisioned', guest]);
    }
    return guestWorkspaceInTransaction(client, {
      share,
      session: null,
      guest: {
        guest_id: guest,
        share_id: share.share_id,
        display_name: guestRow.display_name,
        public_key: guestRow.public_key,
        status: guestRow.status
      }
    });
  });
}

async function guestWorkspaceInTransaction(client, access) {
  const rooms = [];
  const mappings = (await client.query(`SELECT sa.*,CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END AS resolved_room_id,
      a.agent_name
    FROM guest_share_agents sa
    JOIN guest_shares gs ON gs.share_id=sa.share_id
    JOIN agents a ON a.agent_id=sa.agent_id
    LEFT JOIN guest_share_rooms gsr ON gsr.share_id=sa.share_id AND gsr.guest_id=$2 AND gsr.agent_id=sa.agent_id
    WHERE sa.share_id=$1 AND sa.removed_at IS NULL ORDER BY a.agent_name`, [access.share.share_id, access.guest.guest_id])).rows.map(mapping => ({
      ...mapping,
      room_id: mapping.resolved_room_id
    }));
  for (const mapping of mappings) {
    const room = mapping.room_id ? await one(client, 'SELECT title,key_version,membership_version,rotation_required,sharing_enabled FROM shared_conversations WHERE id=$1', [mapping.room_id]) : null;
    if (room?.sharing_enabled === false) continue;
    const member = mapping.room_id ? await one(client, 'SELECT status FROM shared_guest_members WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3', [mapping.room_id, access.share.share_id, access.guest.guest_id]) : null;
    const key = room && await one(client, 'SELECT key_version FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [mapping.room_id, room.key_version, `guest:${access.guest.guest_id}`]);
    rooms.push({
      roomId: mapping.room_id,
      agentId: mapping.agent_id,
      agentName: mapping.agent_name,
      title: room?.title || `Guest conversation — ${mapping.agent_name}`,
      status: member?.status || 'pending',
      keyVersion: room?.key_version || 1,
      membershipVersion: room?.membership_version || 1,
      rotationRequired: room?.rotation_required || false,
      keyReady: Boolean(key)
    });
  }
  return {
    guest: access.guest,
    share: {
      shareId: access.share.share_id,
      roomMode: access.share.room_mode,
      revision: access.share.revision,
      expiresAt: access.share.expires_at || null,
      ...(access.session ? await messageAllowance(client, access) : {})
    },
    rooms
  };
}

async function addGuestMember({ shareId, guestId: id, roomId, status = 'pending' }) {
  return tx(async client => {
    await activeShare(client, shareId);
    const guest = await guestForShare(client, shareId, id);
    const mapping = await one(client, `SELECT room_id FROM guest_share_agents
      WHERE share_id=$1 AND room_id=$2 AND removed_at IS NULL`, [shareId, s.uuid(roomId)]);
    s.check(mapping, 403, 'Conversation is outside this guest share');
    s.check(['pending', 'active'].includes(status), 400, 'Invalid guest membership status');
    return one(client, `INSERT INTO shared_guest_members(conversation_id,share_id,guest_id,status,activated_at)
      VALUES($1,$2,$3,$4::varchar(20),CASE WHEN $4::varchar(20)='active' THEN NOW() ELSE NULL END)
      ON CONFLICT(conversation_id,guest_id) DO UPDATE SET status=$4::varchar(20),activated_at=CASE WHEN $4::varchar(20)='active' THEN NOW() ELSE shared_guest_members.activated_at END,removed_at=NULL
      RETURNING *`, [roomId, shareId, guest.guest_id, status]);
  });
}

async function removeGuestMember({ shareId, guestId: id, roomId }) {
  return db.query(`UPDATE shared_guest_members SET status='removed',removed_at=NOW()
    WHERE share_id=$1 AND guest_id=$2 AND conversation_id=$3 RETURNING *`, [s.uuid(shareId), guestId(id), s.uuid(roomId)]).then(result => result.rows[0] || null);
}

async function auditGuest(client, { roomId, shareId, guestId: id, action, subjectId = null }) {
  await client.query(`INSERT INTO shared_audit(conversation_id,actor_id,actor_kind,actor_guest_id,action,subject_id)
    VALUES($1,NULL,'guest',$2,$3,$4)`, [s.uuid(roomId), guestId(id), text(action, 80), subjectId]);
}

async function insertGuestMessage({ sessionId, sessionTokenHash, roomId, body }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    s.uuid(body?.id);
    const prior = await one(client, 'SELECT * FROM shared_messages WHERE id=$1', [body.id]);
    if (prior) {
      s.check(prior.conversation_id === access.room.id && prior.sender_guest_id === access.guest.guest_id, 409, 'Message identifier already used');
      return prior;
    }
    await assertGuestQueueCapacity(client, access);
    await assertGuestMessageAllowance(client, access);
    s.check(!access.room.rotation_required, 409, 'Conversation key rotation is required');
    s.check(!body?.kind || body.kind === 'message', 403, 'Guests can send messages or answer questions');
    s.check(Number(body.keyVersion) === Number(access.room.key_version), 409, 'Stale conversation key');
    s.envelope(body.payload);
    s.check(await one(client, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [roomId, access.room.key_version, `guest:${access.guest.guest_id}`]), 409, 'Guest encryption key is not provisioned');
    const principals = Array.isArray(body.addressedToPrincipals) ? body.addressedToPrincipals : [];
    s.check(principals.length <= 10, 400, 'Too many addressed recipients');
    const fileIds = Array.isArray(body.fileIds) ? [...new Set(body.fileIds.map(id => s.uuid(id)))] : [];
    s.check(fileIds.length <= 10, 400, 'Too many attachments');
    for (const fileId of fileIds) s.check(await one(client, `SELECT id FROM shared_files
      WHERE id=$1 AND conversation_id=$2 AND uploader=$3 AND key_version=$4 AND message_id IS NULL`, [fileId, roomId, `guest:${access.guest.guest_id}`, access.room.key_version]), 400, 'Attachment unavailable');
    const replies = Array.isArray(body.replyTo) ? [...new Set(body.replyTo.map(id => s.uuid(id)))] : [];
    s.check(replies.length <= 10, 400, 'Too many reply references');
    for (const reply of replies) s.check(await require('./messageAudience').visibleMessage(client, roomId, reply,
      { kind: 'guest', id: access.guest.guest_id }), 400, 'Reply is unavailable in this conversation');
    const addressedUsers = [];
    for (const recipient of principals) {
      s.check(recipient && ['user', 'guest'].includes(recipient.kind), 400, 'Invalid addressed principal');
      if (recipient.kind === 'user') {
        const user = await one(client, `SELECT user_id FROM shared_members
          WHERE conversation_id=$1 AND user_id=$2 AND status='active'`, [roomId, s.uuid(recipient.id)]);
        s.check(user, 400, 'Addressed account is not an active member');
        addressedUsers.push(user.user_id);
      } else {
        const guest = await one(client, `SELECT guest_id FROM shared_guest_members
          WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3 AND status='active'`, [roomId, access.share.share_id, guestId(recipient.id)]);
        s.check(guest, 400, 'Addressed guest is not an active member');
      }
    }
    await client.query(`INSERT INTO shared_messages
      (id,conversation_id,sender_guest_id,kind,payload,key_version,addressed_to,reply_to,addressed_to_principals,guest_share_revision)
      VALUES($1,$2,$3,'message',$4,$5,$6,$7,$8,$9)`, [body.id, roomId, access.guest.guest_id, JSON.stringify(body.payload), access.room.key_version, addressedUsers, replies, JSON.stringify(principals), access.share.revision]);
    for (const fileId of fileIds) await client.query('UPDATE shared_files SET message_id=$2 WHERE id=$1', [fileId, body.id]);
    await auditGuest(client, {
      roomId,
      shareId: access.share.share_id,
      guestId: access.guest.guest_id,
      action: 'guest_message',
      subjectId: body.id
    });
    return one(client, 'SELECT * FROM shared_messages WHERE id=$1', [body.id]);
  });
}

async function guestMessagesUsed(client, access) {
  // Deleted messages still count, so removing one never frees a slot.
  const used = await one(client, `SELECT COUNT(*)::integer AS total FROM shared_messages
    WHERE sender_guest_id=$1 AND kind IN ('message','answer')`, [access.guest.guest_id]);
  return used.total;
}

async function messageAllowance(client, access) {
  const limit = access.share.max_messages ? Number(access.share.max_messages) : null;
  if (!limit) return { maxMessages: null, messagesRemaining: null };
  return { maxMessages: limit, messagesRemaining: Math.max(0, limit - await guestMessagesUsed(client, access)) };
}

async function assertGuestMessageAllowance(client, access) {
  const { maxMessages, messagesRemaining } = await messageAllowance(client, access);
  s.check(maxMessages === null || messagesRemaining > 0, 403, `This guest link allows ${maxMessages} messages and you have used them all. Ask the owner for more.`);
}

async function assertGuestQueueCapacity(client, access) {
  // Guest session access holds the share and principal locks across all rooms,
  // so parallel sends cannot both consume the final queue slot.
  const queued = await one(client, `SELECT COUNT(*) AS total FROM shared_messages
    WHERE sender_guest_id=$1 AND batch_id IS NULL AND deleted_at IS NULL`, [access.guest.guest_id]);
  s.check(Number(queued.total) < 64, 409, 'You have 64 requests waiting. Wait for the agent or remove queued messages.');
  const sharedQueue = await one(client, `SELECT COUNT(*) AS total FROM shared_messages m
    JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id
    WHERE gp.share_id=$1 AND m.batch_id IS NULL AND m.deleted_at IS NULL`, [access.share.share_id]);
  s.check(Number(sharedQueue.total) < 256, 409, 'This share has 256 requests waiting. Wait for the agents before sending more.');
}

async function assertGuestRoom({ sessionId, sessionTokenHash, roomId }) {
  return currentGuestAccess({ sessionId, sessionTokenHash, roomId });
}

async function putGuestFile({ sessionId, sessionTokenHash, roomId, keyVersion, id, bytes }) {
  s.check(Buffer.isBuffer(bytes) && bytes.length > 28 && bytes.length <= s.MAX_FILE_BYTES + 28, 400, 'Encrypted file must be at most 20 MB');
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    s.uuid(id);
    const principal = `guest:${access.guest.guest_id}`;
    s.check(!access.room.rotation_required, 409, 'Conversation key rotation is required');
    s.check(Number(keyVersion) === access.room.key_version, 409, 'Stale conversation key');
    s.check(await one(client, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [access.room.id, access.room.key_version, principal]), 409, 'Guest encryption key is not provisioned');
    // Authorization precedes global admission. Hold this lock until commit so
    // uploads from different rooms, shares and server processes cannot overbook.
    const limits = guestStorageLimits();
    const guard = await one(client, 'SELECT id FROM shared_guest_storage_guard WHERE id=1 FOR UPDATE');
    s.check(guard, 503, 'Guest file storage is unavailable');
    assertGuestUploadUnexpired(access);
    const old = await one(client, 'SELECT id,uploader,conversation_id,key_version,message_id,octet_length(bytes) AS stored_bytes FROM shared_files WHERE id=$1', [id]);
    if (old) {
      s.check(old.uploader === principal && old.conversation_id === access.room.id, 409, 'File identifier already used');
      if (!old.message_id && old.key_version !== access.room.key_version) {
        s.check(Number(keyVersion) === access.room.key_version, 409, 'Stale conversation key');
        await reserveGuestFileStorage(client, limits, bytes.length - Number(old.stored_bytes), 0);
        assertGuestUploadUnexpired(access);
        await client.query('UPDATE shared_files SET key_version=$2,bytes=$3 WHERE id=$1 AND message_id IS NULL', [id, access.room.key_version, bytes]);
      }
      return { id };
    }
    await client.query("DELETE FROM shared_files WHERE uploader LIKE 'guest:%' AND message_id IS NULL AND created_at<$1", [new Date(Date.now() - 86400000)]);
    const count = await one(client, 'SELECT COUNT(*) AS total FROM shared_files WHERE uploader=$1', [principal]);
    s.check(Number(count.total) < 10, 409, 'Attachment quota reached (10 files); delete messages with old attachments');
    await reserveGuestFileStorage(client, limits, bytes.length, 1);
    assertGuestUploadUnexpired(access);
    await client.query('INSERT INTO shared_files(id,conversation_id,uploader,key_version,bytes) VALUES($1,$2,$3,$4,$5)', [id, access.room.id, principal, access.room.key_version, bytes]);
    return { id };
  });
}

async function getGuestFile({ sessionId, sessionTokenHash, roomId, id }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    const file = await one(client, 'SELECT * FROM shared_files WHERE id=$1 AND conversation_id=$2', [s.uuid(id), access.room.id]);
    s.check(file && (file.message_id || file.uploader === `guest:${access.guest.guest_id}`), 404, 'File unavailable');
    if (file.message_id) s.check(await require('./messageAudience').visibleMessage(client, roomId, file.message_id,
      { kind: 'guest', id: access.guest.guest_id }), 404, 'File unavailable');
    return file;
  });
}

async function removeGuestFile({ sessionId, sessionTokenHash, roomId, id }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    const file = await one(client, 'SELECT id FROM shared_files WHERE id=$1 AND conversation_id=$2 AND uploader=$3 AND message_id IS NULL', [s.uuid(id), access.room.id, `guest:${access.guest.guest_id}`]);
    s.check(file, 404, 'File unavailable');
    await client.query('DELETE FROM shared_files WHERE id=$1', [file.id]);
    return { ok: true };
  });
}

async function answerGuestQuestion({ sessionId, sessionTokenHash, roomId, questionId, body }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    s.uuid(body?.id);
    const priorById = await one(client, 'SELECT * FROM shared_messages WHERE id=$1', [body.id]);
    if (priorById) {
      s.check(priorById.conversation_id === access.room.id && priorById.sender_guest_id === access.guest.guest_id && priorById.question_id === questionId, 409, 'Message identifier already used');
      return { existing: true, message: priorById };
    }
    await assertGuestQueueCapacity(client, access);
    await assertGuestMessageAllowance(client, access);
    s.check(!access.room.rotation_required, 409, 'Conversation key rotation is required');
    const question = await one(client, `SELECT * FROM shared_messages
      WHERE id=$1 AND conversation_id=$2 AND kind='question' AND deleted_at IS NULL`, [s.uuid(questionId), roomId]);
    s.check(question && await require('./messageAudience').visibleMessage(client, roomId, question.id,
      { kind: 'guest', id: access.guest.guest_id }), 404, 'Question unavailable');
    const addressedUsers = Array.isArray(question.addressed_to) ? question.addressed_to : [];
    const addressedPrincipals = Array.isArray(question.addressed_to_principals) ? question.addressed_to_principals : [];
    s.check(!addressedUsers.length && (!addressedPrincipals.length || addressedPrincipals.some(item => item?.kind === 'guest' && item.id === access.guest.guest_id)), 403, 'This question is addressed to another participant');
    s.check(Number(body.keyVersion) === Number(access.room.key_version), 409, 'Stale conversation key');
    s.envelope(body.payload);
    s.check(await one(client, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [roomId, access.room.key_version, `guest:${access.guest.guest_id}`]), 409, 'Guest encryption key is not provisioned');
    const prior = await one(client, 'SELECT * FROM shared_messages WHERE question_id=$1', [question.id]);
    if (prior) return { existing: true, message: prior };
    const message = await one(client, `INSERT INTO shared_messages
      (id,conversation_id,sender_guest_id,kind,payload,key_version,addressed_to,reply_to,addressed_to_principals,question_id,guest_share_revision)
      VALUES($1,$2,$3,'answer',$4,$5,'{}',$6,'[]'::jsonb,$7,$8) RETURNING *`, [body.id, roomId, access.guest.guest_id, JSON.stringify(body.payload), access.room.key_version, [question.id], question.id, access.share.revision]);
    if (question.recipient_principals !== undefined) {
      await client.query('UPDATE shared_messages SET recipient_principals=$2 WHERE id=$1', [message.id, JSON.stringify(question.recipient_principals)]);
      message.recipient_principals = question.recipient_principals;
    }
    await auditGuest(client, {
      roomId,
      shareId: access.share.share_id,
      guestId: access.guest.guest_id,
      action: 'guest_answer',
      subjectId: message.id
    });
    return { message };
  });
}

async function removeGuestMessage({ sessionId, sessionTokenHash, roomId, messageId }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    const message = await one(client, 'SELECT * FROM shared_messages WHERE id=$1 AND conversation_id=$2', [s.uuid(messageId), roomId]);
    s.check(message && message.sender_guest_id === access.guest.guest_id, 403, 'Guests can delete only their own messages');
    await client.query('UPDATE shared_messages SET payload=NULL,deleted_at=NOW() WHERE id=$1', [message.id]);
    await client.query('DELETE FROM shared_files WHERE message_id=$1', [message.id]);
    await auditGuest(client, {
      roomId,
      shareId: access.share.share_id,
      guestId: access.guest.guest_id,
      action: 'guest_deleted_message',
      subjectId: message.id
    });
    return { ok: true };
  });
}

async function guestRead({ sessionId, sessionTokenHash, roomId, seq }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    s.check(/^\d+$/.test(String(seq)), 400, 'Invalid cursor');
    const max = await one(client, 'SELECT MAX(seq) AS seq FROM shared_messages WHERE conversation_id=$1', [roomId]);
    const value = Math.min(Number(seq), Number(max.seq || 0));
    await client.query('UPDATE shared_guest_members SET last_read_seq=GREATEST(last_read_seq,$3) WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$4', [roomId, access.share.share_id, value, access.guest.guest_id]);
    return { ok: true, lastReadSeq: value };
  });
}

async function currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId, requireActiveMember = true) {
  const access = await guestSessionAccess(client, sessionId, sessionTokenHash);
  const { share, session } = access;
  const mapping = await one(client, `SELECT sc.*,sa.share_id
    FROM guest_share_agents sa
    JOIN guest_shares gs ON gs.share_id=sa.share_id
    LEFT JOIN guest_share_rooms gsr ON gsr.share_id=sa.share_id AND gsr.guest_id=$2 AND gsr.agent_id=sa.agent_id
    JOIN shared_conversations sc ON sc.id=CASE WHEN gs.room_mode='separate' THEN gsr.room_id ELSE sa.room_id END
    WHERE sa.share_id=$1 AND sc.id=$3 AND sa.removed_at IS NULL`, [share.share_id, session.guest_id, s.uuid(roomId)]);
  s.check(mapping, 404, 'Guest conversation unavailable');
  const lockedRoom = await one(client, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [mapping.id]);
  s.check(lockedRoom, 404, 'Guest conversation unavailable');
  s.check(lockedRoom.sharing_enabled !== false, 403, 'Sharing is turned off by the owner');
  const room = { ...mapping, ...lockedRoom };
  const member = await one(client, `SELECT * FROM shared_guest_members WHERE conversation_id=$1 AND share_id=$2 AND guest_id=$3`, [room.id, share.share_id, session.guest_id]);
  s.check(member && (!requireActiveMember || member.status === 'active'), 404, 'Guest conversation membership unavailable');
  await client.query('UPDATE guest_sessions SET last_seen_at=NOW() WHERE session_id=$1', [session.session_id]);
  return {
    ...access,
    room,
    member
  };
}

async function guestMessageStatuses({ sessionId, sessionTokenHash, roomId, messageIds }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    return s.messageStatusesInTransaction(client, roomId, messageIds, { kind: 'guest', id: access.guest.guest_id });
  });
}
async function guestHistory({ sessionId, sessionTokenHash, roomId, after = 0, since = null, before = null, limit = 200 }) {
  return tx(async client => {
    const access = await currentGuestAccessInTransaction(client, sessionId, sessionTokenHash, roomId);
    s.check(/^\d+$/.test(String(after)), 400, 'Invalid timeline cursor');
    s.check(since === null || typeof since === 'string' && Number.isFinite(Date.parse(since)), 400, 'Invalid timeline update cursor');
    s.check(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 200, 400, 'Invalid timeline page size');
    const viewer = { kind: 'guest', id: access.guest.guest_id };
    if (before !== null) {
      s.check(/^\d+$/.test(String(before)), 400, 'Invalid history cursor');
      const filter = await require('./messageAudience').visibilityFilter(client, viewer, 3);
      const limitPosition = filter ? 4 : 3;
      const rows = (await client.query(`SELECT m.*,COALESCE(si.display_name,gp.display_name) AS display_name
        FROM shared_messages m LEFT JOIN shared_identities si ON si.principal=CASE
          WHEN m.sender_user_id IS NOT NULL THEN 'user:' || m.sender_user_id::text
          WHEN m.sender_agent_id IS NOT NULL THEN 'agent:' || m.sender_agent_id::text ELSE NULL END
        LEFT JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id
        WHERE m.conversation_id=$1 AND m.seq<$2 ${filter} ORDER BY m.seq DESC LIMIT $${limitPosition}`,
        [roomId, before, ...(filter ? [JSON.stringify([viewer])] : []), Number(limit)])).rows;
      return rows.reverse();
    }
    const filter = await require('./messageAudience').visibilityFilter(client, viewer, 4);
    const limitPosition = filter ? 5 : 4;
    return (await client.query(`SELECT m.*,COALESCE(si.display_name,gp.display_name) AS display_name
      FROM shared_messages m
      LEFT JOIN shared_identities si ON si.principal=CASE
        WHEN m.sender_user_id IS NOT NULL THEN 'user:' || m.sender_user_id::text
        WHEN m.sender_agent_id IS NOT NULL THEN 'agent:' || m.sender_agent_id::text
        ELSE NULL END
      LEFT JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id
      WHERE m.conversation_id=$1 AND (m.seq>$2 OR ($3::timestamptz IS NOT NULL AND m.deleted_at>$3)) ${filter} ORDER BY m.seq LIMIT $${limitPosition}`, [roomId, after, since,
        ...(filter ? [JSON.stringify([viewer])] : []), Number(limit)])).rows;
  });
}

// A signed-in visitor asks to join every conversation behind a common-room link.
// Nothing is granted here: the owner approves each request in the Share panel.
async function requestAccountAccess(userId, verifiedShare, note) {
  const userKey = s.uuid(userId);
  const cleanNote = requestNote(note);
  return tx(async client => {
    const share = await activeShare(client, verifiedShare.share_id, verifiedShare.revision, true);
    s.check(share.token_hash === verifiedShare.token_hash, 409, 'Guest share has changed');
    s.check(share.room_mode === 'common', 409, 'This link only admits guests. Continue as a guest instead.');
    s.check(share.owner_id !== userKey, 409, 'This is your own link');
    // The owner decides by the requester's email, so it must be proven first.
    const account = await one(client, 'SELECT email_verified FROM users WHERE user_id=$1', [userKey]);
    s.check(account?.email_verified === true, 403, 'Verify your email address before asking with your account, or continue as a guest');
    const rooms = (await client.query(`SELECT sa.room_id,sc.sharing_enabled FROM guest_share_agents sa
      JOIN shared_conversations sc ON sc.id=sa.room_id WHERE sa.share_id=$1 AND sa.removed_at IS NULL`, [share.share_id])).rows;
    s.check(rooms.some(room => room.sharing_enabled !== false), 403, 'Sharing is turned off by the owner');
    const wanted = [];
    let member = 0;
    for (const room of rooms.filter(room => room.sharing_enabled !== false)) {
      const existing = await one(client, 'SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [room.room_id, userKey]);
      if (existing && existing.status !== 'removed') member++;
      else wanted.push(room);
    }
    // Approval provisions keys to the account's sharing identity, so it must exist first.
    if (wanted.length) s.check(await one(client, 'SELECT principal FROM shared_identities WHERE principal=$1', [`user:${userKey}`]), 409,
      'Open your dashboard once to set up encrypted sharing, then send the request again');
    let requested = 0;
    for (const room of wanted) {
      const pending = await one(client, `SELECT request_id FROM guest_share_account_requests
        WHERE conversation_id=$1 AND user_id=$2 AND state='pending' FOR UPDATE`, [room.room_id, userKey]);
      if (pending) await client.query('UPDATE guest_share_account_requests SET note=COALESCE($2,note) WHERE request_id=$1', [pending.request_id, cleanNote]);
      else await client.query(`INSERT INTO guest_share_account_requests(share_id,conversation_id,user_id,note)
        VALUES($1,$2,$3,$4)`, [share.share_id, room.room_id, userKey, cleanNote]);
      requested++;
    }
    return { state: requested ? 'pending' : 'member', requested, alreadyMember: member };
  });
}

module.exports = {
  requestAccountAccess,
  createOwnerShare,
  listOwnerShares,
  getOwnerShare,
  updateOwnerShare,
  replaceShareAgents,
  removeGuest,
  findShareByLinkSecret,
  previewGuestLink,
  createGuestPrincipal,
  createUnlockedGuestSession,
  setGuestIdentity,
  registerGuestIdentity,
  createGuestSession,
  revokeGuestSession,
  currentGuestAccess,
  currentGuestAccessInTransaction,
  guestWorkspace,
  guestRoomContext,
  assertGuestRoom,
  putGuestFile,
  getGuestFile,
  removeGuestFile,
  provisionGuestKeys,
  addGuestMember,
  removeGuestMember,
  insertGuestMessage,
  answerGuestQuestion,
  removeGuestMessage,
  guestRead,
  guestHistory,
  guestMessageStatuses,
  auditGuest,
  activeShare,
  guestForShare
};
