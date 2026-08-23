#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
#  Chief of Staff — End-to-End Verification Script
# ═══════════════════════════════════════════════════════════════════════════════
#
#  Real-simulation test for the Chief of Staff (CoS) feature. Hits the live
#  server with X-API-Key + X-Agent-Name: "Chief of Staff" and walks through
#  the full lifecycle:
#
#    0. Pre-flight: server reachable, CoS agent installed.
#    1. GET  /api/agent/cos/roster                — roster includes CoS.
#    2. POST /api/agent/cos/spawn-child           — spawn a test child.
#    3. Verify: DB row, chatspace folder, AGENT_INSTRUCTIONS.md.
#    4. Verify: auto-DM was queued from CoS to child.
#    5. Optional: tmux launch + tmux ls (if tmux is available).
#    6. PATCH /api/agent/cos/agents/:id/instructions
#    7. DELETE /api/agent/cos/agents/:id without confirmation → 400.
#    8. DELETE /api/agent/cos/agents/:id with correct confirmation → 200.
#    9. Verify: child no longer appears in roster.
#   10. Negative: PATCH on the CoS itself → 403 (COS_PROTECTED).
#   11. Negative: DELETE on the CoS itself → 403 (COS_SELF_DELETE).
#
#  Usage:
#    API_KEY=<your-key> bash tests/verify_chief_of_staff.sh
#    API_KEY=<key> API_BASE=http://host:port/api bash tests/verify_chief_of_staff.sh
#
#  Required setup (do this once, by hand):
#    Install a Chief of Staff for your user via the dashboard
#    (Settings → Chief of Staff → Install). The script will not install it for
#    you — install is gated on a session cookie, not an API key.
# ═══════════════════════════════════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

PASS=0
FAIL=0
TOTAL=0

print_header()  { echo -e "\n${BOLD}${CYAN}═══  $1  ═══${RESET}\n"; }
print_step()    { echo -e "${YELLOW}>> $1${RESET}"; }
print_success() { echo -e "${GREEN}  ✓ $1${RESET}"; }
print_error()   { echo -e "${RED}  ✗ $1${RESET}"; }
print_info()    { echo -e "${BLUE}  ℹ $1${RESET}"; }

assert_pass() { TOTAL=$((TOTAL + 1)); PASS=$((PASS + 1)); print_success "$1"; }
assert_fail() { TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); print_error   "$1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    assert_pass "$label"
  else
    assert_fail "$label   (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qi -- "$needle"; then
    assert_pass "$label"
  else
    assert_fail "$label   (did not find '$needle')"
    echo "    got: $(echo "$haystack" | head -c 200)"
  fi
}

assert_status() {
  local label="$1" expected="$2" actual="$3" body="${4-}"
  if [[ "$expected" == "$actual" ]]; then
    assert_pass "$label  [HTTP $actual]"
  else
    assert_fail "$label  (expected HTTP $expected, got $actual)"
    [[ -n "$body" ]] && echo "    body: $(echo "$body" | head -c 300)"
  fi
}

json_field() {
  echo "$1" | jq -r "$2" 2>/dev/null || echo ""
}

command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq is required.  apt install jq"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required."; exit 1; }

API_BASE="${API_BASE:-http://localhost:3000/api}"
API_KEY="${API_KEY:-}"
COS_NAME="${COS_NAME:-Local Chief of Staff}"
TEST_CHILD_NAME="${TEST_CHILD_NAME:-cos-verify-child-$$}"

if [[ -z "$API_KEY" ]]; then
  echo -e "${RED}ERROR:${RESET} API_KEY environment variable is required."
  echo "Run:  API_KEY=<your-key> bash $0"
  exit 1
fi

# tmux is optional — we just skip the local launch verification if missing.
HAS_TMUX=false
if command -v tmux >/dev/null 2>&1; then
  HAS_TMUX=true
fi

print_header "Chief of Staff verification"
print_info "API_BASE       = $API_BASE"
print_info "COS_NAME       = $COS_NAME"
print_info "TEST_CHILD     = $TEST_CHILD_NAME"
print_info "tmux available = $HAS_TMUX"

# ─── 0. Pre-flight ────────────────────────────────────────────────────────────
print_header "0. Pre-flight"

print_step "Server reachable"
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/agent/connect-guide" || true)
assert_status "GET /agent/connect-guide" 200 "$HEALTH_STATUS"

# ─── 1. Roster ────────────────────────────────────────────────────────────────
print_header "1. /api/agent/cos/roster"

