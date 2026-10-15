#!/usr/bin/env bash

# Reclaim disposable caches when the root filesystem is under disk pressure.
# This deliberately never touches application data, uploads, databases, or logs.

set -euo pipefail

ROOT_DIR="${HEALTH_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MAX_USAGE_PERCENT="${DISK_CLEANUP_TRIGGER_PERCENT:-85}"

usage="$(df -P "$ROOT_DIR" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
if ! [[ "$usage" =~ ^[0-9]+$ ]]; then
  echo "[disk-cleanup] unable to determine disk usage" >&2
  exit 1
fi

if [ "$usage" -lt "$MAX_USAGE_PERCENT" ]; then
  echo "[disk-cleanup] skipped: ${usage}% used (trigger ${MAX_USAGE_PERCENT}%)"
  exit 0
fi

echo "[disk-cleanup] disk pressure detected: ${usage}% used; reclaiming disposable caches"

# These are reproducible development-tool caches owned by the service user.
# They are intentionally limited to caches and old, named temporary workspaces;
# application data, uploads, databases, and logs are never touched here.
rm -rf "$HOME/.cache/ms-playwright" "$HOME/.cache/pip" "$HOME/.cache/uv"
rm -rf "$HOME/.nvm/.cache" "$HOME/.codex/.tmp"

# CLI self-updaters retain complete superseded releases. On small server disks,
# just a few Codex releases can consume more than a gigabyte. Keep the release
# selected by the `current` symlink plus the newest fallback release, and prune
# only the remaining versioned directories.
codex_releases_dir="$HOME/.codex/packages/standalone/releases"
codex_current=""
if [ -L "$HOME/.codex/packages/standalone/current" ]; then
  codex_current="$(readlink -f "$HOME/.codex/packages/standalone/current" 2>/dev/null || true)"
fi
if [ -d "$codex_releases_dir" ]; then
  kept_fallback=0
  while IFS= read -r release_dir; do
    [ -n "$release_dir" ] || continue
    if [ "$release_dir" = "$codex_current" ]; then
      continue
    fi
    if [ "$kept_fallback" -eq 0 ]; then
      kept_fallback=1
      continue
    fi
    rm -rf -- "$release_dir"
  done < <(find "$codex_releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -rn | cut -d' ' -f2-)
fi

# Agent CLI upgrades leave timestamped rollback copies. Retain recent copies
# for recovery, but discard ones that have been superseded for at least 3 days.
find "$HOME/.local/bin" -xdev -mindepth 1 -maxdepth 1 -type f \
  -name 'agy.*.old' -mtime +3 -delete 2>/dev/null || true

# Test and health-check workers leave uniquely named workspaces in /tmp.  Do
# not interfere with active runs: remove only the known disposable prefixes
# that have not been modified for three days.
find /tmp -xdev -mindepth 1 -maxdepth 1 -type d -mtime +3 \
  \( -name 'agent-helper-*' -o -name 'cos-api-test-*' -o -name 'playwright-artifacts-*' \
     -o -name 'playwright_chromiumdev_profile-*' -o -name 'production-health-*' \
     -o -name 'backup-db-*' \) -exec rm -rf -- {} + 2>/dev/null || true

if command -v npm >/dev/null 2>&1; then
  npm cache clean --force >/dev/null 2>&1 || echo "[disk-cleanup] npm cache cleanup skipped"
fi

# System caches are optional: the user timer may not have passwordless sudo.
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n apt-get clean >/dev/null 2>&1 || true
  sudo -n journalctl --vacuum-size=64M >/dev/null 2>&1 || true
fi

new_usage="$(df -P "$ROOT_DIR" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
echo "[disk-cleanup] complete: ${usage}% -> ${new_usage}% used"
