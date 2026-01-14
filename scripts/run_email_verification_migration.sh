#!/bin/bash
# Run Email Verification Migration
# This script applies the email verification schema to the database

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MIGRATION_FILE="$PROJECT_ROOT/src/db/migrations/add_email_verification.sql"

# Load environment variables
if [ -f "$PROJECT_ROOT/.env" ]; then
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | xargs)
fi

# Default database settings
DB_NAME="${DB_NAME:-agent_messaging}"
DB_USER="${DB_USER:-postgres}"
DB_HOST="${DB_HOST:-/var/run/postgresql}"

echo "=========================================="
echo "Email Verification Migration"
echo "=========================================="
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo ""

# Check if migration file exists
if [ ! -f "$MIGRATION_FILE" ]; then
  echo "Error: Migration file not found at $MIGRATION_FILE"
  exit 1
fi

echo "Applying migration..."

# Run the migration
if [ "$DB_USER" = "postgres" ] && [ -z "$DB_PASSWORD" ]; then
  # Use peer authentication via Unix socket
  psql -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATION_FILE"
else
  # Use TCP with password
  PGPASSWORD="$DB_PASSWORD" psql -h "${DB_HOST:-localhost}" -U "$DB_USER" -d "$DB_NAME" -f "$MIGRATION_FILE"
fi

echo ""
echo "=========================================="
echo "Migration completed successfully!"
echo "=========================================="
echo ""
echo "New tables created:"
echo "  - email_verification_tokens"
echo "  - email_logs"
echo ""
echo "New columns added to users table:"
echo "  - email_verified (BOOLEAN)"
echo "  - email_verified_at (TIMESTAMP)"
echo ""
echo "Don't forget to configure email settings in your .env file:"
echo "  EMAIL_HOST=smtp.gmail.com"
echo "  EMAIL_PORT=587"
echo "  EMAIL_USER=your-email@gmail.com"
echo "  EMAIL_PASSWORD=your-app-password"
echo "  EMAIL_FROM=noreply@yourdomain.com"
echo "  EMAIL_FROM_NAME=Your App Name"
echo ""
