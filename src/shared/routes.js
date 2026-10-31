'use strict';

const express = require('express');
const multer = require('multer');
const s = require('./service');
const authorization = require('./authorization');
const guest = require('./guestService');
const tasks = require('./taskAuthority');
const db = require('../db/connection');
const bcrypt = require('bcrypt');
const { guestUnlockRateLimiter } = require('../middleware/guestRateLimit');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: s.MAX_FILE_BYTES + 28,
    files: 1,
    fields: 4
  }
}).single('file');
function enabled(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true') return res.status(404).json({
    error: {
      message: 'Shared conversations are not enabled'
    }
  });
  next();
}
function guestEnabled(req, res, next) {
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true' || process.env.FEATURE_GUEST_SHARING !== 'true') return res.status(404).json({
    error: {
      message: 'Guest sharing is not enabled'
    }
  });
  next();
}
function wrap(fn) {
  return async (req, res, next) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result);
    } catch (e) {
      if (e instanceof s.SharedError) return res.status(e.status).json({
        error: {
          message: e.message
        }
      });
      next(e);
    }
  };
}
function fileUpload(req, res, next) {
  upload(req, res, e => e ? res.status(400).json({
    error: {
      message: 'Upload one encrypted file, at most 20 MB'
    }
  }) : next());
}
function download(res, file) {
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment',
    'X-Shared-Key-Version': String(file.key_version)
  });
  res.send(file.bytes);
}
const users = express.Router();
users.use(enabled);
users.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
users.get('/identity', wrap(r => s.identity(`user:${r.user.userId}`)));
users.put('/identity', wrap(r => s.registerIdentity(`user:${r.user.userId}`, r.body)));
users.put('/identity/private', wrap(r => s.rewrapIdentity(r.user.userId, r.body)));
users.post('/identity/recover', wrap(r => s.recoverIdentity(r.user.userId, r.body)));
users.get('/devices', wrap(r => authorization.listDevices(r.user.userId, r.query.agentId || null)));
users.post('/devices', wrap(r => authorization.createDevice(r.user.userId, r.body)));
users.patch('/devices/:device', wrap(r => authorization.updateDevice(r.user.userId, r.params.device, r.body)));
users.delete('/devices/:device', wrap(r => authorization.revokeDevice(r.user.userId, r.params.device)));
users.get('/grants', wrap(r => authorization.listGrants(r.user.userId, r.query.agentId || null)));
users.post('/grants', wrap(r => authorization.createGrant(r.user.userId, r.body)));
users.patch('/grants/:grant', wrap(r => authorization.updateGrant(r.user.userId, r.params.grant, r.body)));
users.delete('/grants/:grant', wrap(r => authorization.revokeGrant(r.user.userId, r.params.grant)));
users.post('/tasks/:task/cancel', wrap(r => tasks.cancel(r.user.userId, r.params.task)));
users.get('/tasks/:task/held-result', wrap(r => tasks.heldResult(r.user.userId, r.params.task)));
users.post('/tasks/:task/actions/:action/decision', wrap(r => tasks.decide(r.user.userId, r.params.task, r.params.action, r.body)));
users.get('/guest-shares', guestEnabled, wrap(r => guest.listOwnerShares(r.user.userId)));
users.post('/guest-shares', guestEnabled, wrap(r => guest.createOwnerShare(r.user.userId, r.body)));
users.get('/guest-shares/:share', guestEnabled, wrap(r => guest.getOwnerShare(r.user.userId, r.params.share)));
users.patch('/guest-shares/:share', guestEnabled, wrap(r => guest.updateOwnerShare(r.user.userId, r.params.share, r.body)));
users.delete('/guest-shares/:share', guestEnabled, wrap(r => guest.updateOwnerShare(r.user.userId, r.params.share, {
  revoked: true
})));
users.put('/guest-shares/:share/agents', guestEnabled, wrap(r => guest.replaceShareAgents(r.user.userId, r.params.share, r.body)));
users.delete('/guest-shares/:share/guests/:guest', guestEnabled, wrap(r => guest.removeGuest(r.user.userId, r.params.share, r.params.guest)));
users.post('/guest-shares/:share/keys', guestEnabled, wrap(r => guest.provisionGuestKeys(r.user.userId, r.params.share, r.body)));
// A signed-in visitor asks for access through a guest link (see views/guest-shared.ejs).
users.post('/link-requests', guestEnabled, guestUnlockRateLimiter, wrap(async r => {
  const secret = r.body?.linkSecret;
  const unavailable = () => new s.SharedError(404, 'This link has expired or the access code is wrong');
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw unavailable();
  const share = await guest.findShareByLinkSecret(secret);
  if (!share) throw unavailable();
  if (share.password_hash) {
    const password = r.body?.password;
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72 || !await bcrypt.compare(password, share.password_hash)) throw unavailable();
  }
  return guest.requestAccountAccess(r.user.userId, share, r.body?.note);
}));
users.post('/:room/access-requests/:request/approve', guestEnabled, wrap(r => s.decideAccountRequest(r.user.userId, r.params.room, r.params.request, true)));
users.delete('/:room/access-requests/:request', guestEnabled, wrap(r => s.decideAccountRequest(r.user.userId, r.params.room, r.params.request, false)));
users.post('/:room/guests/:guest/approve', guestEnabled, wrap(r => s.approveGuest(r.user.userId, r.params.room, r.params.guest)));
users.post('/:room/members/:user/recover', wrap(r => s.approveRecovery(r.user.userId, r.params.room, r.params.user)));
users.get('/', wrap(r => s.list(r.user.userId)));
users.post('/', wrap(r => s.create(r.user.userId, r.body)));
users.post('/:room/invitations', wrap(r => s.invite(r.user.userId, r.params.room, r.body)));
users.post('/:room/decline', wrap(r => s.decline(r.user.userId, r.params.room)));
users.post('/:room/accept', wrap(r => s.accept(r.user.userId, r.params.room)));
users.patch('/:room/members/:user', wrap(r => s.membership(r.user.userId, r.params.room, r.params.user, r.body)));
users.delete('/:room/members/:user', wrap(r => s.membership(r.user.userId, r.params.room, r.params.user, {})));
users.get('/:room/agent-messaging', wrap(r => require('./a2aAccess').settings(r.user.userId, r.params.room)));
users.put('/:room/agent-messaging', wrap(r => {
  s.check(typeof r.body.enabled === 'boolean', 400, 'enabled must be a boolean');
  return require('./a2aAccess').settings(r.user.userId, r.params.room, r.body.enabled);
}));
users.get('/:room', wrap(r => s.get(r.user.userId, r.params.room)));
users.get('/:room/sharing', wrap(r => s.sharingSettings(r.user.userId, r.params.room)));
users.put('/:room/sharing', wrap(r => {
  s.check(typeof r.body?.enabled === 'boolean', 400, 'enabled must be a boolean');
  return s.sharingSettings(r.user.userId, r.params.room, r.body.enabled);
}));
users.post('/:room/keys', wrap(r => s.provision(r.user.userId, r.params.room, r.body)));
users.get('/:room/messages', wrap(r => s.history(r.user.userId, r.params.room, r.query.after || 0,
  r.query.since || null, r.query.before || null, r.query.limit || 200)));
