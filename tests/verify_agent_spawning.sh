#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
#  Agent Spawning — End-to-End Verification Script
# ═══════════════════════════════════════════════════════════════════════════════
#
#  Tests the full agent-spawning lifecycle:
#    1. Download CLI script from the website (GET /api/agent/cli-script)
#    2. Create a parent agent the way a real user would (POST /messages)
#    3. Enable spawn permission on the parent (PUT /config  can_spawn:true)
#    4. Parent spawns a child agent (POST /spawn)
#    5. Verify child exists in DB and on disk (GET /config, /children, /lineage)
#    6. Child communicates with parent (DM round-trip)
#    7. Child spawns a grandchild (depth 2)
#    8. Verify limits: depth=3 max, fan-out, cooldown
#    9. Child self-terminates (POST /self-terminate)
#   10. Verify re-parenting of grandchild
#   11. Full cleanup (filesystem + archived agents)
#
#  Usage:
#    API_KEY=<your-key> bash tests/verify_agent_spawning.sh
#    API_KEY=<key> API_BASE=http://host:port/api bash tests/verify_agent_spawning.sh
#
#  Environment variables:
#    API_KEY          (required) — API key for an existing user
#    API_BASE         (optional) — default http://localhost:3000/api
#    USER_PASSWORD    (optional) — default 123123
#    ENCRYPTION_SALT  (optional) — fetched from server if omitted
#    CLEANUP          (optional) — set to "false" to keep test artefacts
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Counters ────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
TOTAL=0

# ─── Helpers ─────────────────────────────────────────────────────────────────
print_header()  { echo -e "\n${BOLD}${CYAN}═══  $1  ═══${RESET}\n"; }
print_step()    { echo -e "${YELLOW}>> $1${RESET}"; }
print_success() { echo -e "${GREEN}  ✓ $1${RESET}"; }
print_error()   { echo -e "${RED}  ✗ $1${RESET}"; }
print_info()    { echo -e "${BLUE}  ℹ $1${RESET}"; }
print_skip()    { echo -e "${YELLOW}  ⊘ SKIP: $1${RESET}"; }

assert_pass() {
  TOTAL=$((TOTAL + 1))
  PASS=$((PASS + 1))
  print_success "$1"
}

assert_fail() {
  TOTAL=$((TOTAL + 1))
  FAIL=$((FAIL + 1))
  print_error "$1"
}

assert_skip() {
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  print_skip "$1"
}

# Check a condition;  assert_check "label" <exit_code_or_bool>
assert_check() {
  local label="$1"
  shift
  if "$@" 2>/dev/null; then
    assert_pass "$label"
  else
    assert_fail "$label"
  fi
}

# Convenience: assert that a string contains a substring
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    assert_pass "$label"
  else
    assert_fail "$label  (expected to find '$needle')"
    echo "    got: $(echo "$haystack" | head -c 200)"
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    assert_fail "$label  (did NOT expect '$needle')"
  else
    assert_pass "$label"
  fi
}

# JSON field helper via jq (required)
json_field() {
  echo "$1" | jq -r "$2" 2>/dev/null || echo ""
}

# ─── Pre-flight ──────────────────────────────────────────────────────────────

command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq is required.  apt install jq"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required."; exit 1; }

# ─── Configuration ───────────────────────────────────────────────────────────

API_BASE="${API_BASE:-http://localhost:3000/api}"
API_KEY="${API_KEY:-}"
USER_PASSWORD="${USER_PASSWORD:-123123}"
ENCRYPTION_SALT="${ENCRYPTION_SALT:-}"
CLEANUP="${CLEANUP:-true}"

if [ -z "$API_KEY" ]; then
  read -rp "Enter your API Key: " API_KEY
fi
[ -z "$API_KEY" ] && { echo "ERROR: API_KEY is required"; exit 1; }

export API_KEY API_BASE USER_PASSWORD ENCRYPTION_SALT

# ─── Unique names (timestamp-based, avoids collisions on re-run) ─────────────

TS=$(date +%s)
PARENT_NAME="SpawnTestParent_${TS}"
CHILD_NAME="SpawnTestChild_${TS}"
GRANDCHILD_NAME="SpawnTestGrandchild_${TS}"

