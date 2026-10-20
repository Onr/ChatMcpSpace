/**
 * Main Server Entry Point
 * AI Agent Messaging Platform
 */

// Load environment variables
require('dotenv').config();

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { testConnection } = require('./src/db/connection');
const { ensureEncryptionColumns } = require('./src/db/migrations/encryptionColumns');
const { ensureLastSeenAtColumn } = require('./src/db/migrations/lastSeenAt');
const { runAllMigrations, ensureArchiveTables } = require('./src/db/runMigrations');
const { startScheduledMessageDelivery } = require('./src/services/scheduledMessageService');
const { globalErrorHandler, notFoundHandler } = require('./src/middleware/errorMiddleware');
const RedisStore = require('connect-redis').default || require('connect-redis');
const { sessionRedisClient } = require('./src/utils/redisClient');
const { requestLogger } = require('./src/middleware/loggingMiddleware');
const { csrfProtection, validateCsrfToken } = require('./src/middleware/csrfMiddleware');
const { safeJsonForScript } = require('./src/utils/safeJsonHelper');
const { assetUrl } = require('./src/utils/assetUrl');
const { isLocalAuthMode, isLocalModeRequested, isGoogleAuthConfigured } = require('./src/utils/localMode');

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
const mcpRoutes = require('./src/routes/mcpRoutes');
const agentApiRoutes = require('./src/routes/agentApiRoutes');
const userApiRoutes = require('./src/routes/userApiRoutes');
const emailApiRoutes = require('./src/routes/emailApiRoutes');
const guestRoutes = require('./src/shared/guestRoutes');
const { isPublicHttpsConfigured } = require('./src/utils/publicHttps');

// Create Express app
const app = express();
// Templates stamp local CSS/JS URLs with the file's mtime (see assetUrl.js).
app.locals.assetUrl = assetUrl;

// Get port from environment or use default
const PORT = parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || PORT, 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const HTTPS_ENABLED = String(process.env.HTTPS_ENABLED || '').toLowerCase() === 'true';
const ENABLE_HTTP_REDIRECT = String(process.env.ENABLE_HTTP_REDIRECT || '').toLowerCase() === 'true';
const PUBLIC_HTTPS_ENABLED = isPublicHttpsConfigured({
  httpsEnabled: HTTPS_ENABLED,
  baseUrl: process.env.BASE_URL
});

// Trust reverse proxy for secure cookies / HTTPS detection
app.set('trust proxy', 1);

// Security headers via helmet with CSP tuned to known assets
const allowedOrigins = [
  process.env.BASE_URL,
  'https://chatmcp.space',
  'https://staging.chatmcp.space'
].filter(Boolean);

// Per-request CSP nonce: every inline <script> in the views carries
// nonce="<%= cspNonce %>" so script-src can drop 'unsafe-inline'.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Build CSP directives - only upgrade insecure requests when HTTPS is enabled
// script-src: no 'unsafe-inline'/'unsafe-eval' — inline scripts must carry the
// request nonce (verified headless: the Tailwind Play CDN compiles fine
// without eval).
// script-src-attr 'unsafe-inline' remains for legacy onclick= attributes in a
// few views (landing, settings, layout, verify-email-sent); remove it after
// those are converted to addEventListener.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    (req, res) => `'nonce-${res.locals.cspNonce}'`,
    "https://cdn.tailwindcss.com"
  ],
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "https://r2cdn.perplexity.ai"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", ...allowedOrigins],
  mediaSrc: ["'self'", 'blob:'],
  frameSrc: ["'self'", "https://www.youtube.com", "https://youtube.com", "https://www.youtube-nocookie.com"],
  childSrc: ["'self'", "https://www.youtube.com", "https://youtube.com", "https://www.youtube-nocookie.com"],
  objectSrc: ["'none'"],
  workerSrc: ["'self'", "blob:"],
  frameAncestors: ["'self'"],
};

