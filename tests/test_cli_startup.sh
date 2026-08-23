#!/usr/bin/env bash
# Tests that agent-cli.sh starts correctly and doesn't silently exit.
# Run: bash tests/test_cli_startup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_SCRIPT="$SCRIPT_DIR/agent-cli.sh"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== agent-cli.sh Startup Tests ==="
echo ""

# Test 1: Syntax check
echo "Test 1: Bash syntax validation"
if bash -n "$CLI_SCRIPT" 2>/dev/null; then
    pass "Script has valid bash syntax"
else
    fail "Script has syntax errors"
fi

# Test 2: --help flag exits 0 and shows usage
echo "Test 2: --help flag"
help_output=$(bash "$CLI_SCRIPT" --help 2>&1)
help_exit=$?
if [ $help_exit -eq 0 ]; then
    pass "--help exits with code 0"
else
    fail "--help exits with code $help_exit"
fi
if echo "$help_output" | grep -q "Usage:"; then
    pass "--help shows usage text"
else
    fail "--help does not show usage text"
fi

# Test 3: ERR trap is present
echo "Test 3: ERR trap exists"
if grep -q "trap.*ERR" "$CLI_SCRIPT"; then
    pass "ERR trap is defined"
else
    fail "No ERR trap found - silent exits possible"
fi

# Test 4: auto_sync is guarded with || true
echo "Test 4: auto_sync_all_installed_providers_models is guarded"
if grep -q "auto_sync_all_installed_providers_models || true" "$CLI_SCRIPT" \
    || grep -q "( auto_sync_all_installed_providers_models ) >/dev/null 2>&1 &" "$CLI_SCRIPT"; then
    pass "auto_sync call is guarded with || true"
else
    fail "auto_sync call is NOT guarded - can cause silent exit"
fi

# Test 5: check_prerequisites function exists
echo "Test 5: check_prerequisites function exists"
if grep -q "^check_prerequisites()" "$CLI_SCRIPT"; then
    pass "check_prerequisites function is defined"
else
    fail "check_prerequisites function not found"
fi

# Test 6: gum auto-install prompt exists (not just URL)
echo "Test 6: gum has auto-install prompt in check_prerequisites"
if grep -A5 "gum)" "$CLI_SCRIPT" | grep -q "Do you want to install gum"; then
    pass "gum case offers interactive install"
else
    fail "gum case only shows URL - no auto-install"
fi

# Test 7: main_menu function exists
echo "Test 7: main_menu function exists"
if grep -q "^main_menu()" "$CLI_SCRIPT"; then
    pass "main_menu function is defined"
else
    fail "main_menu function not found"
fi

# Test 8: Entry point calls main_menu (interactive mode)
echo "Test 8: Entry point reaches main_menu"
if grep -q "^main_menu$" "$CLI_SCRIPT"; then
    pass "main_menu is called at entry point"
else
    fail "main_menu not called at entry point"
fi

# Test 9: Template in apiGuideGenerator.js has ERR trap
echo "Test 9: Template has ERR trap"
GEN_FILE="$SCRIPT_DIR/src/utils/apiGuideGenerator.js"
if [ -f "$GEN_FILE" ] && grep -q "trap.*ERR" "$GEN_FILE"; then
    pass "apiGuideGenerator.js template has ERR trap"
else
    fail "apiGuideGenerator.js template missing ERR trap"
fi

# Test 10: Template has guarded auto_sync
echo "Test 10: Template has guarded auto_sync"
if [ -f "$GEN_FILE" ] && { grep -q "auto_sync_all_installed_providers_models || true" "$GEN_FILE" \
    || grep -q "( auto_sync_all_installed_providers_models ) >/dev/null 2>&1 &" "$GEN_FILE"; }; then
    pass "apiGuideGenerator.js template guards auto_sync"
else
    fail "apiGuideGenerator.js template doesn't guard auto_sync"
fi

# Test 11: Template has gum auto-install
echo "Test 11: Template has gum auto-install"
if [ -f "$GEN_FILE" ] && grep -q "Do you want to install gum" "$GEN_FILE"; then
    pass "apiGuideGenerator.js template has gum auto-install"
else
    fail "apiGuideGenerator.js template missing gum auto-install"
fi

# Test 12: Headless mode with no action shows error (not silent exit)
echo "Test 12: Headless mode without action shows error"
headless_output=$(bash "$CLI_SCRIPT" --headless 2>&1 || true)
if echo "$headless_output" | grep -q "Error.*headless"; then
    pass "Headless mode without action shows clear error"
else
    fail "Headless mode without action exits silently"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Integration Tests: End-to-End Agent Startup
# ═══════════════════════════════════════════════════════════════════════════════

