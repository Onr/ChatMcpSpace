'use strict';

const express = require('express');
const multer = require('multer');
const threads = require('./chatThreadService');
const history = require('./chatHistoryImportService');
const invitations = require('./chatInvitationService');
const sharedService = require('./service');
const router = express.Router();
const historyFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: sharedService.MAX_FILE_BYTES + 28, files: 1 } }).single('file');

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (process.env.FEATURE_IN_PLACE_AGENT_SHARING !== 'true') {
    return res.status(404).json({ error: { message: 'In-place agent sharing is not enabled' } });
  }
  next();
});
function wrap(fn) {
  return async (req, res, next) => {
    try { res.json(await fn(req)); }
    catch (error) {
      if (error instanceof threads.ChatThreadError) return res.status(error.status).json({ error: { message: error.message } });
      if (error instanceof history.HistoryImportError) return res.status(error.status).json({ error: { message: error.message } });
      if (error instanceof invitations.InvitationError) return res.status(error.status).json({ error: { message: error.message } });
      next(error);
    }
  };
}

router.get('/', wrap(req => threads.listChatThreads(req.user.userId)));
router.post('/resolve', wrap(req => threads.resolveAgentThread(req.user.userId, req.body?.agentId)));
router.get('/:conversationId/owner-history', wrap(req => history.ownerPrivateHistory(req.user.userId, req.params.conversationId, req.query.offset || 0, req.query.boundary, req.query.limit ?? 200)));
router.get('/:conversationId/share-preview', wrap(req => history.previewShareHistory(req.user.userId, req.params.conversationId)));
router.get('/:conversationId/imports/active', wrap(req => history.getActiveHistoryImport(req.user.userId, req.params.conversationId)));
router.post('/:conversationId/imports', wrap(req => history.beginHistoryImport(req.user.userId, req.params.conversationId, req.body?.requestId, req.body?.sourceFingerprint)));
router.get('/imports/:importId', wrap(req => history.getHistoryImport(req.user.userId, req.params.importId)));
router.get('/imports/:importId/source', wrap(req => history.readImportSourcePage(req.user.userId, req.params.importId, req.query.offset || 0, req.query.limit || 100)));
router.post('/imports/:importId/messages', wrap(req => history.importHistoryChunk(req.user.userId, req.params.importId, req.body?.revision, req.body?.items)));
router.post('/imports/:importId/files/:sourceAttachmentId', (req, res, next) => historyFileUpload(req, res, error => {
  if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { message: 'Attach one encrypted history file up to 20 MB.' } });
  next();
}), wrap(req => history.importHistoryFile(req.user.userId, req.params.importId, req.body?.revision,
  req.params.sourceAttachmentId, req.body?.targetFileId, req.file?.buffer)));
router.post('/imports/:importId/validate', wrap(req => history.validateHistoryImport(req.user.userId, req.params.importId)));
router.post('/imports/:importId/activate', wrap(req => history.activateSharedThread(req.user.userId, req.params.importId, req.body?.revision)));
router.delete('/imports/:importId', wrap(req => history.abortHistoryImport(req.user.userId, req.params.importId)));
router.get('/invitations/incoming', wrap(req => invitations.listIncomingInvitations(req.user.userId)));
router.get('/invitations/:invitationId', wrap(req => invitations.getInvitationPreview(req.user.userId, req.params.invitationId)));
router.post('/invitations/:invitationId/accept', wrap(req => invitations.acceptAccountInvitation(req.user.userId, req.params.invitationId, req.body?.requestId)));
router.post('/invitations/:invitationId/decline', wrap(req => invitations.declineInvitation(req.user.userId, req.params.invitationId)));
router.delete('/invitations/:invitationId', wrap(req => invitations.revokeInvitation(req.user.userId, req.params.invitationId)));
router.get('/:conversationId/invitations', wrap(req => invitations.listConversationInvitations(req.user.userId, req.params.conversationId)));
router.post('/invitations/:invitationId/resend', wrap(req => invitations.resendAccountInvitationEmail(req.user.userId, req.params.invitationId,
  process.env.BASE_URL || `${req.protocol}://${req.get('host')}`)));
router.post('/:conversationId/invitations', wrap(req => invitations.createAccountInvitation(req.user.userId, req.params.conversationId, req.body?.email, req.body?.requestId,
  process.env.BASE_URL || `${req.protocol}://${req.get('host')}`)));
router.get('/:conversationId', wrap(req => threads.getChatContext(req.user.userId, req.params.conversationId)));
router.post('/:conversationId/adopt', wrap(req => threads.adoptExistingSharedThread(req.user.userId, req.params.conversationId)));

module.exports = router;
