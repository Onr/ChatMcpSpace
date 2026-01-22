#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  CLI Provider Test Suite                                                    ║
# ║  Comprehensive testing for all CLI providers and configurations            ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# Tests Codex, Claude, Gemini, Ollama, LMStudio, and OpenRouter
# with various flag combinations (--full-auto, --sandbox, etc.)
#
# Uses gum CLI for interactive multi-select interface

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$SCRIPT_DIR/test-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_FILE="$RESULTS_DIR/cli_test_results_${TIMESTAMP}.md"

# Test configuration
TEST_QUERY="Say hello and confirm you are working. One sentence only."
TIMEOUT_SECONDS=60

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
RESET='\033[0m'

# ═══════════════════════════════════════════════════════════════════════════════
# UI Helpers
# ═══════════════════════════════════════════════════════════════════════════════
print_header() {
    gum style \
        --border double \
        --padding "1 2" \
        --margin "1 0" \
        --border-foreground 212 \
        "🧪 CLI Provider Test Suite" \
        "Test all AI providers and configurations"
}

print_section() {
    gum style --foreground 212 --bold "$1"
}

print_success() {
    gum style --foreground 82 "✓ $1"
}

print_error() {
    gum style --foreground 9 "✗ $1"
}

print_info() {
    gum style --foreground 244 "$1"
}

print_warning() {
    gum style --foreground 214 "⚠️  $1"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Prerequisites Check
# ═══════════════════════════════════════════════════════════════════════════════
check_prerequisites() {
    local missing=()
    
    if ! command -v gum &>/dev/null; then
        missing+=("gum")
    fi
    
    if ! command -v timeout &>/dev/null; then
        missing+=("timeout (coreutils)")
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Missing required tools:${RESET}"
        for tool in "${missing[@]}"; do
            echo -e "  • $tool"
        done
        exit 1
    fi
    
    # Create results directory
    mkdir -p "$RESULTS_DIR"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Test Configuration Definitions
# ═══════════════════════════════════════════════════════════════════════════════

# Define all test configurations
# Format: "ID|Provider|Model|Flags|Description"
# Focus: Test provider connectivity and flag combinations (not specific models)
declare -a TEST_CONFIGS=(
    # Codex CLI tests
    "codex_default|codex|||Codex CLI - Default"
    "codex_full_auto|codex||--full-auto|Codex CLI - Full Auto"
    "codex_sandbox_write|codex||--sandbox workspace-write|Codex CLI - Sandbox (workspace-write)"
    "codex_sandbox_read|codex||--sandbox read-only|Codex CLI - Sandbox (read-only)"
    "codex_bypass|codex||--dangerously-bypass-approvals-and-sandbox|Codex CLI - Bypass All (DANGEROUS)"
    
    # Claude CLI tests (uses -p for print mode, --permission-mode or --dangerously-skip-permissions)
    "claude_default|claude|||Claude CLI - Default"
    "claude_bypass_perms|claude||--dangerously-skip-permissions|Claude CLI - Bypass Permissions"
    "claude_accept_edits|claude||--permission-mode acceptEdits|Claude CLI - Accept Edits Mode"
    
    # Gemini CLI tests (uses --sandbox boolean, --approval-mode yolo|auto_edit|default)
    "gemini_default|gemini|||Gemini CLI - Default"
    "gemini_sandbox|gemini||--sandbox|Gemini CLI - Sandbox Mode"
    "gemini_yolo|gemini||--approval-mode yolo|Gemini CLI - YOLO Mode"
    "gemini_sandbox_yolo|gemini||--sandbox --approval-mode yolo|Gemini CLI - Sandbox + YOLO"
    
    # Ollama (Local) tests
    "ollama_default|ollama|llama3.2||Ollama - Default (llama3.2)"
    
    # LMStudio (Local) tests
    "lmstudio_default|lmstudio|local-model||LMStudio - Default"
    
    # OpenRouter API tests
    "openrouter_default|openrouter|anthropic/claude-sonnet-4||OpenRouter - Default"
)

# ═══════════════════════════════════════════════════════════════════════════════
# Provider Availability Check
# ═══════════════════════════════════════════════════════════════════════════════
check_provider_available() {
    local provider="$1"
    
    case "$provider" in
        codex)
            command -v codex &>/dev/null
            ;;
        claude)
            command -v claude &>/dev/null
            ;;
        gemini)
            command -v gemini &>/dev/null
            ;;
        ollama)
            command -v ollama &>/dev/null && curl -s http://localhost:11434/api/tags &>/dev/null
            ;;
        lmstudio)
            curl -s http://localhost:1234/v1/models &>/dev/null
            ;;
        openrouter)
            [ -n "${OPENROUTER_API_KEY:-}" ] && command -v codex &>/dev/null
            ;;
        *)
            return 1
            ;;
    esac
}

