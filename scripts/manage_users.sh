#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/_common.sh"

if ! command -v gum >/dev/null 2>&1; then
  echo "The Gum CLI is required for this script." >&2
  exit 1
fi

# Load .env for DB_NAME
if [ -f "$ROOT_DIR/.env" ]; then
  # export variables from .env, ignoring comments
  export $(grep -v '^#' "$ROOT_DIR/.env" | xargs)
fi

DB_NAME=${DB_NAME:-agent_messaging_platform}

execute_sql() {
  local sql="$1"
  # Use sudo -u postgres to ensure admin access
  sudo -u postgres psql -d "$DB_NAME" -tAc "$sql"
}

execute_sql_csv() {
  local sql="$1"
  sudo -u postgres psql -d "$DB_NAME" -c "COPY ($sql) TO STDOUT WITH CSV HEADER;"
}

check_column_exists() {
  local table_name="$1"
  local column_name="$2"
  # Query information_schema to check if the column exists
  local exists
  exists=$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '$table_name' AND column_name = '$column_name');")
  if [[ "$exists" == "t" ]]; then
    return 0 # true
  else
    return 1 # false
  fi
}

list_users() {
  gum style --foreground 212 "Fetching users..."
  
  local user_count
  user_count=$(execute_sql "SELECT COUNT(*) FROM users;")
  
  if [ "$user_count" -eq 0 ]; then
    gum style --foreground 214 "No users found."
    return
  fi

  local select_cols="user_id, email, created_at"
  local header_cols="User ID,Email,Created At"

  if check_column_exists "users" "email_verified"; then
    select_cols+=", email_verified"
    header_cols+=", Email Verified"
  fi

  # Create a temporary CSV file for gum table
  local tmp_csv
  tmp_csv=$(mktemp)
  
  execute_sql_csv "SELECT $select_cols FROM users ORDER BY created_at DESC" > "$tmp_csv"
  
  gum style --foreground 244 "Found $user_count users:"
  gum table --file "$tmp_csv" --height 10
  
  rm "$tmp_csv"
}


delete_user_flow() {
  gum style --foreground 212 "Select a user to DELETE"
  
  # Get list formatted for gum filter: "Email | UserID"
  local users_list
  users_list=$(execute_sql "SELECT email || ' | ' || user_id FROM users ORDER BY created_at DESC;")

  if [ -z "$users_list" ]; then
    gum style --foreground 214 "No users found to delete."
    return
  fi

  local selected
  selected=$(echo "$users_list" | gum filter --placeholder "Search by email..." --height 10)

  if [ -z "$selected" ]; then
    gum style --foreground 214 "No user selected."
    return
  fi

  local user_email
  user_email=$(echo "$selected" | cut -d'|' -f1 | xargs)
  local user_id
  user_id=$(echo "$selected" | cut -d'|' -f2 | xargs)

  gum style --border double --border-foreground 9 --foreground 9 --bold " WARNING "
  gum style --foreground 255 "You are about to delete user:"
  gum style --foreground 212 "$user_email"
  gum style --foreground 255 "ID: $user_id"
  gum style --foreground 9 "This will delete ALL agents, messages, and history for this user."
  gum style --foreground 9 "This action cannot be undone."
  
  if gum confirm --affirmative "Delete Forever" --negative "Cancel" "Are you sure?"; then
    # Delete email logs associated with the user (both by ID and email address)
    # Use || true to prevent failure if the table doesn't exist (e.g. migration not run)
    execute_sql "DELETE FROM email_logs WHERE user_id = '$user_id' OR email_to = '$user_email';" || true
    # Delete the user (cascades to agents, messages, tokens, etc.)
    execute_sql "DELETE FROM users WHERE user_id = '$user_id';"
    gum style --foreground 82 "✔ User '$user_email' has been deleted."
  else
    gum style --foreground 214 "Deletion cancelled."
  fi
}

print_header() {
  gum style \
    --border rounded \
    --padding "0 1" \
    --margin "1 0" \
    --border-foreground 57 \
    "User Management"
}

while true; do
  print_header
  ACTION=$(gum choose "List Users" "Delete User" "Quit")
  
  case "$ACTION" in
    "List Users")
      list_users
      gum input --placeholder "Press Enter to continue..." >/dev/null
      ;;
    "Delete User")
      delete_user_flow
      ;;
    "Quit")
      exit 0
      ;;
  esac
done
