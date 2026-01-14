#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

require_gum() {
  if ! command -v gum >/dev/null 2>&1; then
    echo "[email-config] ERROR: gum CLI is required to configure email settings." >&2
    exit 1
  fi
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    gum style --foreground 196 "Node.js is required to send a test email but is not installed."
    return 1
  fi
  return 0
}

ensure_env_file() {
  if [ -f ".env" ]; then
    return
  fi
  if [ -f ".env.example" ]; then
    cp .env.example .env
  else
    touch .env
  fi
}

get_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" .env 2>/dev/null || true)"
  if [ -n "$line" ]; then
    echo "${line#*=}"
  fi
}

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$value|" .env
  else
    echo "$key=$value" >> .env
  fi
}

prompt_value() {
  local key="$1"
  local prompt="$2"
  local default_val="$3"
  local current
  current="$(get_env_value "$key")"
  local initial="${current:-$default_val}"
  local input
  input="$(gum input --prompt "$prompt: " --value "$initial")"
  if [ -z "$input" ]; then
    input="$initial"
  fi
  update_env "$key" "$input"
  echo "[email-config] Set $key=$input"
}

prompt_bool() {
  local key="$1"
  local prompt="$2"
  local default_val="$3"
  local current
  current="$(get_env_value "$key")"
  local initial="${current:-$default_val}"
  local choice
  choice="$(gum choose --cursor "➤ " "true" "false" --header "$prompt (current: $initial)")"
  update_env "$key" "$choice"
  echo "[email-config] Set $key=$choice"
}

prompt_secret() {
  local key="$1"
  local prompt="$2"
  local default_val="$3"
  local current
  current="$(get_env_value "$key")"
  local initial="${current:-$default_val}"
  local placeholder=""
  if [ -n "$initial" ]; then
    placeholder="(current value will be reused if left blank)"
  fi
  local input
  if [ -n "$placeholder" ]; then
    input="$(gum input --password --prompt "$prompt: " --placeholder "$placeholder")"
  else
    input="$(gum input --password --prompt "$prompt: ")"
  fi
  if [ -z "$input" ]; then
    input="$initial"
  fi
  update_env "$key" "$input"
  echo "[email-config] Set $key"
}

require_gum
ensure_env_file

gum style --border rounded --foreground 212 --margin "1 0" --padding "1 2" "Email configuration"
gum style --foreground 244 "Update all SMTP/email environment settings used by the app."

prompt_value "EMAIL_HOST" "SMTP host" "${EMAIL_HOST:-smtp.gmail.com}"
prompt_value "EMAIL_PORT" "SMTP port" "${EMAIL_PORT:-587}"
prompt_bool "EMAIL_SECURE" "Use TLS/SSL for SMTP" "${EMAIL_SECURE:-false}"
prompt_value "EMAIL_USER" "SMTP username" "${EMAIL_USER:-}"
prompt_secret "EMAIL_PASSWORD" "SMTP password/app password" "${EMAIL_PASSWORD:-}"
prompt_value "EMAIL_FROM" "From email address" "${EMAIL_FROM:-noreply@yourdomain.com}"
prompt_value "EMAIL_FROM_NAME" "From display name" "${EMAIL_FROM_NAME:-Agent Messaging Platform}"
prompt_value "EMAIL_REPLY_TO" "Reply-to email" "${EMAIL_REPLY_TO:-support@yourdomain.com}"

gum style --foreground 82 "Email settings saved to .env"

prompt_send_test_email() {
  if ! gum confirm --affirmative "Send test email" --negative "Skip" "Send a test email now with these settings?"; then
    gum style --foreground 244 "You can send a test later with node scripts/send_test_email.js <email>"
    return
  fi

  if ! require_node; then
    return
  fi

  local default_recipient="${EMAIL_TEST_RECIPIENT:-${EMAIL_FROM:-}}"
  local recipient
  recipient="$(gum input --prompt "Test recipient email (blank = preview only)" --value "$default_recipient")"

  if [ -n "$recipient" ]; then
    gum style --foreground 82 "Sending test email to $recipient..."
    if ! node scripts/send_test_email.js "$recipient"; then
      gum style --foreground 196 "Sending the test email failed. Check logs above."
    fi
  else
    gum style --foreground 214 "Generating test email preview without sending..."
    if ! node scripts/send_test_email.js; then
      gum style --foreground 196 "Generating the preview failed. Check logs above."
    fi
  fi
}

prompt_send_test_email