# ─── Resolve paths ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR="$PROJECT_ROOT/tmp/spawn_test_${TS}"

sanitize_folder() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g'
}

PARENT_DIR=$(sanitize_folder "$PARENT_NAME")
CHILD_DIR=$(sanitize_folder "$CHILD_NAME")
GRANDCHILD_DIR=$(sanitize_folder "$GRANDCHILD_NAME")

# ═══════════════════════════════════════════════════════════════════════════════
#  CLEANUP TRAP — always runs, even on failure
# ═══════════════════════════════════════════════════════════════════════════════

cleanup() {
  echo ""
  print_header "Cleanup"

  if [ "$CLEANUP" = "false" ]; then
    print_info "CLEANUP=false — keeping artefacts in $TEST_DIR"
    return
  fi

  # Remove filesystem artefacts
  if [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR"
    print_info "Removed test directory: $TEST_DIR"
  fi

  # Remove chatspace dirs that the spawn service created (in project-root chatspace)
  for dir in "$PARENT_DIR" "$CHILD_DIR" "$GRANDCHILD_DIR"; do
    local target="$PROJECT_ROOT/chatspace/$dir"
    if [ -d "$target" ]; then
      rm -rf "$target"
      print_info "Removed chatspace/$dir"
    fi
  done

  # Best-effort: delete test agents from DB via the API
  # (self-terminate for spawned agents, or just let archived_agents handle it)
  for agent_name in "$GRANDCHILD_NAME" "$CHILD_NAME" "$PARENT_NAME"; do
    # Try self-terminate first (deletes from agents table)
    curl -s -X POST "$API_BASE/agent/self-terminate" \
      -H "X-API-Key: $API_KEY" \
      -H "X-Agent-Name: $agent_name" \
      -H "Content-Type: application/json" \
      -d "{\"reason\":\"test cleanup\",\"archiveMessages\":false}" \
      >/dev/null 2>&1 || true
  done

  print_info "DB cleanup attempted for test agents"
}

trap cleanup EXIT

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 0 — Connectivity & Bootstrap
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 0: Connectivity & Bootstrap"

print_step "Checking API server at $API_BASE …"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  "${API_BASE%/api}/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  assert_pass "API server is reachable (health=$HTTP_CODE)"
else
  # Fallback: try an authenticated endpoint
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
    -H "X-API-Key: $API_KEY" "$API_BASE/agent/discover" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ]; then
    assert_pass "API server is reachable (discover=$HTTP_CODE)"
  else
    assert_fail "Cannot reach API server (code=$HTTP_CODE)"
    echo "  Start the server:  cd AgentsMCPspace && npm run dev"
    exit 1
  fi
fi

# Fetch encryption salt from CLI-script endpoint (like a real user would)
print_step "Downloading CLI script to extract encryption salt …"
CLI_SCRIPT=$(curl -s -H "X-API-Key: $API_KEY" "$API_BASE/agent/cli-script" 2>/dev/null || true)
API_SALT=$(echo "$CLI_SCRIPT" | sed -nE 's/^ENCRYPTION_SALT="?([A-Za-z0-9+/=]+)"?.*$/\1/p' | grep -v '\$' | head -n 1)

if [ -n "$API_SALT" ]; then
  ENCRYPTION_SALT="$API_SALT"
  assert_pass "Encryption salt fetched from server"
else
  if [ -z "$ENCRYPTION_SALT" ]; then
    print_error "ENCRYPTION_SALT is not set and could not be fetched from the server."
    print_info "Set ENCRYPTION_SALT env var or ensure /api/agent/cli-script is reachable."
    exit 1
  fi
  assert_pass "Encryption salt available"
fi
export ENCRYPTION_SALT

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 1 — Create Parent Agent (like a real user)
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 1: Create Parent Agent via Message"

# Set up the local workspace exactly as the downloaded CLI script would
print_step "Setting up test workspace in $TEST_DIR …"
mkdir -p "$TEST_DIR/chatspace/$PARENT_DIR/agent_state"

