/**
 * API Guide Generator
 * Generates a gum-based CLI main script for agent management
 */
const { AGENT_CLI_VERSION } = require('./agentCliVersion');
const modelDiscoverySource = require('fs').readFileSync(require('path').join(__dirname, '../../scripts/discover-provider-models.js'), 'utf8');

function isNonProductionEnv() {
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    return env !== 'production';
}

function resolveHasEncryption(encryptionSalt) {
    const hasEncryption = typeof encryptionSalt === 'string' && encryptionSalt.trim().length > 0;
    if (!hasEncryption && !isNonProductionEnv()) {
        throw new Error('ENCRYPTION_SALT is required in production. Non-encrypted mode is allowed only in non-production testing.');
    }
    return hasEncryption;
}

function getCurrentAgentCliVersion() {
    return AGENT_CLI_VERSION;
}

/**
 * Generate the main CLI script that manages all agents
 * @param {string} apiKey - User's API key
 * @param {string} baseUrl - Base URL of the application
 * @param {string} encryptionSalt - User's encryption salt for E2E encryption (non-encrypted mode allowed only in non-production testing)
 * @returns {string} The main CLI bash script
 */
function generateMainCLIScript(apiKey, baseUrl, encryptionSalt = null) {
    const apiBase = `${baseUrl}/api`;
    const hasEncryption = resolveHasEncryption(encryptionSalt);

    // Generate the embedded Python helper content
    const pythonHelper = generateMessageHelperPython(hasEncryption);
    const agentInstructions = generateAgentInstructions();
    const newsFeedAgentInstructions = generateNewsFeedAgentInstructions();
    const oneshotInstructions = generateOneshotInstructions();
    const agentRunner = generateAgentRunner();
    const richFormSkill = generateRichFormSkill();
    const selfWakeGuide = generateSelfWakeGuide();

    return `#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  Agent Messaging Platform - Agent CLI                                      ║
# ║  Interactive agent management with gum CLI                                 ║
# ╚════════════════════════════════════════════════════════════════════════════╝
#
# This script manages AI agents for the messaging platform.
#
# Features:
#   - Create new agents with guided setup
#   - Continue existing agent sessions  
#   - Configure model providers (Codex, Claude, Gemini, Copilot, Antigravity, Pi, Ollama, LMStudio, OpenRouter)
#   - Select approval modes (full-auto, auto-edit, suggest)
#   - Configure sandbox modes (none, workspace-write, read-only)
#   - View and manage agent status
#
# UI Helper Functions:
#   - print_header()   - Display styled header box
#   - print_section()  - Display section title in bold
#   - print_success()  - Display success message with ✓
#   - print_error()    - Display error message with ✗
#   - print_info()     - Display info message in gray
#   - print_warning()  - Display warning message with ⚠️
#   - confirm_command() - Show command confirmation dialog with working directory
#
# Generated for your account - KEEP THIS FILE SECURE!
# Do not share this file as it contains your API credentials.

set -euo pipefail
trap 'echo "agent-cli.sh: unexpected error on line $LINENO (exit code: $?). Run with \\"bash -x agent-cli.sh\\" for details." >&2' ERR

# ═══════════════════════════════════════════════════════════════════════════════
# Version & Configuration
# ═══════════════════════════════════════════════════════════════════════════════
# MAINTAINER NOTE:
# - Bump this version whenever generated agent CLI/runtime behavior changes.
# - Keep it in sync with src/utils/agentCliVersion.js (AGENT_CLI_VERSION).
CLI_VERSION="${AGENT_CLI_VERSION}"

# Configuration (embedded from your account)
API_KEY="${apiKey}"
ENCRYPTION_SALT="${hasEncryption ? encryptionSalt : ''}"
API_BASE="${apiBase}"
HAS_ENCRYPTION="${hasEncryption ? 'true' : 'false'}"

# Script location
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CHATSPACE_DIR="$SCRIPT_DIR/.chatspace"

# Colors for non-gum output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
CYAN='\\033[0;36m'
RESET='\\033[0m'

# Startup status messages (no gum dependency)
print_bootstrap_info() {
    local msg="$1"
    local ts
    ts=$(date +"%H:%M:%S" 2>/dev/null || echo "??:??:??")
    echo -e "\${BLUE}[\${ts}]\${RESET} $msg"
}

print_bootstrap_warning() {
    local msg="$1"
    local ts
    ts=$(date +"%H:%M:%S" 2>/dev/null || echo "??:??:??")
    echo -e "\${YELLOW}[\${ts}] ⚠️\${RESET} $msg"
}

# ═══════════════════════════════════════════════════════════════════════════════
# CLI ARGUMENT DEFINITIONS (HEADLESS MODE)
# ═══════════════════════════════════════════════════════════════════════════════
# MAINTAINABILITY RULE: Every gum prompt in this script MUST have a corresponding
# CLI argument. When adding new interactive prompts, add a matching --flag here.
# This ensures the script can run fully headless with identical behavior.
#
# Format: ARG_NAME="default"  # --flag-name: Description (mirrors: function_name)
# ═══════════════════════════════════════════════════════════════════════════════

# Action arguments
ARG_HEADLESS=false           # --headless: Enable non-interactive mode
ARG_CREATE=""                # --create <name>: Create new agent (mirrors: create_agent)
ARG_CONTINUE=""              # --continue <name>: Continue existing agent (mirrors: run_agent)
ARG_STOP=""                  # --stop <name>: Request running agent stop (mirrors: stop_agent_control)
ARG_DELETE=""                # --delete <name>: Delete agent locally and from backend when possible
ARG_LIST=false               # --list: List existing agents
ARG_NEWS_FEED=false          # --news-feed: Create/recreate the Local News Feed agent
ARG_LOCAL_COS=false          # --local-cos: Install the Local Chief of Staff on THIS machine
ARG_CONFIG=""                # --config <file>: Load settings from JSON file
ARG_START=""                 # --start <name>: Start agent in background (tmux, auto-restart on crash)
ARG_RESTART=""               # --restart <name>: Stop the running session (if any) and start it again
ARG_SHUTDOWN=""              # --shutdown <name>: Stop the agent's background session
ARG_STATUS=false             # --status: Show which agents have a running background session
ARG_INSTALL_COMMAND=""       # --install-command [name]: Install a global launcher (default: chatspace)
ARG_PERMS_EXPLICIT=false     # set when any provider/permission flag is passed (see below)

# Agent configuration
ARG_PASSWORD=""              # --password <pwd>: Account password for E2E encryption
ARG_PROJECT_PATH=""          # --project-path <path>: Working directory (default: pwd)
ARG_SETUP_PROFILE="wizard"   # --setup-profile <wizard|max-access>: Permission setup preset
ARG_AUTO_START=true          # --no-auto-start: Don't start agent after config
ARG_SKIP_NEWS_FEED=false     # --skip-news-feed: Skip news feed creation prompt
ARG_SKIP_LOCAL_COS=false     # --skip-local-cos: Skip Local Chief of Staff prompt

# Provider permissions (defaults are sandbox-first; pass the explicit flags
# below to opt in to unsandboxed / bypass modes)
ARG_PROVIDERS="codex"                    # --providers <list>: Comma-separated (mirrors: Step 1)
ARG_CODEX_SANDBOX="workspace-write"      # --codex-sandbox <modes>: Comma-separated (add danger-full-access to opt in)
ARG_CODEX_BYPASS=false                   # --codex-bypass: Allow dangerous bypass flag
ARG_CLAUDE_MODES="default"               # --claude-modes <modes>: Comma-separated
ARG_CLAUDE_SKIP_PERMS=false              # --claude-skip-perms: Allow skip permissions
ARG_GEMINI_SANDBOX=false                 # --gemini-sandbox: Allow sandboxed mode (requires Docker)
ARG_GEMINI_NO_SANDBOX=true               # --gemini-no-sandbox: Allow full access (default: true, Docker not required)
ARG_GEMINI_YOLO=true                     # --gemini-yolo: Allow auto-approve all (needed for autonomous operation)
ARG_ANTIGRAVITY_SANDBOX="workspace-write"  # --antigravity-sandbox <modes>: Comma-separated (add danger-full-access to opt in)
ARG_ANTIGRAVITY_SKIP_PERMS=false         # --antigravity-skip-perms: Allow dangerous skip permissions (explicit opt-in)
ARG_KILO_AUTO=false                      # --kilo-auto: Allow --auto for Kilo CLI

# Inter-agent communication (mirrors: Step 3)
ARG_INTER_AGENT="listen_all"             # --inter-agent <mode>: disabled|listen_all|groups
ARG_INTER_AGENT_GROUP=""                 # --inter-agent-group <name>: Group to join/create
ARG_GROUP_PASSWORD=""                    # --group-password <pwd>: Encrypted group password

# "--continue <name>" must not overwrite an existing agent's saved provider,
# model and permissions with the flag defaults above. Only rebuild them when the
# caller explicitly passed a provider/permission flag.
for _cli_arg in "$@"; do
    case "$_cli_arg" in
        --allow-all|--safe-defaults|--setup-profile|--providers|--config|\\
        --codex-*|--claude-*|--gemini-*|--no-gemini-sandbox|--antigravity-*|--kilo-auto|\\
        --inter-agent|--inter-agent-group|--group-password)
            ARG_PERMS_EXPLICIT=true
            ;;
    esac
done

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --headless)
            ARG_HEADLESS=true
            shift
            ;;
        --create)
            ARG_CREATE="$2"
            shift 2
            ;;
        --continue)
            ARG_CONTINUE="$2"
            shift 2
            ;;
        --stop)
            ARG_STOP="$2"
            shift 2
            ;;
        --delete)
            ARG_DELETE="$2"
            shift 2
            ;;
        --list)
            ARG_LIST=true
            shift
            ;;
        --start)
            ARG_START="$2"
            shift 2
            ;;
        --restart)
            ARG_RESTART="$2"
            shift 2
            ;;
        --shutdown)
            ARG_SHUTDOWN="$2"
            shift 2
            ;;
        --status)
            ARG_STATUS=true
            shift
            ;;
        --install-command)
            if [ -n "\${2:-}" ] && [ "$(printf '%s' "$2" | cut -c1-2)" != "--" ]; then
                ARG_INSTALL_COMMAND="$2"
                shift 2
            else
                ARG_INSTALL_COMMAND="chatspace"
                shift
            fi
            ;;
        --news-feed)
            ARG_NEWS_FEED=true
            shift
            ;;
        --local-cos|--local-chief-of-staff)
            ARG_LOCAL_COS=true
            shift
            ;;
        --skip-local-cos|--skip-local-chief-of-staff)
            ARG_SKIP_LOCAL_COS=true
            shift
            ;;
        --config)
            ARG_CONFIG="$2"
            shift 2
            ;;
        --password)
            ARG_PASSWORD="$2"
            shift 2
            ;;
        --project-path)
            ARG_PROJECT_PATH="$2"
            shift 2
            ;;
        --setup-profile)
            ARG_SETUP_PROFILE="$2"
            shift 2
            ;;
        --allow-all)
            # Shorthand for the max-access profile: allow all providers and
            # skip all permission prompts. Mirrors the interactive "Allow all"
            # choice at the start of agent creation.
            ARG_SETUP_PROFILE="max-access"
            shift
            ;;
        --safe-defaults)
            # Explicit opposite of --allow-all: build per-provider permissions
            # from safe individual defaults. This actively clamps the dangerous
            # provider defaults (danger-full-access, --yolo, skip-permissions,
            # approval bypass) down to their safe values so the resulting agent
            # is not granted autonomous full access. The no-flag ARG_* defaults
            # are intentionally left unchanged for back-compat with existing
            # scripted callers — only this opt-in flag tightens them.
            ARG_SETUP_PROFILE="wizard"
            ARG_CODEX_SANDBOX="workspace-write"
            ARG_CODEX_BYPASS=false
            ARG_CLAUDE_SKIP_PERMS=false
            ARG_GEMINI_SANDBOX=false
            ARG_GEMINI_NO_SANDBOX=false
            ARG_GEMINI_YOLO=false
            ARG_ANTIGRAVITY_SANDBOX="workspace-write"
            ARG_ANTIGRAVITY_SKIP_PERMS=false
            ARG_KILO_AUTO=false
            shift
            ;;
        --no-auto-start)
            ARG_AUTO_START=false
            shift
            ;;
        --skip-news-feed)
            ARG_SKIP_NEWS_FEED=true
            shift
            ;;
        --providers)
            ARG_PROVIDERS="$2"
            shift 2
            ;;
        --codex-sandbox)
            ARG_CODEX_SANDBOX="$2"
            shift 2
            ;;
        --codex-bypass)
            ARG_CODEX_BYPASS=true
            shift
            ;;
        --claude-modes)
            ARG_CLAUDE_MODES="$2"
            shift 2
            ;;
        --claude-skip-perms)
            ARG_CLAUDE_SKIP_PERMS=true
            shift
            ;;
        --gemini-sandbox)
            ARG_GEMINI_SANDBOX=true
            shift
            ;;
        --no-gemini-sandbox)
            ARG_GEMINI_SANDBOX=false
            shift
            ;;
        --gemini-no-sandbox)
            ARG_GEMINI_NO_SANDBOX=true
            shift
            ;;
        --gemini-yolo)
            ARG_GEMINI_YOLO=true
            shift
            ;;
        --antigravity-sandbox)
            ARG_ANTIGRAVITY_SANDBOX="$2"
            shift 2
            ;;
        --antigravity-skip-perms)
            ARG_ANTIGRAVITY_SKIP_PERMS=true
            shift
            ;;
        --kilo-auto)
            ARG_KILO_AUTO=true
            shift
            ;;
        --inter-agent)
            ARG_INTER_AGENT="$2"
            shift 2
            ;;
        --inter-agent-group)
            ARG_INTER_AGENT_GROUP="$2"
            shift 2
            ;;
        --group-password)
            ARG_GROUP_PASSWORD="$2"
            shift 2
            ;;
        --help)
            echo "Usage: bash agent-cli.sh [OPTIONS]"
            echo ""
            echo "ACTION OPTIONS:"
            echo "  --headless              Run in non-interactive mode"
            echo "  --create <name>         Create new agent with given name"
            echo "  --continue <name>       Continue existing agent"
            echo "  --stop <name>           Request a running agent to stop current task"
            echo "  --delete <name>         Delete an agent and remove its local folder"
            echo "  --list                  List existing agents"
            echo "  --news-feed             Create (or recreate) the Local News Feed agent"
            echo "  --local-cos             Install the Local Chief of Staff on this machine"
            echo "  --config <file>         Load settings from JSON file"
            echo ""
            echo "BACKGROUND CONTROL (no manual tmux kill/cleanup needed):"
            echo "  --start <name>          Start agent in a background tmux session (restarts on crash)"
            echo "  --restart <name>        Stop the running session (if any) and start it again"
            echo "  --shutdown <name>       Stop the agent's background session"
            echo "  --status                Show which agents are running in the background"
            echo "  --install-command [cmd] Install a global launcher (default: chatspace) so"
            echo "                          the CLI can be run from any directory"
            echo ""
            echo "AGENT CONFIGURATION:"
            echo "  --password <pwd>        Account password (for E2E encryption)"
            echo "  --project-path <path>   Working directory (default: current dir)"
            echo "  --setup-profile <name>  wizard or max-access"
            echo "  --allow-all             Allow all providers & skip ALL permission prompts (= max-access)"
            echo "  --safe-defaults         Set individual per-provider defaults (recommended; = wizard)"
            echo "  --no-auto-start         Don't start agent after configuration"
            echo "  --skip-news-feed        Skip news feed creation prompt"
            echo "  --skip-local-cos        Skip Local Chief of Staff prompt"
            echo ""
            echo "PROVIDER PERMISSIONS:"
            echo "  --providers <list>      Comma-separated: codex,claude,gemini,copilot,antigravity,pi,kilo,ollama,openrouter"
            echo "  --codex-sandbox <modes> Comma-separated: read-only,workspace-write,danger-full-access"
            echo "  --codex-bypass          Allow --dangerously-bypass-approvals-and-sandbox"
            echo "  --claude-modes <modes>  Comma-separated: default,acceptEdits,plan,bypassPermissions"
            echo "  --claude-skip-perms     Allow --dangerously-skip-permissions"
            echo "  --gemini-sandbox        Allow --sandbox (default: true)"
            echo "  --no-gemini-sandbox     Disallow --sandbox"
            echo "  --gemini-no-sandbox     Allow --no-sandbox (full access)"
            echo "  --gemini-yolo           Allow --yolo (auto-approve all)"
            echo "  --antigravity-sandbox <modes> Comma-separated: workspace-write,danger-full-access"
            echo "  --antigravity-skip-perms Allow --dangerously-skip-permissions"
            echo "  --kilo-auto             Allow kilo run --auto (non-interactive)"
            echo ""
            echo "INTER-AGENT COMMUNICATION:"
            echo "  --inter-agent <mode>    Mode: disabled, listen_all, groups"
            echo "  --inter-agent-group <n> Group name to join or create"
            echo "  --group-password <pwd>  Password for encrypted group"
            echo ""
            echo "EXAMPLES:"
            echo "  # Create agent with defaults (workspace + full-access codex)"
            echo "  bash agent-cli.sh --headless --create MyAgent"
            echo ""
            echo "  # Create agent with full permissions"
            echo "  bash agent-cli.sh --headless --create MyAgent \\\\"
            echo "    --providers codex,claude --codex-sandbox danger-full-access --codex-bypass"
            echo ""
            echo "  # Load from config file"
            echo "  bash agent-cli.sh --headless --config agent-config.json"
            exit 0
            ;;
        *)
            # Unknown option, ignore in headless mode
            shift
            ;;
    esac
done

# Load config file if specified
if [ -n "$ARG_CONFIG" ] && [ -f "$ARG_CONFIG" ]; then
    if command -v jq &>/dev/null; then
        # Parse JSON config file
        [ -z "$ARG_CREATE" ] && ARG_CREATE=$(jq -r '.agentName // empty' "$ARG_CONFIG")
        [ -z "$ARG_PASSWORD" ] && ARG_PASSWORD=$(jq -r '.password // empty' "$ARG_CONFIG")
        [ -z "$ARG_PROJECT_PATH" ] && ARG_PROJECT_PATH=$(jq -r '.projectPath // empty' "$ARG_CONFIG")
        cfg_setup_profile=$(jq -r '.setupProfile // empty' "$ARG_CONFIG")
        [ -n "$cfg_setup_profile" ] && ARG_SETUP_PROFILE="$cfg_setup_profile"
        
        # Providers
        cfg_providers=$(jq -r '.providers // empty | if type == "array" then join(",") else . end' "$ARG_CONFIG")
        [ -n "$cfg_providers" ] && ARG_PROVIDERS="$cfg_providers"

        # Codex settings
        cfg_codex_sandbox=$(jq -r '.codex.sandbox // empty | if type == "array" then join(",") else . end' "$ARG_CONFIG")
        [ -n "$cfg_codex_sandbox" ] && ARG_CODEX_SANDBOX="$cfg_codex_sandbox"
        [ "$(jq -r '.codex.bypass // false' "$ARG_CONFIG")" = "true" ] && ARG_CODEX_BYPASS=true

        # Claude settings
        cfg_claude_modes=$(jq -r '.claude.modes // empty | if type == "array" then join(",") else . end' "$ARG_CONFIG")
        [ -n "$cfg_claude_modes" ] && ARG_CLAUDE_MODES="$cfg_claude_modes"
        [ "$(jq -r '.claude.skipPermissions // false' "$ARG_CONFIG")" = "true" ] && ARG_CLAUDE_SKIP_PERMS=true

        # Gemini settings
        [ "$(jq -r '.gemini.sandbox // true' "$ARG_CONFIG")" = "true" ] && ARG_GEMINI_SANDBOX=true
        [ "$(jq -r '.gemini.noSandbox // false' "$ARG_CONFIG")" = "true" ] && ARG_GEMINI_NO_SANDBOX=true
        [ "$(jq -r '.gemini.yolo // false' "$ARG_CONFIG")" = "true" ] && ARG_GEMINI_YOLO=true
        [ "$(jq -r '.kilo.auto // false' "$ARG_CONFIG")" = "true" ] && ARG_KILO_AUTO=true

        # Inter-agent settings
        cfg_inter_mode=$(jq -r '.interAgent.mode // empty' "$ARG_CONFIG")
        [ -n "$cfg_inter_mode" ] && ARG_INTER_AGENT="$cfg_inter_mode"
        cfg_inter_group=$(jq -r '.interAgent.group // empty' "$ARG_CONFIG")
        [ -n "$cfg_inter_group" ] && ARG_INTER_AGENT_GROUP="$cfg_inter_group"
        cfg_group_pwd=$(jq -r '.interAgent.groupPassword // empty' "$ARG_CONFIG")
        [ -n "$cfg_group_pwd" ] && ARG_GROUP_PASSWORD="$cfg_group_pwd"
    else
        echo "Error: jq is required to parse config files"
        exit 1
    fi
fi

# Remember whether the caller chose a project path before defaulting it, so
# "--continue" keeps the agent's saved project_path unless one was passed.
ARG_PROJECT_PATH_EXPLICIT=false
[ -n "$ARG_PROJECT_PATH" ] && ARG_PROJECT_PATH_EXPLICIT=true

# Set default project path if not specified
[ -z "$ARG_PROJECT_PATH" ] && ARG_PROJECT_PATH="$(pwd)"

# In headless mode, skip news feed by default
[ "$ARG_HEADLESS" = "true" ] && ARG_SKIP_NEWS_FEED=true

# ═══════════════════════════════════════════════════════════════════════════════
# Prerequisite Checks
# ═══════════════════════════════════════════════════════════════════════════════
refresh_common_tool_paths() {
    # Make tools installed into per-user locations available in fresh shells too.
    export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"
    hash -r 2>/dev/null || true
}

check_prerequisites() {
    refresh_common_tool_paths

    local missing=()
    
    if ! command -v gum &>/dev/null; then
        missing+=("gum")
    fi
    
    local has_any_cli=false
    if command -v codex &>/dev/null || command -v claude &>/dev/null || command -v gemini &>/dev/null || command -v copilot &>/dev/null || command -v pi &>/dev/null || command -v kilo &>/dev/null; then
        has_any_cli=true
    fi
    
    if [ "$has_any_cli" = false ]; then
        missing+=("AI_CLI")
    fi
    
    if ! command -v uv &>/dev/null; then
        missing+=("uv")
    fi

    if ! command -v jq &>/dev/null; then
        missing+=("jq")
    fi

    if [ \${#missing[@]} -gt 0 ]; then
        echo -e "\${RED}Missing required tools:\${RESET}"
        local still_missing=()
        for tool in "\${missing[@]}"; do
            case "$tool" in
                gum)
                    echo -e "  • gum (interactive UI toolkit) is missing."
                    read -p "  Do you want to install gum now? [y/N] " -n 1 -r
                    echo ""
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo "Installing gum..."
                        if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
                            brew install gum
                        elif command -v apt-get &>/dev/null; then
                            sudo mkdir -p /etc/apt/keyrings
                            curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null
                            echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list >/dev/null
                            sudo apt update -qq && sudo apt install -y gum
                        elif command -v dnf &>/dev/null; then
                            echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/yum.repos.d/charm.repo >/dev/null
                            sudo dnf install -y gum
                        elif command -v pacman &>/dev/null; then
                            sudo pacman -Sy --noconfirm gum
                        elif command -v brew &>/dev/null; then
                            brew install gum
                        else
                            echo "  Could not detect package manager. Trying go install..."
                            if command -v go &>/dev/null; then
                                go install github.com/charmbracelet/gum@latest
                            else
                                echo -e "\${RED}  Could not install gum automatically.\${RESET}"
                                echo "  Please install manually: https://github.com/charmbracelet/gum#installation"
                            fi
                        fi
                        if command -v gum &>/dev/null; then
                            echo -e "\${GREEN}gum installed successfully.\${RESET}"
                        else
                            echo -e "\${RED}gum installation failed.\${RESET}"
                            echo "  Install manually: https://github.com/charmbracelet/gum#installation"
                            still_missing+=("gum")
                        fi
                    else
                        echo -e "  • gum - Install: https://github.com/charmbracelet/gum#installation"
                        still_missing+=("gum")
                    fi
                    ;;
                AI_CLI)
                    echo -e "  • No AI CLI detected (codex, claude, gemini, copilot, antigravity, pi)."
                    echo -e "    You need at least one AI CLI tool installed to run agents."
                    read -p "  Do you want to install Claude CLI now? [y/N] " -n 1 -r
                    echo ""
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo "Installing Claude CLI..."
                        npm install -g @anthropic-ai/claude-code
                        if command -v claude &>/dev/null; then
                            echo -e "\${GREEN}Claude CLI installed successfully.\${RESET}"
                        else
                             echo -e "\${RED}Claude CLI installation failed. Please make sure Node.js is installed.\${RESET}"
                             still_missing+=("AI_CLI")
                        fi
                    else
                        read -p "  Do you want to install Gemini CLI now? [y/N] " -n 1 -r
                        echo ""
                        if [[ $REPLY =~ ^[Yy]$ ]]; then
                            echo "Installing Gemini CLI..."
                            npm install -g @google/gemini-cli
                            if command -v gemini &>/dev/null; then
                                echo -e "\${GREEN}Gemini CLI installed successfully.\${RESET}"
                            else
                                 echo -e "\${RED}Gemini CLI installation failed.\${RESET}"
                                 still_missing+=("AI_CLI")
                            fi
                        else
                            read -p "  Do you want to install Codex CLI now? [y/N] " -n 1 -r
                            echo ""
                            if [[ $REPLY =~ ^[Yy]$ ]]; then
                                echo "Installing Codex CLI..."
                                npm install -g @openai/codex
                                if command -v codex &>/dev/null; then
                                    echo -e "\${GREEN}Codex CLI installed successfully.\${RESET}"
                                else
                                     echo -e "\${RED}Codex CLI installation failed.\${RESET}"
                                     still_missing+=("AI_CLI")
                                fi
                            else
                                read -p "  Do you want to install Pi CLI now? [y/N] " -n 1 -r
                                echo ""
                                if [[ $REPLY =~ ^[Yy]$ ]]; then
                                    echo "Installing Pi CLI..."
                                    npm install -g @mariozechner/pi-coding-agent
                                    if command -v pi &>/dev/null; then
                                        echo -e "\${GREEN}Pi CLI installed successfully.\${RESET}"
                                    else
                                         echo -e "\${RED}Pi CLI installation failed.\${RESET}"
                                         still_missing+=("AI_CLI")
                                    fi
                                else
                                    echo -e "  • You must install at least one AI CLI manually to continue."
                                    still_missing+=("AI_CLI")
                                fi
                            fi
                        fi
                    fi
                    ;;
                uv)
                    echo -e "  • uv is missing."
                    read -p "  Do you want to install uv now? [y/N] " -n 1 -r
                    echo ""
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo "Installing uv..."
                        curl -LsSf https://astral.sh/uv/install.sh | sh
                        refresh_common_tool_paths
                        if command -v uv &>/dev/null; then
                            echo -e "\${GREEN}uv installed successfully.\${RESET}"
                        else
                             echo -e "\${RED}uv installation failed or not found in PATH.\${RESET}"
                             still_missing+=("uv")
                        fi
                    else
                        echo -e "  • uv - Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
                        still_missing+=("uv")
                    fi
                    ;;
                jq)
                    echo -e "  • jq (JSON processor) is missing."
                    read -p "  Do you want to install jq now? [y/N] " -n 1 -r
                    echo ""
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo "Installing jq..."
                        if [[ "$OSTYPE" == "darwin"* ]] && command -v brew &>/dev/null; then
                            brew install jq
                        elif command -v apt-get &>/dev/null; then
                            sudo apt-get install -y jq
                        elif command -v dnf &>/dev/null; then
                            sudo dnf install -y jq
                        elif command -v pacman &>/dev/null; then
                            sudo pacman -Sy --noconfirm jq
                        elif command -v brew &>/dev/null; then
                            brew install jq
                        else
                            echo -e "\${RED}  Could not detect package manager to install jq.\${RESET}"
                            echo "  Please install manually: https://jqlang.github.io/jq/download/"
                        fi
                        if command -v jq &>/dev/null; then
                            echo -e "\${GREEN}jq installed successfully.\${RESET}"
                        else
                            echo -e "\${RED}jq installation failed.\${RESET}"
                            echo "  Install manually: https://jqlang.github.io/jq/download/"
                            still_missing+=("jq")
                        fi
                    else
                        echo -e "  • jq - Install: https://jqlang.github.io/jq/download/"
                        still_missing+=("jq")
                    fi
                    ;;
            esac
        done

        if [ \${#still_missing[@]} -gt 0 ]; then
            echo -e "\${RED}Please install missing tools and try again.\${RESET}"
            exit 1
        fi
    fi
    
    # Fix cache permissions to prevent permission errors during package installs
    fix_cache_permissions
}

# ═══════════════════════════════════════════════════════════════════════════════
# Cache Permission Fix
# ═══════════════════════════════════════════════════════════════════════════════
fix_cache_permissions() {
    # Ensure uv cache directory exists and is writable
    # This prevents "Permission denied" errors when agents install packages
    local cache_dirs=(
        "$HOME/.cache/uv"
        "$HOME/.local/bin"
        "$HOME/.local/share/uv"
    )
    
    for dir in "\${cache_dirs[@]}"; do
        if [ -d "$dir" ]; then
            # Check if directory is writable
            if [ ! -w "$dir" ]; then
                echo -e "\${YELLOW}Fixing permissions for $dir...\${RESET}"
                # Try to fix permissions, may fail if owned by root
                if ! chmod -R u+rwX "$dir" 2>/dev/null; then
                    echo -e "\${YELLOW}Warning: Could not fix permissions for $dir\${RESET}"
                    echo -e "\${YELLOW}If you see permission errors, run: sudo chown -R \\$USER:\\$USER $dir\${RESET}"
                fi
            fi
        else
            # Create directory with proper permissions
            mkdir -p "$dir" 2>/dev/null && chmod u+rwX "$dir" 2>/dev/null || true
        fi
    done
    
    # Also ensure pip cache is writable
    if [ -d "$HOME/.cache/pip" ] && [ ! -w "$HOME/.cache/pip" ]; then
        echo -e "\${YELLOW}Fixing permissions for pip cache...\${RESET}"
        chmod -R u+rwX "$HOME/.cache/pip" 2>/dev/null || true
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# UI Helpers
# ═══════════════════════════════════════════════════════════════════════════════
print_header() {
    gum style \\
        --border double \\
        --padding "1 2" \\
        --margin "1 0" \\
        --border-foreground 212 \\
        "🤖 Agent Messaging Platform" \\
        "Manage your AI agents" \\
        "" \\
        "Version: $CLI_VERSION"
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
# Command Confirmation
# ═══════════════════════════════════════════════════════════════════════════════
confirm_command() {
    local command="$1"
    local description="\${2:-Execute this command?}"
    local working_dir="\${3:-\$(pwd)}"
    
    echo ""
    gum style \\
        --border rounded \\
        --padding "1 2" \\
        --margin "1 0" \\
        --border-foreground 214 \\
        "⚠️  COMMAND CONFIRMATION"
    
    echo ""
    gum style --foreground 212 --bold "Command to execute:"
    echo ""
    gum style \\
        --foreground 51 \\
        --border double \\
        --padding "0 2" \\
        --margin "0 2" \\
        "$command"
    echo ""
    gum style --foreground 244 "📁 Working directory: $working_dir"
    echo ""
    
    if [ -n "$description" ] && [ "$description" != "Execute this command?" ]; then
        gum style --foreground 226 "$description"
        echo ""
    fi
    
    if gum confirm --affirmative "Execute" --negative "Cancel" "Proceed with this command?"; then
        return 0
    else
        gum style --foreground 214 "Command cancelled."
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Agent Discovery
# ═══════════════════════════════════════════════════════════════════════════════
get_existing_agents() {
    local agents=()
    
    if [ -d "$CHATSPACE_DIR" ]; then
        while IFS= read -r -d '' env_file; do
            local agent_dir
            agent_dir=$(dirname "$env_file")
            local agent_name
            agent_name=$(grep "^AGENT_NAME=" "$env_file" 2>/dev/null | cut -d'=' -f2 | tr -d '"' || basename "$agent_dir")
            if [ -n "$agent_name" ]; then
                agents+=("$agent_name")
            fi
        done < <(find "$CHATSPACE_DIR" -maxdepth 2 -name ".env" -print0 2>/dev/null)
    fi
    
    printf '%s\\n' "\${agents[@]}"
}

# Chief of Staff records live in the account database, while ordinary agent
# folders are intentionally local.  This lets a freshly-installed CLI find a
# CoS created from another project without treating its remote folder as local.
get_remote_chiefs_of_staff() {
    local response
    response=$(curl -fsS -H "X-API-Key: $API_KEY" "$API_BASE/agent/user/install-chief-of-staff/status" 2>/dev/null || true)
    [ -n "$response" ] || return 0
    printf '%s' "$response" | jq -r '.agents[]? | .agent_name // .agentName // empty' 2>/dev/null
}

is_spawned_agent() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    local lineage_file="$CHATSPACE_DIR/$folder/agent_state/lineage.json"

    if [ -f "$lineage_file" ] && command -v jq &>/dev/null; then
        local auto_spawned
        auto_spawned=$(jq -r '.auto_spawned // false' "$lineage_file" 2>/dev/null || echo "false")
        [ "$auto_spawned" = "true" ] && return 0
    fi
    return 1
}

format_agent_label() {
    local agent_name="$1"
    if is_spawned_agent "$agent_name"; then
        printf '%s\\t[spawned]' "$agent_name"
    else
        printf '%s' "$agent_name"
    fi
}

extract_agent_name_from_label() {
    local label="$1"
    printf '%s' "\${label%%$'\\t'*}"
}

get_agent_folder() {
    local agent_name="$1"
    echo "$agent_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-zA-Z0-9_-]/_/g'
}

agent_exists() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    [ -f "$CHATSPACE_DIR/$folder/.env" ]
}

# ═══════════════════════════════════════════════════════════════════════════════
# Agent Creation
# ═══════════════════════════════════════════════════════════════════════════════
create_agent() {
    print_section "Create New Agent"
    echo ""

    # Start with a useful, locally unique name while keeping it fully editable.
    # The short hostname identifies the computer and the working directory
    # identifies the project in which the agent is being created.
    local computer_name
    computer_name="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "")"

    local project_name
    project_name="$(basename "$PWD" 2>/dev/null || echo "")"
    if [ -z "$project_name" ] || [ "$project_name" = "/" ] || [ "$project_name" = "." ]; then
        project_name="NewAgent"
    fi

    local default_agent_name
    if [ -n "$computer_name" ]; then
        default_agent_name="\${computer_name}-\${project_name}"
    else
        default_agent_name="\$project_name"
    fi

    local agent_name
    agent_name=$(gum input \\
        --placeholder "MyAssistant" \\
        --prompt "Agent Name: " \\
        --width 40 \\
        --value "$default_agent_name")
    
    if [ -z "$agent_name" ]; then
        print_error "Agent name cannot be empty"
        return 1
    fi
    
    if agent_exists "$agent_name"; then
        print_error "Agent '$agent_name' already exists!"
        if gum confirm "Would you like to continue with this agent instead?"; then
            run_agent "$agent_name"
            return
        fi
        return 1
    fi
    
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    
    print_success "Agent name: $agent_name"
    echo ""
    
    local user_password=""
    if [ "$HAS_ENCRYPTION" = "true" ]; then
        print_info "🔐 End-to-end encryption is enabled for your account."
        user_password=$(gum input \\
            --password \\
            --placeholder "Enter your account password" \\
            --prompt "Password: ")
        
        if [ -z "$user_password" ]; then
            print_error "Password cannot be empty when encryption is enabled"
            return 1
        fi
        print_success "Password received"
    fi
    
    echo ""
    print_section "Creating agent files..."
    
    mkdir -p "$agent_dir"
    mkdir -p "$agent_dir/agent_state"
    
    # Create .env file
    cat > "$agent_dir/.env" <<ENVEOF
# Agent Messaging Environment Configuration
# KEEP THIS FILE SECURE - DO NOT SHARE WITH AGENT
USER_PASSWORD="$user_password"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$agent_name"
ENVEOF
    chmod 600 "$agent_dir/.env"
    print_success "Created: $agent_dir/.env"
    
    # Create message_helper.py
    create_message_helper "$agent_dir"
    print_success "Created: $agent_dir/message_helper.py"
    
    # Create agent instructions
    create_agent_instructions "$agent_dir" "$agent_name"
    print_success "Created: $agent_dir/AGENT_INSTRUCTIONS.md"
    
    # Create oneshot instructions  
    create_oneshot_instructions "$agent_dir" "$agent_name"
    print_success "Created: $agent_dir/ONESHOT_AGENT_INSTRUCTIONS.md"
    
    # Create rich form skill documentation
    create_rich_form_skill "$agent_dir"
    print_success "Created: $agent_dir/SKILL_RICH_FORMS.md"

    # Create self-wake guide documentation
    create_self_wake_guide "$agent_dir"
    print_success "Created: $agent_dir/SELF_WAKE_GUIDE.md"
    
    # Create agent-runner.sh
    create_agent_runner "$agent_dir"
    print_success "Created: $agent_dir/agent-runner.sh"
    
    # Initialize state files
    echo '[]' > "$agent_dir/agent_state/.scheduled_tasks.json"
    echo '{"session_count": 0}' > "$agent_dir/agent_state/conversation_history.json"
    
    # Create agent_summary.md with template
    cat > "$agent_dir/agent_state/agent_summary.md" <<SUMMARYEOF
# Agent Session Summary - $agent_name

## Current State
- Status: initialized
- Last active: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- Session count: 0

## Ongoing Tasks
- None currently

## Notes for Next Session
- Agent is ready to receive messages
- Use message_helper.py to send and receive messages

## Other Relevant Information
- Agent Name: $agent_name
- Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
SUMMARYEOF
    print_success "Created: $agent_dir/agent_state/agent_summary.md"
    
    # Create .gitignore in agent directory to protect .env
    cat > "$agent_dir/.gitignore" <<GITIGNOREOF
# Never commit .env file - it contains secrets!
.env

# Agent runtime files
agent_state/.agent_response.txt
agent_state/.wait_state.json
agent_state/.running
GITIGNOREOF
    print_success "Created: $agent_dir/.gitignore"
    
    echo ""
    print_success "Agent '$agent_name' created successfully!"
    echo ""
    
    print_info "Launching agent automatically..."
    run_agent "$agent_name"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Platform Availability Checks
# ═══════════════════════════════════════════════════════════════════════════════

# Helper function to install a CLI tool
install_cli_tool() {
    local tool_name="$1"
    local install_cmd="$2"
    local install_url="$3"
    
    print_warning "$tool_name is not installed." >&2
    echo "" >&2
    gum style --foreground 212 "Install from: $install_url" >&2
    echo "" >&2
    
    if gum confirm "Would you like to install $tool_name now?"; then
        print_info "Installing $tool_name..." >&2
        echo "" >&2
        
        # Run the install command
        if eval "$install_cmd"; then
            # Refresh PATH to pick up newly installed tool
            export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$PATH"
            hash -r 2>/dev/null || true
            
            print_success "$tool_name installed successfully!" >&2
            return 0
        else
            print_error "Failed to install $tool_name. Please install manually." >&2
            return 1
        fi
    else
        print_info "Skipping $tool_name installation." >&2
        return 1
    fi
}

check_platform_availability() {
    local provider="$1"
    local api_key=""
    local error_msg=""
    
    case "$provider" in
        default|codex-cli)
            # Codex requires codex CLI to be installed
            if ! command -v codex &>/dev/null; then
                if install_cli_tool "Codex CLI" \\
                    "npm install -g @openai/codex" \\
                    "https://github.com/openai/codex"; then
                    # Verify installation
                    if ! command -v codex &>/dev/null; then
                        error_msg="Codex CLI installation completed but command not found. Try opening a new terminal."
                        return 1
                    fi
                else
                    return 1
                fi
            fi
            ;;
        openai)
            # First check if codex is available (needed for openai provider)
            if ! command -v codex &>/dev/null; then
                if ! install_cli_tool "Codex CLI" \\
                    "npm install -g @openai/codex" \\
                    "https://github.com/openai/codex"; then
                    return 1
                fi
            fi
            
            api_key="\${OPENAI_API_KEY:-}"
            if [ -z "$api_key" ]; then
                print_warning "OpenAI API key not found." >&2
                echo "" >&2
                gum style --foreground 212 "Get your API key at: https://platform.openai.com/api-keys" >&2
                echo "" >&2
                
                api_key=$(gum input \\
                    --placeholder "sk-..." \\
                    --prompt "Enter your OpenAI API key: " \\
                    --password)
                
                if [ -z "$api_key" ]; then
                    error_msg="No API key provided."
                    return 1
                fi
                
                # Save to shell config for persistence
                local shell_rc=""
                if [ -f "$HOME/.bashrc" ]; then
                    shell_rc="$HOME/.bashrc"
                elif [ -f "$HOME/.zshrc" ]; then
                    shell_rc="$HOME/.zshrc"
                fi
                
                if [ -n "$shell_rc" ]; then
                    # Remove any existing OPENAI_API_KEY line and add new one
                    grep -v "^export OPENAI_API_KEY=" "$shell_rc" > "$shell_rc.tmp" 2>/dev/null || true
                    mv "$shell_rc.tmp" "$shell_rc"
                    echo "export OPENAI_API_KEY=\\"$api_key\\"" >> "$shell_rc"
                    print_success "API key saved to $shell_rc" >&2
                fi
                
                # Export for current session
                export OPENAI_API_KEY="$api_key"
                print_success "API key set for current session" >&2
            fi
            ;;
        openrouter)
            # First check if codex is available (needed for openrouter provider)
            if ! command -v codex &>/dev/null; then
                if ! install_cli_tool "Codex CLI" \\
                    "npm install -g @openai/codex" \\
                    "https://github.com/openai/codex"; then
                    return 1
                fi
            fi
            
            api_key="\${OPENROUTER_API_KEY:-}"
            if [ -z "$api_key" ]; then
                print_warning "OpenRouter API key not found." >&2
                echo "" >&2
                gum style --foreground 212 "Get your API key at: https://openrouter.ai/keys" >&2
                echo "" >&2
                
                api_key=$(gum input \\
                    --placeholder "sk-or-v1-..." \\
                    --prompt "Enter your OpenRouter API key: " \\
                    --password)
                
                if [ -z "$api_key" ]; then
                    error_msg="No API key provided."
                    return 1
                fi
                
                # Save to shell config for persistence
                local shell_rc=""
                if [ -f "$HOME/.bashrc" ]; then
                    shell_rc="$HOME/.bashrc"
                elif [ -f "$HOME/.zshrc" ]; then
                    shell_rc="$HOME/.zshrc"
                fi
                
                if [ -n "$shell_rc" ]; then
                    # Remove any existing OPENROUTER_API_KEY line and add new one
                    grep -v "^export OPENROUTER_API_KEY=" "$shell_rc" > "$shell_rc.tmp" 2>/dev/null || true
                    mv "$shell_rc.tmp" "$shell_rc"
                    echo "export OPENROUTER_API_KEY=\\"$api_key\\"" >> "$shell_rc"
                    print_success "API key saved to $shell_rc" >&2
                fi
                
                # Export for current session
                export OPENROUTER_API_KEY="$api_key"
                print_success "API key set for current session" >&2
            fi
            ;;
        claude)
            # Check if claude CLI is installed
            if ! command -v claude &>/dev/null; then
                if ! install_cli_tool "Claude CLI" \\
                    "npm install -g @anthropic-ai/claude-code" \\
                    "https://docs.anthropic.com/en/docs/claude-code/getting-started"; then
                    return 1
                fi
                # Verify installation
                if ! command -v claude &>/dev/null; then
                    error_msg="Claude CLI installation completed but command not found. Try opening a new terminal."
                    return 1
                fi
            fi
            ;;
        gemini)
            # Check if gemini CLI is installed
            if ! command -v gemini &>/dev/null; then
                if ! install_cli_tool "Gemini CLI" \\
                    "npm install -g @google/gemini-cli" \\
                    "https://github.com/google-gemini/gemini-cli"; then
                    return 1
                fi
                # Verify installation
                if ! command -v gemini &>/dev/null; then
                    error_msg="Gemini CLI installation completed but command not found. Try opening a new terminal."
                    return 1
                fi
            fi
            if ! ensure_gemini_node_compat >/dev/null 2>&1; then
                error_msg="Gemini CLI requires Node.js 20 or newer. Install a newer Node.js runtime (or make it first on PATH) before using the Gemini provider."
                return 1
            fi
            ;;
        copilot)
            # Check if GitHub Copilot CLI is installed
            if ! command -v copilot &>/dev/null; then
                if ! install_cli_tool "GitHub Copilot CLI" \\
                    "npm install -g @githubnext/github-copilot-cli" \\
                    "https://githubnext.com/projects/copilot-cli"; then
                    return 1
                fi
                # Verify installation
                if ! command -v copilot &>/dev/null; then
                    error_msg="Copilot CLI installation completed but command not found. Try opening a new terminal."
                    return 1
                fi
            fi
            ;;
        antigravity)
            # Check if Antigravity CLI is installed
            if ! command -v agy &>/dev/null; then
                error_msg="Antigravity CLI is missing. Install Antigravity and run 'agy install' or ensure agy is on PATH."
                print_error "$error_msg" >&2
                gum style --foreground 244 "Expected command: agy -p" >&2
                return 1
            fi
            ;;
        pi)
            # Check if Pi CLI is installed
            if ! command -v pi &>/dev/null; then
                if ! install_cli_tool "Pi CLI" \\
                    "npm install -g @mariozechner/pi-coding-agent" \\
                    "https://pi.dev/"; then
                    return 1
                fi
                # Verify installation
                if ! command -v pi &>/dev/null; then
                    error_msg="Pi CLI installation completed but command not found. Try opening a new terminal."
                    return 1
                fi
            fi
            ;;
        kilo)
            # Check if Kilo CLI is installed
            if ! command -v kilo &>/dev/null; then
                if ! install_cli_tool "Kilo CLI" \\
                    "npm install -g @kilocode/cli" \\
                    "https://kilo.ai/docs/cli"; then
                    return 1
                fi
                # Verify installation
                if ! command -v kilo &>/dev/null; then
                    error_msg="Kilo CLI installation completed but command not found. Try opening a new terminal."
                    return 1
                fi
            fi
            ;;
        ollama)
            # Check if Ollama is installed first
            if ! command -v ollama &>/dev/null; then
                if ! install_cli_tool "Ollama" \\
                    "curl -fsSL https://ollama.com/install.sh | sh" \\
                    "https://ollama.com"; then
                    return 1
                fi
            fi
            # Check if Ollama service is running
            if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
                print_warning "Ollama service is not running." >&2
                if gum confirm "Would you like to start Ollama now?"; then
                    print_info "Starting Ollama..." >&2
                    ollama serve &>/dev/null &
                    sleep 2
                    if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
                        error_msg="Failed to start Ollama. Try running 'ollama serve' manually."
                        return 1
                    fi
                    print_success "Ollama started!" >&2
                else
                    error_msg="Ollama service is not running. Start it with: ollama serve"
                    return 1
                fi
            fi
            ;;
        lmstudio)
            # Check if LM Studio API is running
            if ! curl -s http://localhost:1234/v1/models &>/dev/null; then
                error_msg="LM Studio API is not running. Start LM Studio and enable the local server."
                print_error "$error_msg" >&2
                echo "" >&2
                gum style --foreground 212 "Download LM Studio from: https://lmstudio.ai" >&2
                gum style --foreground 244 "After installing, open LM Studio → Local Server → Start Server" >&2
                return 1
            fi
            ;;
    esac
    
    if [ -n "$error_msg" ]; then
        print_error "$error_msg"
        return 1
    fi
    
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# Model & Provider Selection
# ═══════════════════════════════════════════════════════════════════════════════
select_model_provider() {
    local provider
    
    while true; do
        provider=$(gum choose \\
            --header "Select AI Provider:" \\
            --cursor "➤ " \\
            "default (Codex default - gpt-5.6-terra)" \\
            "openai (OpenAI API - requires OPENAI_API_KEY)" \\
            "codex-cli (Codex CLI - direct, uses ChatGPT login)" \\
            "claude (Claude CLI - direct, no API key needed)" \\
            "gemini (Gemini CLI - direct, no API key needed)" \\
            "copilot (GitHub Copilot CLI - direct, uses GitHub login)" \\
            "antigravity (Antigravity CLI - direct, uses agy -p)" \\
            "pi (Pi CLI - direct, uses Pi auth/providers)" \\
            "kilo (Kilo CLI - direct, supports --auto mode)" \\
            "openrouter (Multi-provider via OPENROUTER_API_KEY)" \\
            "ollama (Local - Ollama server)" \\
            "lmstudio (Local - LM Studio server)")
        
        local provider_name
        provider_name=$(echo "$provider" | cut -d' ' -f1)
        
        if check_platform_availability "$provider_name"; then
            echo "$provider_name"
            return 0
        else
            echo ""
            if ! gum confirm "Try a different provider?"; then
                print_error "Cannot proceed without a valid provider"
                return 1
            fi
            echo ""
        fi
    done
}

sync_runtime_permissions() {
    local payload
    payload=$(jq -nc --arg agentName "$1" --slurpfile config "$2" --slurpfile allowed "$3" \\
        '{agentName:$agentName,config:$config[0],allowedPermissions:$allowed[0]}') || return 1
    if ! curl -fsS --connect-timeout 5 --max-time 15 -X POST \\
        -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \\
        --data-binary "$payload" "$API_BASE/agent/runtime-permissions" >/dev/null; then
        print_error "Could not save the permission grant to the server. Check the owner API key and try again."
        return 1
    fi
}

sync_models_to_backend() {
    local provider="$1"
    local models_text="\${2:-}"

    [ -z "$provider" ] && return 0
    [ -z "$models_text" ] && return 0
    command -v jq >/dev/null 2>&1 || return 0

    local payload
    payload=$(printf '%s\n' "$models_text" | jq -R . | jq -s --arg provider "$provider" --arg source "cli-online" \
        '{provider:$provider, source:$source, models:.}' 2>/dev/null) || return 0

    [ -z "$payload" ] && return 0
    curl -sL --connect-timeout 5 --max-time 10 -X POST \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$API_BASE/agent/models/sync" >/dev/null 2>&1 || true
}

fetch_backend_models_for_provider() {
    local provider="$1"
    [ -z "$provider" ] && return 0
    command -v jq >/dev/null 2>&1 || return 0

    curl -sL --connect-timeout 5 --max-time 10 -H "X-API-Key: $API_KEY" \
        "$API_BASE/agent/models?provider=$provider" 2>/dev/null | \
        jq -r '.models[]?.value' 2>/dev/null | \
        grep -v '^default$' || true
}

auto_sync_all_installed_providers_models() {
    command -v node >/dev/null 2>&1 || return 0
    CHATSPACE_MODEL_PROVIDER="\${1:-}" CHATSPACE_MODEL_API_BASE="$API_BASE" CHATSPACE_MODEL_API_KEY="$API_KEY" node <<'CHATSPACE_MODEL_DISCOVERY'
${modelDiscoverySource}
main().catch(() => { process.exitCode = 1; });
CHATSPACE_MODEL_DISCOVERY
}

select_model() {
    local provider="$1"
    local model
    
    case "$provider" in
        default)
            model=$(gum choose \
                --header "Select model (uses your Codex/ChatGPT account):" \
                --cursor "➤ " \
                "gpt-6-astra (GPT-6 Astra - requires eligible access)" \
                "gpt-6-sol (GPT-6 Sol - latest coding model)" \
                "gpt-6.1-sol (GPT-6.1 Sol - latest balanced model)" \
                "gpt-6-luna (GPT-6 Luna - fastest)" \
                "gpt-5.6-terra (GPT-5.6 Terra - verified default)" \
                "gpt-5.6-luna (GPT-5.6 Luna - fastest)" \
                "gpt-5.6-sol (GPT-5.6 Sol - requires eligible plan)" \
                "gpt-5.5 (GPT-5.5 - latest)" \
                "gpt-5.5-pro (GPT-5.5 Pro - highest reasoning)" \
                "gpt-5.4 (GPT-5.4 - latest default)" \
                "gpt-5.4-pro (GPT-5.4 Pro - highest reasoning)" \
                "gpt-5.4-mini (GPT-5.4 Mini - efficient)" \
                "gpt-5.4-nano (GPT-5.4 Nano - lowest cost)" \
                "gpt-5.3-codex (Codex 5.3)" \
                "gpt-5.2-codex (Codex 5.2)" \
                "gpt-5.1-codex-max (Best for coding)" \
                "gpt-5.1-codex (GPT-5.1 Codex optimized)" \
                "gpt-5.1 (GPT-5.1 general purpose)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        openai)
            print_info "Fetching available OpenAI models..."
            local openai_models=""
            if [ -n "$OPENAI_API_KEY" ] && command -v jq &>/dev/null; then
                openai_models=$(curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" 2>/dev/null | jq -r '.data[].id' 2>/dev/null | grep -E "^(gpt-|o[1-9])" | sort -V || echo "")
            fi
            
            if [ -n "$openai_models" ]; then
                sync_models_to_backend "openai" "$openai_models"
                model=$(echo "$openai_models" | gum filter --placeholder "Search OpenAI models...")
            else
                local openai_cached
                openai_cached=$(fetch_backend_models_for_provider "openai")
                if [ -n "$openai_cached" ]; then
                    model=$(echo "$openai_cached" | gum filter --placeholder "Search cached OpenAI models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum choose \
                    --header "Select OpenAI model (uses OPENAI_API_KEY):" \
                    --cursor "➤ " \
                    "o3-mini (Reasoning)" \
                    "o1 (Reasoning)" \
                    "gpt-4o (General purpose)" \
                    "gpt-4o-mini (Lower cost)")
                model=$(echo "$model" | cut -d' ' -f1)
            fi
            ;;
        openrouter)
            print_info "Fetching available OpenRouter models..."
            local or_models=""
            if command -v jq &>/dev/null; then
                or_models=$(curl -s https://openrouter.ai/api/v1/models 2>/dev/null | jq -r '.data[].id' 2>/dev/null | sort -V || echo "")
            fi
            
            if [ -n "$or_models" ]; then
                sync_models_to_backend "openrouter" "$or_models"
                model=$(echo "$or_models" | gum filter --placeholder "Search OpenRouter models...")
            else
                local or_cached
                or_cached=$(fetch_backend_models_for_provider "openrouter")
                if [ -n "$or_cached" ]; then
                    model=$(echo "$or_cached" | gum filter --placeholder "Search cached OpenRouter models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum choose \
                    --header "Select model via OpenRouter:" \
                    --cursor "➤ " \
                    "anthropic/claude-3.7-sonnet (Claude 3.7 Sonnet - newest)" \
                    "anthropic/claude-3.5-sonnet (Claude 3.5 Sonnet)" \
                    "google/gemini-2.5-pro (Gemini 2.5 Pro)" \
                    "google/gemini-2.0-flash (Gemini 2.0 Flash)" \
                    "openai/o3-mini (OpenAI o3-mini)" \
                    "openai/gpt-4o (OpenAI GPT-4o)" \
                    "meta-llama/llama-3.3-70b-instruct (Llama 3.3 70B)" \
                    "deepseek/deepseek-r1 (DeepSeek R1 reasoning)" \
                    "x-ai/grok-4 (xAI Grok 4)" \
                    "x-ai/grok-4-fast (xAI Grok 4 Fast)" \
                    "x-ai/grok-code-fast-1 (xAI Grok Code Fast 1)" \
                    "x-ai/grok-3 (xAI Grok 3)" \
                    "x-ai/grok-3-mini (xAI Grok 3 Mini)" \
                    "--- FREE MODELS ---" \
                    "x-ai/grok-2-vision:free (Grok 2 Vision - FREE)" \
                    "qwen/qwen-2.5-72b-instruct:free (Qwen 2.5 72B - FREE)" \
                    "mistralai/mistral-7b-instruct:free (Mistral 7B - FREE)")
                if [ "$model" = "--- FREE MODELS ---" ]; then
                    model="qwen/qwen-2.5-72b-instruct:free"
                else
                    model=$(echo "$model" | cut -d' ' -f1)
                fi
            fi
            ;;
        codex-cli)
            model=$(gum choose \
                --header "Select OpenAI model (via Codex CLI):" \
                --cursor "➤ " \
                "gpt-6-astra (GPT-6 Astra - requires eligible access)" \
                "gpt-6-sol (GPT-6 Sol - latest coding model)" \
                "gpt-6.1-sol (GPT-6.1 Sol - latest balanced model)" \
                "gpt-6-luna (GPT-6 Luna - fastest)" \
                "gpt-5.6-terra (GPT-5.6 Terra - verified default)" \
                "gpt-5.6-luna (GPT-5.6 Luna - fastest)" \
                "gpt-5.6-sol (GPT-5.6 Sol - requires eligible plan)" \
                "gpt-5.5 (GPT-5.5 - latest)" \
                "gpt-5.5-pro (GPT-5.5 Pro - highest reasoning)" \
                "gpt-5.4 (GPT-5.4 - latest default)" \
                "gpt-5.4-pro (GPT-5.4 Pro - highest reasoning)" \
                "gpt-5.4-mini (GPT-5.4 Mini - efficient)" \
                "gpt-5.4-nano (GPT-5.4 Nano - lowest cost)" \
                "gpt-5.3-codex (Codex 5.3)" \
                "gpt-5.1-codex-max (Best for coding - default)" \
                "gpt-5.1-codex (GPT-5.1 Codex optimized)" \
                "gpt-5.1 (GPT-5.1 general purpose)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        claude)
            model=$(gum choose \
                --header "Select Claude model:" \
                --cursor "➤ " \
                "claude-fable-5-1 (Claude Fable 5.1 - most capable)" \
                "claude-mythos-5-1 (Claude Mythos 5.1 - invite only)" \
                "claude-opus-5-5 (Claude Opus 5.5 - latest coding model)" \
                "claude-opus-5 (Claude Opus 5)" \
                "claude-fable-5 (Claude Fable 5)" \
                "claude-mythos-5 (Claude Mythos 5 - invite only)" \
                "claude-sonnet-5-5 (Claude Sonnet 5.5 - latest balanced)" \
                "claude-sonnet-5 (Claude Sonnet 5)" \
                "claude-haiku-5-5 (Claude Haiku 5.5 - fastest)" \
                "claude-opus-4-8 (Claude Opus 4.8)" \
                "claude-opus-4-7 (Claude Opus 4.7 - latest)" \
                "claude-opus-4-6 (Claude Opus 4.6)" \
                "claude-sonnet-4-6 (Claude Sonnet 4.6 - balanced)" \
                "claude-haiku-4-5 (Claude Haiku 4.5)" \
                "claude-sonnet-4-5-20250929 (Claude Sonnet 4.5 snapshot)" \
                "claude-haiku-4-5-20251001 (Claude Haiku 4.5 snapshot)" \
                "claude-3-7-sonnet-20250219 (Claude 3.7 Sonnet)" \
                "claude-3-5-sonnet-20241022 (Claude 3.5 Sonnet - best for coding)" \
                "claude-3-5-haiku-20241022 (Claude 3.5 Haiku - fastest)" \
                "sonnet (Claude Sonnet alias)" \
                "opus (Claude Opus alias)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        antigravity)
            local antigravity_cached
            antigravity_cached=$(fetch_backend_models_for_provider "antigravity")
            if [ -n "$antigravity_cached" ]; then
                model=$(echo "$antigravity_cached" | gum filter --placeholder "Search cached Antigravity models...")
                echo "$model"
                return 0
            fi
            model=$(gum choose \
                --header "Select Antigravity model:" \
                --cursor "➤ " \
                "default (Use Antigravity default model)" \
                "gemini-3.8-flash (Gemini 3.8 Flash)" \
                "gemini-3.8-flash-high (Gemini 3.8 Flash High)" \
                "gemini-3.8-flash-medium (Gemini 3.8 Flash Medium)" \
                "gemini-3.8-flash-low (Gemini 3.8 Flash Low)" \
                "claude-sonnet-4-6 (Claude Sonnet 4.6)" \
                "claude-opus-4-6-thinking (Claude Opus 4.6 Thinking)" \
                "gpt-oss-120b-medium (GPT-OSS 120B Medium)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        gemini)
            print_info "Fetching available Gemini models..."
            local gemini_models=""
            if [ -n "$GEMINI_API_KEY" ] && command -v jq &>/dev/null; then
                gemini_models=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" 2>/dev/null | jq -r '.models[].name' 2>/dev/null | sed 's/models\///' | sort -V || echo "")
            fi
            
            if [ -n "$gemini_models" ]; then
                sync_models_to_backend "gemini" "$gemini_models"
                model=$(echo "$gemini_models" | gum filter --placeholder "Search Gemini models...")
            else
                local gemini_cached
                gemini_cached=$(fetch_backend_models_for_provider "gemini")
                if [ -n "$gemini_cached" ]; then
                    model=$(echo "$gemini_cached" | gum filter --placeholder "Search cached Gemini models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum choose \
                    --header "Select Gemini model:" \
                    --cursor "➤ " \
                    "gemini-4-argon (Gemini 4 Argon - most capable)" \
                    "gemini-3.8-flash (Gemini 3.8 Flash - latest stable)" \
                    "gemini-3.7-flash (Gemini 3.7 Flash - latest stable)" \
                    "gemini-3.6-flash (Gemini 3.6 Flash)" \
                    "gemini-3.5-flash (Gemini 3.5 Flash)" \
                    "gemini-3.5-flash-lite (Gemini 3.5 Flash Lite)" \
                    "gemini-2.5-pro (Best for complex tasks)" \
                    "gemini-2.5-flash (Fast and efficient)" \
                    "gemini-2.0-flash (Gemini 2.0 Flash)" \
                    "gemini-2.0-flash-thinking-exp (Gemini 2.0 Flash Thinking)" \
                    "gemini-2.0-pro-exp (Gemini 2.0 Pro Experimental)")
                model=$(echo "$model" | cut -d' ' -f1)
            fi
            ;;
        kilo)
            print_info "Fetching available Kilo models..."
            local kilo_models=""
            if command -v kilo &>/dev/null; then
                kilo_models=$(kilo models 2>/dev/null | sed 's|^kilo/||' | sort -u || echo "")
            fi
            
            if [ -n "$kilo_models" ]; then
                sync_models_to_backend "kilo" "$kilo_models"
                model=$(echo "$kilo_models" | gum filter --placeholder "Search Kilo models...")
            else
                local kilo_cached
                kilo_cached=$(fetch_backend_models_for_provider "kilo")
                if [ -n "$kilo_cached" ]; then
                    model=$(echo "$kilo_cached" | gum filter --placeholder "Search cached Kilo models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum choose \
                    --header "Select Kilo model:" \
                    --cursor "➤ " \
                    "default (Use model from Kilo config)" \
                    "anthropic/claude-3-7-sonnet-20250219 (Claude 3.7 Sonnet)" \
                    "anthropic/claude-sonnet-5-5 (Claude Sonnet 5.5)" \
                    "openai/gpt-5 (GPT-5)" \
                    "openai/o3-mini (OpenAI o3-mini)" \
                    "google/gemini-2.5-pro (Gemini 2.5 Pro)")
                model=$(echo "$model" | cut -d' ' -f1)
            fi
            ;;
        copilot)
            print_info "Fetching available Copilot models..."
            local copilot_models=""
            if command -v copilot &>/dev/null; then
                auto_sync_all_installed_providers_models "copilot" >/dev/null 2>&1 || true
                copilot_models=$(fetch_backend_models_for_provider "copilot")
            fi
            
            if [ -n "$copilot_models" ]; then
                sync_models_to_backend "copilot" "$copilot_models"
                model=$(echo "$copilot_models" | gum filter --placeholder "Search Copilot models...")
            else
                local copilot_cached
                copilot_cached=$(fetch_backend_models_for_provider "copilot")
                if [ -n "$copilot_cached" ]; then
                    model=$(echo "$copilot_cached" | gum filter --placeholder "Search cached Copilot models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum choose \
                    --header "Select Copilot model:" \
                    --cursor "➤ " \
                    "auto (Let Copilot choose the best available model)" \
                    "gpt-5.6-luna (GPT-5.6 Luna)" \
                    "gpt-5.6-sol (GPT-5.6 Sol)" \
                    "gpt-5.6-terra (GPT-5.6 Terra)" \
                    "gpt-5.5 (GPT-5.5)" \
                    "claude-sonnet-5 (Claude Sonnet 5)" \
                    "claude-fable-5 (Claude Fable 5)" \
                    "claude-opus-4.8 (Claude Opus 4.8)" \
                    "claude-opus-4.7 (Claude Opus 4.7)" \
                    "claude-opus-4.6 (Claude Opus 4.6)" \
                    "claude-opus-4.6-fast (Claude Opus 4.6 Fast)" \
                    "claude-opus-4.5 (Claude Opus 4.5)" \
                    "claude-sonnet-4.6 (Claude Sonnet 4.6)" \
                    "claude-sonnet-4.5 (Claude Sonnet 4.5 - default)" \
                    "claude-sonnet-4 (Claude Sonnet 4)" \
                    "gpt-5.4 (GPT 5.4)" \
                    "gpt-5.4-mini (GPT 5.4 Mini)" \
                    "gpt-5.4-nano (GPT 5.4 Nano)" \
                    "gpt-5.3-codex (GPT 5.3 Codex)" \
                    "gpt-5.2-codex (GPT 5.2 Codex)" \
                    "gpt-5.2 (GPT 5.2)" \
                    "gpt-5-mini (GPT 5 Mini)" \
                    "gemini-3.8-flash (Gemini 3.8 Flash)" \
                    "gemini-3.7-flash (Gemini 3.7 Flash)" \
                    "gemini-3.1-pro (Gemini 3.1 Pro)" \
                    "gemini-3-flash (Gemini 3 Flash)" \
                    "claude-3.7-sonnet (Claude 3.7 Sonnet)" \
                    "claude-3.5-sonnet (Claude 3.5 Sonnet)" \
                    "gpt-4o (GPT-4o)" \
                    "o1 (o1)" \
                    "o3-mini (o3-mini)" \
                    "gemini-2.5-pro (Gemini 2.5 Pro)" \
                    "grok-code-fast-1 (Grok Code Fast 1)" \
                    "raptor-mini (Raptor Mini)" \
                    "goldeneye (Goldeneye)")
                model=$(echo "$model" | cut -d' ' -f1)
            fi
            ;;
        pi)
            local pi_cached
            pi_cached=$(fetch_backend_models_for_provider "pi")
            if [ -n "$pi_cached" ]; then
                model=$(echo "$pi_cached" | gum filter --placeholder "Search cached Pi models...")
                echo "$model"
                return 0
            fi
            model=$(gum choose \
                --header "Select Pi model:" \
                --cursor "➤ " \
                "default (Use Pi default model/provider)" \
                "sonnet (Claude Sonnet alias)" \
                "sonnet:high (Claude Sonnet with high thinking)" \
                "opus (Claude Opus alias)" \
                "openai/gpt-4o (OpenAI GPT-4o)" \
                "openai/o3 (OpenAI o3)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        ollama)
            print_info "Fetching available Ollama models..."
            local ollama_models
            ollama_models=$(curl -s http://localhost:11434/api/tags 2>/dev/null | jq -r '.models[].name' 2>/dev/null || echo "")
            
            if [ -n "$ollama_models" ]; then
                sync_models_to_backend "ollama" "$ollama_models"
                model=$(echo "$ollama_models" | gum filter --placeholder "Search Ollama models...")
            else
                local ollama_cached
                ollama_cached=$(fetch_backend_models_for_provider "ollama")
                if [ -n "$ollama_cached" ]; then
                    model=$(echo "$ollama_cached" | gum filter --placeholder "Search cached Ollama models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum input \
                    --placeholder "llama3.2" \
                    --prompt "Ollama model name: " \
                    --value "llama3.2")
            fi
            ;;
        lmstudio)
            print_info "Fetching available LM Studio models..."
            local lmstudio_models
            lmstudio_models=$(curl -s http://localhost:1234/v1/models 2>/dev/null | jq -r '.data[].id' 2>/dev/null || echo "")
            
            if [ -n "$lmstudio_models" ]; then
                sync_models_to_backend "lmstudio" "$lmstudio_models"
                model=$(echo "$lmstudio_models" | gum filter --placeholder "Search LM Studio models...")
            else
                local lmstudio_cached
                lmstudio_cached=$(fetch_backend_models_for_provider "lmstudio")
                if [ -n "$lmstudio_cached" ]; then
                    model=$(echo "$lmstudio_cached" | gum filter --placeholder "Search cached LM Studio models...")
                    echo "$model"
                    return 0
                fi
                model=$(gum input \
                    --placeholder "local-model" \
                    --prompt "LM Studio model name: " \
                    --value "local-model")
            fi
            ;;
        *)
            model="gpt-4o"
            ;;
    esac
    
    echo "$model"
}

select_approval_mode() {
    local mode
    mode=$(gum choose \\
        --header "How should the agent handle actions?" \\
        --cursor "➤ " \\
        "full-auto (No confirmations, agent runs autonomously)" \\
        "auto-edit (Auto-approve file edits, confirm commands)" \\
        "suggest (Agent suggests, you approve everything)")
    
    echo "$mode" | cut -d' ' -f1
}

select_sandbox_mode() {
    # Agents require full access to write response files and call messaging APIs
    # Restrictive sandbox modes break the messaging system
    print_info "Sandbox mode: Full access (required for messaging system)"
    echo "none"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Advanced Options Selection
# ═══════════════════════════════════════════════════════════════════════════════
select_advanced_options() {
    local provider="$1"
    local options=""
    
    if ! gum confirm --affirmative "Yes" --negative "No (Skip)" --default=false "Configure advanced options?"; then
        echo ""
        return 0
    fi
    
    echo ""
    print_section "Advanced Options for $provider"
    echo ""
    
    case "$provider" in
        codex-cli|default|openai|openrouter|ollama|lmstudio)
            # Codex advanced options
            local selected_features
            selected_features=$(gum choose --no-limit \\
                --header "Select additional features (space to select, enter to continue):" \\
                --cursor "➤ " \\
                --selected.foreground="212" \\
                "skip-git-repo-check (Allow running outside Git repo)" \\
                "json-output (Print events as JSONL)" \\
                "color-always (Force color output)" \\
                "color-never (Disable color output)" \\
                "oss-mode (Use open-source provider)")
            
            if echo "$selected_features" | grep -q "skip-git-repo-check"; then
                options="$options --skip-git-repo-check"
            fi
            if echo "$selected_features" | grep -q "json-output"; then
                options="$options --json"
            fi
            if echo "$selected_features" | grep -q "color-always"; then
                options="$options --color always"
            elif echo "$selected_features" | grep -q "color-never"; then
                options="$options --color never"
            fi
            if echo "$selected_features" | grep -q "oss-mode"; then
                options="$options --oss"
            fi
            
            # Additional directories
            if gum confirm "Add additional writable directories?"; then
                local add_dirs
                add_dirs=$(gum input \\
                    --placeholder "/path/to/dir1 /path/to/dir2" \\
                    --prompt "Additional directories (space-separated): ")
                if [ -n "$add_dirs" ]; then
                    for dir in $add_dirs; do
                        options="$options --add-dir \\"$dir\\""
                    done
                fi
            fi
            ;;
            
        claude)
            # Claude advanced options
            local selected_features
            selected_features=$(gum choose --no-limit \\
                --header "Select additional features (space to select, enter to continue):" \\
                --cursor "➤ " \\
                --selected.foreground="212" \\
                "debug-mode (Enable debug output)" \\
                "verbose (Override verbose mode)" \\
                "json-output (JSON output format)" \\
                "stream-json (Streaming JSON output)" \\
                "skip-permissions (Skip ALL permission checks)" \\
                "allow-skip-permissions (Enable skip option)" \\
                "continue-session (Continue most recent conversation)" \\
                "fork-session (Create new session ID when resuming)")
            
            if echo "$selected_features" | grep -q "debug-mode"; then
                options="$options --debug"
            fi
            if echo "$selected_features" | grep -q "verbose"; then
                options="$options --verbose"
            fi
            if echo "$selected_features" | grep -q "json-output"; then
                options="$options --output-format json"
            elif echo "$selected_features" | grep -q "stream-json"; then
                options="$options --output-format stream-json"
            fi
            if echo "$selected_features" | grep -q "skip-permissions"; then
                options="$options --dangerously-skip-permissions"
            fi
            if echo "$selected_features" | grep -q "allow-skip-permissions"; then
                options="$options --allow-dangerously-skip-permissions"
            fi
            if echo "$selected_features" | grep -q "continue-session"; then
                options="$options --continue"
            fi
            if echo "$selected_features" | grep -q "fork-session"; then
                options="$options --fork-session"
            fi
            
            # Custom system prompt
            if gum confirm "Add custom system prompt?"; then
                local sys_prompt
                sys_prompt=$(gum input \\
                    --placeholder "You are a helpful coding assistant..." \\
                    --prompt "System prompt: ")
                if [ -n "$sys_prompt" ]; then
                    options="$options --system-prompt \\"$sys_prompt\\""
                fi
            fi
            
            # Additional directories
            if gum confirm "Add additional directories?"; then
                local add_dirs
                add_dirs=$(gum input \\
                    --placeholder "/path/to/dir1 /path/to/dir2" \\
                    --prompt "Additional directories (space-separated): ")
                if [ -n "$add_dirs" ]; then
                    for dir in $add_dirs; do
                        options="$options --add-dir \\"$dir\\""
                    done
                fi
            fi
            
            # Allowed/disallowed tools
            if gum confirm "Restrict tool access?"; then
                local tool_choice
                tool_choice=$(gum choose \\
                    --header "Tool restriction type:" \\
                    "allow-specific (Whitelist specific tools)" \\
                    "deny-specific (Blacklist specific tools)" \\
                    "no-restriction (All tools available)")
                
                if [ "$tool_choice" = "allow-specific" ]; then
                    local allowed
                    allowed=$(gum input \\
                        --placeholder "Bash Edit Read" \\
                        --prompt "Allowed tools (space-separated): ")
                    if [ -n "$allowed" ]; then
                        options="$options --allowed-tools $allowed"
                    fi
                elif [ "$tool_choice" = "deny-specific" ]; then
                    local denied
                    denied=$(gum input \\
                        --placeholder "Bash(git:*) Edit" \\
                        --prompt "Disallowed tools (space-separated): ")
                    if [ -n "$denied" ]; then
                        options="$options --disallowed-tools $denied"
                    fi
                fi
            fi
            ;;
            
        copilot)
            # Copilot advanced options
            local selected_features
            selected_features=$(gum choose --no-limit \\
                --header "Select additional features (space to select, enter to continue):" \\
                --cursor "➤ " \\
                --selected.foreground="212" \\
                "no-color (Disable color output)" \\
                "stream-on (Enable streaming mode)" \\
                "stream-off (Disable streaming mode)" \\
                "experimental (Enable experimental features)" \\
                "screen-reader (Enable screen reader optimizations)" \\
                "plain-diff (Disable rich diff rendering)" \\
                "no-custom-instructions (Skip AGENTS.md loading)")
            
            if echo "$selected_features" | grep -q "no-color"; then
                options="$options --no-color"
            fi
            if echo "$selected_features" | grep -q "stream-on"; then
                options="$options --stream on"
            elif echo "$selected_features" | grep -q "stream-off"; then
                options="$options --stream off"
            fi
            if echo "$selected_features" | grep -q "experimental"; then
                options="$options --experimental"
            fi
            if echo "$selected_features" | grep -q "screen-reader"; then
                options="$options --screen-reader"
            fi
            if echo "$selected_features" | grep -q "plain-diff"; then
                options="$options --plain-diff"
            fi
            if echo "$selected_features" | grep -q "no-custom-instructions"; then
                options="$options --no-custom-instructions"
            fi
            
            # Additional directories
            if gum confirm "Add additional accessible directories?"; then
                local add_dirs
                add_dirs=$(gum input \\
                    --placeholder "/path/to/dir1 /path/to/dir2" \\
                    --prompt "Additional directories (space-separated): ")
                if [ -n "$add_dirs" ]; then
                    for dir in $add_dirs; do
                        options="$options --add-dir \\"$dir\\""
                    done
                fi
            fi
            
            # Tool restrictions
            if gum confirm "Restrict tool access?"; then
                local tool_choice
                tool_choice=$(gum choose \\
                    --header "Tool restriction type:" \\
                    "allow-specific (Whitelist specific tools)" \\
                    "deny-specific (Blacklist specific tools)" \\
                    "no-restriction (All tools available)")
                
                if [ "$tool_choice" = "allow-specific" ]; then
                    local allowed
                    allowed=$(gum input \\
                        --placeholder "shell(git:*) write read" \\
                        --prompt "Allowed tools (space-separated): ")
                    if [ -n "$allowed" ]; then
                        for tool in $allowed; do
                            options="$options --allow-tool $tool"
                        done
                    fi
                elif [ "$tool_choice" = "deny-specific" ]; then
                    local denied
                    denied=$(gum input \\
                        --placeholder "shell(git push) write" \\
                        --prompt "Denied tools (space-separated): ")
                    if [ -n "$denied" ]; then
                        for tool in $denied; do
                            options="$options --deny-tool $tool"
                        done
                    fi
                fi
            fi
            ;;
            
        gemini)
            # Gemini advanced options
            local selected_features
            selected_features=$(gum choose --no-limit \\
                --header "Select additional features (space to select, enter to continue):" \\
                --cursor "➤ " \\
                --selected.foreground="212" \\
                "debug-mode (Enable debug output)" \\
                "json-output (JSON output format)" \\
                "stream-json (Streaming JSON output)" \\
                "screen-reader (Enable accessibility mode)" \\
                "experimental-acp (Enable ACP mode)")
            
            if echo "$selected_features" | grep -q "debug-mode"; then
                options="$options --debug"
            fi
            if echo "$selected_features" | grep -q "json-output"; then
                options="$options --output-format json"
            elif echo "$selected_features" | grep -q "stream-json"; then
                options="$options --output-format stream-json"
            fi
            if echo "$selected_features" | grep -q "screen-reader"; then
                options="$options --screen-reader"
            fi
            if echo "$selected_features" | grep -q "experimental-acp"; then
                options="$options --experimental-acp"
            fi
            
            # Include directories
            if gum confirm "Include additional directories?"; then
                local inc_dirs
                inc_dirs=$(gum input \\
                    --placeholder "/path/to/dir1,/path/to/dir2" \\
                    --prompt "Include directories (comma-separated): ")
                if [ -n "$inc_dirs" ]; then
                    IFS=',' read -ra DIRS <<< "$inc_dirs"
                    for dir in "\${DIRS[@]}"; do
                        options="$options --include-directories \\"\${dir// /}\\""
                    done
                fi
            fi
            
            # Allowed tools
            if gum confirm "Restrict tool access?"; then
                local allowed
                allowed=$(gum input \\
                    --placeholder "tool1 tool2 tool3" \\
                    --prompt "Allowed tools (space-separated): ")
                if [ -n "$allowed" ]; then
                    for tool in $allowed; do
                        options="$options --allowed-tools $tool"
                    done
                fi
            fi
            ;;
    esac
    
    echo "$options"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Run Agent (Permission Wizard + Start Runner)
# ═══════════════════════════════════════════════════════════════════════════════
run_agent() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    
    if [ ! -f "$agent_dir/.env" ]; then
        print_error "Agent '$agent_name' not found!"
        return 1
    fi
    
    local allowed_perms_file="$agent_dir/agent_state/allowed_permissions.json"
    local config_file="$agent_dir/agent_state/agent_config.json"
    
    # Check if permissions already configured
    if [ -f "$allowed_perms_file" ]; then
        print_info "Permissions already configured"
        if ! gum confirm --affirmative "Reconfigure" --negative "Use existing" "Reconfigure allowed permissions?"; then
            print_info "Using existing permissions"
            sync_runtime_permissions "$agent_name" "$config_file" "$allowed_perms_file" || return 1
            # Just start the runner with existing config
            print_section ">> Starting Agent..."
            start_agent_foreground "$agent_name" "$agent_dir"
            return 0
        fi
    fi
    
    print_section "🔐 Permission Wizard"
    print_info "Select what the frontend is allowed to use for this agent."
    print_info "The frontend cannot escalate beyond these permissions."
    echo ""

    local setup_profile="$ARG_SETUP_PROFILE"
    if [ "$ARG_HEADLESS" != "true" ]; then
        # First decision for a new agent: allow everything, or set your own
        # per-permission defaults. The safe option is listed first so it is the
        # default cursor position.
        setup_profile=$(gum choose \\
            --header "Permissions for this agent — allow all, or set individual defaults?" \\
            --cursor "➤ " \\
            "wizard (Set individual defaults — recommended, safer)" \\
            "max-access (Allow all & skip ALL permission prompts — fastest, least safe)")
        setup_profile=$(echo "$setup_profile" | cut -d' ' -f1)
    fi
    [ -z "$setup_profile" ] && setup_profile="wizard"

    local allowed_providers
    local perms_json
    if [ "$setup_profile" = "max-access" ]; then
        print_success "Setup profile: max-access"
        print_info "Applying maximum provider access, autonomous approvals, and listen-all agent communication."
        allowed_providers=$(printf '%s\\n' \\
            "codex" \\
            "claude" \\
            "gemini" \\
            "copilot" \\
            "antigravity" \\
            "pi" \\
            "kilo" \\
            "ollama" \\
            "openrouter")
        perms_json='{"codex":{"--sandbox":["workspace-write","danger-full-access"],"--dangerously-bypass-approvals-and-sandbox":true},"claude":{"--permission-mode":["default","acceptEdits","plan","bypassPermissions"],"--dangerously-skip-permissions":true},"gemini":{"--sandbox":true,"--no-sandbox":true,"--yolo":true},"copilot":{"--allow-all":true,"--allow-all-tools":true,"--allow-all-paths":true},"antigravity":{"--sandbox":["workspace-write","danger-full-access"],"--dangerously-skip-permissions":true},"pi":{"enabled":true},"kilo":{"--auto":true},"ollama":{"enabled":true},"openrouter":{"enabled":true}}'
        echo ""
    else
        print_success "Setup profile: wizard"
        echo ""

        # Step 1: Select allowed providers
        print_info "Step 1: Select ALLOWED Providers"
        allowed_providers=$(gum choose --no-limit \\
            --header "Which providers can the frontend use?" \\
            --cursor.foreground "10" \\
            "codex" \\
            "claude" \\
            "gemini" \\
            "copilot" \\
            "antigravity" \\
            "pi" \\
            "kilo" \\
            "ollama" \\
            "openrouter")

        if [ -z "$allowed_providers" ]; then
            print_error "You must allow at least one provider!"
            return 1
        fi

        print_success "Allowed providers: $(echo "$allowed_providers" | tr '\\n' ' ')"
        echo ""

        # Initialize permissions JSON
        perms_json="{"
        local first_provider=true

        # Step 2: For each provider, configure allowed flags
        for provider in $allowed_providers; do
            [ "$first_provider" = "false" ] && perms_json+=","
            first_provider=false

            print_info "Configuring $provider permissions..."

            case "$provider" in
                codex)
                    local codex_sandbox
                    codex_sandbox=$(gum choose --no-limit \\
                        --header "Codex: Allowed --sandbox values" \\
                        "read-only" \\
                        "workspace-write" \\
                        "danger-full-access")

                    local codex_bypass="false"
                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --dangerously-bypass-approvals-and-sandbox?"; then
                        codex_bypass="true"
                    fi

                    perms_json+='"codex":{"--sandbox":['
                    local first_val=true
                    for val in $codex_sandbox; do
                        [ "$first_val" = "false" ] && perms_json+=","
                        first_val=false
                        perms_json+="\\"$val\\""
                    done
                    perms_json+='],"--dangerously-bypass-approvals-and-sandbox":'$codex_bypass'}'
                    ;;

                claude)
                    local claude_perms
                    claude_perms=$(gum choose --no-limit \\
                        --header "Claude: Allowed --permission-mode values" \\
                        "default" \\
                        "acceptEdits" \\
                        "plan" \\
                        "bypassPermissions")

                    local claude_skip="false"
                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --dangerously-skip-permissions?"; then
                        claude_skip="true"
                    else
                        claude_skip="false"
                    fi

                    perms_json+='"claude":{"--permission-mode":['
                    local first_val=true
                    for val in $claude_perms; do
                        [ "$first_val" = "false" ] && perms_json+=","
                        first_val=false
                        perms_json+="\\"$val\\""
                    done
                    perms_json+='],"--dangerously-skip-permissions":'$claude_skip'}'
                    ;;

                gemini)
                    local gemini_sandbox="false"
                    local gemini_no_sandbox="false"
                    local gemini_yolo="false"

                    if gum confirm --affirmative "Yes" --negative "No" --default=true "Allow --sandbox (sandboxed mode)?"; then
                        gemini_sandbox="true"
                    fi
                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --no-sandbox (full access)?"; then
                        gemini_no_sandbox="true"
                    fi
                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --yolo (auto-approve all)?"; then
                        gemini_yolo="true"
                    fi

                    perms_json+='"gemini":{"--sandbox":'$gemini_sandbox',"--no-sandbox":'$gemini_no_sandbox',"--yolo":'$gemini_yolo'}'
                    ;;

                copilot)
                    local copilot_allow_all="false"
                    local copilot_allow_all_tools="false"
                    local copilot_allow_all_paths="false"

                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --allow-all (full permissions)?"; then
                        copilot_allow_all="true"
                    fi
                    if [ "$copilot_allow_all" != "true" ]; then
                        if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --allow-all-tools (auto-run tools)?"; then
                            copilot_allow_all_tools="true"
                        fi
                        if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --allow-all-paths (access any path)?"; then
                            copilot_allow_all_paths="true"
                        fi
                    fi

                    perms_json+='"copilot":{"--allow-all":'$copilot_allow_all',"--allow-all-tools":'$copilot_allow_all_tools',"--allow-all-paths":'$copilot_allow_all_paths'}'
                    ;;

                antigravity)
                    local antigravity_sandbox
                    antigravity_sandbox=$(gum choose --no-limit \\
                        --header "Antigravity: Allowed sandbox values" \\
                        "workspace-write" \\
                        "danger-full-access")

                    local antigravity_skip="false"
                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow --dangerously-skip-permissions?"; then
                        antigravity_skip="true"
                    else
                        antigravity_skip="false"
                    fi

                    perms_json+='"antigravity":{"--sandbox":['
                    local first_val=true
                    for val in $antigravity_sandbox; do
                        [ "$first_val" = "false" ] && perms_json+=","
                        first_val=false
                        perms_json+="\\"$val\\""
                    done
                    perms_json+='],"--dangerously-skip-permissions":'$antigravity_skip'}'
                    ;;

                pi)
                    perms_json+='"pi":{"enabled":true}'
                    ;;

                kilo)
                    local kilo_auto="false"

                    if gum confirm --affirmative "Yes" --negative "No" --default=false "Allow kilo run --auto (non-interactive autonomous mode)?"; then
                        kilo_auto="true"
                    fi

                    perms_json+='"kilo":{"--auto":'$kilo_auto'}'
                    ;;

                ollama|openrouter)
                    # These use codex CLI under the hood, so use similar permissions
                    perms_json+='"'$provider'":{"enabled":true}'
                    ;;
            esac

            print_success "$provider permissions configured"
        done

        perms_json+="}"
    fi
    
    # Save allowed permissions
    mkdir -p "$agent_dir/agent_state"
    echo "$perms_json" | jq '.' > "$allowed_perms_file"
    print_success "Saved allowed permissions to $allowed_perms_file"
    echo ""
    
    local inter_agent_mode="disabled"
    local inter_agent_groups=""
    local group_password=""
    local group_salt=""
    local group_id=""

    # Step 3: Inter-Agent Communication
    print_info "Step 3: Inter-Agent Communication"
    if [ "$setup_profile" = "max-access" ]; then
        inter_agent_mode="listen_all"
        print_success "Inter-agent communication set to listen_all"
        echo ""
    else
        print_info "Allow this agent to communicate with other agents?"
        echo ""

        # Fetch existing groups from server
        local groups_response
        groups_response=$(curl -sL -H "X-API-Key: $API_KEY" "$API_BASE/agent/groups" 2>/dev/null || echo "{}")
        local has_groups="false"
        local group_list=""

        if echo "$groups_response" | jq -e '.groups | length > 0' &>/dev/null; then
            has_groups="true"
            group_list=$(echo "$groups_response" | jq -r '.groups[].groupName')
        fi

        # Build options based on whether groups exist
        local inter_options=("Disabled (no inter-agent)" "Listen to all agents")
        if [ "$has_groups" = "true" ]; then
            while IFS= read -r grp; do
                inter_options+=("Join group: $grp")
            done <<< "$group_list"
        fi
        inter_options+=("Create new group")

        local inter_choice
        inter_choice=$(printf '%s\\n' "\${inter_options[@]}" | gum choose \\
            --header "Inter-agent communication:" \\
            --cursor="-> ")

        case "$inter_choice" in
            "Disabled"*)
                inter_agent_mode="disabled"
                print_info "Inter-agent communication disabled"
                ;;
            "Listen to all"*)
                inter_agent_mode="listen_all"
                print_success "Agent can communicate with all other agents"
                ;;
            "Join group:"*)
                inter_agent_mode="groups"
                inter_agent_groups=$(echo "$inter_choice" | sed 's/Join group: //')

                # Prompt for group password
                echo ""
                print_info "🔐 Enter the shared group password for encrypted inter-agent DMs."
                print_info "This password must match what other agents in this group use."
                group_password=$(gum input \\
                    --password \\
                    --placeholder "Enter group password" \\
                    --prompt "Group Password: ")

                if [ -n "$group_password" ]; then
                    # Get group ID and salt from server
                    local grp_info
                    grp_info=$(echo "$groups_response" | jq -r --arg name "$inter_agent_groups" '.groups[] | select(.groupName == $name) | .groupId')

                    if [ -n "$grp_info" ]; then
                        group_id="$grp_info"
                        # Derive salt locally from password (consistent derivation)
                        group_salt=$(echo -n "$group_password" | openssl dgst -sha256 -binary | head -c 16 | base64)
                        print_success "Group password configured for encrypted DMs"
                    fi
                else
                    print_warning "No group password provided - DMs will not be encrypted"
                fi

                print_success "Agent joined group: $inter_agent_groups"
                ;;
            "Create new group")
                inter_agent_mode="groups"
                local new_group_name
                new_group_name=$(gum input \\
                    --placeholder "my-team" \\
                    --prompt "New group name: " \\
                    --width 40)

                if [ -n "$new_group_name" ]; then
                    # Prompt for new group password
                    echo ""
                    print_info "🔐 Set a shared password for encrypted inter-agent DMs."
                    print_info "Share this password with other agents joining this group."
                    group_password=$(gum input \\
                        --password \\
                        --placeholder "Create group password" \\
                        --prompt "Group Password: ")

                    local enc_salt_param=""
                    if [ -n "$group_password" ]; then
                        # Generate salt from password (consistent derivation)
                        group_salt=$(echo -n "$group_password" | openssl dgst -sha256 -binary | head -c 16 | base64)
                        enc_salt_param=", \\"encryptionSalt\\": \\"$group_salt\\""
                    fi

                    local create_result
                    create_result=$(curl -sL -X POST \\
                        -H "X-API-Key: $API_KEY" \\
                        -H "Content-Type: application/json" \\
                        -d "{\\"groupName\\": \\"$new_group_name\\"$enc_salt_param}" \\
                        "$API_BASE/agent/groups" 2>/dev/null)

                    if echo "$create_result" | jq -e '.groupId' &>/dev/null; then
                        inter_agent_groups="$new_group_name"
                        group_id=$(echo "$create_result" | jq -r '.groupId')
                        print_success "Created and joined group: $new_group_name"
                        if [ -n "$group_password" ]; then
                            print_success "Group encryption enabled for inter-agent DMs"
                        fi
                    else
                        print_warning "Could not create group, using listen_all"
                        inter_agent_mode="listen_all"
                        group_password=""
                        group_salt=""
                    fi
                else
                    inter_agent_mode="listen_all"
                fi
                ;;
        esac
        echo ""
    fi
    
    # Update allowed_permissions.json with inter-agent settings
    local inter_agent_json
    if [ "$inter_agent_mode" = "disabled" ]; then
        inter_agent_json='{"enabled": false}'
    elif [ "$inter_agent_mode" = "listen_all" ]; then
        inter_agent_json='{"enabled": true, "mode": "listen_all"}'
    else
        inter_agent_json=$(echo '{"enabled": true, "mode": "groups"}' | jq --arg g "$inter_agent_groups" '. + {groups: [$g]}')
    fi
    
    local updated_perms
    updated_perms=$(cat "$allowed_perms_file" | jq --argjson ia "$inter_agent_json" '. + {inter_agent: $ia}')
    echo "$updated_perms" > "$allowed_perms_file"
    
    # Store group password and salt in .env if set
    if [ -n "$group_password" ] && [ -n "$group_salt" ]; then
        echo "" >> "$agent_dir/.env"
        echo "# Inter-agent DM encryption (group-specific)" >> "$agent_dir/.env"
        echo "GROUP_PASSWORD=\"$group_password\"" >> "$agent_dir/.env"
        echo "GROUP_SALT=\"$group_salt\"" >> "$agent_dir/.env"
        if [ -n "$group_id" ]; then
            echo "GROUP_ID=\"$group_id\"" >> "$agent_dir/.env"
        fi
    fi

    
    # Append inter-agent instructions to AGENT_INSTRUCTIONS.md if enabled
    if [ "$inter_agent_mode" != "disabled" ]; then
        local agent_instr_file="$agent_dir/AGENT_INSTRUCTIONS.md"
        if [ -f "$agent_instr_file" ]; then
            cat >> "$agent_instr_file" <<'INTERAGENTINSTR'

## Inter-Agent Communication

You can communicate with other agents on this account using the message_helper.py tool:

### Discover Other Agents
\`\`\`bash
uv run message_helper.py discover          # List all agents you can talk to
uv run message_helper.py discover --online # List only online agents
\`\`\`

### Send Direct Messages to Other Agents
\`\`\`bash
uv run message_helper.py dm "AgentName" "Hello, can you help with this task?"
uv run message_helper.py dm "AgentName" "Urgent request!" --priority 2
\`\`\`

### Check for Messages from Other Agents
\`\`\`bash
uv run message_helper.py dm check                    # Check all agent messages
uv run message_helper.py dm check --from "AgentName" # From specific agent
\`\`\`

### Auto-Discovery
On startup, run \`discover\` to see available peers. Re-run periodically during long tasks
to detect newly spawned agents.

### Best Practices
- Use \`discover\` first to see which agents are available
- Check for agent messages periodically during long tasks
- Coordinate with other agents on complex multi-step tasks
- Use priority 2 for urgent coordination requests
INTERAGENTINSTR
            print_success "Added inter-agent communication instructions"
        fi
    fi

    # Step 4: Configure project path
    print_info "Step 4: Set Project Path"
    print_info "This is the directory where the agent will work."
    print_info "The agent cannot access files outside this directory (when sandboxed)."
    echo ""
    
    local default_project_path
    default_project_path="$(pwd)"
    
    local project_path
    project_path=$(gum input \\
        --placeholder "$default_project_path" \\
        --prompt "Project path: " \\
        --value "$default_project_path" \\
        --width 80)
    
    # Validate path exists
    if [ ! -d "$project_path" ]; then
        print_warning "Directory '$project_path' does not exist."
        if gum confirm --affirmative "Create it" --negative "Use default" "Create this directory?"; then
            mkdir -p "$project_path"
            print_success "Created: $project_path"
        else
            project_path="$default_project_path"
            print_info "Using default: $project_path"
        fi
    fi
    
    # Resolve to absolute path
    project_path="$(cd "$project_path" && pwd)"
    print_success "Project path: $project_path"
    echo ""
    
    # Store project path in allowed_permissions.json (immutable setting)
    local updated_perms
    updated_perms=$(cat "$allowed_perms_file" | jq --arg path "$project_path" '. + {"project_path": $path}')
    echo "$updated_perms" > "$allowed_perms_file"
    
    # Create default config (frontend will update this)
    local first_provider_name
    first_provider_name=$(echo "$allowed_providers" | head -1)
    
    # Determine initial config from allowed permissions (highest level)
    local initial_sandbox="workspace-write"
    local initial_approval="suggest"
    case "$first_provider_name" in
        codex|default|ollama|openrouter)
            if echo "$perms_json" | grep -q '"--dangerously-bypass-approvals-and-sandbox":true'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            elif echo "$perms_json" | grep -q '"danger-full-access"'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            elif echo "$perms_json" | grep -q '"workspace-write"'; then
                initial_sandbox="workspace-write"
                initial_approval="full-auto"
            fi
            ;;
        claude)
            if echo "$perms_json" | grep -q '"--dangerously-skip-permissions":true'; then
                initial_sandbox="none"
                initial_approval="bypassPermissions"
            elif echo "$perms_json" | grep -q '"bypassPermissions"'; then
                initial_sandbox="none"
                initial_approval="bypassPermissions"
            elif echo "$perms_json" | grep -q '"acceptEdits"'; then
                initial_approval="acceptEdits"
            fi
            ;;
        gemini)
            if echo "$perms_json" | grep -q '"--yolo":true'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            elif echo "$perms_json" | grep -q '"--no-sandbox":true'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            fi
            ;;
        copilot)
            if echo "$perms_json" | grep -q '"--allow-all":true\\|"--yolo":true'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            elif echo "$perms_json" | grep -q '"--allow-all-tools":true'; then
                initial_sandbox="workspace-write"
                initial_approval="full-auto"
            fi
            ;;
        kilo)
            if echo "$perms_json" | grep -q '"kilo":{"--auto":true'; then
                initial_sandbox="none"
                initial_approval="full-auto"
            fi
            ;;
    esac
    
    cat > "$config_file" <<CFGEOF
{
  "model_provider": "$first_provider_name",
  "model": "default",
  "approval_mode": "$initial_approval",
  "sandbox_mode": "$initial_sandbox",
  "project_path": "$project_path",
  "started_at": "$(date -Iseconds)"
}
CFGEOF
    sync_runtime_permissions "$agent_name" "$config_file" "$allowed_perms_file" || return 1
    
    print_success "Created default config (frontend can change this)"
    echo ""
    
    # Show summary
    print_section "✅ Permissions Configured"
    gum style \\
        --border rounded \\
        --padding "1 2" \\
        --margin "1 0" \\
        --border-foreground 36 \\
        "Allowed providers: $(echo "$allowed_providers" | tr '\\n' ', ')
        
Configuration is now controlled from the web dashboard.
Open the dashboard, select this agent, and use the
Config (⚙️) button to change provider/model/mode.

The agent will load new config at each loop iteration."
    
    echo ""
    local start_choice
    start_choice=$(gum choose --header "Start the agent runner now?" \
        "Start here (this terminal)" \
        "Start in background (tmux, auto-restart on crash)" \
        "Cancel") || start_choice="Cancel"
    case "$start_choice" in
        "Start in background"*)
            start_agent_session "$agent_name" restart
            return $?
            ;;
        "Start here"*)
            print_section ">> Starting Agent..."
            echo ""
            start_agent_foreground "$agent_name" "$agent_dir"
            return 0
            ;;
        *)
            print_info "You can start the agent later by running this script again."
            return 0
            ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# View Agent Status
# ═══════════════════════════════════════════════════════════════════════════════
view_agent_status() {
    print_section "Agent Status"
    echo ""
    
    local agents
    agents=$(get_existing_agents)
    
    if [ -z "$agents" ]; then
        print_info "No agents found. Create one first!"
        return
    fi
    
    echo "$agents" | while read -r agent_name; do
        if [ -z "$agent_name" ]; then continue; fi
        
        local folder
        folder=$(get_agent_folder "$agent_name")
        local agent_dir="$CHATSPACE_DIR/$folder"
        
        local status="○ Stopped"
        local last_active="Never"
        local sessions="0"
        local spawned_badge=""

        if [ -f "$agent_dir/agent_state/agent_config.json" ]; then
            last_active=$(jq -r '.started_at // "Unknown"' "$agent_dir/agent_state/agent_config.json" 2>/dev/null || echo "Unknown")
        fi
        
        if [ -f "$agent_dir/agent_state/conversation_history.json" ]; then
            sessions=$(jq -r '.session_count // 0' "$agent_dir/agent_state/conversation_history.json" 2>/dev/null || echo "0")
        fi
        
        if [ -f "$agent_dir/agent_state/.running" ]; then
            status="● Running"
        fi

        if is_spawned_agent "$agent_name"; then
            spawned_badge=" [spawned]"
        fi
        
        echo "  $status  $agent_name$spawned_badge"
        echo "         Last active: $last_active"
        echo "         Sessions: $sessions"
        echo ""
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Agent Stop Control
# ═══════════════════════════════════════════════════════════════════════════════
stop_agent_control() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        print_error "Agent name is required"
        return 1
    fi

    local response=""
    response=$(curl -sL -X POST \\
        -H "X-API-Key: $API_KEY" \\
        -H "Content-Type: application/json" \\
        -d "{\\"agentName\\": \\"$agent_name\\"}" \\
        "$API_BASE/agent/stop" 2>/dev/null || true)

    if [ -n "$response" ] && command -v jq &>/dev/null; then
        local error_msg
        error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null || true)
        if [ -n "$error_msg" ]; then
            print_error "Failed to stop '$agent_name': $error_msg"
            return 1
        fi

        local confirmation
        local resolved_name
        confirmation=$(echo "$response" | jq -r '.message // empty' 2>/dev/null || true)
        resolved_name=$(echo "$response" | jq -r '.agentName // empty' 2>/dev/null || true)
        if [ -n "$resolved_name" ]; then
            print_success "Stop requested for '$resolved_name'"
        else
            print_success "Stop requested for '$agent_name'"
        fi
        [ -n "$confirmation" ] && print_info "$confirmation"
        return 0
    fi

    # Fallback: write local stop flag when API is unavailable
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    local stop_flag="$agent_dir/agent_state/.stop_requested"
    if [ -d "$agent_dir" ]; then
        mkdir -p "$agent_dir/agent_state"
        date -Iseconds > "$stop_flag"
        print_success "Stop flag written for '$agent_name'"
        print_info "API was unavailable; requested stop via local filesystem flag."
        return 0
    fi

    print_error "Failed to request stop for '$agent_name'"
    return 1
}

delete_agent_control() {
    local agent_name="$1"
    if [ -z "$agent_name" ]; then
        print_error "Agent name is required"
        return 1
    fi

    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"

    stop_agent_control "$agent_name" >/dev/null 2>&1 || true

    local response=""
    response=$(curl -sL -X POST \
        -H "X-API-Key: $API_KEY" \
        -H "X-Agent-Name: $agent_name" \
        -H "Content-Type: application/json" \
        -d '{"reason":"Deleted from agent-cli.sh","archiveMessages":true}' \
        "$API_BASE/agent/self-terminate" 2>/dev/null || true)

    if [ -n "$response" ] && command -v jq &>/dev/null; then
        local error_msg
        error_msg=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null || true)
        if [ -n "$error_msg" ]; then
            print_warning "Backend delete returned: $error_msg"
        else
            local archived_name
            archived_name=$(echo "$response" | jq -r '.agentName // empty' 2>/dev/null || true)
            if [ -n "$archived_name" ]; then
                print_success "Deleted backend record for '$archived_name'"
            else
                print_success "Deleted backend record for '$agent_name'"
            fi
        fi
    fi

    if [ -d "$agent_dir" ]; then
        rm -rf "$agent_dir"
        print_success "Removed local folder: $agent_dir"
    else
        print_info "No local folder found for '$agent_name'"
    fi

    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# File Generation Functions
# ═══════════════════════════════════════════════════════════════════════════════
create_message_helper() {
    local agent_dir="$1"
    
    cat > "$agent_dir/message_helper.py" <<'PYEOF'
${pythonHelper}
PYEOF
    chmod 644 "$agent_dir/message_helper.py"
}

create_agent_instructions() {
    local agent_dir="$1"
    local agent_name="$2"
    local agent_type="\${3:-standard}"
    
    if [ "$agent_type" = "news_feed" ]; then
        cat > "$agent_dir/AGENT_INSTRUCTIONS.md" <<'NFINSTREOF'
${newsFeedAgentInstructions}
NFINSTREOF
    else
        cat > "$agent_dir/AGENT_INSTRUCTIONS.md" <<'INSTREOF'
${agentInstructions}
INSTREOF
    fi
    chmod 644 "$agent_dir/AGENT_INSTRUCTIONS.md"
}

create_oneshot_instructions() {
    local agent_dir="$1"
    local agent_name="$2"
    
    cat > "$agent_dir/ONESHOT_AGENT_INSTRUCTIONS.md" <<'OSEOF'
${oneshotInstructions}
OSEOF
    chmod 644 "$agent_dir/ONESHOT_AGENT_INSTRUCTIONS.md"
}

create_rich_form_skill() {
    local agent_dir="$1"
    
    cat > "$agent_dir/SKILL_RICH_FORMS.md" <<'RICHEOF'
${richFormSkill}
RICHEOF
    chmod 644 "$agent_dir/SKILL_RICH_FORMS.md"
}

create_self_wake_guide() {
    local agent_dir="$1"

    cat > "$agent_dir/SELF_WAKE_GUIDE.md" <<'WAKEEOF'
${selfWakeGuide}
WAKEEOF
    chmod 644 "$agent_dir/SELF_WAKE_GUIDE.md"
}

create_agent_runner() {
    local agent_dir="$1"
    
    cat > "$agent_dir/agent-runner.sh" <<'RUNNEREOF'
${agentRunner}
RUNNEREOF
    chmod 755 "$agent_dir/agent-runner.sh"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Autostart / Persistent Agent Management (systemd user services)
# ═══════════════════════════════════════════════════════════════════════════════
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

get_service_name() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    echo "agent-$folder"
}

is_autostart_enabled() {
    local agent_name="$1"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    if systemctl --user is-enabled "$service_name.service" &>/dev/null; then
        return 0
    fi
    return 1
}

is_agent_running_service() {
    local agent_name="$1"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    if systemctl --user is-active "$service_name.service" &>/dev/null; then
        return 0
    fi
    return 1
}

create_systemd_service() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    mkdir -p "$SYSTEMD_USER_DIR"
    
    cat > "$SYSTEMD_USER_DIR/$service_name.service" <<SVCEOF
[Unit]
Description=Agent Runner - $agent_name
After=network.target
StartLimitIntervalSec=10min
StartLimitBurst=8

[Service]
Type=simple
WorkingDirectory=$agent_dir
ExecStart=$agent_dir/agent-runner.sh
# A runner can exit cleanly after an interrupted CLI or transient local
# failure.  Keep long-lived agents (Chiefs and regular agents alike) online
# unless the user explicitly stops the systemd unit.
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Environment
Environment="HOME=$HOME"
Environment="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
SVCEOF
    
    print_success "Created systemd service: $service_name.service"
}

enable_autostart() {
    local agent_name="$1"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    # Create the service file
    create_systemd_service "$agent_name"
    
    # Reload systemd to pick up new service
    systemctl --user daemon-reload
    
    # Enable the service (starts on boot)
    if systemctl --user enable "$service_name.service" &>/dev/null; then
        print_success "Autostart enabled for '$agent_name'"
        
        # Update agent_config.json
        local folder
        folder=$(get_agent_folder "$agent_name")
        local config_file="$CHATSPACE_DIR/$folder/agent_state/agent_config.json"
        if [ -f "$config_file" ]; then
            local updated
            updated=$(jq '.autostart = true' "$config_file")
            echo "$updated" > "$config_file"
        fi
        
        # Ask if user wants to start now
        echo ""
        if gum confirm --affirmative "Start Now" --negative "Start on Next Boot" "Start the agent service now?"; then
            if systemctl --user start "$service_name.service"; then
                print_success "Agent service started!"
                print_info "View logs: journalctl --user -u $service_name.service -f"
            else
                print_error "Failed to start service. Check logs with: journalctl --user -u $service_name.service"
            fi
        else
            print_info "Agent will start automatically on next login/reboot."
        fi
    else
        print_error "Failed to enable autostart"
        return 1
    fi
}

disable_autostart() {
    local agent_name="$1"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    # Stop the service if running
    if is_agent_running_service "$agent_name"; then
        print_info "Stopping agent service..."
        systemctl --user stop "$service_name.service"
    fi
    
    # Disable the service
    if systemctl --user disable "$service_name.service" &>/dev/null; then
        print_success "Autostart disabled for '$agent_name'"
        
        # Update agent_config.json
        local folder
        folder=$(get_agent_folder "$agent_name")
        local config_file="$CHATSPACE_DIR/$folder/agent_state/agent_config.json"
        if [ -f "$config_file" ]; then
            local updated
            updated=$(jq '.autostart = false' "$config_file")
            echo "$updated" > "$config_file"
        fi
        
        # Optionally remove the service file
        if [ -f "$SYSTEMD_USER_DIR/$service_name.service" ]; then
            rm "$SYSTEMD_USER_DIR/$service_name.service"
            systemctl --user daemon-reload
            print_info "Removed service file"
        fi
    else
        print_error "Failed to disable autostart"
        return 1
    fi
}

view_service_status() {
    local agent_name="$1"
    local service_name
    service_name=$(get_service_name "$agent_name")
    
    echo ""
    print_section "Service Status: $agent_name"
    echo ""
    
    if systemctl --user status "$service_name.service" 2>/dev/null; then
        echo ""
    else
        print_info "Service not found or not running"
    fi
    
    echo ""
    if gum confirm --affirmative "View Logs" --negative "Back" "View recent logs?"; then
        echo ""
        journalctl --user -u "$service_name.service" --no-pager -n 50 2>/dev/null || print_info "No logs available"
    fi
}

manage_autostart() {
    print_section "⚙️  Manage Autostart"
    echo ""
    
    # Check if systemd user services are available
    if ! command -v systemctl &>/dev/null; then
        print_error "systemctl not found. Autostart requires systemd."
        print_info "This feature is only available on Linux systems with systemd."
        gum input --placeholder "Press Enter to continue..."
        return 1
    fi
    
    # Check if user linger is enabled (required for services to run without login)
    local user_linger_enabled="false"
    if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
        user_linger_enabled="true"
    fi
    
    local existing_agents
    existing_agents=$(get_existing_agents)
    
    # Build menu with current status
    local agent_list=()
    local labeled_agents=""
    
    while IFS= read -r agent_name; do
        [ -z "$agent_name" ] && continue
        
        local status_icon="○"
        local autostart_icon="○"
        
        if is_agent_running_service "$agent_name"; then
            status_icon="●"
        fi
        
        if is_autostart_enabled "$agent_name"; then
            autostart_icon="✓"
        fi
        
        agent_list+=("$agent_name")
        labeled_agents+="\${status_icon} [\${autostart_icon}] $(format_agent_label "$agent_name")"$'\\n'
    done <<< "$existing_agents"
    
    echo ""
    gum style \\
        --border rounded \\
        --padding "1 2" \\
        --border-foreground 212 \\
        "Legend:" \\
        "  ● = Service Running    ○ = Service Stopped" \\
        "  [✓] = Autostart ON    [○] = Autostart OFF"
    echo ""
    
    if [ "$user_linger_enabled" = "false" ]; then
        print_warning "User linger is not enabled!"
        print_info "Services may stop when you log out."
        print_info "Enable with: sudo loginctl enable-linger $USER"
        echo ""
    fi
    
    local selected_label
    selected_label=$(printf '%s' "$labeled_agents" | sed '/^$/d' | gum choose \\
        --header "Select an agent to configure:" \\
        --cursor "➤ ")

    local selected_agent
    selected_agent=$(extract_agent_name_from_label "\${selected_label#*] }")
    
    if [ -z "$selected_agent" ]; then
        return 0
    fi
    
    echo ""
    print_section "Configure: $selected_agent"
    
    local action
    if is_autostart_enabled "$selected_agent"; then
        action=$(gum choose \\
            --header "Autostart is currently ENABLED" \\
            --cursor "➤ " \\
            "🔄 Restart Service" \\
            "⏹️  Stop Service" \\
            "❌ Disable Autostart" \\
            "📋 View Status & Logs" \\
            "🔙 Back")
    else
        action=$(gum choose \\
            --header "Autostart is currently DISABLED" \\
            --cursor "➤ " \\
            "✅ Enable Autostart" \\
            "▶️  Start Once (no autostart)" \\
            "📋 View Status & Logs" \\
            "🔙 Back")
    fi
    
    case "$action" in
        "✅ Enable Autostart")
            echo ""
            gum style \\
                --border rounded \\
                --padding "1 2" \\
                --margin "1 0" \\
                --border-foreground 36 \\
                "This will create a systemd user service that:" \\
                "" \\
                "• Starts the agent automatically on login/reboot" \\
                "• Restarts the agent if it crashes" \\
                "• Runs in the background (no terminal needed)" \\
                "" \\
                "The agent will use permissions configured during setup."
            echo ""
            
            if gum confirm --affirmative "Enable" --negative "Cancel" "Enable autostart for '$selected_agent'?"; then
                enable_autostart "$selected_agent"
            fi
            ;;
        "❌ Disable Autostart")
            if gum confirm --affirmative "Disable" --negative "Cancel" --default=false "Disable autostart for '$selected_agent'?"; then
                disable_autostart "$selected_agent"
            fi
            ;;
        "🔄 Restart Service")
            local service_name
            service_name=$(get_service_name "$selected_agent")
            print_info "Restarting service..."
            if systemctl --user restart "$service_name.service"; then
                print_success "Service restarted!"
            else
                print_error "Failed to restart service"
            fi
            ;;
        "⏹️  Stop Service")
            local service_name
            service_name=$(get_service_name "$selected_agent")
            print_info "Stopping service..."
            if systemctl --user stop "$service_name.service"; then
                print_success "Service stopped"
                print_info "Note: It will start again on next reboot (autostart still enabled)"
            else
                print_error "Failed to stop service"
            fi
            ;;
        "▶️  Start Once (no autostart)")
            local folder
            folder=$(get_agent_folder "$selected_agent")
            local agent_dir="$CHATSPACE_DIR/$folder"
            print_info "Starting agent in foreground (Ctrl+C to stop)..."
            start_agent_foreground "$selected_agent" "$agent_dir"
            ;;
        "📋 View Status & Logs")
            view_service_status "$selected_agent"
            ;;
        "🔙 Back"|"")
            return 0
            ;;
    esac
    
    echo ""
    gum input --placeholder "Press Enter to continue..."
}

# ═══════════════════════════════════════════════════════════════════════════════
# COMMANDS
# ═══════════════════════════════════════════════════════════════════════════════
main_menu() {
    while true; do
        print_header
        
        local existing_agents
        existing_agents=$(get_existing_agents)
        local agent_count=0
        if [ -n "$existing_agents" ]; then
            agent_count=$(echo "$existing_agents" | wc -l | tr -d ' ')
        fi
        
        if [ "$agent_count" -gt 0 ]; then
            print_info "Found $agent_count existing agent(s)"
        fi
        echo ""

        local labeled_agents=""
        if [ -n "$existing_agents" ]; then
            while IFS= read -r agent_name; do
                [ -z "$agent_name" ] && continue
                labeled_agents+=$(format_agent_label "$agent_name")
                labeled_agents+=$'\\n'
            done <<< "$existing_agents"
        fi
        
        local choice
        choice=$(gum choose \\
            --header "What would you like to do?" \\
            --cursor "➤ " \\
            "🆕 Create New Agent" \\
            "▶️  Continue Existing Agent" \\
            "⏹️  Stop Running Agent" \\
            "🗑️  Delete Agent" \\
            "📊 View Agent Status" \\
            "⚙️  Manage Autostart" \\
            "❌ Exit")
        
        case "$choice" in
            "🆕 Create New Agent")
                create_agent
                ;;
            "▶️  Continue Existing Agent")
                if [ "$agent_count" -eq 0 ]; then
                    print_error "No existing agents found. Create one first!"
                    sleep 2
                else
                    local selected_label
                    selected_label=$(printf '%s' "$labeled_agents" | sed '/^$/d' | gum choose \\
                        --header "Select an agent to continue:" \\
                        --cursor "➤ ")
                    
                    local selected_agent
                    selected_agent=$(extract_agent_name_from_label "$selected_label")
                    if [ -n "$selected_agent" ]; then
                        run_agent "$selected_agent"
                    fi
                fi
                ;;
            "⏹️  Stop Running Agent")
                if [ "$agent_count" -eq 0 ]; then
                    print_error "No existing agents found. Create one first!"
                    sleep 2
                else
                    local selected_label
                    selected_label=$(printf '%s' "$labeled_agents" | sed '/^$/d' | gum choose \\
                        --header "Select an agent to stop:" \\
                        --cursor "➤ ")
                    local selected_agent
                    selected_agent=$(extract_agent_name_from_label "$selected_label")
                    if [ -n "$selected_agent" ]; then
                        stop_agent_control "$selected_agent"
                        gum input --placeholder "Press Enter to continue..."
                    fi
                fi
                ;;
            "🗑️  Delete Agent")
                if [ "$agent_count" -eq 0 ]; then
                    print_error "No existing agents found. Create one first!"
                    sleep 2
                else
                    local selected_label
                    selected_label=$(printf '%s' "$labeled_agents" | sed '/^$/d' | gum choose \\
                        --header "Select an agent to delete:" \\
                        --cursor "➤ ")
                    local selected_agent
                    selected_agent=$(extract_agent_name_from_label "$selected_label")
                    if [ -n "$selected_agent" ]; then
                        if gum confirm --affirmative "Delete" --negative "Cancel" --default=false "Delete '$selected_agent'? This removes the local folder and requests backend termination."; then
                            delete_agent_control "$selected_agent"
                        fi
                        gum input --placeholder "Press Enter to continue..."
                    fi
                fi
                ;;
            "📊 View Agent Status")
                view_agent_status
                gum input --placeholder "Press Enter to continue..."
                ;;
            "⚙️  Manage Autostart")
                if [ "$agent_count" -eq 0 ]; then
                    print_error "No existing agents found. Create one first!"
                    sleep 2
                else
                    manage_autostart
                fi
                ;;
            "❌ Exit")
                print_info "Goodbye!"
                exit 0
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# News Feed Agent Setup
# ═══════════════════════════════════════════════════════════════════════════════
NEWS_FEED_MARKER="$CHATSPACE_DIR/.news_feed_configured"

find_existing_news_feed_folder() {
    local dir
    for dir in "$CHATSPACE_DIR"/local_news_*; do
        if [ -d "$dir" ]; then
            basename "$dir"
            return 0
        fi
    done
    return 1
}

ensure_provider_instructions() {
    local news_feed_folder=""
    if ! news_feed_folder=$(find_existing_news_feed_folder); then
        return 0
    fi

    if [ ! -s "$SCRIPT_DIR/AGENTS.md" ] || [ ! -s "$SCRIPT_DIR/CLAUDE.md" ] || [ ! -s "$SCRIPT_DIR/GEMINI.md" ]; then
        create_provider_instructions "$news_feed_folder"
    fi
}

check_news_feed_agent() {
    # Check if marker file exists
    if [ -f "$NEWS_FEED_MARKER" ]; then
        ensure_provider_instructions
        return 0
    fi
    
    # Also check if any local news feed folder already exists
    if find_existing_news_feed_folder >/dev/null; then
        # News feed already exists, create marker and skip
        touch "$NEWS_FEED_MARKER"
        ensure_provider_instructions
        return 0
    fi
    
    echo ""
    gum style \\
        --border rounded \\
        --padding "1 2" \\
        --margin "1 0" \\
        --border-foreground 212 \\
        "📋 Local News Feed" \\
        "" \\
        "Would you like to create the Local News Feed?" \\
        "This is a read-only activity log where all your" \\
        "agents can post execution summaries."
    
    echo ""
    if gum confirm --affirmative "Yes, create it" --negative "Skip for now" "Create Local News Feed?"; then
        setup_news_feed_agent
    else
        print_info "Skipping Local News Feed. You can create it later."
    fi
    
    touch "$NEWS_FEED_MARKER"
    echo ""
}

setup_news_feed_agent() {
    print_section "News Feed Setup"
    echo ""
    
    local default_name
    default_name=$(basename "$SCRIPT_DIR")
    
    print_info "Give your project a name (used in 'Local News - {name}')"
    local project_name
    project_name=$(gum input \\
        --placeholder "$default_name" \\
        --prompt "Project Name: " \\
        --width 40 \\
        --value "$default_name")
    
    if [ -z "$project_name" ]; then
        project_name="$default_name"
    fi
    
    local news_feed_name="Local News - $project_name"
    print_success "News Feed will be named: $news_feed_name"
    echo ""
    
    local user_password=""
    if [ "$HAS_ENCRYPTION" = "true" ]; then
        print_info "🔐 Enter your account password to enable encrypted messages."
        user_password=$(gum input \\
            --password \\
            --placeholder "Enter your account password" \\
            --prompt "Password: ")
        
        if [ -z "$user_password" ]; then
            print_warning "No password provided - messages will not be encrypted."
        else
            print_success "Password received - messages will be encrypted"
        fi
    fi
    echo ""
    
    create_news_feed_agent "$news_feed_name" "$user_password"
    create_provider_instructions "$news_feed_name"
    print_success "Local News Feed created and provider instructions added!"
}

create_news_feed_agent() {
    local agent_name="$1"
    local user_password="$2"
    
    print_section "Creating News Feed Agent..."
    
    # Create local folder for the news feed agent
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    
    mkdir -p "$agent_dir"
    mkdir -p "$agent_dir/agent_state"
    
    # Create .env file
    cat > "$agent_dir/.env" <<ENVEOF
# Agent Messaging Environment Configuration
# KEEP THIS FILE SECURE - DO NOT SHARE WITH AGENT
USER_PASSWORD="$user_password"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$agent_name"
ENVEOF
    chmod 600 "$agent_dir/.env"
    print_success "Created: $agent_dir/.env"
    
    # Create message_helper.py (so other agents can post to this news feed)
    create_message_helper "$agent_dir"
    print_success "Created: $agent_dir/message_helper.py"
    
    # Create agent instructions (news_feed type)
    create_agent_instructions "$agent_dir" "$agent_name" "news_feed"
    print_success "Created: $agent_dir/AGENT_INSTRUCTIONS.md"
    
    # Initialize state files
    echo '[]' > "$agent_dir/agent_state/.scheduled_tasks.json"
    echo '{"session_count": 0}' > "$agent_dir/agent_state/conversation_history.json"
    
    # Create agent_summary.md with news feed template
    cat > "$agent_dir/agent_state/agent_summary.md" <<SUMMARYEOF
# News Feed Agent - $agent_name

## Purpose
This is a centralized news feed agent. Other agents post their execution summaries here.

## Usage
- **Read-only**: User messages are stored as notes
- **No runner**: This agent does not execute tasks  
- **Cross-agent visibility**: Any agent can read this log for context

## How to Post
From any agent, use:
\\\`\\\`\\\`python
from message_helper import send_message
send_message("Your update here", agent_name="$agent_name")
\\\`\\\`\\\`

## Created
$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SUMMARYEOF
    print_success "Created: $agent_dir/agent_state/agent_summary.md"
    
    # Create .gitignore
    cat > "$agent_dir/.gitignore" <<GITIGNOREOF
# Never commit .env file - it contains secrets!
.env

# Agent runtime files
agent_state/.agent_response.txt
agent_state/.wait_state.json
agent_state/.running
GITIGNOREOF
    print_success "Created: $agent_dir/.gitignore"
    
    # Now send the initial message to register the agent in the database
    local content="📋 **Activity Log Initialized**

This is your centralized news feed. All agents will post their execution summaries here.

- **Read-only**: User messages are stored as notes
- **No runner**: This agent does not execute tasks  
- **Cross-agent visibility**: Any agent can read this log for context"
    local encrypted="false"
    
    if [ -n "$user_password" ] && [ "$HAS_ENCRYPTION" = "true" ]; then
        print_info "Encrypting initial message..."
        local encrypted_content
        encrypted_content=$(python3 -c "
import base64, hashlib, os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
pw='$user_password'
salt=base64.b64decode('$ENCRYPTION_SALT')
key=hashlib.pbkdf2_hmac('sha256',pw.encode(),salt,100000,32)
iv=os.urandom(12)
ct=AESGCM(key).encrypt(iv,'''$content'''.encode(),None)
print(f'{base64.b64encode(iv).decode()}:{base64.b64encode(ct[-16:]).decode()}:{base64.b64encode(ct[:-16]).decode()}')
" 2>/dev/null) || echo ""
        
        if [ -n "$encrypted_content" ]; then
            content="$encrypted_content"
            encrypted="true"
            print_success "Message encrypted"
        fi
    fi
    
    # Build JSON payload properly using jq to handle escaping
    local json_payload
    json_payload=$(jq -n \\
        --arg name "$agent_name" \\
        --arg type "news_feed" \\
        --arg content "$content" \\
        --argjson priority 0 \\
        --argjson encrypted "$encrypted" \\
        '{agentName: $name, agentType: $type, content: $content, priority: $priority, encrypted: $encrypted}')
    
    local response
    response=$(curl -s -X POST "$API_BASE/agent/messages" \\
        -H "X-API-Key: $API_KEY" \\
        -H "Content-Type: application/json" \\
        -d "$json_payload")
    
    local status
    status=$(echo "$response" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
    
    if [ "$status" = "sent" ]; then
        print_success "$agent_name registered in database!"
    else
        print_warning "Could not register $agent_name in database automatically."
        echo "Server response: $response"
        print_info "You can manually create it from the dashboard."
    fi
    
    echo ""
    print_success "News Feed agent folder created at: $agent_dir"
}

create_provider_instructions() {
    local news_feed_name="\${1:-Local News Feed}"
    
    # Calculate the folder name for the news feed agent
    local news_feed_folder
    news_feed_folder=$(get_agent_folder "$news_feed_name")
    
    print_section "Creating provider instruction files..."

    # Helper function to append or create file
    # Usage: append_or_create_file <filepath> <content>
    append_or_create_file() {
        local filepath="$1"
        local content="$2"
        
        if [ -f "$filepath" ] && [ -s "$filepath" ]; then
            # File exists and has content, append with separator
            echo "" >> "$filepath"
            echo "---" >> "$filepath"
            echo "" >> "$filepath"
            echo "$content" >> "$filepath"
        else
            # File doesn't exist or is empty, create new
            echo "$content" > "$filepath"
        fi
    }

    # Generate provider docs (AGENTS.md for Codex, CLAUDE.md for Claude, GEMINI.md for Gemini)
    # All three share identical structure — only the provider name and filename differ.
    local provider_names=("Codex" "Claude" "Gemini")
    local provider_files=("AGENTS.md" "CLAUDE.md" "GEMINI.md")
    local provider_clis=("Codex" "Claude" "Gemini")

    for i in 0 1 2; do
        local pname="\${provider_names[$i]}"
        local pfile="\${provider_files[$i]}"
        local pcli="\${provider_clis[$i]}"
        local provider_content
        # NOTE: Use a quoted heredoc (<<'PROVIDEREOF') so the JSON example below
        # — which contains unescaped " characters — does not break bash quoting.
        # Variables \$pname / \$pcli are inserted via sed placeholder replacement
        # after the heredoc closes. See tests/utils/apiGuideGenerator.test.js
        # for the regression covering this (bug: "task: command not found").
        provider_content=$(cat <<'PROVIDEREOF'
# Agent Instructions for __PROVIDER_NAME__

This file provides guidance for standalone AI agents running with the __PROVIDER_CLI__ CLI.

**Note:** This applies to standalone CLI sessions only. If you are a runner-managed agent (spawned by \`agent-runner.sh\`), your normal reply already goes through \`agent_state/.agent_response.txt\`.

## Reply First, Log Second

When a user sends you a message, you must send a normal reply in the agent chat.
The shared news feed is only an extra activity log. It never replaces the normal reply.
Only skip the normal chat reply for fire-and-forget confirmation messages from another agent.

## Optional News Feed Log

After completing **each user request**, post a short summary to the **shared news feed** as a separate step.

\`\`\`bash
# Post summary to the shared News Feed (different channel from your chat):
uv run __SCRIPT_DIR__/chatspace/__NEWS_FEED_FOLDER__/message_helper.py send --json '{
  "type": "news_announcement",
  "agent": "__PROVIDER_NAME__",
  "context": "'"\$PWD"'",
  "status": "Completed",
  "summary": "Brief task summary here"
}'
\`\`\`

**Status values:** "Completed", "Running", "Failed", "Info"

**WARNING:** This goes to the NEWS FEED, not your chat. Send your normal chat reply first. Then post this log entry separately.
PROVIDEREOF
)
        provider_content=$(echo "$provider_content" | sed -e "s|__PROVIDER_NAME__|$pname|g" -e "s|__PROVIDER_CLI__|$pcli|g" -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" -e "s|__NEWS_FEED_FOLDER__|$news_feed_folder|g")
        append_or_create_file "$SCRIPT_DIR/$pfile" "$provider_content"
        if [ -f "$SCRIPT_DIR/$pfile" ] && grep -q "Agent Instructions for $pname" "$SCRIPT_DIR/$pfile" 2>/dev/null; then
            print_success "Updated: $pfile (appended)"
        else
            print_success "Created: $pfile"
        fi
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Local Chief of Staff Setup
# ═══════════════════════════════════════════════════════════════════════════════
# The Local Chief of Staff (CoS) is a privileged agent that can spawn / edit /
# delete other agents on your behalf. It runs LOCALLY on THIS machine — any
# agents it spawns are created as folders on this same computer. It can
# message remote agents on the platform, but it cannot spawn agents on
# other machines.
LOCAL_COS_MARKER="$CHATSPACE_DIR/.local_cos_configured"

# Find an already-installed Local Chief of Staff folder (folder names are
# sanitized to lower-case-with-dashes).
find_existing_local_cos_folder() {
    local dir
    for dir in "$CHATSPACE_DIR"/local-chief-of-staff "$CHATSPACE_DIR"/chief-of-staff; do
        if [ -d "$dir" ]; then
            basename "$dir"
            return 0
        fi
    done
    return 1
}

check_local_chief_of_staff() {
    # Marker means: we already prompted (and either installed or skipped).
    if [ -f "$LOCAL_COS_MARKER" ]; then
        return 0
    fi

    # If a folder already exists, consider it installed and just mark.
    if find_existing_local_cos_folder >/dev/null; then
        touch "$LOCAL_COS_MARKER"
        return 0
    fi

    local remote_chiefs
    remote_chiefs=$(get_remote_chiefs_of_staff)
    if [ -n "$remote_chiefs" ]; then
        print_info "Chief of Staff already registered on this account (from another project/folder):"
        while IFS= read -r remote_chief; do
            [ -n "$remote_chief" ] && echo "  • $remote_chief"
        done <<< "$remote_chiefs"
        print_info "Use --local-cos to fetch one of these onto this computer; it will not create a duplicate."
        touch "$LOCAL_COS_MARKER"
        return 0
    fi

    echo ""
    gum style \\
        --border rounded \\
        --padding "1 2" \\
        --margin "1 0" \\
        --border-foreground 212 \\
        "🧑‍💼 Local Chief of Staff (optional)" \\
        "" \\
        "Install a privileged agent that manages your other agents on" \\
        "your behalf — spawn, brief, restart, retire, and keep a live" \\
        "roster." \\
        "" \\
        "⚠  Runs locally on THIS machine. Any agents it spawns are" \\
        "    created as folders here. It can message remote agents on" \\
        "    the platform, but it cannot spawn agents on other machines." \\
        "" \\
        "You can also install it later by running:" \\
        "    bash agent-cli.sh --local-cos"

    echo ""
    if gum confirm --affirmative "Yes, install it" --negative "Skip for now" "Install Local Chief of Staff?"; then
        if ! setup_local_chief_of_staff; then
            print_warning "Local Chief of Staff setup did not complete."
        fi
    else
        print_info "Skipping Local Chief of Staff. Run 'bash agent-cli.sh --local-cos' to install it later."
    fi

    touch "$LOCAL_COS_MARKER"
    echo ""
}

# Drive the install — prompts for password, calls the API, writes the
# bundle locally, and offers to start the agent in tmux.
setup_local_chief_of_staff() {
    print_section "Local Chief of Staff Setup"
    echo ""

    if ! command -v jq &>/dev/null; then
        print_error "jq is required to install the Local Chief of Staff."
        print_info "Install jq (https://stedolan.github.io/jq/download/) and re-run."
        return 1
    fi
    if ! command -v python3 &>/dev/null; then
        print_warning "python3 not found — message_helper.py may fail to run. Install python3 to use it."
    fi

    local user_password=""
    if [ "$HAS_ENCRYPTION" = "true" ]; then
        print_info "🔐 Enter your account password so the local agent can decrypt your messages."
        print_info "    Sent only to install the agent; written to .env on THIS machine only."
        user_password=$(gum input \\
            --password \\
            --placeholder "Account password (leave blank to install without encryption)" \\
            --prompt "Password: " < /dev/tty)
    fi

    local default_cos_name
    default_cos_name="Local Chief of Staff - $(hostname 2>/dev/null || echo this-machine)"
    local cos_agent_name
    cos_agent_name=$(gum input \\
        --placeholder "$default_cos_name" \\
        --value "$default_cos_name" \\
        --prompt "Chief of Staff name: " < /dev/tty)
    if [ -z "$cos_agent_name" ]; then
        cos_agent_name="$default_cos_name"
    fi

    print_info "Registering Local Chief of Staff with $API_BASE ..."
    local install_payload
    install_payload=$(jq -n \\
        --arg pwd "$user_password" \\
        --arg name "$cos_agent_name" \\
        '{confirm: true, userPassword: $pwd, agentName: $name, skipFiles: true}')

    local response http_code
    response=$(curl -s -w '\\n%{http_code}' \\
        -X POST "$API_BASE/agent/user/install-chief-of-staff" \\
        -H "X-API-Key: $API_KEY" \\
        -H "Content-Type: application/json" \\
        -d "$install_payload")
    http_code=$(printf '%s' "$response" | tail -n1)
    response=$(printf '%s' "$response" | sed '$d')

    if [ "$http_code" = "409" ]; then
        print_warning "A Local Chief of Staff with that name already exists for this account."
        print_info "Fetching its files so this machine can run that named instance too..."
        local refetch_payload
        refetch_payload=$(jq -n \\
            --arg pwd "$user_password" \\
            --arg name "$cos_agent_name" \\
            '{userPassword: $pwd, agentName: $name}')
        response=$(curl -s -w '\\n%{http_code}' \\
            -X POST "$API_BASE/agent/user/install-chief-of-staff/files" \\
            -H "X-API-Key: $API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "$refetch_payload")
        http_code=$(printf '%s' "$response" | tail -n1)
        response=$(printf '%s' "$response" | sed '$d')
    fi

    if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
        print_error "Install failed (HTTP $http_code)"
        local err_msg
        err_msg=$(printf '%s' "$response" | jq -r '.error.message // empty' 2>/dev/null || echo "")
        if [ -n "$err_msg" ]; then
            print_info "Server: $err_msg"
        else
            print_info "Server response: $response"
        fi
        return 1
    fi

    local agent_name
    agent_name=$(printf '%s' "$response" | jq -r '.agentName // .agent.agentName // empty')
    if [ -z "$agent_name" ]; then
        agent_name="Local Chief of Staff"
    fi

    local folder_name
    folder_name=$(printf '%s' "$agent_name" \\
        | tr '[:upper:]' '[:lower:]' \\
        | sed -e 's/[^a-z0-9]\\+/-/g' -e 's/^-//' -e 's/-$//')
    if [ -z "$folder_name" ]; then
        folder_name="local-chief-of-staff"
    fi

    local agent_dir="$CHATSPACE_DIR/$folder_name"
    mkdir -p "$agent_dir/agent_state"

    print_info "Writing agent files to: $agent_dir"

    # Each bundle entry is { content, mode?, sensitive? }. We write them
    # one by one with jq + base64 to preserve arbitrary content safely.
    local rel_paths
    rel_paths=$(printf '%s' "$response" | jq -r '.fileBundle | keys[]')

    local rel
    while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        # Integrity guard: the file bundle is fetched from the server, so never
        # let a relative path escape \$agent_dir (path traversal / absolute path).
        # Nested subpaths like agent_state/foo.json are allowed; only escapes are blocked.
        case "$rel" in
            /*|../*|*/../*|*/..|..)
                print_warning "Skipping unsafe bundle path: $rel"
                continue
                ;;
        esac
        local full="$agent_dir/$rel"
        mkdir -p "$(dirname "$full")"
        local mode
        mode=$(printf '%s' "$response" | jq -r --arg k "$rel" '.fileBundle[$k].mode // empty')
        printf '%s' "$response" \\
            | jq -r --arg k "$rel" '.fileBundle[$k].content' > "$full"
        if [ -n "$mode" ] && [ "$mode" != "null" ]; then
            # Modes arrive as decimal (e.g. 493 == 0o755). Clamp the resulting
            # octal string to a known-safe allow-list; never honor setuid/setgid.
            local octmode
            octmode=$(printf '%o' "$mode" 2>/dev/null)
            case "$octmode" in
                600|644|700|755)
                    chmod "$octmode" "$full" 2>/dev/null || true
                    ;;
                *)
                    print_warning "Refusing disallowed mode $octmode for $rel (allowed: 600 644 700 755)"
                    ;;
            esac
        fi
    done <<< "$rel_paths"

    # Lock down the .env file (contains credentials).
    if [ -f "$agent_dir/.env" ]; then
        chmod 600 "$agent_dir/.env"
    fi

    print_success "Local Chief of Staff installed at: $agent_dir"
    echo ""

    # A CoS is often the long-running coordinator for the rest of the local
    # team.  Offer the durable systemd path here instead of making the user
    # discover it later through the general Autostart menu.  This remains
    # explicitly opt-in: a local agent has credentials in its .env file.
    if command -v systemctl &>/dev/null; then
        gum style \\
            --border rounded \\
            --padding "1 2" \\
            --margin "1 0" \\
            --border-foreground 36 \\
            "Keep the Chief of Staff running?" \\
            "" \\
            "Enable a per-user systemd service that starts it after reboot" \\
            "and restarts it if its runner fails. No terminal needs to stay open."
        echo ""
        print_info "For it to keep running after logout as well, enable user linger once:"
        gum style --foreground 212 "  sudo loginctl enable-linger $USER"
        echo ""
        if gum confirm --affirmative "Enable persistence" --negative "Use tmux instead" "Start this Chief of Staff automatically after reboot?"; then
            if enable_autostart "$agent_name"; then
                return 0
            fi
            print_warning "Could not enable persistent mode; falling back to the tmux launch option."
        fi
    else
        print_info "Persistent mode is unavailable because systemd is not installed; using the tmux launch option."
    fi

    print_info "To start the agent now, in a new terminal:"
    local tmux_session
    tmux_session="$folder_name"
    gum style --foreground 212 "  tmux new-session -s $tmux_session 'cd \\"$agent_dir\\" && ./agent-runner.sh'"
    echo ""
    print_info "Re-attach later with:"
    gum style --foreground 212 "  tmux attach -t $tmux_session"
    echo ""

    if gum confirm --affirmative "Start it now" --negative "I'll start it later" "Start the Local Chief of Staff now?"; then
        if ! command -v tmux &>/dev/null; then
            print_warning "tmux not found — install tmux and run the command above to start the agent."
        else
            tmux new-session -d -s "$tmux_session" "cd \\"$agent_dir\\" && ./agent-runner.sh"
            print_success "Started in tmux session '$tmux_session'. Attach with: tmux attach -t $tmux_session"
        fi
    fi

    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# Headless Mode Functions
# ═══════════════════════════════════════════════════════════════════════════════
# These functions mirror their interactive counterparts but use ARG_* variables
# instead of gum prompts. When modifying create_agent/run_agent, update these too.

create_agent_headless() {
    local agent_name="$1"
    
    echo "Creating agent: $agent_name"
    
    if [ -z "$agent_name" ]; then
        echo "Error: Agent name is required"
        return 1
    fi
    
    if agent_exists "$agent_name"; then
        echo "Agent '$agent_name' already exists. Use --continue to run it."
        return 1
    fi
    
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    
    local user_password="$ARG_PASSWORD"
    if [ "$HAS_ENCRYPTION" = "true" ] && [ -z "$user_password" ]; then
        echo "Warning: Encryption enabled but no --password provided. E2E encryption disabled for this agent."
    fi
    
    echo "Creating agent files..."
    mkdir -p "$agent_dir"
    mkdir -p "$agent_dir/agent_state"
    
    # Create .env file (mirrors create_agent)
    cat > "$agent_dir/.env" <<ENVEOF
# Agent Messaging Environment Configuration
USER_PASSWORD="$user_password"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$agent_name"
ENVEOF
    
    echo "Created: $agent_dir/.env"
    
    # Create message_helper.py
    cat > "$agent_dir/message_helper.py" <<'HELPEREOF'
${pythonHelper}
HELPEREOF
    chmod +x "$agent_dir/message_helper.py"
    echo "Created: $agent_dir/message_helper.py"
    
    # Create AGENT_INSTRUCTIONS.md
    cat > "$agent_dir/AGENT_INSTRUCTIONS.md" <<'INSTREOF'
${agentInstructions}
INSTREOF
    echo "Created: $agent_dir/AGENT_INSTRUCTIONS.md"
    
    # Create ONESHOT_AGENT_INSTRUCTIONS.md  
    cat > "$agent_dir/ONESHOT_AGENT_INSTRUCTIONS.md" <<'ONEINSTREOF'
${oneshotInstructions}
ONEINSTREOF
    echo "Created: $agent_dir/ONESHOT_AGENT_INSTRUCTIONS.md"
    
    # Create SKILL_RICH_FORMS.md
    cat > "$agent_dir/SKILL_RICH_FORMS.md" <<'RICHEOF2'
${richFormSkill}
RICHEOF2
    echo "Created: $agent_dir/SKILL_RICH_FORMS.md"

    # Create SELF_WAKE_GUIDE.md
    cat > "$agent_dir/SELF_WAKE_GUIDE.md" <<'WAKEEOF2'
${selfWakeGuide}
WAKEEOF2
    echo "Created: $agent_dir/SELF_WAKE_GUIDE.md"
    
    # Create agent-runner.sh
    cat > "$agent_dir/agent-runner.sh" <<'RUNNEREOF'
${agentRunner}
RUNNEREOF
    chmod +x "$agent_dir/agent-runner.sh"
    echo "Created: $agent_dir/agent-runner.sh"
    
    # Initialize state files
    echo '[]' > "$agent_dir/agent_state/.scheduled_tasks.json"
    echo '{"session_count": 0}' > "$agent_dir/agent_state/conversation_history.json"
    
    # Create agent_summary.md with template
    cat > "$agent_dir/agent_state/agent_summary.md" <<SUMMARYEOF
# Agent Session Summary - $agent_name

Waiting for first session...
SUMMARYEOF
    echo "Created: $agent_dir/agent_state/"
    
    # Create .gitignore in agent directory to protect .env
    cat > "$agent_dir/.gitignore" <<GITIGNOREEOF
# Never commit .env file - it contains secrets!
.env

# Agent runtime files
agent_state/.agent_response.txt
agent_state/.wait_state.json
agent_state/.running
GITIGNOREEOF
    
    echo ""
    echo "Agent '$agent_name' created successfully!"
    
    # Now run the agent configuration
    run_agent_headless "$agent_name"
}

run_agent_headless() {
    local agent_name="$1"
    local folder
    folder=$(get_agent_folder "$agent_name")
    local agent_dir="$CHATSPACE_DIR/$folder"
    
    if [ ! -f "$agent_dir/.env" ]; then
        echo "Error: Agent '$agent_name' not found!"
        return 1
    fi
    
    local allowed_perms_file="$agent_dir/agent_state/allowed_permissions.json"
    local config_file="$agent_dir/agent_state/agent_config.json"
    local run_mode="\${2:-configure}"

    # Continuing an already-configured agent: keep its provider/model/permissions.
    if [ "$run_mode" = "preserve" ] && [ "$ARG_PERMS_EXPLICIT" != "true" ] \\
        && [ -s "$allowed_perms_file" ] && [ -s "$config_file" ]; then
        echo "Keeping existing configuration for '$agent_name' (pass provider/permission flags to reconfigure)."
        if [ "$ARG_PROJECT_PATH_EXPLICIT" = "true" ] && command -v jq &>/dev/null; then
            local tmp_cfg
            tmp_cfg=$(mktemp)
            if jq --arg p "$ARG_PROJECT_PATH" '.project_path = $p' "$config_file" > "$tmp_cfg"; then
                mv "$tmp_cfg" "$config_file"
                echo "  Project path updated to: $ARG_PROJECT_PATH"
            else
                rm -f "$tmp_cfg"
            fi
        fi
        if [ "$ARG_AUTO_START" = "true" ]; then
            start_agent_foreground "$agent_name" "$agent_dir"
        fi
        return 0
    fi

    echo "Configuring agent permissions..."

    # --allow-all (setup profile "max-access") grants every provider the full
    # permissive bundle and skips all prompts — the headless equivalent of the
    # interactive "Allow all & skip ALL permission prompts" choice. Otherwise we
    # build per-provider permissions from the individual --flag defaults.
    if [ "$ARG_SETUP_PROFILE" = "max-access" ]; then
        ARG_PROVIDERS="codex,claude,gemini,copilot,antigravity,pi,kilo,ollama,openrouter"
    fi

    # Build permissions JSON from CLI args
    local perms_json
    local first_provider=true

    # Parse providers from comma-separated list
    IFS=',' read -ra providers <<< "$ARG_PROVIDERS"

    if [ "$ARG_SETUP_PROFILE" = "max-access" ]; then
        echo "Setup profile: max-access (allow all & skip all permission prompts)"
        perms_json='{"codex":{"--sandbox":["workspace-write","danger-full-access"],"--dangerously-bypass-approvals-and-sandbox":true},"claude":{"--permission-mode":["default","acceptEdits","plan","bypassPermissions"],"--dangerously-skip-permissions":true},"gemini":{"--sandbox":true,"--no-sandbox":true,"--yolo":true},"copilot":{"--allow-all":true,"--allow-all-tools":true,"--allow-all-paths":true},"antigravity":{"--sandbox":["workspace-write","danger-full-access"],"--dangerously-skip-permissions":true},"pi":{"enabled":true},"kilo":{"--auto":true},"ollama":{"enabled":true},"openrouter":{"enabled":true}}'
    else
    perms_json="{"
    for provider in "\${providers[@]}"; do
        [ "$first_provider" = "false" ] && perms_json+=","
        first_provider=false
        
        case "$provider" in
            codex)
                # Parse comma-separated sandbox modes
                local sandbox_json="["
                local first_val=true
                IFS=',' read -ra sandbox_modes <<< "$ARG_CODEX_SANDBOX"
                for mode in "\${sandbox_modes[@]}"; do
                    [ "$first_val" = "false" ] && sandbox_json+=","
                    first_val=false
                    sandbox_json+="\\"$mode\\""
                done
                sandbox_json+="]"
                perms_json+="\\"codex\\":{\\"--sandbox\\":$sandbox_json,\\"--dangerously-bypass-approvals-and-sandbox\\":$ARG_CODEX_BYPASS}"
                ;;
            claude)
                local modes_json="["
                local first_val=true
                IFS=',' read -ra modes <<< "$ARG_CLAUDE_MODES"
                for mode in "\${modes[@]}"; do
                    [ "$first_val" = "false" ] && modes_json+=","
                    first_val=false
                    modes_json+="\\"$mode\\""
                done
                modes_json+="]"
                perms_json+="\\"claude\\":{\\"--permission-mode\\":$modes_json,\\"--dangerously-skip-permissions\\":$ARG_CLAUDE_SKIP_PERMS}"
                ;;
            gemini)
                perms_json+="\\"gemini\\":{\\"--sandbox\\":$ARG_GEMINI_SANDBOX,\\"--no-sandbox\\":$ARG_GEMINI_NO_SANDBOX,\\"--yolo\\":$ARG_GEMINI_YOLO}"
                ;;
            copilot)
                local provider_json='\\"copilot\\":{\\"--allow-all\\":false,\\"--allow-all-tools\\":false,\\"--allow-all-paths\\":false}'
                perms_json+="$provider_json"
                ;;
            antigravity)
                local sandbox_json="["
                local first_val=true
                IFS=',' read -ra sandbox_modes <<< "$ARG_ANTIGRAVITY_SANDBOX"
                for mode in "\${sandbox_modes[@]}"; do
                    [ "$first_val" = "false" ] && sandbox_json+=","
                    first_val=false
                    sandbox_json+="\\"$mode\\""
                done
                sandbox_json+="]"
                perms_json+="\\"antigravity\\":{\\"--sandbox\\":$sandbox_json,\\"--dangerously-skip-permissions\\":$ARG_ANTIGRAVITY_SKIP_PERMS}"
                ;;
            pi)
                perms_json+="\\"pi\\":{\\"enabled\\":true}"
                ;;
            kilo)
                perms_json+="\\"kilo\\":{\\"--auto\\":$ARG_KILO_AUTO}"
                ;;
            ollama|openrouter)
                perms_json+="\\"$provider\\":{\\"enabled\\":true}"
                ;;
        esac
    done

    perms_json+="}"
    fi

    # Save permissions
    mkdir -p "$agent_dir/agent_state"
    echo "$perms_json" | jq '.' > "$allowed_perms_file"
    echo "Saved permissions to $allowed_perms_file"
    
    # Handle inter-agent communication
    local inter_agent_json
    case "$ARG_INTER_AGENT" in
        disabled)
            inter_agent_json='{"enabled": false}'
            ;;
        listen_all)
            inter_agent_json='{"enabled": true, "mode": "listen_all"}'
            ;;
        groups)
            if [ -n "$ARG_INTER_AGENT_GROUP" ]; then
                # Try to join or create the group
                local group_result
                group_result=$(curl -sL -X POST \\
                    -H "X-API-Key: $API_KEY" \\
                    -H "Content-Type: application/json" \\
                    -d "{\\"groupName\\": \\"$ARG_INTER_AGENT_GROUP\\"}" \\
                    "$API_BASE/agent/groups" 2>/dev/null)
                
                inter_agent_json=$(echo '{"enabled": true, "mode": "groups"}' | jq --arg g "$ARG_INTER_AGENT_GROUP" '. + {groups: [$g]}')
                
                # Store group password if provided
                if [ -n "$ARG_GROUP_PASSWORD" ]; then
                    local group_salt=$(echo -n "$ARG_GROUP_PASSWORD" | openssl dgst -sha256 -binary | head -c 16 | base64)
                    echo "" >> "$agent_dir/.env"
                    echo "GROUP_PASSWORD=\\"$ARG_GROUP_PASSWORD\\"" >> "$agent_dir/.env"
                    echo "GROUP_SALT=\\"$group_salt\\"" >> "$agent_dir/.env"
                fi
            else
                inter_agent_json='{"enabled": true, "mode": "listen_all"}'
            fi
            ;;
        *)
            inter_agent_json='{"enabled": false}'
            ;;
    esac
    
    # Update permissions with inter-agent settings
    local updated_perms
    updated_perms=$(cat "$allowed_perms_file" | jq --argjson ia "$inter_agent_json" '. + {inter_agent: $ia}')
    echo "$updated_perms" > "$allowed_perms_file"
    
    # Add inter-agent instructions if enabled
    if [ "$ARG_INTER_AGENT" != "disabled" ]; then
        cat >> "$agent_dir/AGENT_INSTRUCTIONS.md" <<'INTERAGENTINSTR'

## Inter-Agent Communication

You can communicate with other agents using message_helper.py:

### Discover Other Agents
\`\`\`bash
uv run message_helper.py discover          # List all agents you can talk to
uv run message_helper.py discover --online # List only online agents
\`\`\`

### Send Direct Messages to Other Agents
\`\`\`bash
uv run message_helper.py dm "AgentName" "Hello!"
\`\`\`

### Auto-Discovery
On startup, run \`discover\` to see available peers. Re-run periodically during long tasks
to detect newly spawned agents.
INTERAGENTINSTR
    fi
    
    # Create default config with project path.
    # Pick an initial sandbox mode that's compatible with allowed permissions
    # so headless-created agents don't boot with invalid config.
    local first_provider_headless="\${providers[0]:-codex}"
    local initial_sandbox="workspace-write"
    local initial_approval="suggest"
    if [ "$ARG_SETUP_PROFILE" = "max-access" ]; then
        # Allow-all: run fully autonomously with no sandbox, matching the
        # interactive max-access profile.
        initial_sandbox="none"
        initial_approval="full-auto"
    else
        local sandbox_modes_json
        sandbox_modes_json=$(jq -r --arg p "$first_provider_headless" '.[$p]["--sandbox"] // empty' "$allowed_perms_file" 2>/dev/null)
        if [ -n "$sandbox_modes_json" ] && [ "$sandbox_modes_json" != "null" ]; then
            if echo "$sandbox_modes_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
                if echo "$sandbox_modes_json" | jq -e 'index("workspace-write") != null' >/dev/null 2>&1; then
                    initial_sandbox="workspace-write"
                elif echo "$sandbox_modes_json" | jq -e 'index("danger-full-access") != null' >/dev/null 2>&1; then
                    initial_sandbox="none"
                elif echo "$sandbox_modes_json" | jq -e 'index("read-only") != null' >/dev/null 2>&1; then
                    initial_sandbox="read-only"
                fi
            fi
        fi
    fi
    cat > "$config_file" <<CONFIGEOF
{
    "provider": "$first_provider_headless",
    "model_provider": "$first_provider_headless",
    "model": "default",
    "approval_mode": "$initial_approval",
    "sandbox_mode": "$initial_sandbox",
    "project_path": "$ARG_PROJECT_PATH"
}
CONFIGEOF
    sync_runtime_permissions "$agent_name" "$config_file" "$allowed_perms_file" || return 1
    echo "Created default config at $config_file"
    
    echo ""
    echo "Agent configured successfully!"
    echo "  Providers: $ARG_PROVIDERS"
    echo "  Project path: $ARG_PROJECT_PATH"
    echo "  Inter-agent: $ARG_INTER_AGENT"

    # Auto-start if requested
    if [ "$ARG_AUTO_START" = "true" ]; then
        start_agent_foreground "$agent_name" "$agent_dir"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Background session control (start / restart / shutdown / status)
# ═══════════════════════════════════════════════════════════════════════════════
# Each agent gets one tmux session named "<folder>-local-agent". The session runs
# the runner inside a small supervisor loop that restarts it after a crash and
# exits after a clean (exit 0) shutdown. Because the CLI finds and replaces that
# session itself, users never need to kill tmux sessions or delete folders by hand.

agent_session_name() {
    printf '%s-local-agent' "$(get_agent_folder "$1")"
}

agent_session_running() {
    command -v tmux &>/dev/null && tmux has-session -t "=$1" 2>/dev/null
}

# PIDs of this agent's runner processes, including ones that outlived their
# terminal/tmux session (e.g. the shared listener, which replaces the runner via
# exec and keeps running as an orphan when its session is killed).
agent_runner_pids() {
    local agent_dir="$1"
    local lock="$agent_dir/agent_state/shared-agent.json.lock"
    local pid
    {
        if [ -f "$lock" ]; then
            pid=$(tr -cd '0-9' < "$lock" 2>/dev/null || true)
            if [ -n "$pid" ] && ps -p "$pid" -o args= 2>/dev/null | grep -q "shared-runner.js"; then
                echo "$pid"
            fi
        fi
        pgrep -f "$agent_dir/agent_state/shared-runner.js" 2>/dev/null || true
        for pid in $(pgrep -f "agent-runner.sh" 2>/dev/null || true); do
            [ "$pid" = "$$" ] && continue
            # Never match a tmux server/client: its argv can contain the runner
            # command, and killing it would take every other session down too.
            case "$(ps -p "$pid" -o comm= 2>/dev/null || true)" in tmux*) continue ;; esac
            if [ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$agent_dir" ] \\
                || ps -p "$pid" -o args= 2>/dev/null | grep -qF "$agent_dir/agent-runner.sh"; then
                echo "$pid"
            fi
        done
    } | sort -u
}

agent_is_running() {
    local agent_name="$1"
    local agent_dir="$CHATSPACE_DIR/$(get_agent_folder "$agent_name")"
    agent_session_running "$(agent_session_name "$agent_name")" && return 0
    [ -n "$(agent_runner_pids "$agent_dir")" ]
}

stop_agent_session() {
    local session="$1"
    local agent_dir="$2"
    local i pids
    if agent_session_running "$session"; then
        # Ask the runner to exit cleanly first (Ctrl-C).
        tmux send-keys -t "=$session" C-c 2>/dev/null || true
    fi
    pids=$(agent_runner_pids "$agent_dir")
    [ -n "$pids" ] && kill -TERM $pids 2>/dev/null || true
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if ! agent_session_running "$session" && [ -z "$(agent_runner_pids "$agent_dir")" ]; then
            break
        fi
        sleep 1
    done
    tmux kill-session -t "=$session" 2>/dev/null || true
    pids=$(agent_runner_pids "$agent_dir")
    [ -n "$pids" ] && kill -KILL $pids 2>/dev/null || true
    # A killed listener cannot remove its own lock; clear it so the next start works.
    rm -f "$agent_dir/agent_state/shared-agent.json.lock"
    return 0
}

start_agent_session() {
    local agent_name="$1"
    local mode="\${2:-start}"
    local folder agent_dir session
    folder=$(get_agent_folder "$agent_name")
    agent_dir="$CHATSPACE_DIR/$folder"
    session=$(agent_session_name "$agent_name")

    if [ ! -f "$agent_dir/.env" ] || [ ! -x "$agent_dir/agent-runner.sh" ]; then
        echo "Error: Agent '$agent_name' not found or not configured (expected $agent_dir/agent-runner.sh)."
        echo "Create it first:  bash $SCRIPT_DIR/agent-cli.sh --headless --create \\"$agent_name\\""
        return 1
    fi
    # An enabled service owns this agent. Use its supervisor instead of
    # creating a second tmux listener or killing a process it will restart.
    local service_name="agent-$folder.service"
    if command -v systemctl &>/dev/null && systemctl --user is-enabled "$service_name" &>/dev/null; then
        if [ "$mode" = "restart" ]; then
            systemctl --user restart "$service_name" || return 1
        else
            systemctl --user start "$service_name" || return 1
        fi
        echo "Started '$agent_name' with its persistent service '$service_name'."
        return 0
    fi
    if ! command -v tmux &>/dev/null; then
        echo "Error: tmux is required for background mode. Install it (e.g. sudo apt install tmux)"
        echo "or run in the foreground:  bash $SCRIPT_DIR/agent-cli.sh --headless --continue \\"$agent_name\\""
        return 1
    fi

    if agent_is_running "$agent_name"; then
        if [ "$mode" = "restart" ]; then
            echo "Stopping running agent '$agent_name'..."
            stop_agent_session "$session" "$agent_dir"
        elif agent_session_running "$session"; then
            echo "Agent '$agent_name' is already running (tmux session '$session')."
            echo "  Attach:   tmux attach -t $session"
            echo "  Restart:  bash $SCRIPT_DIR/agent-cli.sh --restart \\"$agent_name\\""
            return 0
        else
            echo "Agent '$agent_name' is already running outside a managed session (PID $(agent_runner_pids "$agent_dir" | tr '\\n' ' '))."
            echo "  Replace it with a managed session:  bash $SCRIPT_DIR/agent-cli.sh --restart \\"$agent_name\\""
            return 0
        fi
    fi

    local log_file="$agent_dir/agent_state/supervisor.log"
    mkdir -p "$agent_dir/agent_state"
    local supervisor
    supervisor='while true; do ./agent-runner.sh; code=$?; echo "$(date -Is) runner exited with code $code" >> agent_state/supervisor.log; [ "$code" -eq 0 ] && break; echo "Runner exited ($code); restarting in 10s (Ctrl-C to stop)..."; sleep 10 || break; done'
    tmux new-session -d -s "$session" -c "$agent_dir" "bash -c '$supervisor'"
    sleep 1
    if agent_session_running "$session"; then
        echo "Started '$agent_name' in tmux session '$session' (auto-restarts on crash)."
        echo "  Attach:   tmux attach -t $session"
        echo "  Stop:     bash $SCRIPT_DIR/agent-cli.sh --shutdown \\"$agent_name\\""
        echo "  Log:      $log_file"
        return 0
    fi
    echo "Error: session '$session' exited immediately. Run in the foreground to see why:"
    echo "  cd \\"$agent_dir\\" && ./agent-runner.sh"
    return 1
}

shutdown_agent_session() {
    local session agent_dir
    session=$(agent_session_name "$1")
    agent_dir="$CHATSPACE_DIR/$(get_agent_folder "$1")"
    local service_name="agent-$(get_agent_folder "$1").service"
    if command -v systemctl &>/dev/null && systemctl --user is-enabled "$service_name" &>/dev/null; then
        systemctl --user stop "$service_name" || return 1
        echo "Stopped '$1' persistent service."
        return 0
    fi
    if agent_is_running "$1"; then
        stop_agent_session "$session" "$agent_dir"
        echo "Stopped '$1'."
    else
        echo "Agent '$1' is not running."
    fi
}

show_agent_session_status() {
    local agents name session found=false
    agents=$(get_existing_agents)
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        session=$(agent_session_name "$name")
        if agent_session_running "$session"; then
            echo "running  $name  (tmux attach -t $session)"
            found=true
        elif agent_is_running "$name"; then
            echo "running  $name  (unmanaged process; use --restart to manage it)"
            found=true
        else
            echo "stopped  $name"
        fi
    done <<< "$agents"
    [ "$found" = "true" ] || echo "(no agents running in the background)"
}

# Run the agent in this terminal. Refuses to start a second runner when the same
# agent is already running in its background session (two runners would answer
# every message twice), and offers the restart command instead.
start_agent_foreground() {
    local agent_name="$1"
    local agent_dir="$2"
    local session
    session=$(agent_session_name "$agent_name")
    if agent_is_running "$agent_name"; then
        echo ""
        echo "Agent '$agent_name' is already running (session '$session' or PID $(agent_runner_pids "$agent_dir" | tr '\\n' ' '))."
        echo "  Attach:   tmux attach -t $session"
        echo "  Restart:  bash $SCRIPT_DIR/agent-cli.sh --restart \\"$agent_name\\""
        return 0
    fi
    echo ""
    echo "Starting agent..."
    exec "$agent_dir/agent-runner.sh"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Global launcher: run this CLI from any directory
# ═══════════════════════════════════════════════════════════════════════════════
# Installs a tiny wrapper (not a copy, so the API key stays in one file) in
# ~/.local/bin. The wrapper keeps the caller's working directory, so new agents
# default their project path to wherever the command was run.
install_global_command() {
    local cmd_name="\${1:-chatspace}"
    local bin_dir="$HOME/.local/bin"
    local self_path="$SCRIPT_DIR/$(basename "\${BASH_SOURCE[0]}")"
    local target="$bin_dir/$cmd_name"

    case "$cmd_name" in
        */*|"")
            echo "Error: invalid command name '$cmd_name'"
            return 1
            ;;
    esac
    if [ -e "$target" ] && ! grep -q "chatspace-launcher" "$target" 2>/dev/null; then
        echo "Error: $target already exists and was not created by this CLI; choose another name:"
        echo "  bash $self_path --install-command <name>"
        return 1
    fi

    mkdir -p "$bin_dir"
    chmod +x "$self_path" 2>/dev/null || true
    cat > "$target" <<LAUNCHEOF
#!/usr/bin/env bash
# chatspace-launcher: generated by agent-cli.sh. Re-run "--install-command" to update.
exec bash "$self_path" "\\$@"
LAUNCHEOF
    chmod +x "$target"
    echo "Installed '$cmd_name' -> $self_path"

    case ":$PATH:" in
        *":$bin_dir:"*) ;;
        *)
            local rc
            for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
                [ -f "$rc" ] || continue
                if ! grep -q "chatspace-launcher PATH" "$rc"; then
                    printf '\\n# chatspace-launcher PATH\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$rc"
                    echo "Added ~/.local/bin to PATH in $rc"
                fi
            done
            echo "Open a new terminal (or run: export PATH=\\"$bin_dir:\\$PATH\\") to use '$cmd_name'."
            ;;
    esac
    echo ""
    echo "Examples (from any directory):"
    echo "  $cmd_name                      # interactive menu"
    echo "  $cmd_name --status             # which agents are running"
    echo "  $cmd_name --start <agent>      # start in background"
    echo "  $cmd_name --restart <agent>    # restart without manual cleanup"
    return 0
}

# Offer the launcher once in interactive mode.
offer_global_command() {
    local marker="$CHATSPACE_DIR/.global_command_offered"
    [ -f "$marker" ] && return 0
    [ -f "$HOME/.local/bin/chatspace" ] && return 0
    command -v gum &>/dev/null || return 0
    touch "$marker" 2>/dev/null || true
    if gum confirm --affirmative "Install" --negative "Skip" "Install the 'chatspace' command so you can run this CLI from any folder?"; then
        install_global_command "chatspace" || true
        echo ""
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
print_bootstrap_info "Initializing agent CLI..."
print_bootstrap_info "Checking prerequisites..."
check_prerequisites
print_bootstrap_info "Syncing provider model lists in background..."
( auto_sync_all_installed_providers_models ) >/dev/null 2>&1 &
print_bootstrap_info "Startup checks complete."
mkdir -p "$CHATSPACE_DIR"
if [ -f "$SCRIPT_DIR/.gitignore" ] && ! grep -qxF ".chatspace/" "$SCRIPT_DIR/.gitignore"; then
    echo ".chatspace/" >> "$SCRIPT_DIR/.gitignore"
fi

# Handle --news-feed action (works in both interactive and headless mode)
if [ "$ARG_NEWS_FEED" = "true" ]; then
    # Remove marker so setup_news_feed_agent runs fresh
    rm -f "$NEWS_FEED_MARKER"
    setup_news_feed_agent
    exit 0
fi

# Handle --local-cos action (works in both interactive and headless mode)
if [ "$ARG_LOCAL_COS" = "true" ]; then
    # Remove marker so setup_local_chief_of_staff runs fresh
    rm -f "$LOCAL_COS_MARKER"
    setup_local_chief_of_staff
    exit $?
fi

# Background control + launcher actions (work in both interactive and headless mode)
if [ -n "$ARG_INSTALL_COMMAND" ]; then
    install_global_command "$ARG_INSTALL_COMMAND"
    exit $?
fi
if [ "$ARG_STATUS" = "true" ]; then
    show_agent_session_status
    exit 0
fi
if [ -n "$ARG_START" ]; then
    start_agent_session "$ARG_START" start
    exit $?
fi
if [ -n "$ARG_RESTART" ]; then
    start_agent_session "$ARG_RESTART" restart
    exit $?
fi
if [ -n "$ARG_SHUTDOWN" ]; then
    shutdown_agent_session "$ARG_SHUTDOWN"
    exit $?
fi

# Handle headless mode dispatch
if [ "$ARG_HEADLESS" = "true" ]; then
    # In headless mode, skip news feed unless explicitly requested
    if [ "$ARG_SKIP_NEWS_FEED" = "false" ]; then
        check_news_feed_agent
    fi

    # Handle --list action
    if [ "$ARG_LIST" = "true" ]; then
        existing_agents=$(get_existing_agents)
        if [ -n "$existing_agents" ]; then
            while IFS= read -r agent_name; do
                [ -z "$agent_name" ] && continue
                format_agent_label "$agent_name"
                echo ""
            done <<< "$existing_agents"
        else
            echo "No agents found."
        fi
        exit 0
    fi
    
    # Handle --create action
    if [ -n "$ARG_CREATE" ]; then
        create_agent_headless "$ARG_CREATE"
        exit $?
    fi
    
    # Handle --continue action
    if [ -n "$ARG_CONTINUE" ]; then
        run_agent_headless "$ARG_CONTINUE" preserve
        exit $?
    fi

    # Handle --stop action
    if [ -n "$ARG_STOP" ]; then
        stop_agent_control "$ARG_STOP"
        exit $?
    fi

    # Handle --delete action
    if [ -n "$ARG_DELETE" ]; then
        delete_agent_control "$ARG_DELETE"
        exit $?
    fi
    
    # If headless but no action specified, show error
    echo "Error: In headless mode, you must specify --create, --continue, --start, --restart, --shutdown, --status, --stop, --delete, --list, or --news-feed"
    echo "Run with --help for usage information."
    exit 1
fi

# Interactive mode
offer_global_command
check_news_feed_agent
if [ "$ARG_SKIP_LOCAL_COS" != "true" ]; then
    check_local_chief_of_staff
fi
main_menu
`;
}

/**
 * Generate the message helper Python script content
 */
function generateMessageHelperPython(hasEncryption) {
    const encryptImport = hasEncryption ? 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM' : '';
    const encryptCheck = hasEncryption ? ' or not Config.user_password or not Config.encryption_salt' : '';

    // Binary encryption functions - only available when encryption is enabled
    const binaryEncryptFuncs = hasEncryption ? `

# ============================================================================
# Binary Data Encryption/Decryption (for images and other binary content)
# ============================================================================

def encrypt_binary(data: bytes, password: str = None, salt: str = None) -> dict:
    """
    Encrypt binary data (e.g., image bytes) using AES-GCM.
    Uses the same key derivation as text encryption (PBKDF2 with SHA-256).

    Args:
        data: Binary data to encrypt
        password: User password (defaults to Config.user_password)
        salt: Base64 encoded salt (defaults to Config.encryption_salt)

    Returns:
        dict with keys:
            - ciphertext: bytes - Encrypted data (without auth tag)
            - iv: bytes - 12-byte initialization vector
            - authTag: bytes - 16-byte authentication tag

    Example:
        >>> with open("image.png", "rb") as f:
        ...     data = f.read()
        >>> result = encrypt_binary(data)
        >>> print(base64.b64encode(result["iv"]).decode())
    """
    password = password or Config.user_password
    salt = salt or Config.encryption_salt

    key = _derive_key(password, salt)
    iv = os.urandom(12)  # 96 bits for GCM
    aesgcm = AESGCM(key)

    # Encrypt: returns ciphertext + auth_tag concatenated
    ciphertext_with_tag = aesgcm.encrypt(iv, data, None)

    # Split ciphertext and auth tag (last 16 bytes is the tag)
    auth_tag = ciphertext_with_tag[-16:]
    ciphertext = ciphertext_with_tag[:-16]

    return {
        "ciphertext": ciphertext,
        "iv": iv,
        "authTag": auth_tag
    }


def decrypt_binary(ciphertext: bytes, iv: bytes, auth_tag: bytes,
                   password: str = None, salt: str = None) -> bytes:
    """
    Decrypt binary data (e.g., encrypted image) using AES-GCM.
    Uses the same key derivation as text encryption (PBKDF2 with SHA-256).

    Args:
        ciphertext: Encrypted binary data (without auth tag)
        iv: 12-byte initialization vector
        auth_tag: 16-byte authentication tag
        password: User password (defaults to Config.user_password)
        salt: Base64 encoded salt (defaults to Config.encryption_salt)

    Returns:
        bytes: Decrypted binary data

    Raises:
        Exception: If decryption fails (wrong password/corrupted data)

    Example:
        >>> decrypted = decrypt_binary(ciphertext, iv, auth_tag)
        >>> with open("decrypted.png", "wb") as f:
        ...     f.write(decrypted)
    """
    password = password or Config.user_password
    salt = salt or Config.encryption_salt

    key = _derive_key(password, salt)
    aesgcm = AESGCM(key)

    # Combine ciphertext and auth tag (AESGCM expects them concatenated)
    ciphertext_with_tag = ciphertext + auth_tag

    # Decrypt
    return aesgcm.decrypt(iv, ciphertext_with_tag, None)
` : '';

    // Image helper functions - available when encryption is enabled
    const imageHelperFuncs = hasEncryption ? `

def _get_content_type(file_path: str) -> str:
    """Detect content type from file extension or magic bytes."""
    # First try mimetypes module
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type:
        return mime_type

    # Fall back to extension-based detection
    ext = Path(file_path).suffix.lower()
    content_types = {
        # Images
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        # Documents
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        # Archives
        ".zip": "application/zip",
        ".gz": "application/gzip",
        ".tar": "application/x-tar",
        # Code/Data
        ".json": "application/json",
        ".xml": "application/xml",
        ".html": "text/html",
        ".css": "text/css",
        ".js": "text/javascript",
    }
    return content_types.get(ext, "application/octet-stream")


def _get_image_dimensions(file_path: str) -> tuple:
    """Get image width and height using PIL if available."""
    if not HAS_PIL:
        return None, None
    try:
        with Image.open(file_path) as img:
            return img.width, img.height
    except Exception:
        return None, None


def _compute_sha256(data: bytes) -> str:
    """Compute SHA-256 hash of data as hex string."""
    return hashlib.sha256(data).hexdigest()


# ============================================================================
# File Upload and Download Functions
# ============================================================================

def upload_file(file_path: str, agent_name: str = None,
                password: str = None, salt: str = None) -> dict:
    """
    Upload an encrypted file attachment to the server.

    The file is encrypted client-side using AES-GCM before upload.
    The server only stores encrypted ciphertext and cannot read the content.
    Supports images, PDFs, text files, archives, and other file types.

    Args:
        file_path: Path to the file to upload
        agent_name: Name of the agent uploading (defaults to Config.agent_name)
        password: User password for encryption (defaults to Config.user_password)
        salt: Base64 encoded salt (defaults to Config.encryption_salt)

    Returns:
        dict with keys on success:
            - attachmentId: str - UUID of the uploaded attachment
            - contentType: str - MIME type of the file
            - sizeBytes: int - Size of encrypted file
            - width: int|None - Image width in pixels (if image)
            - height: int|None - Image height in pixels (if image)
            - encrypted: bool - Always True
            - encryption: dict - Contains alg, ivBase64, tagBase64
        Or dict with 'error' key on failure.

    Example:
        >>> result = upload_file("/path/to/document.pdf")
        >>> if "attachmentId" in result:
        ...     print(f"Uploaded: {result['attachmentId']}")
        ... else:
        ...     print(f"Error: {result.get('error')}")
    """
    agent_name = agent_name or Config.agent_name
    password = password or Config.user_password
    salt = salt or Config.encryption_salt

    # Validate file exists
    path = Path(file_path)
    if not path.exists():
        return {"error": f"File not found: {file_path}"}
    if not path.is_file():
        return {"error": f"Not a file: {file_path}"}

    try:
        # Read file contents
        with open(path, "rb") as f:
            plaintext_data = f.read()

        # Get file metadata
        content_type = _get_content_type(str(path))
        width, height = _get_image_dimensions(str(path))  # Only works for images
        sha256_hash = _compute_sha256(plaintext_data)

        # Encrypt the file data
        encrypted = encrypt_binary(plaintext_data, password, salt)

        # Prepare multipart form data
        base = Config.api_base.rstrip("/")
        url = f"{base}/agent/attachments"

        # Build form fields
        form_data = {
            "agentName": (None, agent_name),
            "ivBase64": (None, base64.b64encode(encrypted["iv"]).decode()),
            "authTagBase64": (None, base64.b64encode(encrypted["authTag"]).decode()),
            "contentType": (None, content_type),
            "sha256": (None, sha256_hash),
        }

        # Add optional dimensions (only relevant for images)
        if width is not None:
            form_data["width"] = (None, str(width))
        if height is not None:
            form_data["height"] = (None, str(height))

        # Add the encrypted file
        files = {
            "file": (path.name, encrypted["ciphertext"], "application/octet-stream")
        }

        headers = {"X-API-Key": Config.api_key}

        response = requests.post(
            url,
            headers=headers,
            data={k: v[1] for k, v in form_data.items()},  # Extract just the values
            files=files,
            timeout=60
        )

        try:
            result = response.json()
            if response.status_code == 201:
                return result
            else:
                return {"error": result.get("error", {}).get("message", response.text)}
        except json.JSONDecodeError:
            return {"error": f"Invalid response: {response.text}"}

    except requests.RequestException as e:
        return {"error": f"Network error: {str(e)}"}
    except Exception as e:
        return {"error": f"Upload failed: {str(e)}"}


# Alias for backwards compatibility - upload_image is just upload_file
def upload_image(image_path: str, agent_name: str = None,
                 password: str = None, salt: str = None) -> dict:
    """Upload an image file. This is an alias for upload_file()."""
    return upload_file(image_path, agent_name, password, salt)


def download_attachment(attachment_id: str, save_path: str,
                        iv_base64: str, auth_tag_base64: str,
                        password: str = None, salt: str = None) -> dict:
    """
    Download and decrypt an attachment from the server.

    The server returns encrypted ciphertext which is decrypted client-side.

    Args:
        attachment_id: UUID of the attachment to download
        save_path: Path where decrypted file should be saved
        iv_base64: Base64 encoded initialization vector (from encryption metadata)
        auth_tag_base64: Base64 encoded auth tag (from encryption metadata)
        password: User password for decryption (defaults to Config.user_password)
        salt: Base64 encoded salt (defaults to Config.encryption_salt)

    Returns:
        dict with keys on success:
            - success: True
            - path: str - Path where file was saved
            - sizeBytes: int - Size of decrypted file
        Or dict with 'error' key on failure.

    Example:
        >>> # From a received message with attachment:
        >>> attachment = message["attachments"][0]
        >>> result = download_attachment(
        ...     attachment["attachmentId"],
        ...     "/tmp/received_image.png",
        ...     attachment["encryption"]["ivBase64"],
        ...     attachment["encryption"]["tagBase64"]
        ... )
        >>> if result.get("success"):
        ...     print(f"Saved to: {result['path']}")
    """
    password = password or Config.user_password
    salt = salt or Config.encryption_salt

    try:
        # Build URL
        base = Config.api_base.rstrip("/")
        url = f"{base}/agent/attachments/{attachment_id}"

        headers = {"X-API-Key": Config.api_key}

        # Download encrypted bytes
        response = requests.get(url, headers=headers, timeout=60)

        if response.status_code == 404:
            return {"error": "Attachment not found"}
        if response.status_code != 200:
            try:
                error_data = response.json()
                return {"error": error_data.get("error", {}).get("message", "Download failed")}
            except json.JSONDecodeError:
                return {"error": f"Download failed: HTTP {response.status_code}"}

        # Decode encryption metadata
        iv = base64.b64decode(iv_base64)
        auth_tag = base64.b64decode(auth_tag_base64)

        # Decrypt the data
        decrypted = decrypt_binary(response.content, iv, auth_tag, password, salt)

        # Save to file
        save_file = Path(save_path)
        save_file.parent.mkdir(parents=True, exist_ok=True)
        with open(save_file, "wb") as f:
            f.write(decrypted)

        return {
            "success": True,
            "path": str(save_file.absolute()),
            "sizeBytes": len(decrypted)
        }

    except requests.RequestException as e:
        return {"error": f"Network error: {str(e)}"}
    except Exception as e:
        return {"error": f"Download failed: {str(e)}"}


def download_message_attachments(message: dict, download_dir: str = None) -> list:
    """
    Download and decrypt all attachments from a received message.

    This is a convenience function for processing messages that contain attachments.
    Downloaded files are saved to the specified directory (or a temp directory).

    Args:
        message: Message dict that may contain an 'attachments' list
        download_dir: Directory to save files (defaults to temp directory)

    Returns:
        list of dicts, each with:
            - attachmentId: str - UUID of the attachment
            - localPath: str - Path where file was saved (or None if failed)
            - contentType: str - MIME type
            - error: str - Error message (only if download failed)

    Example:
        >>> responses = check_new_messages()
        >>> for msg in responses:
        ...     if msg.get("attachments"):
        ...         downloaded = download_message_attachments(msg, "/tmp/received")
        ...         for att in downloaded:
        ...             if att.get("localPath"):
        ...                 print(f"Downloaded: {att['localPath']}")
    """
    attachments = message.get("attachments", [])
    if not attachments:
        return []

    # Use temp directory if not specified
    if download_dir is None:
        download_dir = tempfile.mkdtemp(prefix="agent_attachments_")

    download_path = Path(download_dir)
    download_path.mkdir(parents=True, exist_ok=True)

    results = []
    for att in attachments:
        attachment_id = att.get("attachmentId")
        if not attachment_id:
            continue

        # Determine file extension from content type
        content_type = att.get("contentType", "application/octet-stream")
        ext_map = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/svg+xml": ".svg",
        }
        ext = ext_map.get(content_type, "")
        file_name = att.get("fileName") or f"{attachment_id}{ext}"

        save_path = download_path / file_name

        # Get encryption metadata
        encryption = att.get("encryption", {})
        iv_base64 = encryption.get("ivBase64")
        tag_base64 = encryption.get("tagBase64")

        if not iv_base64 or not tag_base64:
            results.append({
                "attachmentId": attachment_id,
                "localPath": None,
                "contentType": content_type,
                "error": "Missing encryption metadata"
            })
            continue

        # Download and decrypt
        result = download_attachment(attachment_id, str(save_path), iv_base64, tag_base64)

        if result.get("success"):
            results.append({
                "attachmentId": attachment_id,
                "localPath": result["path"],
                "contentType": content_type,
                "sizeBytes": result.get("sizeBytes")
            })
        else:
            results.append({
                "attachmentId": attachment_id,
                "localPath": None,
                "contentType": content_type,
                "error": result.get("error", "Unknown error")
            })

    return results
` : '';

    const encryptFuncs = hasEncryption ? `
def _derive_key(password: str, salt_base64: str) -> bytes:
    salt = base64.b64decode(salt_base64)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000, dklen=32)
    return key


def _encrypt_message(plaintext: str) -> str:
    key = _derive_key(Config.user_password, Config.encryption_salt)
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, plaintext.encode(), None)
    auth_tag = ciphertext[-16:]
    encrypted = ciphertext[:-16]
    return f"{base64.b64encode(iv).decode()}:{base64.b64encode(auth_tag).decode()}:{base64.b64encode(encrypted).decode()}"


def _decrypt_message(encrypted_data: str) -> str:
    try:
        parts = encrypted_data.split(":")
        if len(parts) != 3:
            return encrypted_data
        iv = base64.b64decode(parts[0])
        auth_tag = base64.b64decode(parts[1])
        encrypted = base64.b64decode(parts[2])
        key = _derive_key(Config.user_password, Config.encryption_salt)
        aesgcm = AESGCM(key)
        ciphertext_with_tag = encrypted + auth_tag
        decrypted = aesgcm.decrypt(iv, ciphertext_with_tag, None)
        return decrypted.decode()
    except Exception:
        return "[Decryption failed]"


def _group_encrypt_message(plaintext: str) -> str:
    """Encrypt a message using group password for inter-agent DMs."""
    if not Config.group_password or not Config.group_salt:
        return plaintext  # No encryption if no group password
    key = _derive_key(Config.group_password, Config.group_salt)
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(iv, plaintext.encode(), None)
    auth_tag = ciphertext[-16:]
    encrypted = ciphertext[:-16]
    return f"{base64.b64encode(iv).decode()}:{base64.b64encode(auth_tag).decode()}:{base64.b64encode(encrypted).decode()}"


def _group_decrypt_message(encrypted_data: str) -> str:
    """Decrypt a message using group password for inter-agent DMs."""
    if not Config.group_password or not Config.group_salt:
        return encrypted_data  # Can't decrypt without group password
    try:
        parts = encrypted_data.split(":")
        if len(parts) != 3:
            return encrypted_data
        iv = base64.b64decode(parts[0])
        auth_tag = base64.b64decode(parts[1])
        encrypted = base64.b64decode(parts[2])
        key = _derive_key(Config.group_password, Config.group_salt)
        aesgcm = AESGCM(key)
        ciphertext_with_tag = encrypted + auth_tag
        decrypted = aesgcm.decrypt(iv, ciphertext_with_tag, None)
        return decrypted.decode()
    except Exception:
        return "[Inter-agent DM decryption failed]"


def _encrypt_inter_agent_message(plaintext: str) -> str:
    """
    Inter-agent messages use the same key as normal user messages.
    Falls back to legacy group encryption only when needed.
    """
    encrypted = _encrypt_message(plaintext)
    if encrypted == plaintext and Config.group_password and Config.group_salt:
        encrypted = _group_encrypt_message(plaintext)
    return encrypted


def _decrypt_inter_agent_message(encrypted_data: str) -> str:
    """
    Decrypt inter-agent payloads using the normal account key first.
    Falls back to legacy group decryption for older messages.
    """
    decrypted = _decrypt_message(encrypted_data)
    if decrypted == "[Decryption failed]" and Config.group_password and Config.group_salt:
        return _group_decrypt_message(encrypted_data)
    return decrypted
${binaryEncryptFuncs}${imageHelperFuncs}` : `
def _encrypt_message(plaintext: str) -> str:
    return plaintext


def _decrypt_message(data: str) -> str:
    return data


def _group_encrypt_message(plaintext: str) -> str:
    """No-op group encryption when base encryption is disabled."""
    return plaintext


def _group_decrypt_message(encrypted_data: str) -> str:
    """No-op group decryption when base encryption is disabled."""
    return encrypted_data


def _encrypt_inter_agent_message(plaintext: str) -> str:
    return plaintext


def _decrypt_inter_agent_message(encrypted_data: str) -> str:
    return encrypted_data
`;
    const encryptCall = hasEncryption ? '_encrypt_message(content)' : 'content';
    const decryptCall = hasEncryption ? '_decrypt_message(r["content"])' : 'r["content"]';
    const encryptedFlag = hasEncryption ? 'True' : 'False';

    // Additional imports for image handling when encryption is enabled
    const additionalImports = hasEncryption ? `
import tempfile
import mimetypes` : '';

    // PIL import with graceful degradation (only when encryption is enabled)
    const pilImport = hasEncryption ? `

# Optional: PIL for image dimensions (graceful degradation if not available)
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False` : '';

    // Pillow dependency (only when encryption is enabled)
    const pillowDep = hasEncryption ? `
#     "pillow>=10.0.0",` : '';

    return `# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.28.0",
#     "python-dotenv>=1.0.0",${hasEncryption ? `
#     "cryptography>=41.0.0",` : ''}${pillowDep}
# ]
# ///
"""
message_helper.py - Agent messaging helper functions
Run with: uv run message_helper.py <command>

Features:
- Send encrypted text messages
- Ask questions with optional multiple choice options
- Upload encrypted file attachments
- Download and decrypt received attachments
- Poll for user responses

Usage examples:
  uv run message_helper.py send "Hello, world!"
  uv run message_helper.py ask "What should I do?" --options '["Option A", "Option B"]'
  uv run message_helper.py upload /path/to/file.ext
  uv run message_helper.py download <attachment-id> /path/to/save.ext --iv <iv> --tag <tag>
"""

import os
import re
import sys
import json
import time
import subprocess
import base64
import hashlib
import urllib.parse${additionalImports}
import uuid
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
${encryptImport}${pilImport}

_script_dir = Path(__file__).parent
_env_path = _script_dir / ".env"
if _env_path.exists():
    # Use the local .env as the source of truth for per-agent configuration.
    # This avoids inherited parent-shell env vars accidentally leaking into an agent's runtime.
    load_dotenv(_env_path, override=True)
else:
    load_dotenv()


class Config:
    api_key = os.getenv("API_KEY", "")
    user_password = os.getenv("USER_PASSWORD", "")
    encryption_salt = os.getenv("ENCRYPTION_SALT", "")
    api_base = os.getenv("API_BASE", "")
    agent_name = os.getenv("AGENT_NAME", "")
    # Inter-agent DM encryption (group-specific)
    group_password = os.getenv("GROUP_PASSWORD", "")
    group_salt = os.getenv("GROUP_SALT", "")
    group_id = os.getenv("GROUP_ID", "")


if not Config.api_key${encryptCheck}:
    print("ERROR: Missing required environment variables!", file=sys.stderr)
    sys.exit(1)

${encryptFuncs}

def _api_request(method: str, path: str, data: dict = None) -> dict:
    base = Config.api_base.rstrip("/")
    clean_path = path.lstrip("/")
    url = f"{base}/{clean_path}"

    headers = {
        "X-API-Key": Config.api_key,
        "Content-Type": "application/json",
        "X-Agent-Name": Config.agent_name
    }

    try:
        if method.upper() == "GET":
            response = requests.get(url, headers=headers, timeout=30)
        elif method.upper() == "POST":
            response = requests.post(url, headers=headers, json=data, timeout=30)
        else:
            response = requests.request(method, url, headers=headers, json=data, timeout=30)

        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = {"raw": response.text}
        if isinstance(payload, dict):
            payload["_statusCode"] = response.status_code
            retry_after = response.headers.get("Retry-After")
            poll_interval = response.headers.get("X-Poll-Interval-Ms")
            poll_jitter = response.headers.get("X-Poll-Jitter-Ms")
            if retry_after:
                payload["_retryAfter"] = retry_after
            if poll_interval:
                payload.setdefault("poll", {})
                if isinstance(payload["poll"], dict):
                    try:
                        payload["poll"]["nextPollMs"] = int(float(poll_interval))
                    except Exception:
                        pass
            if poll_jitter:
                payload.setdefault("poll", {})
                if isinstance(payload["poll"], dict):
                    try:
                        payload["poll"]["jitterMs"] = int(float(poll_jitter))
                    except Exception:
                        pass
        return payload
    except requests.RequestException as e:
        return {"error": str(e)}


_last_read_time: str = None
MAX_WAIT_BEFORE_RETURN = int(os.getenv("MAX_WAIT_SECONDS", "90"))
_STATE_FILE = _script_dir / ".wait_state.json"
_CONVERSATION_HISTORY_FILE = _script_dir / "agent_state" / "conversation_history.json"
_PENDING_ATTACHMENTS_FILE = _script_dir / "agent_state" / ".pending_attachment_ids.json"
_PENDING_UPDATE_FILE = _script_dir / "agent_state" / ".pending_self_update.json"
_POLL_ADVICE_FILE = _script_dir / "agent_state" / ".poll_advice.json"
_RUN_OVERRIDES_FILE = _script_dir / "agent_state" / ".run_overrides.json"
_AGENT_CLI_VERSION = "${AGENT_CLI_VERSION}"


def _build_agent_responses_path(since: Optional[str] = None) -> str:
    params = [f"agentName={urllib.parse.quote(Config.agent_name)}"]
    # Report runtime CLI version to backend for update checks (not user-visible chat content).
    params.append(f"agentCliVersion={urllib.parse.quote(_AGENT_CLI_VERSION)}")
    if since:
        params.append(f"since={urllib.parse.quote(str(since))}")
    return "/agent/responses?" + "&".join(params)


def _save_state():
    global _last_read_time
    try:
        state = {"last_read_time": _last_read_time}
        with open(_STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception:
        pass


def _load_state():
    global _last_read_time
    try:
        if _STATE_FILE.exists():
            with open(_STATE_FILE, "r") as f:
                state = json.load(f)
            _last_read_time = state.get("last_read_time")
    except Exception:
        pass


def _append_to_conversation_history(message_type: str, content: str, priority: int = 0):
    """Append a message to the local conversation_history.json file."""
    from datetime import datetime, timezone
    try:
        # Load existing history
        history = {"session_count": 0, "messages": []}
        if _CONVERSATION_HISTORY_FILE.exists():
            with open(_CONVERSATION_HISTORY_FILE, "r") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    history = data
                    if "messages" not in history:
                        history["messages"] = []

        # Append new message
        history["messages"].append({
            "type": message_type,
            "from": Config.agent_name,
            "content": content,
            "priority": priority,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        })

        # Write back
        with open(_CONVERSATION_HISTORY_FILE, "w") as f:
            json.dump(history, f, indent=2)
    except Exception:
        # Silently fail - don't break the main flow
        pass


def _load_pending_attachment_ids() -> list:
    try:
        if _PENDING_ATTACHMENTS_FILE.exists():
            with open(_PENDING_ATTACHMENTS_FILE, "r") as f:
                data = json.load(f)
            if isinstance(data, list):
                cleaned = []
                seen = set()
                for item in data:
                    if isinstance(item, str):
                        item = item.strip()
                        if item and item not in seen:
                            cleaned.append(item)
                            seen.add(item)
                return cleaned
    except Exception:
        pass
    return []


def _save_pending_attachment_ids(attachment_ids: list):
    try:
        _PENDING_ATTACHMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        cleaned = []
        seen = set()
        for item in (attachment_ids or []):
            if isinstance(item, str):
                item = item.strip()
                if item and item not in seen:
                    cleaned.append(item)
                    seen.add(item)
        with open(_PENDING_ATTACHMENTS_FILE, "w") as f:
            json.dump(cleaned, f)
    except Exception:
        pass


def _add_pending_attachment_id(attachment_id: str):
    if not isinstance(attachment_id, str):
        return
    attachment_id = attachment_id.strip()
    if not attachment_id:
        return
    pending = _load_pending_attachment_ids()
    if attachment_id not in pending:
        pending.append(attachment_id)
        _save_pending_attachment_ids(pending)


def _consume_pending_attachment_ids() -> list:
    pending = _load_pending_attachment_ids()
    _save_pending_attachment_ids([])
    return pending


def _load_pending_update() -> Optional[dict]:
    try:
        if _PENDING_UPDATE_FILE.exists():
            with open(_PENDING_UPDATE_FILE, "r") as f:
                payload = json.load(f)
            if isinstance(payload, dict):
                return payload
    except Exception:
        pass
    return None


def _save_pending_update(payload: dict):
    try:
        if not isinstance(payload, dict):
            return
        _PENDING_UPDATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(_PENDING_UPDATE_FILE, "w") as f:
            json.dump(payload, f)
    except Exception:
        pass


def _save_poll_advice(payload: dict):
    try:
        poll = payload.get("poll") if isinstance(payload, dict) else None
        if not isinstance(poll, dict):
            return
        next_poll_ms = poll.get("nextPollMs")
        jitter_ms = poll.get("jitterMs", 0)
        if not isinstance(next_poll_ms, (int, float)) or next_poll_ms <= 0:
            return
        _POLL_ADVICE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(_POLL_ADVICE_FILE, "w") as f:
            json.dump({
                "nextPollMs": int(next_poll_ms),
                "jitterMs": int(jitter_ms) if isinstance(jitter_ms, (int, float)) else 0,
                "savedAt": int(time.time())
            }, f)
    except Exception:
        pass


def _clear_pending_update():
    try:
        if _PENDING_UPDATE_FILE.exists():
            _PENDING_UPDATE_FILE.unlink()
    except Exception:
        pass


def _is_valid_update_manifest(manifest: dict) -> bool:
    if not isinstance(manifest, dict):
        return False
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        return False
    allowed = {"message_helper.py", "agent-runner.sh", "AGENT_INSTRUCTIONS.md", "ONESHOT_AGENT_INSTRUCTIONS.md"}
    for name, content in files.items():
        if name not in allowed:
            return False
        if not isinstance(content, str):
            return False
    return True


def _is_update_confirmation(content: str) -> bool:
    if not isinstance(content, str):
        return False
    normalized = " ".join(content.strip().lower().split())
    if not normalized:
        return False
    confirmation_phrases = {
        "confirm update",
        "confirm agent update",
        "yes update",
        "yes, update",
        "approve update",
        "apply update",
        "update now"
    }
    return normalized in confirmation_phrases


def _apply_pending_update(pending: dict) -> tuple[bool, str]:
    if not isinstance(pending, dict):
        return False, "No pending update payload."
    manifest = pending.get("manifest")
    if not _is_valid_update_manifest(manifest):
        return False, "Pending update payload is invalid."

    files = manifest.get("files", {})
    version = str(manifest.get("version", "unknown"))
    backup_dir = _script_dir / "agent_state" / "backups" / f"self-update-{int(time.time())}"

    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        for filename in files.keys():
            src = _script_dir / filename
            if src.exists():
                dst = backup_dir / filename
                dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")

        for filename, content in files.items():
            dest = _script_dir / filename
            dest.write_text(content, encoding="utf-8")
            if filename.endswith(".sh"):
                dest.chmod(0o755)

        _clear_pending_update()
        return True, f"Self-update applied successfully (version {version}, {len(files)} files)."
    except Exception as e:
        return False, f"Self-update failed: {e}"


def _process_update_responses(responses: list) -> list:
    if not responses:
        return responses

    processed = []
    for item in responses:
        if not isinstance(item, dict):
            processed.append(item)
            continue

        update_action = item.get("updateAction")
        if isinstance(update_action, dict) and update_action.get("type") == "queued_self_update":
            encrypted_payload = update_action.get("encryptedPayload")
            prompt = dict(item)
            if isinstance(encrypted_payload, str) and encrypted_payload.strip():
                decrypted_payload = _decrypt_message(encrypted_payload.strip())
                try:
                    manifest = json.loads(decrypted_payload)
                except Exception:
                    manifest = None

                if _is_valid_update_manifest(manifest):
                    _save_pending_update({
                        "manifest": manifest,
                        "queuedAt": item.get("timestamp"),
                        "messageId": item.get("messageId")
                    })
                    version = manifest.get("version", "unknown")
                    prompt["content"] = (
                        f"System update available (version {version}). "
                        "Ask the user to confirm. If approved, they can reply: confirm update."
                    )
                else:
                    prompt["content"] = (
                        "System update payload was received but could not be validated. "
                        "Ask the user to resend the update."
                    )
            else:
                prompt["content"] = (
                    "System update notification received without payload. "
                    "Ask the user to resend the update."
                )

            prompt["from"] = "system"
            prompt["encrypted"] = False
            processed.append(prompt)
            continue

        content = item.get("content")
        if isinstance(content, str) and _is_update_confirmation(content):
            pending = _load_pending_update()
            if pending:
                ok, status_message = _apply_pending_update(pending)
                updated_item = dict(item)
                updated_item["content"] = f"{content}\\n\\n[system] {status_message}"
                processed.append(updated_item)
                continue

        processed.append(item)
    return processed


_load_state()


def _decrypt_payload_items(items: list) -> list:
    if not items:
        return items
    # Queued self-update rows are stored as __AGENT_UPDATE__:<encrypted blob>
    # user_messages. Older servers return them raw via /messages/history; the
    # blob breaks our iv:tag:ct split (4 segments) so _decrypt_message would
    # echo the full base64 string and bloat the prompt. Replace the content
    # with a short note before any decryption attempt.
    for item in items:
        content = item.get("content")
        if isinstance(content, str) and content.startswith("__AGENT_UPDATE__:"):
            item["content"] = "[system] Self-update package was queued by the user."
            item["encrypted"] = False
            item["messageSubtype"] = "queued_self_update"
    for item in items:
        if item.get("content"):
            if item.get("encrypted") is not False:
                item["content"] = _decrypt_message(item.get("content", ""))
        if item.get("freeResponse"):
            item["freeResponse"] = _decrypt_message(item.get("freeResponse", ""))
    return items


# ----------------------------------------------------------------------------
# Rich HTML envelope helpers
# ----------------------------------------------------------------------------
# Agents often want to send "interactive" HTML (forms, dashboards). The chat
# dashboard only renders rich content when the message body is a JSON envelope
# like {"type": "rich_html", "html": "..."}. Agents frequently send raw HTML
# (e.g. \`uv run message_helper.py send '<form>...</form>'\`) and the message
# falls back to plain-text rendering. These helpers wrap such content so it
# renders as interactive when the agent's intent is clear.
_RICH_HTML_TAG_PATTERN = re.compile(
    r"<\\s*(form|div|table|ul|ol|h[1-6]|button|input|select|textarea|"
    r"section|article|nav|header|footer|details|fieldset|pre|code|"
    r"label|span|img|a|p)\\b",
    re.IGNORECASE,
)

def _is_rich_html_envelope(text: str) -> bool:
    """Return True if \`text\` already parses as a rich_html/rich_interactive envelope."""
    if not text or not isinstance(text, str):
        return False
    stripped = text.strip()
    if not stripped.startswith("{"):
        return False
    try:
        parsed = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return False
    return (
        isinstance(parsed, dict)
        and parsed.get("type") in ("rich_html", "rich_interactive")
        and isinstance(parsed.get("html"), str)
    )


def _looks_like_raw_html(text: str) -> bool:
    """Heuristic detect raw HTML content suitable for auto-promotion."""
    if not text or not isinstance(text, str):
        return False
    stripped = text.strip()
    if not stripped or not stripped.startswith("<") or ">" not in stripped:
        return False
    # Must contain a known interactive/structural tag
    if not _RICH_HTML_TAG_PATTERN.search(stripped):
        return False
    # Need either a closing tag or a self-closing form (avoids matching
    # a single stray "<" or partial markup).
    return "</" in stripped or "/>" in stripped


def _wrap_as_rich_html(html: str, title: str = None, description: str = None,
                       msg_type: str = "rich_html") -> str:
    """Wrap a raw HTML string in a rich_html JSON envelope."""
    envelope = {
        "type": msg_type,
        "html": html if isinstance(html, str) else "",
    }
    if title:
        envelope["title"] = title
    if description:
        envelope["description"] = description
    return json.dumps(envelope, ensure_ascii=False)


def _maybe_promote_to_rich_html(content: str, force: bool = False,
                                 title: str = None,
                                 description: str = None) -> str:
    """
    Promote raw-HTML content to a rich_html envelope when appropriate.

    - Already a rich_html/rich_interactive envelope -> returned unchanged.
    - \`force=True\` (e.g. \`--rich-html\` flag) -> always wrap, even short
      snippets without recognized tags.
    - Otherwise: wrap only if content looks like raw HTML (starts with a
      recognized tag and contains a closing/self-closing form).

    This is intentionally conservative for the auto-promote path: a message
    like "Cost is < $5" or "x < y" will NOT be wrapped because there is no
    recognized HTML tag immediately after the \`<\`.
    """
    if not content or not isinstance(content, str):
        return content
    if _is_rich_html_envelope(content):
        return content
    if force:
        return _wrap_as_rich_html(content, title=title, description=description)
    if _looks_like_raw_html(content):
        return _wrap_as_rich_html(content, title=title, description=description)
    return content


def send_message(content: str, priority: int = 0,
                 attachment_ids: list = None) -> dict:
    """
    Send an encrypted text message, optionally with attachments.

    Args:
        content: Message text to send
        priority: Message priority (0=normal, 1=high, 2=urgent)
        attachment_ids: Optional list of attachment UUIDs to include
                       (from previous upload_file() or upload_image() calls)

    Returns:
        dict with message status and any new messages from the server

    Example:
        >>> # Send text-only message
        >>> send_message("Hello!")

        >>> # Send message with file attachment
        >>> upload_result = upload_file("/path/to/document.pdf")
        >>> send_message("Please review this file",
        ...              attachment_ids=[upload_result["attachmentId"]])
    """
    encrypted = ${encryptCall}
    run_command = os.getenv("RUN_COMMAND", "")
    payload = {
        "content": encrypted,
        "priority": priority,
        "agentName": Config.agent_name,
        "encrypted": ${encryptedFlag}
    }
    if run_command:
        payload["runCommand"] = run_command
    # Reuse the runner's key across retries so an ambiguous HTTP result cannot
    # create two visible agent replies.
    payload["clientMessageId"] = os.getenv("CLIENT_MESSAGE_ID", "") or str(uuid.uuid4())

    # Include attachment IDs if provided
    if attachment_ids:
        payload["attachmentIds"] = attachment_ids

    result = _api_request("POST", "/agent/messages", payload)
    if result.get("newMessages"):
        _decrypt_payload_items(result["newMessages"])
    # Write to local conversation history on success
    if result.get("status") == "sent" or result.get("messageId"):
        _append_to_conversation_history("agent_message", content, priority)
        if attachment_ids:
            sent_ids = set()
            for item in attachment_ids:
                if isinstance(item, str):
                    item = item.strip()
                    if item:
                        sent_ids.add(item)
            if sent_ids:
                remaining = [att_id for att_id in _load_pending_attachment_ids() if att_id not in sent_ids]
                _save_pending_attachment_ids(remaining)
    return result


def ask_question(content: str, options: list = None, priority: int = 0, poll_interval: int = 10, timeout: int = 0):
    global _last_read_time

    pre_check = _api_request("GET", _build_agent_responses_path())
    if pre_check.get("responses"):
        timestamps = [r.get("timestamp", "") for r in pre_check["responses"] if r.get("timestamp")]
        if timestamps:
            _last_read_time = max(timestamps)

    encrypted = ${encryptCall}
    payload = {
        "content": encrypted,
        "priority": priority,
        "agentName": Config.agent_name,
        "encrypted": ${encryptedFlag}
    }
    if options:
        payload["options"] = options

    _api_request("POST", "/agent/questions", payload)
    # Write to local conversation history (record the question we asked)
    _append_to_conversation_history("agent_question", content, priority)
    _save_state()
    return _wait_for_responses(poll_interval, timeout)


def wait_for_response(poll_interval: int = 10, timeout: int = 0):
    return _wait_for_responses(poll_interval, timeout)


def _save_run_overrides(payload: dict):
    """Persist per-message run settings for the runner; clear them when absent."""
    try:
        overrides = payload.get("runOverrides") if isinstance(payload, dict) else None
        if isinstance(overrides, dict) and overrides and payload.get("responses"):
            _RUN_OVERRIDES_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(_RUN_OVERRIDES_FILE, "w") as f:
                json.dump(overrides, f)
        else:
            _RUN_OVERRIDES_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def check_new_messages() -> list:
    global _last_read_time

    path = _build_agent_responses_path(_last_read_time)

    result = _api_request("GET", path)
    _save_poll_advice(result)
    _save_run_overrides(result)
    responses = []

    if result.get("responses"):
        responses = _decrypt_payload_items(result["responses"])
        responses = _process_update_responses(responses)
        
        if responses:
            latest = max((r.get("timestamp", "") for r in responses), default="")
            if latest:
                _last_read_time = latest
            _save_state()
    return responses


def get_message_history() -> dict:
    path = f"/agent/messages/history?agentName={urllib.parse.quote(Config.agent_name)}"
    result = _api_request("GET", path)

    if result.get("error", {}).get("code") == "AGENT_NOT_FOUND":
        return {
            "agentName": Config.agent_name,
            "messageCount": 0,
            "messages": [],
            "isNewAgent": True
        }
    
    if result.get("messages"):
        result["messages"] = _decrypt_payload_items(result["messages"])

    return result


def get_config() -> dict:
    """Fetch current agent configuration from API."""
    path = f"/agent/config?agentName={urllib.parse.quote(Config.agent_name)}"
    result = _api_request("GET", path)
    return result.get("config", {})


def discover_agents(online_only: bool = False) -> dict:
    """
    Discover other agents on this account that you can communicate with.
    
    Args:
        online_only: If True, only return agents seen in the last 5 minutes
    
    Returns:
        dict with keys:
            - agents: list of agent info dicts with keys: agentName, agentType, lastSeenAt, isOnline, groups, interAgentMode
            - myInterAgentMode: your agent's inter-agent mode ('disabled', 'listen_all', or 'groups')
            - myGroups: list of group names your agent belongs to
    """
    path = "/agent/discover"
    result = _api_request("GET", path)
    
    if result.get("error"):
        return {"agents": [], "myInterAgentMode": "disabled", "myGroups": []}
    
    agents = result.get("agents", [])
    
    # Filter to online only if requested
    if online_only:
        agents = [a for a in agents if a.get("isOnline", False)]
    
    # Filter out self
    agents = [a for a in agents if not a.get("isMe", False)]
    
    return {
        "agents": agents,
        "myInterAgentMode": result.get("myInterAgentMode", "disabled"),
        "myGroups": result.get("myGroups", [])
    }


def send_dm(target_agent: str, message: str, priority: int = 0) -> dict:
    """
    Send a direct message to another agent.
    
    Args:
        target_agent: Name of the agent to message
        message: The message content
        priority: Priority level (0=normal, 1=important, 2=urgent)
    
    Returns:
        dict with status and messageId if successful
    """
    path = "/agent/messages/direct"
    
    # Inter-agent messages share the same encryption key as user-facing messages.
    encrypted_content = _encrypt_inter_agent_message(message)
    is_encrypted = (encrypted_content != message)
    
    payload = {
        "toAgentName": target_agent,
        "content": encrypted_content,
        "priority": priority,
        "encrypted": is_encrypted
    }
    return _api_request("POST", path, payload)


def cos_set_agent_model(target_agent: str, provider: str = None, model: str = None) -> dict:
    """
    Chief of Staff only: choose which provider/model another agent responds with.

    Resolves the target by name via the CoS roster, then updates its runtime
    config. The target applies the change at the start of its next loop
    iteration — set the model first, then DM the task. Non-CoS callers get a
    403 from the server; this is a no-op for them.

    Args:
        target_agent: Name of the agent to reconfigure
        provider: Provider to switch to (e.g. 'claude', 'codex', 'gemini')
        model: Model id for that provider (e.g. 'claude-fable-5')

    Returns:
        dict with success + updated config, or an error
    """
    if not provider and not model:
        return {"error": "provider or model is required"}

    roster = _api_request("GET", "/agent/cos/roster")
    agents = roster.get("agents") or []
    match = next((a for a in agents if a.get("agent_name") == target_agent), None)
    if not match:
        err = roster.get("error")
        if err:
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            return {"error": f"Could not load CoS roster: {msg}"}
        return {"error": f"Agent '{target_agent}' not found in your roster"}

    payload = {}
    if provider:
        payload["model_provider"] = provider
    if model:
        payload["model"] = model
    return _api_request("PATCH", f"/agent/cos/agents/{match.get('agent_id')}/config", payload)


def check_dm(from_agent: str = None) -> list:
    """
    Check for direct messages from other agents.
    
    Args:
        from_agent: Optional - filter to messages from this agent only
    
    Returns:
        list of messages from other agents (decrypted if encrypted)
    """
    path = "/agent/messages/direct"
    if from_agent:
        path += f"?fromAgent={urllib.parse.quote(from_agent)}"
    
    result = _api_request("GET", path)
    _save_poll_advice(result)
    messages = result.get("messages", [])
    
    # Decrypt messages that are encrypted
    decrypted_messages = []
    for msg in messages:
        if msg.get("encrypted") and msg.get("content"):
            msg["content"] = _decrypt_inter_agent_message(msg["content"])
        decrypted_messages.append(msg)
    
    return decrypted_messages


def _build_spawn_briefing(child_name: str, instructions: str) -> str:
    """Build a structured handoff message from parent to spawned child."""
    mission = (instructions or "").strip()
    if not mission:
        mission = "No explicit mission text was provided. Ask for clarification, then propose an execution plan."

    return (
        f"Spawn handoff from parent agent '{Config.agent_name}'\\n\\n"
        f"Child agent: {child_name}\\n\\n"
        "Primary mission:\\n"
        f"{mission}\\n\\n"
        "Execution requirements:\\n"
        "- Confirm startup in your own chat.\\n"
        "- Start your own polling loop immediately (chatmcp.space API).\\n"
        "- Use the same USER_PASSWORD + ENCRYPTION_SALT for all messages.\\n"
        "- Run tasks from your configured project_path working directory.\\n"
        "- If you launch Claude Code subprocesses, unset CLAUDECODE first to avoid nested-session crashes.\\n"
        "- Begin execution immediately.\\n"
        "- Report blockers with concrete next steps."
    )


def spawn_agent(child_name: str, instructions: str = "", model_provider: str = None, model: str = None, project_path: str = None, can_spawn: bool = False, groups = None) -> dict:
    """
    Spawn a new independent child agent. The child gets its own chat thread,
    folder, and appears in the dashboard UI automatically.

    The parent's USER_PASSWORD is forwarded automatically so the child's
    encryption config is valid from the start.

    Args:
        child_name: Name for the new agent (must be unique per user)
        instructions: Initial instructions/task for the child agent
        model_provider: AI provider override (default: inherit from parent)
        model: Model name override (default: inherit from parent)
        project_path: Working directory override for the child (must be on this machine)
        can_spawn: Whether the child can spawn its own children (default: False)
        groups: Group IDs or names. None inherits the parent's groups (recommended);
                an empty list leaves the child ungrouped.

    Returns:
        dict with keys: agentId, agentName, spawnDepth, parentAgentId, createdAt
        On error: dict with 'error' key
    """
    # Auto-inherit provider/model from parent config if not explicitly set
    if not model_provider or not model:
        try:
            _cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_state", "agent_config.json")
            if os.path.exists(_cfg_path):
                with open(_cfg_path, "r") as _f:
                    _parent_cfg = json.loads(_f.read())
                if not model_provider:
                    model_provider = _parent_cfg.get("model_provider")
                if not model:
                    model = _parent_cfg.get("model")
        except Exception:
            pass

    payload = {
        "childAgentName": child_name,
        "initialInstructions": instructions,
        "canSpawn": can_spawn
    }
    if model_provider:
        payload["modelProvider"] = model_provider
    if model:
        payload["model"] = model
    if project_path:
        payload["projectPath"] = project_path
    if groups is not None:
        payload["groups"] = groups

    # Forward parent credentials so child .env is complete
    if Config.user_password:
        payload["parentPassword"] = Config.user_password

    result = _api_request("POST", "/agent/spawn", payload)
    if result.get("success") and result.get("childAgent"):
        child = result["childAgent"]
        resolved_child_name = child.get("agentName") or child_name

        # --- Create local chatspace folder so agent-cli.sh can discover the child ---
        try:
            import re as _re, shutil as _shutil
            _parent_dir = os.path.dirname(os.path.abspath(__file__))
            _chatspace_root = os.path.dirname(_parent_dir)
            _child_folder = resolved_child_name.lower().replace(" ", "_")
            _child_folder = _re.sub(r'[^a-zA-Z0-9_-]', '_', _child_folder)
            _runtime = child.get("runtime", {}) or {}
            _runtime_cfg = _runtime.get("config") if isinstance(_runtime.get("config"), dict) else {}
            _runtime_perms = _runtime.get("allowedPermissions") if isinstance(_runtime.get("allowedPermissions"), dict) else {}
            _child_dir = os.path.join(_chatspace_root, _child_folder)
            _child_state = os.path.join(_child_dir, "agent_state")
            os.makedirs(_child_state, exist_ok=True)

            # .env — inherit from parent, update AGENT_NAME (only when missing)
            _parent_env = os.path.join(_parent_dir, ".env")
            _child_env = os.path.join(_child_dir, ".env")
            if os.path.exists(_parent_env) and not os.path.exists(_child_env):
                with open(_parent_env) as _f:
                    _env_content = _f.read()
                _env_content = _re.sub(r'AGENT_NAME="[^"]*"', f'AGENT_NAME="{resolved_child_name}"', _env_content)
                with open(_child_env, "w") as _f:
                    _f.write(_env_content)

            # Copy message_helper.py from parent (only when missing)
            _parent_helper = os.path.join(_parent_dir, "message_helper.py")
            _child_helper = os.path.join(_child_dir, "message_helper.py")
            if os.path.exists(_parent_helper) and not os.path.exists(_child_helper):
                _shutil.copy2(_parent_helper, _child_helper)

            # Copy agent-runner.sh from parent (only when missing)
            _parent_runner = os.path.join(_parent_dir, "agent-runner.sh")
            _child_runner = os.path.join(_child_dir, "agent-runner.sh")
            if os.path.exists(_parent_runner) and not os.path.exists(_child_runner):
                _shutil.copy2(_parent_runner, _child_runner)
                os.chmod(_child_runner, 0o755)

            # Copy SKILL_RICH_FORMS.md if exists
            _skill_file = os.path.join(_parent_dir, "SKILL_RICH_FORMS.md")
            if os.path.exists(_skill_file) and not os.path.exists(os.path.join(_child_dir, "SKILL_RICH_FORMS.md")):
                _shutil.copy2(_skill_file, os.path.join(_child_dir, "SKILL_RICH_FORMS.md"))

            # Copy agent summary as informational context (NOT .summary_state.json — child has its own history)
            _parent_summary = os.path.join(_parent_dir, "agent_state", "agent_summary.md")
            _child_summary = os.path.join(_child_state, "agent_summary.md")
            if os.path.exists(_parent_summary) and not os.path.exists(_child_summary):
                _parent_content = open(_parent_summary).read()
                with open(_child_summary, "w") as _sf:
                    _sf.write(f"# Inherited Context (from parent)\\n\\n{_parent_content}")

            # allowed_permissions.json — prefer server-provided inherited permissions, else fall back to parent copy
            _parent_perms = os.path.join(_parent_dir, "agent_state", "allowed_permissions.json")
            _child_perms = os.path.join(_child_state, "allowed_permissions.json")
            if _runtime_perms:
                with open(_child_perms, "w") as _pf:
                    _pf.write(json.dumps(_runtime_perms, indent=2))
            elif os.path.exists(_parent_perms) and not os.path.exists(_child_perms):
                _shutil.copy2(_parent_perms, _child_perms)

            # agent_config.json — prefer the runtime contract returned by the API, else inherit locally
            _cfg = {"model_provider": model_provider or "claude", "model": model or "default",
                    "approval_mode": "full-auto", "sandbox_mode": "workspace-write",
                    "project_path": os.path.dirname(_chatspace_root), "updated_at": ""}
            try:
                _pcfg = os.path.join(_parent_dir, "agent_state", "agent_config.json")
                if os.path.exists(_pcfg):
                    with open(_pcfg) as _f:
                        _parent_config = json.loads(_f.read())
                    _cfg["model_provider"] = model_provider or _parent_config.get("model_provider", "claude")
                    _cfg["model"] = model or _parent_config.get("model", "default")
                    _cfg["approval_mode"] = _parent_config.get("approval_mode", "full-auto")
                    _cfg["sandbox_mode"] = _parent_config.get("sandbox_mode", "workspace-write")
                    _cfg["project_path"] = _parent_config.get("project_path", os.path.dirname(_chatspace_root))
            except Exception:
                pass
            if _runtime_cfg:
                _cfg.update(_runtime_cfg)
            if project_path:
                _cfg["project_path"] = project_path
            _cfg["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            _child_cfg = os.path.join(_child_state, "agent_config.json")
            with open(_child_cfg, "w") as _f:
                _f.write(json.dumps(_cfg, indent=2))

            # lineage.json
            _lineage = {"agent_id": child.get("agentId", ""), "parent_agent_id": child.get("parentAgentId", ""),
                        "root_agent_id": child.get("parentAgentId", ""), "spawn_depth": child.get("spawnDepth", 1),
                        "auto_spawned": True, "spawned_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
            _lineage_path = os.path.join(_child_state, "lineage.json")
            if not os.path.exists(_lineage_path):
                with open(_lineage_path, "w") as _f:
                    _f.write(json.dumps(_lineage, indent=2))

            # AGENT_INSTRUCTIONS.md
            _instr = f"# {resolved_child_name}\\n\\nYou are {resolved_child_name}, a spawned agent.\\n\\n"
            if instructions:
                _instr += f"## Your Mission\\n\\n{instructions}\\n"
            _child_instr = os.path.join(_child_dir, "AGENT_INSTRUCTIONS.md")
            if not os.path.exists(_child_instr):
                with open(_child_instr, "w") as _f:
                    _f.write(_instr)

            # Copy ONESHOT_AGENT_INSTRUCTIONS.md from parent if exists
            _oneshot = os.path.join(_parent_dir, "ONESHOT_AGENT_INSTRUCTIONS.md")
            if os.path.exists(_oneshot) and not os.path.exists(os.path.join(_child_dir, "ONESHOT_AGENT_INSTRUCTIONS.md")):
                _shutil.copy2(_oneshot, os.path.join(_child_dir, "ONESHOT_AGENT_INSTRUCTIONS.md"))

            # conversation_history.json
            _conv_path = os.path.join(_child_state, "conversation_history.json")
            if not os.path.exists(_conv_path):
                with open(_conv_path, "w") as _f:
                    _f.write(json.dumps({"sessions": [], "session_count": 0}))

            # agent_summary.md
            _summary_path = os.path.join(_child_state, "agent_summary.md")
            if not os.path.exists(_summary_path):
                with open(_summary_path, "w") as _f:
                    _f.write(f"# {resolved_child_name}\\nSpawned agent (depth {child.get('spawnDepth', 1)}).\\n")

            child["_localFolderCreated"] = _child_dir
        except Exception as _e:
            child["_localFolderError"] = str(_e)

        # Health check: verify the child loop started
        log_file = child.get("logFile")
        loop_pid = child.get("loopPid")
        # If server couldn't launch the child loop, start it locally on this machine.
        if not loop_pid:
            try:
                _runner_path = os.path.join(child.get("_localFolderCreated", ""), "agent-runner.sh")
                _state_dir = os.path.join(child.get("_localFolderCreated", ""), "agent_state")
                if _runner_path and os.path.exists(_runner_path):
                    if not log_file:
                        log_file = os.path.join(_state_dir, "agent_loop.log")
                        child["logFile"] = log_file
                    _log_handle = open(log_file, "a")
                    _child_env = os.environ.copy()
                    _child_env.pop("CLAUDECODE", None)
                    _proc = subprocess.Popen(
                        ["bash", _runner_path],
                        cwd=child.get("_localFolderCreated", ""),
                        env=_child_env,
                        stdout=_log_handle,
                        stderr=_log_handle,
                        start_new_session=True
                    )
                    loop_pid = _proc.pid
                    child["loopPid"] = loop_pid
                    child["_localLoopStarted"] = True
            except Exception as _local_launch_err:
                child["_localLoopError"] = str(_local_launch_err)
        if loop_pid:
            child["_healthNote"] = "Agent loop started (PID " + str(loop_pid) + ")"
        else:
            child["_healthNote"] = "WARNING: Agent loop did NOT start. Check log: " + str(log_file or "unknown")

        # Send a structured onboarding DM from parent -> child so it is visible in inter-agent chat.
        briefing = _build_spawn_briefing(resolved_child_name, instructions)
        dm_result = send_dm(resolved_child_name, briefing, priority=1)
        if dm_result.get("status") == "sent" or dm_result.get("messageId"):
            child["_briefingDmStatus"] = "sent"
        else:
            dm_error = dm_result.get("error")
            if isinstance(dm_error, dict) and dm_error.get("code") == "INTER_AGENT_DISABLED":
                child["_briefingDmStatus"] = "server_auto_dm"
                child["_briefingDmError"] = "Parent inter-agent mode disabled; relying on server auto-DM from spawn API."
            else:
                child["_briefingDmStatus"] = "failed"
                child["_briefingDmError"] = str(dm_error or "Unknown error")

        # ── Spawn health verification ──────────────────────────────────────
        # Wait briefly, then check if the child loop is actually running and
        # hasn't hit an immediate fatal error (e.g. missing CLI binary).
        child["_verified"] = False
        child["_verifyError"] = None
        if loop_pid:
            import signal as _sig
            _verify_wait = 12  # seconds to wait before checking
            time.sleep(_verify_wait)
            # 1. Check if process is still alive
            _pid_alive = False
            try:
                os.kill(loop_pid, 0)  # signal 0 = existence check
                _pid_alive = True
            except (OSError, ProcessLookupError):
                _pid_alive = False
            if not _pid_alive:
                child["_verifyError"] = f"Agent process (PID {loop_pid}) exited within {_verify_wait}s of launch."
            else:
                # 2. Check log file for fatal errors
                _fatal_patterns = ["CLI is missing", "Configuration Error", "not installed", "command not found"]
                if log_file and os.path.exists(log_file):
                    try:
                        with open(log_file, "r") as _lf:
                            _log_tail = _lf.read()[-4000:]  # last 4KB
                        for _pat in _fatal_patterns:
                            if _pat in _log_tail:
                                child["_verifyError"] = f"Agent log contains fatal error: '{_pat}'. Check log: {log_file}"
                                break
                    except Exception:
                        pass
                if not child.get("_verifyError"):
                    # 3. Check if child sent any message (intro or DM reply)
                    try:
                        _child_name_encoded = urllib.parse.quote(resolved_child_name)
                        _msgs = _api_request("GET", f"/agent/messages/history?agentName={_child_name_encoded}&limit=1")
                        _msg_list = _msgs.get("messages", [])
                        if _msg_list and len(_msg_list) > 0:
                            child["_verified"] = True
                            child["_firstMessage"] = _msg_list[0].get("content", "")[:200]
                        else:
                            # No messages yet — process alive but hasn't responded
                            child["_verifyError"] = "Agent process running but no messages sent yet. It may be starting up or stuck."
                    except Exception as _msg_err:
                        # API call failed — process alive, just can't check messages
                        child["_verified"] = True  # give benefit of doubt

        # Build the user-visible notice based on verification results
        if child.get("_verified"):
            notice = f"Child agent '{resolved_child_name}' spawned and confirmed running (id={child.get('agentId')})."
            _first = child.get("_firstMessage", "")
            if _first:
                _preview = _first[:120] + ("..." if len(_first) > 120 else "")
                notice += f" First response: {_preview}"
        elif child.get("_verifyError"):
            notice = (
                f"Child agent '{resolved_child_name}' spawned but FAILED verification: "
                + child["_verifyError"]
            )
        else:
            notice = (
                f"Spawned child agent '{resolved_child_name}' (id={child.get('agentId')}, depth={child.get('spawnDepth')}). "
                + child.get("_healthNote", "")
            )
        if child.get("_briefingDmStatus") == "sent":
            notice += " Onboarding DM sent."
        elif child.get("_briefingDmStatus") == "server_auto_dm":
            notice += " Server auto-delivered mission DM."
        elif child.get("_briefingDmStatus") == "failed":
            notice += " Onboarding DM failed."
        _runtime = child.get("runtime", {}) or {}
        _runtime_project = _runtime.get("projectPath") or project_path
        if _runtime_project:
            notice += f" Working directory: {_runtime_project}."
        notice_result = send_message(notice, priority=1 if child.get("_verifyError") else 0)
        child["_frontendNotificationSent"] = bool(
            notice_result.get("status") == "sent" or notice_result.get("messageId")
        )
        if not child["_frontendNotificationSent"]:
            child["_frontendNotificationError"] = str(notice_result.get("error", "Unknown error"))

        return child
    return result


def stop_agent(target_agent: str) -> dict:
    """
    Request a specific agent to stop its current task.

    Args:
        target_agent: Name of the agent to stop

    Returns:
        dict with confirmation message on success, or error payload
    """
    payload = {"agentName": target_agent}
    return _api_request("POST", "/agent/stop", payload)


def self_terminate(reason: str = "Task complete", archive_messages: bool = True) -> dict:
    """
    Request this agent's own termination. Archives the agent and safely
    re-parents any children.

    Args:
        reason: Why the agent is terminating
        archive_messages: Whether to archive messages (default: True)

    Returns:
        dict with keys: success, archived, orphanedChildren, orphanAction
    """
    payload = {
        "reason": reason,
        "archiveMessages": archive_messages
    }
    return _api_request("POST", "/agent/self-terminate", payload)


def get_lineage() -> dict:
    """
    Get this agent's full family tree (ancestors and descendants).

    Returns:
        dict with keys: ancestors (list), descendants (list)
    """
    return _api_request("GET", "/agent/lineage")


def _wait_for_responses(poll_interval: int = 10, timeout: int = 0):
    global _last_read_time

    start_time = _last_read_time

    if not start_time:
        initial_check = _api_request("GET", _build_agent_responses_path())
        if initial_check.get("responses"):
            timestamps = [r.get("timestamp", "") for r in initial_check["responses"] if r.get("timestamp")]
            if timestamps:
                start_time = max(timestamps)
        _last_read_time = start_time

    start_wait = time.time()
    remaining_msg = f" (max {MAX_WAIT_BEFORE_RETURN}s before auto-return)" if MAX_WAIT_BEFORE_RETURN > 0 else ""
    print(f"Waiting for response(s)...{remaining_msg}")

    while True:
        elapsed = time.time() - start_wait

        path = _build_agent_responses_path(start_time)

        result = _api_request("GET", path)
        responses = []
        if result.get("responses"):
            responses = _decrypt_payload_items([r for r in result["responses"] if r.get("content") or r.get("freeResponse")])
            responses = _process_update_responses(responses)
        if responses:
            print(f"Received {len(responses)} response(s)")
            latest = max((r.get("timestamp", "") for r in responses), default="")
            if latest:
                _last_read_time = latest
            _save_state()
            return responses

        if timeout > 0 and elapsed > timeout:
            print("Timed out waiting for response.")
            _save_state()
            return "TIMEOUT"

        if MAX_WAIT_BEFORE_RETURN > 0 and elapsed > MAX_WAIT_BEFORE_RETURN:
            print(f"Approaching sandbox timeout limit ({MAX_WAIT_BEFORE_RETURN}s).")
            print("No new messages yet. Run 'wait' command to continue waiting.")
            _save_state()
            return "CONTINUE_WAITING"

        time.sleep(poll_interval)


def _get_summary_timestamp() -> str:
    try:
        path = _script_dir / "agent_state" / ".summary_state.json"
        if path.exists():
            with open(path, "r") as f:
                return json.load(f).get("summary_timestamp", "")
    except Exception:
        pass
    return ""

def _parse_ts(ts_str):
    from datetime import datetime, timezone
    if not ts_str:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        cleaned = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(cleaned)
    except Exception:
        return datetime.min.replace(tzinfo=timezone.utc)

def _format_msg(msg: dict, my_name: str) -> str:
    sender = msg.get("from", "unknown")
    msg_type = msg.get("type", "")
    ts = msg.get("timestamp", "unknown time")

    if msg_type in ("agent_message", "agent_question"):
        content = _decrypt_message(msg.get("content", ""))
        if sender.upper() == my_name:
            prefix = "[YOU]" if msg_type == "agent_message" else "[YOU asked]"
        else:
            prefix = f"[{sender}]"
        return f"{prefix} ({ts}) {content}"
    elif msg_type == "user_message":
        content = _decrypt_message(msg.get("content", ""))
        return f"[USER] ({ts}) {content}"
    elif msg_type == "user_response":
        selected = msg.get("selectedOption", "")
        free = msg.get("freeResponse", "")
        if selected and free:
            return f"[USER answered] ({ts}) {selected} - {free}"
        elif selected:
            return f"[USER answered] ({ts}) {selected}"
        elif free:
            return f"[USER answered] ({ts}) {free}"
    return ""

def _format_history_for_llm(history: dict, show_full: bool = False) -> str:
    if history.get("isNewAgent") or history.get("messageCount", 0) == 0:
        return "No previous conversation. This is a new session."

    # Caps prevent the prompt from exceeding the model's context window —
    # Codex/Claude otherwise hit "context_length_exceeded" trying to compact.
    CONTEXT_KEEP_FIRST = 5      # always show first N messages for orientation
    CONTEXT_MAX_TAIL = 25       # most recent N messages when no summary exists
    CONTEXT_MAX_MSG_CHARS = 2000  # per-message hard cap

    def _truncate(line: str) -> str:
        if len(line) <= CONTEXT_MAX_MSG_CHARS:
            return line
        omitted = len(line) - CONTEXT_MAX_MSG_CHARS
        return line[:CONTEXT_MAX_MSG_CHARS] + f"... [truncated, {omitted} chars omitted]"

    all_msgs = history.get("messages", [])
    total_msgs = len(all_msgs)
    my_name = Config.agent_name.upper()
    lines = [f"Conversation history ({total_msgs} messages):", ""]

    summary_ts = _get_summary_timestamp()

    if show_full:
        for msg in all_msgs:
            fmt = _format_msg(msg, my_name)
            if fmt: lines.append(fmt)
    elif summary_ts and total_msgs > CONTEXT_KEEP_FIRST:
        parsed_summary_ts = _parse_ts(summary_ts)
        first_n = all_msgs[:CONTEXT_KEEP_FIRST]
        after_summary = [m for m in all_msgs[CONTEXT_KEEP_FIRST:] if _parse_ts(m.get("timestamp", "")) > parsed_summary_ts]
        skipped = total_msgs - len(first_n) - len(after_summary)

        for msg in first_n:
            fmt = _format_msg(msg, my_name)
            if fmt: lines.append(_truncate(fmt))

        if skipped > 0:
            lines.append(f"\\n... [{skipped} messages compressed into summary, see agent_summary.md] ...\\n")

        for msg in after_summary:
            fmt = _format_msg(msg, my_name)
            if fmt: lines.append(_truncate(fmt))
    else:
        # No summary -> aggressively cap to fit the model context window.
        if total_msgs > CONTEXT_KEEP_FIRST + CONTEXT_MAX_TAIL:
            first_n = all_msgs[:CONTEXT_KEEP_FIRST]
            tail = all_msgs[-CONTEXT_MAX_TAIL:]
        else:
            first_n = []
            tail = all_msgs
        skipped = total_msgs - len(first_n) - len(tail)

        for msg in first_n:
            fmt = _format_msg(msg, my_name)
            if fmt: lines.append(_truncate(fmt))

        if skipped > 0:
            lines.append(f"\\n... [{skipped} older messages omitted to fit context window — run 'summarize' to preserve them] ...\\n")

        for msg in tail:
            fmt = _format_msg(msg, my_name)
            if fmt: lines.append(_truncate(fmt))

    if not summary_ts and not show_full:
        total_chars = sum(len(str(m.get("content", ""))) for m in all_msgs)
        estimated_tokens = total_chars // 4
        if estimated_tokens > 8000 or total_msgs >= 30:
            lines.append("\\n[SYSTEM] Conversation is getting long. Consider using 'summarize' to compress context. (e.g. uv run message_helper.py summarize \\"Your summary here\\")")

    return "\\n".join(lines)


def _format_responses_for_llm(responses: list, attachment_paths: dict = None) -> str:
    if not responses:
        return "No new messages."

    attachment_paths = attachment_paths or {}
    lines = []
    for r in responses:
        sender = r.get("from", "user")
        label = sender.upper() if sender else "USER"
        ts = r.get("timestamp", "unknown time")

        if r.get("content"):
            lines.append(f"[{label}] ({ts}) {r['content']}")
        elif r.get("selectedOption") or r.get("freeResponse"):
            selected = r.get("selectedOption", "")
            free = r.get("freeResponse", "")
            if selected and free:
                lines.append(f"[{label} answered] ({ts}) {selected} - {free}")
            elif selected:
                lines.append(f"[{label} answered] ({ts}) {selected}")
            elif free:
                lines.append(f"[{label} answered] ({ts}) {free}")
        
        # Add attachment info if present
        attachments = r.get("attachments", [])
        for att in attachments:
            att_id = att.get("attachmentId", "")
            content_type = att.get("contentType", "file")
            local_path = attachment_paths.get(att_id)
            if local_path:
                lines.append(f"[{label} attached {content_type}] ({ts}) Local file: {local_path}")
            else:
                lines.append(f"[{label} attached {content_type}] ({ts}) Attachment ID: {att_id}")

    return "\\n".join(lines) if lines else "No new messages."


def _print_spawn_usage(exit_code: int = 1):
    print("Usage: uv run message_helper.py spawn <childName> [instructions] [--provider <p>] [--model <m>] [--project-path <dir>] [--group <id-or-name>] [--no-inherit-groups] [--can-spawn]")
    sys.exit(exit_code)


def _is_valid_child_agent_name(name: str) -> bool:
    return isinstance(name, str) and bool(name.strip()) and not name.strip().startswith("-")


${hasEncryption ? `def main():
    if len(sys.argv) < 2:
        print("""Usage:
  uv run message_helper.py send <message> [--priority 0|1|2] [--attach <file-path>] [--attachment-id <id>] [--use-pending-attachments] [--rich-html] [--title <text>] [--description <text>]
  uv run message_helper.py ask <question> [--priority 0|1|2] [--timeout <seconds>]
  uv run message_helper.py wait [--timeout <seconds>]
  uv run message_helper.py check
  uv run message_helper.py sync
  uv run message_helper.py history [--full]
  uv run message_helper.py discover [--online]
  uv run message_helper.py dm <agentName> <message> [--priority 0|1|2] [--provider <p>] [--model <m>]
  uv run message_helper.py dm check [--from <agentName>]
  uv run message_helper.py set-model <agentName> [--provider <p>] [--model <m>]   (Chief of Staff only)
  uv run message_helper.py upload <file-path>
  uv run message_helper.py download <attachment-id> <save-path> --iv <iv-base64> --tag <tag-base64>

Agent Spawning:
  uv run message_helper.py spawn <childName> [instructions] [--provider <p>] [--model <m>] [--project-path <dir>] [--group <id-or-name>] [--no-inherit-groups] [--can-spawn]
  uv run message_helper.py stop <agentName>
  uv run message_helper.py self-terminate [reason]
  uv run message_helper.py lineage

Attachment Commands:
  upload    - Upload an encrypted file, returns attachment ID
  download  - Download and decrypt an attachment by ID
  send --attach - Upload and send a file in one command
  send --use-pending-attachments - Send with IDs staged by upload""")
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    priority = 0
    timeout = 0
    options = None
    attachment_path = None
    attachment_ids = []
    use_pending_attachments = False
    iv_base64 = None
    auth_tag_base64 = None
    rich_html_flag = False
    rich_title = None
    rich_description = None
    message_parts = []

    i = 0
    while i < len(args):
        if args[i] == "--priority" and i + 1 < len(args):
            priority = int(args[i + 1])
            i += 2
        elif args[i] == "--timeout" and i + 1 < len(args):
            timeout = int(args[i + 1])
            i += 2
        elif args[i] == "--options" and i + 1 < len(args):
            try:
                options = json.loads(args[i + 1])
            except json.JSONDecodeError as e:
                print(f"Error: Invalid JSON for --options: {e}")
                sys.exit(1)
            i += 2
        elif args[i] == "--attach" and i + 1 < len(args):
            attachment_path = args[i + 1]
            i += 2
        elif args[i] == "--attachment-id" and i + 1 < len(args):
            attachment_ids.append(args[i + 1])
            i += 2
        elif args[i] == "--use-pending-attachments":
            use_pending_attachments = True
            i += 1
        elif args[i] == "--iv" and i + 1 < len(args):
            iv_base64 = args[i + 1]
            i += 2
        elif args[i] == "--tag" and i + 1 < len(args):
            auth_tag_base64 = args[i + 1]
            i += 2
        elif args[i] in ("--rich-html", "--rich"):
            # Explicitly wrap the message content in a rich_html JSON envelope
            rich_html_flag = True
            i += 1
        elif args[i] == "--title" and i + 1 < len(args):
            rich_title = args[i + 1]
            i += 2
        elif args[i] == "--description" and i + 1 < len(args):
            rich_description = args[i + 1]
            i += 2
        elif args[i] in ("--provider", "--model", "--project-path", "--group") and i + 1 < len(args):
            # Spawn-specific flags; skip both flag and value so they don't pollute instructions text
            i += 2
        elif args[i] in ("--can-spawn", "--no-inherit-groups"):
            # Spawn-specific boolean flag
            i += 1
        else:
            message_parts.append(args[i])
            i += 1

    message = " ".join(message_parts) if message_parts else ""

    if command == "stop":
        if not message_parts:
            print("Error: Agent name is required")
            print("Usage: uv run message_helper.py stop <agentName>")
            sys.exit(1)
        target = message_parts[0]
        result = stop_agent(target)
        if result.get("message") and not result.get("error"):
            resolved_name = result.get("agentName", target)
            print("Stop requested for " + str(resolved_name))
            print("  " + str(result.get("message")))
        else:
            err = result.get("error", {})
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print("Stop request failed: " + msg)
            sys.exit(1)

    elif command == "send":
        if not message:
            print("Error: Message is required for send command")
            sys.exit(1)

        # If the agent passed --rich-html, or the message looks like raw HTML,
        # promote it to a rich_html JSON envelope so the dashboard renders it
        # as an interactive view rather than a plain-text blob.
        message = _maybe_promote_to_rich_html(
            message,
            force=rich_html_flag,
            title=rich_title,
            description=rich_description,
        )

        resolved_attachment_ids = []
        for att_id in attachment_ids:
            if isinstance(att_id, str):
                att_id = att_id.strip()
                if att_id:
                    resolved_attachment_ids.append(att_id)

        if attachment_path:
            # Upload the attachment first
            print(f"Uploading attachment: {attachment_path}")
            upload_result = upload_file(attachment_path)
            if "error" in upload_result:
                print(f"Failed to upload attachment: {upload_result['error']}")
                sys.exit(1)
            resolved_attachment_ids.append(upload_result["attachmentId"])
            print(f"Attachment uploaded: {upload_result['attachmentId']}")

        if use_pending_attachments:
            pending_ids = _load_pending_attachment_ids()
            if pending_ids:
                print(f"Using {len(pending_ids)} pending attachment(s)")
                resolved_attachment_ids.extend(pending_ids)

        if resolved_attachment_ids:
            deduped_ids = []
            seen_ids = set()
            for att_id in resolved_attachment_ids:
                if att_id not in seen_ids:
                    deduped_ids.append(att_id)
                    seen_ids.add(att_id)
            resolved_attachment_ids = deduped_ids

        result = send_message(
            message,
            priority=priority,
            attachment_ids=(resolved_attachment_ids if resolved_attachment_ids else None)
        )
        if result.get("status") == "sent" or result.get("messageId") or result.get("success"):
            print("Message sent successfully.")
        else:
            print(f"Failed to send: {result.get('error', 'Unknown error')}")

    elif command == "ask":
        if not message:
            print("Error: Question is required for ask command")
            sys.exit(1)
        responses = ask_question(message, options=options, priority=priority, timeout=timeout)
        if responses == "TIMEOUT":
            print("Timed out waiting for response")
            sys.exit(1)
        elif responses == "CONTINUE_WAITING":
            print("CONTINUE_WAITING")
            sys.exit(42)
        print(_format_responses_for_llm(responses))

    elif command == "wait":
        print("Continuing to wait for response...")
        responses = wait_for_response(timeout=timeout)
        if responses == "TIMEOUT":
            print("Timed out waiting for response")
            sys.exit(1)
        elif responses == "CONTINUE_WAITING":
            print("CONTINUE_WAITING")
            sys.exit(42)
        print(_format_responses_for_llm(responses))

    elif command == "check":
        messages = check_new_messages()
        print(_format_responses_for_llm(messages))

    elif command == "sync":
        history = get_message_history()
        messages = history.get("messages", [])
        if messages:
            latest = max((m.get("timestamp", "") for m in messages if m.get("timestamp")), default="")
            if latest:
                global _last_read_time
                _last_read_time = latest
                _save_state()
                print(f"Synced last_read_time to {latest}")
            else:
                print("No timestamps found in history.")
        else:
            print("No history messages to sync from.")

    elif command == "summarize":
        summary_text = " ".join(message_parts)
        if not summary_text:
            print("Error: Summary text required. Usage: uv run message_helper.py summarize \\"Your summary\\"")
            sys.exit(1)

        from datetime import datetime, timezone

        # Save to agent_summary.md (incremental append)
        summary_path = _script_dir / "agent_state" / "agent_summary.md"
        existing = ""
        if summary_path.exists():
            existing = summary_path.read_text().strip()

        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        new_section = f"\\n\\n---\\n## Summary Update ({now_str})\\n{summary_text}"

        if existing and not existing.startswith("# Agent Session Summary"):
            final = existing + new_section
        else:
            final = f"# Agent Context Summary{new_section}"

        with open(summary_path, "w") as f:
            f.write(final)

        # Use latest message timestamp instead of wall-clock
        history = get_message_history()
        msgs = history.get("messages", [])
        if msgs:
            latest_ts = max((m.get("timestamp", "") for m in msgs if m.get("timestamp")), default="")
        else:
            latest_ts = ""
        if not latest_ts:
            latest_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        # Save timestamp to .summary_state.json
        state_path = _script_dir / "agent_state" / ".summary_state.json"
        with open(state_path, "w") as f:
            json.dump({"summary_timestamp": latest_ts}, f)

        print("Summary updated successfully. Context pruned.")

    elif command == "history":
        history = get_message_history()
        show_full = "--full" in args
        print(_format_history_for_llm(history, show_full=show_full))

    elif command == "config":
        config = get_config()
        # Output as JSON for bash to parse
        print(json.dumps(config))

    elif command == "upload":
        if not message_parts:
            print("Error: File path is required for upload command")
            print("Usage: uv run message_helper.py upload <file-path>")
            sys.exit(1)
        image_path = message_parts[0]
        result = upload_file(image_path)
        if "attachmentId" in result:
            _add_pending_attachment_id(result["attachmentId"])
            print(f"Upload successful!")
            print(f"  Attachment ID: {result['attachmentId']}")
            print("  Staged for next send: yes")
            print(f"  Content Type: {result.get('contentType', 'unknown')}")
            print(f"  Size: {result.get('sizeBytes', 0)} bytes")
            if result.get("width") and result.get("height"):
                print(f"  Dimensions: {result['width']}x{result['height']}")
            # Output JSON for programmatic use
            print(f"\\nJSON: {json.dumps(result)}")
        else:
            print(f"Upload failed: {result.get('error', 'Unknown error')}")
            sys.exit(1)

    elif command == "download":
        if len(message_parts) < 2:
            print("Error: Attachment ID and save path are required")
            print("Usage: uv run message_helper.py download <attachment-id> <save-path> --iv <iv> --tag <tag>")
            sys.exit(1)
        if not iv_base64 or not auth_tag_base64:
            print("Error: --iv and --tag are required for download")
            print("Usage: uv run message_helper.py download <attachment-id> <save-path> --iv <iv> --tag <tag>")
            sys.exit(1)

        attachment_id = message_parts[0]
        save_path = message_parts[1]

        result = download_attachment(attachment_id, save_path, iv_base64, auth_tag_base64)
        if result.get("success"):
            print(f"Download successful!")
            print(f"  Saved to: {result['path']}")
            print(f"  Size: {result.get('sizeBytes', 0)} bytes")
        else:
            print(f"Download failed: {result.get('error', 'Unknown error')}")
            sys.exit(1)

    elif command == "check-attachments":
        # Check for new messages and download any attachments
        # Returns JSON with messages and downloaded attachment paths
        if len(message_parts) < 1:
            print("Error: Download directory is required")
            print("Usage: uv run message_helper.py check-attachments <download-dir>")
            sys.exit(1)
        
        download_dir = message_parts[0]
        messages = check_new_messages()
        
        # Debug: Show raw message count and attachment info
        print(f"[DEBUG] Found {len(messages)} message(s)", file=sys.stderr)
        for i, msg in enumerate(messages):
            attachments = msg.get("attachments", [])
            print(f"[DEBUG] Message {i}: from={msg.get('from')}, attachments={len(attachments)}", file=sys.stderr)
            for att in attachments:
                print(f"[DEBUG]   Attachment: id={att.get('attachmentId')}, type={att.get('contentType')}", file=sys.stderr)
                encryption = att.get("encryption", {})
                print(f"[DEBUG]   Encryption: iv={bool(encryption.get('ivBase64'))}, tag={bool(encryption.get('tagBase64'))}", file=sys.stderr)
        
        # Download all attachments from messages
        attachment_paths = {}
        for msg in messages:
            downloaded = download_message_attachments(msg, download_dir)
            for att in downloaded:
                if att.get("localPath"):
                    attachment_paths[att["attachmentId"]] = att["localPath"]
                    print(f"[DEBUG] Downloaded: {att['attachmentId']} -> {att['localPath']}", file=sys.stderr)
                elif att.get("error"):
                    print(f"[DEBUG] Download failed: {att['attachmentId']} - {att['error']}", file=sys.stderr)
        
        # Format for LLM with attachment paths
        formatted = _format_responses_for_llm(messages, attachment_paths)
        print(formatted)
        
        # Also output JSON for programmatic use if attachments were found
        if attachment_paths:
            print(f"\\n---ATTACHMENTS_JSON---")
            print(json.dumps(attachment_paths))

    elif command == "discover":
        online_only = "--online" in args
        result = discover_agents(online_only=online_only)
        agents = result.get("agents", [])
        my_mode = result.get("myInterAgentMode", "disabled")
        my_groups = result.get("myGroups", [])
        
        print(f"Your inter-agent mode: {my_mode}")
        if my_groups:
            print(f"Your groups: {', '.join(my_groups)}")
        print()
        
        if not agents:
            print("No other agents found to communicate with.")
        else:
            print(f"Found {len(agents)} agent(s) you can communicate with:")
            for agent in agents:
                status = "ONLINE" if agent.get("isOnline") else "offline"
                groups = agent.get("groups", [])
                group_str = f" (groups: {', '.join(groups)})" if groups else ""
                mode = agent.get("interAgentMode", "unknown")
                print(f"  - {agent.get('agentName')} ({agent.get('agentType', 'standard')}) [{status}] mode={mode}{group_str}")

    elif command == "dm":
        # dm <agent> <message> OR dm check [--from <agent>]
        if not args or args[0] == "check":
            # Check for DMs
            from_agent = None
            if "--from" in args:
                from_idx = args.index("--from")
                if from_idx + 1 < len(args):
                    from_agent = args[from_idx + 1]
            messages = check_dm(from_agent=from_agent)
            if not messages:
                print("No new messages from other agents.")
            else:
                print(f"Received {len(messages)} message(s):")
                for msg in messages:
                    sender = msg.get("fromAgent", msg.get("senderName", "Unknown"))
                    content = msg.get("content", "")
                    encrypted_marker = " [encrypted]" if msg.get("encrypted") else ""
                    print(f"  [{sender}]{encrypted_marker}: {content}")
        else:
            # Send DM: dm <agent> <message> [--provider <p>] [--model <m>]
            # --provider/--model are Chief of Staff only: they switch what the
            # target agent responds with BEFORE the DM is delivered.
            target = args[0]
            dm_provider = None
            dm_model = None
            msg_parts = []
            rest = list(args[1:])
            r = 0
            while r < len(rest):
                a = rest[r]
                if a == "--provider" and r + 1 < len(rest):
                    dm_provider = rest[r + 1]
                    r += 2
                elif a == "--model" and r + 1 < len(rest):
                    dm_model = rest[r + 1]
                    r += 2
                elif a == "--priority" and r + 1 < len(rest):
                    # already parsed globally; skip flag + value here
                    r += 2
                elif a.startswith("--"):
                    r += 1
                else:
                    msg_parts.append(a)
                    r += 1
            message = " ".join(msg_parts)
            if not message:
                print("Error: Message is required. Usage: dm <AgentName> <message> [--provider <p>] [--model <m>]")
                sys.exit(1)
            if dm_provider or dm_model:
                cfg_result = cos_set_agent_model(target, provider=dm_provider, model=dm_model)
                if cfg_result.get("success"):
                    cfg = cfg_result.get("config", {})
                    print(f"Model for {target}: {cfg.get('model_provider')}/{cfg.get('model')} (applies from their next task)")
                else:
                    err = cfg_result.get("error")
                    err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    print(f"Warning: could not set model for {target}: {err_msg} — sending the DM anyway")
            result = send_dm(target, message, priority=priority)
            if result.get("status") == "sent" or result.get("messageId"):
                print(f"DM sent to {target}")
            else:
                print(f"Failed to send DM: {result.get('error', 'Unknown error')}")

    elif command == "set-model":
        # set-model <agent> --provider <p> [--model <m>]  (Chief of Staff only)
        if not message_parts:
            print("Error: Agent name is required. Usage: set-model <AgentName> [--provider <p>] [--model <m>]")
            sys.exit(1)
        target = message_parts[0]
        sm_provider = None
        sm_model = None
        for idx, a in enumerate(sys.argv):
            if a == "--provider" and idx + 1 < len(sys.argv):
                sm_provider = sys.argv[idx + 1]
            elif a == "--model" and idx + 1 < len(sys.argv):
                sm_model = sys.argv[idx + 1]
        if not sm_provider and not sm_model:
            print("Error: --provider and/or --model is required")
            sys.exit(1)
        result = cos_set_agent_model(target, provider=sm_provider, model=sm_model)
        if result.get("success"):
            cfg = result.get("config", {})
            print(f"Model for {target}: {cfg.get('model_provider')}/{cfg.get('model')} (applies from their next task)")
        else:
            err = result.get("error")
            err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print(f"Failed to set model for {target}: {err_msg}")
            sys.exit(1)

    elif command == "spawn":
        if any(arg in ("--help", "-h") for arg in args):
            _print_spawn_usage(0)
        if not message_parts:
            print("Error: Child agent name is required")
            _print_spawn_usage(1)
        child_name = message_parts[0]
        if not _is_valid_child_agent_name(child_name):
            print("Error: Invalid child agent name. Names must not be empty or begin with '-'.")
            _print_spawn_usage(1)
        instructions = " ".join(message_parts[1:]) if len(message_parts) > 1 else ""
        provider_val = None
        model_val = None
        project_path_val = None
        can_spawn_val = "--can-spawn" in sys.argv
        group_vals = [] if "--no-inherit-groups" in sys.argv else None
        for idx, a in enumerate(sys.argv):
            if a == "--provider" and idx + 1 < len(sys.argv):
                provider_val = sys.argv[idx + 1]
            elif a == "--model" and idx + 1 < len(sys.argv):
                model_val = sys.argv[idx + 1]
            elif a == "--project-path" and idx + 1 < len(sys.argv):
                project_path_val = sys.argv[idx + 1]
            elif a == "--group" and idx + 1 < len(sys.argv):
                if group_vals is None:
                    group_vals = []
                group_vals.append(sys.argv[idx + 1])
        result = spawn_agent(
            child_name,
            instructions,
            model_provider=provider_val,
            model=model_val,
            project_path=project_path_val,
            can_spawn=can_spawn_val,
            groups=group_vals
        )
        if result.get("agentId"):
            print("Agent spawned successfully!")
            print("  Name: " + str(result.get('agentName')))
            print("  ID: " + str(result.get('agentId')))
            print("  Depth: " + str(result.get('spawnDepth')))
            print("  Parent: " + str(result.get('parentAgentId')))
            runtime = result.get("runtime", {}) if isinstance(result.get("runtime"), dict) else {}
            if runtime.get("sameMachineAsParent") is not None:
                print("  Same machine: " + ("yes" if runtime.get("sameMachineAsParent") else "no"))
            if runtime.get("projectPath"):
                print("  Project path: " + str(runtime.get("projectPath")))
            health = result.get("_healthNote", "")
            if health:
                print("  Health: " + health)
            dm_status = result.get("_briefingDmStatus")
            if dm_status:
                print("  Briefing DM: " + str(dm_status))
            dm_error = result.get("_briefingDmError")
            if dm_error:
                print("  Briefing DM error: " + str(dm_error))
            frontend_notice = result.get("_frontendNotificationSent")
            if frontend_notice is not None:
                print("  Frontend notice: " + ("sent" if frontend_notice else "failed"))
            frontend_error = result.get("_frontendNotificationError")
            if frontend_error:
                print("  Frontend notice error: " + str(frontend_error))
            log_file = result.get("logFile")
            if log_file:
                print("  Log: " + str(log_file))
            print("")
            print("JSON: " + json.dumps(result))
        else:
            err = result.get("error", {})
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print("Spawn failed: " + msg)
            sys.exit(1)

    elif command == "self-terminate":
        reason = " ".join(message_parts) if message_parts else "Task complete"
        result = self_terminate(reason=reason)
        if result.get("success"):
            print("Self-termination successful.")
            print("  Archived: " + str(result.get('archived')))
            print("  Orphaned children: " + str(result.get('orphanedChildren', 0)))
            print("  Orphan action: " + str(result.get('orphanAction', 'none')))
        else:
            print("Self-terminate failed: " + str(result.get('error', 'Unknown error')))
            sys.exit(1)

    elif command == "lineage":
        result = get_lineage()
        ancestors = result.get("ancestors", [])
        descendants = result.get("descendants", [])
        print("=== Agent Lineage ===")
        if ancestors:
            print("")
            print("Ancestors (" + str(len(ancestors)) + "):")
            for a in ancestors:
                indent = "  " * a.get('spawn_depth', 0)
                print("  " + indent + str(a.get('agent_name')) + " (depth " + str(a.get('spawn_depth', 0)) + ")")
        else:
            print("")
            print("No ancestors (this is a root agent)")
        if descendants:
            print("")
            print("Descendants (" + str(len(descendants)) + "):")
            for d in descendants:
                indent = "  " * d.get('spawn_depth', 0)
                print("  " + indent + str(d.get('agent_name')) + " (depth " + str(d.get('spawn_depth', 0)) + ")")
        else:
            print("")
            print("No descendants")

    else:
        print("Unknown command: " + command)
        sys.exit(1)


if __name__ == "__main__":
    main()` : `def _print_spawn_usage(exit_code: int = 1):
    print("Usage: uv run message_helper.py spawn <childName> [instructions] [--provider <p>] [--model <m>] [--project-path <dir>] [--group <id-or-name>] [--no-inherit-groups] [--can-spawn]")
    sys.exit(exit_code)


def _is_valid_child_agent_name(name: str) -> bool:
    return isinstance(name, str) and bool(name.strip()) and not name.strip().startswith("-")


def main():
    if len(sys.argv) < 2:
        print("""Usage:
  uv run message_helper.py send <message> [--priority 0|1|2] [--json] [--rich-html] [--title <text>] [--description <text>]
  uv run message_helper.py ask <question> [--priority 0|1|2] [--timeout <seconds>]
  uv run message_helper.py wait [--timeout <seconds>]
  uv run message_helper.py check
  uv run message_helper.py sync
  uv run message_helper.py history [--full]
  uv run message_helper.py discover [--online]
  uv run message_helper.py dm <agentName> <message> [--priority 0|1|2] [--provider <p>] [--model <m>]
  uv run message_helper.py dm check [--from <agentName>]
  uv run message_helper.py set-model <agentName> [--provider <p>] [--model <m>]   (Chief of Staff only)

Agent Spawning:
  uv run message_helper.py spawn <childName> [instructions] [--provider <p>] [--model <m>] [--project-path <dir>] [--group <id-or-name>] [--no-inherit-groups] [--can-spawn]
  uv run message_helper.py stop <agentName>
  uv run message_helper.py self-terminate [reason]
  uv run message_helper.py lineage""")
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    priority = 0
    timeout = 0
    options = None
    is_json = False
    rich_html_flag = False
    rich_title = None
    rich_description = None
    message_parts = []

    i = 0
    while i < len(args):
        if args[i] == "--priority" and i + 1 < len(args):
            priority = int(args[i + 1])
            i += 2
        elif args[i] == "--timeout" and i + 1 < len(args):
            timeout = int(args[i + 1])
            i += 2
        elif args[i] == "--options" and i + 1 < len(args):
            try:
                options = json.loads(args[i + 1])
            except json.JSONDecodeError as e:
                print(f"Error: Invalid JSON for --options: {e}")
                sys.exit(1)
            i += 2
        elif args[i] in ("--provider", "--model", "--project-path", "--group") and i + 1 < len(args):
            # Spawn-specific flags; skip both flag and value so they don't pollute instructions text
            i += 2
        elif args[i] in ("--can-spawn", "--no-inherit-groups"):
            # Spawn-specific boolean flag
            i += 1
        elif args[i] == "--json":
            is_json = True
            i += 1
        elif args[i] in ("--rich-html", "--rich"):
            rich_html_flag = True
            i += 1
        elif args[i] == "--title" and i + 1 < len(args):
            rich_title = args[i + 1]
            i += 2
        elif args[i] == "--description" and i + 1 < len(args):
            rich_description = args[i + 1]
            i += 2
        else:
            message_parts.append(args[i])
            i += 1

    message = " ".join(message_parts) if message_parts else ""

    if command == "stop":
        if not message_parts:
            print("Error: Agent name is required")
            print("Usage: uv run message_helper.py stop <agentName>")
            sys.exit(1)
        target = message_parts[0]
        result = stop_agent(target)
        if result.get("message") and not result.get("error"):
            resolved_name = result.get("agentName", target)
            print("Stop requested for " + str(resolved_name))
            print("  " + str(result.get("message")))
        else:
            err = result.get("error", {})
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print("Stop request failed: " + msg)
            sys.exit(1)

    elif command == "send":
        if not message:
            print("Error: Message is required for send command")
            sys.exit(1)

        # If --json flag is used, validate JSON and use as-is
        if is_json:
            try:
                # Validate that it's valid JSON
                json.loads(message)
            except json.JSONDecodeError as e:
                print(f"Error: Invalid JSON message: {e}")
                sys.exit(1)

        # Promote raw HTML / --rich-html content into a rich_html JSON envelope
        # so the dashboard renders it as interactive rather than plain text.
        message = _maybe_promote_to_rich_html(
            message,
            force=rich_html_flag,
            title=rich_title,
            description=rich_description,
        )

        result = send_message(message, priority=priority)
        if result.get("status") == "sent" or result.get("messageId") or result.get("success"):
            print("Message sent successfully.")
        else:
            print(f"Failed to send: {result.get('error', 'Unknown error')}")

    elif command == "ask":
        if not message:
            print("Error: Question is required for ask command")
            sys.exit(1)
        responses = ask_question(message, options=options, priority=priority, timeout=timeout)
        if responses == "TIMEOUT":
            print("Timed out waiting for response")
            sys.exit(1)
        elif responses == "CONTINUE_WAITING":
            print("CONTINUE_WAITING")
            sys.exit(42)
        print(_format_responses_for_llm(responses))

    elif command == "wait":
        print("Continuing to wait for response...")
        responses = wait_for_response(timeout=timeout)
        if responses == "TIMEOUT":
            print("Timed out waiting for response")
            sys.exit(1)
        elif responses == "CONTINUE_WAITING":
            print("CONTINUE_WAITING")
            sys.exit(42)
        print(_format_responses_for_llm(responses))

    elif command == "check":
        messages = check_new_messages()
        print(_format_responses_for_llm(messages))

    elif command == "sync":
        history = get_message_history()
        messages = history.get("messages", [])
        if messages:
            latest = max((m.get("timestamp", "") for m in messages if m.get("timestamp")), default="")
            if latest:
                global _last_read_time
                _last_read_time = latest
                _save_state()
                print(f"Synced last_read_time to {latest}")
            else:
                print("No timestamps found in history.")
        else:
            print("No history messages to sync from.")

    elif command == "summarize":
        summary_text = " ".join(message_parts)
        if not summary_text:
            print("Error: Summary text required. Usage: uv run message_helper.py summarize \\"Your summary\\"")
            sys.exit(1)

        from datetime import datetime, timezone

        # Save to agent_summary.md (incremental append)
        summary_path = _script_dir / "agent_state" / "agent_summary.md"
        existing = ""
        if summary_path.exists():
            existing = summary_path.read_text().strip()

        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        new_section = f"\\n\\n---\\n## Summary Update ({now_str})\\n{summary_text}"

        if existing and not existing.startswith("# Agent Session Summary"):
            final = existing + new_section
        else:
            final = f"# Agent Context Summary{new_section}"

        with open(summary_path, "w") as f:
            f.write(final)

        # Use latest message timestamp instead of wall-clock
        history = get_message_history()
        msgs = history.get("messages", [])
        if msgs:
            latest_ts = max((m.get("timestamp", "") for m in msgs if m.get("timestamp")), default="")
        else:
            latest_ts = ""
        if not latest_ts:
            latest_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        # Save timestamp to .summary_state.json
        state_path = _script_dir / "agent_state" / ".summary_state.json"
        with open(state_path, "w") as f:
            json.dump({"summary_timestamp": latest_ts}, f)

        print("Summary updated successfully. Context pruned.")

    elif command == "history":
        history = get_message_history()
        show_full = "--full" in args
        print(_format_history_for_llm(history, show_full=show_full))

    elif command == "config":
        config = get_config()
        # Output as JSON for bash to parse
        print(json.dumps(config))

    elif command == "discover":
        online_only = "--online" in args
        result = discover_agents(online_only=online_only)
        agents = result.get("agents", [])
        my_mode = result.get("myInterAgentMode", "disabled")
        my_groups = result.get("myGroups", [])
        
        print(f"Your inter-agent mode: {my_mode}")
        if my_groups:
            print(f"Your groups: {', '.join(my_groups)}")
        print()
        
        if not agents:
            print("No other agents found to communicate with.")
        else:
            print(f"Found {len(agents)} agent(s) you can communicate with:")
            for agent in agents:
                status = "ONLINE" if agent.get("isOnline") else "offline"
                groups = agent.get("groups", [])
                group_str = f" (groups: {', '.join(groups)})" if groups else ""
                mode = agent.get("interAgentMode", "unknown")
                print(f"  - {agent.get('agentName')} ({agent.get('agentType', 'standard')}) [{status}] mode={mode}{group_str}")

    elif command == "dm":
        # dm <agent> <message> OR dm check [--from <agent>]
        if not args or args[0] == "check":
            # Check for DMs
            from_agent = None
            if "--from" in args:
                from_idx = args.index("--from")
                if from_idx + 1 < len(args):
                    from_agent = args[from_idx + 1]
            messages = check_dm(from_agent=from_agent)
            if not messages:
                print("No new messages from other agents.")
            else:
                print(f"Received {len(messages)} message(s):")
                for msg in messages:
                    sender = msg.get("fromAgent", msg.get("senderName", "Unknown"))
                    content = msg.get("content", "")
                    encrypted_marker = " [encrypted]" if msg.get("encrypted") else ""
                    print(f"  [{sender}]{encrypted_marker}: {content}")
        else:
            # Send DM: dm <agent> <message> [--provider <p>] [--model <m>]
            # --provider/--model are Chief of Staff only: they switch what the
            # target agent responds with BEFORE the DM is delivered.
            target = args[0]
            dm_provider = None
            dm_model = None
            msg_parts = []
            rest = list(args[1:])
            r = 0
            while r < len(rest):
                a = rest[r]
                if a == "--provider" and r + 1 < len(rest):
                    dm_provider = rest[r + 1]
                    r += 2
                elif a == "--model" and r + 1 < len(rest):
                    dm_model = rest[r + 1]
                    r += 2
                elif a == "--priority" and r + 1 < len(rest):
                    # already parsed globally; skip flag + value here
                    r += 2
                elif a.startswith("--"):
                    r += 1
                else:
                    msg_parts.append(a)
                    r += 1
            message = " ".join(msg_parts)
            if not message:
                print("Error: Message is required. Usage: dm <AgentName> <message> [--provider <p>] [--model <m>]")
                sys.exit(1)
            if dm_provider or dm_model:
                cfg_result = cos_set_agent_model(target, provider=dm_provider, model=dm_model)
                if cfg_result.get("success"):
                    cfg = cfg_result.get("config", {})
                    print(f"Model for {target}: {cfg.get('model_provider')}/{cfg.get('model')} (applies from their next task)")
                else:
                    err = cfg_result.get("error")
                    err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
                    print(f"Warning: could not set model for {target}: {err_msg} — sending the DM anyway")
            result = send_dm(target, message, priority=priority)
            if result.get("status") == "sent" or result.get("messageId"):
                print(f"DM sent to {target}")
            else:
                print(f"Failed to send DM: {result.get('error', 'Unknown error')}")

    elif command == "set-model":
        # set-model <agent> --provider <p> [--model <m>]  (Chief of Staff only)
        if not message_parts:
            print("Error: Agent name is required. Usage: set-model <AgentName> [--provider <p>] [--model <m>]")
            sys.exit(1)
        target = message_parts[0]
        sm_provider = None
        sm_model = None
        for idx, a in enumerate(sys.argv):
            if a == "--provider" and idx + 1 < len(sys.argv):
                sm_provider = sys.argv[idx + 1]
            elif a == "--model" and idx + 1 < len(sys.argv):
                sm_model = sys.argv[idx + 1]
        if not sm_provider and not sm_model:
            print("Error: --provider and/or --model is required")
            sys.exit(1)
        result = cos_set_agent_model(target, provider=sm_provider, model=sm_model)
        if result.get("success"):
            cfg = result.get("config", {})
            print(f"Model for {target}: {cfg.get('model_provider')}/{cfg.get('model')} (applies from their next task)")
        else:
            err = result.get("error")
            err_msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print(f"Failed to set model for {target}: {err_msg}")
            sys.exit(1)

    elif command == "spawn":
        if any(arg in ("--help", "-h") for arg in args):
            _print_spawn_usage(0)
        if not message_parts:
            print("Error: Child agent name is required")
            _print_spawn_usage(1)
        child_name = message_parts[0]
        if not _is_valid_child_agent_name(child_name):
            print("Error: Invalid child agent name. Names must not be empty or begin with '-'.")
            _print_spawn_usage(1)
        instructions = " ".join(message_parts[1:]) if len(message_parts) > 1 else ""
        provider_val = None
        model_val = None
        project_path_val = None
        can_spawn_val = "--can-spawn" in sys.argv
        group_vals = [] if "--no-inherit-groups" in sys.argv else None
        for idx, a in enumerate(sys.argv):
            if a == "--provider" and idx + 1 < len(sys.argv):
                provider_val = sys.argv[idx + 1]
            elif a == "--model" and idx + 1 < len(sys.argv):
                model_val = sys.argv[idx + 1]
            elif a == "--project-path" and idx + 1 < len(sys.argv):
                project_path_val = sys.argv[idx + 1]
            elif a == "--group" and idx + 1 < len(sys.argv):
                if group_vals is None:
                    group_vals = []
                group_vals.append(sys.argv[idx + 1])
        result = spawn_agent(
            child_name,
            instructions,
            model_provider=provider_val,
            model=model_val,
            project_path=project_path_val,
            can_spawn=can_spawn_val,
            groups=group_vals
        )
        if result.get("agentId"):
            print("Agent spawned successfully!")
            print("  Name: " + str(result.get('agentName')))
            print("  ID: " + str(result.get('agentId')))
            print("  Depth: " + str(result.get('spawnDepth')))
            print("  Parent: " + str(result.get('parentAgentId')))
            runtime = result.get("runtime", {}) if isinstance(result.get("runtime"), dict) else {}
            if runtime.get("sameMachineAsParent") is not None:
                print("  Same machine: " + ("yes" if runtime.get("sameMachineAsParent") else "no"))
            if runtime.get("projectPath"):
                print("  Project path: " + str(runtime.get("projectPath")))
            health = result.get("_healthNote", "")
            if health:
                print("  Health: " + health)
            dm_status = result.get("_briefingDmStatus")
            if dm_status:
                print("  Briefing DM: " + str(dm_status))
            dm_error = result.get("_briefingDmError")
            if dm_error:
                print("  Briefing DM error: " + str(dm_error))
            frontend_notice = result.get("_frontendNotificationSent")
            if frontend_notice is not None:
                print("  Frontend notice: " + ("sent" if frontend_notice else "failed"))
            frontend_error = result.get("_frontendNotificationError")
            if frontend_error:
                print("  Frontend notice error: " + str(frontend_error))
            log_file = result.get("logFile")
            if log_file:
                print("  Log: " + str(log_file))
            print("")
            print("JSON: " + json.dumps(result))
        else:
            err = result.get("error", {})
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            print("Spawn failed: " + msg)
            sys.exit(1)

    elif command == "self-terminate":
        reason = " ".join(message_parts) if message_parts else "Task complete"
        result = self_terminate(reason=reason)
        if result.get("success"):
            print("Self-termination successful.")
            print("  Archived: " + str(result.get('archived')))
            print("  Orphaned children: " + str(result.get('orphanedChildren', 0)))
            print("  Orphan action: " + str(result.get('orphanAction', 'none')))
        else:
            print("Self-terminate failed: " + str(result.get('error', 'Unknown error')))
            sys.exit(1)

    elif command == "lineage":
        result = get_lineage()
        ancestors = result.get("ancestors", [])
        descendants = result.get("descendants", [])
        print("=== Agent Lineage ===")
        if ancestors:
            print("")
            print("Ancestors (" + str(len(ancestors)) + "):")
            for a in ancestors:
                indent = "  " * a.get('spawn_depth', 0)
                print("  " + indent + str(a.get('agent_name')) + " (depth " + str(a.get('spawn_depth', 0)) + ")")
        else:
            print("")
            print("No ancestors (this is a root agent)")
        if descendants:
            print("")
            print("Descendants (" + str(len(descendants)) + "):")
            for d in descendants:
                indent = "  " * d.get('spawn_depth', 0)
                print("  " + indent + str(d.get('agent_name')) + " (depth " + str(d.get('spawn_depth', 0)) + ")")
        else:
            print("")
            print("No descendants")

    else:
        print("Unknown command: " + command)
        sys.exit(1)


if __name__ == "__main__":
    main()`}`;
}

/**
 * Generate orchestrator template markdown to append to agent instructions
 */
function generateOrchestratorTemplate() {
    return `

---

## Your Role: Agent Orchestrator

You are the **Orchestrator** — a council manager agent. Your purpose is to help the user
set up and coordinate a team of specialized AI agents.

### How You Work
1. **Discover** — Talk to the user to understand their needs (business, personal, project)
2. **Plan** — Propose a team of agents, each with a clear role and instructions
3. **Deploy** — Once the user approves, spawn each agent with detailed instructions
4. **Coordinate** — Monitor agents, relay info between them, and manage the council

### Spawning Agents
Use the \\\`spawn\\\` command documented above to create new agents:

\\\`\\\`\\\`bash
# Create a specialized agent with clear instructions
uv run message_helper.py spawn "researcher" "Your role is to research market trends and summarize findings weekly"

# For sub-coordinators only (rarely needed)
uv run message_helper.py spawn "team-lead" "Manage the development team" --can-spawn
\\\`\\\`\\\`

**Key Principles:**
- Give each agent **clear, specific instructions** about their role and responsibilities
- Use \\\`--can-spawn\\\` **only** for sub-coordinators (agents that will manage other agents)
- After spawning, verify health: check for "Agent loop started" in the output
- Send initial briefing messages to new agents using \\\`dm\\\` command

### Inter-Agent Coordination
Use the commands documented above to manage your team:

\\\`\\\`\\\`bash
# See all available agents
uv run message_helper.py discover

# Check which agents are currently online
uv run message_helper.py discover --online

# Send instructions to a specific agent
uv run message_helper.py dm "researcher" "Please compile a report on Q1 trends"

# Check for responses from agents
uv run message_helper.py dm check
\\\`\\\`\\\`

### Example Agent Teams

**Company Use Cases:**
- **PR-manager** — Monitor social media, draft responses, manage public communications
- **Coder** — Review pull requests, write code, run tests
- **Legal-reviewer** — Check contracts, flag legal concerns, ensure compliance
- **Project-manager** — Track milestones, coordinate tasks, report status

**Personal Use Cases:**
- **Morning-briefer** — Compile daily news, weather, calendar, and priorities
- **Family-trip-planner** — Research destinations, find deals, create itineraries
- **Gift-finder** — Track important dates, suggest gift ideas, manage shopping lists
- **Budget-tracker** — Monitor expenses, categorize spending, alert on budget limits

**Project Use Cases:**
- **Researcher** — Gather information, fact-check, compile sources
- **Writer** — Draft content, edit, maintain style consistency
- **Reviewer** — Quality check, provide feedback, suggest improvements
- **Publisher** — Format content, schedule posts, track distribution

### Ongoing Management
- You can be activated later to create more agents, remove existing ones, or reassign tasks
- Use \\\`discover\\\` to see all active agents, \\\`dm\\\` to communicate with them
- To remove an agent: send it a \\\`dm\\\` instructing it to use \\\`self-terminate "reason"\\\`
- Periodically check in on agents and report status to the user
- Post regular updates to the News Feed so the user can see team activity

### First Conversation
**Start by asking the user what they need help with.** Be conversational and curious.
Examples:
- "What kind of tasks would you like help with?"
- "Are you working on a personal project, business, or something else?"
- "What takes up most of your time that could be delegated to agents?"

**Before spawning any agents:**
1. Propose a team structure with specific roles
2. Explain what each agent will do
3. Get explicit user approval
4. Then spawn agents one by one, verifying each is healthy

Remember: You're building a **long-term team**. Quality and clarity matter more than speed.`;
}

/**
 * Generate agent instructions markdown
 */
function generateAgentInstructions(agentTemplate = 'blank') {
    const baseInstructions = `# Agent Communication Instructions

You are an AI agent that communicates with a human ONLY through the messaging API.
You never talk directly to the human - all communication goes through CLI commands.

## CRITICAL: Avoid A2A Confirmation Loops (Ping-Pong)

When using inter-agent (A2A) communication (DMs), do **NOT** get stuck in a loop of acknowledgements.

Follow these rules strictly:
- Do **not** respond to an agent DM if your reply would only be a confirmation (e.g., "ok", "ack", "received", "thanks", "done", "sounds good") and adds **no new information**.
- If you receive a confirmation-only message, treat it as terminal and **do not reply**.
- Only send A2A messages when you have at least one of:
  - A new fact/finding/result
  - A decision you made (and why)
  - A concrete blocker + a specific question
  - A deliverable (file path, command, link, output snippet)
- Prefer **one** compact progress update over many small ones.

Loop-break procedure (if a loop starts anyway):
1) Send exactly one final message that breaks the loop, e.g.:
   "Stopping replies to avoid an acknowledgement loop. Reply only if you have new data or a question."
2) Stop sending messages until you have new information or a direct question arrives.

## Available Commands

Use \`uv run message_helper.py\` with these commands:

\`\`\`bash
# Check for new messages (do this FIRST)
uv run message_helper.py check

# Get message history (do this on startup)
uv run message_helper.py history

# Send a message (does not wait for response)
uv run message_helper.py send "Your message here"
uv run message_helper.py send "Urgent message!" --priority 2

# Ask a question and wait for response
uv run message_helper.py ask "What should I do next?"

# Continue waiting after CONTINUE_WAITING
uv run message_helper.py wait
\`\`\`

## Priority Levels
- 0 = Normal (default)
- 1 = Needs Attention
- 2 = Urgent

## Timeout Handling
Commands auto-return after ~90 seconds to avoid sandbox timeouts.
If you get **CONTINUE_WAITING**, run the \`wait\` command to keep waiting.

## Self-Update Flow
- During \`check\` / \`wait\`, the backend may send a system message that an update is available.
- When that appears, ask the user for explicit approval before updating.
- The user can approve by replying: \`confirm update\` (or equivalent approval phrase).
- After approval, the helper applies the queued update automatically (if writable) and returns a system status line.
- If update application fails, report the error to the user and continue operating with current files.

## Advanced Skills

You have optional skill documentation available in this directory. Read these files when you need the capability:

- **SKILL_RICH_FORMS.md** - Send interactive HTML forms and visual reports to the user (weather dashboards, status reports, surveys, settings). Read this file for full documentation and examples.
- **SELF_WAKE_GUIDE.md** - Schedule future wake-ups or trigger a wake when a local task finishes. Read only if you need self-wake behavior.

## Rich HTML Views

To send visual dashboards, reports, forms, or interactive HTML to the user, read **SKILL_RICH_FORMS.md** in this directory for full docs and examples.
Do not invent or copy a placeholder JSON object. If you do not have real HTML content ready, send a normal text reply instead.

## IMPORTANT: How to Execute Commands

You communicate by running shell commands directly. Use your bash/shell execution to run:
\\\`\\\`\\\`bash
uv run message_helper.py send "your message"
\\\`\\\`\\\`
Do NOT try to use tools like \\\`run_shell_command\\\`, \\\`delegate_to_agent\\\`, or any MCP-style tool calls.
You run commands directly in your shell.

## Agent Spawning (Creating New Agents)

You can create new independent child agents that get their own chat thread in the dashboard UI.
Each spawned agent runs autonomously with its own folder, memory, and state.

### IMPORTANT: Use the spawn command — do NOT create local scripts
When asked to create a new agent, you MUST use the \\\`spawn\\\` command below.
Do NOT create local Python scripts, local agent loops, or any local-only agent.
Local-only agents will NOT appear in the dashboard UI and the user will not be able to interact with them.

### Spawn a New Agent
\\\`\\\`\\\`bash
# Basic: create a child agent with instructions
uv run message_helper.py spawn "my-helper-agent" "Your task is to research X and report findings"

# With specific provider/model
uv run message_helper.py spawn "code-reviewer" "Review all PRs for security issues" --provider claude --model claude-sonnet-5-5

# Gemini models through the installed Antigravity CLI (agy)
uv run message_helper.py spawn "gemini-reviewer" "Review the UI" --provider antigravity --model gemini-3.8-flash

# With an explicit working directory on this same machine
uv run message_helper.py spawn "repo-worker" "Implement and test issue #42" --project-path /path/to/repo

# Recommended: omit --group to inherit all of the creating agent's groups.
# Override with one or more group IDs/names, or opt out explicitly.
uv run message_helper.py spawn "researcher" "Research the topic" --group Research
uv run message_helper.py spawn "isolated-worker" "Work without group access" --no-inherit-groups
\\\`\\\`\\\`

The \\\`spawn\\\` command automatically:
- Sends a frontend-visible status message in your chat confirming creation
- Sends a structured onboarding DM from parent → child with the mission details
- Prints JSON output with health metadata
- Runs the child on the same machine as the parent agent (not a remote worker)
- Keeps child/user and agent/agent traffic encrypted with the same account password+salt

### IMPORTANT: Do NOT use --can-spawn unless explicitly requested
The \\\`--can-spawn\\\` flag lets the child create its own children. Only use it when:
- The user explicitly asks for a coordinator/manager agent
- You need a multi-level agent hierarchy
Default: children CANNOT spawn further children (safer).

\\\`\\\`\\\`bash
# Only when explicitly needed:
uv run message_helper.py spawn "coordinator" "Manage the team of sub-agents" --can-spawn
\\\`\\\`\\\`

### After Spawning: Verify the Child is Healthy
Always check the spawn output for the "Health" line:
- \\\`Health: Agent loop started (PID ...)\\\` — child is running
- \\\`Health: WARNING: Agent loop did NOT start\\\` — something is wrong, check the log file

Also verify the JSON output contains an \\\`agentId\\\` and check:
- \\\`Briefing DM: sent\\\` (child received onboarding instructions)
- \\\`Frontend notice: sent\\\` (user can see spawn status in the parent chat)

If the child fails to start, check its log file (printed in the spawn output).
Do NOT tell the user the agent is ready until you see confirmation it started.

### Communicate with the Spawned Agent
Use DMs to send messages to other agents:
\\\`\\\`\\\`bash
uv run message_helper.py dm "AgentName" "Your instructions here"
uv run message_helper.py dm check                    # Check for replies
uv run message_helper.py dm check --from "AgentName" # From specific agent
\\\`\\\`\\\`

### Self-Terminate (when your task is done)
\\\`\\\`\\\`bash
uv run message_helper.py self-terminate "Task complete - report delivered"
\\\`\\\`\\\`

### Check Your Lineage (parent/child tree)
\\\`\\\`\\\`bash
uv run message_helper.py lineage
\\\`\\\`\\\`

### Spawn Rules
- Max depth: 3 levels (root → child → grandchild → great-grandchild)
- Max 10 children per agent
- Max 75 total agents per user
- Cooldown: 1 spawn per minute per agent
- Child inherits your model/provider config unless overridden
- Child inherits all of your groups by default (recommended)
- Use repeatable \`--group <id-or-name>\` to choose groups, or \`--no-inherit-groups\` for none
- Child inherits your permission ceiling (cannot exceed your permissions)
- Child inherits your working directory unless you pass \\\`--project-path\\\`
- Child listens to user + DM traffic by polling chatmcp.space API in its own loop

## First Action
1. Run \`history\` to check for existing context
2. Run \`send "Hello! I am ready."\` to introduce yourself
3. When a user asks for work, reply in the agent chat. Do not replace that reply with a news-feed post.

## News Feed Announcements (Activity Logging)
This is secondary to the normal agent chat reply. Use it only as an additional log entry:

\`\`\`bash
uv run message_helper.py send '{
  "type": "news_announcement",
  "agent": "YourName",
  "context": "/current/working/dir",
  "status": "Completed",
  "summary": "Short summary of what you did"
}'
\`\`\`

Supported status values: \`Completed\`, \`Running\`, \`Failed\`, \`Info\`.
DO NOT use markdown formatting like \`**Agent:**\` inside the JSON.
Using JSON ensures your announcement is styled correctly in the dashboard.
The news feed does not replace a required user-facing reply in the agent chat.

## Waiting for Instructions
After introduction, run \`ask "What would you like me to do?"\` to wait for instructions.
If you get CONTINUE_WAITING, run \`wait\` to keep waiting.`;

    // Append orchestrator template if requested
    if (agentTemplate === 'orchestrator') {
        return baseInstructions + generateOrchestratorTemplate();
    }

    return baseInstructions;
}

/**
 * Generate news feed agent instructions markdown (simplified, fire-and-forget)
 */
function generateNewsFeedAgentInstructions() {
    return `# News Feed - Activity Logging

This is a **fire-and-forget notification channel**. Agents post execution summaries here.

## Send a Status Update

Use this command to post an update. It returns immediately - do NOT wait for responses.

\`\`\`bash
uv run message_helper.py send "Your status update here"
uv run message_helper.py send "Important update!" --priority 1
\`\`\`

## Priority Levels
- 0 = Normal (default)
- 1 = Needs Attention  
- 2 = Urgent

## Important Rules
- **DO NOT** use \`ask\`, \`wait\`, \`check\`, or \`history\` commands with this agent
- This is a **one-way notification** - no responses are expected
- After sending your update, continue with your original task or exit
- The \`send\` command returns immediately after posting`;
}

// ─── Local Chief of Staff ──────────────────────────────────────────────────
//
// The Local Chief of Staff (CoS) is a privileged default agent the user can
// install from the dashboard or from the CLI. It manages the user's roster:
// spawn / delete / edit other agents on the user's behalf, maintain a live
// picture of each agent, and act on its own initiative via heartbeat ticks.
//
// "Local" is important: the agent process runs on the user's own machine
// (via agent-runner.sh inside a tmux session) and any child agents it
// spawns are created as folders on THAT SAME local machine. It is not a
// hosted/cloud agent. It can message agents on other machines via the
// platform API, but the agent runtime and any new agent folders live
// locally.
//
// Its DB row has is_chief_of_staff = TRUE, which unlocks /api/agent/cos/*
// endpoints.

const CHIEF_OF_STAFF_DEFAULT_NAME = 'Local Chief of Staff';

function generateChiefOfStaffInstructions({ userName = null, apiBase = 'http://localhost:3000/api' } = {}) {
    const greeting = userName ? `the user (${userName})` : 'the user';
    const base = generateAgentInstructions();
    const cosBlock = `# Agent: ${CHIEF_OF_STAFF_DEFAULT_NAME}

> You are the **Local Chief of Staff** — a privileged agent that helps
> ${greeting} run their multi-agent setup. You run locally on the user's
> own machine. You can spawn, delete, and edit other agents via the
> \`/api/agent/cos/*\` endpoints. Any new agents you spawn live as folders
> on this same local machine; you can also message remote agents (running
> on other machines) via the platform messaging API. You are the single,
> trusted point of contact between the user and the rest of the team.

## Your Mission

1. **Be the user's right hand.** They talk to you, you talk to the team.
   When they say "build me an X agent that does Y", you spawn it, brief it,
   and report back. When they ask "what is everyone doing?", you produce a
   roster digest.
2. **Maintain a live roster.** Keep \`agent_state/roster.json\` fresh: every
   agent's name, role, current state (working / idle / stopped), last
   activity, parent, and a one-line description of what they do. Refresh on
   every mutation and on every heartbeat tick.
3. **Improve over time.** If an agent keeps failing the same way, propose a
   change to its instructions and (with the user's OK) apply it via
   \`PATCH /api/agent/cos/agents/:id/instructions\`. If an agent has
   nothing to do, ask the user before deleting it.
4. **Schedule yourself** for low-volume background work — only if the user
   opts in. See "Heartbeat" below.

## Privileged endpoints

All require \`X-API-Key\` plus \`X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}\`.
Base URL: \`${apiBase}\`.

### Roster
\`\`\`bash
curl -s -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     ${apiBase}/agent/cos/roster
\`\`\`
Returns \`{ agents: [...] }\`. Cache to \`agent_state/roster.json\`.

### Spawn a sub-agent
\`\`\`bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "name": "research-agent",
            "role": "Scrape and summarize web pages",
            "initialInstructions": "You are…",
            "runtimeConfig": { "model_provider": "antigravity", "model": "gemini-3.8-flash" },
            "groups": ["Research"] }' \\
     ${apiBase}/agent/cos/spawn-child
\`\`\`
Omit \`groups\` to inherit the Chief of Staff's groups (recommended). Pass group
IDs/names to choose explicitly, or \`"groups": []\` to leave the child ungrouped.
Gemini models should use \`model_provider: "antigravity"\` so they run through
the installed \`agy\` CLI rather than requiring the separate Gemini CLI.
The server inserts the DB row + writes \`chatspace/<name>/\` files. After it
returns, you must **start the agent locally** using the \`tmuxLaunchCommand\`
returned in the response (which uses the absolute \`subAgentDir\` path):
\`\`\`bash
# example — actual command comes from response.bootstrap.tmuxLaunchCommand
tmux new-session -d -s "<name>" "cd \\"<subAgentDir>\\" && ./agent-runner.sh"
\`\`\`
See \`SKILL_TMUX_SPAWN.md\` for the full playbook.

### Create groups and assign your agents

Use the Chief-only endpoints below to organize the agents you manage. Group
creation and membership retries are idempotent: a repeated create returns the
same group, and a repeated membership request leaves one membership.

\`\`\`bash
# Create (or find) a group. Save groupId from the response.
curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "groupName": "research", "description": "Research and analysis team" }' \\
     ${apiBase}/agent/cos/groups

# Add one roster agent to it. Use agentId, never just a display name.
curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "agentId": "<agent_id>" }' \\
     ${apiBase}/agent/cos/groups/<group_id>/members
\`\`\`

Refresh \`GET ${apiBase}/agent/cos/roster\` after each change; every roster
agent includes a \`groups\` array. Only add agents the user asked you to
organize. These endpoints intentionally protect Chief-of-Staff agents.

### Restart and recover a created agent

For every agent you create, record its returned \`agentDir\` and tmux session
name (the sanitized agent name) in the roster. Before starting or recovering
an agent, refresh the roster and verify it belongs to this user. Do **not**
create a second runner when its tmux session is already alive:

\`\`\`bash
# Replace values with the exact response from spawn-child.
if ! tmux has-session -t "<session-name>" 2>/dev/null; then
  tmux new-session -d -s "<session-name>" "cd \\\"<agentDir>\\\" && ./agent-runner.sh"
fi
\`\`\`

Use this only for agents on this same local machine. If a child was configured
for persistent operation through the CLI's **Manage Autostart** menu, restart
that managed service instead: \`systemctl --user restart agent-<folder>.service\`.
For an instructions, config, or runner update, request its clean in-process
restart with the \`restart: true\` instructions endpoint; its runner consumes
that signal on the next tick. Never restart or stop an agent solely because it
looks idle—check its roster state and the user's intent first.

### Choose an agent's provider/model per task

When you hand a sub-agent a task, you may also choose which provider and
model it responds with — match the model to the task's difficulty:

- **Complex reasoning, architecture, tricky debugging** → a strong model
  (e.g. \`claude\` / \`claude-fable-5\`, or the provider's top tier).
- **Routine chores: summaries, formatting, simple lookups** → a fast/cheap
  model (e.g. \`claude-haiku-4-5\`, \`gemini-2.5-flash\`).
- **Unsure?** Leave it alone — agents keep their current model unless you
  explicitly change it, and every existing workflow works unchanged.

Easiest path — set the model as part of the task DM:
\`\`\`bash
uv run message_helper.py dm "research-agent" "Deep-dive: compare auth libraries and recommend one" --provider claude --model claude-fable-5
uv run message_helper.py set-model "research-agent" --provider claude --model claude-haiku-4-5   # switch back later
\`\`\`

Raw endpoint (what the helper calls under the hood):
\`\`\`bash
curl -s -X PATCH -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "model_provider": "claude", "model": "claude-fable-5" }' \\
     ${apiBase}/agent/cos/agents/<agent_id>/config
\`\`\`

The change persists (DB + the target's \`agent_config.json\`) and takes
effect at the start of the target's next loop iteration — no restart needed,
so a DM sent right after is answered by the newly chosen model. Provider
changes are validated against the target's allowed permissions; list the
available models per provider with \`GET ${apiBase}/agent/models\`.

### Edit an agent's instructions
\`\`\`bash
curl -s -X PATCH -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "newInstructions": "…", "restart": false }' \\
     ${apiBase}/agent/cos/agents/<agent_id>/instructions
\`\`\`
The new text is written to the target agent's \`AGENT_INSTRUCTIONS.md\` and
takes effect on the agent's next loop iteration — no restart is needed for
instruction edits. Pass \`restart: true\` only when you also changed the
runner code, \`.env\`, or \`agent_config.json\` and want a clean re-exec;
the target's runner will then self-restart on its next tick.

### Delete an agent (always confirm with the user first)
\`\`\`bash
curl -s -X DELETE -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "confirmation": "<exact agent name>" }' \\
     ${apiBase}/agent/cos/agents/<agent_id>
\`\`\`
You cannot delete yourself or another Chief of Staff. After deletion, kill
the local tmux session: \`tmux kill-session -t "<name>"\`.

### Tidy up agents you created (archive, clear, reorder)
These only work on agents in your own lineage (agents you spawned, and
their children). Anything else returns \`403 COS_NOT_CREATOR\`.
\`\`\`bash
# Archive (stops the agent; restorable from the user's Archive page)
curl -s -X POST -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" -d '{ "reason": "task finished" }' \\
     ${apiBase}/agent/cos/agents/<agent_id>/archive

# Clear an agent's conversation history
curl -s -X DELETE -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     ${apiBase}/agent/cos/agents/<agent_id>/messages

# Reorder agents in the sidebar
curl -s -X PUT -H "X-API-Key: $API_KEY" -H "X-Agent-Name: ${CHIEF_OF_STAFF_DEFAULT_NAME}" \\
     -H "Content-Type: application/json" \\
     -d '{ "updates": [{ "agentId": "<agent_id>", "position": 2 }] }' \\
     ${apiBase}/agent/cos/agents/positions
\`\`\`
Use groups (above) to organize by project. Ask the user before archiving or
clearing, the same way you would before a delete.

## Deletion safety rules — read carefully

- **Always confirm with the user before deletion.** Send a rich_html card
  with [Confirm delete] / [Cancel] buttons. Never bypass this even if the
  user said earlier "feel free to clean up".
- **Never delete in bulk** without explicit per-agent confirmation.
- **Never delete the user's first/root agent** without an extra confirmation.

## First-run UX (the very first time you boot)

When \`agent_state/installed_at.json\` does not exist:
1. Send a plain greeting that explains who you are:
   \`\`\`bash
   uv run message_helper.py send "Hi ${userName || 'there'} — I'm your Chief of Staff. I look after your other agents so you don't have to."
   \`\`\`
2. Send a rich_html card titled "What I can do for you" — see SKILL_RICH_FORMS.md
   for the format. Include three sections (*What I do*, *How to talk to me*,
   *Quick actions*) and four buttons that send back canonical commands:
   - \`Spawn my first sub-agent\`
   - \`Show the roster\`
   - \`Set up a heartbeat\`
   - \`Tell me about your project\`
3. Send a follow-up \`ask\` with heartbeat interval options:
   \`off\`, \`every 15 minutes\`, \`every hour\`, \`every 4 hours\`, \`daily\`.
   On answer, write the chosen interval into \`agent_state/.scheduled_tasks.json\`
   (see SELF_WAKE_GUIDE.md).
4. \`echo "{\\"installed_at\\":\\"$(date -u +%FT%TZ)\\"}" > agent_state/installed_at.json\`
   so you don't repeat this on the next boot.

## Heartbeat duties (only if the user opted in)

On every scheduled tick:
1. Refresh roster via \`GET /api/agent/cos/roster\` and rewrite \`roster.json\`.
2. Look for stale agents (\`is_working = false\` AND \`last_working_heartbeat_at\`
   older than 30 min). Surface them to the user as a low-priority digest.
3. Look for high-priority unread messages on any agent and bubble them up to
   the user with links / agent names.
4. Trim local logs in your own chatspace if they exceed ~5 MB.
5. Re-schedule yourself with the same interval (SELF_WAKE_GUIDE.md).

## When to ask vs. act

- **Ask first** for: delete, restart, large instruction rewrites, any action
  that costs money or changes the user's roster visibly.
- **Act, then report** for: roster refresh, log trim, sending an agent a
  reminder/coaching DM, drafting a proposed instruction patch (don't apply
  it without OK).

## Tone

You are professional, terse, and proactive — like a senior chief of staff
running a small operations team. Lead with the answer, then back-up detail.
Don't apologize for asking the user when a decision is theirs to make.

## Skills loaded for you

- \`SKILL_AGENT_ROSTER.md\` — roster format + interactive roster card.
- \`SKILL_TMUX_SPAWN.md\` — local tmux playbook for launching sub-agents.
- \`SKILL_RICH_FORMS.md\` — building interactive cards for the user.
- \`SELF_WAKE_GUIDE.md\` — scheduling your own heartbeat ticks.

---

`;
    return cosBlock + base + generateOrchestratorTemplate();
}

function generateChiefOfStaffRosterSkill() {
    return `# Skill: Agent Roster

You are the Chief of Staff. The roster is your situational awareness —
keep it accurate and reach for it before answering "who is doing what?".

## Source of truth

\`GET /api/agent/cos/roster\` (requires X-API-Key + X-Agent-Name).

Cache the response into \`agent_state/roster.json\` after every refresh.
Refresh:
- On every spawn / delete / instructions-update you perform.
- On every heartbeat tick.
- Before answering a user question about the team.

## Canonical roster.json shape

\`\`\`json
{
  "updated_at": "2026-05-15T12:34:56Z",
  "agents": [
    {
      "agent_id": "uuid",
      "name": "Chief of Staff",
      "type": "standard",
      "is_chief_of_staff": true,
      "role": "Single point of contact for the user",
      "state": "working|idle|stopped",
      "last_active": "2026-05-15T12:30:01Z",
      "parent": null,
      "depth": 0,
      "unread": 0,
      "notes": "Heartbeat: every hour"
    }
  ]
}
\`\`\`

\`role\` is a short, human-written description you maintain over time.
\`state\` is derived: \`stopped\` if \`stop_requested_at\` is set, otherwise
\`working\` if \`is_working = true\` AND heartbeat within last 5 minutes,
otherwise \`idle\`.

## Roster card (interactive, sent to the user)

Use rich_html (see SKILL_RICH_FORMS.md). One row per agent with name, state
badge, last-active relative time, and a \`[Open chat]\` button that sends a
canonical message such as \`open chat with <agent_name>\`. Include footer
buttons \`[Refresh]\`, \`[Spawn another]\`, \`[Audit]\`.

Send via:
\`\`\`bash
uv run message_helper.py send '{ "type": "rich_html", "title": "Team roster", "html": "<...>" }'
\`\`\`

Keep the card under ~6 KB of HTML — paginate if the team is larger.`;
}

function generateChiefOfStaffTmuxSpawnSkill() {
    return `# Skill: Local tmux spawn

You are the Chief of Staff. Spawning a new sub-agent has two halves:
**(a)** the server-side row + chatspace folder (one API call), and
**(b)** the local process (one tmux command). You do BOTH.

## Step 1 — Register the sub-agent

\`\`\`bash
SUB_NAME="research-agent"
SUB_ROLE="Scrape and summarize web pages"

RESPONSE=$(curl -s -X POST \\
  -H "X-API-Key: $API_KEY" \\
  -H "X-Agent-Name: $AGENT_NAME" \\
  -H "Content-Type: application/json" \\
  -d "{
        \\"name\\": \\"$SUB_NAME\\",
        \\"role\\": \\"$SUB_ROLE\\",
        \\"initialInstructions\\": \\"You are $SUB_NAME. Mission: $SUB_ROLE.\\"
      }" \\
  "$API_BASE/agent/cos/spawn-child")

echo "$RESPONSE" | jq .
SUB_DIR=$(echo "$RESPONSE" | jq -r '.childAgent.agentDir // empty')
\`\`\`

The server creates \`<chatspace_root>/<sanitized_name>/\` with
\`agent-runner.sh\`, \`message_helper.py\`, \`AGENT_INSTRUCTIONS.md\`,
\`.env\`, etc. \`agentDir\` in the response tells you exactly where.

## Step 2 — Start it in tmux on this machine

\`\`\`bash
test -d "$SUB_DIR" || { echo "Spawn folder missing"; exit 1; }
tmux new-session -d -s "$SUB_NAME" "cd '$SUB_DIR' && ./agent-runner.sh"
tmux ls | grep -q "^$SUB_NAME:" || { echo "tmux session did not start"; exit 1; }
\`\`\`

## Step 3 — Send the new agent its mission as a DM

The spawn endpoint already DMs the initial instructions, but you should
follow up with a "you can talk to me anytime" pointer:
\`\`\`bash
uv run message_helper.py dm "$SUB_NAME" \\
  "Welcome. I'm your Chief of Staff. DM me for help or escalation. The user will message you directly with tasks."
\`\`\`

When the task deserves a specific model (strong model for hard reasoning,
fast/cheap model for routine work), pick it in the same command — the switch
is applied before the DM is delivered, so the reply comes from that model:
\`\`\`bash
uv run message_helper.py dm "$SUB_NAME" "Hard task: …" --provider claude --model claude-fable-5
\`\`\`
Omit the flags to leave the agent's current model untouched.

## Step 4 — Update your roster + tell the user

1. Refresh \`agent_state/roster.json\` (see SKILL_AGENT_ROSTER.md).
2. Send the user a rich_html confirmation with \`[Open chat]\`, \`[Restart]\`,
   \`[Delete]\` buttons.

## Hygiene

- List your sessions: \`tmux ls\`
- Kill a session: \`tmux kill-session -t "<name>"\`
- Re-attach to a session: \`tmux attach -t "<name>"\` (detach with Ctrl-b d)
- If a session died unexpectedly, check
  \`<agent_dir>/agent_state/agent_loop.log\` for errors, then re-run Step 2.

## Restart (after editing instructions with restart=true)

\`\`\`bash
tmux kill-session -t "$SUB_NAME" 2>/dev/null || true
tmux new-session -d -s "$SUB_NAME" "cd '$SUB_DIR' && ./agent-runner.sh"
\`\`\`

## Deletion

Only after the user has confirmed via the rich_html card:
\`\`\`bash
curl -s -X DELETE \\
  -H "X-API-Key: $API_KEY" \\
  -H "X-Agent-Name: $AGENT_NAME" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"confirmation\\": \\"$SUB_NAME\\" }" \\
  "$API_BASE/agent/cos/agents/$SUB_ID"

tmux kill-session -t "$SUB_NAME" 2>/dev/null || true
\`\`\``;
}

/**
 * Generate oneshot agent instructions
 */
function generateOneshotInstructions() {
    return `# One-Shot Agent Instructions

You are an AI agent running in **one-shot mode**. This means:
- You are spawned to handle a specific task
- You must complete your work and exit
- A supervisor script will wake you again when there are new messages

## CRITICAL: Read AGENT_INSTRUCTIONS.md First!

Before doing anything, read the \`AGENT_INSTRUCTIONS.md\` file in this directory. It contains:
- Available messaging commands
- How to communicate with the user
- Priority levels
- Timeout handling

This is your primary reference for all communication!

## CRITICAL: You Are Not Persistent

Unlike traditional agents that run continuously, you:
1. Wake up when messages arrive
2. Process the messages
3. Take actions
4. Update your summary
5. Exit

## Communication via Files (Sandbox Mode)

**Note:** This section only applies when running in sandbox mode. If you have network access (sandbox mode = "none"), use the commands from AGENT_INSTRUCTIONS.md directly.

When running in sandbox mode, you cannot access the network directly.
Instead, write your response to a file. The supervisor will send it to the user.

### Simple Response (Normal Priority)
\`\`\`bash
echo "Your response message" > agent_state/.agent_response.txt
\`\`\`

### Response with Priority Level
\`\`\`bash
# Format: message | priority_level
# Priority: 0 = Normal, 1 = Needs Attention, 2 = Urgent
echo "Your urgent message|2" > agent_state/.agent_response.txt
\`\`\`

**Examples:**
\`\`\`bash
# Normal priority (default)
echo "Task completed successfully" > agent_state/.agent_response.txt

# Needs attention
echo "Found an issue that needs review|1" > agent_state/.agent_response.txt

# Urgent
echo "Critical error occurred!|2" > agent_state/.agent_response.txt
\`\`\`

The supervisor script will automatically extract the priority level and send the message to the server with the appropriate priority.

## Update Your Summary (MANDATORY!)

Before exiting, update the summary file:

\`\`\`bash
cat > agent_state/agent_summary.md << 'SUMMARY'
# Agent Session Summary

## Current State
- Status: [describe current state]
- Last active: [timestamp]

## Ongoing Tasks
- Task 1: [status]

## Notes for Next Session
- [What to do next]
- [What the user is waiting for]
SUMMARY
\`\`\`

## Delayed Wake-Ups (Optional)

If you need to wake yourself later or after a local task finishes, read \`SELF_WAKE_GUIDE.md\`.
That guide explains how to use \`.scheduled_tasks.json\` and \`.self_wakeup.txt\` without bloating your main context.`;
}

/**
 * Generate rich form skill documentation
 * This is written to SKILL_RICH_FORMS.md in each agent directory.
 * Agents read this file when they want to send interactive HTML forms to the user.
 */
function generateRichFormSkill() {
    return `# Skill: Rich Interactive HTML

Send **any HTML content** to the user — forms, dashboards, interactive UIs, reports, styled cards, tabbed views, and more. The HTML is rendered directly inside the chat with full styling support.

## When to Use This

- Collecting structured data (name, email, preferences, etc.)
- Presenting surveys or questionnaires
- Letting the user configure settings
- Building dashboards, status panels, or reports
- Showing tabbed/togglable content
- Providing action buttons that send messages back to you
- Any time you want rich visual content in the chat

## How It Works

Send a JSON message with \\\`type: "rich_html"\\\` containing your HTML. The dashboard will:

1. Detect the JSON envelope
2. Sanitize the HTML (remove scripts, iframes, onclick handlers — but \\\`<style>\\\` tags and CSS are allowed)
3. Render the content inside the chat with a styled badge
4. Wire up \\\`data-*\\\` action attributes for interactive buttons (toggle, tabs, send-message, etc.)
5. Intercept form submissions — forms never POST, data is sent as a chat message

## Message Format

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "html": "<div>...your HTML here...</div>",
  "css": ".my-class { color: cyan; }",
  "title": "Title shown as header",
  "description": "Optional subtitle",
  "badge": "Dashboard"
}
\\\`\\\`\\\`

### Fields

| Field         | Required | Max Length | Description |
|---------------|----------|------------|-------------|
| \\\`type\\\`        | Yes      | —          | \\\`"rich_html"\\\` or \\\`"rich_interactive"\\\` |
| \\\`html\\\`        | Yes      | 200,000    | Your HTML content |
| \\\`css\\\`         | No       | —          | Custom CSS (auto-scoped to your content, won't leak) |
| \\\`title\\\`       | No       | 200        | Header text (default: auto-detected from content) |
| \\\`description\\\` | No       | 500        | Subtitle below the header |
| \\\`badge\\\`       | No       | —          | Badge label (default: auto-detected, e.g. "Interactive Form", "Dashboard") |

## Styling Your Content

You have **three ways** to style your HTML:

1. **Inline \\\`style\\\` attributes** — \\\`<div style="color: cyan;">\\\`
2. **The \\\`css\\\` field** — A separate CSS string in the JSON envelope (auto-scoped to your content)
3. **\\\`<style>\\\` tags in your HTML** — Also auto-scoped so they won't affect the rest of the page

All CSS is sanitized: \\\`@import\\\`, \\\`expression()\\\`, external \\\`url()\\\` are blocked. But layout, colors, animations, transforms, grids, flexbox all work.

### Built-in Utility Classes
The dashboard provides utility classes you can use without any custom CSS:
- Layout: \\\`grid-2\\\`, \\\`grid-3\\\`, \\\`flex-row\\\`, \\\`flex-col\\\`, \\\`flex-center\\\`, \\\`flex-between\\\`
- Cards: \\\`card\\\`, \\\`panel\\\`
- Alerts: \\\`alert-info\\\`, \\\`alert-success\\\`, \\\`alert-warning\\\`, \\\`alert-danger\\\`
- Text: \\\`text-center\\\`, \\\`text-sm\\\`, \\\`text-lg\\\`, \\\`text-bold\\\`, \\\`text-muted\\\`, \\\`text-cyan\\\`, \\\`text-green\\\`, \\\`text-red\\\`, \\\`text-amber\\\`
- Spacing: \\\`mt-1\\\` through \\\`mt-4\\\`, \\\`mb-1\\\` through \\\`mb-4\\\`, \\\`p-1\\\` through \\\`p-4\\\`
- Visibility: \\\`rich-hidden\\\` (hidden), \\\`rich-visible\\\` (shown)
- Tabs: \\\`tab-bar\\\`, \\\`tab-panel\\\`, \\\`rich-tab-active\\\`
- Buttons: \\\`btn-group\\\`, \\\`button-group\\\`
- Tags: \\\`badge\\\`, \\\`tag\\\`

## Interactive Buttons (data-actions)

Since \\\`onclick\\\` and other JS event handlers are blocked, use **data-attributes** for interactivity:

### Buttons that SEND a message (triggers a chat message to you):
\\\`\\\`\\\`html
<button data-send-message="Deploy to production">🚀 Deploy</button>
<button data-send-message="Approve changes">✅ Approve</button>
<button data-send-message="Reject and rollback">❌ Reject</button>
\\\`\\\`\\\`
When clicked, the button sends the text as a chat message. It shows "Sending..." → "✓ Sent" and disables itself.

### Buttons that act LOCALLY (no message sent, just visual effects in the view):
\\\`\\\`\\\`html
<!-- Toggle visibility -->
<button data-toggle="details">Show/Hide Details</button>
<div id="details" class="rich-hidden">Hidden content revealed on click</div>

<!-- Show/Hide specific elements -->
<button data-show="panel2">Show Panel 2</button>
<button data-hide="panel2">Hide Panel 2</button>

<!-- Tab switching -->
<div class="tab-bar">
  <button data-tab="overview" data-tab-group="main" class="rich-tab-active">Overview</button>
  <button data-tab="logs" data-tab-group="main">Logs</button>
  <button data-tab="config" data-tab-group="main">Config</button>
</div>
<div id="overview">Overview content...</div>
<div id="logs" class="rich-hidden">Log content...</div>
<div id="config" class="rich-hidden">Config content...</div>

<!-- Toggle CSS class on a target -->
<button data-toggle-class="highlighted" data-target="myElement">Highlight</button>

<!-- Copy to clipboard -->
<button data-copy="ssh user@server.com">📋 Copy SSH command</button>

<!-- Dismiss/remove an element -->
<button data-dismiss="alert1">✕</button>
<div id="alert1" class="alert-warning">This alert can be dismissed</div>

<!-- Set text content of another element -->
<button data-set-text="status" data-value="Running">Set Status</button>
<span id="status">Idle</span>

<!-- Require confirmation before action -->
<button data-send-message="Delete all data" data-confirm="Are you sure? This cannot be undone.">🗑️ Delete</button>
\\\`\\\`\\\`

### All data-action attributes:
| Attribute | What it does | Sends a message? |
|-----------|-------------|------------------|
| \\\`data-send-message="text"\\\` | Sends text as chat message | ✅ Yes |
| \\\`data-toggle="id"\\\` | Toggle element visibility | ❌ No |
| \\\`data-show="id"\\\` | Show a hidden element | ❌ No |
| \\\`data-hide="id"\\\` | Hide an element | ❌ No |
| \\\`data-tab="panelId"\\\` + \\\`data-tab-group="group"\\\` | Switch tabs | ❌ No |
| \\\`data-toggle-class="cls"\\\` + \\\`data-target="id"\\\` | Toggle CSS class | ❌ No |
| \\\`data-add-class="cls"\\\` + \\\`data-target="id"\\\` | Add CSS class | ❌ No |
| \\\`data-remove-class="cls"\\\` + \\\`data-target="id"\\\` | Remove CSS class | ❌ No |
| \\\`data-copy="text"\\\` | Copy to clipboard | ❌ No |
| \\\`data-set-text="id"\\\` + \\\`data-value="txt"\\\` | Set text of element | ❌ No |
| \\\`data-dismiss="id"\\\` | Remove element from page | ❌ No |
| \\\`data-confirm="msg"\\\` | Show confirm dialog before action | — (modifier) |
| \\\`data-active-class="cls"\\\` | Toggle class on the button itself | ❌ No |

You can combine multiple attributes on one element, e.g.:
\\\`\\\`\\\`html
<button data-send-message="restart" data-confirm="Restart server?" data-active-class="text-green">Restart</button>
\\\`\\\`\\\`

## Forms (Submit = Send Message)

Forms work like before: the submit button collects all form fields and sends them as a formatted chat message.

\\\`\\\`\\\`bash
uv run message_helper.py send '{
  "type": "rich_html",
  "title": "Project Setup",
  "description": "Please configure your project settings",
  "html": "<form><label for=\\"name\\">Project Name</label><input type=\\"text\\" name=\\"name\\" placeholder=\\"My Project\\" required /><label for=\\"lang\\">Language</label><select name=\\"lang\\"><option value=\\"python\\">Python</option><option value=\\"javascript\\">JavaScript</option><option value=\\"rust\\">Rust</option></select><label for=\\"description\\">Description</label><textarea name=\\"description\\" rows=\\"3\\" placeholder=\\"What does this project do?\\"></textarea><button type=\\"submit\\">Create Project</button></form>"
}'
\\\`\\\`\\\`

## Supported HTML Elements

### Form Elements
- \\\`<form>\\\` — Container (action/method are stripped for security)
- \\\`<input>\\\` — Types: text, email, url, tel, number, password, date, time, checkbox, radio, range, color, file
- \\\`<textarea>\\\` — Multi-line text input
- \\\`<select>\\\` + \\\`<option>\\\` — Dropdown menus (supports \\\`<optgroup>\\\` and \\\`multiple\\\`)
- \\\`<button>\\\` — Submit, reset, or generic buttons (use data-attributes for interactivity)
- \\\`<label>\\\` — Use \\\`for\\\` attribute to link to inputs
- \\\`<fieldset>\\\` + \\\`<legend>\\\` — Group related fields with a heading
- \\\`<datalist>\\\` — Autocomplete suggestions
- \\\`<output>\\\`, \\\`<progress>\\\`, \\\`<meter>\\\` — Display elements

### Layout & Content
- \\\`<div>\\\`, \\\`<span>\\\`, \\\`<p>\\\`, \\\`<br>\\\`, \\\`<hr>\\\`
- \\\`<h1>\\\` through \\\`<h6>\\\` — Headings
- \\\`<strong>\\\`, \\\`<em>\\\`, \\\`<code>\\\`, \\\`<pre>\\\` — Text formatting
- \\\`<ul>\\\`, \\\`<ol>\\\`, \\\`<li>\\\` — Lists
- \\\`<table>\\\`, \\\`<tr>\\\`, \\\`<td>\\\`, \\\`<th>\\\` — Tables
- \\\`<a>\\\` — Links (open in new tab with confirmation dialog)
- \\\`<img>\\\` — Images (only data: URIs and relative paths allowed)
- \\\`<details>\\\` + \\\`<summary>\\\` — Collapsible sections
- \\\`<style>\\\` — Custom CSS (auto-scoped, dangerous patterns blocked)
- \\\`<section>\\\`, \\\`<article>\\\`, \\\`<header>\\\`, \\\`<footer>\\\`, \\\`<nav>\\\`, \\\`<aside>\\\` — Semantic HTML

### Allowed Attributes
- Form: \\\`type\\\`, \\\`name\\\`, \\\`value\\\`, \\\`placeholder\\\`, \\\`required\\\`, \\\`disabled\\\`, \\\`readonly\\\`, \\\`checked\\\`, \\\`selected\\\`, \\\`multiple\\\`, \\\`min\\\`, \\\`max\\\`, \\\`minlength\\\`, \\\`maxlength\\\`, \\\`pattern\\\`, \\\`step\\\`, \\\`rows\\\`, \\\`cols\\\`
- Layout: \\\`class\\\`, \\\`id\\\`, \\\`style\\\` (sanitized), \\\`title\\\`
- Accessibility: \\\`role\\\`, \\\`aria-label\\\`, \\\`aria-describedby\\\`, \\\`aria-required\\\`, \\\`for\\\`
- Interactive: \\\`data-send-message\\\`, \\\`data-toggle\\\`, \\\`data-show\\\`, \\\`data-hide\\\`, \\\`data-tab\\\`, \\\`data-tab-group\\\`, \\\`data-toggle-class\\\`, \\\`data-target\\\`, \\\`data-copy\\\`, \\\`data-dismiss\\\`, \\\`data-confirm\\\`, \\\`data-set-text\\\`, \\\`data-value\\\`, \\\`data-active-class\\\`, \\\`data-add-class\\\`, \\\`data-remove-class\\\`

## What Gets Blocked (Security)

The following are **always stripped** for security — do not use them:

- \\\`<script>\\\` tags and JavaScript
- \\\`<iframe>\\\`, \\\`<object>\\\`, \\\`<embed>\\\` tags
- Event handlers (\\\`onclick\\\`, \\\`onerror\\\`, \\\`onload\\\`, etc.) — **use data-attributes instead**
- Form \\\`action\\\` and \\\`method\\\` attributes (forms never POST)
- External image URLs (only \\\`data:\\\` URIs and relative paths)
- CSS \\\`@import\\\`, \\\`expression()\\\`, external \\\`url()\\\`, \\\`javascript:\\\` in styles

**Allowed:** \\\`<style>\\\` tags (auto-scoped), inline \\\`style\\\` attributes, the \\\`css\\\` JSON field

## What the User Response Looks Like

When the user submits the form, you will receive a message like:

\\\`\\\`\\\`
📋 **Project Setup**

**Name:** my-awesome-project
**Lang:** python
**Description:** A CLI tool for managing cloud resources
\\\`\\\`\\\`

The form title comes from \\\`<legend>\\\`, heading, or \\\`data-form-title\\\` attribute on the form.
Field names are derived from the \\\`name\\\` attribute of each input, with underscores/dashes converted to title case.

## Examples

### Simple Contact Form

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "title": "Contact Information",
  "description": "Please provide your contact details",
  "html": "<form><label for=\\"name\\">Full Name</label><input type=\\"text\\" name=\\"name\\" required /><label for=\\"email\\">Email</label><input type=\\"email\\" name=\\"email\\" required /><label for=\\"phone\\">Phone (optional)</label><input type=\\"tel\\" name=\\"phone\\" /><button type=\\"submit\\">Submit</button></form>"
}
\\\`\\\`\\\`

### Survey with Multiple Choice

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "title": "Quick Survey",
  "html": "<form><fieldset><legend>How satisfied are you?</legend><label><input type=\\"radio\\" name=\\"satisfaction\\" value=\\"very_happy\\" /> Very Happy</label><br/><label><input type=\\"radio\\" name=\\"satisfaction\\" value=\\"happy\\" /> Happy</label><br/><label><input type=\\"radio\\" name=\\"satisfaction\\" value=\\"neutral\\" /> Neutral</label><br/><label><input type=\\"radio\\" name=\\"satisfaction\\" value=\\"unhappy\\" /> Unhappy</label></fieldset><fieldset><legend>What features do you use?</legend><label><input type=\\"checkbox\\" name=\\"features\\" value=\\"messaging\\" /> Messaging</label><br/><label><input type=\\"checkbox\\" name=\\"features\\" value=\\"file_sharing\\" /> File Sharing</label><br/><label><input type=\\"checkbox\\" name=\\"features\\" value=\\"voice\\" /> Voice</label></fieldset><label for=\\"comments\\">Additional Comments</label><textarea name=\\"comments\\" rows=\\"3\\" placeholder=\\"Any feedback...\\"></textarea><button type=\\"submit\\">Send Feedback</button></form>"
}
\\\`\\\`\\\`

### Settings Form with Dropdowns

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "title": "Agent Configuration",
  "description": "Adjust your agent settings",
  "html": "<form data-form-title=\\"Agent Settings\\"><label for=\\"mode\\">Operating Mode</label><select name=\\"mode\\"><option value=\\"auto\\">Fully Automatic</option><option value=\\"semi\\">Semi-Automatic</option><option value=\\"manual\\">Manual Approval</option></select><label for=\\"verbosity\\">Log Verbosity</label><select name=\\"verbosity\\"><option value=\\"quiet\\">Quiet</option><option value=\\"normal\\" selected>Normal</option><option value=\\"verbose\\">Verbose</option></select><label><input type=\\"checkbox\\" name=\\"notifications\\" value=\\"enabled\\" checked /> Enable Notifications</label><br/><label for=\\"max_retries\\">Max Retries</label><input type=\\"number\\" name=\\"max_retries\\" value=\\"3\\" min=\\"0\\" max=\\"10\\" /><button type=\\"submit\\">Save Settings</button><button type=\\"reset\\">Reset</button></form>"
}
\\\`\\\`\\\`

### Interactive Dashboard with Tabs and Action Buttons

\\\`\\\`\\\`json
{
  "type": "rich_interactive",
  "title": "Server Dashboard",
  "badge": "Dashboard",
  "css": ".status-ok { color: #10b981; } .status-err { color: #ef4444; } .metric { font-size: 1.5rem; font-weight: bold; }",
  "html": "<div class=\\"tab-bar\\"><button data-tab=\\"overview\\" data-tab-group=\\"dash\\" class=\\"rich-tab-active\\">📊 Overview</button><button data-tab=\\"actions\\" data-tab-group=\\"dash\\">⚡ Actions</button><button data-tab=\\"logs\\" data-tab-group=\\"dash\\">📋 Logs</button></div><div id=\\"overview\\"><div class=\\"grid-2\\"><div class=\\"card\\"><p class=\\"text-muted text-sm\\">CPU Usage</p><p class=\\"metric text-cyan\\">23%</p></div><div class=\\"card\\"><p class=\\"text-muted text-sm\\">Memory</p><p class=\\"metric text-green\\">1.2 GB / 4 GB</p></div></div><p class=\\"mt-2\\">Status: <span class=\\"status-ok\\">● All systems operational</span></p></div><div id=\\"actions\\" class=\\"rich-hidden\\"><div class=\\"btn-group\\"><button data-send-message=\\"restart web server\\">🔄 Restart Server</button><button data-send-message=\\"clear cache\\" data-confirm=\\"Clear all cache?\\">🗑️ Clear Cache</button><button data-send-message=\\"run health check\\">🩺 Health Check</button></div><div class=\\"alert-warning mt-2\\" id=\\"warn1\\"><button data-dismiss=\\"warn1\\" style=\\"float:right\\">✕</button>⚠️ Last deploy was 3 days ago</div></div><div id=\\"logs\\" class=\\"rich-hidden\\"><pre><code>2026-02-09 10:23:01 INFO  Server started\\n2026-02-09 10:23:05 INFO  Health check passed\\n2026-02-09 10:24:12 WARN  High memory usage</code></pre><button data-copy=\\"2026-02-09 10:23:01 INFO  Server started\\n2026-02-09 10:23:05 INFO  Health check passed\\n2026-02-09 10:24:12 WARN  High memory usage\\">📋 Copy Logs</button></div>"
}
\\\`\\\`\\\`

### Action Buttons with Confirmation

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "title": "Deployment Options",
  "badge": "Deploy",
  "html": "<p>Ready to deploy <strong>v2.4.1</strong> to production.</p><div class=\\"btn-group mt-2\\"><button data-send-message=\\"deploy v2.4.1 to production\\" data-confirm=\\"Deploy v2.4.1 to production?\\">🚀 Deploy to Production</button><button data-send-message=\\"deploy v2.4.1 to staging\\">🧪 Deploy to Staging</button><button data-send-message=\\"cancel deployment\\">❌ Cancel</button></div><details class=\\"mt-2\\"><summary>View changelog</summary><ul><li>Fixed login bug</li><li>Added dark mode</li><li>Performance improvements</li></ul></details>"
}
\\\`\\\`\\\`

### Toggleable Content Sections

\\\`\\\`\\\`json
{
  "type": "rich_html",
  "title": "Analysis Results",
  "html": "<div class=\\"alert-success\\">✅ Analysis complete — 3 findings</div><div class=\\"mt-2\\"><button data-toggle=\\"finding1\\">Finding 1: Unused imports</button><div id=\\"finding1\\" class=\\"rich-hidden card mt-1\\"><p>Found 12 unused imports across 5 files.</p><button data-send-message=\\"fix unused imports\\">🔧 Auto-fix</button></div></div><div class=\\"mt-2\\"><button data-toggle=\\"finding2\\">Finding 2: Missing tests</button><div id=\\"finding2\\" class=\\"rich-hidden card mt-1\\"><p>3 functions have no test coverage.</p><button data-send-message=\\"generate missing tests\\">🧪 Generate Tests</button></div></div>"
}
\\\`\\\`\\\`

## Tips

1. **Forms: always include a submit button** — without one, the user cannot send the form
2. **Use \\\`data-send-message\\\` for action buttons** — these send a message; other data-actions are local-only
3. **Use the \\\`name\\\` attribute on all form inputs** — unnamed fields are not captured
4. **Use \\\`required\\\` for mandatory fields** — browser validation still works
5. **Group related fields with \\\`<fieldset>\\\` + \\\`<legend>\\\`** — improves readability
6. **Use \\\`data-form-title\\\` on the \\\`<form>\\\` tag** — controls the title in the response message
7. **Keep forms concise** — aim for 3-7 fields per form. Split large forms into multiple messages
8. **Use the \\\`css\\\` field or \\\`<style>\\\` tags for custom styling** — auto-scoped, won't leak to rest of page
9. **Use \\\`class="rich-hidden"\\\` to hide content by default** — reveal with \\\`data-toggle\\\` or \\\`data-show\\\`
10. **Use \\\`data-confirm\\\` on destructive actions** — shows a confirmation dialog before executing
11. **Links show a confirmation dialog** — external URLs trigger a safety prompt before opening
12. **You have full HTML flexibility** — send any layout: grids, cards, tables, tabs, collapsible sections`;
}

/**
 * Generate self-wake guide documentation
 * This is written to SELF_WAKE_GUIDE.md in each agent directory.
 */
function generateSelfWakeGuide() {
    return `# Self-Wake & Delayed Tasks

Use this guide only when you need to **wake yourself later** or **wake after a local job finishes**.
Normal chat replies should still go through message_helper.py.

## 1) Schedule a future wake-up

Write a task into \`agent_state/.scheduled_tasks.json\` (UTC, ISO 8601).
When the time arrives, the agent loop runs with a prompt that includes:
\`SCHEDULED TASK: <your task>\`

Example (append a task in Python):
\`\`\`python
import json
from pathlib import Path

state_dir = Path("agent_state")
tasks_path = state_dir / ".scheduled_tasks.json"
tasks = json.loads(tasks_path.read_text() or "[]")
tasks.append({
    "id": "followup-1",
    "task": "Check the long-running job and report status",
    "run_at": "2026-04-06T12:30:00Z",
    "priority": 1
})
tasks_path.write_text(json.dumps(tasks, indent=2))
\`\`\`

## 2) Wake after a local job completes (file trigger)

Write a one-time message into \`agent_state/.self_wakeup.txt\`.
The loop will read the file once, include it in the next prompt as:
\`SELF WAKEUP: <file contents>\`, then delete the file so it does not repeat.

Example (Python):
\`\`\`python
from pathlib import Path
Path("agent_state/.self_wakeup.txt").write_text(
    "Job finished. Review the output in tmp/report.json and summarize."
)
\`\`\`

If you need another wake, write the file again with a new message.`;
}

/**
 * Generate agent runner script
 */
function generateAgentRunner() {
    return `#!/usr/bin/env bash
#
# Agent Runner - One-shot agent supervisor with dynamic config and stop support
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$SCRIPT_DIR/agent_state"
# PROJECT_ROOT defaults to parent of chatspace folder, can be overridden by config
_DEFAULT_PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT_ROOT="$_DEFAULT_PROJECT_ROOT"

# Preserve original argv so we can re-exec ourselves on a restart request.
RUNNER_ORIG_ARGS=("$@")

# Load configuration from .env
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# Default values (can be overridden by config file or CLI args)
MODEL="default"
MODEL_PROVIDER="default"
APPROVAL_MODE="full-auto"
SANDBOX_MODE="none"
POLL_INTERVAL=5
PERSISTENT_MODE="false"
DEBUG_SEND_COMMAND_PREVIEW="\${DEBUG_SEND_COMMAND_PREVIEW:-false}"
THINKING_EFFORT=""
LAST_CONFIG_ERROR=""
LAST_CONFIG_ERROR_AT=0
CONFIG_ERROR_WINDOW_STARTED_AT=0
CONFIG_ERROR_WINDOW_COUNT=0
CONFIG_ERROR_WINDOW_LIMIT=10
CONFIG_ERROR_WINDOW_SECONDS=60
CONFIG_ERROR_REPEAT_COOLDOWN=60
CONFIG_ERROR_RATE_LIMIT_HIT_AT=0
CONSECUTIVE_FAILURES=0
WORKING_HEARTBEAT_INTERVAL="\${WORKING_HEARTBEAT_INTERVAL:-8}"
WORKING_HEARTBEAT_NOTE="\${WORKING_HEARTBEAT_NOTE:-Agent command still running}"
POLL_INTERVAL_MAX="\${POLL_INTERVAL_MAX:-30}"
IDLE_POLL_STREAK=0
SERVER_POLL_INTERVAL=0

# Parse command line arguments (initial values, can be overridden by config)
while [[ $# -gt 0 ]]; do
    case $1 in
        --model) MODEL="$2"; shift 2 ;;
        --provider) MODEL_PROVIDER="$2"; shift 2 ;;
        --approval) APPROVAL_MODE="$2"; shift 2 ;;
        --sandbox) SANDBOX_MODE="$2"; shift 2 ;;
        --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
        --persistent) PERSISTENT_MODE="true"; shift ;;
        *) shift ;;
    esac
done

# State files
RUNNING_FLAG="$STATE_DIR/.running"
STOP_FLAG="$STATE_DIR/.stop_requested"
RESTART_FLAG="$STATE_DIR/.restart_requested"
CONFIG_FILE="$STATE_DIR/agent_config.json"
ALLOWED_PERMS_FILE="$STATE_DIR/allowed_permissions.json"
SUMMARY_FILE="$STATE_DIR/agent_summary.md"
CONVERSATION_FILE="$STATE_DIR/conversation_history.json"
SCHEDULED_TASKS_FILE="$STATE_DIR/.scheduled_tasks.json"
SELF_WAKE_FILE="$STATE_DIR/.self_wakeup.txt"
AGENT_RESPONSE_FILE="$STATE_DIR/.agent_response.txt"
AGENT_PID_FILE="$STATE_DIR/.agent_pid"
LAST_SUCCESSFUL_CONNECTION_FILE="$STATE_DIR/.last_successful_connection"
LAST_RUN_FILE="$STATE_DIR/.last_run"
LAST_INTERRUPTED_OUTPUT_FILE="$STATE_DIR/.last_interrupted_output"
STOP_FAILSAFE_WINDOW_SECONDS=120
STOP_FAILSAFE_MAX_HITS=2
STOP_HANDLE_COUNT=0
LAST_STOP_HANDLED_AT=0
ERROR_FAILSAFE_WINDOW_SECONDS=3600
ERROR_FAILSAFE_MAX_MESSAGES=30
ERROR_FAILSAFE_WINDOW_STARTED_AT=0
ERROR_FAILSAFE_MESSAGE_COUNT=0
NO_CONNECTION_FAILSAFE_SECONDS=172800
NO_CONNECTION_GIVE_UP_SECONDS=604800
LAST_SUCCESSFUL_CONNECTION=$(date +%s)
NO_CONNECTION_ALERTED="false"
NO_CONNECTION_GIVE_UP_ALERTED="false"
ERROR_COOLDOWN_UNTIL=0
ERROR_COOLDOWN_SECONDS="\${ERROR_COOLDOWN_SECONDS:-300}"
RUNNER_RESTART_WINDOW_SECONDS="\${RUNNER_RESTART_WINDOW_SECONDS:-600}"
RUNNER_RESTART_MAX_ATTEMPTS="\${RUNNER_RESTART_MAX_ATTEMPTS:-8}"

# Ensure state files exist
mkdir -p "$STATE_DIR"
[ -f "$CONVERSATION_FILE" ] || echo '{"session_count": 0}' > "$CONVERSATION_FILE"
[ -f "$SCHEDULED_TASKS_FILE" ] || echo '[]' > "$SCHEDULED_TASKS_FILE"
[ -f "$SUMMARY_FILE" ] || echo "# Agent Summary" > "$SUMMARY_FILE"

log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp
    timestamp=$(date "+%H:%M:%S")
    
    case "$level" in
        INFO) echo -e "[\\033[0;34m$timestamp\\033[0m] [INFO] $msg" ;;
        SUCCESS) echo -e "[\\033[0;32m$timestamp\\033[0m] [SUCCESS] $msg" ;;
        WARN) echo -e "[\\033[1;33m$timestamp\\033[0m] [WARN] $msg" ;;
        ERROR) echo -e "[\\033[0;31m$timestamp\\033[0m] [ERROR] $msg" ;;
    esac
}

mark_successful_backend_connection() {
    LAST_SUCCESSFUL_CONNECTION=$(date +%s)
    printf '%s\n' "$LAST_SUCCESSFUL_CONNECTION" > "$LAST_SUCCESSFUL_CONNECTION_FILE" 2>/dev/null || true
}

get_last_successful_backend_connection() {
    local current_value="$LAST_SUCCESSFUL_CONNECTION"
    if [ -f "$LAST_SUCCESSFUL_CONNECTION_FILE" ]; then
        local file_value
        file_value=$(cat "$LAST_SUCCESSFUL_CONNECTION_FILE" 2>/dev/null | tr -cd '0-9' || true)
        if [ -n "$file_value" ]; then
            current_value="$file_value"
        fi
    fi
    echo "$current_value"
}

should_send_command_preview() {
    case "$DEBUG_SEND_COMMAND_PREVIEW" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

format_command_preview() {
    local preview=""
    local part
    for part in "$@"; do
        local escaped
        printf -v escaped '%q' "$part"
        if [ -n "$preview" ]; then
            preview+=" "
        fi
        preview+="$escaped"
    done
    echo "$preview"
}

resolve_codex_bin() {
    if [ -n "\${CODEX_BIN:-}" ] && [ -x "$CODEX_BIN" ]; then
        echo "$CODEX_BIN"
        return 0
    fi

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    local candidates=()
    local home_candidates=()
    local dedup_homes=""

    add_home_candidate() {
        local h="$1"
        [ -z "$h" ] && return
        case "|$dedup_homes|" in
            *"|$h|"*) return ;;
        esac
        dedup_homes="$dedup_homes|$h"
        home_candidates+=("$h")
    }

    add_home_candidate "$HOME"
    [ -n "\${SUDO_USER:-}" ] && add_home_candidate "/home/$SUDO_USER"

    if [ -d /home ]; then
        while IFS= read -r user_home; do
            add_home_candidate "$user_home"
        done < <(find /home -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi

    [ -n "\${NVM_BIN:-}" ] && candidates+=("$NVM_BIN/codex")
    local h
    for h in "\${home_candidates[@]}"; do
        candidates+=(
            "$h/.local/bin/codex"
            "$h/.npm-global/bin/codex"
            "$h/.cargo/bin/codex"
        )
    done

    if command -v node >/dev/null 2>&1; then
        local node_dir
        node_dir="$(dirname "$(command -v node)")"
        candidates+=("$node_dir/codex")
    fi

    for h in "\${home_candidates[@]}"; do
        if [ -d "$h/.nvm/versions/node" ]; then
            while IFS= read -r candidate; do
                candidates+=("$candidate/codex")
            done < <(find "$h/.nvm/versions/node" -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -r)
        fi
    done

    local candidate
    for candidate in "\${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            export PATH="$(dirname "$candidate"):$PATH"
            export CODEX_BIN="$candidate"
            echo "$candidate"
            return 0
        fi
    done

    return 1
}

get_node_major_version() {
    local node_bin="$1"
    [ -x "$node_bin" ] || return 1
    "$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -dc '0-9'
}

find_compatible_node_bin() {
    local minimum_major="\${1:-20}"
    local candidates=()
    local home_candidates=()
    local dedup_homes=""
    local dedup_candidates=""

    add_node_home_candidate() {
        local h="$1"
        [ -z "$h" ] && return
        case "|$dedup_homes|" in
            *"|$h|"*) return ;;
        esac
        dedup_homes="$dedup_homes|$h"
        home_candidates+=("$h")
    }

    add_node_bin_candidate() {
        local candidate="$1"
        [ -z "$candidate" ] && return
        case "|$dedup_candidates|" in
            *"|$candidate|"*) return ;;
        esac
        dedup_candidates="$dedup_candidates|$candidate"
        candidates+=("$candidate")
    }

    [ -n "\${NVM_BIN:-}" ] && add_node_bin_candidate "$NVM_BIN/node"
    if command -v node >/dev/null 2>&1; then
        add_node_bin_candidate "$(command -v node)"
    fi

    add_node_home_candidate "$HOME"
    [ -n "\${SUDO_USER:-}" ] && add_node_home_candidate "/home/$SUDO_USER"

    if [ -d /home ]; then
        while IFS= read -r user_home; do
            add_node_home_candidate "$user_home"
        done < <(find /home -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi

    local h
    for h in "\${home_candidates[@]}"; do
        add_node_bin_candidate "$h/.nvm/current/bin/node"
        if [ -d "$h/.nvm/versions/node" ]; then
            while IFS= read -r candidate; do
                add_node_bin_candidate "$candidate/node"
            done < <(find "$h/.nvm/versions/node" -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -r)
        fi
    done

    local candidate major
    for candidate in "\${candidates[@]}"; do
        [ -x "$candidate" ] || continue
        major=$(get_node_major_version "$candidate")
        if [ -n "$major" ] && [ "$major" -ge "$minimum_major" ]; then
            echo "$candidate"
            return 0
        fi
    done

    return 1
}

ensure_gemini_node_compat() {
    local minimum_major=20
    local compatible_node
    compatible_node=$(find_compatible_node_bin "$minimum_major") || return 1

    local compatible_dir
    compatible_dir="$(dirname "$compatible_node")"
    export PATH="$compatible_dir:$PATH"
    hash -r
    export GEMINI_NODE_BIN="$compatible_node"
    return 0
}

gemini_supports_explicit_model_selection() {
    # Gemini CLI model pinning is reliable when using API-key/Vertex-backed auth.
    # Google-account sign-in works best with the CLI default model selection flow.
    if [ -n "\${GEMINI_API_KEY:-}" ] || [ -n "\${GOOGLE_API_KEY:-}" ] || [ "\${GOOGLE_GENAI_USE_VERTEXAI:-}" = "true" ]; then
        return 0
    fi
    return 1
}

# Load allowed permissions (read once at startup, never modified during runtime)
ALLOWED_PERMISSIONS=""
load_allowed_permissions() {
    if [ -f "$ALLOWED_PERMS_FILE" ]; then
        ALLOWED_PERMISSIONS=$(cat "$ALLOWED_PERMS_FILE")
        log INFO "Loaded allowed permissions from $ALLOWED_PERMS_FILE"
    else
        log WARN "No allowed permissions file found - all options allowed"
        ALLOWED_PERMISSIONS="{}"
    fi
}

# Load dynamic config from file (called at start of each loop iteration)
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        local new_provider new_model new_approval new_sandbox new_project_path new_cmd_preview new_thinking_effort
        new_provider=$(jq -r '.model_provider // empty' "$CONFIG_FILE" 2>/dev/null)
        new_model=$(jq -r '.model // empty' "$CONFIG_FILE" 2>/dev/null)
        new_approval=$(jq -r '.approval_mode // empty' "$CONFIG_FILE" 2>/dev/null)
        new_sandbox=$(jq -r '.sandbox_mode // empty' "$CONFIG_FILE" 2>/dev/null)
        new_project_path=$(jq -r '.project_path // empty' "$CONFIG_FILE" 2>/dev/null)
        new_cmd_preview=$(jq -r '.debug_send_command_preview // empty' "$CONFIG_FILE" 2>/dev/null)
        new_thinking_effort=$(jq -r '.thinking_effort // empty' "$CONFIG_FILE" 2>/dev/null)
        
        # Update if values exist
        [ -n "$new_provider" ] && MODEL_PROVIDER="$new_provider"
        [ -n "$new_model" ] && MODEL="$new_model"
        [ -n "$new_approval" ] && APPROVAL_MODE="$new_approval"
        [ -n "$new_sandbox" ] && SANDBOX_MODE="$new_sandbox"
        # Only override PROJECT_ROOT if the configured path actually exists on
        # this machine. Otherwise the config may carry a stale server-side path
        # (e.g. a CoS installed on a different machine where the server lives
        # in /home/ubuntu/projects/AgentsMCPspace) and the cd "$PROJECT_ROOT"
        # later in run_agent_command would fail with 'No such file or directory'.
        if [ -n "$new_project_path" ] && [ -d "$new_project_path" ]; then
            PROJECT_ROOT="$new_project_path"
        elif [ -n "$new_project_path" ] && [ "$new_project_path" != "$PROJECT_ROOT" ]; then
            log WARN "Configured project_path '$new_project_path' does not exist on this machine; keeping default '$PROJECT_ROOT'"
        fi
        [ -n "$new_cmd_preview" ] && DEBUG_SEND_COMMAND_PREVIEW="$new_cmd_preview"
        [ -n "$new_thinking_effort" ] && THINKING_EFFORT="$new_thinking_effort"
    fi
    return 0
}

# Per-message run settings (provider/model/effort/permissions). message_helper.py
# writes them when the oldest unread message was queued with overrides.
RUN_OVERRIDES_FILE="$STATE_DIR/.run_overrides.json"
SAVED_RUN_CONFIG=()

apply_run_overrides() {
    [ -f "$RUN_OVERRIDES_FILE" ] || return 1
    command -v jq >/dev/null 2>&1 || { rm -f "$RUN_OVERRIDES_FILE"; return 1; }
    local ov_provider ov_model ov_approval ov_sandbox ov_effort
    ov_provider=$(jq -r '.model_provider // empty' "$RUN_OVERRIDES_FILE" 2>/dev/null)
    ov_model=$(jq -r '.model // empty' "$RUN_OVERRIDES_FILE" 2>/dev/null)
    ov_approval=$(jq -r '.approval_mode // empty' "$RUN_OVERRIDES_FILE" 2>/dev/null)
    ov_sandbox=$(jq -r '.sandbox_mode // empty' "$RUN_OVERRIDES_FILE" 2>/dev/null)
    ov_effort=$(jq -r '.thinking_effort // empty' "$RUN_OVERRIDES_FILE" 2>/dev/null)
    rm -f "$RUN_OVERRIDES_FILE"
    [ -z "$ov_provider$ov_model$ov_approval$ov_sandbox$ov_effort" ] && return 1

    SAVED_RUN_CONFIG=("$MODEL_PROVIDER" "$MODEL" "$APPROVAL_MODE" "$SANDBOX_MODE" "\${THINKING_EFFORT:-}")
    [ -n "$ov_provider" ] && MODEL_PROVIDER="$ov_provider"
    [ -n "$ov_model" ] && MODEL="$ov_model"
    [ -n "$ov_approval" ] && APPROVAL_MODE="$ov_approval"
    [ -n "$ov_sandbox" ] && SANDBOX_MODE="$ov_sandbox"
    [ -n "$ov_effort" ] && THINKING_EFFORT="$ov_effort"

    if ! validate_config; then
        log WARN "Per-message run settings rejected by local permissions; using agent config"
        restore_run_overrides
        return 1
    fi
    log INFO "Applying per-message run settings: provider=$MODEL_PROVIDER, model=$MODEL, approval=$APPROVAL_MODE, sandbox=$SANDBOX_MODE, effort=\${THINKING_EFFORT:-default}"
    return 0
}

restore_run_overrides() {
    [ "\${#SAVED_RUN_CONFIG[@]}" -eq 5 ] || return 0
    MODEL_PROVIDER="\${SAVED_RUN_CONFIG[0]}"
    MODEL="\${SAVED_RUN_CONFIG[1]}"
    APPROVAL_MODE="\${SAVED_RUN_CONFIG[2]}"
    SANDBOX_MODE="\${SAVED_RUN_CONFIG[3]}"
    THINKING_EFFORT="\${SAVED_RUN_CONFIG[4]}"
    SAVED_RUN_CONFIG=()
}

# Fetch config from API (allows frontend to update settings dynamically)
# NOTE: project_path is NOT fetched from API - it's only set via CLI at agent creation
fetch_config_from_api() {
    cd "$SCRIPT_DIR"
    local config_json
    config_json=$(uv run message_helper.py config 2>/dev/null || echo "{}")
    
    # Skip if empty or error
    if [ -z "$config_json" ] || [ "$config_json" = "{}" ]; then
        return 0
    fi
    
    # Parse config values (project_path intentionally excluded - security)
    local api_provider api_model api_approval api_sandbox api_cmd_preview api_thinking_effort
    api_provider=$(echo "$config_json" | jq -r '.model_provider // empty' 2>/dev/null)
    api_model=$(echo "$config_json" | jq -r '.model // empty' 2>/dev/null)
    api_approval=$(echo "$config_json" | jq -r '.approval_mode // empty' 2>/dev/null)
    api_sandbox=$(echo "$config_json" | jq -r '.sandbox_mode // empty' 2>/dev/null)
    api_cmd_preview=$(echo "$config_json" | jq -r '.debug_send_command_preview // empty' 2>/dev/null)
    api_thinking_effort=$(echo "$config_json" | jq -r '.thinking_effort // empty' 2>/dev/null)
    
    # Update if values exist (API takes precedence for these settings)
    [ -n "$api_provider" ] && MODEL_PROVIDER="$api_provider"
    [ -n "$api_model" ] && MODEL="$api_model"
    [ -n "$api_approval" ] && APPROVAL_MODE="$api_approval"
    [ -n "$api_sandbox" ] && SANDBOX_MODE="$api_sandbox"
    [ -n "$api_cmd_preview" ] && DEBUG_SEND_COMMAND_PREVIEW="$api_cmd_preview"
    [ -n "$api_thinking_effort" ] && THINKING_EFFORT="$api_thinking_effort"
    
    log INFO "Fetched config from API: provider=$MODEL_PROVIDER, approval=$APPROVAL_MODE, sandbox=$SANDBOX_MODE"
}

sync_models_to_backend() {
    local provider="$1"
    local models_text="\${2:-}"

    [ -z "$provider" ] && return 0
    [ -z "$models_text" ] && return 0
    command -v jq >/dev/null 2>&1 || return 0

    local payload
    payload=$(printf '%s\n' "$models_text" | jq -R . | jq -s --arg provider "$provider" --arg source "cli-online" \
        '{provider:$provider, source:$source, models:.}' 2>/dev/null) || return 0

    [ -z "$payload" ] && return 0
    curl -sL --connect-timeout 5 --max-time 10 -X POST \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$API_BASE/agent/models/sync" >/dev/null 2>&1 || true
}

auto_sync_all_installed_providers_models() {
    command -v node >/dev/null 2>&1 || return 0
    CHATSPACE_MODEL_PROVIDER="\${1:-}" CHATSPACE_MODEL_API_BASE="$API_BASE" CHATSPACE_MODEL_API_KEY="$API_KEY" node <<'CHATSPACE_MODEL_DISCOVERY'
${modelDiscoverySource}
main().catch(() => { process.exitCode = 1; });
CHATSPACE_MODEL_DISCOVERY
}

# Reset remembered config error state after a valid config cycle.
reset_config_error_state() {
    LAST_CONFIG_ERROR=""
    LAST_CONFIG_ERROR_AT=0
}

# Send at most CONFIG_ERROR_WINDOW_LIMIT config-error notifications per
# CONFIG_ERROR_WINDOW_SECONDS, and suppress duplicate error keys within
# CONFIG_ERROR_REPEAT_COOLDOWN seconds.
report_config_error() {
    local error_key="$1"
    local message="$2"
    local priority="\${3:-1}"
    local now
    now=$(date +%s)

    # Suppress duplicate alerts for the same error key within cooldown.
    if [ "$LAST_CONFIG_ERROR" = "$error_key" ] && \
       [ $((now - LAST_CONFIG_ERROR_AT)) -lt "$CONFIG_ERROR_REPEAT_COOLDOWN" ]; then
        log WARN "Duplicate config error suppressed: $error_key"
        return 1
    fi

    # Reset rolling window.
    if [ "$CONFIG_ERROR_WINDOW_STARTED_AT" -eq 0 ] || \
       [ $((now - CONFIG_ERROR_WINDOW_STARTED_AT)) -ge "$CONFIG_ERROR_WINDOW_SECONDS" ]; then
        CONFIG_ERROR_WINDOW_STARTED_AT="$now"
        CONFIG_ERROR_WINDOW_COUNT=0
        CONFIG_ERROR_RATE_LIMIT_HIT_AT=0
    fi

    # Hard cap on outbound config errors in the rolling window.
    if [ "$CONFIG_ERROR_WINDOW_COUNT" -ge "$CONFIG_ERROR_WINDOW_LIMIT" ]; then
        if [ "$CONFIG_ERROR_RATE_LIMIT_HIT_AT" -eq 0 ] || \
           [ $((now - CONFIG_ERROR_RATE_LIMIT_HIT_AT)) -ge "$CONFIG_ERROR_WINDOW_SECONDS" ]; then
            CONFIG_ERROR_RATE_LIMIT_HIT_AT="$now"
            log WARN "Config error notifications throttled (limit=$CONFIG_ERROR_WINDOW_LIMIT per \${CONFIG_ERROR_WINDOW_SECONDS}s)"
        fi
        return 1
    fi

    CONFIG_ERROR_WINDOW_COUNT=$((CONFIG_ERROR_WINDOW_COUNT + 1))
    LAST_CONFIG_ERROR="$error_key"
    LAST_CONFIG_ERROR_AT="$now"
    send_error_message "$message" "$priority"
    return 0
}

# Validate config against allowed permissions
# Returns 0 if valid, 1 if invalid (and sends error message)
validate_config() {
    # If no permissions file or empty, allow all
    if [ -z "$ALLOWED_PERMISSIONS" ] || [ "$ALLOWED_PERMISSIONS" = "{}" ]; then
        reset_config_error_state
        return 0
    fi
    
    # Map 'default' to 'codex' for permission checking (they are equivalent)
    local check_provider="$MODEL_PROVIDER"
    if [ "$check_provider" = "default" ]; then
        check_provider="codex"
    fi
    
    # Check if provider is in allowed list
    local provider_allowed
    provider_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".\\"$check_provider\\" // empty" 2>/dev/null)
    
    if [ -z "$provider_allowed" ]; then
        if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ]; then
            log ERROR "Selected shared provider '$check_provider' is not enabled by the owner's permissions"
            return 1
        fi
        local allowed_list
        allowed_list=$(echo "$ALLOWED_PERMISSIONS" | jq -r '[keys[] | select(. != "inter_agent" and . != "project_path")] | join(", ")' 2>/dev/null)

        # Try to fall back to first allowed provider
        local fallback_provider
        fallback_provider=$(echo "$ALLOWED_PERMISSIONS" | jq -r '[keys[] | select(. != "inter_agent" and . != "project_path")] | first // empty' 2>/dev/null)

        if [ -n "$fallback_provider" ]; then
            log WARN "Provider '$check_provider' not allowed. Falling back to '$fallback_provider'"
            MODEL_PROVIDER="$fallback_provider"
            # Update local config file so it persists
            if [ -f "$CONFIG_FILE" ]; then
                local updated_cfg
                updated_cfg=$(jq --arg p "$fallback_provider" '.model_provider = $p' "$CONFIG_FILE")
                echo "$updated_cfg" > "$CONFIG_FILE"
            fi
            reset_config_error_state
            return 0
        fi

        log ERROR "Provider '$check_provider' is not allowed. Allowed: $allowed_list"
        report_config_error \
            "provider_not_allowed_$check_provider" \
            "❌ Configuration Error: Provider '$check_provider' is not allowed by your permission settings. Allowed providers: $allowed_list. Please update your config using the dashboard." \
            "1" || true
        return 1
    fi
    
    # Validate provider-specific permissions
    case "$check_provider" in
        codex|codex-cli|ollama|openrouter)
            # Check sandbox mode against allowed values
            local sandbox_value="$SANDBOX_MODE"
            [ "$sandbox_value" = "none" ] && sandbox_value="danger-full-access"
            
            local allowed_sandboxes
            allowed_sandboxes=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".\\"$check_provider\\".\\"--sandbox\\" // []" 2>/dev/null)
            
            if [ -n "$allowed_sandboxes" ] && [ "$allowed_sandboxes" != "[]" ] && [ "$allowed_sandboxes" != "null" ]; then
                if ! echo "$allowed_sandboxes" | jq -e "index(\\"$sandbox_value\\")" >/dev/null 2>&1; then
                    local fallback_sandbox
                    fallback_sandbox=$(echo "$allowed_sandboxes" | jq -r 'first // empty' 2>/dev/null)
                    if [ -n "$fallback_sandbox" ]; then
                        local normalized_fallback="$fallback_sandbox"
                        [ "$normalized_fallback" = "danger-full-access" ] && normalized_fallback="none"
                        log WARN "Sandbox mode '$sandbox_value' not allowed. Falling back to '$fallback_sandbox'"
                        SANDBOX_MODE="$normalized_fallback"
                        if [ -f "$CONFIG_FILE" ]; then
                            local updated_cfg
                            updated_cfg=$(jq --arg s "$SANDBOX_MODE" '.sandbox_mode = $s' "$CONFIG_FILE")
                            echo "$updated_cfg" > "$CONFIG_FILE"
                        fi
                    else
                        local sandbox_list
                        sandbox_list=$(echo "$allowed_sandboxes" | jq -r 'join(", ")' 2>/dev/null)
                        log ERROR "Sandbox mode '$sandbox_value' not allowed. Allowed: $sandbox_list"
                        report_config_error \
                            "sandbox_not_allowed_\${check_provider}_\${sandbox_value}" \
                            "❌ Configuration Error: Sandbox mode '$sandbox_value' is not allowed. Allowed modes: $sandbox_list. Please update your config." \
                            "1" || true
                        return 1
                    fi
                fi
            fi
            
            # Check bypass flag (full-auto + no sandbox)
            if [ "$APPROVAL_MODE" = "full-auto" ] && [ "$SANDBOX_MODE" = "none" ]; then
                local bypass_allowed
                bypass_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".\\"$check_provider\\".\\"--dangerously-bypass-approvals-and-sandbox\\" // false" 2>/dev/null)
                if [ "$bypass_allowed" != "true" ]; then
                    log ERROR "Full bypass mode not allowed"
                    report_config_error \
                        "bypass_not_allowed_$check_provider" \
                        "❌ Configuration Error: Full bypass mode (--dangerously-bypass-approvals-and-sandbox) is not allowed by your permissions." \
                        "1" || true
                    return 1
                fi
            fi
            ;;
        antigravity)
            local sandbox_value="$SANDBOX_MODE"
            [ "$sandbox_value" = "none" ] && sandbox_value="danger-full-access"

            local allowed_sandboxes
            allowed_sandboxes=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".antigravity.\\"--sandbox\\" // []" 2>/dev/null)

            if [ -n "$allowed_sandboxes" ] && [ "$allowed_sandboxes" != "[]" ] && [ "$allowed_sandboxes" != "null" ]; then
                if ! echo "$allowed_sandboxes" | jq -e "index(\\"$sandbox_value\\")" >/dev/null 2>&1; then
                    local fallback_sandbox
                    fallback_sandbox=$(echo "$allowed_sandboxes" | jq -r 'first // empty' 2>/dev/null)
                    if [ -n "$fallback_sandbox" ]; then
                        local normalized_fallback="$fallback_sandbox"
                        [ "$normalized_fallback" = "danger-full-access" ] && normalized_fallback="none"
                        log WARN "Antigravity sandbox mode '$sandbox_value' not allowed. Falling back to '$fallback_sandbox'"
                        SANDBOX_MODE="$normalized_fallback"
                        if [ -f "$CONFIG_FILE" ]; then
                            local updated_cfg
                            updated_cfg=$(jq --arg s "$SANDBOX_MODE" '.sandbox_mode = $s' "$CONFIG_FILE")
                            echo "$updated_cfg" > "$CONFIG_FILE"
                        fi
                    else
                        local sandbox_list
                        sandbox_list=$(echo "$allowed_sandboxes" | jq -r 'join(", ")' 2>/dev/null)
                        report_config_error \
                            "antigravity_sandbox_not_allowed_\${sandbox_value}" \
                            "❌ Configuration Error: Antigravity sandbox mode '$sandbox_value' is not allowed. Allowed modes: $sandbox_list." \
                            "1" || true
                        return 1
                    fi
                fi
            fi

            if [ "$APPROVAL_MODE" = "full-auto" ] && [ "$SANDBOX_MODE" = "none" ]; then
                local skip_allowed
                skip_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".antigravity.\\"--dangerously-skip-permissions\\" // false" 2>/dev/null)
                if [ "$skip_allowed" != "true" ]; then
                    report_config_error \
                        "antigravity_skip_permissions_not_allowed" \
                        "❌ Configuration Error: Antigravity skip-permissions mode (--dangerously-skip-permissions) is not allowed." \
                        "1" || true
                    return 1
                fi
            fi
            ;;
        claude)
            # Check permission mode
            local allowed_modes
            allowed_modes=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".claude.\\"--permission-mode\\" // []" 2>/dev/null)

            if [ -n "$allowed_modes" ] && [ "$allowed_modes" != "[]" ] && [ "$allowed_modes" != "null" ]; then
                # Map generic approval_mode values to claude permission-mode equivalents
                local check_mode="$APPROVAL_MODE"
                case "$check_mode" in
                    full-auto)  check_mode="bypassPermissions" ;;
                    auto-edit)  check_mode="acceptEdits" ;;
                esac
                if ! echo "$allowed_modes" | jq -e "index(\\"$check_mode\\")" >/dev/null 2>&1; then
                    local mode_list
                    mode_list=$(echo "$allowed_modes" | jq -r 'join(", ")' 2>/dev/null)
                    log ERROR "Permission mode '$APPROVAL_MODE' not allowed. Allowed: $mode_list"
                    report_config_error \
                        "permission_mode_not_allowed_\${check_provider}_\${APPROVAL_MODE}" \
                        "❌ Configuration Error: Permission mode '$APPROVAL_MODE' is not allowed. Allowed modes: $mode_list." \
                        "1" || true
                    return 1
                fi
            fi
            
            # Check skip permissions (sandbox_mode = none means skip all)
            if [ "$SANDBOX_MODE" = "none" ]; then
                local skip_allowed
                skip_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".claude.\\"--dangerously-skip-permissions\\" // false" 2>/dev/null)
                if [ "$skip_allowed" != "true" ]; then
                    log ERROR "Skip permissions not allowed"
                    report_config_error \
                        "skip_permissions_not_allowed_claude" \
                        "❌ Configuration Error: Skip permissions mode (--dangerously-skip-permissions) is not allowed." \
                        "1" || true
                    return 1
                fi
            fi
            ;;
        gemini)
            # Check sandbox/no-sandbox
            if [ "$SANDBOX_MODE" = "none" ]; then
                local no_sandbox_allowed
                no_sandbox_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".gemini.\\"--no-sandbox\\" // false" 2>/dev/null)
                if [ "$no_sandbox_allowed" != "true" ]; then
                    log ERROR "No-sandbox mode not allowed for Gemini"
                    report_config_error \
                        "gemini_no_sandbox_not_allowed" \
                        "❌ Configuration Error: No-sandbox mode is not allowed for Gemini." \
                        "1" || true
                    return 1
                fi
            else
                local sandbox_allowed
                sandbox_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".gemini.\\"--sandbox\\" // false" 2>/dev/null)
                if [ "$sandbox_allowed" != "true" ]; then
                    log ERROR "Sandbox mode not allowed for Gemini"
                    report_config_error \
                        "gemini_sandbox_not_allowed" \
                        "❌ Configuration Error: Sandbox mode is not allowed for Gemini." \
                        "1" || true
                    return 1
                fi
            fi
            
            # Check yolo mode
            if [ "$APPROVAL_MODE" = "full-auto" ]; then
                local yolo_allowed
                yolo_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".gemini.\\"--yolo\\" // false" 2>/dev/null)
                if [ "$yolo_allowed" != "true" ]; then
                    log ERROR "YOLO mode not allowed for Gemini"
                    report_config_error \
                        "gemini_yolo_not_allowed" \
                        "❌ Configuration Error: YOLO mode (--yolo) is not allowed for Gemini." \
                        "1" || true
                    return 1
                fi
            fi
            ;;
        copilot)
            # Check allow-all permissions
            if [ "$SANDBOX_MODE" = "none" ] && [ "$APPROVAL_MODE" = "full-auto" ]; then
                local allow_all_allowed
                allow_all_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".copilot.\\"--allow-all\\" // false" 2>/dev/null)
                if [ "$allow_all_allowed" != "true" ]; then
                    # Check individual flags
                    local tools_allowed paths_allowed
                    tools_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".copilot.\\"--allow-all-tools\\" // false" 2>/dev/null)
                    paths_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".copilot.\\"--allow-all-paths\\" // false" 2>/dev/null)
                    if [ "$tools_allowed" != "true" ] || [ "$paths_allowed" != "true" ]; then
                        log ERROR "Full access mode not allowed for Copilot"
                        report_config_error \
                            "copilot_full_access_not_allowed" \
                            "❌ Configuration Error: Full access mode (--allow-all) is not allowed for Copilot." \
                            "1" || true
                        return 1
                    fi
                fi
            fi
            ;;
        kilo)
            # Kilo uses --auto for non-interactive autonomous mode
            if [ "$APPROVAL_MODE" = "full-auto" ]; then
                local auto_allowed
                auto_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".kilo.\\"--auto\\" // false" 2>/dev/null)
                if [ "$auto_allowed" != "true" ]; then
                    log ERROR "Auto mode not allowed for Kilo"
                    report_config_error \
                        "kilo_auto_not_allowed" \
                        "❌ Configuration Error: Auto mode (--auto) is not allowed for Kilo." \
                        "1" || true
                    return 1
                fi
            fi
            ;;
    esac
    
    reset_config_error_state
    return 0
}

# Check if stop was requested
check_stop_flag() {
    [ -f "$STOP_FLAG" ]
}

# Check if a restart was requested (written by CoS PATCH /instructions with
# restart=true). Restarting re-execs this script in place so it picks up the
# updated AGENT_INSTRUCTIONS.md, .env, agent_config.json, and runner code.
check_restart_flag() {
    [ -f "$RESTART_FLAG" ]
}

acknowledge_stop_request() {
    if ! command -v curl >/dev/null 2>&1; then
        return 1
    fi

    if [ -z "\${API_BASE:-}" ] || [ -z "\${API_KEY:-}" ] || [ -z "\${AGENT_NAME:-}" ]; then
        return 1
    fi

    local payload
    payload=$(jq -nc \
        --arg agent "$AGENT_NAME" \
        '{agentName:$agent}' 2>/dev/null || echo "")
    if [ -z "$payload" ]; then
        return 1
    fi

    local response
    response=$(curl -sS -X POST "$API_BASE/agent/stop/acknowledge" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: $API_KEY" \
        -d "$payload" 2>/dev/null || true)

    if echo "$response" | jq -e '.acknowledged == true' >/dev/null 2>&1; then
        mark_successful_backend_connection
        return 0
    fi

    return 1
}

queue_stop_summary_wakeup() {
    local summary_text=""
    local interrupted_output=""

    if [ -f "$SUMMARY_FILE" ]; then
        summary_text=$(cat "$SUMMARY_FILE" 2>/dev/null || echo "")
    fi

    if [ -f "$LAST_INTERRUPTED_OUTPUT_FILE" ]; then
        interrupted_output=$(cat "$LAST_INTERRUPTED_OUTPUT_FILE" 2>/dev/null || echo "")
        rm -f "$LAST_INTERRUPTED_OUTPUT_FILE"
    fi

    cat > "$SELF_WAKE_FILE" <<EOF
STOP SUMMARY TASK:
A stop command was just honored for this agent.
Do not continue the interrupted task and do not start new work.
Reply to the user immediately with one concise status update that:
- confirms the stop request was received and the agent is now stopped
- summarizes the most important completed work so far
- states the current status at the moment of stopping
- calls out the main unfinished item or blocker, if any
- mentions if the stop interrupted active work

Use the facts below. If something is uncertain, say that clearly.

Current summary:
$summary_text

Last interrupted output:
\${interrupted_output:-No active CLI task was interrupted.}
EOF
}

handle_restart() {
    log WARN "Restart requested — re-executing agent runner"
    # Best-effort: kill any running provider process so we exit cleanly.
    if [ -f "$AGENT_PID_FILE" ]; then
        local agent_pid
        agent_pid=$(cat "$AGENT_PID_FILE")
        if kill -0 "$agent_pid" 2>/dev/null; then
            kill "$agent_pid" 2>/dev/null || true
            wait "$agent_pid" 2>/dev/null || true
        fi
        rm -f "$AGENT_PID_FILE"
    fi

    send_working_heartbeat "false" || true
    rm -f "$RESTART_FLAG"
    # Re-exec with the original arguments so we keep the same launch context.
    exec "$0" "\${RUNNER_ORIG_ARGS[@]}"
}

# Track repeated stop requests in a short window.
record_stop_event() {
    local now
    now=$(date +%s)

    if [ "$LAST_STOP_HANDLED_AT" -gt 0 ] && [ $((now - LAST_STOP_HANDLED_AT)) -le "$STOP_FAILSAFE_WINDOW_SECONDS" ]; then
        STOP_HANDLE_COUNT=$((STOP_HANDLE_COUNT + 1))
    else
        STOP_HANDLE_COUNT=1
    fi

    LAST_STOP_HANDLED_AT="$now"
}

activate_stop_failsafe_if_needed() {
    if [ "$STOP_HANDLE_COUNT" -lt "$STOP_FAILSAFE_MAX_HITS" ]; then
        return 1
    fi

    log WARN "Failsafe activated after repeated stop requests ($STOP_HANDLE_COUNT in $STOP_FAILSAFE_WINDOW_SECONDS s)"
    send_message "🛑 Failsafe activated: repeated stop requests detected. Agent is shutting down (will remain in dashboard as offline)." "2" || true

    send_working_heartbeat "false" || true
    rm -f "$AGENT_PID_FILE" "$STOP_FLAG" "$RUNNING_FLAG"
    log WARN "Agent stopped via stop failsafe (not archived — agent remains in dashboard)"
    exit 0
}

# Handle stop request - kill running agent, clear the stop latch, and queue a
# one-shot status reply so the user gets a concise final summary.
handle_stop() {
    log WARN "Stop requested by user"
    record_stop_event
    
    # Kill running agent process if exists
    if [ -f "$AGENT_PID_FILE" ]; then
        local agent_pid
        agent_pid=$(cat "$AGENT_PID_FILE")
        if kill -0 "$agent_pid" 2>/dev/null; then
            log INFO "Killing agent process $agent_pid"
            kill "$agent_pid" 2>/dev/null || true
            wait "$agent_pid" 2>/dev/null || true
        fi
        rm -f "$AGENT_PID_FILE"
    fi

    activate_stop_failsafe_if_needed || true
    send_working_heartbeat "false" || true
    rm -f "$STOP_FLAG"

    if acknowledge_stop_request; then
        log INFO "Cleared backend stop request latch"
    else
        log WARN "Could not clear backend stop request latch immediately"
    fi

    if queue_stop_summary_wakeup; then
        log SUCCESS "Agent stopped, queued final stop-status reply"
    else
        send_message "⏹ Agent stopped. Waiting for new instructions." "0" || true
        log WARN "Failed to queue stop summary; sent fallback stopped message"
    fi
}

cleanup() {
    log INFO "Shutting down agent runner..."
    
    # Kill any running agent process
    if [ -f "$AGENT_PID_FILE" ]; then
        local agent_pid
        agent_pid=$(cat "$AGENT_PID_FILE")
        if kill -0 "$agent_pid" 2>/dev/null; then
            kill "$agent_pid" 2>/dev/null || true
        fi
        rm -f "$AGENT_PID_FILE"
    fi
    
    rm -f "$RUNNING_FLAG"
    rm -f "$STOP_FLAG"
    send_working_heartbeat "false" || true
    exit 0
}

trap cleanup SIGINT SIGTERM

check_for_messages() {
    cd "$SCRIPT_DIR"
    # Use check-attachments to download images and get message text
    local received_images_dir="$STATE_DIR/received_images"
    mkdir -p "$received_images_dir"
    local user_messages
    local combined
    local check_exit

    user_messages=$(uv run message_helper.py check-attachments "$received_images_dir" 2>/dev/null)
    check_exit=$?

    # Track last successful backend connection for the no-connection failsafe
    if [ $check_exit -eq 0 ]; then
        mark_successful_backend_connection
    else
        user_messages=""
    fi

    combined=""

    if [ -n "$user_messages" ] && [ "$user_messages" != "No new messages." ]; then
        combined="$user_messages"
    fi

    # Only check for inter-agent DMs if enabled in allowed permissions
    if [ -n "$ALLOWED_PERMISSIONS" ] && [ "$ALLOWED_PERMISSIONS" != "{}" ]; then
        local inter_agent_enabled
        inter_agent_enabled=$(echo "$ALLOWED_PERMISSIONS" | jq -r '.inter_agent.enabled // false' 2>/dev/null)

        if [ "$inter_agent_enabled" = "true" ]; then
            local dm_messages
            dm_messages=$(uv run message_helper.py dm check 2>/dev/null || echo "")

                # Only treat as DM if it looks like actual content (not an error or unsupported command)
                # NOTE: tolerate both old and new "no messages" strings.
                if [ -n "$dm_messages" ] && \
                    [ "$dm_messages" != "No new messages from other agents." ] && \
                    [ "$dm_messages" != "No direct messages from other agents." ] && \
                    ! echo "$dm_messages" | grep -qi "error\\|not supported\\|unknown command\\|usage:"; then
                if [ -n "$combined" ]; then
                    combined+=$'\n'
                fi
                combined+=$'[AGENT DM]\n'"$dm_messages"
            fi
        fi
    fi

    if [ -z "$combined" ]; then
        echo "No new messages."
    else
        echo "$combined"
    fi
}

get_history() {
    cd "$SCRIPT_DIR"
    local history_output
    history_output=$(uv run message_helper.py history 2>/dev/null) || {
        echo "No history available. This is a new session."
        return 0
    }
    mark_successful_backend_connection
    echo "$history_output"
}

has_new_messages() {
    local check_result="$1"
    [ -n "$check_result" ] && [ "$check_result" != "No new messages." ]
}

update_server_poll_interval() {
    local advice_file="$STATE_DIR/.poll_advice.json"
    SERVER_POLL_INTERVAL=0
    if [ -f "$advice_file" ]; then
        local next_ms jitter_ms
        next_ms=$(jq -r '.nextPollMs // 0' "$advice_file" 2>/dev/null || echo "0")
        jitter_ms=$(jq -r '.jitterMs // 0' "$advice_file" 2>/dev/null || echo "0")
        if [[ "$next_ms" =~ ^[0-9]+$ ]] && [ "$next_ms" -gt 0 ]; then
            SERVER_POLL_INTERVAL=$(( (next_ms + 999) / 1000 ))
        fi
        if [[ "$jitter_ms" =~ ^[0-9]+$ ]] && [ "$jitter_ms" -gt 0 ]; then
            local jitter_sec=$(( jitter_ms / 1000 ))
            if [ "$jitter_sec" -gt 0 ]; then
                SERVER_POLL_INTERVAL=$(( SERVER_POLL_INTERVAL + (RANDOM % (jitter_sec + 1)) ))
            fi
        fi
    fi
}

get_next_idle_wait_seconds() {
    local wait_seconds="$POLL_INTERVAL"
    if [ "$IDLE_POLL_STREAK" -ge 5 ]; then
        wait_seconds=$(( POLL_INTERVAL * 4 ))
    elif [ "$IDLE_POLL_STREAK" -ge 2 ]; then
        wait_seconds=$(( POLL_INTERVAL * 2 ))
    fi
    if [ "$SERVER_POLL_INTERVAL" -gt "$wait_seconds" ]; then
        wait_seconds="$SERVER_POLL_INTERVAL"
    fi
    if [ "$wait_seconds" -gt "$POLL_INTERVAL_MAX" ]; then
        wait_seconds="$POLL_INTERVAL_MAX"
    fi
    if [ "$wait_seconds" -lt 1 ]; then
        wait_seconds=1
    fi
    echo "$wait_seconds"
}

send_message() {
    local message="$1"
    local priority="\${2:-0}"
    cd "$SCRIPT_DIR"
    local max_attempts=4
    local attempt=1
    local output=""
    local exit_code=0
    local client_message_id
    client_message_id=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || true)
    export CLIENT_MESSAGE_ID="$client_message_id"

    while [ "$attempt" -le "$max_attempts" ]; do
        output=$(uv run message_helper.py send "$message" --priority "$priority" --use-pending-attachments 2>&1)
        exit_code=$?

        if [ $exit_code -eq 0 ] && ! echo "$output" | grep -q "Failed to send\\|error\\|ERROR"; then
            mark_successful_backend_connection
            log INFO "API Output: $output"
            return 0
        fi

        local retry_after=""
        retry_after=$(echo "$output" | grep -oE "'retryAfter': [0-9]+" | head -n1 | grep -oE "[0-9]+" || true)
        if [ -z "$retry_after" ]; then
            retry_after=$(echo "$output" | grep -oE '"retryAfter"[[:space:]]*:[[:space:]]*[0-9]+' | head -n1 | grep -oE "[0-9]+" || true)
        fi

        if echo "$output" | grep -q "RATE_LIMIT_EXCEEDED" && [ "$attempt" -lt "$max_attempts" ]; then
            if [ -z "$retry_after" ]; then
                retry_after=$((attempt * 5))
            fi
            if [ "$retry_after" -lt 1 ]; then
                retry_after=1
            fi
            log WARN "Rate limited while sending message (attempt $attempt/$max_attempts). Retrying in \${retry_after}s"
            sleep "$retry_after"
            attempt=$((attempt + 1))
            continue
        fi

        break
    done

    log ERROR "Failed to send message after $attempt attempt(s): $output"
    return 1
}

record_error_event() {
    local now
    now=$(date +%s)

    if [ "$ERROR_FAILSAFE_WINDOW_STARTED_AT" -eq 0 ] || \
       [ $((now - ERROR_FAILSAFE_WINDOW_STARTED_AT)) -ge "$ERROR_FAILSAFE_WINDOW_SECONDS" ]; then
        ERROR_FAILSAFE_WINDOW_STARTED_AT="$now"
        ERROR_FAILSAFE_MESSAGE_COUNT=0
    fi

    ERROR_FAILSAFE_MESSAGE_COUNT=$((ERROR_FAILSAFE_MESSAGE_COUNT + 1))
}

activate_error_failsafe_if_needed() {
    if [ "$ERROR_FAILSAFE_MESSAGE_COUNT" -lt "$ERROR_FAILSAFE_MAX_MESSAGES" ]; then
        return 1
    fi

    # Do not permanently take the agent offline for a recoverable provider or
    # configuration problem.  A bounded cooldown stops error spam, then lets
    # the runner retry after an operator changes its config or the provider
    # recovers. This applies equally to Chiefs and normal agents.
    local now
    now=$(date +%s)
    ERROR_COOLDOWN_UNTIL=$((now + ERROR_COOLDOWN_SECONDS))
    log WARN "Error circuit breaker activated after $ERROR_FAILSAFE_MESSAGE_COUNT automated errors in $ERROR_FAILSAFE_WINDOW_SECONDS s; pausing for $ERROR_COOLDOWN_SECONDS s"
    send_message "⚠️ Agent paused automated retries for $ERROR_COOLDOWN_SECONDS seconds after $ERROR_FAILSAFE_MESSAGE_COUNT errors. It will recover automatically; check provider/model configuration if this repeats." "2" || true
    return 0
}

check_no_connection_failsafe() {
    local now
    now=$(date +%s)
    LAST_SUCCESSFUL_CONNECTION=$(get_last_successful_backend_connection)
    local elapsed=$((now - LAST_SUCCESSFUL_CONNECTION))
    if [ "$elapsed" -lt "$NO_CONNECTION_FAILSAFE_SECONDS" ]; then
        NO_CONNECTION_ALERTED="false"
        return 1
    fi

    # Keep attempting recovery instead of silently leaving the agent offline.
    # Log once per outage; the main loop uses a slow retry cadence while the
    # backend remains unavailable.
    if [ "$NO_CONNECTION_ALERTED" != "true" ]; then
        log WARN "Backend has been unreachable for \${elapsed}s (limit=$NO_CONNECTION_FAILSAFE_SECONDS s); continuing with slow recovery retries"
        NO_CONNECTION_ALERTED="true"
    fi
    return 0
}

check_no_connection_giveup() {
    local now
    now=$(date +%s)
    LAST_SUCCESSFUL_CONNECTION=$(get_last_successful_backend_connection)
    local elapsed=$((now - LAST_SUCCESSFUL_CONNECTION))
    if [ "$elapsed" -lt "$NO_CONNECTION_GIVE_UP_SECONDS" ]; then
        NO_CONNECTION_GIVE_UP_ALERTED="false"
        return 1
    fi

    # A full week of an unreachable backend is long enough that further
    # per-minute retries are just wasted cycles. Stop attempting to reach
    # the backend; a manual restart re-baselines LAST_SUCCESSFUL_CONNECTION
    # and resumes normal polling once connectivity is restored.
    if [ "$NO_CONNECTION_GIVE_UP_ALERTED" != "true" ]; then
        log ERROR "Backend unreachable for \${elapsed}s (limit=$NO_CONNECTION_GIVE_UP_SECONDS s); giving up automated retries. Restart the agent once connectivity is restored."
        NO_CONNECTION_GIVE_UP_ALERTED="true"
    fi
    return 0
}

send_error_message() {
    local message="$1"
    local priority="\${2:-1}"
    if ! send_message "$message" "$priority"; then
        return 1
    fi

    record_error_event
    activate_error_failsafe_if_needed || true
    return 0
}

# Send runner heartbeat so backend/frontend can show "agent still working"
# Returns:
#   0  - heartbeat accepted
#   10 - stop requested by backend
#   11 - heartbeat endpoint error (non-fatal)
send_working_heartbeat() {
    local working_flag="\${1:-true}"

    if ! command -v curl >/dev/null 2>&1; then
        return 11
    fi

    if [ -z "\${API_BASE:-}" ] || [ -z "\${API_KEY:-}" ] || [ -z "\${AGENT_NAME:-}" ]; then
        return 11
    fi

    local payload
    payload=$(jq -nc \\
        --arg agent "$AGENT_NAME" \\
        --arg note "$WORKING_HEARTBEAT_NOTE" \\
        --argjson working "$working_flag" \\
        '{agentName:$agent, isWorking:$working, noteType:"working_status", note:$note}' 2>/dev/null || echo "")

    if [ -z "$payload" ]; then
        return 11
    fi

    local response
    response=$(curl -sS -X POST "$API_BASE/agent/heartbeat" \\
        -H "Content-Type: application/json" \\
        -H "X-API-Key: $API_KEY" \\
        -d "$payload" 2>/dev/null || true)

    if [ -z "$response" ]; then
        return 11
    fi

    local stop_requested
    stop_requested=$(echo "$response" | jq -r '.stopRequested // false' 2>/dev/null || echo "false")
    if [ "$stop_requested" = "true" ]; then
        return 10
    fi

    return 0
}

# Run CLI command in background with stop + heartbeat monitoring
# Usage: run_cli_in_background "<stdin_file_or_empty>" "<stdout_capture_path>" "command" "arg1" ...
# Returns: exit code of CLI or 143 if killed by stop
run_cli_in_background() {
    local stdin_file="$1"
    local stdout_capture="$2"
    shift 2
    local cmd_args=("$@")
    local run_with_clean_claude_env="false"

    capture_interrupted_output() {
        local capture_path="$1"
        if [ -f "$capture_path" ]; then
            tail -n 40 "$capture_path" > "$LAST_INTERRUPTED_OUTPUT_FILE" 2>/dev/null || true
        fi
    }

    if [ "\${#cmd_args[@]}" -gt 0 ] && [ "\${cmd_args[0]}" = "claude" ]; then
        run_with_clean_claude_env="true"
    fi

    if [ "$run_with_clean_claude_env" = "true" ]; then
        cmd_args=(env -u CLAUDECODE "\${cmd_args[@]}")
    fi

    # Shared replies carry structured recipients. Preserve the complete stdout
    # and keep diagnostics on stderr instead of truncating/mixing the JSON.
    if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ]; then
        if [ -n "$stdin_file" ]; then
            "\${cmd_args[@]}" < "$stdin_file" > "$stdout_capture" &
        else
            "\${cmd_args[@]}" > "$stdout_capture" &
        fi
    else
        if [ -n "$stdin_file" ]; then
            "\${cmd_args[@]}" < "$stdin_file" > >(tee "$stdout_capture") 2>&1 &
        else
            "\${cmd_args[@]}" > >(tee "$stdout_capture") 2>&1 &
        fi
    fi
    local cli_pid=$!

    # Save PID for stop handling
    echo "$cli_pid" > "$AGENT_PID_FILE"

    log INFO "CLI started with PID $cli_pid"

    # Initial heartbeat so frontend shows working indicator quickly
    send_working_heartbeat "true" || true

    local heartbeat_elapsed=0

    # Poll while CLI is running
    while kill -0 "$cli_pid" 2>/dev/null; do
        # Check for stop flag
        if check_stop_flag; then
            log WARN "Stop requested - killing CLI process $cli_pid"
            capture_interrupted_output "$stdout_capture"
            kill "$cli_pid" 2>/dev/null || true
            wait "$cli_pid" 2>/dev/null || true
            rm -f "$AGENT_PID_FILE"
            return 143  # SIGTERM exit code
        fi

        # Periodic heartbeat + backend stop check
        if [ "$heartbeat_elapsed" -ge "$WORKING_HEARTBEAT_INTERVAL" ]; then
            if ! send_working_heartbeat "true"; then
                local hb_code=$?
                if [ "$hb_code" -eq 10 ]; then
                    log WARN "Stop requested by backend heartbeat - killing CLI process $cli_pid"
                    if [ ! -f "$STOP_FLAG" ]; then
                        date -Iseconds > "$STOP_FLAG"
                    fi
                    capture_interrupted_output "$stdout_capture"
                    kill "$cli_pid" 2>/dev/null || true
                    wait "$cli_pid" 2>/dev/null || true
                    rm -f "$AGENT_PID_FILE"
                    return 143
                fi
            fi
            heartbeat_elapsed=0
        fi

        sleep 1
        heartbeat_elapsed=$((heartbeat_elapsed + 1))
    done

    # Wait for process to finish and get exit code
    wait "$cli_pid" 2>/dev/null
    local exit_code=$?

    rm -f "$AGENT_PID_FILE"
    send_working_heartbeat "false" || true
    if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ] && [ "$exit_code" -eq 0 ] &&
       [ ! -s "$AGENT_RESPONSE_FILE" ] && [ -s "$stdout_capture" ]; then
        if [ "$run_with_clean_claude_env" = "true" ]; then
            # Claude's text stream includes intermediate tool progress. Its
            # JSON result contains only the final answer, outside that stream.
            if ! jq -er 'select(.type == "result" and .is_error != true) | .result | select(type == "string" and length > 0)' "$stdout_capture" > "$AGENT_RESPONSE_FILE"; then
                rm -f "$AGENT_RESPONSE_FILE"
                log ERROR "Claude did not return a successful final reply"
                return 1
            fi
        else
            cp "$stdout_capture" "$AGENT_RESPONSE_FILE"
        fi
    fi
    return $exit_code
}

check_scheduled_tasks() {
    if [ ! -f "$SCHEDULED_TASKS_FILE" ]; then
        echo ""
        return
    fi
    
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    local due_task
    due_task=$(jq -r --arg now "$now" '
        map(select(.run_at <= $now)) | 
        sort_by(.priority) | 
        reverse | 
        first // empty |
        .task
    ' "$SCHEDULED_TASKS_FILE" 2>/dev/null || echo "")
    
    echo "$due_task"
}

process_scheduled_task() {
    local task="$1"
    local temp_file
    temp_file=$(mktemp)
    jq --arg task "$task" 'map(select(.task != $task))' "$SCHEDULED_TASKS_FILE" > "$temp_file" 2>/dev/null
    mv "$temp_file" "$SCHEDULED_TASKS_FILE"
}

self_wakeup_pending() {
    [ -s "$SELF_WAKE_FILE" ]
}

consume_self_wakeup() {
    if [ ! -s "$SELF_WAKE_FILE" ]; then
        echo ""
        return
    fi

    local temp_file="$STATE_DIR/.self_wakeup.processing.$$"
    if ! mv "$SELF_WAKE_FILE" "$temp_file" 2>/dev/null; then
        echo ""
        return
    fi

    local content
    content=$(cat "$temp_file" 2>/dev/null || echo "")
    rm -f "$temp_file"

    if [ -n "$content" ]; then
        printf '%s\n' "$content" > "$STATE_DIR/.self_wakeup.last" 2>/dev/null || true
    fi

    echo "$content"
}

build_agent_prompt() {
    local messages="$1"
    local history="$2"
    local summary=""
    local sandbox_info=""
    
    if [ -f "$SUMMARY_FILE" ]; then
        summary=$(cat "$SUMMARY_FILE")
    fi
    
    # Provide sandbox-specific instructions
    local sandbox_info=""
    local response_instructions=""
    
    if [ "$SANDBOX_MODE" = "none" ]; then
        sandbox_info="You have FULL ACCESS (Network + File System). \\n- You can call external APIs directly.\\n- You can READ and WRITE files anywhere on the system using standard bash commands (cat, grep, sed, echo, etc).\\n- You can execute any command."
        response_instructions="Write your response to $STATE_DIR/.agent_response.txt (format: \\"message\\" or \\"message|priority\\")\\n   Example: echo \\"Task completed\\" > $STATE_DIR/.agent_response.txt"
    elif [ "$SANDBOX_MODE" = "workspace-write" ]; then
        sandbox_info="You have FILE SYSTEM ACCESS (Workspace). \\n- You CANNOT access the network directly.\\n- You can READ and WRITE files within your workspace using standard bash commands.\\n- Use local tools only."
        response_instructions="Write your response to $STATE_DIR/.agent_response.txt (format: \\"message\\" or \\"message|priority\\")\\n   Example: echo \\"Task completed\\" > $STATE_DIR/.agent_response.txt"
    else
        sandbox_info="You are in READ-ONLY SANDBOX mode. You cannot access the network or write files."
        response_instructions="Since you cannot write files, simply output your response as your final message.\\n   Your stdout output will be captured and sent to the user automatically.\\n   Just respond naturally with your answer - no file writing needed."
    fi
    
    cat <<PROMPT
# One-Shot Agent Session

You are $AGENT_NAME, an AI agent running in one-shot mode.

## FIRST: Read Your Instructions
Read these files for detailed guidance:
- $SCRIPT_DIR/AGENT_INSTRUCTIONS.md - How to communicate (commands, priority levels)
- $SCRIPT_DIR/ONESHOT_AGENT_INSTRUCTIONS.md - How one-shot mode works

## Working Directory
- Current directory: $PROJECT_ROOT (main project)
- Agent files location: $SCRIPT_DIR
- Agent state files: $STATE_DIR

## Network Access
$sandbox_info

## Image Handling

### Receiving Images
When the user sends an image, it will be downloaded and appear in the messages like:
  [USER attached image/png] Local file: /path/to/image.png
You can read and process this file using standard tools.

### Sending Images
To send an image to the user, use one of these commands:
  cd $SCRIPT_DIR
  uv run message_helper.py send "Here is the image." --attach /path/to/your/image.png

Or two-step:
  cd $SCRIPT_DIR
  uv run message_helper.py upload /path/to/your/image.png
  uv run message_helper.py send "Here is the image." --use-pending-attachments

IMPORTANT: Uploading alone does NOT render an image in chat.
You must send a message that includes attachmentIds (via --attach or --use-pending-attachments).

IMPORTANT: Do NOT send images as base64 text. Use the upload command.

## Rich HTML Views (Visual Reports, Dashboards, Interactive Forms)
When the user asks for something "visual", a "dashboard", "HTML view", "report", or "form":

Read $SCRIPT_DIR/SKILL_RICH_FORMS.md first. Send rich_html only when you have real, task-specific title/html content.
Never send placeholder fields such as REPLACE_WITH_TITLE or REPLACE_WITH_HTML. If you are unsure, send a normal text reply.

For fallback stdout mode, output the prefix RICH_HTML_JSON: followed by a complete real rich_html JSON object from SKILL_RICH_FORMS.md.

## CRITICAL: How to Execute Commands
You run shell commands directly in bash. Do NOT use tool-call patterns like run_shell_command or delegate_to_agent.
Just execute: cd $SCRIPT_DIR && uv run message_helper.py send "message"

## Inter-Agent DM Handling
If you see messages prefixed with [AGENT DM], these are direct messages from other agents.
You MUST reply to DMs using the dm command — do NOT use send_message (that goes to the user).

To reply to an agent DM:
  cd $SCRIPT_DIR
  uv run message_helper.py dm "<SenderAgentName>" "Your reply message here"

Example: if you see  [SecurityBot]: Please review the deployment config
Reply with:  cd $SCRIPT_DIR && uv run message_helper.py dm "SecurityBot" "I reviewed the config, looks good."

IMPORTANT:
- Extract the sender name from the [SenderName] prefix in the DM
- Always reply via the dm command so the sender receives your response
- You should ALSO write a brief summary to .agent_response.txt (or stdout) so the user sees what happened

## Previous Session Summary
$summary

## Conversation History
$history

## New Messages to Process
$messages

## Your Task
1. Read and understand the messages
2. Take appropriate actions
3. RESPONSE INSTRUCTIONS: 
   $response_instructions
4. Priority levels: 0=Normal, 1=Needs Attention, 2=Urgent

## Important
- If the latest actionable message is from the user, send a real reply to the user chat. Do not send only a news-feed entry.
- Only skip the normal user-chat reply for fire-and-forget confirmation messages from another agent.
- **Duplicate Detection**: If you see the same message in both "Conversation History" and "New Messages to Process", it is the same message. The "New Messages" section contains the triggers that just arrived or triggered this session.
- **Timestamp Awareness**: Check timestamps to understand the order of messages.
- If you can write files, update $STATE_DIR/agent_summary.md before exiting to preserve your state for the next session.
- Answer the user's question directly and concisely
- Never claim a command succeeded unless you actually executed it and saw success output
- For agent-creation requests, run uv run message_helper.py spawn ... and verify output contains agentId
PROMPT
}

run_agent() {
    local prompt="$1"

    # Clear any stale command from a previous run; each provider branch
    # exports the real command right before invoking its CLI.
    export RUN_COMMAND=""

    log INFO "Waking up agent..."
    
    local prompt_file
    prompt_file=$(mktemp)
    echo "$prompt" > "$prompt_file"
    
    # Change to project root directory (agent files stay in SCRIPT_DIR)
    cd "$PROJECT_ROOT"
    
    # Handle different CLI tools based on provider
    case "$MODEL_PROVIDER" in
        claude)
            if ! command -v claude &>/dev/null; then
                log ERROR "Claude CLI is not installed"
                send_error_message "❌ Claude CLI is missing. Please install it with: \`npm install -g @anthropic-ai/claude-code\`" "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use Claude CLI directly
            # -p = print mode (non-interactive), prompt is positional argument
            # Note: Claude doesn't have sandbox modes like Codex - uses permission modes instead
            local claude_args=()
            
            # Add model if specified and not 'default' (Claude CLI uses its own default)
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                claude_args+=("--model" "$MODEL")
            fi

            case "$THINKING_EFFORT" in
                low|medium|high|xhigh|max) claude_args+=("--effort" "$THINKING_EFFORT") ;;
                "") ;;
                *) log WARN "Ignoring unsupported thinking_effort '$THINKING_EFFORT'" ;;
            esac

            # Print mode - non-interactive, reads prompt from stdin
            claude_args+=("-p")
            # Shared callers need the final result, without tool progress.
            if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ]; then
                claude_args+=("--output-format" "json")
            else
                claude_args+=("--output-format" "text")
            fi
            
            # Handle approval/sandbox modes for Claude
            # Claude uses --permission-mode and --dangerously-skip-permissions
            case "$SANDBOX_MODE" in
                none)
                    # Full access - skip all permission checks
                    claude_args+=("--dangerously-skip-permissions")
                    ;;
                workspace-write|read-only)
                    # Claude doesn't have granular sandbox - use permission mode
                    if [ "$APPROVAL_MODE" = "full-auto" ]; then
                        claude_args+=("--permission-mode" "bypassPermissions")
                    elif [ "$APPROVAL_MODE" = "auto-edit" ]; then
                        claude_args+=("--permission-mode" "acceptEdits")
                    fi
                    ;;
            esac
            
            # Build command string for notification
            local cmd_preview="claude"
            for arg in "\${claude_args[@]}"; do
                cmd_preview+=" $arg"
            done
            cmd_preview+=" (prompt from stdin)"

            log INFO "Running: claude \${claude_args[*]} (prompt from stdin)"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "�� Received message, about to run: $cmd_preview" "0"
            fi

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            # Pass prompt via stdin - this handles long multi-line prompts correctly
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" claude "\${claude_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi
            
            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    # First: check if output contains a RICH_HTML_JSON marker
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    else
                        # Filter CLI noise from stdout
                        local filtered_output
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "sandbox" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 30 | \\
                            head -n 20)

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | \\
                                grep -v "^╭" | \\
                                grep -v "^╰" | \\
                                grep -v "^│" | \\
                                tail -n 15)
                        fi

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | tail -n 10)
                        fi

                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        gemini)
            if ! command -v gemini &>/dev/null; then
                log ERROR "Gemini CLI is not installed"
                send_error_message "❌ Gemini CLI is missing. Please install it with: \`npm install -g @google/gemini-cli\`" "1"
                rm -f "$prompt_file"
                return 1
            fi
            if ! ensure_gemini_node_compat; then
                local current_node_version="not found"
                if command -v node &>/dev/null; then
                    current_node_version="$(node -v 2>/dev/null || echo "unknown")"
                fi
                log ERROR "Gemini CLI requires Node.js 20+ (current: $current_node_version)"
                send_error_message "❌ Gemini CLI requires Node.js 20 or newer. Detected runtime: \`$current_node_version\`. Install a newer Node.js version (or put it first on PATH) and rerun the Gemini agent." "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use Gemini CLI directly
            # Use -p flag for prompt (more reliable than positional)
            # Gemini uses --sandbox (boolean) and --approval-mode
            local gemini_args=()
            
            # Add model if specified and supported by the current Gemini auth mode.
            # Explicit model selection is reliable with API-key / Vertex auth; with
            # Google-account sign-in we fall back to Gemini's own default model so
            # the CLI stays in the same working headless path as the default option.
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                if gemini_supports_explicit_model_selection; then
                    gemini_args+=("--model" "$MODEL")
                else
                    log WARN "Gemini model override '$MODEL' requested without API-key/Vertex auth; falling back to Gemini default model"
                    send_message "ℹ️ Gemini model \`$MODEL\` needs Gemini API key or Vertex auth for reliable non-interactive runs. Falling back to Gemini's default model for this agent." "0"
                fi
            fi
            
            # Explicit non-interactive mode for Gemini CLI.
            # Per Gemini CLI docs: "To run in non-interactive mode, use the --prompt (-p) flag."
            # Use -p - to read prompt from stdin (redirected from prompt_file) to avoid:
            #   1. Interactive mode fallback (Gemini waits for EOF on inherited terminal stdin)
            #   2. OS argument length limits for large prompts

            # Add output format
            gemini_args+=("-o" "text")
            # Handle sandbox mode - Gemini uses boolean --sandbox/--no-sandbox flags
            # Note: --sandbox requires Docker; fall back to --no-sandbox if Docker is not available
            case "$SANDBOX_MODE" in
                none)
                    gemini_args+=("--no-sandbox")
                    ;;
                workspace-write|read-only)
                    if command -v docker &>/dev/null; then
                        gemini_args+=("--sandbox")
                    else
                        gemini_args+=("--no-sandbox")
                    fi
                    ;;
            esac
            
            # Handle approval mode
            # Note: For automated agent operation, we need at least auto_edit
            # 'suggest' (default) mode waits for interactive user input which won't work
            case "$APPROVAL_MODE" in
                full-auto)
                    gemini_args+=("--approval-mode" "yolo")
                    ;;
                auto-edit)
                    gemini_args+=("--approval-mode" "auto_edit")
                    ;;
                suggest|*)
                    # For automated operation, use auto_edit as minimum
                    # This allows Gemini to respond without waiting for manual approval
                    gemini_args+=("--approval-mode" "auto_edit")
                    ;;
            esac
            
            # Trust the project folder so Gemini doesn't override sandbox/approval modes
            # Without this, Gemini ignores --no-sandbox and --approval-mode for untrusted folders
            if command -v gemini &>/dev/null; then
                gemini trust add "$PROJECT_ROOT" 2>/dev/null || true
                gemini trust add "$SCRIPT_DIR" 2>/dev/null || true
            fi

            # Build command string for notification (show flags only)
            local cmd_preview
            cmd_preview=$(format_command_preview gemini "\${gemini_args[@]}")
            cmd_preview+=" -p - < <prompt_file>"

            log INFO "Running: $cmd_preview"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "🤖 Received message, about to run: $cmd_preview" "0"
            fi

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" gemini "\${gemini_args[@]}" -p -; then
                cli_exit=0
            else
                cli_exit=$?
            fi

            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    # First: check if output contains a RICH_HTML_JSON marker
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    else
                        # Strip code blocks (unexecuted commands the agent wanted to run)
                        # and filter CLI noise from Gemini stdout
                        local stripped_output
                        stripped_output=$(echo "$captured_output" | \\
                            awk '/^\`\`\`/{skip=!skip; next} !skip{print}')

                        local filtered_output
                        filtered_output=$(echo "$stripped_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "sandbox" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^Error executing tool" | \\
                            grep -v "^YOLO mode" | \\
                            grep -v "^Approval mode overridden" | \\
                            grep -v "^Loaded cached" | \\
                            grep -v "^Session cleanup" | \\
                            grep -v "^Skipping project" | \\
                            grep -v "^Loading extension" | \\
                            grep -v "^Project hooks" | \\
                            grep -v "^Hook registry" | \\
                            grep -v "^I will " | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 30 | \\
                            head -n 20)

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$stripped_output" | \\
                                grep -v "^╭" | \\
                                grep -v "^╰" | \\
                                grep -v "^│" | \\
                                grep -v "^Error executing" | \\
                                grep -v "^[[:space:]]*$" | \\
                                tail -n 15)
                        fi

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$stripped_output" | tail -n 10)
                        fi

                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        kilo)
            if ! command -v kilo &>/dev/null; then
                log ERROR "Kilo CLI is not installed"
                send_error_message "❌ Kilo CLI is missing." "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use Kilo CLI directly in non-interactive run mode
            # Kilo uses kilo run and supports --auto for autonomous execution
            local kilo_args=("run")

            # Add model if specified and not 'default' (Kilo expects provider/model format)
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                kilo_args+=("--model" "$MODEL")
            fi

            # Enable autonomous mode for full-auto approvals
            if [ "$APPROVAL_MODE" = "full-auto" ]; then
                kilo_args+=("--auto")
            fi

            # Build command string for notification
            local cmd_preview="kilo"
            for arg in "\${kilo_args[@]}"; do
                cmd_preview+=" $arg"
            done
            cmd_preview+=" (prompt from stdin)"

            log INFO "Running: kilo \${kilo_args[*]} (prompt from stdin)"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "🤖 Received message, about to run: $cmd_preview" "0"
            fi

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" kilo "\${kilo_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi

            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"

            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    local filtered_output
                    filtered_output=$(echo "$captured_output" | \\
                        grep -v "^✓" | \\
                        grep -v "^✕" | \\
                        grep -v "^Using:" | \\
                        grep -v "^╭" | \\
                        grep -v "^╰" | \\
                        grep -v "^│" | \\
                        grep -v "^>" | \\
                        grep -v "context left" | \\
                        grep -v "MCP server" | \\
                        grep -v "^[[:space:]]*$" | \\
                        tail -n 30 | \\
                        head -n 20)

                    if [ -z "$filtered_output" ]; then
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            tail -n 15)
                    fi

                    if [ -z "$filtered_output" ]; then
                        filtered_output=$(echo "$captured_output" | tail -n 10)
                    fi

                    if [ -n "$filtered_output" ]; then
                        echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                        log INFO "Using captured stdout as response"
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        copilot)
            if ! command -v copilot &>/dev/null; then
                log ERROR "Copilot CLI is not installed"
                send_error_message "❌ Copilot CLI is missing. Please install it with: \`npm install -g @githubnext/github-copilot-cli\`" "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use GitHub Copilot CLI directly
            # -p = non-interactive prompt mode, --allow-all-tools for automated operation
            # -s = silent mode (output only agent response, no stats)
            local copilot_args=()
            
            # Add model if specified and not 'default'
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                copilot_args+=("--model" "$MODEL")
            fi
            
            # Silent mode - clean output for non-interactive use
            copilot_args+=("-s")
            
            # Handle approval/sandbox modes for Copilot
            # Copilot uses --allow-all, --allow-all-tools, --allow-all-paths, --yolo
            case "$SANDBOX_MODE" in
                none)
                    case "$APPROVAL_MODE" in
                        full-auto)
                            # Full access - equivalent to --yolo / --allow-all
                            copilot_args+=("--allow-all")
                            ;;
                        auto-edit)
                            copilot_args+=("--allow-all-tools" "--allow-all-paths")
                            ;;
                        *)
                            copilot_args+=("--allow-all-paths")
                            ;;
                    esac
                    ;;
                workspace-write)
                    case "$APPROVAL_MODE" in
                        full-auto)
                            copilot_args+=("--allow-all-tools")
                            copilot_args+=("--add-dir" "$PROJECT_ROOT")
                            ;;
                        auto-edit)
                            copilot_args+=("--allow-all-tools")
                            copilot_args+=("--add-dir" "$PROJECT_ROOT")
                            ;;
                        *)
                            copilot_args+=("--add-dir" "$PROJECT_ROOT")
                            ;;
                    esac
                    ;;
                read-only)
                    copilot_args+=("--add-dir" "$PROJECT_ROOT")
                    if [ "$APPROVAL_MODE" = "full-auto" ] || [ "$APPROVAL_MODE" = "auto-edit" ]; then
                        copilot_args+=("--allow-all-tools")
                    fi
                    ;;
            esac
            
            # Disable the ask_user tool for non-interactive operation
            copilot_args+=("--no-ask-user")

            # Non-interactive prompt mode: use -p "" to avoid interactive mode.
            # Pass actual prompt content via stdin to avoid "Argument list too long"
            # for large prompts (same approach as Claude).
            copilot_args+=("-p" "")

            # Build command string for notification
            local cmd_preview="copilot"
            for arg in "\${copilot_args[@]}"; do
                cmd_preview+=" $arg"
            done
            cmd_preview+=" (prompt via stdin)"

            log INFO "Running: copilot (prompt via stdin)"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "🤖 Received message, about to run: $cmd_preview" "0"
            fi

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" copilot "\${copilot_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi
            
            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")
                
                if [ -n "$captured_output" ]; then
                    # Filter known CLI noise from Copilot output
                    local filtered_output
                    filtered_output=$(echo "$captured_output" | \\
                        grep -v "^✓" | \\
                        grep -v "^✕" | \\
                        grep -v "^Using:" | \\
                        grep -v "^╭" | \\
                        grep -v "^╰" | \\
                        grep -v "^│" | \\
                        grep -v "^>" | \\
                        grep -v "context left" | \\
                        grep -v "MCP server" | \\
                        grep -v "^[[:space:]]*$" | \\
                        tail -n 30 | \\
                        head -n 20)
                    
                    # If filtered output is empty, try keeping more content
                    if [ -z "$filtered_output" ]; then
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            tail -n 15)
                    fi
                    
                    # Last resort: use raw output
                    if [ -z "$filtered_output" ]; then
                        filtered_output=$(echo "$captured_output" | tail -n 10)
                    fi
                    
                    if [ -n "$filtered_output" ]; then
                        echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                        log INFO "Using captured stdout as response"
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        antigravity)
            if ! command -v agy &>/dev/null; then
                log ERROR "Antigravity CLI is not installed"
                send_error_message "❌ Antigravity CLI is missing. Install Antigravity, run \`agy install\`, or ensure \`agy\` is on PATH." "1"
                rm -f "$prompt_file"
                return 1
            fi

            local agy_args=()
            # "agy models" prints "<id><TAB><label>"; older syncs saved the whole line.
            local agy_tab=$'\\t'
            local agy_model="\${MODEL%%"$agy_tab"*}"

            if [ -n "$agy_model" ] && [ "$agy_model" != "default" ]; then
                agy_args+=("--model" "$agy_model")
            fi

            case "$THINKING_EFFORT" in
                low|medium|high)
                    agy_args+=("--effort" "$THINKING_EFFORT")
                    ;;
                xhigh|max)
                    log WARN "Antigravity only supports low, medium, or high effort; using high instead of '$THINKING_EFFORT'"
                    agy_args+=("--effort" "high")
                    ;;
                "")
                    ;;
                *)
                    log WARN "Ignoring unsupported Antigravity thinking_effort '$THINKING_EFFORT'"
                    ;;
            esac

            case "$SANDBOX_MODE" in
                none)
                    if [ "$APPROVAL_MODE" = "full-auto" ]; then
                        agy_args+=("--dangerously-skip-permissions")
                    fi
                    ;;
                workspace-write|read-only)
                    agy_args+=("--sandbox")
                    agy_args+=("--add-dir" "$PROJECT_ROOT")
                    ;;
            esac

            local prompt_text
            prompt_text=$(cat "$prompt_file")
            agy_args+=("-p" "$prompt_text")

            local cmd_preview
            cmd_preview=$(format_command_preview agy "\${agy_args[@]:0:\${#agy_args[@]}-1}")
            cmd_preview+=" <prompt_text>"

            log INFO "Running: $cmd_preview"

            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "🤖 Received message, about to run: $cmd_preview" "0"
            fi

            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "" "$stdout_capture" agy "\${agy_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi

            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"

            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    else
                        local filtered_output
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 30 | \\
                            head -n 20)

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | \\
                                grep -v "^╭" | \\
                                grep -v "^╰" | \\
                                grep -v "^│" | \\
                                tail -n 15)
                        fi

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | tail -n 10)
                        fi

                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        pi)
            if ! command -v pi &>/dev/null; then
                log ERROR "Pi CLI is not installed"
                send_error_message "❌ Pi CLI is missing. Please install it with: \`npm install -g @mariozechner/pi-coding-agent\`" "1"
                rm -f "$prompt_file"
                return 1
            fi

            # Use Pi print mode. Keep the actual prompt on stdin so large
            # agent prompts do not hit OS argument length limits.
            local pi_args=()

            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                pi_args+=("--model" "$MODEL")
            fi

            pi_args+=("-p" "Follow the instructions provided on stdin.")

            local cmd_preview
            cmd_preview=$(format_command_preview pi "\${pi_args[@]}")
            cmd_preview+=" < <prompt_file>"

            log INFO "Running: $cmd_preview"

            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "🤖 Received message, about to run: $cmd_preview" "0"
            fi

            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" pi "\${pi_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi

            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"

            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    else
                        local filtered_output
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 30 | \\
                            head -n 20)

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | \\
                                grep -v "^╭" | \\
                                grep -v "^╰" | \\
                                grep -v "^│" | \\
                                tail -n 15)
                        fi

                        if [ -z "$filtered_output" ]; then
                            filtered_output=$(echo "$captured_output" | tail -n 10)
                        fi

                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;

        codex-cli)
            local codex_bin
            if ! codex_bin=$(resolve_codex_bin); then
                log ERROR "Codex CLI is not installed"
                send_error_message "❌ Codex CLI is missing. Please install it with: \`npm install -g @openai/codex\`" "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use Codex CLI directly (provider selected as codex-cli)
            local codex_args=("exec")
            
            # Handle combined full-auto + no-sandbox case
            if [ "$APPROVAL_MODE" = "full-auto" ] && [ "$SANDBOX_MODE" = "none" ]; then
                codex_args+=("--dangerously-bypass-approvals-and-sandbox")
            else
                # Handle approval mode separately
                if [ "$APPROVAL_MODE" = "full-auto" ]; then
                    codex_args+=("--full-auto")
                fi
                
                # Handle sandbox mode
                case "$SANDBOX_MODE" in
                    none)
                        codex_args+=("--sandbox" "danger-full-access")
                        ;;
                    workspace-write)
                        codex_args+=("--sandbox" "workspace-write")
                        ;;
                    read-only)
                        codex_args+=("--sandbox" "read-only")
                        ;;
                esac
            fi
            
            codex_args+=("--skip-git-repo-check")
            # Use project root for full access, otherwise stay in agent directory
            if [ "$SANDBOX_MODE" = "none" ]; then
                codex_args+=("--cd" "$PROJECT_ROOT")
            else
                codex_args+=("--cd" "$PROJECT_ROOT")
            fi
            
            # Add model if specified
            if [ -n "$MODEL" ]; then
                codex_args+=("--model" "$MODEL")
            fi

            # Forward the dashboard's reasoning control to Codex. GPT-6 Astra
            # supports low, medium, high, xhigh, and max (but not none/minimal).
            case "$THINKING_EFFORT" in
                low|medium|high|xhigh|max)
                    codex_args+=("-c" "model_reasoning_effort='$THINKING_EFFORT'")
                    ;;
                "")
                    ;;
                *)
                    log WARN "Ignoring unsupported Codex thinking_effort '$THINKING_EFFORT'"
                    ;;
            esac
            
            codex_args+=("-")
            
            # Build command string for notification (without the prompt from stdin)
            local cmd_preview="codex exec"
            for arg in "\${codex_args[@]}"; do
                [[ "$arg" != "-" ]] && cmd_preview+=" $arg"
            done
            cmd_preview+=" -"
            
            log INFO "Running: $codex_bin \${codex_args[*]}"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "�� Received message, about to run: $cmd_preview" "0"
            fi
            
            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" "$codex_bin" "\${codex_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi
            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, check for errors
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    # First: check if output contains a RICH_HTML_JSON marker
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    # Check for known error patterns
                    elif echo "$captured_output" | grep -qi "usage.limit\|rate.limit\|429\|Too Many Requests\|quota\|exceeded"; then
                        # Extract the error message
                        local error_msg
                        error_msg=$(echo "$captured_output" | grep -i "ERROR\|limit\|429" | head -n 3)
                        if [ -n "$error_msg" ]; then
                            echo "⚠️ API Error: $error_msg" > "$AGENT_RESPONSE_FILE"
                            log WARN "Detected rate limit error, sending to user"
                        fi
                    elif echo "$captured_output" | grep -qi "error\|failed\|exception"; then
                        # Generic error
                        local error_msg
                        error_msg=$(echo "$captured_output" | grep -i "error\|failed" | head -n 3)
                        if [ -n "$error_msg" ]; then
                            echo "⚠️ Agent Error: $error_msg" > "$AGENT_RESPONSE_FILE"
                            log WARN "Detected error, sending to user"
                        fi
                    else
                        # Use filtered output as response
                        local filtered_output
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "sandbox" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 20)
                        
                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;
            
        *)
            local codex_bin
            if ! codex_bin=$(resolve_codex_bin); then
                log ERROR "Codex CLI is not installed"
                send_error_message "❌ Codex CLI is missing. Please install it with: \`npm install -g @openai/codex\`" "1"
                rm -f "$prompt_file"
                return 1
            fi
            
            # Use Codex CLI for all other providers
            local codex_args=("exec")
            
            # Handle combined full-auto + no-sandbox case
            if [ "$APPROVAL_MODE" = "full-auto" ] && [ "$SANDBOX_MODE" = "none" ]; then
                codex_args+=("--dangerously-bypass-approvals-and-sandbox")
            else
                # Handle approval mode separately
                if [ "$APPROVAL_MODE" = "full-auto" ]; then
                    codex_args+=("--full-auto")
                fi
                
                # Handle sandbox mode
                case "$SANDBOX_MODE" in
                    none)
                        codex_args+=("--sandbox" "danger-full-access")
                        ;;
                    workspace-write) codex_args+=("--sandbox" "workspace-write") ;;
                    read-only) codex_args+=("--sandbox" "read-only") ;;
                esac
            fi
            
            codex_args+=("--skip-git-repo-check")
            # Use project root for full access, otherwise stay in agent directory
            if [ "$SANDBOX_MODE" = "none" ]; then
                codex_args+=("--cd" "$PROJECT_ROOT")
            else
                codex_args+=("--cd" "$PROJECT_ROOT")
            fi
            
            # Handle model and provider for codex
            case "$MODEL_PROVIDER" in
                default|codex)
                    # Both dashboard-created agents ("codex") and legacy runners
                    # ("default") use the logged-in Codex/ChatGPT account.  Forward
                    # every explicit model choice so GPT-5.6 Luna and Sol are not
                    # silently replaced by the global Terra default.
                    if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                        codex_args+=("--model" "$MODEL")
                    fi
                    ;;
                openai)
                    # Use OpenAI API directly
                    codex_args+=("--model" "$MODEL")
                    ;;
                openrouter)
                    # Use OpenRouter as a bridge to access Claude/Gemini/etc via OpenAI-compatible API
                    codex_args+=("-c" "model_provider=openrouter")
                    codex_args+=("-c" 'model_providers.openrouter.name="OpenRouter"')
                    codex_args+=("-c" 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"')
                    codex_args+=("-c" 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"')
                    codex_args+=("-c" 'model_providers.openrouter.wire_api="chat"')
                    codex_args+=("--model" "$MODEL")
                    ;;
                ollama)
                    # Use Ollama local provider
                    codex_args+=("--oss" "--local-provider" "ollama" "--model" "$MODEL")
                    ;;
                lmstudio)
                    # Use LM Studio local provider  
                    codex_args+=("--oss" "--local-provider" "lmstudio" "--model" "$MODEL")
                    ;;
            esac

            # Apply the configured reasoning level for every Codex-backed
            # provider. This includes GPT-6 Astra through ChatGPT or the API.
            case "$THINKING_EFFORT" in
                low|medium|high|xhigh|max)
                    codex_args+=("-c" "model_reasoning_effort='$THINKING_EFFORT'")
                    ;;
                "")
                    ;;
                *)
                    log WARN "Ignoring unsupported Codex thinking_effort '$THINKING_EFFORT'"
                    ;;
            esac
            
            codex_args+=("-")
            
            # Build command string for notification (without the prompt from stdin)
            local cmd_preview="codex exec"
            for arg in "\${codex_args[@]}"; do
                [[ "$arg" != "-" ]] && cmd_preview+=" $arg"
            done
            cmd_preview+=" -"
            
            log INFO "Running: $codex_bin \${codex_args[*]:0:5}... (prompt from stdin)"

            # Send notification to user about what command is being executed
            # Record the exact command so message_helper.py reports it with
            # every message this run produces (dashboard "i" info modal).
            export RUN_COMMAND="$cmd_preview"
            if should_send_command_preview; then
                send_message "�� Received message, about to run: $cmd_preview" "0"
            fi
            
            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            local cli_exit=0
            if run_cli_in_background "$prompt_file" "$stdout_capture" "$codex_bin" "\${codex_args[@]}"; then
                cli_exit=0
            else
                cli_exit=$?
            fi
            rm -f "$prompt_file"

            if [ "$cli_exit" -eq 143 ]; then
                log WARN "Agent command interrupted by stop request"
                rm -f "$stdout_capture"
                return 143
            fi
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, check for errors
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")

                if [ -n "$captured_output" ]; then
                    # First: check if output contains a RICH_HTML_JSON marker
                    local rich_line
                    rich_line=$(echo "$captured_output" | grep -o 'RICH_HTML_JSON:.*' | head -1)

                    if [ -n "$rich_line" ]; then
                        echo "$rich_line" > "$AGENT_RESPONSE_FILE"
                        log INFO "Detected rich HTML in stdout"
                    # Check for known error patterns
                    elif echo "$captured_output" | grep -qi "usage.limit\|rate.limit\|429\|Too Many Requests\|quota\|exceeded"; then
                        # Extract the error message
                        local error_msg
                        error_msg=$(echo "$captured_output" | grep -i "ERROR\|limit\|429" | head -n 3)
                        if [ -n "$error_msg" ]; then
                            echo "⚠️ API Error: $error_msg" > "$AGENT_RESPONSE_FILE"
                            log WARN "Detected rate limit error, sending to user"
                        fi
                    elif echo "$captured_output" | grep -qi "error\|failed\|exception"; then
                        # Generic error
                        local error_msg
                        error_msg=$(echo "$captured_output" | grep -i "error\|failed" | head -n 3)
                        if [ -n "$error_msg" ]; then
                            echo "⚠️ Agent Error: $error_msg" > "$AGENT_RESPONSE_FILE"
                            log WARN "Detected error, sending to user"
                        fi
                    else
                        # Use filtered output as response
                        local filtered_output
                        filtered_output=$(echo "$captured_output" | \\
                            grep -v "^✓" | \\
                            grep -v "^✕" | \\
                            grep -v "^Using:" | \\
                            grep -v "^╭" | \\
                            grep -v "^╰" | \\
                            grep -v "^│" | \\
                            grep -v "^>" | \\
                            grep -v "sandbox" | \\
                            grep -v "context left" | \\
                            grep -v "MCP server" | \\
                            grep -v "^[[:space:]]*$" | \\
                            tail -n 20)
                        
                        if [ -n "$filtered_output" ]; then
                            echo "$filtered_output" > "$AGENT_RESPONSE_FILE"
                            log INFO "Using captured stdout as response"
                        fi
                    fi
                fi
            fi
            rm -f "$stdout_capture"
            ;;
    esac
    
    # Shared callers deliver this response through their encrypted conversation API.
    if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ]; then
        return "\${cli_exit:-0}"
    fi

    # Check for response file (required for all agents)
    if [ -f "$AGENT_RESPONSE_FILE" ]; then
        local response
        response=$(cat "$AGENT_RESPONSE_FILE")
        if [ -n "$response" ]; then
            log INFO "Sending agent response to API..."

            # Check if response contains a RICH_HTML_JSON marker
            local rich_html_json=""
            rich_html_json=$(echo "$response" | grep -o 'RICH_HTML_JSON:.*' | head -1 | sed 's/^RICH_HTML_JSON://')

            if [ -n "$rich_html_json" ]; then
                log INFO "Detected rich HTML response"
                if send_message "$rich_html_json" "0"; then
                    log SUCCESS "Rich HTML response sent to user"
                else
                    log ERROR "Failed to send rich HTML response"
                fi
            else
                # Parse priority from response (format: "message|priority")
                local message="$response"
                local priority="0"

                if [[ "$response" =~ \\|[0-2]$ ]]; then
                    priority="\${response##*|}"
                    message="\${response%|*}"
                fi

                log INFO "Message: $message (Priority: $priority)"
                if send_message "$message" "$priority"; then
                    log SUCCESS "Response sent to user"
                else
                    log ERROR "Failed to send response to user"
                fi
            fi
        fi
        rm -f "$AGENT_RESPONSE_FILE"
    else
        log WARN "Agent did not write a response file"
        log INFO "Sending notification message to user..."
        if send_message "Agent session completed but did not send a response message." "0"; then
            log SUCCESS "Notification sent to user"
        else
            log ERROR "Failed to send notification to user"
        fi
    fi
    
    local session_count
    session_count=$(jq '.session_count // 0' "$CONVERSATION_FILE" 2>/dev/null || echo "0")
    session_count=$((session_count + 1))
    jq ".session_count = $session_count" "$CONVERSATION_FILE" > "$CONVERSATION_FILE.tmp" && mv "$CONVERSATION_FILE.tmp" "$CONVERSATION_FILE"
}

main() {
    # Load allowed permissions ONCE at startup (immutable during runtime)
    load_allowed_permissions
    
    # Load initial config
    load_config
    
    # Auto-sync models to backend on start (background - must not block startup)
    log INFO "Auto-syncing models in background..."
    ( auto_sync_all_installed_providers_models ) >/dev/null 2>&1 &

    log INFO "Starting Agent Runner"
    log INFO "  Model: $MODEL_PROVIDER / $MODEL"
    log INFO "  Approval Mode: $APPROVAL_MODE"
    log INFO "  Sandbox Mode: $SANDBOX_MODE"
    log INFO "  Agent Name: $AGENT_NAME"
    log INFO "  Poll Interval: \${POLL_INTERVAL}s"
    log INFO ""
    log INFO "Waiting for messages... (Ctrl+C to stop)"
    
    echo $$ > "$RUNNING_FLAG"
    mark_successful_backend_connection
    
    local history
    history=$(get_history)
    
    # Check if this is a new agent (no previous messages)
    local is_new_agent="false"
    if echo "$history" | grep -qi "new session\\|No previous conversation\\|No history available"; then
        is_new_agent="true"
    else
        # Preserve the helper's persisted cursor. Syncing to the newest server
        # message on restart would discard messages that arrived while down.
        log INFO "Existing agent detected — preserving message cursor on startup"
    fi
    
    # Track whether this is a fresh agent that hasn't received a user message yet.
    # When true, we only send the pre-recorded intro — we do NOT run the agent
    # command (gemini/claude/codex/kilo/copilot) until the first real user message arrives.
    local skip_agent_command="false"

    # Detect spawned agent BEFORE intro/drain so onboarding DMs are not consumed
    local is_spawned_agent="false"
    if [ -f "$SCRIPT_DIR/agent_state/lineage.json" ]; then
        if grep -q '"auto_spawned": true' "$SCRIPT_DIR/agent_state/lineage.json" 2>/dev/null; then
            is_spawned_agent="true"
        fi
    fi

    if [ "$is_new_agent" = "true" ]; then
        if [ "$is_spawned_agent" = "true" ]; then
            # Spawned agents skip intro and drain — start working immediately
            # so the onboarding DM from parent is processed in the first loop cycle
            log INFO "Spawned agent detected - skipping intro, starting work immediately"
            skip_agent_command="false"
            sleep 2  # Brief pause to let onboarding DM arrive
        else
            log INFO "First run detected - sending introduction message only (no agent command)"
            if send_message "Hello! I am $AGENT_NAME and I am ready to assist you. What would you like me to help with?"; then
                log SUCCESS "Introduction message sent!"
            else
                log ERROR "Failed to send introduction message"
            fi
            skip_agent_command="true"
            # Wait before first poll to avoid picking up our own intro as a new message
            sleep "$POLL_INTERVAL"
        fi
    fi

    # Auto-discover peer agents on startup if inter-agent is enabled
    if [ -n "$ALLOWED_PERMISSIONS" ] && [ "$ALLOWED_PERMISSIONS" != "{}" ]; then
        local ia_enabled
        ia_enabled=$(echo "$ALLOWED_PERMISSIONS" | jq -r '.inter_agent.enabled // false' 2>/dev/null)
        if [ "$ia_enabled" = "true" ]; then
            log INFO "Discovering available agents..."
            local peers
            peers=$(uv run message_helper.py discover 2>/dev/null || echo "")
            if [ -n "$peers" ]; then
                log SUCCESS "Peer agents discovered:"
                echo "$peers" | head -20
            fi
        fi
    fi

    while [ -f "$RUNNING_FLAG" ]; do
        # Load local config as defaults first
        load_config

        # Then fetch from API - API takes precedence and overwrites local values
        fetch_config_from_api

        # Validate config against allowed permissions
        if ! validate_config; then
            # Config is not allowed - error message already sent
            # Wait and continue to next iteration
            sleep "$POLL_INTERVAL"
            continue
        fi
        
        # Check for stop request
        if check_stop_flag; then
            handle_stop
            continue
        fi

        # Check for restart request (e.g. CoS PATCH /instructions restart=true).
        # handle_restart re-execs and never returns.
        if check_restart_flag; then
            handle_restart
        fi

        local scheduled_task
        scheduled_task=$(check_scheduled_tasks)
        local has_self_wakeup="false"
        if self_wakeup_pending; then
            has_self_wakeup="true"
        fi

        # After a full week without a successful backend connection, stop
        # attempting network calls entirely instead of retrying forever.
        # Stop/restart requests above are still honored while idling.
        if check_no_connection_giveup; then
            sleep 300
            continue
        fi

        local check_result
        check_result=$(check_for_messages)
        update_server_poll_interval

        # Do not strand an agent offline after a long backend outage.  Slow
        # down retries until a connection succeeds, then resume normally.
        if check_no_connection_failsafe; then
            sleep 60
            continue
        fi

        local now_epoch
        now_epoch=$(date +%s)
        if [ "$ERROR_COOLDOWN_UNTIL" -gt "$now_epoch" ]; then
            local cooldown_remaining=$((ERROR_COOLDOWN_UNTIL - now_epoch))
            log WARN "Error circuit breaker active; retrying in $cooldown_remaining s"
            sleep "$cooldown_remaining"
            ERROR_FAILSAFE_WINDOW_STARTED_AT=0
            ERROR_FAILSAFE_MESSAGE_COUNT=0
            ERROR_COOLDOWN_UNTIL=0
            continue
        fi

        local has_messages="false"
        if has_new_messages "$check_result"; then
            has_messages="true"
            IDLE_POLL_STREAK=0
        else
            IDLE_POLL_STREAK=$((IDLE_POLL_STREAK + 1))
        fi

        # Don't run scheduled/self wake tasks before first user message
        if [ "$skip_agent_command" = "true" ] && [ "$has_messages" = "false" ]; then
            if [ -n "$scheduled_task" ] || [ "$has_self_wakeup" = "true" ]; then
                log INFO "Skipping scheduled/self wake - waiting for first user message"
            fi
            sleep "$(get_next_idle_wait_seconds)"
            continue
        fi

        local combined="$check_result"
        if [ "$combined" = "No new messages." ]; then
            combined=""
        fi

        local wake_payload=""
        if [ -n "$scheduled_task" ]; then
            wake_payload="SCHEDULED TASK: $scheduled_task"
        fi

        local self_wakeup_content=""
        if [ "$has_self_wakeup" = "true" ]; then
            self_wakeup_content=$(consume_self_wakeup)
            if [ -n "$self_wakeup_content" ]; then
                if [ -n "$wake_payload" ]; then
                    wake_payload+=$'\n'
                fi
                wake_payload+="SELF WAKEUP:\n$self_wakeup_content"
            fi
        fi

        if [ -n "$wake_payload" ]; then
            if [ -n "$combined" ]; then
                combined+=$'\n'
            fi
            combined+="$wake_payload"
        fi

        if [ "$has_messages" = "true" ] || [ -n "$wake_payload" ]; then
            # If still waiting for the first real user message, this IS it.
            # Clear the flag so the agent command runs now.
            if [ "$skip_agent_command" = "true" ]; then
                skip_agent_command="false"
                log INFO "First user message received - agent command now enabled"
            fi

            if [ "$has_messages" = "true" ]; then
                log SUCCESS "New message(s) received!"
                log INFO "Messages: $check_result"
            fi

            if [ -n "$scheduled_task" ]; then
                log SUCCESS "Scheduled task triggered!"
                log INFO "Task: $scheduled_task"
            fi

            if [ -n "$self_wakeup_content" ]; then
                log SUCCESS "Self wake signal detected!"
            fi

            local run_overrides_applied="false"
            if [ "$has_messages" = "true" ] && apply_run_overrides; then
                run_overrides_applied="true"
            fi

            history=$(get_history)
            local prompt
            prompt=$(build_agent_prompt "$combined" "$history")

            local run_exit=0
            local run_success=0
            local agent_rc=0
            run_agent "$prompt" || agent_rc=$?
            if [ "$run_overrides_applied" = "true" ]; then
                restore_run_overrides
            fi
            if [ "$agent_rc" -eq 0 ]; then
                CONSECUTIVE_FAILURES=0
                run_success=1
            else
                run_exit=$agent_rc
                if [ "$run_exit" -eq 143 ] && check_stop_flag; then
                    log INFO "Stop request confirmed during command execution"
                    handle_stop
                    CONSECUTIVE_FAILURES=0
                    continue
                fi

                CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
                if [ $CONSECUTIVE_FAILURES -ge 3 ]; then
                    log ERROR "Agent failed $CONSECUTIVE_FAILURES times consecutively. Pausing for 60s."
                    send_error_message "⚠️ Agent encountered repeated errors ($CONSECUTIVE_FAILURES failures). Pausing before retry. Check your provider/model configuration." "1"
                    sleep 60
                    CONSECUTIVE_FAILURES=0
                fi
            fi

            if [ -n "$scheduled_task" ] && [ "$run_success" -eq 1 ]; then
                process_scheduled_task "$scheduled_task"
                log INFO "Scheduled task completed"
            fi

            log INFO "Agent completed, checking for messages that arrived during execution..."
            # Skip sleep and immediately re-check for messages that arrived while the agent was working
            continue
        fi

        # Reset failure counter when idle (no messages to process)
        CONSECUTIVE_FAILURES=0
        local wait_seconds
        wait_seconds=$(get_next_idle_wait_seconds)

        # Instead of sleeping the full poll interval, check every second for
        # wake-up signal files (.dm_pending or .message_pending) written by the
        # server when a DM or user message arrives.  This lets the agent react
        # to inter-agent messages almost instantly while keeping CPU usage low.
        local waited=0
        while [ "$waited" -lt "$wait_seconds" ]; do
            if [ -f "$STATE_DIR/.dm_pending" ] || [ -f "$STATE_DIR/.message_pending" ]; then
                log INFO "Wake signal detected — checking for messages"
                rm -f "$STATE_DIR/.dm_pending" "$STATE_DIR/.message_pending" 2>/dev/null
                break
            fi
            if check_restart_flag; then
                log INFO "Restart signal detected — breaking idle wait"
                break
            fi
            if self_wakeup_pending; then
                log INFO "Self wake signal detected — checking for messages"
                break
            fi
            local due_task
            due_task=$(check_scheduled_tasks)
            if [ -n "$due_task" ]; then
                log INFO "Scheduled task due — checking for messages"
                break
            fi
            sleep 1
            waited=$((waited + 1))
        done
    done
}

supervise_main() {
    local restart_count=0
    local restart_window_started_at=0

    while true; do
        local main_exit=0
        if main; then
            main_exit=0
        else
            main_exit=$?
        fi

        # A removed running flag or a signal trap is an intentional shutdown.
        if [ ! -f "$RUNNING_FLAG" ]; then
            return "$main_exit"
        fi

        local now
        now=$(date +%s)
        if [ "$restart_window_started_at" -eq 0 ] || \
           [ $((now - restart_window_started_at)) -gt "$RUNNER_RESTART_WINDOW_SECONDS" ]; then
            restart_window_started_at="$now"
            restart_count=0
        fi
        restart_count=$((restart_count + 1))

        # Keep the runner alive after unexpected shell/provider failures, but
        # avoid a tight crash loop. systemd adds another recovery layer for
        # agents with persistence enabled.
        local delay=$((restart_count * 5))
        if [ "$delay" -gt 60 ]; then
            delay=60
        fi
        if [ "$restart_count" -gt "$RUNNER_RESTART_MAX_ATTEMPTS" ]; then
            delay=300
            restart_count=0
            restart_window_started_at="$now"
        fi
        log WARN "Runner loop exited unexpectedly (code $main_exit); recovering in $delay s"
        send_working_heartbeat "false" || true
        sleep "$delay"
    done
}

# Metadata refreshes do not poll conversations or invoke an inference turn.
if [ "\${CHATSPACE_MODEL_SYNC_ONLY:-0}" = "1" ]; then
    auto_sync_all_installed_providers_models
    exit 0
fi

# Shared mode executes one supplied transcript with the existing permission mapping.
# It never polls private history or sends a fallback response to the private chat.
if [ "\${CHATSPACE_SHARED_TURN:-0}" = "1" ]; then
    DEBUG_SEND_COMMAND_PREVIEW="false"
    send_message() { return 0; }
    send_error_message() { log ERROR "$1" >&2; }
    # The outer serialized listener maintains heartbeats and cancellation.
    # A provider subprocess must not consume another private polling quota.
    send_working_heartbeat() { return 0; }
    check_stop_flag() { return 1; }
    load_allowed_permissions >&2
    load_config >&2
    MODEL_PROVIDER="\${CHATSPACE_SHARED_PROVIDER:-$MODEL_PROVIDER}"
    MODEL="\${CHATSPACE_SHARED_MODEL:-$MODEL}"
    if [ -n "\${CHATSPACE_SHARED_RUN_CONFIG:-}" ]; then
        shared_approval=$(printf '%s' "$CHATSPACE_SHARED_RUN_CONFIG" | jq -r '.approval_mode // empty')
        shared_sandbox=$(printf '%s' "$CHATSPACE_SHARED_RUN_CONFIG" | jq -r '.sandbox_mode // empty')
        [ -z "$shared_approval" ] || APPROVAL_MODE="$shared_approval"
        [ -z "$shared_sandbox" ] || SANDBOX_MODE="$shared_sandbox"
        if printf '%s' "$CHATSPACE_SHARED_RUN_CONFIG" | jq -e 'has("thinking_effort")' >/dev/null; then
            THINKING_EFFORT=$(printf '%s' "$CHATSPACE_SHARED_RUN_CONFIG" | jq -r '.thinking_effort // empty')
        fi
    fi
    validate_config >&2 || exit 1
    shared_output_dir=$(mktemp -d)
    chmod 700 "$shared_output_dir"
    AGENT_RESPONSE_FILE="$shared_output_dir/response.json"
    AGENT_PID_FILE="$shared_output_dir/provider.pid"
    shared_prompt=$(cat)
    shared_exit=0
    run_agent "$shared_prompt" >&2 || shared_exit=$?
    if [ "$shared_exit" -eq 0 ] && [ -s "$AGENT_RESPONSE_FILE" ]; then
        cat "$AGENT_RESPONSE_FILE"
    else
        shared_exit=1
    fi
    rm -rf "$shared_output_dir"
    exit "$shared_exit"
fi

# Replace this listener with one serialized private/shared listener when enabled.
# Single-turn provider subprocesses exit above, so they cannot enroll recursively.
if [ "\${CHATSPACE_TRUSTED_SHARING:-1}" = "1" ] && command -v node >/dev/null 2>&1; then
    if ! sharing_status=$(curl -fsS --max-time 10 "$API_BASE/agent/sharing-status" 2>/dev/null) || \\
        ! printf '%s' "$sharing_status" | jq -e 'has("enabled") and (.enabled | type == "boolean")' >/dev/null 2>&1; then
        log WARN "Sharing availability could not be checked; the supervisor will retry the connection"
        exit 1
    fi
    if [ "$(printf '%s' "$sharing_status" | jq -r '.enabled // false' 2>/dev/null || true)" = "true" ]; then
        load_allowed_permissions
        load_config
        validate_config || exit 1
        # A listener killed without cleanup leaves its lock behind, and the shared
        # runner then refuses to start until someone deletes it by hand. Clear the
        # lock only when its recorded PID is no longer a live shared-runner.
        sharing_lock="$STATE_DIR/shared-agent.json.lock"
        if [ -f "$sharing_lock" ]; then
            lock_pid=$(tr -cd '0-9' < "$sharing_lock" 2>/dev/null || true)
            if [ -n "$lock_pid" ] && ps -p "$lock_pid" -o args= 2>/dev/null | grep -q "shared-runner.js"; then
                log ERROR "This agent's shared listener is already running (PID $lock_pid). Use agent-cli.sh --restart <agent> to replace it."
                exit 0
            fi
            rm -f "$sharing_lock"
            log INFO "Removed stale shared listener lock"
        fi
        sharing_bundle=$(mktemp "$STATE_DIR/.shared-runner.XXXXXX.js")
        if ! curl -fsS --max-time 30 "$API_BASE/agent/shared-runner.js" -o "$sharing_bundle" || ! node --check "$sharing_bundle"; then
            rm -f "$sharing_bundle"
            log ERROR "Shared listener could not be prepared; restart after fixing the connection."
            exit 1
        fi
        chmod 700 "$sharing_bundle"
        mv "$sharing_bundle" "$STATE_DIR/shared-runner.js"
        export CHATSPACE_BRIDGE_STATE="$STATE_DIR/shared-agent.json"
        export CHATSPACE_SHARED_PROFILES="$STATE_DIR/shared-profiles.json"
        export CHATSPACE_SHARED_EXPORT_DIR="$STATE_DIR/shared-exports"
        export CHATSPACE_SHARED_MANAGED_RUNNER="$SCRIPT_DIR/$(basename "\${BASH_SOURCE[0]}")"
        export CHATSPACE_SHARED_PROJECT="$PROJECT_ROOT"
        export CHATSPACE_SHARED_PROVIDER="$MODEL_PROVIDER"
        export CHATSPACE_SHARED_MODEL="$MODEL"
        export CHATSPACE_SHARED_PROTOCOL=2
        export CHATSPACE_SHARED_EXECUTION_MODE=trusted
        log INFO "Starting trusted sharing with the existing provider permissions"
        exec node "$STATE_DIR/shared-runner.js" run-managed
    fi
fi

supervise_main`;
}

/**
 * Legacy function - generates simple API guide for backwards compatibility
 */
function generateApiGuide(apiKey, baseUrl, agentName = 'Your Agent Name', encryptionSalt = null) {
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const helperFolder = `.chatspace/${agentFolder}`;

    return `# Agent Setup - ${agentName}

Your messaging workspace is at \`${helperFolder}/\`.

Run these commands to get started:

\`\`\`bash
# 1. Check for existing context
uv run python ${helperFolder}/message_helper.py history

# 2. Introduce yourself
uv run python ${helperFolder}/message_helper.py send "Hello! I am ${agentName}, ready for instructions."

# 3. Wait for instructions
uv run python ${helperFolder}/message_helper.py ask "What would you like me to do?"
\`\`\`

ALL further conversation happens through these CLI commands — keep using them to chat with the user from the terminal.

Read \`${helperFolder}/AGENT_INSTRUCTIONS.md\` for full documentation.`;
}

/**
 * Direct setup script - generates a ready-to-run agent CLI with permissions configured
 */
function generateDirectSetupScript(apiKey, baseUrl, agentName = 'Your Agent Name', encryptionSalt = null) {
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const agentDir = `.chatspace/${agentFolder}`;
    const hasEncryption = resolveHasEncryption(encryptionSalt);

    const pythonHelper = generateMessageHelperPython(hasEncryption);
    const agentInstructions = generateAgentInstructions();
    const oneshotInstructions = generateOneshotInstructions();
    const agentRunner = generateAgentRunner();
    const selfWakeGuide = generateSelfWakeGuide();

    const passwordBlock = hasEncryption ? `
echo "🔐 End-to-end encryption is enabled. Your password never leaves this machine."
read -sp "Enter your account password (used for encryption): " USER_PASSWORD
echo ""` : '';

    return `#!/usr/bin/env bash
set -euo pipefail

API_KEY="${apiKey}"
API_BASE="${baseUrl}/api"
AGENT_NAME="${agentName}"
AGENT_FOLDER="${agentDir}"
ENCRYPTION_SALT="${hasEncryption ? encryptionSalt : ''}"
USER_PASSWORD=""

# Collect password only when encryption is enabled
${passwordBlock}

mkdir -p "$AGENT_FOLDER/agent_state"

# Persist credentials for helper scripts
cat > "$AGENT_FOLDER/.env" <<ENVEOF
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$AGENT_NAME"
USER_PASSWORD="$USER_PASSWORD"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
DEBUG_SEND_COMMAND_PREVIEW="false"
ENVEOF
chmod 600 "$AGENT_FOLDER/.env"

# Python helper for sending/receiving messages
cat > "$AGENT_FOLDER/message_helper.py" <<'PYEOF'
${pythonHelper}
PYEOF
chmod 644 "$AGENT_FOLDER/message_helper.py"

# Agent instructions
cat > "$AGENT_FOLDER/AGENT_INSTRUCTIONS.md" <<'INSTREOF'
${agentInstructions}
INSTREOF
chmod 644 "$AGENT_FOLDER/AGENT_INSTRUCTIONS.md"

# One-shot instructions
cat > "$AGENT_FOLDER/ONESHOT_AGENT_INSTRUCTIONS.md" <<'OSEOF'
${oneshotInstructions}
OSEOF
chmod 644 "$AGENT_FOLDER/ONESHOT_AGENT_INSTRUCTIONS.md"

# Self wake guide
cat > "$AGENT_FOLDER/SELF_WAKE_GUIDE.md" <<'WAKEEOF'
${selfWakeGuide}
WAKEEOF
chmod 644 "$AGENT_FOLDER/SELF_WAKE_GUIDE.md"

# Agent runner (supervises polling and model execution)
cat > "$AGENT_FOLDER/agent-runner.sh" <<'RUNNEREOF'
${agentRunner}
RUNNEREOF
chmod 755 "$AGENT_FOLDER/agent-runner.sh"

# Lightweight CLI launcher with correct permissions defaults
cat > "$AGENT_FOLDER/agent-cli.sh" <<'CLIEOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

set -a
source "$SCRIPT_DIR/.env"
set +a

APPROVAL_MODE="\${APPROVAL_MODE:-full-auto}"
SANDBOX_MODE="\${SANDBOX_MODE:-none}"
MODEL_PROVIDER="\${MODEL_PROVIDER:-default}"
MODEL="\${MODEL:-gpt-5.6-terra}"
POLL_INTERVAL="\${POLL_INTERVAL:-5}"

exec "$SCRIPT_DIR/agent-runner.sh" \\
  --model "$MODEL" \\
  --provider "$MODEL_PROVIDER" \\
  --approval "$APPROVAL_MODE" \\
  --sandbox "$SANDBOX_MODE" \\
  --poll-interval "$POLL_INTERVAL"
CLIEOF
chmod 755 "$AGENT_FOLDER/agent-cli.sh"

# Initialize state files
echo '[]' > "$AGENT_FOLDER/agent_state/.scheduled_tasks.json"
echo '{"session_count": 0}' > "$AGENT_FOLDER/agent_state/conversation_history.json"

cat > "$AGENT_FOLDER/agent_state/agent_summary.md" <<SUMMARYEOF
# Agent Session Summary - $AGENT_NAME

## Current State
- Status: initialized
- Last active: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- Session count: 0

## Ongoing Tasks
- None currently

## Notes for Next Session
- Agent is ready to receive messages
- Use message_helper.py to send and receive messages

## Other Relevant Information
- Agent Name: $AGENT_NAME
- Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
SUMMARYEOF

cat > "$AGENT_FOLDER/.gitignore" <<GITIGNOREOF
# Never commit .env file - it contains secrets!
.env

# Agent runtime files
agent_state/.agent_response.txt
agent_state/.wait_state.json
agent_state/.running
GITIGNOREOF

echo ""
echo "✅ Agent files created at $AGENT_FOLDER"
echo "ALL further conversation happens through these CLI commands."
echo "To start the agent with full permissions (no sandbox):"
echo "  SANDBOX_MODE=none APPROVAL_MODE=full-auto $AGENT_FOLDER/agent-cli.sh"
`;
}

module.exports = {
    generateApiGuide,
    generateDirectSetupScript,
    generateMainCLIScript,
    getCurrentAgentCliVersion,
    // Exposed for agent spawn service to generate runner files
    generateAgentRunner,
    generateMessageHelperPython,
    generateOneshotInstructions,
    generateAgentInstructions,
    generateOrchestratorTemplate,
    generateRichFormSkill,
    generateSelfWakeGuide,
    generateNewsFeedAgentInstructions,
    // Chief of Staff
    CHIEF_OF_STAFF_DEFAULT_NAME,
    generateChiefOfStaffInstructions,
    generateChiefOfStaffRosterSkill,
    generateChiefOfStaffTmuxSpawnSkill
};
