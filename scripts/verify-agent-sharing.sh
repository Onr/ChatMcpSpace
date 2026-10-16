#!/usr/bin/env bash
# Repeat the application checks using a new private database and empty browsers.
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: bash scripts/verify-agent-sharing.sh [--ui|--in-place]

--ui runs focused interface regressions and all browser flows. --in-place runs
the in-place interface tests plus the registered-account browser flow only.
Without an option, authorization and runtime checks run alongside the tests.

Requires Linux, Node.js with this project's dependencies, PostgreSQL server
binaries (initdb/pg_ctl), timeout and rg. Downloads temporary Chromium if missing.
Creates a private PostgreSQL cluster with no TCP listener, runs authorization
and browser checks, then removes its temporary database and browser cache.
Does not use a supplied database URL, change production flags or call a model.

Exit 0 means trusted sharing application checks passed. Provider subprocesses
are fixtures; this command does not certify live provider credentials or billing.
Restricted container/tool-broker conformance is a separate execution mode.
HELP
  exit 0
fi
verification_mode=full
if [[ $# -eq 1 && "$1" == --ui ]]; then
  verification_mode=ui
elif [[ $# -eq 1 && "$1" == --in-place ]]; then
  verification_mode=in-place
elif [[ $# -ne 0 ]]; then
  printf 'Use --help or run without arguments.\n' >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux || "$(id -u)" == 0 ]]; then
  printf 'Run this verification as your ordinary Linux user.\n' >&2
  exit 2
fi

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repository_root"
command -v node >/dev/null || { printf 'Node.js is required.\n' >&2; exit 2; }
command -v timeout >/dev/null || { printf 'The timeout utility is required.\n' >&2; exit 2; }
command -v rg >/dev/null || { printf 'ripgrep (rg) is required.\n' >&2; exit 2; }
node -e 'require("pg"); require("@playwright/test")' || {
  printf 'Install this repository\x27s Node dependencies before verification.\n' >&2
  exit 2
}
npm run build:css
postgres_initdb=$(command -v initdb || true)
if [[ -z "$postgres_initdb" ]]; then
  for candidate in /usr/lib/postgresql/*/bin/initdb; do
    if [[ -x "$candidate" ]]; then postgres_initdb=$candidate; fi
  done
fi
if [[ -z "$postgres_initdb" || ! -x "${postgres_initdb%/initdb}/pg_ctl" ]]; then
  printf 'PostgreSQL server binaries (initdb and pg_ctl) are required.\n' >&2
  exit 2
fi
postgres_ctl="${postgres_initdb%/initdb}/pg_ctl"
verification_root=$(mktemp -d /tmp/agent-sharing-verify.XXXXXX)
chmod 700 "$verification_root"
owned_browser_cache=''

cleanup() {
  verification_status=$?
  trap - EXIT
  if [[ -f "$verification_root/postgres/postmaster.pid" ]]; then
    if ! "$postgres_ctl" -D "$verification_root/postgres" -m fast -w -t 30 stop > "$verification_root/stop.log" 2>&1; then
      printf 'Database stop could not be confirmed. Retained evidence: %s\n' "$verification_root" >&2
      exit 1
    fi
  fi
  rm -rf -- "$verification_root"
  if [[ -n "$owned_browser_cache" ]]; then rm -rf -- "$owned_browser_cache"; fi
  printf 'Temporary verification services and owned caches removed.\n'
  exit "$verification_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep downloads away from a nearly full checkout. Never change mount options.
if ! timeout --kill-after=10s 60s node - <<'NODE' > "$verification_root/browser-preflight.log" 2>&1
const { chromium } = require('@playwright/test');
(async () => { const browser = await chromium.launch({ headless: true }); await browser.close(); })()
  .catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
then
  if ! rg -q "Executable doesn't exist" "$verification_root/browser-preflight.log"; then
    cat "$verification_root/browser-preflight.log" >&2
    printf 'Chromium could not start; resolve the reported prerequisite.\n' >&2
    exit 2
  fi
  browser_parent="$verification_root"
  if [[ -d /dev/shm && -w /dev/shm ]] && command -v findmnt >/dev/null; then
    mount_options=$(findmnt -n -o OPTIONS -T /dev/shm)
    if [[ ",$mount_options," != *,noexec,* ]] && node -e 'const s=require("fs").statfsSync("/dev/shm"); process.exit(s.bavail*s.bsize >= 600*1024*1024 ? 0 : 1)'; then
      browser_parent=/dev/shm
    fi
  fi
  if [[ "$browser_parent" != /dev/shm ]] && ! node -e 'const s=require("fs").statfsSync(process.argv[1]); process.exit(s.bavail*s.bsize >= 750*1024*1024 ? 0 : 1)' "$browser_parent"; then
    printf 'Provide an existing Playwright browser cache or more disposable space.\n' >&2
    exit 2
  fi
  owned_browser_cache=$(mktemp -d "$browser_parent/agent-sharing-browser.XXXXXX")
  chmod 700 "$owned_browser_cache"
  mkdir "$owned_browser_cache/downloads"
  export PLAYWRIGHT_BROWSERS_PATH="$owned_browser_cache"
  printf 'Preparing temporary Chromium for verification...\n'
  TMPDIR="$owned_browser_cache/downloads" timeout --kill-after=10s 180s node node_modules/playwright/cli.js install --only-shell chromium
fi

mkdir "$verification_root/socket"
chmod 700 "$verification_root/socket"
"$postgres_initdb" -D "$verification_root/postgres" -U sharing_verify --auth=trust --no-sync > "$verification_root/initdb.log" 2>&1 || {
  cat "$verification_root/initdb.log" >&2; exit 2;
}
cat >> "$verification_root/postgres/postgresql.conf" <<CONFIG
listen_addresses = ''
unix_socket_directories = '$verification_root/socket'
port = 5432
fsync = off
synchronous_commit = off
full_page_writes = off
shared_buffers = '16MB'
max_wal_size = '64MB'
min_wal_size = '32MB'
checkpoint_timeout = '30s'
CONFIG
"$postgres_ctl" -D "$verification_root/postgres" -l "$verification_root/postgres.log" -w -t 30 start > "$verification_root/start.log" 2>&1 || {
  cat "$verification_root/start.log" >&2; exit 2;
}
# This URL always points at the newly created, mode-0700 private Unix socket.
export SHARED_TEST_DATABASE_URL="postgresql:///postgres?host=$verification_root/socket&user=sharing_verify"
unset GUEST_TEST_REDIS_URL SHARED_TEST_OUTPUT_STORE

verification_tests=(tests/ui/sharing-ui.test.js tests/ui/guest-sharing-owner.test.js tests/ui/shared-agent-selection.test.js tests/ui/agent-actions-ui.test.js tests/ui/guest-workspace.test.js tests/ui/in-place-chat.test.js tests/ui/in-place-sharing-access.test.js tests/routes/pageRoutes.legacy-sharing-redirect.test.js tests/ui/mobile-layout.test.js tests/ui/mobile-css-regressions.test.js tests/ui/in-place-chat-history-import.test.js tests/ui/sharing-csrf-recovery.test.js tests/middleware/csrfMiddleware.test.js tests/ui/in-place-dashboard-template.test.js tests/ui/in-place-rich-content.test.js tests/routes/pageRoutes.register.test.js tests/services/emailService.sharing.test.js)
if [[ "$verification_mode" == in-place ]]; then
  verification_tests=(tests/ui/in-place-chat.test.js tests/ui/in-place-sharing-access.test.js tests/routes/pageRoutes.legacy-sharing-redirect.test.js tests/ui/mobile-layout.test.js tests/ui/mobile-css-regressions.test.js tests/ui/in-place-chat-history-import.test.js tests/ui/sharing-csrf-recovery.test.js tests/middleware/csrfMiddleware.test.js tests/ui/in-place-dashboard-template.test.js tests/ui/in-place-rich-content.test.js tests/routes/pageRoutes.register.test.js tests/services/emailService.sharing.test.js)
elif [[ "$verification_mode" == full ]]; then
  printf 'Checking current grants, device policies and PostgreSQL authorization races...\n'
  verification_tests+=(tests/integration/agentAuthorization.test.js tests/integration/executionPolicy.test.js tests/integration/guestMembership.test.js tests/integration/sharedConversations.test.js tests/integration/guestShareOwner.test.js tests/services/emailService.sharing.test.js tests/utils/sharedRunner.test.js tests/utils/boundActionBroker.test.js tests/utils/sharedExecutor.test.js tests/api/agentApiRoutes.test.js)
else
  printf 'Checking picker refreshes, agent-icon sharing and conversation interfaces...\n'
fi
if [[ "$verification_mode" != in-place ]]; then
  verification_tests+=(tests/ui/guest-shared.test.js)
fi
verification_tests+=(tests/ui/shared-chat-rendering.test.js tests/ui/chat-switch-stale-rendering.test.js tests/ui/message-receipts.test.js tests/ui/multi-chat-delete-optimistic.test.js tests/ui/mobile-scroll-preservation.test.js)
timeout --kill-after=10s 240s node node_modules/jest/bin/jest.js "${verification_tests[@]}" --runInBand --testTimeout=20000
printf 'Checking shared conversation picker screenshots and tap targets...\n'
timeout --kill-after=10s 90s node node_modules/playwright/cli.js test tests/ui/shared-conversation-list.visual.spec.js --workers=1 --reporter=line
if [[ "$verification_mode" != in-place ]]; then
  printf 'Checking browser key storage...\n'
  timeout --kill-after=10s 90s node tests/e2e/guest-crypto-storage.js
  printf 'Checking owner and two account-free guests...\n'
  timeout --kill-after=10s 180s node tests/e2e/guest-sharing.js
  printf 'Checking registered-friend conversations...\n'
fi
if [[ "$verification_mode" == in-place ]]; then
  IN_PLACE_DASHBOARD_ONLY=true timeout --kill-after=10s 240s node tests/e2e/shared-conversations.js
else
  timeout --kill-after=10s 240s node tests/e2e/shared-conversations.js
fi
printf '\nAPPLICATION CHECKS: PASS\n'
if [[ "$verification_mode" == ui ]]; then
  printf 'INTERFACE CHECKS: PASS. Authorization/runtime suites were not rerun in --ui mode.\n'
  exit 0
fi
if [[ "$verification_mode" == in-place ]]; then
  printf 'IN-PLACE CHECKS: PASS. Legacy guest, authorization, and runtime suites were not rerun.\n'
  exit 0
fi
printf 'TRUSTED SHARING CHECKS: PASS. Uses the owner\x27s normal provider and existing tool permissions.\n'
printf 'Live provider setup and restricted-executor conformance are separate checks.\n'
