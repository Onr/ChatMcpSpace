# AI Agent Messaging Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org)

A web-based platform that enables bidirectional communication between users and their AI agents through a chat-like interface.

## Features

- **User Authentication**: Secure registration and login system
- **Agent Messaging**: AI agents can send messages to users via REST API
- **Free-text User Replies**: Users can respond with their own text and send it straight back to the agents
- **Real-time Updates**: Frontend polling for new messages and responses
- **API Key Management**: Each user gets a unique API key for their agents
- **Priority & Urgency**: Messages can be marked with priority levels and urgent flags
- **User Isolation**: Complete data isolation between users
- **Local Password Login**: Standard email/password authentication for local accounts
- **End-to-End Encryption**: Encrypted message content for users and agents
- **Voice Alerts & TTS**: Voice notifications and text-to-speech playback for messages

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
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

4. **Configure environment variables**
   
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and update the following variables:
   ```
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=agent_messaging_platform
   DB_USER=your_db_user
   DB_PASSWORD=your_db_password
   SESSION_SECRET=your_random_secret_key_here
   PORT=3000
   NODE_ENV=development
   BASE_URL=http://localhost:3000
   # Optional HTTPS (see section below)
   HTTPS_ENABLED=false
   HTTPS_PORT=3443
   HTTPS_KEY_PATH=./keys/localhost-key.pem
   HTTPS_CERT_PATH=./keys/localhost-cert.pem
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

2) Update `.env` (or the relevant env file):  
   ```
   HTTPS_ENABLED=true
   HTTPS_PORT=3443            # or 443 in production
   HTTPS_KEY_PATH=/path/to/privkey.pem
   HTTPS_CERT_PATH=/path/to/fullchain.pem
   # Optional:
   ENABLE_HTTP_REDIRECT=true  # start a lightweight HTTP -> HTTPS redirect
   HTTP_REDIRECT_PORT=3000    # set to 80/8080/etc. depending on your host
   ```

3) Start the server. It will listen on `HTTPS_PORT` and log `TLS: enabled (HTTPS)`.

Notes:
- Keep `BASE_URL` aligned with your HTTPS host so cookies and CORS match.
- For production, running behind a reverse proxy (nginx/traefik) is still fine; leave `HTTPS_ENABLED=false` if the proxy handles TLS.

## Usage

### For Users

1. **Register**: Visit `/register` to create a new account
2. **Login**: Visit `/login` to access your dashboard
3. **Dashboard**: View messages from your AI agents
4. **Settings**: Get your API key and integration guide at `/settings`

### For AI Agents

Use the REST API to send messages and questions:

**Send a Message:**
```bash
curl -X POST http://localhost:3000/api/agent/messages \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello from your AI agent!",
    "priority": "normal",
    "urgent": false,
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
    "priority": "high",
    "urgent": true,
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
├── src/
│   ├── db/                   # Database connection and schema
│   │   ├── connection.js
│   │   ├── schema.sql
│   │   └── init.js
│   ├── middleware/           # Express middleware
│   │   ├── authMiddleware.js
│   │   ├── csrfMiddleware.js
│   │   ├── errorMiddleware.js
│   │   └── rateLimitMiddleware.js
│   ├── routes/               # Route handlers
│   │   ├── pageRoutes.js     # HTML page routes
│   │   ├── agentApiRoutes.js # Agent API endpoints
│   │   └── userApiRoutes.js  # User AJAX endpoints
│   ├── services/             # Business logic
│   │   └── authService.js
│   └── utils/                # Utility functions
│       ├── apiGuideGenerator.js
│       ├── errorHandler.js
│       ├── securityLogger.js
│       └── validation.js
├── views/                    # EJS templates
│   ├── layout.ejs
│   ├── register.ejs
│   ├── login.ejs
│   ├── dashboard.ejs
│   ├── settings.ejs
│   └── error.ejs
└── public/                   # Static files
    └── js/
        └── dashboard.js      # Frontend JavaScript

```

## API Documentation

### Authentication

All agent API endpoints require authentication via API key:
- Header: `X-API-Key: YOUR_API_KEY`

### Endpoints

#### Agent API

- `POST /api/agent/messages` - Send a message
- `POST /api/agent/questions` - Send an interactive question
- `GET /api/agent/responses` - Poll for user responses

#### User API (Session-based)

- `GET /api/user/agents` - Get agent list
- `GET /api/user/messages/:agentId` - Get messages for an agent
- `POST /api/user/messages` - Send a free-text reply to an agent
- `POST /api/user/responses` - Submit response to a question

#### Sending Free-text Replies

Users can now push custom text directly to an agent by `POST`ing to `/api/user/messages` with `agentId` and `content`; the response includes the stored `messageId` and recorded `timestamp`, and the agent will see the message the next time it polls `/api/agent/responses`.

## Security Features

- Password hashing with bcrypt
- Session-based authentication for users
- API key authentication for agents
- CSRF protection on forms
- Rate limiting on all endpoints
- User data isolation
- SQL injection prevention via parameterized queries
- Secure, httpOnly cookies

## Development

The application uses:
- **Express.js** for the web server
- **EJS** for server-side templating
- **PostgreSQL** for data persistence
- **express-session** for session management
- **bcrypt** for password hashing
- **Tailwind CSS** for styling

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
