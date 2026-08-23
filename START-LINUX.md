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
- Create .env file if needed (with a freshly generated SESSION_SECRET)
- Install Node.js dependencies
- Start the application on http://localhost:3000

### Step 3: Create Your Account

Out of the box, registering sends a verification code by email, so you need SMTP
credentials in `.env` before you can log in. To skip that on a personal machine,
start in **local mode**:

```bash
./scripts/start_app.sh --local
```

Then open http://localhost:3000, click **Get Started**, and register with any
email address and a password. You are logged in right away - no verification
email and no Google account needed. (Equivalent to setting `LOCAL_MODE=true` in
`.env`.)

Local mode is for machines you control. It is ignored when `NODE_ENV=production`,
and you should not enable it on a server that is reachable from the internet.

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
