#!/usr/bin/env bash
#
# agent_cli_safety_test.sh
# ------------------------------------------------------------------------------
# Reusable "stranger's agent" safety test for the ChatMCP setup installer.
#
# Scenario it simulates:
#   A user downloads our bootstrap installer with
#       curl -sL https://chatmcp.space/setup
#   and asks THEIR OWN agent "is this safe to run?". We want to know what a
#   neutral agent, with zero knowledge that chatmcp.space is "us", concludes.
#
# Two review targets:
#   1. BOOTSTRAP (always): the public installer at $SETUP_URL. No credentials
#      needed. This is what a brand-new user first pipes into a shell.
#   2. PAYLOAD (opt-in, when CHATMCP_API_KEY is set): the REAL, per-user
#      second-stage script that the bootstrap fetches from
#      /api/agent/cli-script behind the X-API-Key header. This is the opaque
#      part a cold reviewer of the bootstrap can never see — so to judge it we
#      must fetch it with a valid key and review it directly.
#
# How it stays unbiased:
#   - The reviewer is a fresh `claude -p` process (NOT an in-session subagent,
#     which would inherit this repo's CLAUDE.md / memory that name chatmcp.space
#     as our own platform).
#   - It runs from a throwaway tmp dir, so no project CLAUDE.md and no
#     project-scoped memory are loaded.
#   - The prompt is a neutral security-audit prompt and never reveals the
#     script's origin. We do NOT coax the model toward "safe".
#
# Secret handling (PAYLOAD mode):
#   The real payload embeds the user's live API key and encryption salt. Before
#   the script is ever shown to the reviewer or written to a log, those lines
#   are redacted by anchored pattern match (^API_KEY= / ^ENCRYPTION_SALT=) to a
#   visible placeholder, and the raw copy is deleted immediately. The reviewer
#   therefore still SEES that credentials are embedded (a legitimate finding)
#   but never receives their actual values.
#
# Usage:
#   tests/agent_cli_safety_test.sh [SETUP_URL]
# Env overrides:
#   SETUP_URL        (default: https://chatmcp.space/setup)
#   CHATMCP_API_KEY  if set, also fetch + review the real per-user payload
#   CLI_SCRIPT_URL   (default: derived from SETUP_URL origin + /api/agent/cli-script)
#   MODEL            (default: claude-sonnet-4-6)
#   KEEP_TMP=1       keep the tmp working dir for inspection
#
# Exit code: 0 if the WORST verdict is SAFE, 2 if CAUTION, 3 if UNSAFE,
#            1 on harness error.
# ------------------------------------------------------------------------------
set -euo pipefail

SETUP_URL="${1:-${SETUP_URL:-https://chatmcp.space/setup}}"
MODEL="${MODEL:-claude-sonnet-4-6}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-results"
mkdir -p "$LOG_DIR"

# Derive the authenticated payload endpoint from the bootstrap origin unless the
# caller overrides it. (For file:// SETUP_URLs this is meaningless; auth mode is
# simply skipped unless CLI_SCRIPT_URL is given explicitly.)
BASE_ORIGIN="${SETUP_URL%/setup}"
CLI_SCRIPT_URL="${CLI_SCRIPT_URL:-${BASE_ORIGIN}/api/agent/cli-script}"

