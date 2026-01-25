# AI Agent Messaging Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org)

<div align="center">
  <img src="public/images/logo.png" alt="ChatMcpSpace Logo" width="200" />
</div>

A web-based platform that enables bidirectional communication between users and their AI agents through a chat-like interface.

## Hosted Version

Live at **[https://chatmcp.space/](https://chatmcp.space/)**

## Features

- **User Authentication**: Secure registration and login with email/password or Google OAuth
- **Email Verification**: New accounts require email verification before access
- **Agent Messaging**: AI agents can send messages to users via REST API
- **Free-text User Replies**: Users can respond with their own text and send it straight back to the agents
- **Interactive Questions**: Agents can present multiple-choice questions with benefits/downsides
- **Image Attachments**: Both agents and users can attach images to messages
- **Real-time Updates**: Frontend polling for new messages and responses
- **API Key Management**: Each user gets a unique API key for their agents
- **Priority & Urgency**: Messages can be marked with priority levels and urgent flags
- **User Isolation**: Complete data isolation between users
- **End-to-End Encryption**: Encrypted message content for users and agents
- **Voice Alerts & TTS**: Voice notifications and text-to-speech playback for messages
- **Message Archive**: Archive old agents and messages for long-term storage
- **CLI Setup Script**: One-command agent CLI installation via `/setup`

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- Redis (v6 or higher) - required for session storage and rate limiting
- npm or yarn

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/onr/ChatMcpSpace.git
   cd ChatMcpSpace
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up PostgreSQL database**

   Create a new PostgreSQL database:
   ```bash
   createdb agent_messaging_platform
   ```

   Initialize the database schema:
   ```bash
   psql -d agent_messaging_platform -f src/db/schema.sql
   ```

4. **Set up Redis**

   Ensure Redis is running locally:
   ```bash
   redis-server
   ```

   Or connect to a remote Redis instance via `REDIS_URL`.

5. **Configure environment variables**

   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and configure the required variables (see [Configuration](#configuration) below).

## Configuration

### Required Variables

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=agent_messaging_platform
DB_USER=your_db_user
DB_PASSWORD=your_db_password

# Redis
REDIS_URL=redis://localhost:6379

# Session
SESSION_SECRET=your_random_secret_key_here

# Server
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000
```

### Optional Variables

```bash
# Redis (alternative to REDIS_URL)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_SESSION_DB=0
REDIS_RATE_DB=1

# Email (required for email verification)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=noreply@yourdomain.com
EMAIL_FROM_NAME=Agent Messaging Platform
VERIFICATION_TOKEN_EXPIRY_HOURS=24

# Google OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# TLS/HTTPS (optional)
HTTPS_ENABLED=false
HTTPS_PORT=3443
HTTPS_KEY_PATH=./keys/localhost-key.pem
HTTPS_CERT_PATH=./keys/localhost-cert.pem
ENABLE_HTTP_REDIRECT=false
HTTP_REDIRECT_PORT=3000

# Features
TTS_ENABLED=true
LOG_LEVEL=info

# Image Upload
MAX_IMAGE_SIZE_MB=20
MAX_IMAGES_PER_USER=10
```

## Running the Application

**Development mode:**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in your .env file).

## Enabling HTTPS / TLS

The server can terminate TLS directly when certificates are available.

1) Place your certificate and key files on disk (not in git).
   - Production example (Let's Encrypt):
     - `HTTPS_KEY_PATH=/etc/letsencrypt/live/<domain>/privkey.pem`
     - `HTTPS_CERT_PATH=/etc/letsencrypt/live/<domain>/fullchain.pem`
   - Local self-signed quickstart (valid for 365 days):
     ```bash
     mkdir -p keys
     openssl req -x509 -newkey rsa:2048 -nodes -keyout keys/localhost-key.pem \
       -out keys/localhost-cert.pem -days 365 -subj "/CN=localhost"
     ```
     Then set `BASE_URL=https://localhost:3443`.

2) Update `.env`:
   ```
   HTTPS_ENABLED=true
   HTTPS_PORT=3443
   HTTPS_KEY_PATH=/path/to/privkey.pem
   HTTPS_CERT_PATH=/path/to/fullchain.pem
   ENABLE_HTTP_REDIRECT=true
   HTTP_REDIRECT_PORT=3000
   ```

3) Start the server. It will listen on `HTTPS_PORT` and log `TLS: enabled (HTTPS)`.

## Usage

### For Users

1. **Register**: Visit `/register` to create a new account
2. **Verify Email**: Check your email and enter the verification code
3. **Login**: Visit `/login` to access your dashboard
4. **Dashboard**: View and respond to messages from your AI agents
5. **Settings**: Get your API key and CLI setup instructions at `/settings`
6. **Archive**: View archived agents and messages at `/archive`

### For AI Agents

Use the REST API to send messages and questions. A CLI setup script is available:

```bash
curl -sSL https://your-server.com/setup | bash
```

**Send a Message:**
```bash
curl -X POST http://localhost:3000/api/agent/messages \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello from your AI agent!",
    "priority": 0,
    "agentName": "My Agent"
  }'
```

**Send a Question:**
```bash
curl -X POST http://localhost:3000/api/agent/questions \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Which option do you prefer?",
    "priority": 2,
    "agentName": "My Agent",
    "options": [
      {
        "text": "Option A",
        "benefits": "Fast and efficient",
        "downsides": "Higher cost",
        "isDefault": true
      },
      {
        "text": "Option B",
        "benefits": "Lower cost",
        "downsides": "Takes longer"
      }
    ]
  }'
```

**Poll for Responses:**
```bash
curl -X GET "http://localhost:3000/api/agent/responses?since=2024-01-01T00:00:00Z" \
  -H "X-API-Key: YOUR_API_KEY"
```

## Project Structure

```
.
├── server.js                 # Main application entry point
├── package.json              # Dependencies and scripts
├── .env.example              # Environment variables template
├── docs/                     # Additional documentation
│   ├── ARCHIVE_USER_GUIDE.md
│   ├── EMAIL_VERIFICATION.md
│   └── IMAGE_MESSAGING.md
├── src/
│   ├── config/               # Configuration
│   │   └── passport.js       # Google OAuth setup
│   ├── controllers/          # Request handlers
│   │   ├── agentAttachmentController.js
│   │   └── userAttachmentController.js
│   ├── db/                   # Database
│   │   ├── connection.js
│   │   ├── schema.sql
│   │   ├── init.js
│   │   ├── runMigrations.js
│   │   └── migrations/
│   ├── middleware/           # Express middleware
│   │   ├── authMiddleware.js
│   │   ├── csrfMiddleware.js
│   │   ├── errorMiddleware.js
│   │   ├── loggingMiddleware.js
│   │   └── rateLimitMiddleware.js
│   ├── routes/               # Route handlers
│   │   ├── pageRoutes.js     # HTML page routes
│   │   ├── agentApiRoutes.js # Agent API endpoints
│   │   ├── userApiRoutes.js  # User AJAX endpoints
│   │   └── emailApiRoutes.js # Email verification endpoints
│   ├── services/             # Business logic
│   │   ├── authService.js
│   │   ├── emailService.js
│   │   ├── archiveService.js
│   │   └── ttsService.js
│   ├── storage/              # File storage providers
│   │   ├── index.js
│   │   ├── StorageProvider.js
│   │   └── LocalStorageProvider.js
│   └── utils/                # Utility functions
│       ├── apiGuideGenerator.js
│       ├── archiveQueryWrapper.js
│       ├── encryptionHelper.js
│       ├── errorHandler.js
│       ├── logger.js
│       ├── redisClient.js
│       ├── securityLogger.js
│       └── validation.js
├── views/                    # EJS templates
│   ├── layout.ejs
│   ├── landing.ejs
│   ├── register.ejs
│   ├── login.ejs
│   ├── verify-email-sent.ejs
│   ├── verify-email-result.ejs
│   ├── dashboard.ejs
│   ├── settings.ejs
│   ├── archive.ejs
│   ├── demo.ejs
│   ├── terms.ejs
│   ├── privacy.ejs
│   ├── error.ejs
│   └── partials/
│       └── question.ejs
├── public/                   # Static files
│   ├── css/
│   ├── images/
│   ├── audio/
│   └── js/
│       ├── dashboard.js
│       ├── settings.js
│       ├── archive.js
│       ├── encryption.js
│       ├── notifications.js
│       ├── voice-control.js
│       ├── feedback.js
│       ├── marble-generator.js
│       ├── page-transitions.js
│       ├── setup-script.js
│       └── vendor/
└── tests/                    # Test suite
    ├── api/
    ├── middleware/
    ├── services/
    ├── utils/
    └── integration/
```

## API Documentation

### Authentication

All agent API endpoints require authentication via API key:
- Header: `X-API-Key: YOUR_API_KEY`

User API endpoints use session-based authentication.

### Agent API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agent/messages` | Send a message to the user |
| `POST` | `/api/agent/questions` | Send an interactive question |
| `GET` | `/api/agent/responses` | Poll for user responses |
| `GET` | `/api/agent/messages/history` | Get message history |
| `GET` | `/api/agent/messages/latest` | Get latest messages |
| `GET` | `/api/agent/config` | Get agent configuration |
| `PUT` | `/api/agent/config` | Update agent configuration |
| `POST` | `/api/agent/stop` | Signal agent stop |
| `POST` | `/api/agent/attachments` | Upload an attachment |
| `GET` | `/api/agent/attachments/:id` | Download an attachment |
| `GET` | `/api/agent/cli-script` | Get CLI setup script |

### User API Endpoints (Session-based)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/user/agents` | Get agent list |
| `PUT` | `/api/user/agents/positions` | Reorder agents |
| `DELETE` | `/api/user/agents/:agentId` | Delete an agent |
| `GET` | `/api/user/messages/:agentId` | Get messages for an agent |
| `POST` | `/api/user/messages` | Send a free-text reply |
| `POST` | `/api/user/responses` | Submit response to a question |
| `PUT` | `/api/user/messages/:messageId/hidden` | Hide/unhide a message |
| `DELETE` | `/api/user/messages/:messageId` | Delete a message |
| `DELETE` | `/api/user/agents/:agentId/messages` | Delete all messages for agent |
| `POST` | `/api/user/tts` | Generate TTS audio |
| `POST` | `/api/user/attachments` | Upload an attachment |
| `GET` | `/api/user/attachments/:id` | Download an attachment |
| `POST` | `/api/user/feedback` | Submit feedback |
| `POST` | `/api/user/agents/:agentId/archive` | Archive an agent |
| `DELETE` | `/api/user/agents/:agentId/archive` | Unarchive an agent |
| `GET` | `/api/user/archive/agents` | List archived agents |
| `GET` | `/api/user/archive/messages` | List archived messages |

### Email API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/email/verify-token` | Verify email via token |
| `POST` | `/api/email/verify-code` | Verify email via 6-digit code |
| `POST` | `/api/email/resend-verification` | Resend verification email |
| `GET` | `/api/email/verification-status` | Check verification status |
| `GET` | `/api/email/logs` | Get email logs (authenticated) |
| `GET` | `/api/email/stats` | Get email statistics |

### Page Routes

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Landing page |
| `GET` | `/register` | Registration page |
| `GET` | `/login` | Login page |
| `GET` | `/logout` | Logout |
| `GET` | `/dashboard` | User dashboard |
| `GET` | `/settings` | User settings |
| `GET` | `/archive` | Archived messages |
| `GET` | `/demo` | Demo page |
| `GET` | `/setup` | CLI installer script |
| `GET` | `/auth/google` | Google OAuth login |
| `GET` | `/terms` | Terms of service |
| `GET` | `/privacy` | Privacy policy |

## Security Features

- Password hashing with bcrypt
- Session-based authentication for users (Redis-backed)
- API key authentication for agents
- CSRF protection on forms
- Rate limiting on all endpoints (Redis-backed)
- User data isolation
- SQL injection prevention via parameterized queries
- Secure, httpOnly cookies
- Helmet.js security headers
- Email verification for new accounts
- Google OAuth integration

## Testing

Run the test suite:
```bash
npm test
```

Run with coverage:
```bash
npm run test:coverage
```

## Additional Documentation

See the `docs/` folder for detailed guides:
- [Archive Feature Guide](docs/ARCHIVE_USER_GUIDE.md)
- [Email Verification](docs/EMAIL_VERIFICATION.md)
- [Image Messaging](docs/IMAGE_MESSAGING.md)
- [Remote Deployment](docs/REMOTE_DEPLOYMENT_GUIDE.md)

## Development

The application uses:
- **Express.js** for the web server
- **EJS** for server-side templating
- **PostgreSQL** for data persistence
- **Redis** for session storage and rate limiting
- **Passport.js** for authentication (local + Google OAuth)
- **express-session** with connect-redis for session management
- **bcrypt** for password hashing
- **Tailwind CSS** for styling
- **Jest** for testing

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.