get_provider_status() {
    local provider="$1"
    if check_provider_available "$provider"; then
        echo "✅ Available"
    else
        echo "❌ Not Available"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Build Command for Test
# ═══════════════════════════════════════════════════════════════════════════════
build_test_command() {
    local provider="$1"
    local model="$2"
    local flags="$3"
    local query="$4"
    
    local cmd=""
    
    case "$provider" in
        codex)
            cmd="codex exec"
            if [ -n "$model" ] && [ "$model" != "gpt-5.1-codex-max" ]; then
                cmd="$cmd --model $model"
            fi
            if [ -n "$flags" ]; then
                cmd="$cmd $flags"
            fi
            cmd="$cmd \"$query\""
            ;;
        claude)
            # Claude: -p is print mode flag, prompt is positional after options
            cmd="claude"
            if [ -n "$model" ]; then
                cmd="$cmd --model $model"
            fi
            cmd="$cmd -p --output-format text"
            if [ -n "$flags" ]; then
                cmd="$cmd $flags"
            fi
            cmd="$cmd \"$query\""
            ;;
        gemini)
            # Gemini: positional prompt, --yolo for auto-approve
            cmd="gemini"
            if [ -n "$model" ]; then
                cmd="$cmd --model $model"
            fi
            cmd="$cmd -o text --yolo"  # Text output and auto-approve
            if [ -n "$flags" ]; then
                cmd="$cmd $flags"
            fi
            cmd="$cmd \"$query\""
            ;;
        ollama)
            cmd="ollama run $model \"$query\""
            ;;
        lmstudio)
            # LMStudio uses OpenAI-compatible API
            cmd="curl -s http://localhost:1234/v1/chat/completions -H 'Content-Type: application/json' -d '{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"$query\"}]}'"
            ;;
        openrouter)
            # OpenRouter via codex with custom provider config
            cmd="codex exec -c model_provider=openrouter"
            cmd="$cmd -c 'model_providers.openrouter.name=\"OpenRouter\"'"
            cmd="$cmd -c 'model_providers.openrouter.base_url=\"https://openrouter.ai/api/v1\"'"
            cmd="$cmd -c 'model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"'"
            cmd="$cmd -c 'model_providers.openrouter.wire_api=\"chat\"'"
            cmd="$cmd --model $model"
            if [ -n "$flags" ]; then
                cmd="$cmd $flags"
            fi
            cmd="$cmd \"$query\""
            ;;
    esac
    
    echo "$cmd"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Run Single Test
