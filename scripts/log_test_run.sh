#!/usr/bin/env bash
#
# log_test_run.sh — append one row to the test run log.
#
# The log answers a single question: "when did this feature last provably work?"
# Every runner that proves something (jest suite, e2e script) appends a row when
# it finishes, pass or fail, so a red run is as visible as a green one.
#
# Usage:
#   scripts/log_test_run.sh <suite> <exit_code> [details]
#
#   suite      short label, e.g. "jest" or "e2e:create-agent"
#   exit_code  0 means PASS, anything else means FAIL
#   details    free text, e.g. "65 suites, 791 tests"
#
# Environment:
#   CHATMCP_TEST_LOG  override the log path (used by the unit tests)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${CHATMCP_TEST_LOG:-$ROOT_DIR/docs/TEST_RUN_LOG.md}"

if [ "$#" -lt 2 ]; then
  echo "usage: $(basename "$0") <suite> <exit_code> [details]" >&2
  exit 2
fi

suite="$1"
exit_code="$2"
details="${3:-}"

if [ "$exit_code" -eq 0 ] 2>/dev/null; then
  result="PASS"
else
  result="FAIL"
fi

# The commit is what makes a row reproducible later. A dirty tree is flagged
# because "it worked at abc1234" is misleading when the tree had uncommitted
# edits on top of that commit.
commit="unknown"
branch="unknown"
if git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  if ! git -C "$ROOT_DIR" diff --quiet HEAD 2>/dev/null; then
    commit="$commit+dirty"
  fi
fi

# Pipes would break the markdown table; newlines would break the row.
sanitize() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'
}

mkdir -p "$(dirname "$LOG_FILE")"
if [ ! -f "$LOG_FILE" ]; then
  cat > "$LOG_FILE" <<'EOF'
# Test run log

Append-only record of when each suite last ran, so you can tell when a feature
last provably worked. Rows are written by `scripts/log_test_run.sh`, which is
called from `scripts/run_tests.sh` and from the e2e runners — do not hand-edit
rows, add a new run instead.

Failures are logged too. A missing row means the suite was never run, which is
not the same as passing — plain `npm test` does not write a row, only
`npm run test:logged` and the e2e runners do.

## What each suite proves

| Suite | Proves | Run with |
| --- | --- | --- |
| `jest` | The unit/integration suite: routes, services, utils, UI regressions. | `npm run test:logged` |
| `e2e:create-agent` | A brand-new agent can be installed and send its first message — the `curl -sL https://chatmcp.space/setup \| bash` onboarding path, against a live server and DB. | `npm run test:e2e:create-agent` |

`e2e:create-agent` needs the app running (default `http://127.0.0.1:3000`, override
with `E2E_BASE_URL`). It creates a throwaway user/agent and deletes them again.

| UTC time | Suite | Result | Details | Commit | Branch |
| --- | --- | --- | --- | --- | --- |
EOF
fi

printf '| %s | %s | %s | %s | %s | %s |\n' \
  "$(date -u '+%Y-%m-%d %H:%M:%S')" \
  "$(sanitize "$suite")" \
  "$result" \
  "$(sanitize "$details")" \
  "$commit" \
  "$(sanitize "$branch")" >> "$LOG_FILE"

echo "[test-log] $result $suite ${details:+($details)} -> $LOG_FILE"