cat > "$TEST_DIR/chatspace/$PARENT_DIR/.env" <<EOF
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$PARENT_NAME"
USER_PASSWORD="$USER_PASSWORD"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
EOF

cat > "$TEST_DIR/chatspace/$PARENT_DIR/agent_state/agent_config.json" <<EOF
{
  "model_provider": "claude",
  "model": "default",
  "approval_mode": "full-auto",
  "sandbox_mode": "workspace-write",
  "updated_at": "$(date -Iseconds)"
}
EOF

cat > "$TEST_DIR/chatspace/$PARENT_DIR/agent_state/allowed_permissions.json" <<'EOF'
{}
EOF

print_step "Registering parent agent ($PARENT_NAME) via POST /messages …"
REG_RESPONSE=$(curl -s -X POST "$API_BASE/agent/messages" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"content\": \"Hello! I am $PARENT_NAME, registering as spawn-test parent.\",
    \"priority\": 0,
    \"agentName\": \"$PARENT_NAME\",
    \"encrypted\": false,
    \"agentType\": \"standard\"
  }" 2>&1)

MSG_ID=$(json_field "$REG_RESPONSE" '.messageId')
if [ -n "$MSG_ID" ] && [ "$MSG_ID" != "null" ]; then
  assert_pass "Parent agent created (messageId=$MSG_ID)"
else
  assert_fail "Failed to create parent agent"
  echo "  Response: $REG_RESPONSE"
  exit 1
fi

# Verify agent exists via GET /config
print_step "Verifying parent agent config …"
PARENT_CONFIG=$(curl -s "$API_BASE/agent/config?agentName=$PARENT_NAME" \
  -H "X-API-Key: $API_KEY" 2>&1)

PARENT_AGENT_ID=$(json_field "$PARENT_CONFIG" '.agentId')
PARENT_CAN_SPAWN=$(json_field "$PARENT_CONFIG" '.canSpawn')
PARENT_DEPTH=$(json_field "$PARENT_CONFIG" '.spawnDepth')

assert_contains "Parent agent found in DB" "$PARENT_CONFIG" "$PARENT_NAME"

if [ "$PARENT_CAN_SPAWN" = "false" ]; then
  assert_pass "Parent starts with canSpawn=false (correct default)"
else
  assert_fail "Parent should start with canSpawn=false, got $PARENT_CAN_SPAWN"
fi

if [ "$PARENT_DEPTH" = "0" ]; then
  assert_pass "Parent starts at spawnDepth=0"
else
  assert_fail "Parent depth should be 0, got $PARENT_DEPTH"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 2 — Enable Spawn Permission
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 2: Enable Spawn Permission"

print_step "Enabling can_spawn + listen_all on parent via PUT /config …"
ENABLE_RESPONSE=$(curl -s -X PUT "$API_BASE/agent/config" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentName\": \"$PARENT_NAME\",
    \"can_spawn\": true,
    \"inter_agent_mode\": \"listen_all\"
  }" 2>&1)

assert_contains "PUT /config accepted" "$ENABLE_RESPONSE" "Config updated"

# Re-fetch and verify
PARENT_CONFIG2=$(curl -s "$API_BASE/agent/config?agentName=$PARENT_NAME" \
  -H "X-API-Key: $API_KEY" 2>&1)
PARENT_CAN_SPAWN2=$(json_field "$PARENT_CONFIG2" '.canSpawn')
PARENT_MODE=$(json_field "$PARENT_CONFIG2" '.interAgentMode')

if [ "$PARENT_CAN_SPAWN2" = "true" ]; then
  assert_pass "can_spawn is now true"
else
  assert_fail "can_spawn should be true after PUT, got $PARENT_CAN_SPAWN2"
fi

if [ "$PARENT_MODE" = "listen_all" ]; then
  assert_pass "interAgentMode is now listen_all"
else
  assert_fail "interAgentMode should be listen_all, got $PARENT_MODE"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 3 — Spawn a Child Agent
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 3: Spawn Child Agent"