// Only upgrade insecure requests when HTTPS is enabled (not for HTTP dev mode)
if (PUBLIC_HTTPS_ENABLED) {
  cspDirectives.upgradeInsecureRequests = [];
} else if (IS_PROD) {
  // Security warning: production should use HTTPS directly or at its public reverse proxy.
  console.warn('⚠️  WARNING: Running in production mode without HTTPS. This is a security risk!');
  console.warn('   Configure an https:// BASE_URL behind a TLS reverse proxy, or enable direct HTTPS.');
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: cspDirectives
  },
  // Disable HSTS only when the public deployment is not using HTTPS.
  // on HTTP-only dev servers (especially when accessed via IP instead of localhost)
  strictTransportSecurity: PUBLIC_HTTPS_ENABLED ? undefined : false,
}));

// Explicit CORS allowlist for API routes (same-origin only)
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, false); // block null-origin requests (same-origin requests bypass CORS entirely)
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

// Compress responses (gzip/deflate). Respects the standard
// `x-no-compression` request header for clients that need raw bodies.
app.use(compression());

// Configure Express middleware
app.use(requestLogger);
// Parse JSON request bodies with explicit size limits
app.use(express.json({ limit: '2mb' }));

// Parse URL-encoded request bodies (for form submissions)
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve static files from public directory.
// In production, cache for 1 day and rely on etag for revalidation. Critical
// scripts (dashboard.js, multi-chat.js, rich-rendering.js) and the main
// stylesheet bust the cache via ?v=Date.now() on every page load, so they
// pick up new versions immediately.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PROD ? '1d' : 0,
  etag: true,
  lastModified: true,
}));

// Configure session middleware
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required');
}
const sessionOptions = {
  store: undefined,
  secret: process.env.SESSION_SECRET,
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
  // Helper for embedding JSON in inline <script> tags safely (see audit T11).
  res.locals.safeJsonForScript = safeJsonForScript;
  // Google sign-in buttons only work when OAuth credentials are configured;
  // a local install without them should not render a dead button.
  res.locals.googleAuthEnabled = isGoogleAuthConfigured();
  res.locals.localAuthMode = isLocalAuthMode();
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

// Cache compiled EJS templates in production (recompiling every request
// is wasteful when templates are immutable for the lifetime of the process).
if (IS_PROD) {
  app.enable('view cache');
}

// Mount route handlers
// OAuth discovery, consent, token, and MCP protocol endpoints. This must run
// after session initialization and before page routes can render fallbacks.
app.use('/', mcpRoutes);

// Page routes (HTML rendering)
app.get('/guest', (req, res) => {
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true' || process.env.FEATURE_GUEST_SHARING !== 'true') {
    return res.status(404).send('Not found');
  }
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  res.render('guest-shared', { layout: false });
});
app.use('/', pageRoutes);

// Agent API routes (RESTful API for AI agents)
app.use('/api/agent', agentApiRoutes);

// Guest routes use a dedicated opaque cookie and never establish account
// identity on req.user or req.session.userId.
app.use('/api/guest', guestRoutes);

// User API routes (AJAX endpoints for frontend). These use browser sessions,
// so state-changing requests must carry the page CSRF token.
app.use('/api/user', csrfProtection, validateCsrfToken, userApiRoutes);

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
  const tlsStatus = tlsEnabled
    ? 'enabled directly (HTTPS)'
    : PUBLIC_HTTPS_ENABLED
      ? 'enabled at reverse proxy (HTTPS public URL)'
      : 'disabled (HTTP only)';
  console.log(`TLS: ${tlsStatus}`);

  if (isLocalAuthMode()) {
    console.log('='.repeat(60));
    console.log('LOCAL MODE is ON (LOCAL_MODE=true)');
    console.log('  - Register with any email + password; no verification email.');
    console.log('  - New accounts are signed in immediately.');
    console.log('  ! Anyone who can reach this server can create an account.');
    console.log('  ! Do not use this on a public or internet-facing deployment.');
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl)) {
      console.warn(`  ! BASE_URL is ${baseUrl}, which does not look local.`);
    }
  } else if (isLocalModeRequested()) {
    console.warn('='.repeat(60));
    console.warn('LOCAL MODE was requested but is IGNORED under NODE_ENV=production.');
  }

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
      const message = 'Database migrations failed; refusing to start with a partially updated schema.';
      if (process.env.NODE_ENV === 'production' || process.env.MIGRATION_STRICT === 'true') {
        throw new Error(message);
      }
      console.warn(`⚠ ${message}`);
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

    startScheduledMessageDelivery();
    require('./src/services/modelRefreshService').startModelRefresh();

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
