#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$ROOT_DIR/scripts"
LOG_FILE="$ROOT_DIR/server.log"

if ! command -v gum >/dev/null 2>&1; then
  echo "The Gum CLI is required for this script." >&2
  echo "Install instructions: https://github.com/charmbracelet/gum#installation" >&2
  exit 1
fi

if [ ! -d "$SCRIPTS_DIR" ]; then
  echo "scripts/ directory not found. Please ensure helper scripts exist." >&2
  exit 1
fi

print_header() {
  gum style \
    --border double \
    --padding "1 2" \
    --margin "1 0" \
    --border-foreground 212 \
    "AI Agent Messaging Platform" \
    "Main Control Menu"
}

command_preview() {
  local title="$1"
  local detail="$2"
  shift 2
  local -a cmd=("$@")

  local preview=""
  for part in "${cmd[@]}"; do
    preview+="$(printf '%q ' "$part")"
  done

  gum style --margin "1 0" --bold "$title"
  gum style --foreground 250 "$detail"
  gum style --foreground 36 "Command preview:"
  gum style --foreground 244 "$preview"

  if gum confirm --affirmative "Run" --negative "Cancel" "Execute this command?"; then
    "${cmd[@]}"
  else
    gum style --foreground 214 "Action cancelled"
  fi
}

action_initial_setup() {
  gum style --foreground 212 "Environment setup"
  gum style --foreground 244 "Choose whether to bootstrap the database schema."
  local run_db="false"
  if gum confirm --affirmative "Bootstrap" --negative "Skip" "Run database setup after npm install?"; then
    run_db="true"
  fi
  command_preview \
    "Initial setup" \
    "Prepare .env, install dependencies, and optionally run the DB setup script." \
    env "RUN_DB_SETUP=$run_db" "$SCRIPTS_DIR/initial_setup.sh"
}

action_setup_env_template() {
  command_preview \
    "Setup .env from template" \
    "Copy local/staging/production template into .env (overwrite prompt included)." \
    "$SCRIPTS_DIR/setup_env_from_template.sh"
}

action_configure_email() {
  gum style --foreground 212 "Email configuration"
  gum style --foreground 244 "Modify SMTP host, credentials, and sender/reply-to values."
  gum style --foreground 244 "You'll be prompted to send a test email with the configured settings."
  command_preview \
    "Configure email settings" \
    "Prompt for all EMAIL_* variables so the app can send mail." \
    "$SCRIPTS_DIR/configure_email.sh"
}

action_check_prereqs() {
  command_preview \
    "Check prerequisites" \
    "Verify Node, npm, and PostgreSQL command-line tools are available." \
    "$SCRIPTS_DIR/check_prereqs.sh"
}

action_run_db_setup() {
  gum style --foreground 214 "This will run the PostgreSQL bootstrap (uses sudo)."
  gum style --foreground "9" --bold "WARNING: This will DELETE ALL existing data in the database."
  if ! gum confirm --affirmative "Proceed and delete data" --negative "Cancel" "Do you want to continue?"; then
      gum style --foreground 214 "Action cancelled."
      return
  fi
  command_preview \
    "Database setup" \
    "Provision the PostgreSQL database and apply schema migrations." \
    "$SCRIPTS_DIR/run_db_setup.sh"
}

action_fix_db() {
  command_preview \
    "Fix database authentication" \
    "Diagnose and repair database connection issues." \
    "$SCRIPTS_DIR/fix_db_auth.sh"
}

action_restart_db() {
  command_preview \
    "Restart database" \
    "Restart the PostgreSQL service without losing data." \
    "sudo" "service" "postgresql" "restart"
}

action_start_server() {
  command_preview \
    "Start server" \
    "Launch npm start in the background and capture logs to server.log." \
    "$SCRIPTS_DIR/start_server.sh"
}

action_start_app_foreground() {
  command_preview \
    "Start server (foreground)" \
    "Ensure environment/dependencies, then run npm start in the foreground." \
    "$SCRIPTS_DIR/start_app.sh"
}

