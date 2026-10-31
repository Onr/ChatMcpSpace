'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const multer = require('multer');
const guestService = require('./guestService');
const tasks = require('./taskAuthority');
const { SharedError } = require('./service');
const {
  guestSharingEnabled,
  guestOriginCheck,
  guestSessionRequired,
  guestCsrfRequired,
  setGuestCookies,
  clearGuestCookies,
  tokenHash
} = require('../middleware/guestAuthMiddleware');
const { guestUnlockRateLimiter } = require('../middleware/guestRateLimit');

const LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PASSWORD_BYTES = 72;
const guestUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1000 * 1000 + 28,
    files: 1,
    fields: 4
  }
}).single('file');

function disabled(res) {
  return res.status(404).json({
    error: {
      code: 'GUEST_SHARING_DISABLED',
      message: 'Guest sharing is not enabled'
    }
  });
}

function enabled(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!guestSharingEnabled()) return disabled(res);
  next();
}

function genericUnlockFailure(res) {
  return res.status(401).json({
    error: {
      code: 'GUEST_UNLOCK_FAILED',
      message: 'The guest link or password is invalid'
    }
  });
}

function displayName(value) {
  if (value === undefined || value === null || value === '') return 'Guest';
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80) {
    const error = new SharedError(400, 'Invalid guest display name');
    throw error;
  }
  return value.trim();
}

function passwordInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) return null;
  return value;
}

function newSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function safeShare(share) {
  return {
    shareId: share.share_id,
    roomMode: share.room_mode,
    expiresAt: share.expires_at || null
  };
}

function routeError(res, error) {
  if (error instanceof SharedError) {
    return res.status(error.status).json({ error: { code: 'GUEST_REQUEST_INVALID', message: error.message } });
  }
  throw error;
}

async function authorizeGuestRoom(req, res, next) {
  try {
    await guestService.assertGuestRoom({
      sessionId: req.guestSessionId,
      sessionTokenHash: req.guestSessionTokenHash,
      roomId: req.params.room
    });
    next();
  } catch (error) {
    if (error instanceof SharedError) return routeError(res, error);
    next(error);
  }
}

function parseGuestUpload(req, res, next) {
  guestUpload(req, res, error => {
    if (error) return res.status(400).json({ error: { code: 'GUEST_UPLOAD_INVALID', message: 'Upload one encrypted file, at most 20 MB' } });
    next();
  });
}

function downloadGuest(res, file) {
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment',
    'X-Shared-Key-Version': String(file.key_version)
  });
  res.send(file.bytes);
}