# Fresh, uniquely-named tmp dir => its own isolated claude project key
# (no project CLAUDE.md, no memory) => faithful "stranger's machine" reviewer.
TMP_DIR="$(mktemp -d "/tmp/agent-cli-safety-${STAMP}.XXXXXX")"
cleanup() { [ "${KEEP_TMP:-0}" = "1" ] || rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "== ChatMCP agent-cli safety test =="
echo "Bootstrap URL: $SETUP_URL"
if [ -n "${CHATMCP_API_KEY:-}" ]; then
    echo "Payload mode:  ON  ($CLI_SCRIPT_URL)"
else
    echo "Payload mode:  off (set CHATMCP_API_KEY to also review the real payload)"
fi
echo "Model:         $MODEL"
echo "Tmp:           $TMP_DIR"
echo

# Worst verdict seen across all reviewed targets (0=SAFE 2=CAUTION 3=UNSAFE).
WORST=0

# build_prompt <script_path> <out_prompt_path>
# Neutral security-audit prompt. Origin is NOT revealed. Asks for itemized
# findings (the actionable diagnosis) followed by a structured verdict.
build_prompt() {
    local script_path="$1" out="$2"
    {
        cat <<'EOP'
You are a security engineer. A user is about to download and run the shell
script below on their personal machine and has asked you: "Is this safe to
run?" You have NO other context about where it came from or who wrote it.

Review it as an independent auditor. Consider, among other things:
  - does it execute opaque/remote code it cannot show the user up front?
  - does it require sudo/root or modify system package sources?
  - does it pipe remote content straight into a shell?
  - does it verify integrity (checksums/signatures) of anything it fetches?
  - does it send or exfiltrate any sensitive data?
  - does it embed credentials or secrets in the file on disk?

First list your specific concerns as concise bullet points (or "none" if you
have none). Be honest and do not assume good intent or bad intent. Then end
your reply with EXACTLY these two lines:
VERDICT: <SAFE|CAUTION|UNSAFE>
REASON: <one sentence>

Here is the script:
--- BEGIN SCRIPT ---
EOP
        cat "$script_path"
        printf '\n--- END SCRIPT ---\n'
    } > "$out"
}

# review_target <label> <script_path> <log_file>
# Runs a fresh cold reviewer over <script_path>, prints + persists the verdict,
# and folds its verdict into WORST. Never executes the reviewed script.
review_target() {
    local label="$1" script_path="$2" log_file="$3"
    local prompt_file="$TMP_DIR/prompt_${label}.txt"
    local review_out="$TMP_DIR/review_${label}.txt"

    echo "----- Reviewing: $label ($(wc -l < "$script_path") lines) -----"
    build_prompt "$script_path" "$prompt_file"

    # Larger payloads need a longer budget than the small bootstrap. The prompt
    # is piped on stdin (not passed as an argv string): the real payload is
    # ~640 KB, which blows past ARG_MAX as a command-line argument.
    if ! ( cd "$TMP_DIR" && timeout 600 claude -p --model "$MODEL" < "$prompt_file" ) \
            > "$review_out" 2>&1; then
        echo "ERROR: reviewer agent failed for $label; see output below" >&2
        cat "$review_out" >&2
        exit 1
    fi

    {
        echo "TARGET=$label"
        echo "MODEL=$MODEL"
        echo "TIMESTAMP=$STAMP"
        echo "=== REVIEWER OUTPUT ==="
        cat "$review_out"
    } > "$log_file"

    echo "Verdict for $label:"
    grep -E '^(VERDICT|REASON):' "$review_out" || \
        echo "  (no structured verdict found; full output in $log_file)"
    echo "Full review saved to: $log_file"
    echo

    # Match worst verdicts first; "UNSAFE" contains the substring "SAFE", so
    # exact-token matching matters — never let UNSAFE fall through to SAFE.
    local vline
    vline="$(grep -E '^VERDICT:' "$review_out" | head -1 | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    case "$vline" in
        VERDICT:UNSAFE*)  [ "$WORST" -lt 3 ] && WORST=3 ;;
        VERDICT:CAUTION*) [ "$WORST" -lt 2 ] && WORST=2 ;;
        VERDICT:SAFE*)    : ;;
        *)                echo "ERROR: unparseable verdict for $label" >&2; exit 1 ;;
    esac
}

# ------------------------------------------------------------------------------
# Target 1: the public bootstrap installer (always).
# ------------------------------------------------------------------------------
BOOT_PATH="$TMP_DIR/setup.sh"
if ! curl -sL --fail "$SETUP_URL" -o "$BOOT_PATH"; then
    echo "ERROR: failed to download bootstrap $SETUP_URL" >&2
    exit 1
fi
if [ ! -s "$BOOT_PATH" ]; then
    echo "ERROR: downloaded bootstrap is empty" >&2
    exit 1
fi
review_target "bootstrap" "$BOOT_PATH" \
    "$LOG_DIR/agent_cli_bootstrap_${STAMP}.log"

# ------------------------------------------------------------------------------
# Target 2: the real per-user payload (opt-in, requires a valid API key).
# ------------------------------------------------------------------------------
if [ -n "${CHATMCP_API_KEY:-}" ]; then
    RAW_PAYLOAD="$TMP_DIR/payload.raw"
    HTTP_CODE="$(curl -sL -o "$RAW_PAYLOAD" -w '%{http_code}' \
        -H "X-API-Key: $CHATMCP_API_KEY" "$CLI_SCRIPT_URL" || true)"
    if [ "$HTTP_CODE" != "200" ]; then
        echo "ERROR: failed to fetch payload (HTTP $HTTP_CODE) from $CLI_SCRIPT_URL" >&2
        [ "$HTTP_CODE" = "401" ] && echo "  -> CHATMCP_API_KEY rejected. Check the key." >&2
        rm -f "$RAW_PAYLOAD"
        exit 1
    fi

    # Redact embedded secrets by anchored line match BEFORE the payload is shown
    # to the reviewer or written anywhere, then delete the raw copy. The salt is
    # server-generated (value unknown to us), so we match by line, not by value.
    REDACTED_PAYLOAD="$TMP_DIR/payload.redacted.sh"
    sed -E \
        -e 's/^(API_KEY=).*/\1"<REDACTED-BY-HARNESS>"/' \
        -e 's/^(ENCRYPTION_SALT=).*/\1"<REDACTED-BY-HARNESS>"/' \
        "$RAW_PAYLOAD" > "$REDACTED_PAYLOAD"
    rm -f "$RAW_PAYLOAD"

    # Safety net: if any secret-shaped token survived redaction, abort rather
    # than risk leaking it into the model context or a log file. Matches the
    # UUID-shaped API key AND any 32+ char hex run (the encryption salt is
    # server-generated 64-hex, so value-based redaction can't anticipate it).
    if grep -qE '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32,})' "$REDACTED_PAYLOAD"; then
        echo "ERROR: a secret-shaped token survived redaction; aborting to avoid leaking a secret." >&2
        exit 1
    fi

    review_target "payload" "$REDACTED_PAYLOAD" \
        "$LOG_DIR/agent_cli_payload_${STAMP}.log"
fi

# ------------------------------------------------------------------------------
echo "===== Overall result ====="
case "$WORST" in
    0) echo "Worst verdict: SAFE";    exit 0 ;;
    2) echo "Worst verdict: CAUTION"; exit 2 ;;
    3) echo "Worst verdict: UNSAFE"; exit 3 ;;
esac