action_start_production() {
  command_preview \
    "Start server (production)" \
    "Prep env/deps, verify DB, then start with NODE_ENV=production in the foreground." \
    "$SCRIPTS_DIR/start_production.sh"
}

action_start_dev_mode() {
  gum style --foreground "9" --bold "⚠️  SECURITY WARNING ⚠️"
  gum style --foreground "9" "This mode creates a default user with INSECURE credentials!"
  gum style --foreground "9" "  Email:    123@gmail.com"
  gum style --foreground "9" "  Password: 12345678"
  echo ""
  gum style --foreground "214" "This is for LOCAL DEVELOPMENT/TESTING ONLY."
  gum style --foreground "214" "DO NOT use in production or expose to the internet!"
  echo ""
  command_preview \
    "Start server (dev mode)" \
    "Create default test user and start server for local testing without authentication setup." \
    "$SCRIPTS_DIR/start_dev_mode.sh"
}

action_setup_nginx() {
  gum style --foreground 212 "Configure Nginx reverse proxy on port 80 (requires sudo)."
  gum style --foreground 244 "This will install nginx if missing, write /etc/nginx/sites-available/agent-messaging-platform.conf, and reload nginx."
  command_preview \
    "Setup Nginx reverse proxy" \
    "Proxy :80 to the app's PORT (defaults to 3000 if PORT is privileged)." \
    "$SCRIPTS_DIR/setup_nginx_reverse_proxy.sh"
}

action_start_redis() {
  command_preview \
    "Start Redis (local)" \
    "Launch a local redis-server if not running and ensure .env has Redis defaults." \
    "$SCRIPTS_DIR/start_redis.sh"
}

action_launch_agent() {
  gum style --foreground 212 "One-Shot Agent Launcher"
  gum style --foreground 244 "Configure and start the AI agent with interactive prompts."
  gum style --foreground 244 "The agent will run in one-shot mode, processing messages and exiting."
  
  if gum confirm --affirmative "Launch" --negative "Cancel" "Open the agent launcher?"; then
    exec "$ROOT_DIR/chatspace/cli-test-agent/agent-launcher.sh"
  else
    gum style --foreground 214 "Action cancelled"
  fi
}

action_start_local_stack() {
  gum style --foreground 212 "Start local PostgreSQL and Redis (requires sudo for Postgres)."
  gum style --foreground 244 "Sets local defaults in .env if missing, then starts services."
  command_preview \
    "Start local DB + Redis" \
    "Ensure .env defaults, start PostgreSQL service, then start Redis." \
    "$SCRIPTS_DIR/start_local_stack.sh"
}

action_setup_tls() {
  gum style --foreground 212 "Obtain Let's Encrypt cert (standalone) and update .env for in-app TLS."
  gum style --foreground 244 "Requires ports 80/443 and sudo for certbot installation."
  command_preview \
    "Setup TLS (certbot)" \
    "Acquire/renew certs and write HTTPS_ settings into .env." \
    "$SCRIPTS_DIR/setup_tls_certbot.sh"
}

action_check_https() {
  command_preview \
    "Check HTTPS reachability" \
    "Prompt for an https:// URL (defaults to BASE_URL if present) and verify it responds with 2xx/3xx." \
    "$SCRIPTS_DIR/check_https_site.sh"
}

action_bootstrap_all() {
  command_preview \
    "Bootstrap machine" \
    "Install system deps, prepare .env, install npm deps, set up DB/Redis, and start the server." \
    "$SCRIPTS_DIR/bootstrap_machine.sh"
}

action_stop_server() {
  command_preview \
    "Stop server" \
    "Terminate the running server process recorded in tmp/server.pid." \
    "$SCRIPTS_DIR/stop_server.sh"
}

action_server_status() {
  command_preview \
    "Server status" \
    "Interactive status dashboard (process, traffic, system, Postgres, Redis)." \
    "$SCRIPTS_DIR/server_status.sh"
}

