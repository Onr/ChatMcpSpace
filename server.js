/**
 * Main Server Entry Point
 * AI Agent Messaging Platform
 */

// Load environment variables
require('dotenv').config();

const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { testConnection } = require('./src/db/connection');
const { ensureEncryptionColumns } = require('./src/db/migrations/encryptionColumns');
const { ensureLastSeenAtColumn } = require('./src/db/migrations/lastSeenAt');
const { runAllMigrations, ensureArchiveTables } = require('./src/db/runMigrations');
const { globalErrorHandler, notFoundHandler } = require('./src/middleware/errorMiddleware');
const RedisStore = require('connect-redis').default || require('connect-redis');
const { sessionRedisClient } = require('./src/utils/redisClient');
const { requestLogger } = require('./src/middleware/loggingMiddleware');

// Check for Google Cloud Service Account Key
const serviceAccountPath = path.join(__dirname, 'keys', 'service-account.json');
if (fs.existsSync(serviceAccountPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  console.log('TTS Service: Service account key found and configured.');
} else {
  console.log('TTS Service: No service account key found. Server-side TTS will be disabled.');
}

// Import route handlers
const pageRoutes = require('./src/routes/pageRoutes');
const agentApiRoutes = require('./src/routes/agentApiRoutes');
const userApiRoutes = require('./src/routes/userApiRoutes');
const emailApiRoutes = require('./src/routes/emailApiRoutes');

// Create Express app
const app = express();

// Get port from environment or use default
const PORT = parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || PORT, 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const HTTPS_ENABLED = String(process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
const ENABLE_HTTP_REDIRECT = String(process.env.ENABLE_HTTP_REDIRECT || '').toLowerCase() === 'true';

// Trust reverse proxy for secure cookies / HTTPS detection
app.set('trust proxy', 1);

// Security headers via helmet with CSP tuned to known assets
const allowedOrigins = [
  process.env.BASE_URL,
  'https://chatmcp.space',
  'https://staging.chatmcp.space'
].filter(Boolean);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://r2cdn.perplexity.ai"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ...allowedOrigins],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://youtube.com"],
      childSrc: ["'self'", "https://www.youtube.com", "https://youtube.com"],
      objectSrc: ["'none'"],
      workerSrc: ["'self'", "blob:"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: [],
    }
  },
}));

// Explicit CORS allowlist for API routes (same-origin only)
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow same-origin / curl
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
};
app.use('/api', cors(corsOptions));
app.use('/api', (err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Request origin is not permitted'
      }
    });
  }
  next(err);
});

// Configure Express middleware
app.use(requestLogger);
// Parse JSON request bodies with explicit size limits
app.use(express.json({ limit: '2mb' }));

// Parse URL-encoded request bodies (for form submissions)
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure session middleware
const sessionOptions = {
  store: undefined,
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PROD, // Use secure cookies in production (HTTPS)
    httpOnly: true, // Prevent client-side JavaScript access to cookies
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
};

try {
  if (sessionRedisClient) {
    sessionOptions.store = new RedisStore({
      client: sessionRedisClient,
      prefix: 'sess:',
    });
  } else {
    console.warn('Redis client not initialized; falling back to in-memory session store (not recommended for production).');
  }
} catch (error) {
  console.error('Failed to configure Redis session store:', error.message);
  console.warn('Falling back to in-memory session store (not recommended for production).');
}

app.use(session(sessionOptions));

// Initialize Passport for Google OAuth
const passport = require('./src/config/passport');
app.use(passport.initialize());
app.use(passport.session());

// Expose session user to all templates so layout can render navigation
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  if (req.session && req.session.userId) {
    res.locals.user = {
      userId: req.session.userId,
      email: req.session.email
    };
  } else {
    res.locals.user = null;
  }
  next();
});

// Set up EJS as view engine with layout support
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Mount route handlers
// Page routes (HTML rendering)
app.use('/', pageRoutes);

// Agent API routes (RESTful API for AI agents)
app.use('/api/agent', agentApiRoutes);

// User API routes (AJAX endpoints for frontend)
app.use('/api/user', userApiRoutes);

// Email API routes (verification and logs)
app.use('/api/email', emailApiRoutes);

// 404 Not Found handler (must be after all routes)
app.use(notFoundHandler);

// Global error handling middleware (must be last)
app.use(globalErrorHandler);

function loadTlsConfig() {
  if (!HTTPS_ENABLED) {
    return null;
  }

  if (!process.env.HTTPS_KEY_PATH || !process.env.HTTPS_CERT_PATH) {
    console.error('HTTPS_ENABLED is true but HTTPS_KEY_PATH or HTTPS_CERT_PATH is not set.');
    process.exit(1);
  }

  try {
    const tlsConfig = {
      key: fs.readFileSync(process.env.HTTPS_KEY_PATH),
      cert: fs.readFileSync(process.env.HTTPS_CERT_PATH),
    };

    if (process.env.HTTPS_CA_PATH) {
      tlsConfig.ca = fs.readFileSync(process.env.HTTPS_CA_PATH);
    }

    if (process.env.HTTPS_PASSPHRASE) {
      tlsConfig.passphrase = process.env.HTTPS_PASSPHRASE;
    }

    return tlsConfig;
  } catch (error) {
    console.error('Failed to read TLS key/cert files:', error.message);
    process.exit(1);
  }
}