users.post('/:room/messages', wrap(r => s.send(r.user.userId, r.params.room, r.body)));
users.get('/:room/message-status', wrap(r => s.messageStatuses(r.user.userId, r.params.room, String(r.query.ids || '').split(',').filter(Boolean))));
users.post('/:room/questions/:question/answer', wrap(r => s.answer(r.user.userId, r.params.room, r.params.question, r.body)));
users.delete('/:room/messages/:message', wrap(r => s.removeMessage(r.user.userId, r.params.room, r.params.message)));
users.post('/:room/read', wrap(r => s.read(r.user.userId, r.params.room, r.body.seq)));
users.post('/:room/files', fileUpload, wrap(r => s.putFile(`user:${r.user.userId}`, r.params.room, r.body.keyVersion, r.body.id, r.file?.buffer)));
users.get('/:room/files/:file', wrap(async (r, res) => download(res, await s.getFile(`user:${r.user.userId}`, r.params.room, r.params.file))));
users.post('/:room/control', wrap(r => s.control(r.user.userId, r.params.room, r.body)));
users.post('/:room/runtime/adopt', wrap(r => s.adoptRuntime(r.user.userId, r.params.room, r.body)));
users.get('/:room/audit', wrap(r => s.auditHistory(r.user.userId, r.params.room)));
users.get('/:room/batches', wrap(r => s.batches(r.user.userId, r.params.room)));
users.get('/:room/tasks', wrap(r => tasks.list(r.user.userId, r.params.room)));
const agents = express.Router();
agents.use(enabled);
agents.use(async (req, res, next) => {
  try {
    const name = req.authContext?.agentName || req.headers['x-agent-name'];
    s.check(typeof name === 'string', 400, 'X-Agent-Name is required');
    const a = (await db.query('SELECT agent_id FROM agents WHERE user_id=$1 AND agent_name=$2', [req.user.userId, name])).rows[0];
    s.check(a && (!req.authContext?.agentId || req.authContext.agentId === a.agent_id), 403, 'Agent identity unavailable');
    req.sharedAgentId = a.agent_id;
    req.sharedRuntimeId = req.headers['x-shared-runtime'];
    req.sharedCredentialId = req.authContext?.credentialId || null;
    next();
  } catch (e) {
    if (e instanceof s.SharedError) return res.status(e.status).json({
      error: {
        message: e.message
      }
    });
    next(e);
  }
});
agents.post('/enroll', wrap(async r => {
  s.check(r.authContext?.type === 'api_key', 403, 'Managed enrollment requires the owner API key');
  const credentials = require('../services/agentCredentialService');
  await credentials.revokeActiveCredentials(r.sharedAgentId);
  const credential = await credentials.issueScopedCredential({
    agentId: r.sharedAgentId,
    scopes: ['agent.messages.write', 'agent.questions.write', 'agent.responses.read', 'agent.dm.read', 'agent.dm.write', 'agent.attachments.read', 'agent.attachments.write', 'agent.history.read', 'agent.stop.write']
  });
  return {
    agentId: r.sharedAgentId,
    token: credential.token
  };
}));
agents.get('/identity', wrap(async r => ({
  agentId: r.sharedAgentId,
  identity: await s.identity(`agent:${r.sharedAgentId}`)
})));
agents.put('/identity', wrap(r => s.registerIdentity(`agent:${r.sharedAgentId}`, r.body, true)));
agents.post('/runtime', wrap(r => {
  s.check(r.authContext?.type === 'agent_token' && r.sharedCredentialId, 403, 'Shared runtime registration requires a scoped agent credential');
  return s.registerRuntime(r.sharedAgentId, r.body, r.sharedCredentialId);
}));
async function requireCurrentRuntime(req, res, next) {
  try {
    s.check(req.sharedRuntimeId && req.sharedCredentialId, 403, 'Current shared runtime credential is required');
    await s.verifyRuntime(req.sharedAgentId, req.sharedRuntimeId, req.sharedCredentialId);
    next();
  } catch (e) {
    if (e instanceof s.SharedError) return res.status(e.status).json({
      error: {
        message: e.message
      }
    });
    next(e);
  }
}
agents.post('/acquire', wrap(r => s.acquire(r.sharedAgentId, r.sharedRuntimeId, 'private', r.body.executionId, r.sharedCredentialId)));
agents.post('/release', wrap(r => s.release(r.sharedAgentId, r.sharedRuntimeId, r.body.executionId, r.body.uncertain === true, r.sharedCredentialId)));
agents.post('/claim', wrap(r => s.claim(r.sharedAgentId, r.sharedRuntimeId, r.sharedCredentialId)));
agents.post('/batches/:batch/interrupted', wrap(r => s.interrupt(r.sharedAgentId, r.sharedRuntimeId, r.params.batch, r.body, r.sharedCredentialId)));
agents.post('/batches/:batch/finish', wrap(r => s.finish(r.sharedAgentId, r.sharedRuntimeId, r.params.batch, r.body, r.sharedCredentialId)));
agents.post('/batches/:batch/read', wrap(r => s.markBatchRead(r.sharedAgentId, r.sharedRuntimeId, r.params.batch, r.body, r.sharedCredentialId)));
agents.get('/batches/:batch', wrap(r => s.agentBatch(r.sharedAgentId, r.sharedRuntimeId, r.params.batch, r.sharedCredentialId)));
const taskRuntime = r => ({ agentId: r.sharedAgentId, runtimeId: r.sharedRuntimeId, credentialId: r.sharedCredentialId });
agents.get('/tasks/:task/authorization', wrap(r => tasks.authorize(taskRuntime(r), r.params.task)));
agents.post('/tasks/:task/actions', wrap(r => tasks.propose(taskRuntime(r), r.params.task, r.body)));
agents.post('/tasks/:task/actions/:action/start', wrap(r => tasks.start(taskRuntime(r), r.params.task, r.params.action, r.body)));
agents.post('/tasks/:task/actions/:action/complete', wrap(r => tasks.complete(taskRuntime(r), r.params.task, r.params.action, r.body)));
agents.post('/tasks/:task/cancellation/confirm', wrap(r => tasks.confirmCancellation(taskRuntime(r), r.params.task, r.body)));
agents.get('/:room', wrap(r => s.agentDetails(r.sharedAgentId, r.params.room, r.sharedRuntimeId, r.sharedCredentialId)));
agents.post('/:room/messages', wrap(r => s.agentSend(r.sharedAgentId, r.params.room, r.body, r.sharedRuntimeId, r.sharedCredentialId)));
agents.get('/:room/messages', wrap(r => s.agentHistory(r.sharedAgentId, r.params.room, r.query.after || 0, r.sharedRuntimeId, r.sharedCredentialId)));
agents.post('/:room/files', requireCurrentRuntime, fileUpload, wrap(r => s.putFile(`agent:${r.sharedAgentId}`, r.params.room, r.body.keyVersion, r.body.id, r.file?.buffer, r.sharedAgentId, r.sharedRuntimeId, r.sharedCredentialId)));
agents.get('/:room/files/:file', wrap(async (r, res) => download(res, await s.getFile(`agent:${r.sharedAgentId}`, r.params.room, r.params.file, r.sharedAgentId, r.sharedRuntimeId, r.sharedCredentialId))));
// Prevent old private consumers from competing with an opted-in shared runtime.
async function fenceLegacy(req, res, next) {
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true') return next();
  if (!['/responses', '/messages/direct', '/messages', '/questions', '/responses/ack', '/messages/direct/ack'].includes(req.path)) return next();
  try {
    const name = req.authContext?.agentName || req.headers['x-agent-name'] || req.body?.agentName || req.query?.agentName;
    const rows = (await db.query(`SELECT r.* FROM shared_runtimes r JOIN agents a ON a.agent_id=r.agent_id
      WHERE a.user_id=$1 AND ($2::text IS NULL OR a.agent_name=$2)`, [req.user.userId, name || null])).rows;
    if (rows.some(r => r.runtime_id !== req.headers['x-shared-runtime'])) return res.status(409).json({
      error: {
        message: 'This agent uses a shared-capable runtime; stop the legacy listener before connecting it.'
      }
    });
    next();
  } catch (e) {
    next(e);
  }
}
module.exports = {
  users,
  agents,
  fenceLegacy,
  enabled
};