action_server_status_file() {
  command_preview \
    "Server status file" \
    "Write a status snapshot to server_status.txt every 5 minutes (Ctrl+C to stop)." \
    "$SCRIPTS_DIR/server_status_file.sh"
}

action_follow_logs() {
  local default_lines="200"
  local lines
  lines=$(gum input --placeholder "Lines to tail" --value "$default_lines" --prompt "Tail lines > ")
  if [ -z "$lines" ]; then
    lines="$default_lines"
  fi
  if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
    gum style --foreground 9 "Invalid number of lines: $lines"
    return
  fi
  command_preview \
    "Follow logs" \
    "Stream server.log with tail -f showing the last $lines lines." \
    "$SCRIPTS_DIR/follow_logs.sh" "$lines"
}

action_view_log() {
  command_preview \
    "View full log" \
    "Open server.log in your default pager for inspection." \
    "$SCRIPTS_DIR/view_log.sh"
}

action_run_tests_suite() {
  gum style --foreground 212 "Test suite & UI checklist"
  gum style --foreground 244 "Run automated Jest + Python helper tests, then confirm the UI behaves after agent deletion."

  if gum confirm --affirmative "Run tests" --negative "Skip" "Execute the automated test suite now?"; then
    set +e
    (cd "$ROOT_DIR" && "$SCRIPTS_DIR/run_tests.sh")
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      gum style --foreground 82 "✓ Automated tests passed"
    else
      gum style --foreground 9 "✗ Automated tests failed (exit $status). Review the log above."
    fi
  fi

  gum style --margin "1 0" --foreground 212 "Manual UI checklist (agent deletion)"
  gum style --foreground 244 "Open the web app, delete a test agent, and check each item below:"
  local steps=(
    "Agent disappears from the Agents list immediately after deletion"
    "Other agents still load histories and messages without errors"
    "Deleted agent stays gone after refreshing the Agents list"
    "No toast/error banners appear after deletion; history for the deleted agent is inaccessible"
  )
  gum choose --no-limit --cursor "➤ " --selected-prefix "✓ " --unselected-prefix "• " "${steps[@]}" >/dev/null
  gum style --foreground 36 "Checklist recorded. Capture screenshots/log snippets for any failed items."
}

action_manage_users() {
  command_preview \
    "Manage Users" \
    "List, search, and delete users (and their data) from the database." \
    "$SCRIPTS_DIR/manage_users.sh"
}

action_show_google_auth_walkthrough() {
  "$SCRIPTS_DIR/show_google_auth_walkthrough.sh"
}

action_test_cli_providers() {
  gum style \
    --border double \
    --padding "1 2" \
    --margin "1 0" \
    --border-foreground 212 \
    "🧪 CLI Provider Test Suite" \
    "Test Codex, Claude, Gemini, and local providers"
  
  echo ""
  gum style --foreground 244 "This test suite will:"
  gum style --foreground 244 "  • Test selected CLI providers with various configurations"
  gum style --foreground 244 "  • Use a weather query that requires internet access"
  gum style --foreground 244 "  • Log results to tests/test-results/ directory"
  echo ""
  
  # Build test selection and pass to the test script
  local test_script="$ROOT_DIR/tests/cli-provider-test.sh"
  
  if [ ! -f "$test_script" ]; then
    gum style --foreground 9 "✗ Test script not found: $test_script"
    return 1
  fi
  
  # Run the test script with its unified menu
  "$test_script"
}

