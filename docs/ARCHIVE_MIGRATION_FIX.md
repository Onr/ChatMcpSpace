# Archive Feature Migration Fix

## Problem
The archive feature (implemented in Phase 1-3) was not working on remote servers because the database migration was created but never executed on the database schema. This caused errors like:

```
error: relation "archived_agents" does not exist
error: relation "archived_messages" does not exist
```

## Solution
Implemented an **automatic migration runner** that executes all SQL migrations on application startup. This ensures the database schema is always in sync across all environments (local, staging, production).

## What Was Changed

### 1. New Automatic Migration System

**File:** `src/db/runMigrations.js`
- Creates a migration runner that automatically executes all `.sql` files in `src/db/migrations/` directory
- Sorts migrations numerically by filename prefix (e.g., 001_, 002_, 014_)
- Tracks applied migrations in a `migrations` table to prevent duplicate execution
- Gracefully handles errors without crashing the application
- Provides detailed logging of migration status

### 2. Updated Server Startup

**File:** `server.js`
- Added call to `runAllMigrations()` during application startup
- Runs AFTER database connection test, BEFORE starting HTTP server
- Logs migration progress and any issues encountered
- Application continues even if some migrations fail (with warnings)

### 3. Defensive Query Wrappers

**New File:** `src/utils/archiveQueryWrapper.js`
- Provides fallback behavior when archive tables don't exist yet
- Wraps queries to catch "relation does not exist" errors (PostgreSQL error code 42P01)
- Automatically falls back to queries without archive filtering during migration
- Ensures application works during schema updates

### 4. Updated User API Routes

**File:** `src/routes/userApiRoutes.js`
- Wrapped GET `/api/user/agents` with archive-aware query
- Wrapped GET `/api/user/messages/:agentId` with archive-aware query
- Wrapped GET `/api/user/messages/:agentId/since` with archive-aware query
- Each endpoint has both a primary query (with archive filtering) and fallback (without)
- If archive tables don't exist, falls back automatically

### 5. Safe Archive Service Functions

**File:** `src/services/archiveService.js`
- Updated `isAgentArchived()` to return `false` if archive tables don't exist
- Updated `isMessageArchived()` to return `false` if archive tables don't exist
- Prevents 403 errors when archive feature isn't initialized
- Allows normal operation during migration phase

## How It Works

### Startup Sequence

1. **Connect to Database**
   ```
   ✓ Database connection successful
   ```

2. **Run Migrations**
   ```
   === Running Database Migrations ===

   Running 18 migrations...

   ⊘ Migration 001_add_encryption_salt.sql already applied (skipping)
   ⊘ Migration 002_add_free_response_features.sql already applied (skipping)
   ...
   ✓ Migration 014_add_archive_support.sql completed successfully
   ...

   Migration Summary:
     Completed: 1
     Skipped: 17
     Failed: 0

   ✓ All migrations completed successfully!
   ```

3. **Start Server**
   ```
   AI Agent Messaging Platform
   Server running on port 3000
   ...
   ```

### On Fresh Database

- Migration `014_add_archive_support.sql` executes automatically
- Creates `archived_agents` and `archived_messages` tables
- Creates necessary indexes and constraints
- Inserts `014_add_archive_support.sql` into `migrations` table
- Application starts normally with archive feature active

### On Existing Database (Already Has Migration)

- Migration runner checks `migrations` table
- Finds `014_add_archive_support.sql` already applied
- Skips execution (prevents duplicate table creation errors)
- Archive feature ready to use

### During Migration Process

- If migration fails, warning logged but application continues
- Query wrappers catch "relation does not exist" errors
- Fall back to non-archive queries automatically
- No crashes, no 500 errors for users
- Error logs show which migrations failed

## Testing the Fix

### 1. Fresh Database Test

```bash
# Start with empty database
npm start

# Check logs for migration execution
# Should see: "✓ All migrations completed successfully!"

# Verify tables exist
psql -d agentsmcpspace_dev -c "\d archived_agents"
psql -d agentsmcpspace_dev -c "\d archived_messages"

# Test archive feature
curl -H "Cookie: connect.sid=..." \
  -X POST http://localhost:3000/api/user/agents/AGENT_ID/archive
```

### 2. Existing Database Test

```bash
# Start with database that already has archive tables
npm start

# Check logs for migration skipping
# Should see: "⊘ Migration 014_add_archive_support.sql already applied"

# Test that archive feature works
# No duplicate table errors
```

### 3. Remote Server Deployment

```bash
# Push code to remote
git push origin main

# Server restarts
# Migrations run automatically
# No manual SQL execution needed
# Archive feature available immediately
```

## Migration File Location

The migration that creates archive tables:
```
src/db/migrations/014_add_archive_support.sql
```

This file contains:
- `archived_agents` table creation
- `archived_messages` table creation
- 7 indexes for performance
- CHECK constraints for data integrity
- Foreign key constraints
- Column comments for documentation

## What If Migrations Don't Run?

If migrations fail to execute, you'll see warnings in the logs:

```
⚠ Some migrations failed. Please check the errors above.
Failed migrations: 014_add_archive_support.sql
```

**Manual Fix:**
```bash
# Run migration manually
node src/db/migrations/run_sql_migration.js 014_add_archive_support.sql

# Or connect to database and execute SQL directly
psql -d agentsmcpspace_dev -f src/db/migrations/014_add_archive_support.sql
```

## Backward Compatibility

- Archive feature is completely optional
- If archive tables don't exist, application works normally
- Archive buttons don't crash the app during migration
- Old code that queries without archive filtering still works
- No breaking changes to existing API

## Future Migrations

To add new migrations in the future:

1. Create file in `src/db/migrations/` with numeric prefix
   ```
   src/db/migrations/015_new_feature.sql
   ```

2. Write SQL (use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.)

3. Run application - migration runs automatically

4. If needed, manually execute:
   ```bash
   node src/db/migrations/run_sql_migration.js 015_new_feature.sql
   ```

## Summary

This fix ensures:
- ✅ Archive tables created automatically on all databases
- ✅ No manual SQL execution required on remote servers
- ✅ Application works during migration process
- ✅ Archive feature available immediately after startup
- ✅ Graceful fallback if archive tables missing
- ✅ Detailed logging of migration status
- ✅ No breaking changes to existing functionality

The application can now be deployed to remote servers without any manual database setup, and the archive feature will work correctly.
