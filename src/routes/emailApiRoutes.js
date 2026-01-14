/**
 * Email API Routes
 * Endpoints for email verification and email log management
 */

const express = require('express');
const router = express.Router();
const { protectRoute, requireEmailVerification } = require('../middleware/authMiddleware');
const {
  getEmailLogs,
  getAllEmailLogs,
  resendVerificationEmail,
  verifyEmailToken,
  verifyEmailCode,
} = require('../services/emailService');
const { query } = require('../db/connection');

/**
 * POST /api/email/verify-token
 * Verify an email verification token (legacy link-based verification)
 */
router.post('/verify-token', async (req, res) => {
  try {
    const token = req.body?.token || req.query?.token;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Verification token is required',
      });
    }

    const result = await verifyEmailToken(token);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Invalid or expired verification token',
      });
    }

    return res.json({
      success: true,
      userId: result.userId,
      email: result.email,
      alreadyVerified: result.alreadyVerified === true,
    });
  } catch (error) {
    console.error('Email token verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify email token',
    });
  }
});

/**
 * POST /api/email/verify-code
 * Verify an email with a 6-digit code
 */
router.post('/verify-code', async (req, res) => {
  try {
    const email = req.body?.email;
    const code = req.body?.code;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        error: 'Email and verification code are required',
      });
    }

    const result = await verifyEmailCode(email, code);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Invalid or expired verification code',
      });
    }

    return res.json({
      success: true,
      userId: result.userId,
      email: result.email,
      alreadyVerified: result.alreadyVerified === true,
    });
  } catch (error) {
    console.error('Email code verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify email code',
    });
  }
});

/**
 * POST /api/email/resend-verification
 * Resend verification email/code to a given email address
 */
router.post('/resend-verification', async (req, res) => {
  try {
    const email = req.body?.email;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
      });
    }

    const result = await resendVerificationEmail(email, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (!result.success) {
      const status = result.rateLimited ? 429 : 400;
      return res.status(status).json({
        success: false,
        error: result.error || 'Failed to resend verification email',
        rateLimited: result.rateLimited === true,
      });
    }

    return res.json({
      success: true,
      messageId: result.messageId,
      logId: result.logId,
    });
  } catch (error) {
    console.error('Resend verification API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to resend verification email',
    });
  }
});

/**
 * GET /api/email/logs
 * Get email logs for the authenticated user
 */
router.get('/logs', protectRoute, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const logs = await getEmailLogs(req.user.userId, limit);

    res.json({
      success: true,
      logs: logs.map(log => ({
        id: log.log_id,
        to: log.email_to,
        subject: log.subject,
        type: log.email_type,
        status: log.status,
        sentAt: log.sent_at,
        createdAt: log.created_at,
        error: log.error_message
      }))
    });
  } catch (error) {
    console.error('Error fetching email logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch email logs'
    });
  }
});

/**
 * GET /api/email/verification-status
 * Get current email verification status
 */
router.get('/verification-status', protectRoute, async (req, res) => {
  try {
    const result = await query(
      'SELECT email_verified, email_verified_at FROM users WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      verified: result.rows[0].email_verified === true,
      verifiedAt: result.rows[0].email_verified_at
    });
  } catch (error) {
    console.error('Error checking verification status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check verification status'
    });
  }
});

/**
 * GET /api/email/stats
 * Get email statistics for the authenticated user
 */
router.get('/stats', protectRoute, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        email_type,
        status,
        COUNT(*) as count
      FROM email_logs 
      WHERE user_id = $1
      GROUP BY email_type, status
      ORDER BY email_type, status
    `, [req.user.userId]);

    // Transform into a more usable format
    const stats = {};
    result.rows.forEach(row => {
      if (!stats[row.email_type]) {
        stats[row.email_type] = {};
      }
      stats[row.email_type][row.status] = parseInt(row.count);
    });

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching email stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch email stats'
    });
  }
});

module.exports = router;