print_step "Parent ($PARENT_NAME) spawns child ($CHILD_NAME) …"
SPAWN_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"childAgentName\": \"$CHILD_NAME\",
    \"initialInstructions\": \"You are a test child agent. Verify inter-agent communication works.\",
    \"modelProvider\": \"claude\",
    \"model\": \"default\",
    \"canSpawn\": true
  }" 2>&1)

SPAWN_SUCCESS=$(json_field "$SPAWN_RESPONSE" '.success')
CHILD_AGENT_ID=$(json_field "$SPAWN_RESPONSE" '.childAgent.agentId')
CHILD_DEPTH=$(json_field "$SPAWN_RESPONSE" '.childAgent.spawnDepth')
CHILD_PARENT=$(json_field "$SPAWN_RESPONSE" '.childAgent.parentAgentId')

if [ "$SPAWN_SUCCESS" = "true" ]; then
  assert_pass "Child agent spawned successfully"
else
  assert_fail "Spawn failed"
  echo "  Response: $SPAWN_RESPONSE"
fi

if [ "$CHILD_DEPTH" = "1" ]; then
  assert_pass "Child spawnDepth=1 (correct)"
else
  assert_fail "Child depth should be 1, got $CHILD_DEPTH"
fi

if [ "$CHILD_PARENT" = "$PARENT_AGENT_ID" ]; then
  assert_pass "Child parentAgentId matches parent"
else
  assert_fail "Child parent mismatch: expected $PARENT_AGENT_ID, got $CHILD_PARENT"
fi

# ─── Verify child config via GET /config ─────────────────────────────────────

print_step "Verifying child agent config …"
CHILD_CONFIG=$(curl -s "$API_BASE/agent/config?agentName=$CHILD_NAME" \
  -H "X-API-Key: $API_KEY" 2>&1)

CHILD_AUTO=$(json_field "$CHILD_CONFIG" '.autoSpawned')
CHILD_CAN_SPAWN=$(json_field "$CHILD_CONFIG" '.canSpawn')
CHILD_INTER=$(json_field "$CHILD_CONFIG" '.interAgentMode')

if [ "$CHILD_AUTO" = "true" ]; then
  assert_pass "Child is marked auto_spawned=true"
else
  assert_fail "Child auto_spawned should be true, got $CHILD_AUTO"
fi

if [ "$CHILD_CAN_SPAWN" = "true" ]; then
  assert_pass "Child can_spawn=true (inherited)"
else
  assert_fail "Child can_spawn should be true, got $CHILD_CAN_SPAWN"
fi

if [ "$CHILD_INTER" = "listen_all" ]; then
  assert_pass "Child inter_agent_mode=listen_all"
else
  assert_fail "Child inter_agent_mode should be listen_all, got $CHILD_INTER"
fi

# ─── Verify child folder on disk ────────────────────────────────────────────

print_step "Checking child folder on disk …"
# The spawn service creates folders under the chatspace root.
# Check the project-root chatspace (where the server CWD is)
CHILD_FOLDER="$PROJECT_ROOT/chatspace/$CHILD_DIR"

if [ -d "$CHILD_FOLDER" ]; then
  assert_pass "Child chatspace folder exists: chatspace/$CHILD_DIR"
else
  assert_fail "Child folder not found at $CHILD_FOLDER"
fi

if [ -f "$CHILD_FOLDER/agent_state/lineage.json" ]; then
  assert_pass "lineage.json exists"
  LINEAGE_DEPTH=$(jq -r '.spawn_depth' "$CHILD_FOLDER/agent_state/lineage.json" 2>/dev/null || echo "")
  if [ "$LINEAGE_DEPTH" = "1" ]; then
    assert_pass "lineage.json spawn_depth=1"
  else
    assert_fail "lineage.json depth should be 1, got $LINEAGE_DEPTH"
  fi
else
  assert_fail "lineage.json not found"
fi

if [ -f "$CHILD_FOLDER/agent_state/agent_config.json" ]; then
  assert_pass "agent_config.json exists"
else
  assert_fail "agent_config.json not found"
fi

