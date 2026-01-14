#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

choose_template() {
  local choice
  choice=$(gum choose "local (.env.example)" "staging (.env.staging.example)" "production (.env.production.example)" --header "Select which template to copy into .env")
  case "$choice" in
    "local (.env.example)") echo ".env.example" ;;
    "staging (.env.staging.example)") echo ".env.staging.example" ;;
    "production (.env.production.example)") echo ".env.production.example" ;;
    *) echo "" ;;
  esac
}

main() {
  if [ ! -f ".env.example" ]; then
    echo "[setup-env] Missing .env.example; cannot proceed." >&2
    exit 1
  fi

  local template_file
  template_file="$(choose_template)"
  if [ -z "$template_file" ]; then
    echo "[setup-env] No template selected."
    exit 1
  fi

  if [ ! -f "$template_file" ]; then
    echo "[setup-env] Template $template_file not found." >&2
    exit 1
  fi

  if [ -f ".env" ]; then
    gum style --foreground 214 "[setup-env] .env already exists and will be overwritten."
    if ! gum confirm --affirmative "Overwrite" --negative "Cancel" "Replace existing .env with $template_file?"; then
      echo "[setup-env] Cancelled."
      exit 0
    fi
  fi

  cp "$template_file" .env
  echo "[setup-env] Copied $template_file to .env. Please populate placeholder values from your secret store."
}

main
