'use strict';

const db = require('../db/connection');
const { sendConversationInvitationEmail } = require('../services/emailService');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class InvitationError extends Error { constructor(status, message) { super(message); this.status = status; } }
function check(ok, status, message) { if (!ok) throw new InvitationError(status, message); }
function id(value) { check(typeof value === 'string' && UUID.test(value), 400, 'Invalid identifier'); return value; }
function email(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  check(normalized.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized), 400, 'Enter a valid email address');
  return normalized;
}
function view(row) {
  return { invitationId: row.invitation_id, conversationId: row.conversation_id, agentId: row.agent_id,
    agentName: row.agent_name, ownerId: row.owner_id, ownerDisplayName: row.owner_display_name || null,
    recipientEmail: row.recipient_email, recipientUserId: row.recipient_user_id || null,
    state: row.state, deliveryState: row.delivery_state, expiresAt: row.expires_at,
    createdAt: row.created_at, role: 'participant' };
}
async function deliverInvitationEmail(ownerId, invitationId, baseUrl) {
  const row = (await db.query(`SELECT i.invitation_id,i.recipient_email,i.expires_at,a.agent_name
    FROM conversation_invitations i JOIN shared_conversations c ON c.id=i.conversation_id
    JOIN agents a ON a.agent_id=c.agent_id WHERE i.invitation_id=$1 AND i.owner_id=$2
    AND i.state='pending' AND i.expires_at>NOW()`, [id(invitationId), id(ownerId)])).rows[0];
  check(row, 404, 'Invitation not found or expired');
  const base = String(baseUrl || process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    await db.query("UPDATE conversation_invitations SET delivery_state='in_app_only',updated_at=NOW() WHERE invitation_id=$1", [invitationId]);
    return { deliveryState: 'in_app_only' };
  }
  const delivery = await sendConversationInvitationEmail({
    to: row.recipient_email, agentName: row.agent_name, expiresAt: row.expires_at,
    joinUrl: `${base}/join/invitation/${encodeURIComponent(invitationId)}`
  });
  const deliveryState = delivery.success ? 'sent' : delivery.skipped ? 'in_app_only' : 'failed';
  await db.query('UPDATE conversation_invitations SET delivery_state=$2,updated_at=NOW() WHERE invitation_id=$1', [invitationId, deliveryState]);
  return { deliveryState };
}