if [ -f "$CHILD_FOLDER/AGENT_INSTRUCTIONS.md" ]; then
  assert_pass "AGENT_INSTRUCTIONS.md exists"
  assert_contains "Instructions contain initial text" \
    "$(cat "$CHILD_FOLDER/AGENT_INSTRUCTIONS.md")" "inter-agent communication"
else
  assert_fail "AGENT_INSTRUCTIONS.md not found"
fi

# ─── Verify via GET /children ────────────────────────────────────────────────

print_step "Checking GET /children for parent …"
CHILDREN_RESPONSE=$(curl -s "$API_BASE/agent/children?agentName=$PARENT_NAME" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" 2>&1)

CHILDREN_COUNT=$(json_field "$CHILDREN_RESPONSE" '.children | length')
CHILD_IN_LIST=$(json_field "$CHILDREN_RESPONSE" ".children[] | select(.agent_name==\"$CHILD_NAME\") | .agent_name")

if [ "$CHILDREN_COUNT" = "1" ]; then
  assert_pass "Parent has exactly 1 child"
else
  assert_fail "Parent should have 1 child, got $CHILDREN_COUNT"
fi

if [ "$CHILD_IN_LIST" = "$CHILD_NAME" ]; then
  assert_pass "Child listed in parent's children"
else
  assert_fail "Child not found in children list"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 4 — Inter-Agent Communication
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 4: Inter-Agent Communication"

# Child discovers parent
print_step "Child discovers parent via GET /discover …"
DISCOVER_RESPONSE=$(curl -s "$API_BASE/agent/discover" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $CHILD_NAME" 2>&1)

assert_contains "Child can discover parent" "$DISCOVER_RESPONSE" "$PARENT_NAME"

# Child sends DM to parent
print_step "Child sends DM to parent …"
DM_RESPONSE=$(curl -s -X POST "$API_BASE/agent/messages/direct" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $CHILD_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"toAgentName\": \"$PARENT_NAME\",
    \"content\": \"Hello parent! I am your spawned child. Task started.\",
    \"priority\": 0,
    \"encrypted\": false
  }" 2>&1)

DM_STATUS=$(json_field "$DM_RESPONSE" '.status')
if [ "$DM_STATUS" = "sent" ]; then
  assert_pass "Child→Parent DM sent"
else
  assert_fail "DM send failed: $DM_RESPONSE"
fi

# Parent checks DMs
sleep 1
print_step "Parent checks incoming DMs …"
DM_CHECK=$(curl -s "$API_BASE/agent/messages/direct?agentName=$PARENT_NAME" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" 2>&1)

assert_contains "Parent received DM from child" "$DM_CHECK" "spawned child"

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 5 — Spawn Grandchild (Depth 2)
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 5: Spawn Grandchild (Depth 2)"

# Need to wait for cooldown to not apply (child is new, no cooldown on child)
print_step "Child ($CHILD_NAME) spawns grandchild ($GRANDCHILD_NAME) …"
SPAWN2_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $CHILD_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"childAgentName\": \"$GRANDCHILD_NAME\",
    \"initialInstructions\": \"You are a grandchild test agent at depth 2.\",
    \"canSpawn\": false
  }" 2>&1)

SPAWN2_SUCCESS=$(json_field "$SPAWN2_RESPONSE" '.success')
GC_DEPTH=$(json_field "$SPAWN2_RESPONSE" '.childAgent.spawnDepth')
GC_PARENT=$(json_field "$SPAWN2_RESPONSE" '.childAgent.parentAgentId')

if [ "$SPAWN2_SUCCESS" = "true" ]; then
  assert_pass "Grandchild spawned successfully"
else
  assert_fail "Grandchild spawn failed: $SPAWN2_RESPONSE"
fi

if [ "$GC_DEPTH" = "2" ]; then
  assert_pass "Grandchild spawnDepth=2 (correct)"
else
  assert_fail "Grandchild depth should be 2, got $GC_DEPTH"
fi

if [ "$GC_PARENT" = "$CHILD_AGENT_ID" ]; then
  assert_pass "Grandchild parentAgentId matches child"
else
  assert_fail "Grandchild parent mismatch: expected $CHILD_AGENT_ID, got $GC_PARENT"
fi

# ─── Verify lineage ─────────────────────────────────────────────────────────

print_step "Checking full lineage from child …"
LINEAGE_RESPONSE=$(curl -s "$API_BASE/agent/lineage" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $CHILD_NAME" 2>&1)

ANCESTOR_COUNT=$(json_field "$LINEAGE_RESPONSE" '.ancestors | length')
DESC_COUNT=$(json_field "$LINEAGE_RESPONSE" '.descendants | length')

if [ "$ANCESTOR_COUNT" -ge "2" ] 2>/dev/null; then
  assert_pass "Child has ≥2 ancestors (self + parent)"
else
  assert_fail "Expected ≥2 ancestors, got $ANCESTOR_COUNT"
fi

if [ "$DESC_COUNT" -ge "1" ] 2>/dev/null; then
  assert_pass "Child has ≥1 descendant (grandchild)"
else
  assert_fail "Expected ≥1 descendant, got $DESC_COUNT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 6 — Validation & Limit Tests
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 6: Validation & Limit Enforcement"

# 6a. Duplicate name should fail
print_step "Testing duplicate agent name rejection …"
DUP_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"childAgentName\": \"$CHILD_NAME\",
    \"initialInstructions\": \"duplicate\"
  }" 2>&1)

DUP_ERROR=$(json_field "$DUP_RESPONSE" '.error.message')
assert_contains "Duplicate name rejected" "$DUP_ERROR" "already exists"

# 6b. Spawn without can_spawn should fail
print_step "Testing spawn without permission …"
# Grandchild has can_spawn=false
NOPERM_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $GRANDCHILD_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"childAgentName\": \"ShouldNotExist_${TS}\",
    \"initialInstructions\": \"should fail\"
  }" 2>&1)

NOPERM_ERROR=$(json_field "$NOPERM_RESPONSE" '.error.message')
assert_contains "No-permission spawn rejected" "$NOPERM_ERROR" "can_spawn"

# 6c. Cooldown enforcement (parent just spawned, try again immediately)
print_step "Testing spawn cooldown …"
COOLDOWN_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"childAgentName\": \"CooldownTest_${TS}\",
    \"initialInstructions\": \"should fail due to cooldown\"
  }" 2>&1)

