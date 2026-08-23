#!/usr/bin/env bash
set -euo pipefail

# Real E2E test: run a live Copilot (gpt-5-mini) agent runner and verify
# image delivery reaches frontend-visible message attachments.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  while IFS='=' read -r key raw_val; do
    case "$key" in
      API_KEY|USER_PASSWORD|ENCRYPTION_SALT|API_BASE|BASE_URL|PORT|DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)
        val="${raw_val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        export "$key=$val"
        ;;
    esac
  done < <(grep -E '^(API_KEY|USER_PASSWORD|ENCRYPTION_SALT|API_BASE|BASE_URL|PORT|DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)=' "$PROJECT_ROOT/.env" || true)
fi

# Normalize base64 padding for salt (some local .env files omit trailing '=')
if [ -n "${ENCRYPTION_SALT:-}" ]; then
  mod=$(( ${#ENCRYPTION_SALT} % 4 ))
  if [ "$mod" -ne 0 ]; then
    ENCRYPTION_SALT="${ENCRYPTION_SALT}$(printf '=%.0s' $(seq 1 $((4 - mod))))"
    export ENCRYPTION_SALT
  fi
fi

API_BASE="${API_BASE:-}"
if [ -z "$API_BASE" ]; then
  if [ -n "${BASE_URL:-}" ]; then
    API_BASE="${BASE_URL%/}/api"
  else
    API_BASE="http://localhost:${PORT:-3000}/api"
  fi
fi

for cmd in curl jq node uv copilot; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $cmd"
    exit 1
  fi
done

if [ -z "${API_KEY:-}" ] || [ -z "${USER_PASSWORD:-}" ] || [ -z "${ENCRYPTION_SALT:-}" ]; then
  echo "ERROR: API_KEY, USER_PASSWORD, and ENCRYPTION_SALT must be set (from env or .env)."
  exit 1
fi

http_code=$(curl -s -o /tmp/real-copilot-image-health.$$ -w "%{http_code}" \
  -H "X-API-Key: $API_KEY" "$API_BASE/agent/cli-script" || true)
if [ "$http_code" != "200" ]; then
  echo "ERROR: API unreachable at $API_BASE (status=$http_code)"
  cat /tmp/real-copilot-image-health.$$ || true
  rm -f /tmp/real-copilot-image-health.$$ || true
  exit 1
fi
rm -f /tmp/real-copilot-image-health.$$ || true

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g'
}

json_num() {
  local json="$1"
  local filter="$2"
  local value
  value="$(echo "$json" | jq -r "$filter" 2>/dev/null | tail -n1 | tr -d '\r' || true)"
  if ! [[ "${value:-}" =~ ^-?[0-9]+$ ]]; then
    value="0"
  fi
  echo "$value"
}

post_agent_message() {
  local agent_name="$1"
  local content="$2"
  curl -s -X POST "$API_BASE/agent/messages" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"agentName\":\"$agent_name\",\"content\":\"$content\",\"priority\":0,\"encrypted\":false}" \
    | jq -r '.messageId // empty'
}

set_inter_agent_mode() {
  local agent_name="$1"
  curl -s -X PUT "$API_BASE/agent/config" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"agentName\":\"$agent_name\",\"inter_agent_mode\":\"listen_all\"}" >/dev/null
}

insert_user_message() {
  local agent_name="$1"
  local content="$2"

  node - "$PROJECT_ROOT" "$agent_name" "$content" <<'NODE'
const path = require('path');
const root = process.argv[2];
const agentName = process.argv[3];
const content = process.argv[4];
const { query, pool } = require(path.join(root, 'src/db/connection'));

(async () => {
  try {
    const agentRes = await query(
      'SELECT agent_id FROM agents WHERE agent_name = $1 ORDER BY created_at DESC LIMIT 1',
      [agentName]
    );
    if (!agentRes.rows.length) {
      console.log('USERMSG_JSON:{"error":"agent_not_found"}');
      process.exitCode = 1;
      return;
    }

    const insertRes = await query(
      'INSERT INTO user_messages (agent_id, content, encrypted) VALUES ($1, $2, FALSE) RETURNING user_message_id',
      [agentRes.rows[0].agent_id, content]
    );
    console.log(`USERMSG_JSON:${JSON.stringify({ userMessageId: insertRes.rows[0].user_message_id })}`);
  } catch (err) {
    console.log(`USERMSG_JSON:${JSON.stringify({ error: err.message })}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
NODE
}

configure_target_provider() {
  local agent_name="$1"
  curl -s -X PUT "$API_BASE/agent/config" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"agentName\":\"$agent_name\",\"model_provider\":\"copilot\",\"model\":\"gpt-5-mini\",\"approval_mode\":\"full-auto\",\"sandbox_mode\":\"none\",\"inter_agent_mode\":\"listen_all\"}" >/dev/null
}

terminate_agent() {
  local agent_name="$1"
  curl -s -X POST "$API_BASE/agent/self-terminate" \
    -H "X-API-Key: $API_KEY" \
    -H "X-Agent-Name: $agent_name" \
    -H "Content-Type: application/json" \
    -d '{"reason":"real_copilot_image_delivery cleanup","archiveMessages":false}' >/dev/null 2>&1 || true
}

metrics_json() {
  local agent_name="$1"

  node - "$PROJECT_ROOT" "$agent_name" <<'NODE'
const path = require('path');
const root = process.argv[2];
const agentName = process.argv[3];
const { query, pool } = require(path.join(root, 'src/db/connection'));

(async () => {
  try {
    const msgRes = await query(`
      SELECT m.message_id, m.created_at,
             COALESCE(ma.cnt, 0) AS attachment_count
      FROM messages m
      JOIN agents ag ON ag.agent_id = m.agent_id
      LEFT JOIN (
        SELECT message_id, COUNT(*)::int AS cnt
        FROM message_attachments
        GROUP BY message_id
      ) ma ON ma.message_id = m.message_id
      WHERE ag.agent_name = $1
      ORDER BY m.created_at ASC
    `, [agentName]);

    const uploadRes = await query(`
      SELECT COUNT(*)::int AS uploads_total
      FROM attachments a
      JOIN agents ag ON ag.agent_id = a.agent_id
      WHERE ag.agent_name = $1
    `, [agentName]);

    const linkedRes = await query(`
      SELECT COUNT(DISTINCT ma.attachment_id)::int AS linked_attachments
      FROM message_attachments ma
      JOIN messages m ON m.message_id = ma.message_id
      JOIN agents ag ON ag.agent_id = m.agent_id
      WHERE ag.agent_name = $1
    `, [agentName]);

    const out = {
      messages_total: msgRes.rows.length,
      messages_with_attachments: msgRes.rows.filter(r => Number(r.attachment_count) > 0).length,
      uploads_total: Number(uploadRes.rows[0]?.uploads_total || 0),
      linked_attachments: Number(linkedRes.rows[0]?.linked_attachments || 0),
      message_rows: msgRes.rows.slice(-20).map(r => ({
        message_id: r.message_id,
        created_at: r.created_at,
        attachment_count: Number(r.attachment_count || 0),
      })),
    };

    console.log(`METRICS_JSON:${JSON.stringify(out)}`);
  } catch (err) {
    console.log(`METRICS_JSON:${JSON.stringify({ error: err.message })}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
NODE
}

TS="$(date +%s)"
TARGET_AGENT="RealCopilotImageTarget_${TS}"
TARGET_DIR_NAME="$(sanitize_name "$TARGET_AGENT")"
TARGET_DIR="$PROJECT_ROOT/chatspace/$TARGET_DIR_NAME"
ARTIFACT_DIR="$PROJECT_ROOT/tmp/real_copilot_image_delivery_${TS}"
RUNNER_LOG="$ARTIFACT_DIR/runner.log"
RUNNER_PID_FILE="$ARTIFACT_DIR/runner.pid"

mkdir -p "$ARTIFACT_DIR"

cleanup() {
  set +e
  if [ -f "$RUNNER_PID_FILE" ]; then
    pid="$(cat "$RUNNER_PID_FILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  terminate_agent "$TARGET_AGENT"
  rm -rf "$TARGET_DIR"
}
trap cleanup EXIT

echo "[1/8] Registering target agent..."
msg_id_target="$(post_agent_message "$TARGET_AGENT" "register target agent for real copilot image e2e")"
if [ -z "$msg_id_target" ]; then
  echo "ERROR: failed to register test agents"
  exit 1
fi

set_inter_agent_mode "$TARGET_AGENT"

echo "[2/8] Preparing target agent workspace at $TARGET_DIR ..."
mkdir -p "$TARGET_DIR/agent_state"
cat > "$TARGET_DIR/.env" <<ENVEOF
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$TARGET_AGENT"
USER_PASSWORD="$USER_PASSWORD"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
DEBUG_SEND_COMMAND_PREVIEW="false"
ENVEOF
chmod 600 "$TARGET_DIR/.env"

cat > "$TARGET_DIR/agent_state/agent_config.json" <<'CFGEOF'
{
  "model_provider": "copilot",
  "model": "gpt-5-mini",
  "approval_mode": "full-auto",
  "sandbox_mode": "none"
}
CFGEOF

cat > "$TARGET_DIR/agent_state/allowed_permissions.json" <<'PERMEOF'
{
  "copilot": {
    "--allow-all": true,
    "--allow-all-tools": true,
    "--allow-all-paths": true
  },
  "inter_agent": {
    "enabled": true,
    "mode": "listen_all",
    "groups": []
  }
}
PERMEOF

echo "[]" > "$TARGET_DIR/agent_state/.scheduled_tasks.json"

node "$PROJECT_ROOT/scripts/update-agent-scripts.js" "$TARGET_DIR" >/dev/null

configure_target_provider "$TARGET_AGENT"

echo "[3/8] Starting real agent runner (copilot + gpt-5-mini)..."
(
  cd "$TARGET_DIR" || exit 1
  ./agent-runner.sh --persistent > "$RUNNER_LOG" 2>&1
) &
echo $! > "$RUNNER_PID_FILE"
sleep 10

echo "[4/8] Inserting user instruction message to trigger image send..."
INSTRUCTION=$(cat <<MSG
Please send me back an image and make sure it renders in the frontend chat.
Use this file path: $PROJECT_ROOT/public/images/logo.png
After that, tell me what you did.
MSG
)

user_msg_json="$(insert_user_message "$TARGET_AGENT" "$INSTRUCTION" 2>/dev/null | grep 'USERMSG_JSON:' | tail -n1 | sed 's/^USERMSG_JSON://' || true)"
if [ -z "$user_msg_json" ] || ! echo "$user_msg_json" | jq -e '.userMessageId != null' >/dev/null 2>&1; then
  echo "ERROR: failed to inject user message"
  echo "$user_msg_json"
  exit 1
fi

echo "[5/8] Waiting for agent output and attachment linkage..."
baseline_metrics="$(metrics_json "$TARGET_AGENT" 2>/dev/null | grep 'METRICS_JSON:' | tail -n1 | sed 's/^METRICS_JSON://' || true)"
if ! echo "${baseline_metrics:-}" | jq -e . >/dev/null 2>&1; then
  baseline_metrics='{}'
fi
baseline_messages="$(json_num "${baseline_metrics:-{}}" '.messages_total // 0')"
baseline_uploads="$(json_num "${baseline_metrics:-{}}" '.uploads_total // 0')"
baseline_linked="$(json_num "${baseline_metrics:-{}}" '.linked_attachments // 0')"

final_metrics=''
stable_message_loops=0
for _ in $(seq 1 45); do
  sleep 4
  metrics="$(metrics_json "$TARGET_AGENT" 2>/dev/null | grep 'METRICS_JSON:' | tail -n1 | sed 's/^METRICS_JSON://' || true)"
  if [ -n "$metrics" ] && echo "$metrics" | jq -e 'has("messages_total") and (.error == null)' >/dev/null 2>&1; then
    final_metrics="$metrics"
    curr_messages="$(json_num "$metrics" '.messages_total // 0')"
    curr_uploads="$(json_num "$metrics" '.uploads_total // 0')"
    curr_linked="$(json_num "$metrics" '.linked_attachments // 0')"
    new_messages=$((curr_messages - baseline_messages))
    new_uploads=$((curr_uploads - baseline_uploads))
    new_linked=$((curr_linked - baseline_linked))

    if [ "$new_messages" -ge 1 ]; then
      stable_message_loops=$((stable_message_loops + 1))
    fi
    # Stop early once we have attachment linkage OR after a few stable loops with messages
    if [ "$new_linked" -gt 0 ] || [ "$new_uploads" -gt 0 ]; then
      break
    fi
    if [ "$stable_message_loops" -ge 3 ]; then
      break
    fi
  fi
done

if [ -z "$final_metrics" ]; then
  final_metrics='{"messages_total":0,"messages_with_attachments":0,"uploads_total":0,"linked_attachments":0,"message_rows":[]}'
fi

echo "[6/8] Collecting diagnostics..."
HISTORY_OUTPUT="$(cd "$TARGET_DIR" && uv run message_helper.py history 2>/dev/null || true)"
{
  echo "===== METRICS ====="
  echo "$final_metrics" | jq .
  echo
  echo "===== HISTORY (decrypted) ====="
  echo "$HISTORY_OUTPUT"
  echo
  echo "===== RUNNER LOG (tail) ====="
  tail -n 120 "$RUNNER_LOG" 2>/dev/null || true
} > "$ARTIFACT_DIR/report.txt"

linked_attachments="$(json_num "$final_metrics" '.linked_attachments // 0')"
uploads_total="$(json_num "$final_metrics" '.uploads_total // 0')"
messages_total="$(json_num "$final_metrics" '.messages_total // 0')"
new_linked_attachments=$((linked_attachments - baseline_linked))
new_uploads_total=$((uploads_total - baseline_uploads))
new_messages_total=$((messages_total - baseline_messages))


echo "[7/8] Result"
echo "  baseline_messages=$baseline_messages"
echo "  baseline_uploads=$baseline_uploads"
echo "  baseline_linked_attachments=$baseline_linked"
echo "  new_messages=$new_messages_total"
echo "  new_uploads=$new_uploads_total"
echo "  new_linked_attachments=$new_linked_attachments"
echo "  artifacts=$ARTIFACT_DIR/report.txt"

if [ "$new_linked_attachments" -gt 0 ]; then
  echo "PASS: Agent sent at least one message with a linked attachment."
  exit 0
fi

if [ "$new_uploads_total" -gt 0 ] && [ "$new_linked_attachments" -eq 0 ]; then
  echo "FAIL: Agent uploaded attachment(s) but none were linked to sent message(s)."
  echo "Likely issue: upload happened without sending message with attachmentIds."
  exit 2
fi

if [ "$new_messages_total" -gt 0 ] && [ "$new_linked_attachments" -eq 0 ]; then
  echo "FAIL: Agent sent text message(s) only; no image attachment reached frontend message payload."
  exit 3
fi

echo "FAIL: Agent produced no detectable output messages in the wait window."
exit 4
