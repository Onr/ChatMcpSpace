#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000/api}"
API_KEY="${API_KEY:-}"
USER_PASSWORD="${USER_PASSWORD:-123123}"
CHATSPACE_DIR="${CHATSPACE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.chatspace}"

if [ -z "$API_KEY" ]; then
  echo "ERROR: API_KEY is required"
  echo "Usage: API_KEY=<key> bash tests/e2e/verify_spawn_codex_runtime.sh"
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required"; exit 1; }

sanitize_folder() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g'
}

TS="$(date +%s)"
PARENT_NAME="SpawnCodexParent_${TS}"
CHILD_NAME="SpawnCodexChild_${TS}"
CHILD_DIR="$(sanitize_folder "$CHILD_NAME")"
CHILD_LOG="$CHATSPACE_DIR/$CHILD_DIR/agent_state/agent_loop.log"

cleanup() {
  curl -s -X POST "$API_BASE/agent/self-terminate" \
    -H "X-API-Key: $API_KEY" \
    -H "X-Agent-Name: $CHILD_NAME" \
    -H "Content-Type: application/json" \
    -d '{"reason":"spawn codex runtime smoke cleanup","archiveMessages":false}' >/dev/null 2>&1 || true

  curl -s -X POST "$API_BASE/agent/self-terminate" \
    -H "X-API-Key: $API_KEY" \
    -H "X-Agent-Name: $PARENT_NAME" \
    -H "Content-Type: application/json" \
    -d '{"reason":"spawn codex runtime smoke cleanup","archiveMessages":false}' >/dev/null 2>&1 || true
}
trap cleanup EXIT

health_code="$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE%/api}/health" || true)"
if [ "$health_code" != "200" ]; then
  health_code="$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $API_KEY" "$API_BASE/agent/discover" || true)"
  if [ "$health_code" != "200" ] && [ "$health_code" != "401" ]; then
    echo "ERROR: API server is not reachable at ${API_BASE%/api}"
    exit 1
  fi
fi

echo "Registering parent agent: $PARENT_NAME"
curl -s -X POST "$API_BASE/agent/register" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"agentName\":\"$PARENT_NAME\"}" >/dev/null

echo "Ensuring parent can spawn"
curl -s -X PUT "$API_BASE/agent/config" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"can_spawn":true}' >/dev/null

echo "Checking invalid child name rejection"
invalid_response="$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"childAgentName":"--help","initialInstructions":"invalid name check","modelProvider":"codex","parentPassword":"'"$USER_PASSWORD"'"}')"

invalid_message="$(echo "$invalid_response" | jq -r '.error.message // .message // empty')"
if ! echo "$invalid_message" | grep -Eqi 'invalid|begin with "-"|childAgentName'; then
  echo "ERROR: invalid spawn name was not rejected as expected"
  echo "$invalid_response"
  exit 1
fi

echo "Spawning real child agent with codex"
spawn_response="$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d '{"childAgentName":"'"$CHILD_NAME"'","initialInstructions":"Reply with a one-line startup acknowledgement and mention the current provider.","modelProvider":"codex","model":"gpt-5-mini","parentPassword":"'"$USER_PASSWORD"'"}')"

child_id="$(echo "$spawn_response" | jq -r '.childAgent.agentId // empty')"
if [ -z "$child_id" ]; then
  echo "ERROR: spawn failed"
  echo "$spawn_response"
  exit 1
fi

echo "Spawned child: $child_id"
echo "Waiting for runner log at $CHILD_LOG"

deadline=$((SECONDS + 45))
while [ $SECONDS -lt $deadline ]; do
  if [ -f "$CHILD_LOG" ]; then
    if grep -q "Codex CLI is missing" "$CHILD_LOG"; then
      echo "ERROR: child runner still reported missing Codex CLI"
      tail -n 80 "$CHILD_LOG"
      exit 1
    fi

    if grep -Eq "Running: .*codex|Agent session completed|Received message" "$CHILD_LOG"; then
      echo "PASS: child runner started without the missing-Codex failure"
      tail -n 40 "$CHILD_LOG"
      exit 0
    fi
  fi
  sleep 1
done

echo "ERROR: timed out waiting for child runner activity"
if [ -f "$CHILD_LOG" ]; then
  tail -n 80 "$CHILD_LOG"
fi
exit 1
