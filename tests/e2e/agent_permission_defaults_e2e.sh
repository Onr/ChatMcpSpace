#!/usr/bin/env bash
#
# agent_permission_defaults_e2e.sh
# ------------------------------------------------------------------------------
# End-to-end test for the agent-creation permission choice.
#
# What it covers
# --------------
# At the start of new-agent creation the user chooses between:
#   • "Allow all & skip ALL permission prompts"  (max-access / --allow-all)
#   • "Set individual defaults"                  (wizard    / --safe-defaults)
#
# The interactive fork uses `gum`, which needs a TTY and cannot run in CI, so
# this test drives the HEADLESS equivalent of both branches end-to-end and
# asserts on the artifacts the CLI writes (allowed_permissions.json and
# agent_config.json). The interactive-only wording/defaults are covered by
# static assertions on the freshly rendered script.
#
# It is credential-free and hermetic: the CLI is rendered locally from the
# generator with dummy values, run in a throwaway temp dir (CHATSPACE_DIR is
# derived from the script location), with --no-auto-start so no agent loop or
# network call is triggered.
#
# Usage:
#   tests/e2e/agent_permission_defaults_e2e.sh
# ------------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-perm-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

CLI="$WORK/agent-cli.sh"

echo "==> Rendering agent-cli.sh from the generator (dummy credentials)"
node -e '
  const { generateMainCLIScript } = require(process.argv[1] + "/src/utils/apiGuideGenerator");
  const fs = require("fs");
  const script = generateMainCLIScript("E2E-DUMMY-KEY", "https://example.invalid", "e2esalt");
  fs.writeFileSync(process.argv[2], script);
' "$REPO_ROOT" "$CLI" || { echo "FATAL: could not render CLI script"; exit 2; }

if bash -n "$CLI"; then
  pass "rendered script is syntactically valid bash"
else
  fail "rendered script FAILED bash syntax check"
  echo "VERDICT: FAIL"; exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Static assertions: interactive-only surface (gum needs a TTY)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "==> Static checks on the interactive permission fork"

grep -q "allow all, or set individual defaults" "$CLI" \
  && pass "interactive header offers 'allow all vs individual defaults'" \
  || fail "interactive header wording missing"

grep -q 'Allow all & skip ALL permission prompts' "$CLI" \
  && pass "max-access option is framed as 'allow all & skip ALL prompts'" \
  || fail "max-access option wording missing"

# Claude skip-permissions must default to NO in the individual-defaults wizard.
grep -q -- '--default=false "Allow --dangerously-skip-permissions?"' "$CLI" \
  && pass "Claude --dangerously-skip-permissions defaults to 'No'" \
  || fail "Claude skip-permissions still defaults to 'Yes'"

grep -q -- '--allow-all)' "$CLI" && grep -q -- '--safe-defaults)' "$CLI" \
  && pass "headless --allow-all / --safe-defaults flags are wired" \
  || fail "headless --allow-all / --safe-defaults flags missing"

# ─────────────────────────────────────────────────────────────────────────────
# Helper: create an agent headless and echo its agent_state dir
# ─────────────────────────────────────────────────────────────────────────────
create_agent() {
  local name="$1"; shift
  local runroot="$WORK/run_$name"
  mkdir -p "$runroot"
  cp "$CLI" "$runroot/agent-cli.sh"
  ( cd "$runroot" && bash agent-cli.sh --headless --create "$name" \
      --project-path "$runroot" --inter-agent disabled --no-auto-start "$@" \
      </dev/null ) >"$runroot/create.log" 2>&1
  # Locate the created agent_state dir (folder name is sanitized from $name)
  find "$runroot/.chatspace" -type d -name agent_state 2>/dev/null | head -1
}

# ─────────────────────────────────────────────────────────────────────────────
# Branch 1: --allow-all  (allow everything, skip all prompts)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "==> Headless branch: --allow-all"
ALLOW_STATE="$(create_agent AllowAllAgent --allow-all)"
ALLOW_PERMS="$ALLOW_STATE/allowed_permissions.json"
ALLOW_CFG="$ALLOW_STATE/agent_config.json"

if [ -f "$ALLOW_PERMS" ] && [ -f "$ALLOW_CFG" ]; then
  pass "allow-all: created allowed_permissions.json + agent_config.json"
else
  fail "allow-all: expected artifacts missing (see $WORK/run_AllowAllAgent/create.log)"