function startHttpRedirectServer(targetPort) {
  if (!ENABLE_HTTP_REDIRECT) {
    return;
  }

  const redirectPort = parseInt(process.env.HTTP_REDIRECT_PORT || PORT, 10);

  if (redirectPort === targetPort) {
    console.warn('ENABLE_HTTP_REDIRECT is true but redirect port matches HTTPS port; skipping redirect listener.');
    return;
  }

  const redirectServer = http.createServer((req, res) => {
    const hostHeader = req.headers.host || 'localhost';
    const hostWithoutPort = hostHeader.replace(/:\d+$/, '');
    const location = `https://${hostWithoutPort}${targetPort === 443 ? '' : `:${targetPort}`}${req.url}`;
    res.writeHead(301, { Location: location });
    res.end();
  });

  redirectServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(
        `HTTP redirect server port ${redirectPort} already in use; skipping the redirect listener.`
      );
      return;
    }
    console.error('HTTP redirect server error:', error);
  });

  redirectServer.listen(redirectPort, () => {
    console.log(`HTTP redirect server listening on port ${redirectPort} and redirecting to HTTPS port ${targetPort}`);
  });
}

function logStartup({ port, scheme, tlsEnabled }) {
  const defaultHost = `${scheme}://localhost${[80, 443].includes(port) ? '' : `:${port}`}`;
  const baseUrl = process.env.BASE_URL || defaultHost;

  console.log('='.repeat(60));
  console.log('AI Agent Messaging Platform');
  console.log('='.repeat(60));
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Server running on port ${port}`);
  console.log(`URL: ${baseUrl}`);
  console.log(`TLS: ${tlsEnabled ? 'enabled (HTTPS)' : 'disabled (HTTP only)'}`);
  console.log('='.repeat(60));
  console.log('Available routes:');
  console.log('  - GET  /register          - User registration page');
  console.log('  - GET  /login             - User login page');
  console.log('  - GET  /dashboard         - Main dashboard');
  console.log('  - GET  /settings          - Account settings');
  console.log('  - POST /api/agent/messages   - Send message (API)');
  console.log('  - POST /api/agent/questions  - Send question (API)');
  console.log('  - GET  /api/agent/responses  - Poll responses (API)');
  console.log('='.repeat(60));
}

// Start server
async function startServer() {
  try {
    // Test database connection
    console.log('Testing database connection...');
    const dbConnected = await testConnection();

    if (!dbConnected) {
      console.error('Failed to connect to database. Please check your database configuration.');
      console.error('Make sure PostgreSQL is running and the credentials in .env are correct.');
      process.exit(1);
    }

    console.log('\n=== Running Database Migrations ===\n');

    // Run all SQL migrations from the migrations directory
    const migrationsSuccess = await runAllMigrations();
    if (!migrationsSuccess) {
      console.warn('⚠ Some migrations encountered issues. The application may not work correctly.');
    }

    console.log('Ensuring encrypted column migration has been applied...');
    const encryptionSchemaUpdated = await ensureEncryptionColumns();
    if (encryptionSchemaUpdated) {
      console.log('Database schema updated: encrypted columns added.');
    } else {
      console.log('Database schema already includes encrypted columns.');
    }

    console.log('Ensuring last_seen_at column migration has been applied...');
    const lastSeenSchemaUpdated = await ensureLastSeenAtColumn();
    if (lastSeenSchemaUpdated) {
      console.log('Database schema updated: last_seen_at column added.');
    } else {
      console.log('Database schema already includes last_seen_at column.');
    }

    console.log('Verifying archive tables...');
    const archiveTablesExist = await ensureArchiveTables();
    if (archiveTablesExist) {
      console.log('✓ Archive tables verified and ready.');
    } else {
      console.log('Archive tables will be created by migrations.');
    }

    const tlsConfig = loadTlsConfig();
    const useHttps = Boolean(tlsConfig);
    const listenPort = useHttps ? HTTPS_PORT : PORT;
    const scheme = useHttps ? 'https' : 'http';

    if (useHttps) {
      https.createServer(tlsConfig, app).listen(listenPort, () => {
        logStartup({ port: listenPort, scheme, tlsEnabled: true });
      });
      startHttpRedirectServer(listenPort);
    } else {
      app.listen(listenPort, () => {
        logStartup({ port: listenPort, scheme, tlsEnabled: false });
      });
    }

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

// Start the server only if this script is run directly
if (require.main === module) {
  startServer();
}

module.exports = app;