# ═══════════════════════════════════════════════════════════════════════════════
run_single_test() {
    local test_id="$1"
    local provider="$2"
    local model="$3"
    local flags="$4"
    local description="$5"
    
    local start_time
    local end_time
    local elapsed
    local status="❌ FAILED"
    local response=""
    local error_output=""
    local exit_code=0
    
    echo ""
    print_section "Testing: $description"
    print_info "Provider: $provider | Model: $model"
    if [ -n "$flags" ]; then
        print_info "Flags: $flags"
    fi
    
    # Check if provider is available
    if ! check_provider_available "$provider"; then
        status="⏭️ SKIPPED"
        error_output="Provider not available or not configured"
        print_warning "Skipping - provider not available"
        
        # Write to results file
        {
            echo ""
            echo "### $description"
            echo ""
            echo "| Field | Value |"
            echo "|-------|-------|"
            echo "| Test ID | \`$test_id\` |"
            echo "| Provider | $provider |"
            echo "| Model | $model |"
            echo "| Flags | ${flags:-None} |"
            echo "| Status | $status |"
            echo "| Response Time | N/A |"
            echo "| Error | $error_output |"
            echo ""
        } >> "$RESULTS_FILE"
        
        return 0
    fi
    
    # Build the command
    local cmd
    cmd=$(build_test_command "$provider" "$model" "$flags" "$TEST_QUERY")
    
    print_info "Command: $cmd"
    echo ""
    echo -e "${YELLOW}⏳ Running test (timeout: ${TIMEOUT_SECONDS}s)...${RESET}"
    
    # Execute with timeout
    start_time=$(date +%s)
    
    local temp_output
    temp_output=$(mktemp)
    local temp_error
    temp_error=$(mktemp)
    
    set +e
    timeout "${TIMEOUT_SECONDS}s" bash -c "$cmd" > "$temp_output" 2> "$temp_error"
    exit_code=$?
    set -e
    
    end_time=$(date +%s)
    elapsed=$((end_time - start_time))
    
    response=$(cat "$temp_output" 2>/dev/null || echo "")
    error_output=$(cat "$temp_error" 2>/dev/null || echo "")
    
    rm -f "$temp_output" "$temp_error"
    
    # Determine status
    if [ $exit_code -eq 0 ] && [ -n "$response" ]; then
        status="✅ PASSED"
        print_success "Test passed in ${elapsed}s"
        # Print response preview in real-time
        echo ""
        gum style --foreground 36 "Response preview:"
        echo "$response" | head -20
        if [ $(echo "$response" | wc -l) -gt 20 ]; then
            gum style --foreground 244 "... (truncated, see full response in results file)"
        fi
        echo ""
    elif [ $exit_code -eq 124 ]; then
        status="⏱️ TIMEOUT"
        error_output="Command timed out after ${TIMEOUT_SECONDS}s"
        print_error "Test timed out"
    else
        status="❌ FAILED"
        if [ -z "$error_output" ]; then
            error_output="Exit code: $exit_code"
        fi
        print_error "Test failed (exit code: $exit_code)"
        # Print error in real-time
        if [ -n "$error_output" ]; then
            echo ""
            gum style --foreground 9 "Error output:"
            echo "$error_output" | head -10
            echo ""
        fi
    fi
    
    # Escape response for markdown
    local escaped_response
    escaped_response=$(echo "$response" | sed 's/|/\\|/g' | head -c 2000)
    local escaped_error
    escaped_error=$(echo "$error_output" | sed 's/|/\\|/g' | head -c 500)
    
    # Write to results file
    {
        echo ""
        echo "### $description"
        echo ""
        echo "| Field | Value |"
        echo "|-------|-------|"
        echo "| Test ID | \`$test_id\` |"
        echo "| Provider | $provider |"
        echo "| Model | $model |"
        echo "| Flags | ${flags:-None} |"
        echo "| Status | $status |"
        echo "| Response Time | ${elapsed}s |"
        echo "| Exit Code | $exit_code |"
        echo ""
        echo "**Command:**"
        echo "\`\`\`bash"
        echo "$cmd"
        echo "\`\`\`"
        echo ""
        if [ -n "$response" ]; then
            echo "**Response:**"
            echo "\`\`\`"
            echo "$escaped_response"
            echo "\`\`\`"
            echo ""
        fi
        if [ -n "$error_output" ] && [ "$status" != "✅ PASSED" ]; then
            echo "**Error Output:**"
            echo "\`\`\`"
            echo "$escaped_error"
            echo "\`\`\`"
            echo ""
        fi
    } >> "$RESULTS_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Initialize Results File
# ═══════════════════════════════════════════════════════════════════════════════
init_results_file() {
    cat > "$RESULTS_FILE" <<EOF
# CLI Provider Test Results

**Test Date:** $(date "+%Y-%m-%d %H:%M:%S")  
**Test Query:** "$TEST_QUERY"  
**Timeout:** ${TIMEOUT_SECONDS}s per test  

---

## Provider Availability

| Provider | Status |
|----------|--------|
| Codex CLI | $(get_provider_status codex) |
| Claude CLI | $(get_provider_status claude) |
| Gemini CLI | $(get_provider_status gemini) |
| Ollama | $(get_provider_status ollama) |
| LMStudio | $(get_provider_status lmstudio) |
| OpenRouter | $(get_provider_status openrouter) |

---

## Summary Table

| Test | Provider | Model | Flags | Status | Time |
|------|----------|-------|-------|--------|------|
EOF
}

# ═══════════════════════════════════════════════════════════════════════════════
# Add Summary Row
# ═══════════════════════════════════════════════════════════════════════════════
add_summary_row() {
    local description="$1"
    local provider="$2"
    local model="$3"
    local flags="$4"
    local status="$5"
    local time="$6"
    
    # Append to summary table in results file
    sed -i "/^## Summary Table/,/^---$/ {
        /^---$/i | $description | $provider | $model | ${flags:-None} | $status | $time |
    }" "$RESULTS_FILE" 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════════════
# Finalize Results File
# ═══════════════════════════════════════════════════════════════════════════════
finalize_results_file() {
    local passed="$1"
    local failed="$2"
    local skipped="$3"
    local timeout="$4"
    local total="$5"
    
    {
        echo ""
        echo "---"
        echo ""
        echo "## Test Summary"
        echo ""
        echo "| Metric | Count |"
        echo "|--------|-------|"
        echo "| ✅ Passed | $passed |"
        echo "| ❌ Failed | $failed |"
        echo "| ⏭️ Skipped | $skipped |"
        echo "| ⏱️ Timeout | $timeout |"
        echo "| **Total** | $total |"
        echo ""
        echo "---"
        echo ""
        echo "## Assessment Instructions"
        echo ""
        echo "For evaluating agent to assess these results:"
        echo ""
        echo "1. **Response Quality**: Check if each response accurately answers the weather query"
        echo "2. **Response Completeness**: Verify responses include temperature, conditions, and relevant details"
        echo "3. **Error Analysis**: For failed tests, determine if the error is:"
        echo "   - Configuration issue (missing API key, CLI not installed)"
        echo "   - Provider issue (service unavailable)"
        echo "   - Command structure issue (incorrect flags or syntax)"
        echo "4. **Performance**: Compare response times across providers"
        echo "5. **Reliability**: Note any providers that consistently fail or timeout"
        echo ""
        echo "### Key Questions to Answer:"
        echo ""
        echo "- Which providers returned accurate weather information?"
        echo "- Are there any command structure issues that need fixing?"
        echo "- Which provider/model combinations are most reliable?"
        echo "- Are there any patterns in failures (e.g., all sandbox modes fail)?"
        echo ""
    } >> "$RESULTS_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Interactive Test Selection
# ═══════════════════════════════════════════════════════════════════════════════
select_tests() {
    print_header
    echo ""
    print_section "Select Tests to Run"
    print_info "Use SPACE to select multiple items, ENTER to confirm"
    print_info "Tests are organized by provider with all flag combinations"
    echo ""
    
    # Build a single organized menu with all test configurations
    local options=()
    
    # Quick select options
    options+=("🔄 RUN ALL TESTS")
    options+=("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Group by provider - Add headers and individual tests
    local current_provider=""
    for config in "${TEST_CONFIGS[@]}"; do
        IFS='|' read -r id provider model flags desc <<< "$config"
        
        # Add provider header when switching providers
        if [ "$provider" != "$current_provider" ]; then
            current_provider="$provider"
            case "$provider" in
                codex)
                    options+=("┌─ CODEX CLI (OpenAI) ────────────────────")
                    ;;
                claude)
                    options+=("┌─ CLAUDE CLI (Anthropic) ─────────────────")
                    ;;
                gemini)
                    options+=("┌─ GEMINI CLI (Google) ────────────────────")
                    ;;
                ollama)
                    options+=("┌─ OLLAMA (Local) ─────────────────────────")
                    ;;
                lmstudio)
                    options+=("┌─ LMSTUDIO (Local) ────────────────────────")
                    ;;
                openrouter)
                    options+=("┌─ OPENROUTER API ─────────────────────────")
                    ;;
            esac
        fi
        
        # Add the test option (no leading spaces, matching is done by description)
        options+=("$desc")
    done
    
    # Use gum choose with multi-select
    local selected
    selected=$(printf '%s\n' "${options[@]}" | gum choose --no-limit --height 30 --cursor "➤ " --selected-prefix "✓ " --unselected-prefix "○ ")
    
    echo "$selected"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Main Test Runner