async function createAccountInvitation(ownerId, conversationId, recipientEmail, requestId, baseUrl) {
  id(ownerId); id(conversationId); id(requestId);
  const to = email(recipientEmail);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const prior = (await client.query(`SELECT i.*,a.agent_id,a.agent_name FROM conversation_invitations i JOIN agents a ON a.agent_id=(SELECT agent_id FROM shared_conversations WHERE id=i.conversation_id)
      WHERE i.owner_id=$1 AND i.request_id=$2 FOR UPDATE`, [ownerId,requestId])).rows[0];
    if (prior) {
      check(prior.conversation_id === conversationId && prior.recipient_email === to, 409, 'This invitation request belongs to another conversation or recipient');
      await client.query('COMMIT'); return view(prior);
    }
    const room = (await client.query(`SELECT c.id,c.agent_id,c.owner_id,a.agent_name FROM shared_conversations c
      JOIN agents a ON a.agent_id=c.agent_id JOIN shared_members m ON m.conversation_id=c.id
      WHERE c.id=$1 AND c.owner_id=$2 AND m.user_id=$2 AND m.role='owner' AND m.status='active' FOR UPDATE OF c`, [conversationId,ownerId])).rows[0];
    check(room,404,'Conversation not found');
    const bindingTable=(await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='agent_chat_threads'`)).rows[0];
    if(bindingTable) {
      const binding=(await client.query('SELECT state FROM agent_chat_threads WHERE conversation_id=$1 AND owner_id=$2',[conversationId,ownerId])).rows[0];
      check(!binding || binding.state==='shared',409,'Finish preparing this conversation before inviting collaborators');
    }
    await client.query("UPDATE conversation_invitations SET state='expired',updated_at=NOW() WHERE conversation_id=$1 AND state='pending' AND expires_at<=NOW()",[conversationId]);
    const existing = (await client.query(`SELECT i.*,a.agent_id,a.agent_name FROM conversation_invitations i
      JOIN agents a ON a.agent_id=$2 WHERE i.conversation_id=$1 AND i.recipient_email=$3 AND i.state='pending'
      AND i.expires_at>NOW() ORDER BY i.created_at DESC LIMIT 1 FOR UPDATE`,[conversationId,room.agent_id,to])).rows[0];
    if (existing) { await client.query('COMMIT'); return view(existing); }
    const recipient = (await client.query('SELECT user_id FROM users WHERE LOWER(email)=LOWER($1)',[to])).rows[0];
    if (recipient) {
      const member = (await client.query('SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2',[conversationId,recipient.user_id])).rows[0];
      check(!member || member.status==='removed',409,'This person already has access or a pending invitation');
    }
    const invitation = (await client.query(`INSERT INTO conversation_invitations
      (conversation_id,owner_id,inviter_id,recipient_email,recipient_user_id,request_id,delivery_state)
      VALUES($1,$2,$2,$3,$4,$5,'in_app_only') RETURNING *`, [conversationId,ownerId,to,recipient?.user_id || null,requestId])).rows[0];
    // Admission remains in the invitation until the intended verified account
    // accepts. A legacy invited membership would let its accept endpoint bypass
    // the account invitation's verified-email and lifecycle checks.
    await client.query('COMMIT');
    const delivery = await deliverInvitationEmail(ownerId, invitation.invitation_id, baseUrl);
    return view({ ...invitation, agent_id:room.agent_id, agent_name:room.agent_name, delivery_state:delivery.deliveryState });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function resendAccountInvitationEmail(ownerId, invitationId, baseUrl) {
  const delivery = await deliverInvitationEmail(ownerId, invitationId, baseUrl);
  return { invitationId, deliveryState: delivery.deliveryState };
}
async function listConversationInvitations(userId, conversationId) {
  id(userId); id(conversationId);
  const owner = (await db.query('SELECT owner_id FROM shared_conversations WHERE id=$1',[conversationId])).rows[0];
  check(owner?.owner_id === userId,403,'Only the owner can manage invitations');
  const rows = (await db.query(`SELECT i.*,a.agent_id,a.agent_name FROM conversation_invitations i
    JOIN agents a ON a.agent_id=(SELECT agent_id FROM shared_conversations WHERE id=i.conversation_id)
    WHERE i.conversation_id=$1 ORDER BY i.created_at DESC`,[conversationId])).rows;
  return rows.map(view);
}
async function listIncomingInvitations(userId) {
  id(userId);
  const rows = (await db.query(`SELECT i.*,c.agent_id,a.agent_name,c.owner_id,si.display_name AS owner_display_name
    FROM users u JOIN conversation_invitations i ON i.recipient_email=LOWER(u.email)
    JOIN shared_conversations c ON c.id=i.conversation_id JOIN agents a ON a.agent_id=c.agent_id
    LEFT JOIN shared_identities si ON si.principal='user:' || c.owner_id::text
    WHERE u.user_id=$1 AND i.state='pending' AND i.expires_at>NOW()
    ORDER BY i.created_at DESC`,[userId])).rows;
  return rows.map(view);
}
async function getInvitationPreview(userId, invitationId) {
  id(userId); id(invitationId);
  const row = (await db.query(`SELECT i.*,c.agent_id,a.agent_name,c.owner_id,u.email,u.email_verified,si.display_name AS owner_display_name
    FROM conversation_invitations i JOIN shared_conversations c ON c.id=i.conversation_id
    JOIN agents a ON a.agent_id=c.agent_id JOIN users u ON u.user_id=$1
    LEFT JOIN shared_identities si ON si.principal='user:' || c.owner_id::text
    WHERE i.invitation_id=$2`,[userId,invitationId])).rows[0];
  check(row && row.email.toLowerCase() === row.recipient_email,404,'Invitation not found');
  return { ...view(row), verified: row.email_verified === true, available: row.state==='pending' && new Date(row.expires_at)>new Date() };
}
async function acceptAccountInvitation(userId, invitationId, requestId) {
  id(userId); id(invitationId); id(requestId);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT i.*,u.email,u.email_verified FROM conversation_invitations i
      JOIN users u ON u.user_id=$1 WHERE i.invitation_id=$2 FOR UPDATE OF i`,[userId,invitationId])).rows[0];
    check(row && row.email.toLowerCase()===row.recipient_email,404,'Invitation not found');
    if (row.state==='accepted') { await client.query('COMMIT'); return { conversationId:row.conversation_id,state:'accepted',idempotent:true }; }
    check(row.state==='pending' && new Date(row.expires_at)>new Date(),410,'Invitation is expired or unavailable');
    check(row.email_verified===true,403,'Verify the invited email address before joining');
    check((await client.query('SELECT principal FROM shared_identities WHERE principal=$1',[`user:${userId}`])).rows.length,409,'Unlock your account sharing identity before joining');
    const member = (await client.query('SELECT status FROM shared_members WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE',[row.conversation_id,userId])).rows[0];
    check(!member || ['invited','pending','active','removed'].includes(member.status),409,'Membership is unavailable');
    if (member?.status==='active' || member?.status==='pending') {
      await client.query("UPDATE conversation_invitations SET state='accepted',accepted_at=NOW(),updated_at=NOW() WHERE invitation_id=$1",[invitationId]);
    } else {
      await client.query(`INSERT INTO shared_members(conversation_id,user_id,role,status,invited_by)
        VALUES($1,$2,'participant','pending',$3)
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='participant',status='pending',invited_by=$3,expires_at=NULL`,[row.conversation_id,userId,row.inviter_id]);
      await client.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1',[row.conversation_id]);
      await client.query("UPDATE conversation_invitations SET state='accepted',accepted_at=NOW(),updated_at=NOW() WHERE invitation_id=$1",[invitationId]);
    }
    await client.query('COMMIT');
    return { conversationId:row.conversation_id,state:'pending',idempotent:false };
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function declineInvitation(userId, invitationId) {
  id(userId); id(invitationId);
  const client=await db.getClient();
  try {
    await client.query('BEGIN');
    const row=(await client.query(`UPDATE conversation_invitations i SET state='declined',updated_at=NOW()
      FROM users u WHERE u.user_id=$1 AND i.invitation_id=$2 AND i.recipient_email=LOWER(u.email) AND i.state='pending'
      RETURNING i.conversation_id`,[userId,invitationId])).rows[0];
    check(row,404,'Invitation unavailable');
    await client.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2 AND status='invited'",[row.conversation_id,userId]);
    await client.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1',[row.conversation_id]);
    await client.query('COMMIT');
    return { state:'declined' };
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function revokeInvitation(ownerId, invitationId) {
  id(ownerId); id(invitationId);
  const client=await db.getClient();
  try {
    await client.query('BEGIN');
    const row=(await client.query(`UPDATE conversation_invitations SET state='revoked',updated_at=NOW()
      WHERE invitation_id=$1 AND owner_id=$2 AND state='pending' RETURNING conversation_id,recipient_user_id`,[invitationId,ownerId])).rows[0];
    check(row,404,'Pending invitation not found');
    if(row.recipient_user_id) await client.query("UPDATE shared_members SET status='removed' WHERE conversation_id=$1 AND user_id=$2 AND status='invited'",[row.conversation_id,row.recipient_user_id]);
    await client.query('UPDATE shared_conversations SET membership_version=membership_version+1 WHERE id=$1',[row.conversation_id]);
    await client.query('COMMIT');
    return { state:'revoked' };
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
module.exports = { InvitationError, createAccountInvitation, resendAccountInvitationEmail, listConversationInvitations, listIncomingInvitations,
  getInvitationPreview, acceptAccountInvitation, declineInvitation, revokeInvitation };