show_menu_and_get_selection() {
  local entries=()
  local menu_items=(
    "bootstrap|Bootstrap machine|Install deps, prep env, set up DB/Redis, start server"
    "prereqs|Check prerequisites|Ensure Node/npm/PostgreSQL CLIs are present"
    "env|Setup .env from template|Copy local/staging/prod template into .env"
    "email|Configure email settings|Adjust SMTP host/port/auth and sender addresses"
    "google_auth|Google Auth Help|Show verification steps for Google Sign-In"
    "users|Manage Users|List and delete users/data"
    "agent|Launch AI Agent|Start one-shot agent with interactive configuration"
    "tests|Run tests & UI checks|Automated Jest suite plus manual UI checklist"
    "cli_tests|Test CLI Providers|🧪 Test Codex, Claude, and Gemini CLI configurations"
    "redis|Start Redis (local)|Start redis-server locally and set .env defaults"
    "local_stack|Start DB + Redis (local)|Start PostgreSQL and Redis locally; patch .env defaults"
    "tls|Setup TLS (Let's Encrypt)|Use certbot standalone to fetch certs and update .env"
    "https_check|Check HTTPS reachability|Verify a site responds over HTTPS"
    "setup|Initial setup|Configure .env, install dependencies, bootstrap DB"
    "nginx|Setup Nginx reverse proxy|Install/configure Nginx to proxy :80 to app port"
    "db|Run database setup|Provision PostgreSQL and apply schema"
    "start_fg|Start server (foreground)|Ensure env/deps then run npm start interactively"
    "start_fg_for_devlop|Start server (dev mode)|⚠️ INSECURE: Create test user 123@gmail.com for local testing"
    "start_prod|Start server (production)|Prep env/deps, verify DB, start with NODE_ENV=production"
    "start|Start server|Run npm start in the background"
    "status|Server status|Check PID and log file location"
    "status_file|Server status file|Write a server_status.txt snapshot every 5 minutes"
    "follow_logs|Follow logs|Stream server.log with tail -f"
    "view_log|View full log|Open server.log inside a pager"
    "stop|Stop server|Stop the running server process"
    "fix_db|Fix database auth|Diagnose and repair database connection issues"
    "restart_db|Restart DB service|Restart PostgreSQL without data loss"
    "backup|Backup database|Create compressed pg_dump in backups/"
    "backup_timer|Install backup timer|Install/enable daily systemd user timer"
    "quit|Quit|Exit this menu"
  )

  for item in "${menu_items[@]}"; do
    IFS="|" read -r key title desc <<<"$item"
    entries+=("[$key] $title — $desc")
  done

  print_header
  local height="${#entries[@]}"
  if [ "$height" -lt 1 ]; then
    height=1
  fi
  gum choose --height "$height" --cursor "➤ " "${entries[@]}"
}

while true; do
  selection=$(show_menu_and_get_selection)
  key=$(sed -n 's/^\[\([^]]*\)\].*/\1/p' <<<"$selection")
  case "$key" in
    env) action_setup_env_template ;;
    email) action_configure_email ;;
    google_auth) action_show_google_auth_walkthrough ;;
    users) action_manage_users ;;
    prereqs) action_check_prereqs ;;
    agent) action_launch_agent ;;
    setup) action_initial_setup ;;
    nginx) action_setup_nginx ;;
    tls) action_setup_tls ;;
    https_check) action_check_https ;;
    local_stack) action_start_local_stack ;;
    db) action_run_db_setup ;;
    start_prod) action_start_production ;;
    fix_db) action_fix_db ;;
    restart_db) action_restart_db ;;
    backup) "$SCRIPTS_DIR/backup_db.sh" ;;
    backup_timer) "$SCRIPTS_DIR/install_backup_timer.sh" ;;
    redis) action_start_redis ;;
    bootstrap) action_bootstrap_all ;;
    start) action_start_server ;;
    start_fg) action_start_app_foreground ;;
    start_fg_for_devlop) action_start_dev_mode ;;
    tests) action_run_tests_suite ;;
    cli_tests) action_test_cli_providers ;;
    stop) action_stop_server ;;
    status) action_server_status ;;
    status_file) action_server_status_file ;;
    follow_logs) action_follow_logs ;;
    view_log) action_view_log ;;
    quit) exit 0 ;;
    *) gum style --foreground 9 "Unknown action: $key" ;;
  esac

done
