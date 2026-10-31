'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const executionPolicy = require('./executionPolicy');
const trustedExecution = require('./trustedExecution');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 20 * 1000 * 1000;
class SharedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function check(ok, status, message) {
  if (!ok) throw new SharedError(status, message);
}
function uuid(v) {
  check(typeof v === 'string' && UUID.test(v), 400, 'Invalid identifier');
  return v;
}
function label(v, max = 120) {
  check(typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max, 400, 'Invalid text length');
  return v.trim();
}
function envelope(v) {
  check(v && v.v === 1 && typeof v.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(v.iv) && typeof v.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v.data) && v.data.length >= 24 && v.data.length <= 1500000, 400, 'Encrypted content required');
  return {
    v: 1,
    iv: v.iv,
    data: v.data
  };
}
function ids(v = []) {
  check(Array.isArray(v) && v.length <= 100, 400, 'Invalid identifier list');
  return [...new Set(v.map(uuid))];
}
async function tx(fn) {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function one(c, sql, params) {
  return (await c.query(sql, params)).rows[0];
}
async function chatThreadSchema(c) {
  return one(c, `SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='agent_chat_threads'`);
}
async function assertSharedThreadActive(c, roomId) {
  if (!await chatThreadSchema(c)) return;
  const binding = await one(c, 'SELECT state FROM agent_chat_threads WHERE conversation_id=$1', [roomId]);
  check(!binding || binding.state === 'shared', 409, 'Finish preparing this conversation before sharing messages or invitations');
}
async function audit(c, room, user, action, subject = null) {
  await c.query('INSERT INTO shared_audit(conversation_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)', [room, user, action, subject]);
}
async function roomAccess(c, roomId, userId, manage = false, pending = false) {
  const room = await one(c, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [uuid(roomId)]);
  check(room, 404, 'Shared conversation not found');
  const member = await one(c, 'SELECT * FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [roomId, userId]);
  check(member && (member.status === 'active' || pending && member.status === 'pending'), 404, 'Shared conversation not found');
  check(room.sharing_enabled !== false || room.owner_id === userId, 403, 'Sharing is turned off by the owner');
  check(!manage || ['owner', 'manager'].includes(member.role), 403, 'Manager role required');
  return {
    ...room,
    member
  };
}
async function agentRoom(c, roomId, agentId) {
  const room = await one(c, 'SELECT * FROM shared_conversations WHERE id=$1 AND agent_id=$2 FOR UPDATE', [uuid(roomId), agentId]);
  check(room, 404, 'Shared conversation not found');
  return room;
}
async function sharingSettings(userId, roomId, enabled) {
  check(enabled === undefined || typeof enabled === 'boolean', 400, 'enabled must be a boolean');
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    check(room.owner_id === userId, 403, 'Only the owner can change sharing');
    await assertSharedThreadActive(c, roomId);
    if (enabled !== undefined && enabled !== (room.sharing_enabled !== false)) {
      await c.query('UPDATE shared_conversations SET sharing_enabled=$2 WHERE id=$1', [roomId, enabled]);
      await audit(c, roomId, userId, enabled ? 'sharing_enabled' : 'sharing_disabled');
    }
    return { enabled: enabled === undefined ? room.sharing_enabled !== false : enabled };
  });
}
async function approveGuest(userId, roomId, guestId) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    check(room.owner_id === userId, 403, 'Only the owner can approve guests');
    const request = (await eligibleGuestMembers(c, roomId, { requests: true })).find(guest => guest.guest_id === uuid(guestId));
    check(request, 404, 'This guest request is no longer waiting');
    await c.query('UPDATE shared_guest_members SET approved_at=NOW() WHERE conversation_id=$1 AND guest_id=$2', [roomId, request.guest_id]);
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, 'guest_approved', request.guest_id);
    return { ok: true };
  });
}
// Requests signed-in people sent through a guest link (guestService.requestAccountAccess).
async function pendingAccountRequests(c, roomId) {
  const exists = await one(c, `SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='guest_share_account_requests'`);
  if (!exists) return [];
  return (await c.query(`SELECT r.request_id,r.user_id,r.note,r.created_at,si.display_name,u.email
    FROM guest_share_account_requests r JOIN guest_shares gs ON gs.share_id=r.share_id
    JOIN users u ON u.user_id=r.user_id LEFT JOIN shared_identities si ON si.principal=('user:' || r.user_id::text)
    WHERE r.conversation_id=$1 AND r.state='pending' AND gs.revoked_at IS NULL
      AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) ORDER BY r.created_at`, [roomId])).rows;
}
// Approval adds a pending member, exactly like an accepted email invitation; the
// owner's browser then provisions that member's keys.
async function decideAccountRequest(userId, roomId, requestId, approve) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    check(room.owner_id === userId, 403, 'Only the owner can answer access requests');
    const request = (await pendingAccountRequests(c, roomId)).find(item => item.request_id === uuid(requestId));
    check(request, 404, 'This request is no longer waiting');
    if (approve) {
      check(room.sharing_enabled !== false, 403, 'Turn sharing on before approving requests');
      const member = await one(c, 'SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE', [roomId, request.user_id]);
      if (!member || member.status === 'removed') {
        await c.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
          VALUES($1,$2,'participant','pending',$3)
          ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='participant',status='pending',invited_by=$3,expires_at=NULL`, [roomId, request.user_id, userId]);
        await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
      }
    }
    await c.query(`UPDATE guest_share_account_requests SET state=$2,decided_at=NOW() WHERE request_id=$1`, [request.request_id, approve ? 'approved' : 'declined']);
    await audit(c, roomId, userId, approve ? 'account_request_approved' : 'account_request_declined', request.user_id);
    return { ok: true };
  });
}
async function writable(c, room, principal = `agent:${room.agent_id}`) {
  check(!room.rotation_required, 409, 'Conversation key rotation is required');
  const key = await one(c, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [room.id, room.key_version, principal]);
  check(key, 409, principal.startsWith('agent:') ? 'Agent encryption key is not provisioned' : 'Your conversation key is not provisioned');
}
async function registerIdentity(principal, body, agent = false) {
  const key = body.publicKey;
  check(key && key.kty === 'RSA' && key.e === 'AQAB' && typeof key.n === 'string' && key.n.length === 512 && !key.d && !key.p && !key.q, 400, 'RSA-3072 public key required');
  try {
    crypto.createPublicKey({
      key,
      format: 'jwk'
    });
  } catch (_) {
    throw new SharedError(400, 'Invalid public key');
  }
  const publicKey = {
    kty: 'RSA',
    n: key.n,
    e: key.e,
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['wrapKey']
  };
  return tx(async c => {
    await c.query('INSERT INTO shared_identities(principal,public_key,private_key,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(principal) DO NOTHING', [principal, JSON.stringify(publicKey), agent ? null : JSON.stringify(envelope(body.privateKey)), label(body.displayName, 80)]);
    const saved = await one(c, 'SELECT * FROM shared_identities WHERE principal=$1', [principal]);
    check(saved.public_key.n === key.n, 409, 'Identity key already registered. Restore its encrypted private key; key replacement requires explicit recovery.');
    return saved;
  });
}
async function identity(principal) {
  return (await one(db, 'SELECT * FROM shared_identities WHERE principal=$1', [principal])) || null;
}
async function rewrapIdentity(userId, body) {
  const principal = 'user:' + userId;
  const current = await identity(principal);
  check(current, 404, 'Shared identity unavailable');
  const key = body?.publicKey;
  check(key && key.kty === 'RSA' && key.e === 'AQAB' && typeof key.n === 'string' && key.n === current.public_key.n && key.n.length === 512 && !key.d && !key.p && !key.q, 409, 'Rewrapping must preserve the existing key pair');
  try {
    crypto.createPublicKey({
      key,
      format: 'jwk'
    });
  } catch (_) {
    throw new SharedError(400, 'Invalid public key');
  }
  await db.query('UPDATE shared_identities SET private_key=$2 WHERE principal=$1', [principal, JSON.stringify(envelope(body.privateKey))]);
  return {
    ok: true
  };
}
async function recoverIdentity(userId, body) {
  check(body.confirm === true, 400, 'Confirm that shared access will pause until another manager approves recovery');
  const key = body.publicKey;
  check(key && key.kty === 'RSA' && key.e === 'AQAB' && typeof key.n === 'string' && key.n.length === 512 && !key.d, 400, 'RSA-3072 public key required');
  try {
    crypto.createPublicKey({
      key,
      format: 'jwk'
    });
  } catch (_) {
    throw new SharedError(400, 'Invalid public key');
  }
  const publicKey = {
    kty: 'RSA',
    n: key.n,
    e: key.e,
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['wrapKey']
  };
  return tx(async c => {
    check(await one(c, 'SELECT principal FROM shared_identities WHERE principal=$1', [`user:${userId}`]), 404, 'Shared identity unavailable');
    const memberships = (await c.query("SELECT conversation_id FROM shared_members WHERE user_id=$1 AND status IN ('active','pending','recovering') ORDER BY conversation_id", [userId])).rows;
    for (const m of memberships) {
      await one(c, 'SELECT id FROM shared_conversations WHERE id=$1 FOR UPDATE', [m.conversation_id]);
      await c.query("UPDATE shared_members SET status='recovering' WHERE conversation_id=$1 AND user_id=$2", [m.conversation_id, userId]);
      await c.query('UPDATE shared_conversations SET rotation_required=TRUE,membership_version=membership_version+1 WHERE id=$1', [m.conversation_id]);
      await audit(c, m.conversation_id, userId, 'requested_key_recovery');
    }
    await c.query('DELETE FROM shared_key_envelopes WHERE principal=$1', ['user:' + userId]);
    await c.query('UPDATE shared_identities SET public_key=$2,private_key=$3 WHERE principal=$1', ['user:' + userId, JSON.stringify(publicKey), JSON.stringify(envelope(body.privateKey))]);
    return {
      ok: true
    };
  });
}
async function approveRecovery(userId, roomId, target) {
  return tx(async c => {
    await roomAccess(c, roomId, userId, true);
    check(userId !== target, 403, 'Another manager must approve recovery');
    const member = await one(c, "SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2 AND status='recovering'", [roomId, uuid(target)]);
    check(member, 404, 'Recovery request unavailable');
    await c.query("UPDATE shared_members SET status='pending' WHERE conversation_id=$1 AND user_id=$2", [roomId, target]);
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, 'approved_key_recovery', target);
    return {
      ok: true
    };
  });
}
async function list(userId) {
  const rooms = (await db.query(`SELECT sc.*, sm.role, sm.status, sm.last_read_seq, a.agent_name
    FROM shared_conversations sc JOIN shared_members sm ON sm.conversation_id=sc.id JOIN agents a ON a.agent_id=sc.agent_id
    WHERE sm.user_id=$1 AND sm.status <> 'removed' ORDER BY sc.created_at`, [userId])).rows;
  const agents = (await db.query(`SELECT a.agent_id,a.agent_name,r.last_seen_at,r.capabilities FROM agents a
    JOIN shared_runtimes r ON r.agent_id=a.agent_id WHERE a.user_id=$1`, [userId])).rows;
  for (const room of rooms) {
    const viewer = { kind: 'user', id: userId };
    const filter = await require('./messageAudience').visibilityFilter(db, viewer, 4);
    const unread = await one(db, `SELECT COUNT(*) AS total FROM shared_messages m WHERE conversation_id=$1 AND seq>$2 AND deleted_at IS NULL AND (sender_user_id IS NULL OR sender_user_id<>$3) ${filter}`, [room.id, room.last_read_seq, userId,
      ...(filter ? [JSON.stringify([viewer])] : [])]);
    room.unread = Number(unread.total);
  }
  return {
    rooms,
    agents,
    userId
  };
}
async function create(userId, body) {
  return tx(async c => {
    const a = await one(c, 'SELECT a.agent_id,r.last_seen_at FROM agents a JOIN shared_runtimes r ON r.agent_id=a.agent_id WHERE a.agent_id=$1 AND a.user_id=$2', [uuid(body.agentId), userId]);
    check(a && Date.now() - new Date(a.last_seen_at).getTime() < 120000, 409, 'Connect a shared-capable runner first');
    check(await one(c, 'SELECT principal FROM shared_identities WHERE principal=$1', [`user:${userId}`]), 409, 'Unlock your shared identity first');
    const r = await one(c, 'INSERT INTO shared_conversations(agent_id,owner_id,title) VALUES($1,$2,$3) RETURNING *', [a.agent_id, userId, label(body.title)]);
    await c.query("INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by) VALUES($1,$2,'owner','active',$2)", [r.id, userId]);
    return r;
  });
}
async function invite(userId, roomId, body) {
  return tx(async c => {
    await roomAccess(c, roomId, userId, true);
    await assertSharedThreadActive(c, roomId);
    const role = body.role || 'participant';
    check(['manager', 'participant'].includes(role), 400, 'Invalid role');
    const u = await one(c, 'SELECT user_id FROM users WHERE LOWER(email)=LOWER($1)', [label(body.email, 255)]);
    check(u, 400, 'Invitation requires an existing registered account');
    const prior = await one(c, 'SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [roomId, u.user_id]);
    check(!prior || prior.status === 'removed', 409, 'User is already invited or a member');
    await c.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by,expires_at)
      VALUES($1,$2,$3,'invited',$4,$5) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role=$3,status='invited',invited_by=$4,expires_at=$5`, [roomId, u.user_id, role, userId, new Date(Date.now() + 7 * 86400000)]);
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, 'invite', u.user_id);
    return {
      invited: true
    };
  });
}
async function accept(userId, roomId) {
  return tx(async c => {
    const room = await one(c, 'SELECT * FROM shared_conversations WHERE id=$1 FOR UPDATE', [uuid(roomId)]);
    check(room?.sharing_enabled !== false, 403, 'Sharing is turned off by the owner');
    await assertSharedThreadActive(c, roomId);
    const m = await one(c, 'SELECT * FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [roomId, userId]);
    check(m && m.status === 'invited' && new Date(m.expires_at) > new Date(), 404, 'Invitation unavailable or expired');
    check(await one(c, 'SELECT principal FROM shared_identities WHERE principal=$1', [`user:${userId}`]), 409, 'Unlock your shared identity first');
    await c.query("UPDATE shared_members SET status='pending',expires_at=NULL WHERE conversation_id=$1 AND user_id=$2", [roomId, userId]);
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, 'accepted');
    return {
      status: 'pending'
    };
  });
}
async function decline(userId, roomId) {
  return tx(async c => {
    await one(c, 'SELECT id FROM shared_conversations WHERE id=$1 FOR UPDATE', [uuid(roomId)]);
    const result = await c.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2 AND status='invited' RETURNING user_id", [roomId, userId]);
    check(result.rows.length, 404, 'Invitation unavailable');
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, 'declined');
    return {
      ok: true
    };
  });
}
async function membership(userId, roomId, target, body) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId, target !== userId);
    uuid(target);
    const m = await one(c, 'SELECT * FROM shared_members WHERE conversation_id=$1 AND user_id=$2', [roomId, target]);
    check(m && m.status !== 'removed' && m.role !== 'owner', 403, 'The owner cannot be removed or demoted');
    if (body.role) {
      check(room.member.role === 'owner', 403, 'Only the owner assigns existing roles');
      check(['manager', 'participant'].includes(body.role), 400, 'Invalid role');
      await c.query('UPDATE shared_members SET role=$3 WHERE conversation_id=$1 AND user_id=$2', [roomId, target, body.role]);
    } else {
      await c.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2", [roomId, target]);
      await c.query('DELETE FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [roomId, `user:${target}`]);
      // Rotate even after a pending invitation: prior membership may have held old keys.
      await c.query('UPDATE shared_conversations SET rotation_required=TRUE WHERE id=$1', [roomId]);
    }
    await c.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1', [roomId]);
    await audit(c, roomId, userId, body.role ? `role:${body.role}` : 'removed', target);
    return {
      ok: true
    };
  });
}
async function details(c, room, principal) {
  const members = (await c.query(`SELECT sm.user_id,sm.role,sm.status,si.display_name,si.public_key
    FROM shared_members sm LEFT JOIN shared_identities si ON si.principal=('user:' || sm.user_id::text)
    WHERE sm.conversation_id=$1 AND sm.status <> 'removed'`, [room.id])).rows;
  const keys = (await c.query('SELECT key_version,wrapped_key FROM shared_key_envelopes WHERE conversation_id=$1 AND principal=$2', [room.id, principal])).rows;
  const runtime = await one(c, `SELECT r.capabilities,r.last_seen_at,r.execution_kind,r.execution_uncertain,b.id AS execution_id,
    b.conversation_id AS execution_conversation_id FROM shared_runtimes r
    LEFT JOIN shared_batches b ON b.id=r.execution_id AND b.agent_id=r.agent_id AND b.conversation_id=$2
    WHERE r.agent_id=$1`, [room.agent_id, room.id]);
  if (runtime?.capabilities && typeof runtime.capabilities === 'object') delete runtime.capabilities.credentialId;
  const agentIdentity = await one(c, 'SELECT principal,public_key,display_name FROM shared_identities WHERE principal=$1', [`agent:${room.agent_id}`]);
  const guests = await eligibleGuestMembers(c, room.id);
  const guestRequests = principal === `user:${room.owner_id}` ? await eligibleGuestMembers(c, room.id, { requests: true }) : [];
  const accountRequests = principal === `user:${room.owner_id}` ? await pendingAccountRequests(c, room.id) : [];
  const taskSchema = await one(c, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_tasks' AND column_name='held_result'`);
  return {
    room,
    members,
    keys,
    runtime,
    agentIdentity,
    guests,
    guestRequests,
    accountRequests,
    taskSupport: Boolean(taskSchema)
  };
}
async function eligibleGuestMembers(c, roomId, { requests = false } = {}) {
  const exists = await one(c, `SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='shared_guest_members'`);
  if (!exists) return [];
  // A link holder only gets keys after the owner approves them; requests lists
  // the guests still waiting for that decision.
  const approval = requests ? "gm.status='pending' AND gm.approved_at IS NULL" : "(gm.status='active' OR gm.approved_at IS NOT NULL)";
  const noteColumn = await one(c, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='guest_principals' AND column_name='request_note'`);
  return (await c.query(`SELECT gm.guest_id,gm.status,gm.role,gm.invited_at,gp.display_name,gp.public_key${noteColumn ? ',gp.request_note' : ''}
    FROM shared_guest_members gm JOIN guest_principals gp ON gp.guest_id=gm.guest_id AND gp.share_id=gm.share_id
    JOIN guest_shares gs ON gs.share_id=gm.share_id
    JOIN shared_conversations sc ON sc.id=gm.conversation_id
    JOIN guest_share_agents sa ON sa.share_id=gs.share_id AND sa.agent_id=sc.agent_id
    WHERE gm.conversation_id=$1 AND gm.status IN ('pending','active') AND ${approval} AND gp.status<>'revoked'
      AND gp.public_key IS NOT NULL AND gs.revoked_at IS NULL AND (gs.expires_at IS NULL OR gs.expires_at>NOW())
      AND sa.removed_at IS NULL ORDER BY gm.guest_id`, [roomId])).rows;
}
async function get(userId, roomId) {
  return tx(async c => details(c, await roomAccess(c, roomId, userId, false, true), `user:${userId}`));
}
async function provision(userId, roomId, body) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId, true);
    check(body.membershipVersion === room.membership_version && body.keyVersion === room.key_version, 409, 'Membership or key changed; refresh before provisioning');
    const targetVersion = room.key_version + (room.rotation_required ? 1 : 0);
    const members = (await c.query("SELECT user_id,status FROM shared_members WHERE conversation_id=$1 AND status IN ('pending','active')", [roomId])).rows;
    const guests = await eligibleGuestMembers(c, roomId);
    const principals = members.map(m => `user:${m.user_id}`).concat(`agent:${room.agent_id}`, guests.map(m => `guest:${m.guest_id}`));
    check(Array.isArray(body.envelopes) && body.envelopes.length <= 2000, 400, 'Invalid key envelopes');
    const requiredVersions = new Set([targetVersion]);
    const retained = (await c.query('SELECT DISTINCT key_version FROM shared_messages WHERE conversation_id=$1 AND deleted_at IS NULL', [roomId])).rows;
    retained.forEach(r => requiredVersions.add(r.key_version));
    for (const principal of principals) {
      for (const version of requiredVersions) {
        const existing = await one(c, 'SELECT principal FROM shared_key_envelopes WHERE conversation_id=$1 AND key_version=$2 AND principal=$3', [roomId, version, principal]);
        const entry = body.envelopes.find(e => e.principal === principal && e.keyVersion === version);
        check(existing || entry, 409, 'Every member needs keys for all retained history');
      }
    }
    for (const e of body.envelopes) {
      check(principals.includes(e.principal) && requiredVersions.has(e.keyVersion) && typeof e.wrappedKey === 'string' && /^[A-Za-z0-9+/]{512}$/.test(e.wrappedKey), 400, 'Invalid key recipient or envelope');
      await c.query('INSERT INTO shared_key_envelopes(conversation_id,key_version,principal,wrapped_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [roomId, e.keyVersion, e.principal, e.wrappedKey]);
    }
    await c.query("UPDATE shared_members SET status='active' WHERE conversation_id=$1 AND status='pending'", [roomId]);
    for (const guest of guests) await c.query("UPDATE shared_guest_members SET status='active',activated_at=COALESCE(activated_at,NOW()) WHERE conversation_id=$1 AND guest_id=$2 AND status='pending'", [roomId, guest.guest_id]);
    await c.query('UPDATE shared_conversations SET key_version=$2,rotation_required=FALSE,membership_version=membership_version+$3 WHERE id=$1', [roomId, targetVersion, guests.length ? 1 : 0]);
    await audit(c, roomId, userId, room.rotation_required ? 'rotated_keys' : 'provisioned_keys');
    return {
      keyVersion: targetVersion
    };
  });
}
async function hasAgentReadReceipts(c) {
  return Boolean(await one(c, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='agent_read_at'`));
}
async function messageStatusesInTransaction(c, roomId, requestedIds, viewer) {
  check(Array.isArray(requestedIds) && requestedIds.length <= 100, 400, 'Request at most 100 message receipts');
  const messageIds = ids(requestedIds);
  if (!messageIds.length) return [];
  const filter = await require('./messageAudience').visibilityFilter(c, viewer, 3);
  const receipt = await hasAgentReadReceipts(c) ? 'm.agent_read_at' : 'NULL::timestamptz AS agent_read_at';
  const rows = (await c.query(`SELECT m.id,${receipt} FROM shared_messages m
    WHERE m.conversation_id=$1 AND m.id=ANY($2::uuid[]) AND m.sender_agent_id IS NULL AND m.deleted_at IS NULL ${filter}`,
    [roomId, messageIds, ...(filter ? [JSON.stringify([viewer])] : [])])).rows;
  return rows.map(row => ({ messageId: row.id, serverReceived: true,
    readAt: row.agent_read_at ? new Date(row.agent_read_at).toISOString() : null,
    deliveryState: row.agent_read_at ? 'read' : 'delivered' }));
}
async function messageStatuses(userId, roomId, requestedIds) {
  return tx(async c => {
    await roomAccess(c, roomId, userId);
    return messageStatusesInTransaction(c, roomId, requestedIds, { kind: 'user', id: userId });
  });
}
async function markBatchRead(agentId, runtimeId, batchId, body, credentialId = null) {
  const requested = ids(body?.messageIds);
  check(requested.length > 0 && requested.length <= 20, 400, 'Acknowledge 1–20 source messages');
  return tx(async c => {
    const active = await runtime(c, agentId, runtimeId, credentialId);
    const batch = await one(c, 'SELECT * FROM shared_batches WHERE id=$1 AND agent_id=$2 FOR UPDATE', [uuid(batchId), agentId]);
    check(batch && batch.status === 'processing' && active.execution_id === batchId && active.execution_kind === 'shared',
      409, 'Only the current shared execution can acknowledge messages');
    const source = (await c.query(`SELECT id FROM shared_messages WHERE batch_id=$1 AND id=ANY($2::uuid[])
      AND conversation_id=$3 AND sender_agent_id IS NULL AND deleted_at IS NULL`, [batchId, requested, batch.conversation_id])).rows;
    check(source.length === requested.length, 404, 'Batch source message unavailable');
    if (!await hasAgentReadReceipts(c)) return { ok: true, receiptStored: false };
    await c.query(`UPDATE shared_messages SET agent_read_at=COALESCE(agent_read_at,NOW())
      WHERE batch_id=$1 AND id=ANY($2::uuid[])`, [batchId, requested]);
    return { ok: true, receiptStored: true };
  });
}
async function timeline(c, roomId, after = 0, agentContext = false, viewer = null, since = null, before = null, limit = 200) {
  check(/^\d+$/.test(String(after)), 400, 'Invalid timeline cursor');
  check(since === null || typeof since === 'string' && Number.isFinite(Date.parse(since)), 400, 'Invalid timeline update cursor');
  check(Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 200, 400, 'Invalid timeline page size');
  if (before !== null) {
    check(/^\d+$/.test(String(before)), 400, 'Invalid history cursor');
    const guestSchema = await one(c, `SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name='guest_principals'`);
    const filter = await require('./messageAudience').visibilityFilter(c, viewer, 3);
    const limitPosition = filter ? 4 : 3;
    const rows = (await c.query(`SELECT m.*,${guestSchema ? 'COALESCE(si.display_name,gp.display_name) AS display_name' : 'si.display_name'}
      FROM shared_messages m LEFT JOIN shared_identities si
        ON si.principal=CASE WHEN m.sender_user_id IS NOT NULL THEN 'user:' || m.sender_user_id::text
          ${guestSchema ? "WHEN m.sender_guest_id IS NOT NULL THEN 'guest:' || m.sender_guest_id::text" : ''}
          ELSE 'agent:' || m.sender_agent_id::text END
      ${guestSchema ? 'LEFT JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id' : ''}
      WHERE m.conversation_id=$1 AND m.seq<$2 ${filter} ORDER BY m.seq DESC LIMIT $${limitPosition}`,
      [roomId, before, ...(filter ? [JSON.stringify([viewer])] : []), Number(limit)])).rows;
    return rows.reverse();
  }
  const guestSchema = await one(c, `SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='guest_principals'`);
  const contextSchema = agentContext ? await one(c, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='agent_context_eligible'`) : null;
  const contextFilter = contextSchema ? 'AND m.agent_context_eligible=TRUE' : '';
  const audienceFilter = await require('./messageAudience').visibilityFilter(c, viewer, 4);
  const limitPosition = audienceFilter ? 5 : 4;
  return (await c.query(`SELECT m.*,${guestSchema ? 'COALESCE(si.display_name,gp.display_name) AS display_name' : 'si.display_name'}
    FROM shared_messages m LEFT JOIN shared_identities si
    ON si.principal=CASE WHEN m.sender_user_id IS NOT NULL THEN 'user:' || m.sender_user_id::text
      ${guestSchema ? "WHEN m.sender_guest_id IS NOT NULL THEN 'guest:' || m.sender_guest_id::text" : ''}
      ELSE 'agent:' || m.sender_agent_id::text END
    ${guestSchema ? 'LEFT JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id' : ''}
    WHERE m.conversation_id=$1 AND (m.seq>$2 OR ($3::timestamptz IS NOT NULL AND m.deleted_at>$3)) ${contextFilter} ${audienceFilter} ORDER BY m.seq LIMIT $${limitPosition}`, [roomId, after, since,
      ...(audienceFilter ? [JSON.stringify([viewer])] : []), Number(limit)])).rows;
}
async function history(userId, roomId, after, since = null, before = null, limit = 200) {
  return tx(async c => {
    await roomAccess(c, roomId, userId);
    return timeline(c, roomId, after, false, { kind: 'user', id: userId }, since, before, limit);
  });
}
async function validateMessage(c, room, body, agent = false, principal) {
  uuid(body.id);
  check(body.keyVersion === room.key_version, 409, 'Stale conversation key');
  envelope(body.payload);
  await writable(c, room, principal);
  let addressed = ids(body.addressedTo);
  let addressedPrincipals = null;
  if (body.addressedToPrincipals !== undefined) {
    check(Array.isArray(body.addressedToPrincipals) && body.addressedToPrincipals.length <= 100, 400, 'Invalid addressed principal list');
    check(await one(c, `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='shared_guest_members'`), 409, 'Typed recipients require the guest-aware schema');
    if (agent) {
      const currentRuntime = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1', [room.agent_id]);
      check(Number(currentRuntime?.protocol_version || currentRuntime?.capabilities?.protocol || 1) === executionPolicy.PROTOCOL_VERSION, 409, 'Typed agent recipients require protocol 2');
    }
    const recipients = new Map();
    for (const recipient of body.addressedToPrincipals) {
      check(recipient && ['user', 'guest'].includes(recipient.kind), 400, 'Invalid addressed principal');
      const target = { kind: recipient.kind, id: uuid(recipient.id) };
      recipients.set(`${target.kind}:${target.id}`, target);
    }
    addressedPrincipals = [...recipients.values()];
    const users = addressedPrincipals.filter(target => target.kind === 'user').map(target => target.id);
    check(!addressed.length || addressed.length === users.length && addressed.every(id => users.includes(id)), 400, 'Addressed targets disagree');
    addressed = users;
    const guests = await eligibleGuestMembers(c, room.id);
    for (const target of addressedPrincipals.filter(target => target.kind === 'guest')) {
      check(guests.some(member => member.guest_id === target.id && member.status === 'active'), 400, 'Addressed guest is not active');
    }
  }
  const replies = ids(body.replyTo);
  check(!body.kind || ['message', 'question', 'answer'].includes(body.kind), 400, 'Invalid message kind');
  check(agent || body.kind !== 'question', 403, 'Only agents create interactive questions');
  check(body.kind !== 'question' || (addressedPrincipals || addressed).length <= 1, 400, 'Questions target one participant or everyone');
  for (const id of addressed) check(await one(c, "SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2 AND status='active'", [room.id, id]), 400, 'Addressed user is not active');
  for (const id of replies) check(await require('./messageAudience').visibleMessage(c, room.id, id,
    agent ? null : { kind: 'user', id: principal.split(':')[1] }), 400, 'Reply is unavailable in this conversation');
  return {
    addressed,
    addressedPrincipals,
    replies
  };
}
async function insertMessage(c, room, principal, body, batchId = null) {
  await assertSharedThreadActive(c, room.id);
  const agent = principal.startsWith('agent:');
  const prior = await one(c, 'SELECT * FROM shared_messages WHERE id=$1', [uuid(body.id)]);
  if (prior) {
    check(prior.conversation_id === room.id && (agent ? prior.sender_agent_id : prior.sender_user_id) === principal.split(':')[1], 409, 'Message identifier already used');
    return prior;
  }
  if (!agent && !batchId) {
    const dispatchSchema = await one(c, `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='dispatch_eligible'`);
    const queued = await one(c, `SELECT COUNT(*) AS total FROM shared_messages
      WHERE conversation_id=$1 AND sender_user_id=$2 AND batch_id IS NULL AND deleted_at IS NULL
      ${dispatchSchema ? 'AND dispatch_eligible=TRUE' : ''}`, [room.id, principal.split(':')[1]]);
    check(Number(queued.total) < 64, 409, 'This chat has 64 requests waiting for this participant. Wait for the agent or remove queued messages.');
  }
  const {
    addressed,
    addressedPrincipals,
    replies
  } = await validateMessage(c, room, body, agent, principal);
  let recipients = await agentDeliveryRecipients(c, room, body, agent, addressedPrincipals, addressed);
  if (body.kind === 'answer' && body.questionId && await require('./messageAudience').hasAudience(c)) {
    const question = await one(c, 'SELECT recipient_principals FROM shared_messages WHERE id=$1 AND conversation_id=$2', [body.questionId, room.id]);
    recipients = question?.recipient_principals || [];
  }
  const files = ids(body.fileIds);
  check(files.length <= 10, 400, 'At most ten attachments per message');
  for (const id of files) check(await one(c, 'SELECT id FROM shared_files WHERE id=$1 AND conversation_id=$2 AND uploader=$3 AND key_version=$4 AND message_id IS NULL', [id, room.id, principal, room.key_version]), 400, 'Attachment unavailable');
  const values = [body.id, room.id, agent ? null : principal.split(':')[1], agent ? principal.split(':')[1] : null, body.kind || 'message', JSON.stringify(body.payload), room.key_version, addressed, replies, body.questionId || null, batchId];
  if (addressedPrincipals !== null) values.push(JSON.stringify(addressedPrincipals));
  const result = await one(c, `INSERT INTO shared_messages(id,conversation_id,sender_user_id,sender_agent_id,kind,payload,key_version,addressed_to,reply_to,question_id,batch_id${addressedPrincipals !== null ? ',addressed_to_principals' : ''})
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${addressedPrincipals !== null ? ',$12' : ''}) RETURNING *`, values);
  if (recipients !== null) {
    await c.query('UPDATE shared_messages SET recipient_principals=$2 WHERE id=$1', [body.id, JSON.stringify(recipients)]);
    result.recipient_principals = recipients;
  }
  for (const id of files) await c.query('UPDATE shared_files SET message_id=$2 WHERE id=$1', [id, body.id]);
  return result;
}
async function agentDeliveryRecipients(c, room, body, agent, typed, users) {
  if (!agent) { check(body.audience === undefined, 403, 'Only agents choose reply delivery'); return null; }
  let targets = typed?.length ? typed : users.map(id => ({ kind: 'user', id }));
  if (body.audience !== undefined) {
    check(body.audience && ['owner', 'selected', 'all'].includes(body.audience.mode), 400, 'Invalid reply audience');
    const requested = body.audience.principals;
    check(requested === undefined || Array.isArray(requested) && requested.length <= 100, 400, 'Invalid reply audience recipients');
    if (body.audience.mode !== 'selected') check(!requested?.length, 400, 'Only selected delivery accepts recipients');
    if (body.audience.mode === 'all') return null;
    targets = body.audience.mode === 'owner' ? [] : requested || [];
    check(body.audience.mode !== 'selected' || targets.length > 0, 400, 'Select at least one recipient');
  } else if (!targets.length) return null;
  check(await require('./messageAudience').hasAudience(c), 409, 'Apply the message-recipient migration before targeted replies');
  if (targets.some(target => target?.kind === 'guest')) {
    const currentRuntime = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1', [room.agent_id]);
    check(Number(currentRuntime?.protocol_version || currentRuntime?.capabilities?.protocol || 1) === 2, 409, 'Guest delivery requires protocol 2');
  }
  const recipients = new Map([[`user:${room.owner_id}`, { kind: 'user', id: room.owner_id }]]);
  const guests = await eligibleGuestMembers(c, room.id);
  for (const target of targets) {
    check(target && ['user', 'guest'].includes(target.kind), 400, 'Invalid delivery recipient');
    const id = uuid(target.id);
    const present = target.kind === 'guest' ? guests.some(member => member.guest_id === id && member.status === 'active') :
      await one(c, "SELECT user_id FROM shared_members WHERE conversation_id=$1 AND user_id=$2 AND status='active'", [room.id, id]);
    check(present, 400, 'Delivery recipient is not active in this conversation');
    recipients.set(`${target.kind}:${id}`, { kind: target.kind, id });
  }
  return [...recipients.values()];
}
async function send(userId, roomId, body) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    check(!body.questionId && body.kind !== 'answer', 400, 'Use the question answer endpoint');
    return insertMessage(c, room, `user:${userId}`, body);
  });
}
async function answer(userId, roomId, questionId, body) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    const q = await one(c, "SELECT * FROM shared_messages WHERE id=$1 AND conversation_id=$2 AND kind='question' AND deleted_at IS NULL", [uuid(questionId), roomId]);
    check(q && await require('./messageAudience').visibleMessage(c, roomId, q.id, { kind: 'user', id: userId }), 404, 'Question unavailable');
    check(q, 404, 'Question unavailable');
    const typedTargets = q.addressed_to_principals;
    check((!q.addressed_to.length || q.addressed_to.includes(userId)) &&
      (typedTargets === undefined || Array.isArray(typedTargets) && (!typedTargets.length || typedTargets.some(target => target?.kind === 'user' && target.id === userId))),
    403, 'This question is addressed to another participant');
    const priorById = await one(c, 'SELECT * FROM shared_messages WHERE id=$1', [uuid(body?.id)]);
    if (priorById) {
      check(priorById.conversation_id === roomId && priorById.sender_user_id === userId && priorById.question_id === questionId, 409, 'Message identifier already used');
      return { existing: true, message: priorById };
    }
    const prior = await one(c, 'SELECT * FROM shared_messages WHERE question_id=$1', [questionId]);
    if (prior) return {
      existing: true,
      message: prior
    };
    return {
      message: await insertMessage(c, room, `user:${userId}`, {
        ...body,
        kind: 'answer',
        questionId,
        replyTo: [questionId]
      })
    };
  });
}
async function removeMessage(userId, roomId, messageId) {
  return tx(async c => {
    const room = await roomAccess(c, roomId, userId);
    const m = await one(c, 'SELECT * FROM shared_messages WHERE id=$1 AND conversation_id=$2', [uuid(messageId), roomId]);
    check(m && (m.sender_user_id === userId || ['owner', 'manager'].includes(room.member.role)), 403, 'Cannot delete this message');
    await c.query('UPDATE shared_messages SET payload=NULL,deleted_at=NOW() WHERE id=$1', [messageId]);
    await c.query('DELETE FROM shared_files WHERE message_id=$1', [messageId]);
    await audit(c, roomId, userId, 'deleted_message', messageId);
    return {
      ok: true
    };
  });
}
async function read(userId, roomId, seq) {
  return tx(async c => {
    await roomAccess(c, roomId, userId);
    check(/^\d+$/.test(String(seq)), 400, 'Invalid cursor');
    const max = await one(c, 'SELECT MAX(seq) AS seq FROM shared_messages WHERE conversation_id=$1', [roomId]);
    const value = Math.min(Number(seq), Number(max.seq || 0));
    await c.query('UPDATE shared_members SET last_read_seq=GREATEST(last_read_seq,$3) WHERE conversation_id=$1 AND user_id=$2', [roomId, userId, value]);
    return {
      ok: true
    };
  });
}
async function putFile(principal, roomId, version, id, bytes, agentId = null, runtimeId = null, credentialId = null) {
  check(Buffer.isBuffer(bytes) && bytes.length > 28 && bytes.length <= MAX_FILE_BYTES + 28, 400, 'Encrypted file must be at most 20 MB');
  return tx(async c => {
    if (agentId) await runtime(c, agentId, runtimeId, credentialId);
    const room = agentId ? await agentRoom(c, roomId, agentId) : await roomAccess(c, roomId, principal.split(':')[1]);
    await assertSharedThreadActive(c, roomId);
    uuid(id);
    const old = await one(c, 'SELECT id,uploader,conversation_id,key_version,message_id FROM shared_files WHERE id=$1', [id]);
    if (old) {
      check(old.uploader === principal && old.conversation_id === roomId, 409, 'File identifier already used');
      if (!old.message_id && old.key_version !== room.key_version) {
        check(Number(version) === room.key_version, 409, 'Stale conversation key');
        await c.query('UPDATE shared_files SET key_version=$2,bytes=$3 WHERE id=$1 AND message_id IS NULL', [id, room.key_version, bytes]);
      }
      return {
        id
      };
    }
    await writable(c, room, principal);
    check(Number(version) === room.key_version, 409, 'Stale conversation key');
    // Unlinked uploads expire; per-sender quota also limits orphaned encrypted blobs.
    await c.query('DELETE FROM shared_files WHERE message_id IS NULL AND created_at<$1', [new Date(Date.now() - 86400000)]);
    const count = await one(c, 'SELECT COUNT(*) AS total FROM shared_files WHERE uploader=$1', [principal]);
    check(Number(count.total) < 10, 409, 'Attachment quota reached (10 files); delete messages with old attachments');
    await c.query('INSERT INTO shared_files(id,conversation_id,uploader,key_version,bytes) VALUES($1,$2,$3,$4,$5)', [id, roomId, principal, room.key_version, bytes]);
    return {
      id
    };
  });
}
async function getFile(principal, roomId, id, agentId = null, runtimeId = null, credentialId = null) {
  return tx(async c => {
    if (agentId) {
      await runtime(c, agentId, runtimeId, credentialId);
      await agentRoom(c, roomId, agentId);
    } else await roomAccess(c, roomId, principal.split(':')[1]);
    const file = await one(c, 'SELECT * FROM shared_files WHERE id=$1 AND conversation_id=$2', [uuid(id), roomId]);
    check(file && (file.message_id || file.uploader === principal), 404, 'File unavailable');
    if (file.message_id && principal.startsWith('user:')) check(await require('./messageAudience').visibleMessage(c, roomId, file.message_id,
      { kind: 'user', id: principal.split(':')[1] }), 404, 'File unavailable');
    return file;
  });
}
async function registerRuntime(agentId, body, credentialId = null) {
  uuid(agentId);
  uuid(body.runtimeId);
  if (credentialId) uuid(credentialId);
  const protocol = body.protocol || 1;
  const executionMode = body.executionMode || 'restricted';
  check(['trusted', 'restricted'].includes(executionMode) && (executionMode !== 'trusted' || protocol === 2), 400, 'Trusted sharing requires protocol 2');
  check([1, executionPolicy.PROTOCOL_VERSION].includes(protocol) && Array.isArray(body.profiles) && body.profiles.length > 0 && body.profiles.length <= 20, 400, 'Supported shared protocol and runtime profiles required');
  const profiles = body.profiles.map(p => ({
    provider: label(p.provider, 80),
    model: label(p.model, 120)
  }));
  return tx(async c => {
    const old = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [agentId]);
    check(!old || Number(old.protocol_version || old.capabilities?.protocol || 1) !== executionPolicy.PROTOCOL_VERSION || protocol === executionPolicy.PROTOCOL_VERSION, 409, 'Protocol downgrade requires owner runtime reenrollment');
    check(!old?.execution_id || (old.capabilities?.executionMode || 'restricted') === executionMode, 409, 'Resolve the current execution before changing sharing mode');
    let device = null;
    if (protocol === executionPolicy.PROTOCOL_VERSION && executionMode !== 'trusted') {
      const deviceId = uuid(body.deviceId);
      device = await one(c, `SELECT d.* FROM agent_devices d JOIN agents a ON a.agent_id=d.agent_id
        WHERE d.device_id=$1 AND d.agent_id=$2 AND d.revoked_at IS NULL
          AND d.verification_status IN ('owner-approved','isolation-tested') AND a.user_id=(SELECT user_id FROM agents WHERE agent_id=$2)`, [deviceId, agentId]);
      check(device, 409, 'Protocol 2 requires an active owner-approved execution device');
    }
    if (credentialId) check(await one(c, `SELECT credential_id FROM agent_api_credentials
      WHERE credential_id=$1 AND agent_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>NOW()::timestamp)`, [credentialId, agentId]), 409, 'Shared runtime credential is unavailable');
    check(!old || old.runtime_id === body.runtimeId, 409, 'Another shared runtime owns this identity; owner must reset it after confirming it stopped');
    if (old?.capabilities?.credentialId && credentialId && old.capabilities.credentialId !== credentialId) {
      const previous = await one(c, `SELECT credential_id FROM agent_api_credentials
        WHERE credential_id=$1 AND agent_id=$2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>NOW()::timestamp)`, [old.capabilities.credentialId, agentId]);
      check(!previous, 409, 'Another active shared runtime credential owns this identity');
    }
    const capabilities = {
      protocol,
      executionMode,
      followsAgentConfig: executionMode === 'trusted' && body.followsAgentConfig === true,
      profiles,
      attachments: true,
      questions: true,
      ...(device ? {
        deviceId: device.device_id
      } : {}),
      ...(credentialId ? {
        credentialId
      } : old?.capabilities?.credentialId ? {
        credentialId: old.capabilities.credentialId
      } : {})
    };
    if (old) {
      if (protocol === executionPolicy.PROTOCOL_VERSION) await c.query('UPDATE shared_runtimes SET last_seen_at=NOW(),capabilities=$2,protocol_version=$3,device_id=$4 WHERE agent_id=$1', [agentId, JSON.stringify(capabilities), protocol, device?.device_id || null]);
      else await c.query('UPDATE shared_runtimes SET last_seen_at=NOW(),capabilities=$2 WHERE agent_id=$1', [agentId, JSON.stringify(capabilities)]);
    } else if (protocol === executionPolicy.PROTOCOL_VERSION) await c.query('INSERT INTO shared_runtimes(agent_id,runtime_id,capabilities,protocol_version,device_id) VALUES($1,$2,$3,$4,$5)', [agentId, body.runtimeId, JSON.stringify(capabilities), protocol, device?.device_id || null]);
    else await c.query('INSERT INTO shared_runtimes(agent_id,runtime_id,capabilities) VALUES($1,$2,$3)', [agentId, body.runtimeId, JSON.stringify(capabilities)]);
    return {
      ok: true
    };
  });
}
async function adoptRuntime(userId, roomId, body) {
  check(body?.confirmedStopped === true, 400, 'Confirm that the previous shared runtime has stopped');
  const newRuntimeId = uuid(body?.newRuntimeId);
  return tx(async c => {
    const target = await one(c, 'SELECT agent_id FROM shared_conversations WHERE id=$1', [uuid(roomId)]);
    check(target, 404, 'Shared conversation not found');
    const current = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [target.agent_id]);
    check(current, 409, 'Shared runtime is not registered');
    const room = await roomAccess(c, roomId, userId, true);
    check(room.member.role === 'owner', 403, 'Only the conversation owner can adopt a runtime');
    check(newRuntimeId !== current.runtime_id, 409, 'New runtime identity must differ from the current runtime');
    await one(c, 'SELECT agent_id FROM agents WHERE agent_id=$1 FOR UPDATE', [room.agent_id]);
    if (current.execution_id) {
      await c.query('UPDATE shared_runtimes SET runtime_id=$2,last_seen_at=NOW(),execution_uncertain=TRUE WHERE agent_id=$1', [room.agent_id, newRuntimeId]);
      if (current.execution_kind === 'shared') {
        await c.query("UPDATE shared_batches SET status='uncertain' WHERE id=$1 AND status='processing'", [current.execution_id]);
      }
    } else {
    await c.query('UPDATE shared_runtimes SET runtime_id=$2,last_seen_at=NOW(),execution_uncertain=CASE WHEN execution_id IS NULL THEN execution_uncertain ELSE TRUE END WHERE agent_id=$1', [room.agent_id, newRuntimeId]);
    if (current.execution_kind === 'shared' && current.execution_id) {
      await c.query("UPDATE shared_batches SET status='uncertain' WHERE id=$1 AND status='processing'", [current.execution_id]);
    }
    }
    await audit(c, roomId, userId, 'adopted_runtime');
    return {
      ok: true,
      runtimeId: newRuntimeId,
      executionId: current.execution_id,
      executionUncertain: Boolean(current.execution_id) || current.execution_uncertain
    };
  });
}
async function runtime(c, agentId, runtimeId, credentialId = null) {
  uuid(runtimeId);
  if (credentialId) uuid(credentialId);
  const r = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [agentId]);
  check(r && r.runtime_id === runtimeId, 409, 'Shared runtime identity mismatch');
  if (credentialId) {
    check(r.capabilities?.credentialId === credentialId, 409, 'Shared runtime credential epoch mismatch');
    check(await one(c, `SELECT credential_id FROM agent_api_credentials
      WHERE credential_id=$1 AND agent_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>NOW()::timestamp)`, [credentialId, agentId]), 409, 'Shared runtime credential is unavailable');
  }
  await c.query('UPDATE shared_runtimes SET last_seen_at=NOW() WHERE agent_id=$1', [agentId]);
  return r;
}
async function verifyRuntime(agentId, runtimeId, credentialId = null) {
  return tx(async c => runtime(c, agentId, runtimeId, credentialId));
}
async function acquire(agentId, runtimeId, kind, executionId, credentialId = null) {
  return tx(async c => {
    const r = await runtime(c, agentId, runtimeId, credentialId);
    const a = await one(c, 'SELECT stop_requested_at,runtime_config FROM agents WHERE agent_id=$1', [agentId]);
    check(!a.stop_requested_at, 409, 'Agent stop requested');
    check(!r.execution_id || r.execution_id === executionId, 409, 'Agent has an unfinished execution');
    check(!r.execution_uncertain, 409, 'Execution needs review');
    await c.query('UPDATE shared_runtimes SET execution_id=$2,execution_kind=$3,execution_started_at=NOW() WHERE agent_id=$1', [agentId, uuid(executionId), kind]);
    return {
      config: a.runtime_config
    };
  });
}
async function release(agentId, runtimeId, executionId, uncertain = false, credentialId = null) {
  return tx(async c => {
    const r = await runtime(c, agentId, runtimeId, credentialId);
    if (!r.execution_id && !uncertain) return { ok: true, existing: true };
    check(r.execution_id === executionId, 409, 'Execution mismatch');
    if (uncertain) {
      await c.query('UPDATE shared_runtimes SET execution_uncertain=TRUE WHERE agent_id=$1', [agentId]);
      await c.query("UPDATE shared_batches SET status='uncertain' WHERE id=$1 AND status='processing'", [executionId]);
      if (r.protocol_version !== undefined) await c.query("UPDATE shared_tasks SET state='outcome_uncertain' WHERE task_id=(SELECT task_id FROM shared_batches WHERE id=$1) AND state IN ('running','paused','waiting_for_approval')", [executionId]);
    } else await c.query('UPDATE shared_runtimes SET execution_id=NULL,execution_kind=NULL,execution_started_at=NULL,execution_uncertain=FALSE WHERE agent_id=$1', [agentId]);
    return {
      ok: true
    };
  });
}
async function executionGrant(c, agentId, roomId, requesterKind, requesterId, deviceId) {
  if (requesterKind === 'guest') {
    if (process.env.FEATURE_GUEST_SHARING !== 'true') return null;
    const guest = await one(c, `SELECT gm.guest_id,gs.expires_at FROM shared_guest_members gm
      JOIN guest_principals gp ON gp.guest_id=gm.guest_id AND gp.share_id=gm.share_id
      JOIN guest_shares gs ON gs.share_id=gm.share_id
      JOIN guest_share_agents ga ON ga.share_id=gm.share_id AND ga.agent_id=$3
      LEFT JOIN guest_share_rooms gr ON gr.share_id=gm.share_id AND gr.guest_id=gp.guest_id AND gr.agent_id=ga.agent_id
      WHERE gm.guest_id=$1 AND gm.conversation_id=$2 AND gm.status='active' AND gp.status<>'revoked'
        AND gs.revoked_at IS NULL AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND ga.removed_at IS NULL
        AND gm.conversation_id=CASE WHEN gs.room_mode='common' THEN ga.room_id ELSE gr.room_id END`,
    [requesterId, roomId, agentId]);
    if (!guest || guest.expires_at && new Date(guest.expires_at).getTime() <= Date.now()) return null;
  }
  // Keep authorization stable through claim/publication. All grant mutations
  // lock grant-before-device; acquire the same order here to avoid deadlocks.
  const grant = await one(c, `SELECT g.* FROM agent_share_grants g
    WHERE g.agent_id=$1 AND g.room_id=$2 AND g.grantee_kind=$3 AND g.grantee_id=$4
      AND g.device_id=$5 AND g.status='active'
      AND (g.expires_at IS NULL OR g.expires_at>NOW()) FOR SHARE`, [agentId, roomId, requesterKind, requesterId, deviceId]);
  if (!grant) return null;
  const device = await one(c, `SELECT device_label,platform,executor_type,verification_status,workspace_aliases,capabilities,credential_epoch
    FROM agent_devices WHERE device_id=$1 AND agent_id=$2 AND owner_id=$3
      AND revoked_at IS NULL AND verification_status IN ('owner-approved','isolation-tested') FOR SHARE`, [deviceId, agentId, grant.owner_id]);
  // NOW() is transaction-start time and does not advance during lock waits.
  if (!device || grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) return null;
  const current = { ...grant, ...device };
  return executionPolicy.grantWithinDeviceCeiling(current) ? current : null;
}
async function unsupportedTask(c, {
  taskId,
  firstMessageId,
  room,
  agent,
  requesterKind,
  requesterId,
  runtime,
  reason
}) {
  const existing = await one(c, 'SELECT task_id FROM shared_tasks WHERE first_message_id=$1 AND state=\'unsupported_runtime\'', [firstMessageId]);
  if (existing) return existing;
  const task = {
    task_id: taskId,
    source_message_ids: [firstMessageId]
  };
  const context = executionPolicy.buildContext({
    agent,
    room,
    task,
    requester: {
      kind: requesterKind,
      id: requesterId
    },
    runtime,
    unsupportedReason: reason
  });
  await c.query(`INSERT INTO shared_tasks
    (task_id,first_message_id,conversation_id,agent_id,requester_kind,requester_id,source_message_ids,execution_context,current_authorization,state,connector_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unsupported_runtime',$10)`, [taskId, firstMessageId, room.id, agent.agent_id, requesterKind, requesterId, JSON.stringify(task.source_message_ids), JSON.stringify(context), JSON.stringify({
    state: 'unsupported_runtime',
    reason
  }), runtime.runtime_id]);
  return {
    task_id: taskId,
    unsupported: true
  };
}
async function claim(agentId, runtimeId, credentialId = null) {
  return tx(async c => {
    const guestRevisionSchema = process.env.FEATURE_GUEST_SHARING === 'true' ? await one(c, `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='guest_share_revision'`) : null;
    if (guestRevisionSchema) {
      // Match guest mutations' share-before-room lock order. Revocation must
      // finish before a queued request is considered, not race a new task row.
      await c.query(`SELECT gs.share_id FROM guest_shares gs JOIN guest_share_agents ga ON ga.share_id=gs.share_id
        WHERE ga.agent_id=$1 ORDER BY gs.share_id FOR SHARE OF gs`, [agentId]);
    }
    const r = await runtime(c, agentId, runtimeId, credentialId);
    check(!r.execution_id, 409, 'Agent has an unfinished execution');
    const a = await one(c, 'SELECT stop_requested_at,runtime_config FROM agents WHERE agent_id=$1', [agentId]);
    check(!a.stop_requested_at, 409, 'Agent stop requested');
    const protocol = Number(r.protocol_version || r.capabilities?.protocol || 1);
    const guestSchema = protocol === executionPolicy.PROTOCOL_VERSION ? await one(c, `SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name='shared_guest_members'`) : null;
    const hasGuestSchema = Boolean(guestSchema);
    const dispatchSchema = await one(c, `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='shared_messages' AND column_name='dispatch_eligible'`);
    const dispatchFilter = dispatchSchema ? 'AND m.dispatch_eligible=TRUE' : '';
    const threadSchema = await chatThreadSchema(c);
    const rooms = (await c.query(`SELECT c.id FROM shared_conversations c
      ${threadSchema ? 'LEFT JOIN agent_chat_threads t ON t.conversation_id=c.id' : ''}
      WHERE c.agent_id=$1 AND c.rotation_required=FALSE
      ${threadSchema ? "AND (t.conversation_id IS NULL OR t.state='shared')" : ''}`, [agentId])).rows;
    if (!rooms.length) return null;
    const placeholders = rooms.map((_, i) => '$' + (i + 1)).join(',');
    const guestClaimFilter = guestRevisionSchema ? 'TRUE' : 'm.sender_guest_id IS NULL';
    const guestJoins = agentParameter => guestRevisionSchema ? `LEFT JOIN guest_principals gp ON gp.guest_id=m.sender_guest_id
      LEFT JOIN guest_shares gs ON gs.share_id=gp.share_id
      LEFT JOIN guest_share_agents ga ON ga.share_id=gp.share_id AND ga.agent_id=${agentParameter}
      LEFT JOIN guest_share_rooms gr ON gr.share_id=gp.share_id AND gr.guest_id=gp.guest_id AND gr.agent_id=ga.agent_id` : '';
    const guestPredicate = guestRevisionSchema ? `m.sender_guest_id IS NOT NULL AND sgm.status='active'
      AND gp.status<>'revoked' AND sgm.share_id=gp.share_id AND gs.revoked_at IS NULL
      AND (gs.expires_at IS NULL OR gs.expires_at>NOW()) AND ga.removed_at IS NULL
      AND m.conversation_id=CASE WHEN gs.room_mode='common' THEN ga.room_id ELSE gr.room_id END
      AND m.guest_share_revision=gs.revision` : 'FALSE';
    const candidates = (protocol === executionPolicy.PROTOCOL_VERSION && hasGuestSchema ? await c.query(`SELECT DISTINCT ON(m.conversation_id,m.sender_user_id,m.sender_guest_id) m.id,m.conversation_id,m.seq,m.sender_user_id,m.sender_guest_id FROM shared_messages m
      JOIN shared_conversations access_room ON access_room.id=m.conversation_id
      LEFT JOIN shared_members sm ON sm.conversation_id=m.conversation_id AND sm.user_id=m.sender_user_id
      LEFT JOIN shared_guest_members sgm ON sgm.conversation_id=m.conversation_id AND sgm.guest_id=m.sender_guest_id
      ${guestJoins('$' + (rooms.length + 1))}
      WHERE m.conversation_id IN (${placeholders}) AND ((m.sender_user_id IS NOT NULL AND sm.status='active' AND (sm.expires_at IS NULL OR sm.expires_at>NOW())) OR (${guestPredicate}))
        AND (access_room.sharing_enabled=TRUE OR m.sender_user_id=access_room.owner_id)
        AND ${guestClaimFilter} AND m.deleted_at IS NULL AND m.batch_id IS NULL ${dispatchFilter} ORDER BY m.conversation_id,m.sender_user_id,m.sender_guest_id,m.seq`, [...rooms.map(r => r.id), ...(guestRevisionSchema ? [agentId] : [])]) : await c.query(`SELECT ${protocol === executionPolicy.PROTOCOL_VERSION ? 'DISTINCT ON(m.conversation_id,m.sender_user_id)' : ''} m.id,m.conversation_id,m.seq,m.sender_user_id FROM shared_messages m
      JOIN shared_conversations access_room ON access_room.id=m.conversation_id
      JOIN shared_members sm ON sm.conversation_id=m.conversation_id AND sm.user_id=m.sender_user_id
      WHERE m.conversation_id IN (${placeholders}) AND m.sender_user_id IS NOT NULL
        AND sm.status='active' AND (sm.expires_at IS NULL OR sm.expires_at>NOW())
        AND (access_room.sharing_enabled=TRUE OR m.sender_user_id=access_room.owner_id)
        AND m.deleted_at IS NULL AND m.batch_id IS NULL ${dispatchFilter} ORDER BY ${protocol === executionPolicy.PROTOCOL_VERSION ? 'm.conversation_id,m.sender_user_id,m.seq' : 'm.seq LIMIT 1'}`, rooms.map(r => r.id))).rows;
    if (!candidates.length) return null;
    const agent = await one(c, 'SELECT agent_id,user_id,agent_name FROM agents WHERE agent_id=$1', [agentId]);
    let next = null, room = null, grant = null, requesterKind, requesterId;
    if (protocol === executionPolicy.PROTOCOL_VERSION) {
      const previous = (await c.query(`SELECT requester_kind,requester_id,MAX(claimed_at) AS last_claimed_at
        FROM shared_tasks WHERE agent_id=$1 GROUP BY requester_kind,requester_id`, [agentId])).rows;
      const turns = new Map(previous.map(task => [`${task.requester_kind}:${task.requester_id}`, Date.parse(task.last_claimed_at) || 0]));
      const lastTurn = message => turns.get(`${message.sender_guest_id ? 'guest' : 'user'}:${message.sender_guest_id || message.sender_user_id}`) || 0;
      candidates.sort((left, right) => lastTurn(left) - lastTurn(right) || Number(left.seq) - Number(right.seq));
      for (const candidate of candidates) {
        if (candidate.sender_guest_id && process.env.FEATURE_GUEST_SHARING !== 'true') continue;
        const candidateRoom = await agentRoom(c, candidate.conversation_id, agentId);
        if (candidateRoom.rotation_required) continue;
        if (candidateRoom.sharing_enabled === false && candidate.sender_user_id !== candidateRoom.owner_id) continue;
        const kind = candidate.sender_guest_id ? 'guest' : 'user', id = candidate.sender_guest_id || candidate.sender_user_id;
        const candidateGrant = trustedExecution.isTrusted(r)
          ? await trustedExecution.requesterAccess(c, agentId, candidateRoom, kind, id)
          : await executionGrant(c, agentId, candidateRoom.id, kind, id, r.device_id || r.capabilities?.deviceId);
        if (!candidateGrant) {
          await unsupportedTask(c, { taskId: crypto.randomUUID(), firstMessageId: candidate.id, room: candidateRoom,
            agent, requesterKind: kind, requesterId: id, runtime: r, reason: 'No current execution grant is bound to this requester and device.' });
          continue;
        }
        next = candidate; room = candidateRoom; grant = candidateGrant; requesterKind = kind; requesterId = id;
        break;
      }
    } else {
      next = candidates[0]; room = await agentRoom(c, next.conversation_id, agentId);
      if (room.sharing_enabled === false && next.sender_user_id !== room.owner_id) return null;
      requesterKind = 'user'; requesterId = next.sender_user_id;
    }
    if (!next) return null;
    await writable(c, room);
    const messages = (await c.query(protocol === executionPolicy.PROTOCOL_VERSION && hasGuestSchema ? `SELECT m.* FROM shared_messages m
      LEFT JOIN shared_members sm ON sm.conversation_id=m.conversation_id AND sm.user_id=m.sender_user_id
      LEFT JOIN shared_guest_members sgm ON sgm.conversation_id=m.conversation_id AND sgm.guest_id=m.sender_guest_id
      ${guestJoins('$3')}
      WHERE m.conversation_id=$1 AND ${requesterKind === 'guest' ? `m.sender_guest_id=$2 AND (${guestPredicate})` : 'm.sender_user_id=$2 AND sm.status=\'active\''}
        AND m.deleted_at IS NULL AND m.batch_id IS NULL ${dispatchFilter} ORDER BY m.seq LIMIT 20` : protocol === executionPolicy.PROTOCOL_VERSION ? `SELECT m.* FROM shared_messages m
      JOIN shared_members sm ON sm.conversation_id=m.conversation_id AND sm.user_id=m.sender_user_id
      WHERE m.conversation_id=$1 AND m.sender_user_id=$2 AND sm.status='active'
        AND m.deleted_at IS NULL AND m.batch_id IS NULL ${dispatchFilter} ORDER BY m.seq LIMIT 20` : `SELECT m.* FROM shared_messages m
      JOIN shared_conversations access_room ON access_room.id=m.conversation_id
      JOIN shared_members sm ON sm.conversation_id=m.conversation_id AND sm.user_id=m.sender_user_id
      WHERE m.conversation_id=$1 AND m.sender_user_id IS NOT NULL
        AND sm.status='active' AND (sm.expires_at IS NULL OR sm.expires_at>NOW())
        AND (access_room.sharing_enabled=TRUE OR m.sender_user_id=access_room.owner_id)
        AND m.deleted_at IS NULL AND m.batch_id IS NULL ${dispatchFilter} ORDER BY m.seq LIMIT 20`, protocol === executionPolicy.PROTOCOL_VERSION ? [room.id, requesterId, ...(hasGuestSchema && guestRevisionSchema ? [agentId] : [])] : [room.id])).rows;
    const id = crypto.randomUUID();
    const task = {
      task_id: id,
      source_message_ids: messages.map(m => m.id)
    };
    let context = null;
    if (protocol === executionPolicy.PROTOCOL_VERSION) {
      await c.query(`UPDATE shared_tasks SET state='completed',completed_at=NOW(),current_authorization=$2
        WHERE first_message_id=$1 AND state='unsupported_runtime'`, [messages[0].id, JSON.stringify({ state: 'superseded', nextTaskId: id })]);
      context = trustedExecution.isTrusted(r) ? trustedExecution.buildContext({ agent, room, task,
        requester: { kind: requesterKind, id: requesterId }, runtime: r, access: grant }) : executionPolicy.buildContext({
        agent,
        room,
        task,
        requester: {
          kind: requesterKind,
          id: requesterId
        },
        runtime: r,
        device: grant,
        grant
      });
      await c.query(`INSERT INTO shared_tasks
        (task_id,first_message_id,conversation_id,agent_id,requester_kind,requester_id,source_message_ids,grant_id,grant_revision,grant_snapshot,execution_context,current_authorization,state,device_id,connector_id,device_epoch,claimed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'running',$13,$14,$15,NOW())`, [id, messages[0].id, room.id, agentId, requesterKind, requesterId, JSON.stringify(task.source_message_ids), grant.grant_id || null, grant.revision || null, JSON.stringify(trustedExecution.isTrusted(r) ? context.authorization : executionPolicy.grantSnapshot(grant, grant)), JSON.stringify(context), JSON.stringify({
        mode: trustedExecution.isTrusted(r) ? 'trusted' : 'restricted',
        grantId: grant.grant_id || null,
        revision: grant.revision == null ? null : Number(grant.revision),
        deviceEpoch: grant.credential_epoch == null ? null : Number(grant.credential_epoch),
        state: 'authorized'
      }), grant.device_id || null, r.runtime_id, grant.credential_epoch || null]);
    }
    if (protocol === executionPolicy.PROTOCOL_VERSION) await c.query("INSERT INTO shared_batches(id,conversation_id,agent_id,status,task_id) VALUES($1,$2,$3,'processing',$1)", [id, room.id, agentId]);
    else await c.query("INSERT INTO shared_batches(id,conversation_id,agent_id,status) VALUES($1,$2,$3,'processing')", [id, room.id, agentId]);
    for (const m of messages) await c.query('UPDATE shared_messages SET batch_id=$2 WHERE id=$1', [m.id, id]);
    await c.query("UPDATE shared_runtimes SET execution_id=$2,execution_kind='shared',execution_started_at=NOW() WHERE agent_id=$1", [agentId, id]);
    return {
      id,
      messages,
      config: a.runtime_config,
      ...(context ? {
        taskId: id,
        context
      } : {}),
      ...(await details(c, room, `agent:${agentId}`))
    };
  });
}
async function lockTaskShare(c, batchId) {
  const exists = await one(c, `SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name='guest_shares'`);
  if (!exists) return;
  await c.query(`SELECT gs.share_id FROM guest_shares gs
    JOIN guest_principals gp ON gp.share_id=gs.share_id
    JOIN shared_tasks t ON t.requester_id=gp.guest_id AND t.requester_kind='guest'
    JOIN shared_batches b ON b.task_id=t.task_id WHERE b.id=$1 FOR SHARE OF gs`, [uuid(batchId)]);
}
async function holdTaskResult(c, taskId, body) {
  const schema = await one(c, `SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='shared_tasks' AND column_name='held_result'`);
  if (!schema || !Array.isArray(body?.messages) || !body.messages.length || body.messages.length > 20) return;
  let result;
  try {
    result = { messages: body.messages.map(reply => ({
      id: uuid(reply.id), kind: reply.kind, keyVersion: reply.keyVersion, payload: envelope(reply.payload),
      addressedTo: ids(reply.addressedTo), replyTo: ids(reply.replyTo), fileIds: ids(reply.fileIds),
      ...(reply.audience !== undefined ? { audience: reply.audience } : {}),
      ...(Array.isArray(reply.addressedToPrincipals) ? { addressedToPrincipals: reply.addressedToPrincipals.map(target =>
        ({ kind: target.kind, id: uuid(target.id) })) } : {})
    })) };
  } catch (_) { return; }
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) return;
  await c.query(`UPDATE shared_tasks SET held_result=COALESCE(held_result,$2),result_held_at=COALESCE(result_held_at,NOW())
    WHERE task_id=$1`, [taskId, serialized]);
}
// Close an interrupted trusted turn without replaying tools or requiring a
// manager decision. This only publishes a failure notice, never a task result.
async function interrupt(agentId, runtimeId, batchId, body, credentialId = null) {
  return tx(async c => {
    await lockTaskShare(c, batchId);
    const r = await runtime(c, agentId, runtimeId, credentialId);
    check(trustedExecution.isTrusted(r), 409, 'Automatic interruption recovery requires trusted sharing');
    const batch = await one(c, 'SELECT * FROM shared_batches WHERE id=$1 AND agent_id=$2 FOR UPDATE', [uuid(batchId), agentId]);
    check(batch, 404, 'Batch unavailable');
    const task = batch.task_id ? await one(c, 'SELECT * FROM shared_tasks WHERE task_id=$1 FOR UPDATE', [batch.task_id]) : null;
    check(task?.execution_context?.execution?.mode === 'trusted' && task.connector_id === runtimeId,
      409, 'Interrupted task does not belong to this trusted runtime');
    if (['answered', 'skipped', 'retry'].includes(batch.status)) return { ok: true, existing: true };
    check(r.execution_id === batchId && r.execution_kind === 'shared' &&
      ['processing', 'uncertain'].includes(batch.status), 409, 'Batch no longer active');
    check(['running', 'outcome_uncertain', 'failed', 'cancellation_requested'].includes(task.state), 409, 'Task cannot be closed as interrupted');
    const room = await agentRoom(c, batch.conversation_id, agentId);
    await writable(c, room);
    const access = await trustedExecution.requesterAccess(c, agentId, room, task.requester_kind, task.requester_id);
    await insertMessage(c, room, `agent:${agentId}`, {
      id: body.message?.id, keyVersion: body.message?.keyVersion, payload: body.message?.payload,
      kind: 'message', addressedTo: [], replyTo: [], fileIds: [],
      audience: access ? { mode: 'selected', principals: [{ kind: task.requester_kind, id: task.requester_id }] } : { mode: 'owner' }
    }, batchId);
    await c.query("UPDATE shared_batches SET status='skipped',completed_at=NOW() WHERE id=$1", [batchId]);
    await c.query("UPDATE shared_tasks SET state='failed',current_authorization=$2,completed_at=NOW() WHERE task_id=$1", [task.task_id,
      JSON.stringify({ state: 'interrupted', recovery: 'automatic', previousState: task.state, message: 'Run interrupted; agent ready for new messages' })]);
    await c.query('UPDATE shared_runtimes SET execution_id=NULL,execution_kind=NULL,execution_started_at=NULL,execution_uncertain=FALSE WHERE agent_id=$1', [agentId]);
    return { ok: true };
  });
}
async function finish(agentId, runtimeId, batchId, body, credentialId = null) {
  let deferredError = null;
  const result = await tx(async c => {
    await lockTaskShare(c, batchId);
    const r = await runtime(c, agentId, runtimeId, credentialId);
    const batch = await one(c, 'SELECT * FROM shared_batches WHERE id=$1 AND agent_id=$2', [uuid(batchId), agentId]);
    check(batch, 404, 'Batch unavailable');
    if (batch.status === 'answered') return {
      ok: true,
      existing: true
    };
    check(r.execution_id === batchId && ['processing', 'uncertain'].includes(batch.status), 409, 'Batch no longer active');
    const room = await agentRoom(c, batch.conversation_id, agentId);
    const task = batch.task_id ? await one(c, 'SELECT * FROM shared_tasks WHERE task_id=$1 FOR UPDATE', [batch.task_id]) : null;
    if (task) {
      const trusted = task.execution_context?.execution?.mode === 'trusted';
      const current = trusted ? await trustedExecution.authorizeTask(c, task, room, r) :
        await executionGrant(c, agentId, room.id, task.requester_kind, task.requester_id, task.device_id);
      try {
        executionPolicy.assertTaskContext(JSON.parse(JSON.stringify(task.execution_context)), {
          taskId: task.task_id,
          grantId: task.grant_id,
          revision: task.grant_revision,
          deviceId: task.device_id
        });
      } catch (error) {
        await holdTaskResult(c, task.task_id, body);
        await c.query("UPDATE shared_tasks SET state='failed',current_authorization=$2,completed_at=NOW() WHERE task_id=$1", [task.task_id, JSON.stringify({
          state: 'context_mismatch',
          message: error.message
        })]);
        deferredError = error;
        return null;
      }
      if (!current || !trusted && (current.grant_id !== task.grant_id || Number(current.revision) !== Number(task.grant_revision) || Number(current.credential_epoch) !== Number(task.device_epoch)) ||
          task.state !== 'running' || task.execution_context?.conversation?.membershipVersion !== Number(room.membership_version) ||
          task.execution_context?.conversation?.keyVersion !== Number(room.key_version)) {
        await holdTaskResult(c, task.task_id, body);
        await c.query("UPDATE shared_tasks SET state=CASE WHEN state IN ('cancellation_requested','outcome_uncertain') THEN state ELSE 'failed' END,current_authorization=$2,completed_at=NOW() WHERE task_id=$1", [task.task_id, JSON.stringify({
          state: 'authorization_changed',
          grantId: task.grant_id,
          expectedRevision: task.grant_revision,
          expectedDeviceEpoch: task.device_epoch
        })]);
        deferredError = new SharedError(409, 'Task authorization changed; result held for review');
        return null;
      }
    }
    check(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 20, 400, 'Return 1–20 replies');
    for (const reply of body.messages) {
      check(reply.kind !== 'answer' && !reply.questionId, 400, 'Agent cannot answer human questions');
      await insertMessage(c, room, `agent:${agentId}`, reply, batchId);
    }
    if (await hasAgentReadReceipts(c)) await c.query(`UPDATE shared_messages SET agent_read_at=COALESCE(agent_read_at,NOW())
      WHERE batch_id=$1 AND sender_agent_id IS NULL`, [batchId]);
    await c.query("UPDATE shared_batches SET status='answered',completed_at=NOW() WHERE id=$1", [batchId]);
    if (task) await c.query("UPDATE shared_tasks SET state='completed',current_authorization=$2,completed_at=NOW() WHERE task_id=$1", [task.task_id, JSON.stringify({
      state: 'published',
      grantId: task.grant_id,
      revision: task.grant_revision,
      deviceEpoch: task.device_epoch
    })]);
    await c.query('UPDATE shared_runtimes SET execution_id=NULL,execution_kind=NULL,execution_started_at=NULL,execution_uncertain=FALSE WHERE agent_id=$1', [agentId]);
    return {
      ok: true
    };
  });
  if (deferredError) throw deferredError;
  return result;
}
async function control(userId, roomId, body) {
  return tx(async c => {
    const targetRoom = await one(c, 'SELECT agent_id FROM shared_conversations WHERE id=$1', [uuid(roomId)]);
    check(targetRoom, 404, 'Shared conversation unavailable');
    await one(c, 'SELECT agent_id FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [targetRoom.agent_id]);
    const room = await roomAccess(c, roomId, userId, true);
    if (body.action === 'stop') {
      await c.query('UPDATE agents SET stop_requested_at=NOW() WHERE agent_id=$1', [room.agent_id]);
    } else if (body.action === 'profile') {
      const rt = await one(c, 'SELECT capabilities FROM shared_runtimes WHERE agent_id=$1', [room.agent_id]);
      check(rt?.capabilities.profiles.some(p => p.provider === body.provider && p.model === body.model), 400, 'Choose an owner-configured runtime profile');
      // Only these two fields change. Never reconstruct or overwrite permission configuration.
      const agent = await one(c, 'SELECT runtime_config FROM agents WHERE agent_id=$1 FOR UPDATE', [room.agent_id]);
      await c.query('UPDATE agents SET runtime_config=$2 WHERE agent_id=$1', [room.agent_id, JSON.stringify({
        ...agent.runtime_config,
        model_provider: body.provider,
        model: body.model
      })]);
    } else if (['retry', 'skip'].includes(body.action)) {
      const rt = await one(c, 'SELECT * FROM shared_runtimes WHERE agent_id=$1 FOR UPDATE', [room.agent_id]);
      check(rt?.execution_kind === 'shared' && (rt.execution_uncertain || Date.now() - new Date(rt.last_seen_at).getTime() > 120000), 409, 'No uncertain shared execution');
      if (body.executionId !== undefined) check(rt.execution_id === uuid(body.executionId), 409, 'This request has already changed. Refresh the conversation.');
      const batch = await one(c, 'SELECT * FROM shared_batches WHERE id=$1 AND agent_id=$2 FOR UPDATE', [rt.execution_id, room.agent_id]);
      check(batch && batch.conversation_id === room.id, 409, 'No uncertain shared execution for this room');
      if (batch.task_id) {
        // Recovery is an explicit decision, not proof that earlier effects did
        // not happen. Preserve that attempt and revoke its unused approvals.
        await c.query("UPDATE shared_tasks SET state='outcome_uncertain' WHERE task_id=$1 AND state IN ('running','paused','waiting_for_approval','cancellation_requested')", [batch.task_id]);
        await c.query("UPDATE shared_task_actions SET approval_state='revoked' WHERE task_id=$1 AND approval_state IN ('pending','approved')", [batch.task_id]);
      }
      await c.query('UPDATE shared_batches SET status=$2,completed_at=NOW() WHERE id=$1 AND agent_id=$3 AND conversation_id=$4', [rt.execution_id, body.action === 'skip' ? 'skipped' : 'retry', room.agent_id, room.id]);
      if (body.action === 'retry') {
        const activeGuests = (await eligibleGuestMembers(c, room.id)).filter(guest => guest.status === 'active').map(guest => guest.guest_id);
        await c.query(`UPDATE shared_messages SET batch_id=NULL
          WHERE batch_id=$1 AND deleted_at IS NULL AND
            (sender_user_id IN (SELECT user_id FROM shared_members
              WHERE conversation_id=$2 AND status='active' AND (expires_at IS NULL OR expires_at>NOW()))
              ${activeGuests.length ? 'OR sender_guest_id=ANY($3::uuid[])' : ''})`,
          [rt.execution_id, room.id, ...(activeGuests.length ? [activeGuests] : [])]);
      }
      await c.query('UPDATE shared_runtimes SET execution_id=NULL,execution_kind=NULL,execution_started_at=NULL,execution_uncertain=FALSE WHERE agent_id=$1', [room.agent_id]);
    } else throw new SharedError(400, 'Unsupported action');
    await audit(c, roomId, userId, body.action);
    return {
      ok: true,
      message: body.action === 'stop' ? 'Stop requested; remote tool termination is not confirmed.' : undefined
    };
  });
}
async function batches(userId, roomId) {
  return tx(async c => {
    await roomAccess(c, roomId, userId);
    return (await c.query('SELECT * FROM shared_batches WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 50', [roomId])).rows;
  });
}
async function agentSend(agentId, roomId, body, runtimeId, credentialId = null) {
  check(body.kind !== 'answer' && !body.questionId, 400, 'Agents cannot submit human answers');
  return tx(async c => {
    await runtime(c, agentId, runtimeId, credentialId);
    return insertMessage(c, await agentRoom(c, roomId, agentId), 'agent:' + agentId, body);
  });
}
async function auditHistory(userId, roomId) {
  return tx(async c => {
    await roomAccess(c, roomId, userId);
    return (await c.query('SELECT * FROM shared_audit WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 100', [roomId])).rows;
  });
}
async function agentHistory(agentId, roomId, after, runtimeId, credentialId = null) {
  return tx(async c => {
    const current = await runtime(c, agentId, runtimeId, credentialId);
    await agentRoom(c, roomId, agentId);
    const task = current.execution_id && Number(current.protocol_version || current.capabilities?.protocol || 1) === 2 &&
      await one(c, 'SELECT requester_kind,requester_id FROM shared_tasks WHERE task_id=$1 AND conversation_id=$2', [current.execution_id, roomId]);
    return timeline(c, roomId, after, true, task ? { kind: task.requester_kind, id: task.requester_id } : null);
  });
}
async function agentDetails(agentId, roomId, runtimeId, credentialId = null) {
  return tx(async c => {
    await runtime(c, agentId, runtimeId, credentialId);
    return details(c, await agentRoom(c, roomId, agentId), `agent:${agentId}`);
  });
}
async function agentBatch(agentId, runtimeId, batchId, credentialId = null) {
  return tx(async c => {
    const runtimeRecord = await runtime(c, agentId, runtimeId, credentialId);
    const batch = runtimeRecord.protocol_version === undefined ? await one(c, 'SELECT id,conversation_id,agent_id,status,created_at,completed_at FROM shared_batches WHERE id=$1 AND agent_id=$2', [uuid(batchId), agentId]) : await one(c, `SELECT b.id,b.conversation_id,b.agent_id,b.status,b.created_at,b.completed_at,
      t.task_id,t.requester_kind,t.requester_id,t.grant_id,t.grant_revision,t.execution_context,t.state AS task_state
      FROM shared_batches b LEFT JOIN shared_tasks t ON t.task_id=b.task_id
      WHERE b.id=$1 AND b.agent_id=$2`, [uuid(batchId), agentId]);
    check(batch, 404, 'Batch unavailable');
    return batch;
  });
}
module.exports = {
  SharedError,
  MAX_FILE_BYTES,
  check,
  uuid,
  envelope,
  registerIdentity,
  identity,
  rewrapIdentity,
  recoverIdentity,
  approveRecovery,
  list,
  create,
  invite,
  accept,
  decline,
  membership,
  get,
  provision,
  eligibleGuestMembers,
  approveGuest,
  decideAccountRequest,
  history,
  messageStatuses,
  messageStatusesInTransaction,
  markBatchRead,
  send,
  answer,
  removeMessage,
  read,
  putFile,
  getFile,
  registerRuntime,
  verifyRuntime,
  runtimeInTransaction: runtime,
  executionGrant,
  lockTaskShare,
  adoptRuntime,
  acquire,
  release,
  claim,
  finish,
  interrupt,
  control,
  sharingSettings,
  batches,
  agentHistory,
  agentDetails,
  agentBatch,
  agentSend,
  auditHistory
};
