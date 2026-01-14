/**
 * Database connection module using pg library
 * Provides connection pool for PostgreSQL database
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { logInfo, logError, logWarn } = require('../utils/logger');

// Create connection pool configuration
const poolConfig = {
  user: process.env.DB_USER || 'postgres',
  database: process.env.DB_NAME || 'agent_messaging',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

// For postgres user with peer authentication, use Unix socket
// For other users, use TCP with host/port/password
if (poolConfig.user === 'postgres' && !process.env.DB_PASSWORD) {
  // Use Unix socket with peer authentication
  poolConfig.host = '/var/run/postgresql';
  console.log('Using peer authentication via Unix socket for postgres user');
} else {
  // Use TCP connection with host and port
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;

  // Only add password if it's set
  if (process.env.DB_PASSWORD) {
    poolConfig.password = process.env.DB_PASSWORD;
  }
}

// Create connection pool
const pool = new Pool(poolConfig);

// Handle pool errors
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Execute a query with parameters
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logInfo('db.query', { durationMs: duration, rows: res.rowCount });
    return res;
  } catch (error) {
    const duration = Date.now() - start;
    logError('db.query_error', {
      error: error.message,
      code: error.code,
      detail: error.detail,
      durationMs: duration
    });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<Object>} Database client
 */
async function getClient() {
  try {
    const client = await pool.connect();
    const query = client.query;
    const release = client.release;

    // Set a timeout of 5 seconds, after which we will log this client's last query
    const timeout = setTimeout(() => {
      logWarn('db.client_long_checkout', { lastQuery: client.lastQuery });
    }, 5000);

    // Monkey patch the query method to keep track of the last query executed
    client.query = (...args) => {
      client.lastQuery = args;
      return query.apply(client, args);
    };

    client.release = () => {
      // Clear timeout
      clearTimeout(timeout);
      // Set the methods back to their old un-monkey-patched version
      client.query = query;
      client.release = release;
      return release.apply(client);
    };

    return client;
  } catch (error) {
    console.error('Failed to get database client from pool:', error);
    throw error;
  }
}

/**
 * Initialize database schema
 * Reads and executes the schema.sql file
 * @returns {Promise<void>}
 */
async function initializeSchema() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('Initializing database schema...');
    await query(schema);
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    throw error;
  }
}

/**
 * Test database connection
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
  try {
    const result = await query('SELECT NOW()');
    console.log('Database connection successful:', result.rows[0]);
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

/**
 * Close all connections in the pool
 * @returns {Promise<void>}
 */
async function closePool() {
  await pool.end();
  console.log('Database pool closed');
}

module.exports = {
  query,
  getClient,
  initializeSchema,
  testConnection,
  closePool,
  pool
};
