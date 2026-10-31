#!/usr/bin/env bash
# Send the repeatable public-repo end-to-end test brief to a test agent by DM.
#
# Usage: scripts/send_public_e2e_test.sh [agent-name] [commit|latest]
#   agent-name  defaults to "windos-test"
#   commit      public repo commit to test; defaults to "latest" (origin/main)
#
# Prints the brief instead of sending when DRY_RUN=1, so it can also be pasted
# into an agent by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF="$ROOT/docs/PUBLIC_REPO_E2E_TEST_PROMPT.md"
# The AgentsMCPspace identity runs on the shared runtime, which rejects the
# legacy helper, so send as the news-feed agent on this box by default. Its own
# helper predates `dm`, so run the current helper against its .env instead.
# The sender needs inter-agent messaging enabled in the dashboard, otherwise the
# server answers INTER_AGENT_DISABLED; use DRY_RUN=1 and paste it by hand then.
SENDER_ENV="${SENDER_ENV:-$ROOT/chatspace/local_news_-_aws_c1/.env}"
HELPER="$ROOT/.chatspace/agentsmcpspace/message_helper.py"
REPLY_TO="${REPLY_TO:-AgentsMCPspace}"
TARGET="${1:-windos-test}"
COMMIT="${2:-latest}"

[ -f "$BRIEF" ] || { echo "Missing $BRIEF" >&2; exit 1; }

MESSAGE="$(printf 'TEST_COMMIT: %s\nSENT_AT_UTC: %s\nREPLY_TO: post the report in your own conversation for the human, and DM it to %s\n\n%s' \
  "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPLY_TO" "$(cat "$BRIEF")")"

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$MESSAGE"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
cp "$HELPER" "$WORK/message_helper.py"
ln -s "$SENDER_ENV" "$WORK/.env"
cd "$WORK"
uv run message_helper.py dm "$TARGET" "$MESSAGE"
