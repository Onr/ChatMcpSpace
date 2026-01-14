#!/bin/bash
# Automated migration script for read tracking feature

set -e

# Get the absolute path of the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Running Read Tracking Migration ==="
echo ""

# Load DB name from environment or use default
if [ -f "$PROJECT_DIR/.env" ]; then
    source "$PROJECT_DIR/.env" 2>/dev/null || true
fi
DB_NAME="${DB_NAME:-agent_messaging_platform}"

echo "Database: $DB_NAME"
echo "Migration file: $PROJECT_DIR/src/db/migrations/003_add_read_tracking.sql"
echo ""

# Run migration using absolute path
echo "Running migration SQL..."
sudo -u postgres psql -d "$DB_NAME" -f "$PROJECT_DIR/src/db/migrations/003_add_read_tracking.sql"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migration completed successfully!"
    echo ""
    echo "Next steps:"
    echo "  1. Restart your server if it's running"
    echo "  2. Refresh your browser"
    echo "  3. Test the features (see walkthrough.md)" 
else
    echo ""
    echo "❌ Migration failed. Please check the error above."
    exit 1
fi