print_step "Roster as CoS"
ROSTER_BODY=$(curl -s -w "\n%{http_code}" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  "$API_BASE/agent/cos/roster" || true)
ROSTER_CODE=$(echo "$ROSTER_BODY" | tail -n 1)
ROSTER_JSON=$(echo "$ROSTER_BODY" | sed '$d')
assert_status "GET /agent/cos/roster" 200 "$ROSTER_CODE" "$ROSTER_JSON"
if [[ "$ROSTER_CODE" != "200" ]]; then
  echo
  echo -e "${RED}Cannot continue — CoS agent named \"$COS_NAME\" is not installed for this API key.${RESET}"
  echo "Install via dashboard Settings → Chief of Staff → Install."
  exit 1
fi
COS_ID=$(json_field "$ROSTER_JSON" '.cosAgentId')
assert_contains "Roster lists the CoS" "$ROSTER_JSON" "is_chief_of_staff"
print_info "CoS agent id: $COS_ID"

print_step "Roster rejected for a non-CoS X-Agent-Name"
# Try to find a non-CoS agent to assert 403 behaviour. Skip the assertion if
# there is no other agent on this account yet.
NON_COS_NAME=$(echo "$ROSTER_JSON" | jq -r '.agents[] | select(.is_chief_of_staff == false) | .agent_name' | head -n 1)
if [[ -n "$NON_COS_NAME" && "$NON_COS_NAME" != "null" ]]; then
  FORBID_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-API-Key: $API_KEY" \
    -H "X-Agent-Name: $NON_COS_NAME" \
    "$API_BASE/agent/cos/roster" || true)
  assert_status "GET /agent/cos/roster as non-CoS" 403 "$FORBID_CODE"
else
  print_info "(no non-CoS agent available to test 403 — skipping)"
fi

# ─── 2. Spawn child ───────────────────────────────────────────────────────────
print_header "2. /api/agent/cos/spawn-child"

print_step "Spawning $TEST_CHILD_NAME"
SPAWN_BODY=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$TEST_CHILD_NAME\", \"role\": \"Verification subject\", \"initialInstructions\": \"You exist only for verify_chief_of_staff.sh. Reply 'ok' if you receive this DM.\"}" \
  "$API_BASE/agent/cos/spawn-child" || true)
SPAWN_CODE=$(echo "$SPAWN_BODY" | tail -n 1)
SPAWN_JSON=$(echo "$SPAWN_BODY" | sed '$d')
assert_status "POST /agent/cos/spawn-child" 201 "$SPAWN_CODE" "$SPAWN_JSON"

CHILD_ID=$(json_field "$SPAWN_JSON" '.childAgent.agentId')
CHILD_DIR=$(json_field "$SPAWN_JSON" '.childAgent.agentDir')
CHILD_LAUNCH=$(json_field "$SPAWN_JSON" '.childAgent.tmuxLaunchCommand')
print_info "Child id : $CHILD_ID"
print_info "Child dir: $CHILD_DIR"

# ─── 3. Verify filesystem ─────────────────────────────────────────────────────
print_header "3. Child chatspace folder"

if [[ -n "$CHILD_DIR" && -d "$CHILD_DIR" ]]; then
  assert_pass "Child folder exists: $CHILD_DIR"
  for f in AGENT_INSTRUCTIONS.md agent-runner.sh message_helper.py agent_state/agent_config.json; do
    if [[ -e "$CHILD_DIR/$f" ]]; then
      assert_pass "File present: $f"
    else
      assert_fail "Missing: $f"
    fi
  done
  if [[ -e "$CHILD_DIR/AGENT_INSTRUCTIONS.md" ]]; then
    if grep -q "Verification subject" "$CHILD_DIR/AGENT_INSTRUCTIONS.md"; then
      assert_pass "AGENT_INSTRUCTIONS.md includes role"
    else
      assert_fail "AGENT_INSTRUCTIONS.md missing role text"
    fi
  fi
else
  assert_fail "Child folder not on disk ($CHILD_DIR)"
  print_info "(The server may be running on a different machine — file-system asserts only work when this script runs on the same host.)"
fi

# ─── 4. Auto-DM ───────────────────────────────────────────────────────────────
print_header "4. Auto-DM from CoS to child"