function createGuestRouter({ rateLimiter = guestUnlockRateLimiter } = {}) {
  const router = express.Router();
  router.use(enabled);
  router.use(guestOriginCheck);

  router.post('/preview', rateLimiter, async (req, res, next) => {
    try {
      const linkSecret = req.body?.linkSecret;
      if (!LINK_SECRET_PATTERN.test(String(linkSecret || ''))) return genericUnlockFailure(res);
      return res.json(await guestService.previewGuestLink(linkSecret));
    } catch (error) {
      if (error instanceof SharedError) {
        if (error.status === 404 || error.status === 400) return genericUnlockFailure(res);
        return routeError(res, error);
      }
      next(error);
    }
  });

  router.post('/unlock', rateLimiter, async (req, res, next) => {
    try {
      const linkSecret = req.body?.linkSecret;
      if (!LINK_SECRET_PATTERN.test(String(linkSecret || ''))) return genericUnlockFailure(res);
      const password = passwordInput(req.body?.password);
      if (req.body?.password !== undefined && req.body?.password !== null && password === null) {
        return genericUnlockFailure(res);
      }
      const share = await guestService.findShareByLinkSecret(linkSecret);
      if (!share) return genericUnlockFailure(res);
      if (share.password_hash) {
        if (password === null || !await bcrypt.compare(password, share.password_hash)) {
          return genericUnlockFailure(res);
        }
      }

      const guestName = displayName(req.body?.displayName);
      const sessionToken = newSecret();
      const csrfToken = newSecret();
      const { guest, session } = await guestService.createUnlockedGuestSession({
        verifiedShare: share,
        displayName: guestName,
        note: typeof req.body?.note === 'string' ? req.body.note : null,
        sessionTokenHash: tokenHash(sessionToken),
        csrfSecretHash: tokenHash(csrfToken)
      });
      setGuestCookies(res, req, {
        sessionId: session.session_id,
        sessionToken,
        csrfToken,
        maxAge: Math.max(1, new Date(session.expires_at).getTime() - Date.now())
      });
      return res.json({
        guest: {
          guestId: guest.guest_id,
          displayName: guest.display_name,
          status: guest.status
        },
        share: safeShare(share),
        csrfToken,
        sessionExpiresAt: session.expires_at
      });
    } catch (error) {
      if (error instanceof SharedError) {
        if ([404, 409].includes(error.status) || error.status === 400 && error.message === 'Invalid guest link') return genericUnlockFailure(res);
        return routeError(res, error);
      }
      next(error);
    }
  });

  router.get('/session', guestSessionRequired, (req, res) => res.json({
    guest: {
      guestId: req.guestAccess.guest.guest_id,
      displayName: req.guestAccess.guest.display_name,
      status: req.guestAccess.guest.status
    },
    share: safeShare(req.guestAccess.share),
    sessionExpiresAt: req.guestAccess.session.expires_at
  }));

  router.get('/workspace', guestSessionRequired, async (req, res, next) => {
    try {
      res.json(await guestService.guestWorkspace({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.put('/identity', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      const identity = await guestService.registerGuestIdentity({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        publicKey: req.body?.publicKey
      });
      res.json(identity);
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.get('/rooms/:room', guestSessionRequired, async (req, res, next) => {
    try {
      res.json(await guestService.guestRoomContext({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.get('/rooms/:room/messages', guestSessionRequired, async (req, res, next) => {
    try {
      res.json(await guestService.guestHistory({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        after: req.query.after || 0,
        since: req.query.since || null,
        before: req.query.before || null,
        limit: req.query.limit || 200
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.get('/rooms/:room/message-status', guestSessionRequired, async (req, res, next) => {
    try {
      res.json(await guestService.guestMessageStatuses({ sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash, roomId: req.params.room,
        messageIds: String(req.query.ids || '').split(',').filter(Boolean) }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });
  router.get('/rooms/:room/tasks', guestSessionRequired, async (req, res, next) => {
    try { res.json(await tasks.listGuest({ sessionId: req.guestSessionId, sessionTokenHash: req.guestSessionTokenHash }, req.params.room)); }
    catch (error) { if (error instanceof SharedError) return routeError(res, error); next(error); }
  });
  router.post('/tasks/:task/cancel', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try { res.json(await tasks.cancel(null, req.params.task, { sessionId: req.guestSessionId, sessionTokenHash: req.guestSessionTokenHash })); }
    catch (error) { if (error instanceof SharedError) return routeError(res, error); next(error); }
  });

  router.post('/rooms/:room/messages', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      res.json(await guestService.insertGuestMessage({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        body: req.body
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.post('/rooms/:room/questions/:question/answer', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      res.json(await guestService.answerGuestQuestion({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        questionId: req.params.question,
        body: req.body
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.delete('/rooms/:room/messages/:message', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      res.json(await guestService.removeGuestMessage({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        messageId: req.params.message
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.post('/rooms/:room/read', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      res.json(await guestService.guestRead({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        seq: req.body?.seq
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.post('/rooms/:room/files', guestSessionRequired, guestCsrfRequired, authorizeGuestRoom, parseGuestUpload, async (req, res, next) => {
    try {
      res.json(await guestService.putGuestFile({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        keyVersion: req.body?.keyVersion,
        id: req.body?.id,
        bytes: req.file?.buffer
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.get('/rooms/:room/files/:file', guestSessionRequired, async (req, res, next) => {
    try {
      downloadGuest(res, await guestService.getGuestFile({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        id: req.params.file
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.delete('/rooms/:room/files/:file', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      res.json(await guestService.removeGuestFile({
        sessionId: req.guestSessionId,
        sessionTokenHash: req.guestSessionTokenHash,
        roomId: req.params.room,
        id: req.params.file
      }));
    } catch (error) {
      if (error instanceof SharedError) return routeError(res, error);
      next(error);
    }
  });

  router.post('/logout', guestSessionRequired, guestCsrfRequired, async (req, res, next) => {
    try {
      await guestService.revokeGuestSession(req.guestSessionId);
      clearGuestCookies(res, req);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createGuestRouter();
module.exports.createGuestRouter = createGuestRouter;
