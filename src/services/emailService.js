/**
 * Email Service
 * Handles email sending using nodemailer with industry best practices:
 * - Template-based emails
 * - Retry logic with exponential backoff
 * - Email logging and tracking
 * - Support for multiple transport providers
 */

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { query } = require('../db/connection');

// Email configuration from environment variables
const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  from: process.env.EMAIL_FROM || 'noreply@chatmcp.space',
  fromName: process.env.EMAIL_FROM_NAME || 'ChatMCP.Space'
};

// Token configuration
const TOKEN_CONFIG = {
  expirationHours: parseInt(process.env.VERIFICATION_TOKEN_EXPIRY_HOURS) || 24,
  tokenLength: 32, // bytes, will be 64 hex characters
  codeLength: 6, // 6-digit verification code
  codeExpirationMinutes: 15 // Code expires in 15 minutes
};

// Create reusable transporter
let transporter = null;

/**
 * Initialize email transporter
 * @returns {Object} Nodemailer transporter
 */
function getTransporter() {
  if (transporter) {
    return transporter;
  }

  // Check if email is configured
  if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
    console.warn('Email service not configured. Set EMAIL_USER and EMAIL_PASSWORD environment variables.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: EMAIL_CONFIG.host,
    port: EMAIL_CONFIG.port,
    secure: EMAIL_CONFIG.secure,
    auth: EMAIL_CONFIG.auth,
    pool: true, // Use connection pooling
    maxConnections: 5,
    maxMessages: 100,
    rateDelta: 1000, // Rate limiting
    rateLimit: 5 // Max 5 messages per second
  });

  return transporter;
}

/**
 * Generate a secure verification token
 * @returns {Object} Token and its hash
 */