fi

if [ -f "$ALLOW_PERMS" ]; then
  [ "$(jq -r '.codex["--dangerously-bypass-approvals-and-sandbox"]' "$ALLOW_PERMS")" = "true" ] \
    && pass "allow-all: codex bypass-approvals = true" \
    || fail "allow-all: codex bypass-approvals not true"
  [ "$(jq -r '.claude["--dangerously-skip-permissions"]' "$ALLOW_PERMS")" = "true" ] \
    && pass "allow-all: claude skip-permissions = true" \
    || fail "allow-all: claude skip-permissions not true"
  [ "$(jq -r '.gemini["--yolo"]' "$ALLOW_PERMS")" = "true" ] \
    && pass "allow-all: gemini yolo = true" \
    || fail "allow-all: gemini yolo not true"
  [ "$(jq -r 'keys | map(select(. != "inter_agent")) | length' "$ALLOW_PERMS")" -ge 9 ] \
    && pass "allow-all: all providers granted (>=9)" \
    || fail "allow-all: fewer than 9 providers granted"
fi

if [ -f "$ALLOW_CFG" ]; then
  [ "$(jq -r '.approval_mode' "$ALLOW_CFG")" = "full-auto" ] \
    && pass "allow-all: approval_mode = full-auto" \
    || fail "allow-all: approval_mode not full-auto"
  [ "$(jq -r '.sandbox_mode' "$ALLOW_CFG")" = "none" ] \
    && pass "allow-all: sandbox_mode = none" \
    || fail "allow-all: sandbox_mode not none"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Branch 2: --safe-defaults  (individual per-provider defaults)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "==> Headless branch: --safe-defaults (individual defaults, providers=codex,gemini)"
SAFE_STATE="$(create_agent SafeAgent --safe-defaults --providers codex,gemini)"
SAFE_PERMS="$SAFE_STATE/allowed_permissions.json"
SAFE_CFG="$SAFE_STATE/agent_config.json"

if [ -f "$SAFE_PERMS" ] && [ -f "$SAFE_CFG" ]; then
  pass "safe-defaults: created allowed_permissions.json + agent_config.json"
else
  fail "safe-defaults: expected artifacts missing (see $WORK/run_SafeAgent/create.log)"
fi

if [ -f "$SAFE_PERMS" ]; then
  # The defining difference from --allow-all: codex is NOT auto-bypassed and the
  # full permissive bundle is not force-applied.
  [ "$(jq -r '.codex["--dangerously-bypass-approvals-and-sandbox"]' "$SAFE_PERMS")" = "false" ] \
    && pass "safe-defaults: codex bypass-approvals = false (not skip-all)" \
    || fail "safe-defaults: codex bypass-approvals should be false"
  [ "$(jq -r 'has("antigravity")' "$SAFE_PERMS")" = "false" ] \
    && pass "safe-defaults: only the requested providers are granted" \
    || fail "safe-defaults: unexpected extra providers granted"

  # Substance: --safe-defaults must actually clamp the dangerous provider
  # defaults, not just alias the (still permissive) wizard profile.
  [ "$(jq -r '.codex["--sandbox"] | index("danger-full-access") // "none"' "$SAFE_PERMS")" = "none" ] \
    && pass "safe-defaults: codex sandbox EXCLUDES danger-full-access" \
    || fail "safe-defaults: codex sandbox still allows danger-full-access"
  [ "$(jq -r '.gemini["--yolo"]' "$SAFE_PERMS")" = "false" ] \
    && pass "safe-defaults: gemini --yolo = false (no auto-approve-all)" \
    || fail "safe-defaults: gemini --yolo should be false"
  [ "$(jq -r '.gemini["--no-sandbox"]' "$SAFE_PERMS")" = "false" ] \
    && pass "safe-defaults: gemini --no-sandbox = false (no forced full access)" \
    || fail "safe-defaults: gemini --no-sandbox should be false"
fi

if [ -f "$SAFE_CFG" ]; then
  [ "$(jq -r '.approval_mode' "$SAFE_CFG")" = "suggest" ] \
    && pass "safe-defaults: approval_mode = suggest (not autonomous)" \
    || fail "safe-defaults: approval_mode should be suggest"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Verdict
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "VERDICT: PASS"
  exit 0
else
  echo "VERDICT: FAIL"
  exit 1
fi