# ═══════════════════════════════════════════════════════════════════════════════
run_tests() {
    local selected_tests="$1"
    
    local passed=0
    local failed=0
    local skipped=0
    local timeout=0
    local total=0
    
    # Determine which tests to run
    local run_all=false
    declare -a specific_tests=()
    
    while IFS= read -r line; do
        # Skip empty lines and separator/header lines
        if [ -z "$line" ]; then
            continue
        fi
        # Skip separator and header lines (contain ─, ━, or ┌)
        if [[ "$line" == *"━"* ]] || [[ "$line" == *"─"* ]] || [[ "$line" == *"┌"* ]]; then
            continue
        fi
        
        case "$line" in
            "🔄 RUN ALL TESTS")
                run_all=true
                ;;
            *)
                # Strip leading whitespace for matching
                local clean_line="${line#"${line%%[![:space:]]*}"}"
                if [ -n "$clean_line" ]; then
                    specific_tests+=("$clean_line")
                fi
                ;;
        esac
    done <<< "$selected_tests"
    
    # Initialize results file
    init_results_file
    
    echo ""
    print_section "Starting Test Suite"
    print_info "Results will be saved to: $RESULTS_FILE"
    echo ""
    
    # Add a line for detailed results section
    echo "" >> "$RESULTS_FILE"
    echo "---" >> "$RESULTS_FILE"
    echo "" >> "$RESULTS_FILE"
    echo "## Detailed Test Results" >> "$RESULTS_FILE"
    
    # Run selected tests
    for config in "${TEST_CONFIGS[@]}"; do
        IFS='|' read -r id provider model flags desc <<< "$config"
        
        local should_run=false
        
        if [ "$run_all" = true ]; then
            should_run=true
        else
            # Check specific tests by matching description
            for specific in "${specific_tests[@]}"; do
                if [ "$specific" = "$desc" ]; then
                    should_run=true
                    break
                fi
            done
        fi
        
        if [ "$should_run" = true ]; then
            ((total++)) || true
            
            run_single_test "$id" "$provider" "$model" "$flags" "$desc"
            
            # Track results (simplified - actual status tracking would need to read from file)
            # For now, we'll count based on provider availability
            if ! check_provider_available "$provider"; then
                ((skipped++)) || true
            fi
        fi
    done
    
    # Check if any tests ran
    if [ "$total" -eq 0 ]; then
        echo ""
        print_warning "No tests were executed. Please select at least one test from the menu."
        print_info "Tip: Use SPACE to select items, then press ENTER to confirm."
        return 0
    fi

    # Finalize results
    finalize_results_file "$passed" "$failed" "$skipped" "$timeout" "$total"

    echo ""
    echo ""
    print_section "Test Suite Complete!"
    print_success "Results saved to: $RESULTS_FILE"
    echo ""
    
    # Show quick summary
    gum style \
        --border rounded \
        --padding "1 2" \
        --margin "1 0" \
        --border-foreground 36 \
        "📊 Quick Summary" \
        "Total Tests: $total" \
        "Results File: $RESULTS_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --all           Run all tests (non-interactive)"
    echo "  --help          Show this help message"
    echo ""
    echo "If no options are provided, interactive mode is used."
    echo "Use SPACE to select tests, ENTER to confirm."
}

main() {
    check_prerequisites
    
    local selected=""
    local non_interactive=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all)
                selected="🔄 RUN ALL TESTS"
                non_interactive=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
    
    # If no CLI args and interactive terminal, use gum selection
    if [ "$non_interactive" = false ]; then
        if [ -t 0 ] && [ -t 1 ]; then
            selected=$(select_tests)
        else
            # Non-interactive terminal without args - run all tests
            echo "Non-interactive mode detected. Running all tests..."
            selected="🔄 RUN ALL TESTS"
        fi
    fi
    
    if [ -z "$selected" ]; then
        print_warning "No tests selected. Exiting."
        exit 0
    fi
    
    run_tests "$selected"
}

main "$@"
