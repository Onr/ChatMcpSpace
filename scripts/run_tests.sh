#!/usr/bin/env bash
#
# Runs the jest suite and records the outcome in docs/TEST_RUN_LOG.md, so the
# log shows when the suite last passed rather than only what passed today.
#
# Usage:
#   scripts/run_tests.sh              # whole suite
#   scripts/run_tests.sh tests/api    # any jest args are forwarded

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to run the test suite." >&2
  exit 1
fi

cd "$ROOT_DIR"

OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

set +e
npm test -- "$@" 2>&1 | tee "$OUTPUT_FILE"
# tee always succeeds, so the pipeline status is useless here — read jest's own
# exit status out of PIPESTATUS or a red suite gets logged as a pass.
TEST_EXIT=${PIPESTATUS[0]}
set -e

# Jest prints its totals on stderr, which tee captured above.
SUITES_LINE="$(grep -E '^Test Suites:' "$OUTPUT_FILE" | tail -1 | sed 's/Test Suites: *//')"
TESTS_LINE="$(grep -E '^Tests:' "$OUTPUT_FILE" | tail -1 | sed 's/Tests: *//')"
DETAILS="suites: ${SUITES_LINE:-unknown}; tests: ${TESTS_LINE:-unknown}"
if [ "$#" -gt 0 ]; then
  DETAILS="$DETAILS; args: $*"
fi

"$ROOT_DIR/scripts/log_test_run.sh" "jest" "$TEST_EXIT" "$DETAILS" || true

exit "$TEST_EXIT"
