# Remote Server Deployment Guide - Archive Feature Fix

## Overview

This guide explains the fix for the archive feature not working on remote servers. The issue was that migrations weren't automatically running, leaving the database schema incomplete.

## The Problem

When the archive feature was first deployed to a remote server, users saw errors:

```
error: relation "archived_agents" does not exist (code 42P01)
error: relation "archived_messages" does not exist (code 42P01)
```

**Root Cause:** The migration file `014_add_archive_support.sql` existed in the codebase but was never executed against the remote database.

## The Solution

We implemented an **automatic migration system** that:
1. Runs ALL SQL migrations on application startup
2. Tracks which migrations have been applied
3. Prevents duplicate execution
4. Gracefully handles failures
5. Allows the app to continue during schema updates

## Files Changed

### New Files Created
1. **`src/db/runMigrations.js`** - Automatic migration runner
   - Discovers migration files in `src/db/migrations/`
   - Executes in numeric order (001_, 002_, 014_, etc.)
   - Tracks executed migrations in database
   - Comprehensive error logging

2. **`src/utils/archiveQueryWrapper.js`** - Query fallback system
   - Catches "relation does not exist" errors
   - Falls back to queries without archive filtering
   - Ensures app works during migration

### Modified Files
1. **`server.js`** - Added migration runner to startup
   - Imports `runAllMigrations` and `ensureArchiveTables`
   - Runs migrations after database connection test
   - Provides progress logging

2. **`src/routes/userApiRoutes.js`** - Defensive query wrapping
   - GET `/api/user/agents` - uses fallback if archive tables missing
   - GET `/api/user/messages/:agentId` - uses fallback
   - GET `/api/user/messages/:agentId/since` - uses fallback

3. **`src/services/archiveService.js`** - Safe archive checks
   - `isAgentArchived()` - returns false if tables don't exist
   - `isMessageArchived()` - returns false if tables don't exist

## How Deployment Works Now

### Step 1: Push Code to Remote
```bash
git push origin main
```

### Step 2: Server Restarts
When the server restarts:

```
Testing database connection...
✓ Database connection successful

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

Ensuring encrypted column migration has been applied...
Database schema already includes encrypted columns.

Verifying archive tables...
✓ Archive tables verified and ready.

=== Server Started ===
AI Agent Messaging Platform
Environment: production
Server running on port 3000
URL: https://yourdomain.com
TLS: enabled (HTTPS)
```

### Step 3: Archive Feature Works
- Tables are created automatically
- Archive buttons work
- No manual SQL execution needed
- Users don't see any errors

## Migration Execution Order

Migrations run in numeric order based on filename prefix:

```
001_add_encryption_salt.sql
002_add_free_response_features.sql
003_add_read_tracking.sql
...
013_add_feedback_table.sql
014_add_archive_support.sql ← Archive feature
```

## What About Existing Servers?

### Already Has Archive Tables?
If the archive tables already exist on your server:
- Migration runner checks `migrations` table
- Finds `014_add_archive_support.sql` already applied
- Skips execution (no duplicate table errors)
- Everything works normally

### Partially Applied Migration?
If something went wrong:
- Application logs all migration errors
- Provides option to manually re-run migrations
- Falls back to non-archive queries
- No application crashes

## Recovery - Manual Migration

If migrations don't run automatically for some reason:

```bash
# SSH into your server
ssh user@yourserver.com

# Navigate to app directory
cd /path/to/agentsMCPspace

# Run migration manually
node src/db/migrations/run_sql_migration.js 014_add_archive_support.sql

# Or execute SQL directly
psql -d agentsmcpspace_prod -f src/db/migrations/014_add_archive_support.sql
```

## Monitoring Deployment

### Check Logs
```bash
# Watch application logs for migration output
docker logs -f container-name

# Or check application logs file
tail -f /var/log/application/app.log
```

### Verify Tables Exist
```bash
# Connect to database
psql -d agentsmcpspace_prod -U postgres

# Verify archive tables
\d archived_agents
\d archived_messages

# Verify migration tracking
SELECT * FROM migrations WHERE migration_name LIKE '%archive%';
```

## Rollback (If Needed)

If archive tables cause issues, you can temporarily disable archive feature:

1. Archive queries already have fallback logic
2. If archive tables deleted, app automatically falls back
3. No code changes needed for graceful degradation

```sql
-- Temporarily drop archive tables
DROP TABLE IF EXISTS archived_messages CASCADE;
DROP TABLE IF EXISTS archived_agents CASCADE;

-- Remove from migrations tracking
DELETE FROM migrations WHERE migration_name = '014_add_archive_support.sql';

-- Application will fall back to non-archive queries automatically
```

## Environment-Specific Notes

### Development
- Migrations run on each `npm start`
- Great for testing schema changes

### Staging
- Migrations run on deployment
- Test archive feature before production
- Verify with full dataset

### Production
- Migrations run on deployment
- Monitor logs carefully first time
- No manual SQL needed
- Automatic backups recommended before deployment

## Troubleshooting

### "Table already exists" Error
- Normal on existing databases
- App handles this gracefully with `CREATE TABLE IF NOT EXISTS`

### "Permission denied" Error
- Database user needs permission to create tables
- Verify user has CREATE, ALTER privileges
- Contact database administrator

### Archive Feature Not Working After Deployment
1. Check application logs for migration errors
2. Verify tables exist: `\d archived_agents`
3. Verify migration was tracked: `SELECT * FROM migrations WHERE migration_name = '014_add_archive_support.sql'`
4. If not found, run manual migration
5. Restart application

### Queries Timing Out
- Migrations create indexes for performance
- First execution may take 10-30 seconds
- Normal for large databases
- Doesn't block application startup

## Performance Impact

### Schema Creation
- Initial migration: ~5-10 seconds for typical database
- Subsequent startups: <1 second (skipped)
- No impact on application performance

### Query Performance
- Archive filtering adds minimal overhead
- Only applies WHERE clauses
- Indexes created for fast queries
- No N+1 query issues

## Testing the Fix

### Test 1: Fresh Database
```bash
# Start with empty database
npm start
# Expect: All migrations execute
```

### Test 2: Existing Database
```bash
# Start with database that already has tables
npm start
# Expect: Migrations skipped
```

### Test 3: Archive Feature
```bash
# Test archive buttons in dashboard
# Test archive API endpoints
# Test archive page
# Expect: Everything works
```

## Future Migrations

To add new migrations:

1. Create file: `src/db/migrations/015_your_migration.sql`
2. Write SQL using `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`
3. Deploy code
4. On restart, migration runs automatically
5. No manual execution needed

## Summary

The fix ensures:
- ✅ Archive tables created automatically on all servers
- ✅ No manual SQL execution required
- ✅ Graceful fallback if tables missing
- ✅ Proper error handling and logging
- ✅ No breaking changes
- ✅ Easy recovery if needed

**Result:** Archive feature now works seamlessly on remote servers without any manual database setup.