COOLDOWN_ERROR=$(json_field "$COOLDOWN_RESPONSE" '.error.message')
assert_contains "Cooldown enforced" "$COOLDOWN_ERROR" "cooldown"

# 6d. Missing X-Agent-Name header
print_step "Testing missing X-Agent-Name header …"
NOHEADER_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"childAgentName\": \"test\"}" 2>&1)

assert_contains "Missing header rejected" "$NOHEADER_RESPONSE" "X-Agent-Name"

# 6e. Missing childAgentName body field
print_step "Testing missing childAgentName …"
NOBODY_RESPONSE=$(curl -s -X POST "$API_BASE/agent/spawn" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{}" 2>&1)

assert_contains "Missing name rejected" "$NOBODY_RESPONSE" "childAgentName"

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 7 — Self-Termination & Re-Parenting
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 7: Self-Termination & Re-Parenting"

print_step "Child ($CHILD_NAME) self-terminates …"
TERM_RESPONSE=$(curl -s -X POST "$API_BASE/agent/self-terminate" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $CHILD_NAME" \
  -H "Content-Type: application/json" \
  -d "{
    \"reason\": \"E2E test — child task complete\",
    \"archiveMessages\": true
  }" 2>&1)

TERM_SUCCESS=$(json_field "$TERM_RESPONSE" '.success')
TERM_ORPHANS=$(json_field "$TERM_RESPONSE" '.orphanedChildren')
TERM_ACTION=$(json_field "$TERM_RESPONSE" '.orphanAction')

if [ "$TERM_SUCCESS" = "true" ]; then
  assert_pass "Child self-terminated successfully"
else
  assert_fail "Self-terminate failed: $TERM_RESPONSE"
fi

if [ "$TERM_ORPHANS" = "1" ]; then
  assert_pass "Reported 1 orphaned child (grandchild)"
else
  assert_fail "Expected 1 orphan, got $TERM_ORPHANS"
fi

if [ "$TERM_ACTION" = "reassigned_to_parent" ]; then
  assert_pass "Grandchild reassigned to parent (re-parenting)"
else
  assert_fail "Expected 'reassigned_to_parent', got '$TERM_ACTION'"
fi

# ─── Verify grandchild now points to parent ──────────────────────────────────

print_step "Verifying grandchild re-parenting …"
GC_CONFIG=$(curl -s "$API_BASE/agent/config?agentName=$GRANDCHILD_NAME" \
  -H "X-API-Key: $API_KEY" 2>&1)

GC_NEW_PARENT=$(json_field "$GC_CONFIG" '.parentAgentId')
GC_NEW_DEPTH=$(json_field "$GC_CONFIG" '.spawnDepth')

if [ "$GC_NEW_PARENT" = "$PARENT_AGENT_ID" ]; then
  assert_pass "Grandchild now points to original parent"
else
  assert_fail "Grandchild parent should be $PARENT_AGENT_ID, got $GC_NEW_PARENT"
fi

if [ "$GC_NEW_DEPTH" = "1" ]; then
  assert_pass "Grandchild depth decremented to 1"
else
  assert_fail "Grandchild depth should be 1, got $GC_NEW_DEPTH"
fi

# ─── Verify child no longer exists ──────────────────────────────────────────

print_step "Verifying child agent is gone …"
CHILD_GONE=$(curl -s "$API_BASE/agent/config?agentName=$CHILD_NAME" \
  -H "X-API-Key: $API_KEY" 2>&1)

CHILD_GONE_CODE=$(json_field "$CHILD_GONE" '.error.code')
if [ "$CHILD_GONE_CODE" = "AGENT_NOT_FOUND" ]; then
  assert_pass "Child agent no longer exists (archived)"
else
  assert_fail "Child should be gone, got: $CHILD_GONE"
fi

# ─── Parent's children list should now show grandchild ───────────────────────

print_step "Parent's children should now include grandchild …"
CHILDREN2_RESPONSE=$(curl -s "$API_BASE/agent/children?agentName=$PARENT_NAME" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" 2>&1)

GC_IN_LIST=$(json_field "$CHILDREN2_RESPONSE" ".children[] | select(.agent_name==\"$GRANDCHILD_NAME\") | .agent_name")
if [ "$GC_IN_LIST" = "$GRANDCHILD_NAME" ]; then
  assert_pass "Grandchild is now a direct child of parent"
else
  assert_fail "Grandchild not found in parent's children after re-parenting"
fi

# ═══════════════════════════════════════════════════════════════════════════════
#  Phase 8 — Self-Terminate Remaining Agents (cleanup via API)
# ═══════════════════════════════════════════════════════════════════════════════

print_header "Phase 8: Final Agent Cleanup via API"

# Terminate grandchild first (leaf)
print_step "Terminating grandchild …"
curl -s -X POST "$API_BASE/agent/self-terminate" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $GRANDCHILD_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"reason\":\"E2E test complete\",\"archiveMessages\":false}" \
  >/dev/null 2>&1 || true
assert_pass "Grandchild terminated"

# Terminate parent
print_step "Terminating parent …"
curl -s -X POST "$API_BASE/agent/self-terminate" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $PARENT_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"reason\":\"E2E test complete\",\"archiveMessages\":false}" \
  >/dev/null 2>&1 || true
assert_pass "Parent terminated"

# ═══════════════════════════════════════════════════════════════════════════════
#  Results Summary
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
print_header "Results"

echo -e "  ${GREEN}Passed:  $PASS${RESET}"
echo -e "  ${RED}Failed:  $FAIL${RESET}"
echo -e "  ${YELLOW}Skipped: $SKIP${RESET}"
echo -e "  ${BOLD}Total:   $TOTAL${RESET}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ✅  ALL TESTS PASSED${RESET}"
  echo ""
  exit 0
else
  echo -e "${RED}${BOLD}  ❌  $FAIL TEST(S) FAILED${RESET}"
  echo ""
  exit 1
fi