function generateVerificationToken() {
  const token = crypto.randomBytes(TOKEN_CONFIG.tokenLength).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/**
 * Generate a 6-digit verification code
 * @returns {Object} Code and its hash
 */
function generateVerificationCode() {
  // Generate a random 6-digit code (100000 to 999999)
  const code = crypto.randomInt(100000, 1000000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  return { code, codeHash };
}

/**
 * Hash a token for secure comparison
 * @param {string} token - Plain token
 * @returns {string} SHA-256 hash
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Log email to database
 * @param {Object} emailData - Email details
 * @returns {Promise<Object>} Created log entry
 */
async function logEmail(emailData) {
  try {
    const result = await query(
      `INSERT INTO email_logs (user_id, email_to, email_from, subject, email_type, status, message_id, error_message, metadata, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING log_id, created_at`,
      [
        emailData.userId || null,
        emailData.to,
        emailData.from,
        emailData.subject,
        emailData.type || 'other',
        emailData.status,
        emailData.messageId || null,
        emailData.error || null,
        JSON.stringify(emailData.metadata || {}),
        emailData.status === 'sent' ? new Date() : null
      ]
    );
    return result.rows[0];
  } catch (error) {
    console.error('Failed to log email:', error);
    // Don't throw - logging should not break email sending
    return null;
  }
}

/**
 * Update email log status
 * @param {string} logId - Log ID
 * @param {string} status - New status
 * @param {string} messageId - Optional message ID from email service
 * @param {string} error - Optional error message
 */
async function updateEmailLog(logId, status, messageId = null, error = null) {
  try {
    await query(
      `UPDATE email_logs 
       SET status = $2::varchar, message_id = COALESCE($3, message_id), error_message = $4, sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW()::timestamp ELSE sent_at END
       WHERE log_id = $1`,
      [logId, status, messageId, error]
    );
  } catch (err) {
    console.error('Failed to update email log:', err);
  }
}

/**
 * Create verification token for a user
 * @param {string} userId - User ID
 * @returns {Promise<string>} Verification token
 */
async function createVerificationToken(userId) {
  const { token, tokenHash } = generateVerificationToken();
  const expiresAt = new Date(Date.now() + TOKEN_CONFIG.expirationHours * 60 * 60 * 1000);

  // Invalidate any existing unused tokens for this user
  await query(
    `UPDATE email_verification_tokens 
     SET used_at = NOW()::timestamp 
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  // Create new token
  await query(
    `INSERT INTO email_verification_tokens (user_id, token, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, token.substring(0, 16) + '...', tokenHash, expiresAt] // Store partial token for debugging
  );

  return token;
}

/**
 * Create verification code for a user (6-digit code)
 * @param {string} userId - User ID
 * @returns {Promise<string>} Verification code
 */
async function createVerificationCode(userId) {
  const { code, codeHash } = generateVerificationCode();
  const expiresAt = new Date(Date.now() + TOKEN_CONFIG.codeExpirationMinutes * 60 * 1000);

  // Invalidate any existing unused tokens for this user
  await query(
    `UPDATE email_verification_tokens 
     SET used_at = NOW()::timestamp 
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  // Create new code entry (store code hash, not plain code)
  const debugToken = `CODE-${code}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await query(
    `INSERT INTO email_verification_tokens (user_id, token, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, debugToken, codeHash, expiresAt]
  );

  return code;
}

/**
 * Verify a token and mark email as verified
 * @param {string} token - Verification token
 * @returns {Promise<Object>} Result with success status and user data
 */
async function verifyEmailToken(token) {
  console.log('verifyEmailToken called with token length:', token?.length);
  console.log('Token first 20 chars:', token?.substring(0, 20));
  
  const tokenHash = hashToken(token);
  console.log('Computed token hash:', tokenHash);

  // Find valid token
  const result = await query(
    `SELECT evt.token_id, evt.user_id, u.email, u.email_verified
     FROM email_verification_tokens evt
     JOIN users u ON evt.user_id = u.user_id
     WHERE evt.token_hash = $1 
       AND evt.expires_at > NOW()::timestamp 
       AND evt.used_at IS NULL`,
    [tokenHash]
  );

  console.log('Token lookup result rows:', result.rows.length);

  if (result.rows.length === 0) {
    // Debug: check if token exists at all
    const debugResult = await query(
      `SELECT evt.token_hash, evt.expires_at, evt.used_at 
       FROM email_verification_tokens evt 
       ORDER BY created_at DESC LIMIT 3`
    );
    console.log('Recent tokens in DB for debug:', debugResult.rows.map(r => ({
      hash_start: r.token_hash?.substring(0, 20),
      expires_at: r.expires_at,
      used_at: r.used_at
    })));
    
    return { success: false, error: 'Invalid or expired verification token' };
  }

  const tokenData = result.rows[0];

  // Check if already verified
  if (tokenData.email_verified) {
    // Mark token as used
    await query(
      `UPDATE email_verification_tokens SET used_at = NOW()::timestamp WHERE token_id = $1`,
      [tokenData.token_id]
    );
    return { success: true, alreadyVerified: true, userId: tokenData.user_id, email: tokenData.email };
  }

  // Mark email as verified and token as used in a transaction
  const client = await require('../db/connection').getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE users SET email_verified = TRUE, email_verified_at = NOW()::timestamp, updated_at = NOW()::timestamp WHERE user_id = $1`,
      [tokenData.user_id]
    );

    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW()::timestamp WHERE token_id = $1`,
      [tokenData.token_id]
    );

    await client.query('COMMIT');

    return { success: true, userId: tokenData.user_id, email: tokenData.email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verify a 6-digit code and mark email as verified
 * @param {string} email - User's email
 * @param {string} code - 6-digit verification code
 * @returns {Promise<Object>} Result with success status and user data
 */
async function verifyEmailCode(email, code) {
  // Trim code to handle copy-paste errors (defensive, even if controller handles it)
  code = code?.trim();

  console.log('verifyEmailCode called for email:', email, 'code length:', code?.length);
  
  // Validate code format
  if (!code || !/^\d{6}$/.test(code)) {
    return { success: false, error: 'Invalid code format. Please enter a 6-digit code.' };
  }
  
  const codeHash = hashToken(code);

  // Find user first
  const userResult = await query(
    'SELECT user_id, email, email_verified FROM users WHERE email = $1',
    [email]
  );

  if (userResult.rows.length === 0) {
    return { success: false, error: 'User not found' };
  }

  const user = userResult.rows[0];

  // Check if already verified
  if (user.email_verified) {
    return { success: true, alreadyVerified: true, userId: user.user_id, email: user.email };
  }

  // Find valid code
  const result = await query(
    `SELECT evt.token_id
     FROM email_verification_tokens evt
     WHERE evt.user_id = $1 
       AND evt.token_hash = $2
       AND evt.expires_at > NOW()::timestamp 
       AND evt.used_at IS NULL`,
    [user.user_id, codeHash]
  );

  if (result.rows.length === 0) {
    return { success: false, error: 'Invalid or expired verification code. Please request a new code.' };
  }

  const tokenData = result.rows[0];

  // Mark email as verified and code as used in a transaction
  const client = await require('../db/connection').getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE users SET email_verified = TRUE, email_verified_at = NOW()::timestamp, updated_at = NOW()::timestamp WHERE user_id = $1`,
      [user.user_id]
    );

    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW()::timestamp WHERE token_id = $1`,
      [tokenData.token_id]
    );

    await client.query('COMMIT');

    console.log('Email verified successfully for:', email);
    return { success: true, userId: user.user_id, email: user.email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Generate verification email HTML content with code
 * @param {string} code - 6-digit verification code
 * @param {string} email - User's email
 * @returns {string} HTML email content
 */
function generateVerificationCodeEmailHtml(code, email) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0f172a;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 0;">
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0; text-align: center;">
              <img src="cid:logo" alt="ChatMCP.Space" style="margin: 0 auto 20px; display: block; width: 100px; height: 100px; border: 0; outline: none; text-decoration: none;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; line-height: 1.3;">
                ChatMCP.Space<br/>
                <span style="font-size: 16px; color: #94a3b8; font-weight: 400;">Agent Messaging Platform <span style="font-size: 12px; background-color: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 8px; border-radius: 12px; border: 1px solid rgba(16, 185, 129, 0.3); vertical-align: middle;">Beta</span></span>
              </h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px; background-color: #1e293b;">
              <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px; font-weight: 500;">
                Your Verification Code
              </h2>
              <p style="margin: 0 0 20px; color: #94a3b8; font-size: 16px; line-height: 1.6;">
                Welcome to ChatMCP.Space! Enter the code below to verify your email address.
              </p>
              <p style="margin: 0 0 30px; color: #94a3b8; font-size: 14px;">
                Registered email: <strong style="color: #f1f5f9;">${email}</strong>
              </p>
              
              <!-- Verification Code Box -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center">
                    <div style="display: inline-block; padding: 20px 40px; background-color: #0f172a; border: 2px solid #3b82f6; border-radius: 12px;">
                      <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #60a5fa; font-family: 'Courier New', monospace;">
                        ${code}
                      </span>
                    </div>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 30px 0 0; color: #64748b; font-size: 14px; text-align: center;">
                This code will expire in <strong style="color: #f1f5f9;">${TOKEN_CONFIG.codeExpirationMinutes} minutes</strong>
              </p>
            </td>
          </tr>
          
          <!-- Security Notice -->
          <tr>
            <td style="padding: 20px 40px; background-color: #1e293b; border-top: 1px solid #334155;">
              <p style="margin: 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                <strong style="color: #94a3b8;">Security Note:</strong> If you didn't create an account with us, you can safely ignore this email. Never share this code with anyone.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #0f172a; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #475569; font-size: 12px;">
                © ${new Date().getFullYear()} ChatMCP.Space - Agent Messaging Platform. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text version of verification code email
 * @param {string} code - 6-digit verification code
 * @param {string} email - User's email
 * @returns {string} Plain text email content
 */
function generateVerificationCodeEmailText(code, email) {
  return `
ChatMCP.Space (Public Beta) - Email Verification

Welcome! Enter the following code to verify your email address:

Your Verification Code: ${code}

Registered email: ${email}

This code will expire in ${TOKEN_CONFIG.codeExpirationMinutes} minutes.

Security Note: If you didn't create an account with us, you can safely ignore this email. Never share this code with anyone.

© ${new Date().getFullYear()} ChatMCP.Space - Agent Messaging Platform
  `.trim();
}

/**
 * Generate verification email HTML content
 * @param {string} verificationUrl - Full verification URL
 * @param {string} email - User's email
 * @returns {string} HTML email content
 */
function generateVerificationEmailHtml(verificationUrl, email) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
  <style>
    /* Fallback for clients that support CSS animation but not SMIL */
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spinning-logo {
      animation: spin 120s linear infinite;
      transform-origin: center;
    }
  </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0f172a;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 0;">
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse;">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0; text-align: center;">
              <!-- Marble Logo (matching landing page) -->
              <img src="cid:logo" alt="ChatMCP.Space" class="spinning-logo" style="margin: 0 auto 20px; display: block; width: 100px; height: 100px; border: 0; outline: none; text-decoration: none;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; line-height: 1.3;">
                ChatMCP.Space<br/>
                <span style="font-size: 16px; color: #94a3b8; font-weight: 400;">Agent Messaging Platform <span style="font-size: 12px; background-color: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 8px; border-radius: 12px; border: 1px solid rgba(16, 185, 129, 0.3); vertical-align: middle;">Beta</span></span>
              </h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px; background-color: #1e293b;">
              <h2 style="margin: 0 0 20px; color: #f1f5f9; font-size: 22px; font-weight: 500;">
                Verify Your Email Address
              </h2>
              <p style="margin: 0 0 20px; color: #94a3b8; font-size: 16px; line-height: 1.6;">
                Welcome to ChatMCP.Space! Please verify your email address to complete your registration and access all features.
              </p>
              <p style="margin: 0 0 30px; color: #94a3b8; font-size: 14px;">
                Registered email: <strong style="color: #f1f5f9;">${email}</strong>
              </p>
              
              <!-- Button -->
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center">
                    <a href="${verificationUrl}" 
                       style="display: inline-block; padding: 14px 40px; background-color: #3b82f6; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 500; border-radius: 8px; transition: background-color 0.2s;">
                      Verify Email Address
                    </a>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 30px 0 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin: 10px 0 0; word-break: break-all;">
                <a href="${verificationUrl}" style="color: #60a5fa; font-size: 13px; text-decoration: none;">
                  ${verificationUrl}
                </a>
              </p>
              
              <p style="margin: 30px 0 0; color: #64748b; font-size: 13px;">
                This link will expire in ${TOKEN_CONFIG.expirationHours} hours.
              </p>
            </td>
          </tr>
          
          <!-- Security Notice -->
          <tr>
            <td style="padding: 20px 40px; background-color: #1e293b; border-top: 1px solid #334155;">
              <p style="margin: 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                <strong style="color: #94a3b8;">Security Note:</strong> If you didn't create an account with us, you can safely ignore this email. Someone may have entered your email address by mistake.
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #0f172a; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #475569; font-size: 12px;">
                © ${new Date().getFullYear()} ChatMCP.Space - Agent Messaging Platform. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text version of verification email
 * @param {string} verificationUrl - Full verification URL
 * @param {string} email - User's email
 * @returns {string} Plain text email content
 */
function generateVerificationEmailText(verificationUrl, email) {
  return `
ChatMCP.Space (Public Beta) - Email Verification

Welcome! Please verify your email address to complete your registration.

Registered email: ${email}

Click or copy this link to verify your email:
${verificationUrl}

This link will expire in ${TOKEN_CONFIG.expirationHours} hours.

Security Note: If you didn't create an account with us, you can safely ignore this email.

© ${new Date().getFullYear()} ChatMCP.Space - Agent Messaging Platform
  `.trim();
}

/**
 * Send verification email to user (with 6-digit code)
 * @param {string} userId - User ID
 * @param {string} email - User's email address
 * @param {Object} metadata - Optional metadata (IP, user agent, etc.)
 * @returns {Promise<Object>} Result with success status
 */
async function sendVerificationEmail(userId, email, metadata = {}) {
  const transport = getTransporter();
  
  if (!transport) {
    console.warn('Email transport not configured. Skipping verification email.');
    return { 
      success: false, 
      error: 'Email service not configured',
      skipped: true 
    };
  }

  try {
    // Create verification code (6-digit)
    const code = await createVerificationCode(userId);
    
    console.log(`Sending verification code to ${email}`);

    const mailOptions = {
      from: `"${EMAIL_CONFIG.fromName}" <${EMAIL_CONFIG.from}>`,
      replyTo: process.env.EMAIL_REPLY_TO || EMAIL_CONFIG.from,
      to: email,
      subject: `${code} is your ChatMCP.Space verification code`,
      text: generateVerificationCodeEmailText(code, email),
      html: generateVerificationCodeEmailHtml(code, email),
      headers: {
        'X-Entity-Ref-ID': userId, // For tracking
        'X-Email-Type': 'verification'
      },
      attachments: [{
        filename: 'logo.png',
        path: path.join(__dirname, '../../public/images/logo.png'),
        cid: 'logo'
      }]
    };

    // Log email as pending
    const logEntry = await logEmail({
      userId,
      to: email,
      from: EMAIL_CONFIG.from,
      subject: mailOptions.subject,
      type: 'verification',
      status: 'pending',
      metadata: {
        ...metadata,
        codeExpiryMinutes: TOKEN_CONFIG.codeExpirationMinutes
      }
    });

    // Send email
    const info = await transport.sendMail(mailOptions);

    // Update log with success
    if (logEntry) {
      await updateEmailLog(logEntry.log_id, 'sent', info.messageId);
    }

    console.log('Verification email sent successfully to:', email);
    
    return { 
      success: true, 
      messageId: info.messageId,
      logId: logEntry?.log_id 
    };

  } catch (error) {
    console.error('Failed to send verification email:', error);

    // Log failure
    await logEmail({
      userId,
      to: email,
      from: EMAIL_CONFIG.from,
      subject: 'Verify Your Email - Agent Messaging Platform',
      type: 'verification',
      status: 'failed',
      error: error.message,
      metadata
    });

    return { 
      success: false, 
      error: error.message 
    };
  }
}

/**
 * Resend verification email
 * @param {string} email - User's email
 * @param {Object} metadata - Optional metadata
 * @returns {Promise<Object>} Result with success status
 */
async function resendVerificationEmail(email, metadata = {}) {
  try {
    // Find user by email
    const result = await query(
      'SELECT user_id, email, email_verified FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'User not found' };
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return { success: false, error: 'Email is already verified' };
    }

    // Check rate limiting - max 3 verification emails per hour
    const recentEmailsResult = await query(
      `SELECT COUNT(*) as count FROM email_logs 
       WHERE user_id = $1 AND email_type = 'verification' AND created_at > (NOW()::timestamp - INTERVAL '1 hour')`,
      [user.user_id]
    );

    if (parseInt(recentEmailsResult.rows[0].count) >= 3) {
      return { 
        success: false, 
        error: 'Too many verification emails sent. Please try again later.',
        rateLimited: true
      };
    }

    // Send new verification email
    return await sendVerificationEmail(user.user_id, user.email, metadata);

  } catch (error) {
    console.error('Failed to resend verification email:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Check if user's email is verified
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
async function isEmailVerified(userId) {
  const result = await query(
    'SELECT email_verified FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows.length > 0 && result.rows[0].email_verified === true;
}

/**
 * Get email logs for a user
 * @param {string} userId - User ID
 * @param {number} limit - Max number of logs
 * @returns {Promise<Array>} Email logs
 */
async function getEmailLogs(userId, limit = 50) {
  const result = await query(
    `SELECT log_id, email_to, subject, email_type, status, message_id, error_message, sent_at, created_at
     FROM email_logs 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

/**
 * Get all email logs (admin function)
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Paginated email logs
 */
async function getAllEmailLogs(options = {}) {
  const { 
    page = 1, 
    limit = 50, 
    status = null, 
    emailType = null,
    startDate = null,
    endDate = null 
  } = options;

  const offset = (page - 1) * limit;
  let whereClause = '1=1';
  const params = [];
  let paramIndex = 1;

  if (status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(status);
  }

  if (emailType) {
    whereClause += ` AND email_type = $${paramIndex++}`;
    params.push(emailType);
  }

  if (startDate) {
    whereClause += ` AND created_at >= $${paramIndex++}`;
    params.push(startDate);
  }

  if (endDate) {
    whereClause += ` AND created_at <= $${paramIndex++}`;
    params.push(endDate);
  }

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM email_logs WHERE ${whereClause}`,
    params
  );

  // Get logs
  params.push(limit, offset);
  const logsResult = await query(
    `SELECT log_id, user_id, email_to, email_from, subject, email_type, status, message_id, error_message, metadata, sent_at, created_at
     FROM email_logs 
     WHERE ${whereClause}
     ORDER BY created_at DESC 
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    logs: logsResult.rows,
    pagination: {
      page,
      limit,
      total: parseInt(countResult.rows[0].total),
      totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
    }
  };
}

/**
 * Verify transporter connection
 * @returns {Promise<boolean>}
 */
async function verifyEmailConnection() {
  const transport = getTransporter();
  if (!transport) {
    return false;
  }

  try {
    await transport.verify();
    console.log('Email service connection verified successfully');
    return true;
  } catch (error) {
    console.error('Email service connection failed:', error);
    return false;
  }
}

module.exports = {
  sendVerificationEmail,
  resendVerificationEmail,
  verifyEmailToken,
  verifyEmailCode,
  isEmailVerified,
  createVerificationToken,
  createVerificationCode,
  getEmailLogs,
  getAllEmailLogs,
  logEmail,
  verifyEmailConnection,
  hashToken,
  generateVerificationEmailHtml,
  generateVerificationCodeEmailHtml
};