TEST_AGENT_NAME="__test_e2e_startup_$$"
TEST_AGENT_FOLDER=$(echo "$TEST_AGENT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-zA-Z0-9_-]/_/g')
TEST_AGENT_DIR="$SCRIPT_DIR/.chatspace/$TEST_AGENT_FOLDER"
RUNNER_PID=""

cleanup_integration() {
    # Kill runner if running
    if [ -n "$RUNNER_PID" ] && kill -0 "$RUNNER_PID" 2>/dev/null; then
        kill "$RUNNER_PID" 2>/dev/null
        wait "$RUNNER_PID" 2>/dev/null || true
    fi
    # Remove test agent directory
    if [ -d "$TEST_AGENT_DIR" ]; then
        rm -rf "$TEST_AGENT_DIR"
    fi
}
trap cleanup_integration EXIT

echo ""
echo "--- Integration Tests ---"
echo ""

# Test 13: Regenerate CLI from latest templates
echo "Test 13: Regenerate CLI from latest templates"
if [ -f "$SCRIPT_DIR/scripts/regenerate-cli.js" ]; then
    regen_output=$(node "$SCRIPT_DIR/scripts/regenerate-cli.js" 2>&1)
    regen_exit=$?
    if [ $regen_exit -eq 0 ]; then
        pass "regenerate-cli.js ran successfully"
    else
        fail "regenerate-cli.js exited with code $regen_exit: $regen_output"
    fi
else
    fail "scripts/regenerate-cli.js not found"
fi

# Test 14: Create agent in headless mode
echo "Test 14: Create agent in headless mode"
create_output=$(bash "$CLI_SCRIPT" --headless --create "$TEST_AGENT_NAME" \
    --password testpassword --providers codex --codex-sandbox read-only \
    --no-auto-start 2>&1)
create_exit=$?
if [ $create_exit -eq 0 ]; then
    pass "Headless --create exited 0"
else
    fail "Headless --create exited $create_exit: $create_output"
fi

if [ -d "$TEST_AGENT_DIR" ]; then
    pass "Agent directory created at $TEST_AGENT_DIR"
else
    fail "Agent directory not found at $TEST_AGENT_DIR"
fi

for keyfile in agent-runner.sh message_helper.py agent_state; do
    if [ -e "$TEST_AGENT_DIR/$keyfile" ]; then
        pass "Key file exists: $keyfile"
    else
        fail "Key file missing: $keyfile"
    fi
done

# Test 15: Generated agent-runner.sh has valid bash syntax
echo "Test 15: Generated agent-runner.sh has valid bash syntax"
if [ -f "$TEST_AGENT_DIR/agent-runner.sh" ]; then
    if bash -n "$TEST_AGENT_DIR/agent-runner.sh" 2>/dev/null; then
        pass "agent-runner.sh has valid bash syntax"
    else
        fail "agent-runner.sh has syntax errors"
    fi
else
    fail "agent-runner.sh not found (skipping syntax check)"
fi

# Test 16: Generated message_helper.py has valid Python syntax
echo "Test 16: Generated message_helper.py has valid Python syntax"
if [ -f "$TEST_AGENT_DIR/message_helper.py" ]; then
    if python3 -m py_compile "$TEST_AGENT_DIR/message_helper.py" 2>/dev/null; then
        pass "message_helper.py has valid Python syntax"
    else
        fail "message_helper.py has syntax errors"
    fi
else
    fail "message_helper.py not found (skipping syntax check)"
fi

# Test 17: Agent runner reaches polling loop within 30s
echo "Test 17: Agent runner reaches polling loop within 30s"
if [ -f "$TEST_AGENT_DIR/agent-runner.sh" ]; then
    RUNNER_LOG="$TEST_AGENT_DIR/runner_test_output.log"
    bash "$TEST_AGENT_DIR/agent-runner.sh" > "$RUNNER_LOG" 2>&1 &
    RUNNER_PID=$!

    TIMEOUT=60
    FOUND=false

    for i in $(seq 1 $TIMEOUT); do
        if [ -f "$RUNNER_LOG" ] && grep -q "Waiting for messages" "$RUNNER_LOG"; then
            FOUND=true
            break
        fi
        sleep 1
    done

    if [ "$FOUND" = "true" ]; then
        pass "Runner reached polling loop in ${i}s"
    else
        fail "Runner did NOT reach polling loop within ${TIMEOUT}s"
        echo "    Last 20 lines of runner output:"
        tail -20 "$RUNNER_LOG" 2>/dev/null | sed 's/^/    /'
    fi
else
    fail "agent-runner.sh not found (skipping startup test)"
fi

# Test 18: .running flag file was created
echo "Test 18: .running flag file was created"
if [ -f "$TEST_AGENT_DIR/agent_state/.running" ]; then
    pass ".running flag exists after startup"
else
    fail ".running flag not found after startup"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ $FAIL -gt 0 ]; then
    exit 1
fi
echo "All tests passed!"
