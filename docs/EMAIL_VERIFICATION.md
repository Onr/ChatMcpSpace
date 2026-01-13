# Email Verification System

This document describes the email verification system implementation for the Agent Messaging Platform.

## Overview

The email verification system ensures that users provide a valid email address during registration. It follows industry best practices including:

- **Secure token generation**: Uses cryptographically secure random tokens (64 hex characters)
- **Token hashing**: Stores SHA-256 hashed tokens in the database for security
- **Rate limiting**: Prevents abuse by limiting resend requests (max 3 per hour)
- **Token expiration**: Tokens expire after 24 hours (configurable)
- **Email logging**: All sent emails are logged for audit and debugging purposes

## Setup

### 1. Database Migration

Run the migration script to create the required tables:

```bash
cd /path/to/AgentsMCPspace
bash scripts/run_email_verification_migration.sh
```

This creates:
- `email_verification_tokens` - Stores verification tokens
- `email_logs` - Logs all sent emails
- Adds `email_verified` and `email_verified_at` columns to `users` table

### 2. Email Configuration

Add the following environment variables to your `.env` file:

```env
# Email Server Configuration
EMAIL_HOST=smtp.gmail.com          # SMTP server host
EMAIL_PORT=587                     # SMTP port (587 for TLS, 465 for SSL)
EMAIL_SECURE=false                 # true for SSL (port 465), false for TLS
EMAIL_USER=your-email@gmail.com    # SMTP username
EMAIL_PASSWORD=your-app-password   # SMTP password or app-specific password

# Email Content Settings
EMAIL_FROM=noreply@yourdomain.com  # From email address
EMAIL_FROM_NAME=Agent Messaging Platform  # From display name

# Token Settings
VERIFICATION_TOKEN_EXPIRY_HOURS=24  # How long tokens are valid
```

### Gmail App Passwords

If using Gmail, you need to generate an App Password:
1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification if not already enabled
3. Go to App passwords
4. Generate a new app password for "Mail"
5. Use this password in `EMAIL_PASSWORD`

## User Flow

### Registration
1. User fills out registration form with email and password
2. Account is created with `email_verified = false`
3. Verification email is sent with unique token link
4. User is redirected to "Check Your Email" page
5. User can access limited features while unverified

### Email Verification
1. User clicks link in verification email
2. Token is validated (not expired, not used)
3. User's `email_verified` is set to `true`
4. User sees success confirmation page

### Resend Verification
1. User can request a new verification email
2. Previous unused tokens are invalidated
3. Rate limited to 3 requests per hour
4. New token is generated and sent

## API Endpoints

### Page Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/verify-email-sent` | Shows "check your email" page |
| GET | `/verify-email?token=xxx` | Handles verification link |
| POST | `/resend-verification` | Resends verification email |

### Email API Routes (`/api/email/`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/logs` | Get email logs for current user |
| GET | `/verification-status` | Check if email is verified |
| GET | `/stats` | Get email statistics |

## Database Schema

### email_verification_tokens
```sql
CREATE TABLE email_verification_tokens (
  token_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token VARCHAR(64) UNIQUE NOT NULL,        -- Partial token for debugging
  token_hash VARCHAR(255) NOT NULL,         -- SHA-256 hash of full token
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### email_logs
```sql
CREATE TABLE email_logs (
  log_id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  email_to VARCHAR(255) NOT NULL,
  email_from VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  email_type VARCHAR(50) NOT NULL,          -- verification, password_reset, etc.
  status VARCHAR(20) NOT NULL,              -- pending, sent, failed, bounced, delivered
  message_id VARCHAR(255),                  -- Email service message ID
  error_message TEXT,                       -- Error details if failed
  metadata JSONB DEFAULT '{}',              -- IP, user agent, etc.
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Security Features

1. **Token Security**: Full tokens are never stored; only SHA-256 hashes
2. **Token Expiration**: Tokens expire after 24 hours
3. **Single Use**: Tokens can only be used once
4. **Rate Limiting**: Max 3 verification emails per hour per user
5. **CSRF Protection**: Resend endpoint requires CSRF token
6. **Metadata Logging**: IP and user agent logged for security auditing

## UI Components

### Verification Banner
When logged in with an unverified email, a warning banner appears at the top of every page prompting the user to verify their email.

### Verification Sent Page (`/verify-email-sent`)
- Shows confirmation that email was sent
- Displays the email address
- Provides instructions
- Allows resending with cooldown

### Verification Result Page (`/verify-email`)
- Shows success or failure state
- Links to dashboard on success
- Shows error details on failure

## Extending the System

### Adding New Email Types
1. Add the type to the `email_type` CHECK constraint in `email_logs`
2. Create a new template function in `emailService.js`
3. Create a new send function following the pattern of `sendVerificationEmail`

### Enforcing Verification for Features
Use the `requireEmailVerification` middleware:

```javascript
const { protectRoute, requireEmailVerification } = require('../middleware/authMiddleware');

router.post('/sensitive-action', protectRoute, requireEmailVerification, async (req, res) => {
  // This route requires email verification
});
```

## Troubleshooting

### Emails Not Sending
1. Check EMAIL_* environment variables are set
2. Verify SMTP credentials are correct
3. Check email_logs table for error messages
4. Ensure port 587/465 is not blocked by firewall

### Token Invalid Errors
1. Token may have expired (24 hours)
2. Token may have been used already
3. Link may have been truncated when copied

### Rate Limiting
Users are limited to 3 verification emails per hour. Wait 1 hour or check email_logs for the sent emails.
