/**
 * Database initialization script
 * Run this script to initialize the database schema
 * Usage: node src/db/init.js
 */

require('dotenv').config();
const { initializeSchema, testConnection, closePool } = require('./connection');

async function init() {
  console.log('Starting database initialization...');
  console.log('Database configuration:');
  console.log(`  Host: ${process.env.DB_HOST || 'localhost'}`);
  console.log(`  Port: ${process.env.DB_PORT || 5432}`);
  console.log(`  Database: ${process.env.DB_NAME || 'agent_messaging'}`);
  console.log(`  User: ${process.env.DB_USER || 'postgres'}`);
  console.log('');
  
  try {
    // Test connection first
    const connected = await testConnection();
    if (!connected) {
      console.error('Failed to connect to database. Please check your configuration.');
      process.exit(1);
    }
    
    // Initialize schema
    await initializeSchema();
    
    console.log('');
    console.log('Database initialization completed successfully!');
    
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run initialization
init();