# We don't have a direct endpoint to list agent_messages by sender as the CoS
# from outside Postgres, but we DO have the discover endpoint and the child's
# own messages endpoint. Use /messages/direct with X-Agent-Name = child to
# fetch DMs the child has received.
sleep 1  # allow row-write to settle if the test server is loaded
DMS_BODY=$(curl -s -w "\n%{http_code}" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $TEST_CHILD_NAME" \
  "$API_BASE/agent/messages/direct" || true)
DMS_CODE=$(echo "$DMS_BODY" | tail -n 1)
DMS_JSON=$(echo "$DMS_BODY" | sed '$d')
if [[ "$DMS_CODE" == "200" ]]; then
  assert_pass "Child can read its DMs (HTTP 200)"
  if echo "$DMS_JSON" | grep -qi "Verification subject"; then
    assert_pass "Child has the mission DM from CoS"
  else
    assert_fail "Mission DM not found in child's DMs"
    echo "    body: $(echo "$DMS_JSON" | head -c 300)"
  fi
else
  print_info "(GET /agent/messages/direct returned $DMS_CODE — skipping DM assertions)"
fi

# ─── 5. Optional tmux launch ──────────────────────────────────────────────────
print_header "5. tmux launch (optional)"

if [[ "$HAS_TMUX" == "true" && -n "$CHILD_DIR" && -d "$CHILD_DIR" ]]; then
  SESSION="cos-verify-$$"
  print_step "tmux new-session -d -s $SESSION"
  if tmux new-session -d -s "$SESSION" "cd '$CHILD_DIR' && bash -c 'echo started; sleep 5'" 2>/dev/null; then
    assert_pass "tmux session started"
    sleep 1
    if tmux ls 2>/dev/null | grep -q "^${SESSION}:"; then
      assert_pass "tmux session visible in tmux ls"
    else
      assert_fail "tmux session not visible after start"
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  else
    assert_fail "tmux new-session failed"
  fi
else
  print_info "(skipping — tmux missing or child folder unreachable from this host)"
fi

# ─── 6. PATCH instructions ────────────────────────────────────────────────────
print_header "6. PATCH /api/agent/cos/agents/:id/instructions"

NEW_INSTR="Updated by verify_chief_of_staff.sh at $(date -u +%FT%TZ)."
PATCH_BODY=$(curl -s -w "\n%{http_code}" \
  -X PATCH \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"newInstructions\": \"$NEW_INSTR\"}" \
  "$API_BASE/agent/cos/agents/$CHILD_ID/instructions" || true)
PATCH_CODE=$(echo "$PATCH_BODY" | tail -n 1)
PATCH_JSON=$(echo "$PATCH_BODY" | sed '$d')
assert_status "PATCH instructions" 200 "$PATCH_CODE" "$PATCH_JSON"
assert_contains "PATCH response success=true" "$PATCH_JSON" '"success":true'

print_step "Empty newInstructions → 400"
EMPTY_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d '{"newInstructions": ""}' \
  "$API_BASE/agent/cos/agents/$CHILD_ID/instructions" || true)
assert_status "PATCH with empty newInstructions" 400 "$EMPTY_CODE"

# ─── 7. DELETE without confirmation → 400 ─────────────────────────────────────
print_header "7. DELETE without confirmation → 400"

NO_CONFIRM_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$API_BASE/agent/cos/agents/$CHILD_ID" || true)
assert_status "DELETE without confirmation" 400 "$NO_CONFIRM_CODE"

# ─── 8. DELETE with correct confirmation → 200 ────────────────────────────────
print_header "8. DELETE with confirmation → 200"

DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"confirmation\": \"$TEST_CHILD_NAME\"}" \
  "$API_BASE/agent/cos/agents/$CHILD_ID" || true)
assert_status "DELETE with confirmation" 200 "$DEL_CODE"

# ─── 9. Verify child gone ─────────────────────────────────────────────────────
print_header "9. Roster no longer lists the child"

sleep 1
ROSTER2=$(curl -s \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  "$API_BASE/agent/cos/roster" || true)
if echo "$ROSTER2" | jq -r '.agents[].agent_name' | grep -q -- "^$TEST_CHILD_NAME$"; then
  assert_fail "Child still in roster after delete"
else
  assert_pass "Child removed from roster"
fi

# ─── 10. PATCH on the CoS itself → 403 ────────────────────────────────────────
print_header "10. Protected: PATCH on the CoS itself → 403"

SELF_PATCH=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d '{"newInstructions": "trying"}' \
  "$API_BASE/agent/cos/agents/$COS_ID/instructions" || true)
assert_status "PATCH on CoS" 403 "$SELF_PATCH"

# ─── 11. DELETE on the CoS itself → 403 ───────────────────────────────────────
print_header "11. Protected: DELETE on the CoS itself → 403"

SELF_DEL=$(curl -s -o /dev/null -w "%{http_code}" \
  -X DELETE \
  -H "X-API-Key: $API_KEY" \
  -H "X-Agent-Name: $COS_NAME" \
  -H "Content-Type: application/json" \
  -d "{\"confirmation\": \"$COS_NAME\"}" \
  "$API_BASE/agent/cos/agents/$COS_ID" || true)
assert_status "DELETE on CoS" 403 "$SELF_DEL"

# ─── Summary ─────────────────────────────────────────────────────────────────
print_header "Summary"
echo -e "${BOLD}Total : ${TOTAL}${RESET}"
echo -e "${GREEN}Pass  : ${PASS}${RESET}"
echo -e "${RED}Fail  : ${FAIL}${RESET}"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
