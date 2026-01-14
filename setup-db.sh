#!/bin/bash

echo "=== Database Setup ==="
echo ""

# Start PostgreSQL
echo "Starting PostgreSQL..."
sudo service postgresql start
sleep 2

# Check PostgreSQL status
if sudo service postgresql status | grep -q "online\|active"; then
    echo "✓ PostgreSQL is running"
else
    echo "✗ Failed to start PostgreSQL"
    exit 1
fi

# Check if database exists
echo ""
echo "Checking database..."
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='agent_messaging_platform'" 2>/dev/null || echo "0")

if [ "$DB_EXISTS" = "1" ]; then
    echo "✓ Database 'agent_messaging_platform' already exists"
else
    echo "Creating database 'agent_messaging_platform'..."
    sudo -u postgres createdb agent_messaging_platform
    echo "✓ Database created"
fi

# Initialize schema
echo ""
echo "Initializing database schema..."
if [ -f "src/db/schema.sql" ]; then
    sudo -u postgres psql -d agent_messaging_platform -f src/db/schema.sql 2>&1 | grep -v "NOTICE\|already exists" || true
    echo "✓ Schema initialized"
else
    echo "⚠ Warning: schema.sql not found at src/db/schema.sql"
fi

echo ""
echo "=== Database Setup Complete ==="
echo ""
