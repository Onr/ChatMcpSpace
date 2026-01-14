# Database Module

This directory contains the database schema and connection management for the AI Agent Messaging Platform.

## Files

- `schema.sql` - Complete database schema with all tables, indexes, and constraints
- `connection.js` - Database connection pool and query utilities
- `init.js` - Database initialization script

## Setup

### Prerequisites

1. PostgreSQL 14+ installed and running
2. Create a database for the application:
   ```bash
   createdb agent_messaging
   ```

### Environment Variables

Create a `.env` file in the project root with the following variables:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=agent_messaging
DB_USER=postgres
DB_PASSWORD=your_password_here
```

### Initialize Database

Run the initialization script to create all tables and indexes:

```bash
node src/db/init.js
```

This will:
1. Test the database connection
2. Drop existing tables (if any)
3. Create all tables with proper constraints
4. Create performance indexes

## Database Schema

### Tables

1. **users** - User accounts with authentication credentials
2. **agents** - AI agents associated with users
3. **messages** - Messages and questions sent by agents
4. **question_options** - Multiple choice options for interactive questions
5. **user_responses** - User selections for interactive questions
6. **user_messages** - Free-text replies sent by users that agents can read during response polling

### Key Features

- **Foreign Key Constraints**: All relationships use foreign keys with CASCADE delete
- **Unique Constraints**: Prevent duplicate emails, API keys, and agent names per user
- **Check Constraints**: Validate message types and priority levels
- **Indexes**: Optimized for common query patterns (user lookups, message retrieval, polling)

## Usage

### Query Execution

```javascript
const db = require('./db/connection');

// Simple query
const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);

// Transaction
const client = await db.getClient();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO users ...');
  await client.query('INSERT INTO agents ...');
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

### Connection Pool

The module uses a connection pool with:
- Maximum 20 concurrent connections
- 30 second idle timeout
- 2 second connection timeout
- Automatic error handling and logging

## Maintenance

### Reset Database

To reset the database (WARNING: deletes all data):

```bash
node src/db/init.js
```

### Manual Schema Updates

If you need to manually run the schema:

```bash
psql -d agent_messaging -f src/db/schema.sql
```
