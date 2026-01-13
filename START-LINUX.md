# Starting the Application on Linux

## Quick Start

### Step 1: Setup Database (One-time setup)

```bash
chmod +x scripts/run_db_setup.sh
./scripts/run_db_setup.sh
```

This will:
- Start PostgreSQL service
- Create the database
- Initialize the schema

### Step 2: Start the Application

```bash
chmod +x scripts/start_app.sh
./scripts/start_app.sh
```

This will:
- Create .env file if needed
- Install Node.js dependencies
- Start the application on http://localhost:3000

---

## Manual Setup (Alternative)

If you prefer to run commands manually:

### 1. Start PostgreSQL

```bash
sudo service postgresql start
sudo service postgresql status
```

### 2. Create Database

```bash
sudo -u postgres createdb agent_messaging_platform
sudo -u postgres psql -d agent_messaging_platform -f src/db/schema.sql
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env if needed with your preferred editor
nano .env
```

### 4. Install Dependencies and Start

```bash
npm install
npm start
```

---

## Troubleshooting

### PostgreSQL not installed

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
```

### PostgreSQL won't start

```bash
# Check logs
sudo tail -f /var/log/postgresql/postgresql-*-main.log

# Try restarting
sudo service postgresql restart
```

### Port 3000 already in use

Edit `.env` and change the PORT value:
```
PORT=3001
```

### Database connection errors

Check your `.env` file. Default PostgreSQL credentials:
- User: `postgres`
- Password: `postgres` (or empty)
- Host: `localhost`
- Port: `5432`

---

## Useful Commands

**Check PostgreSQL status:**
```bash
sudo service postgresql status
```

**Stop PostgreSQL:**
```bash
sudo service postgresql stop
```

**Restart PostgreSQL:**
```bash
sudo service postgresql restart
```

**View application logs:**
Logs appear in the terminal where you ran `npm start`

**Stop the application:**
Press `Ctrl+C` in the terminal running the app
