/**
 * API Guide Generator
 * Generates a gum-based CLI main script for agent management
 */

/**
 * Generate the main CLI script that manages all agents
 * @param {string} apiKey - User's API key
 * @param {string} baseUrl - Base URL of the application
 * @param {string} encryptionSalt - User's encryption salt for E2E encryption (null for no encryption)
 * @returns {string} The main CLI bash script
 */
function generateMainCLIScript(apiKey, baseUrl, encryptionSalt = null) {
    const apiBase = `${baseUrl}/api`;
    const hasEncryption = encryptionSalt !== null;

    // Generate the embedded Python helper content
    const pythonHelper = generateMessageHelperPython(hasEncryption);
    const agentInstructions = generateAgentInstructions();
    const newsFeedAgentInstructions = generateNewsFeedAgentInstructions();
    const oneshotInstructions = generateOneshotInstructions();
    const agentRunner = generateAgentRunner();

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
#   - Configure model providers (Codex, Claude, Gemini, Ollama, LMStudio, OpenRouter)
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

# ═══════════════════════════════════════════════════════════════════════════════
# Version & Configuration
# ═══════════════════════════════════════════════════════════════════════════════
CLI_VERSION="1.1.1"  # Bump this when making changes

# Configuration (embedded from your account)
API_KEY="${apiKey}"
ENCRYPTION_SALT="${hasEncryption ? encryptionSalt : ''}"
API_BASE="${apiBase}"
HAS_ENCRYPTION="${hasEncryption ? 'true' : 'false'}"

# Script location
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CHATSPACE_DIR="$SCRIPT_DIR/chatspace"

# Colors for non-gum output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
CYAN='\\033[0;36m'
RESET='\\033[0m'

# ═══════════════════════════════════════════════════════════════════════════════
# Prerequisite Checks
# ═══════════════════════════════════════════════════════════════════════════════
check_prerequisites() {
    local missing=()
    
    if ! command -v gum &>/dev/null; then
        missing+=("gum")
    fi
    
    if ! command -v codex &>/dev/null; then
        missing+=("codex")
    fi
    
    if ! command -v uv &>/dev/null; then
        missing+=("uv")
    fi
    
    if [ \${#missing[@]} -gt 0 ]; then
        echo -e "\${RED}Missing required tools:\${RESET}"
        local still_missing=()
        for tool in "\${missing[@]}"; do
            case "$tool" in
                gum)
                    echo -e "  • gum - Install: https://github.com/charmbracelet/gum#installation"
                    still_missing+=("gum")
                    ;;
                codex)
                    echo -e "  • codex - Install: https://github.com/openai/codex"
                    still_missing+=("codex")
                    ;;
                uv)
                    echo -e "  • uv is missing."
                    read -p "  Do you want to install uv now? [y/N] " -n 1 -r
                    echo ""
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo "Installing uv..."
                        curl -LsSf https://astral.sh/uv/install.sh | sh
                        export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
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
    
    local agent_name
    agent_name=$(gum input \\
        --placeholder "MyAssistant" \\
        --prompt "Agent Name: " \\
        --width 40 \\
        --value "NewAgent")
    
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
            "default (Codex default - gpt-5.1-codex-max)" \\
            "openai (OpenAI API - requires OPENAI_API_KEY)" \\
            "codex-cli (Codex CLI - direct, uses ChatGPT login)" \\
            "claude (Claude CLI - direct, no API key needed)" \\
            "gemini (Gemini CLI - direct, no API key needed)" \\
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

select_model() {
    local provider="$1"
    local model
    
    case "$provider" in
        default)
            model=$(gum choose \\
                --header "Select model (uses your Codex/ChatGPT account):" \\
                --cursor "➤ " \\
                "gpt-5.1-codex-max (Best for coding - default)" \\
                "gpt-5.1-codex (GPT-5.1 Codex optimized)" \\
                "gpt-5.1 (GPT-5.1 general purpose)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        openai)
            model=$(gum choose \\
                --header "Select OpenAI model (uses OPENAI_API_KEY):" \\
                --cursor "➤ " \\
                "gpt-5.1 (Latest with reasoning)" \\
                "gpt-5 (Previous reasoning model)" \\
                "gpt-5-mini (Faster, cost-efficient)" \\
                "gpt-5-nano (Fastest)" \\
                "o3 (Reasoning model)" \\
                "o4-mini (Fast reasoning)" \\
                "gpt-4.1 (Smartest non-reasoning)" \\
                "gpt-4.1-mini (Smaller, faster)" \\
                "gpt-4o (Fast, intelligent)" \\
                "gpt-4o-mini (Affordable)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        openrouter)
            # OpenRouter provides access to many models via OpenAI-compatible API
            model=$(gum choose \\
                --header "Select model via OpenRouter:" \\
                --cursor "➤ " \\
                "anthropic/claude-sonnet-4 (Claude Sonnet 4 - best for coding)" \\
                "anthropic/claude-opus-4 (Claude Opus 4 - most intelligent)" \\
                "anthropic/claude-haiku-4 (Claude Haiku 4 - fastest)" \\
                "anthropic/claude-3.5-sonnet (Claude 3.5 Sonnet)" \\
                "google/gemini-2.5-pro-preview (Gemini 2.5 Pro)" \\
                "google/gemini-2.0-flash-001 (Gemini 2.0 Flash)" \\
                "meta-llama/llama-4-maverick (Llama 4 Maverick)" \\
                "meta-llama/llama-3.3-70b-instruct (Llama 3.3 70B)" \\
                "deepseek/deepseek-r1 (DeepSeek R1 reasoning)" \\
                "deepseek/deepseek-chat (DeepSeek V3)" \\
                "--- FREE MODELS ---" \\
                "x-ai/grok-4.1-fast:free (Grok 4.1 Fast - FREE)" \\
                "qwen/qwen3-coder:free (Qwen3 Coder - FREE)" \\
                "z-ai/glm-4.5-air:free (GLM 4.5 Air - FREE)" \\
                "mistralai/mistral-7b-instruct:free (Mistral 7B - FREE)")
            # Skip separator if selected
            if [ "$model" = "--- FREE MODELS ---" ]; then
                model="x-ai/grok-4.1-fast:free"
            else
                model=$(echo "$model" | cut -d' ' -f1)
            fi
            ;;
        codex-cli)
            # Codex CLI - uses your ChatGPT login
            model=$(gum choose \\
                --header "Select OpenAI model (via Codex CLI):" \\
                --cursor "➤ " \\
                "gpt-5.1-codex-max (Best for coding - default)" \\
                "gpt-5.1-codex (GPT-5.1 Codex optimized)" \\
                "gpt-5.1 (GPT-5.1 general purpose)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        claude)
            # Claude CLI - uses your authenticated Claude account
            # Supports aliases (sonnet, opus, haiku) or full model names
            model=$(gum choose \\
                --header "Select Claude model:" \\
                --cursor "➤ " \\
                "sonnet (Claude Sonnet - best for coding)" \\
                "opus (Claude Opus - most intelligent)" \\
                "haiku (Claude Haiku - fastest, cost-efficient)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        gemini)
            # Gemini CLI - uses your authenticated Gemini account
            # Note: Only 2.5 models support thinking mode required by the CLI
            model=$(gum choose \\
                --header "Select Gemini model:" \\
                --cursor "➤ " \\
                "gemini-2.5-pro (Best for complex tasks)" \\
                "gemini-2.5-flash (Fast and efficient)")
            model=$(echo "$model" | cut -d' ' -f1)
            ;;
        ollama)
            print_info "Fetching available Ollama models..."
            local ollama_models
            ollama_models=$(curl -s http://localhost:11434/api/tags 2>/dev/null | jq -r '.models[].name' 2>/dev/null || echo "")
            
            if [ -n "$ollama_models" ]; then
                model=$(echo "$ollama_models" | gum choose \\
                    --header "Select Ollama model:" \\
                    --cursor "➤ ")
            else
                model=$(gum input \\
                    --placeholder "llama3.2" \\
                    --prompt "Ollama model name: " \\
                    --value "llama3.2")
            fi
            ;;
        lmstudio)
            print_info "Fetching available LM Studio models..."
            local lmstudio_models
            lmstudio_models=$(curl -s http://localhost:1234/v1/models 2>/dev/null | jq -r '.data[].id' 2>/dev/null || echo "")
            
            if [ -n "$lmstudio_models" ]; then
                model=$(echo "$lmstudio_models" | gum choose \\
                    --header "Select LM Studio model:" \\
                    --cursor "➤ ")
            else
                model=$(gum input \\
                    --placeholder "local-model" \\
                    --prompt "LM Studio model name: " \\
                    --value "local-model")
            fi
            ;;
        *)
            model="gpt-5.1-codex-max"
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
            # Just start the runner with existing config
            print_section ">> Starting Agent..."
            exec "$agent_dir/agent-runner.sh"
        fi
    fi
    
    print_section "🔐 Permission Wizard"
    print_info "Select what the frontend is allowed to use for this agent."
    print_info "The frontend cannot escalate beyond these permissions."
    echo ""
    
    # Step 1: Select allowed providers
    print_info "Step 1: Select ALLOWED Providers"
    local allowed_providers
    allowed_providers=$(gum choose --no-limit \\
        --header "Which providers can the frontend use?" \\
        --cursor.foreground "10" \\
        "codex" \\
        "claude" \\
        "gemini" \\
        "ollama" \\
        "openrouter")
    
    if [ -z "$allowed_providers" ]; then
        print_error "You must allow at least one provider!"
        return 1
    fi
    
    print_success "Allowed providers: $(echo "$allowed_providers" | tr '\\n' ' ')"
    echo ""
    
    # Initialize permissions JSON
    local perms_json="{"
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
                
            ollama|openrouter)
                # These use codex CLI under the hood, so use similar permissions
                perms_json+='"'$provider'":{"enabled":true}'
                ;;
        esac
        
        print_success "$provider permissions configured"
    done
    
    perms_json+="}"
    
    # Save allowed permissions
    mkdir -p "$agent_dir/agent_state"
    echo "$perms_json" | jq '.' > "$allowed_perms_file"
    print_success "Saved allowed permissions to $allowed_perms_file"
    echo ""
    
    # Step 3: Configure project path
    print_info "Step 3: Set Project Path"
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
    
    # Determine initial sandbox mode from allowed permissions
    local initial_sandbox="none"
    case "$first_provider_name" in
        codex|default|ollama|openrouter)
            if echo "$perms_json" | grep -q '"danger-full-access"'; then
                initial_sandbox="none"
            fi
            ;;
        claude)
            if echo "$perms_json" | grep -q '"--dangerously-skip-permissions":true'; then
                initial_sandbox="none"
            fi
            ;;
        gemini)
            if echo "$perms_json" | grep -q '"--no-sandbox":true'; then
                initial_sandbox="none"
            fi
            ;;
    esac
    
    cat > "$config_file" <<CFGEOF
{
  "model_provider": "$first_provider_name",
  "model": "default",
  "approval_mode": "suggest",
  "sandbox_mode": "$initial_sandbox",
  "project_path": "$project_path",
  "started_at": "$(date -Iseconds)"
}
CFGEOF
    
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
    if ! gum confirm --affirmative "Start Agent" --negative "Cancel" "Start the agent runner now?"; then
        print_info "You can start the agent later by running this script again."
        return 0
    fi
    
    print_section ">> Starting Agent..."
    echo ""
    exec "$agent_dir/agent-runner.sh"
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
        
        if [ -f "$agent_dir/agent_state/agent_config.json" ]; then
            last_active=$(jq -r '.started_at // "Unknown"' "$agent_dir/agent_state/agent_config.json" 2>/dev/null || echo "Unknown")
        fi
        
        if [ -f "$agent_dir/agent_state/conversation_history.json" ]; then
            sessions=$(jq -r '.session_count // 0' "$agent_dir/agent_state/conversation_history.json" 2>/dev/null || echo "0")
        fi
        
        if [ -f "$agent_dir/agent_state/.running" ]; then
            status="● Running"
        fi
        
        echo "  $status  $agent_name"
        echo "         Last active: $last_active"
        echo "         Sessions: $sessions"
        echo ""
    done
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

[Service]
Type=simple
WorkingDirectory=$agent_dir
ExecStart=$agent_dir/agent-runner.sh
Restart=on-failure
RestartSec=10
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
    local menu_items=""
    local agent_list=()
    
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
        menu_items+="\${status_icon} [\${autostart_icon}] $agent_name\\n"
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
    
    local selected_agent
    selected_agent=$(echo "$existing_agents" | gum choose \\
        --header "Select an agent to configure:" \\
        --cursor "➤ ")
    
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
            exec "$agent_dir/agent-runner.sh"
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
# Main Menu
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
        
        local choice
        choice=$(gum choose \\
            --header "What would you like to do?" \\
            --cursor "➤ " \\
            "🆕 Create New Agent" \\
            "▶️  Continue Existing Agent" \\
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
                    local selected_agent
                    selected_agent=$(echo "$existing_agents" | gum choose \\
                        --header "Select an agent to continue:" \\
                        --cursor "➤ ")
                    
                    if [ -n "$selected_agent" ]; then
                        run_agent "$selected_agent"
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

    # AGENTS.md content
    local agents_content
    agents_content=$(cat <<'AGENTSEOF'
# Agent Instructions for Codex

This file provides guidance for standalone AI agents running with the Codex CLI.

**Note:** This applies to standalone CLI sessions only. If you are a runner-managed agent (spawned by \`agent-runner.sh\`), your response is automatically sent via \`agent_state/.agent_response.txt\`. You should STILL post to the news feed as described below.

## Post to News Feed (Shared Activity Log)

**CRITICAL: Mandatory Activity Logging**

After completing **each user request**, post a summary to the **shared news feed**. This is separate from your chat response.

\`\`\`bash
# Post summary to the shared News Feed (different channel from your chat):
uv run __SCRIPT_DIR__/chatspace/__NEWS_FEED_FOLDER__/message_helper.py send --json '{
  "type": "news_announcement",
  "agent": "Codex",
  "context": "'"$PWD"'",
  "status": "Completed",
  "summary": "Brief task summary here"
}'
\`\`\`

**Status values:** "Completed", "Running", "Failed", "Info"

**WARNING:** This goes to the NEWS FEED, not your chat. The news feed is a shared log visible to all agents. Use \`send\` only — do NOT call \`ask\` after posting. This command returns immediately.
AGENTSEOF
)
    # Replace placeholders in AGENTS.md content
    agents_content=$(echo "$agents_content" | sed -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" -e "s|__NEWS_FEED_FOLDER__|$news_feed_folder|g")
    append_or_create_file "$SCRIPT_DIR/AGENTS.md" "$agents_content"
    if [ -f "$SCRIPT_DIR/AGENTS.md" ] && grep -q "Agent Instructions for Codex" "$SCRIPT_DIR/AGENTS.md" 2>/dev/null; then
        print_success "Updated: AGENTS.md (appended)"
    else
        print_success "Created: AGENTS.md"
    fi

    # CLAUDE.md content
    local claude_content
    claude_content=$(cat <<'CLAUDEEOF'
# Agent Instructions for Claude

This file provides guidance for standalone AI agents running with the Claude CLI.

**Note:** This applies to standalone CLI sessions only. If you are a runner-managed agent (spawned by \`agent-runner.sh\`), your response is automatically sent via \`agent_state/.agent_response.txt\`. You should STILL post to the news feed as described below.

## Post to News Feed (Shared Activity Log)

**CRITICAL: Mandatory Activity Logging**

After completing **each user request**, post a summary to the **shared news feed**. This is separate from your chat response.

\`\`\`bash
# Post summary to the shared News Feed (different channel from your chat):
uv run __SCRIPT_DIR__/chatspace/__NEWS_FEED_FOLDER__/message_helper.py send --json '{
  "type": "news_announcement",
  "agent": "Claude",
  "context": "'"$PWD"'",
  "status": "Completed",
  "summary": "Brief task summary here"
}'
\`\`\`

**Status values:** "Completed", "Running", "Failed", "Info"

**WARNING:** This goes to the NEWS FEED, not your chat. The news feed is a shared log visible to all agents. Use \`send\` only — do NOT call \`ask\` after posting. This command returns immediately.
CLAUDEEOF
)
    # Replace placeholders in CLAUDE.md content
    claude_content=$(echo "$claude_content" | sed -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" -e "s|__NEWS_FEED_FOLDER__|$news_feed_folder|g")
    append_or_create_file "$SCRIPT_DIR/CLAUDE.md" "$claude_content"
    if [ -f "$SCRIPT_DIR/CLAUDE.md" ] && grep -q "Agent Instructions for Claude" "$SCRIPT_DIR/CLAUDE.md" 2>/dev/null; then
        print_success "Updated: CLAUDE.md (appended)"
    else
        print_success "Created: CLAUDE.md"
    fi

    # GEMINI.md content
    local gemini_content
    gemini_content=$(cat <<'GEMINIEOF'
# Agent Instructions for Gemini

This file provides guidance for standalone AI agents running with the Gemini CLI.

**Note:** This applies to standalone CLI sessions only. If you are a runner-managed agent (spawned by \`agent-runner.sh\`), your response is automatically sent via \`agent_state/.agent_response.txt\`. You should STILL post to the news feed as described below.

## Post to News Feed (Shared Activity Log)

**CRITICAL: Mandatory Activity Logging**

After completing **each user request**, post a summary to the **shared news feed**. This is separate from your chat response.

\`\`\`bash
# Post summary to the shared News Feed (different channel from your chat):
uv run __SCRIPT_DIR__/chatspace/__NEWS_FEED_FOLDER__/message_helper.py send --json '{
  "type": "news_announcement",
  "agent": "Gemini",
  "context": "'"$PWD"'",
  "status": "Completed",
  "summary": "Brief task summary here"
}'
\`\`\`

**Status values:** "Completed", "Running", "Failed", "Info"

**WARNING:** This goes to the NEWS FEED, not your chat. The news feed is a shared log visible to all agents. Use \`send\` only — do NOT call \`ask\` after posting. This command returns immediately.
GEMINIEOF
)
    # Replace placeholders in GEMINI.md content
    gemini_content=$(echo "$gemini_content" | sed -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" -e "s|__NEWS_FEED_FOLDER__|$news_feed_folder|g")
    append_or_create_file "$SCRIPT_DIR/GEMINI.md" "$gemini_content"
    if [ -f "$SCRIPT_DIR/GEMINI.md" ] && grep -q "Agent Instructions for Gemini" "$SCRIPT_DIR/GEMINI.md" 2>/dev/null; then
        print_success "Updated: GEMINI.md (appended)"
    else
        print_success "Created: GEMINI.md"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
check_prerequisites
mkdir -p "$CHATSPACE_DIR"
check_news_feed_agent
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
${binaryEncryptFuncs}${imageHelperFuncs}` : `
def _encrypt_message(plaintext: str) -> str:
    return plaintext


def _decrypt_message(data: str) -> str:
    return data
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
#     "python-dotenv>=1.0.0",
#     "cryptography>=41.0.0",${pillowDep}
# ]
# ///
"""
message_helper.py - Agent messaging helper functions
Run with: uv run message_helper.py <command>

Features:
- Send encrypted text messages
- Ask questions with optional multiple choice options
- Upload encrypted image attachments
- Download and decrypt received attachments
- Poll for user responses

Usage examples:
  uv run message_helper.py send "Hello, world!"
  uv run message_helper.py ask "What should I do?" --options '["Option A", "Option B"]'
  uv run message_helper.py upload /path/to/image.png
  uv run message_helper.py download <attachment-id> /path/to/save.png --iv <iv> --tag <tag>
"""

import os
import sys
import json
import time
import base64
import hashlib
import urllib.parse${additionalImports}
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
        "Content-Type": "application/json"
    }

    try:
        if method.upper() == "GET":
            response = requests.get(url, headers=headers, timeout=30)
        elif method.upper() == "POST":
            response = requests.post(url, headers=headers, json=data, timeout=30)
        else:
            response = requests.request(method, url, headers=headers, json=data, timeout=30)

        try:
            return response.json()
        except json.JSONDecodeError:
            return {"raw": response.text}
    except requests.RequestException as e:
        return {"error": str(e)}


_last_read_time: str = None
MAX_WAIT_BEFORE_RETURN = int(os.getenv("MAX_WAIT_SECONDS", "90"))
_STATE_FILE = _script_dir / ".wait_state.json"
_CONVERSATION_HISTORY_FILE = _script_dir / "agent_state" / "conversation_history.json"


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


_load_state()


def _decrypt_payload_items(items: list) -> list:
    if not items:
        return items
    for item in items:
        if item.get("content"):
            item["content"] = _decrypt_message(item.get("content", ""))
        if item.get("freeResponse"):
            item["freeResponse"] = _decrypt_message(item.get("freeResponse", ""))
    return items


def send_message(content: str, priority: int = 0,
                 attachment_ids: list = None) -> dict:
    """
    Send an encrypted text message, optionally with attachments.

    Args:
        content: Message text to send
        priority: Message priority (0=normal, 1=high, 2=urgent)
        attachment_ids: Optional list of attachment UUIDs to include
                       (from previous upload_image() calls)

    Returns:
        dict with message status and any new messages from the server

    Example:
        >>> # Send text-only message
        >>> send_message("Hello!")

        >>> # Send message with image attachment
        >>> upload_result = upload_image("/path/to/image.png")
        >>> send_message("Check out this image!",
        ...              attachment_ids=[upload_result["attachmentId"]])
    """
    encrypted = ${encryptCall}
    payload = {
        "content": encrypted,
        "priority": priority,
        "agentName": Config.agent_name,
        "encrypted": ${encryptedFlag}
    }

    # Include attachment IDs if provided
    if attachment_ids:
        payload["attachmentIds"] = attachment_ids

    result = _api_request("POST", "/agent/messages", payload)
    if result.get("newMessages"):
        _decrypt_payload_items(result["newMessages"])
    # Write to local conversation history on success
    if result.get("status") == "sent" or result.get("messageId"):
        _append_to_conversation_history("agent_message", content, priority)
    return result


def ask_question(content: str, options: list = None, priority: int = 0, poll_interval: int = 10, timeout: int = 0):
    global _last_read_time

    agent_param = f"agentName={urllib.parse.quote(Config.agent_name)}"
    pre_check = _api_request("GET", f"/agent/responses?{agent_param}")
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


def check_new_messages() -> list:
    global _last_read_time

    agent_param = f"agentName={urllib.parse.quote(Config.agent_name)}"
    path = f"/agent/responses?{agent_param}"
    if _last_read_time:
        path += f"&since={_last_read_time}"

    result = _api_request("GET", path)
    responses = []

    if result.get("responses"):
        responses = _decrypt_payload_items(result["responses"])
        
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


def _wait_for_responses(poll_interval: int = 10, timeout: int = 0):
    global _last_read_time

    agent_param = f"agentName={urllib.parse.quote(Config.agent_name)}"
    start_time = _last_read_time

    if not start_time:
        initial_check = _api_request("GET", f"/agent/responses?{agent_param}")
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

        path = f"/agent/responses?{agent_param}"
        if start_time:
            path += f"&since={start_time}"

        result = _api_request("GET", path)
        responses = []
        if result.get("responses"):
            responses = _decrypt_payload_items([r for r in result["responses"] if r.get("content") or r.get("freeResponse")])
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


def _format_history_for_llm(history: dict) -> str:
    if history.get("isNewAgent") or history.get("messageCount", 0) == 0:
        return "No previous conversation. This is a new session."

    lines = [f"Conversation history ({history.get('messageCount', 0)} messages):", ""]
    my_name = Config.agent_name.upper()

    for msg in history.get("messages", []):
        sender = msg.get("from", "unknown")
        msg_type = msg.get("type", "")

        if msg_type in ("agent_message", "agent_question"):
            content = _decrypt_message(msg.get("content", ""))
            if sender.upper() == my_name:
                prefix = "[YOU]" if msg_type == "agent_message" else "[YOU asked]"
            else:
                prefix = f"[{sender}]"
            lines.append(f"{prefix} {content}")
        elif msg_type == "user_message":
            content = _decrypt_message(msg.get("content", ""))
            lines.append(f"[USER] {content}")
        elif msg_type == "user_response":
            selected = msg.get("selectedOption", "")
            free = msg.get("freeResponse", "")
            if selected and free:
                lines.append(f"[USER answered] {selected} - {free}")
            elif selected:
                lines.append(f"[USER answered] {selected}")
            elif free:
                lines.append(f"[USER answered] {free}")

    return "\\n".join(lines)


def _format_responses_for_llm(responses: list, attachment_paths: dict = None) -> str:
    if not responses:
        return "No new messages."

    attachment_paths = attachment_paths or {}
    lines = []
    for r in responses:
        sender = r.get("from", "user")
        label = sender.upper() if sender else "USER"

        if r.get("content"):
            lines.append(f"[{label}] {r['content']}")
        elif r.get("selectedOption") or r.get("freeResponse"):
            selected = r.get("selectedOption", "")
            free = r.get("freeResponse", "")
            if selected and free:
                lines.append(f"[{label} answered] {selected} - {free}")
            elif selected:
                lines.append(f"[{label} answered] {selected}")
            elif free:
                lines.append(f"[{label} answered] {free}")
        
        # Add attachment info if present
        attachments = r.get("attachments", [])
        for att in attachments:
            att_id = att.get("attachmentId", "")
            content_type = att.get("contentType", "file")
            local_path = attachment_paths.get(att_id)
            if local_path:
                lines.append(f"[{label} attached {content_type}] Local file: {local_path}")
            else:
                lines.append(f"[{label} attached {content_type}] Attachment ID: {att_id}")

    return "\\n".join(lines) if lines else "No new messages."


${hasEncryption ? `def main():
    if len(sys.argv) < 2:
        print("""Usage:
  uv run message_helper.py send <message> [--priority 0|1|2] [--attach <image-path>]
  uv run message_helper.py ask <question> [--priority 0|1|2] [--timeout <seconds>]
  uv run message_helper.py wait [--timeout <seconds>]
  uv run message_helper.py check
  uv run message_helper.py history
  uv run message_helper.py upload <image-path>
  uv run message_helper.py download <attachment-id> <save-path> --iv <iv-base64> --tag <tag-base64>

Image Commands:
  upload    - Upload an encrypted image, returns attachment ID
  download  - Download and decrypt an attachment by ID
  send --attach - Send a message with an image attachment""")
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    priority = 0
    timeout = 0
    options = None
    attachment_path = None
    iv_base64 = None
    auth_tag_base64 = None
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
        elif args[i] == "--iv" and i + 1 < len(args):
            iv_base64 = args[i + 1]
            i += 2
        elif args[i] == "--tag" and i + 1 < len(args):
            auth_tag_base64 = args[i + 1]
            i += 2
        else:
            message_parts.append(args[i])
            i += 1

    message = " ".join(message_parts) if message_parts else ""

    if command == "send":
        if not message:
            print("Error: Message is required for send command")
            sys.exit(1)

        attachment_ids = None
        if attachment_path:
            # Upload the attachment first
            print(f"Uploading attachment: {attachment_path}")
            upload_result = upload_image(attachment_path)
            if "error" in upload_result:
                print(f"Failed to upload attachment: {upload_result['error']}")
                sys.exit(1)
            attachment_ids = [upload_result["attachmentId"]]
            print(f"Attachment uploaded: {upload_result['attachmentId']}")

        result = send_message(message, priority=priority, attachment_ids=attachment_ids)
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

    elif command == "history":
        history = get_message_history()
        print(_format_history_for_llm(history))

    elif command == "config":
        config = get_config()
        # Output as JSON for bash to parse
        print(json.dumps(config))

    elif command == "upload":
        if not message_parts:
            print("Error: Image path is required for upload command")
            print("Usage: uv run message_helper.py upload <image-path>")
            sys.exit(1)
        image_path = message_parts[0]
        result = upload_image(image_path)
        if "attachmentId" in result:
            print(f"Upload successful!")
            print(f"  Attachment ID: {result['attachmentId']}")
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

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()` : `def main():
    if len(sys.argv) < 2:
        print("""Usage:
  uv run message_helper.py send <message> [--priority 0|1|2] [--json]
  uv run message_helper.py ask <question> [--priority 0|1|2] [--timeout <seconds>]
  uv run message_helper.py wait [--timeout <seconds>]
  uv run message_helper.py check
  uv run message_helper.py history""")
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    priority = 0
    timeout = 0
    options = None
    is_json = False
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
        elif args[i] == "--json":
            is_json = True
            i += 1
        else:
            message_parts.append(args[i])
            i += 1

    message = " ".join(message_parts) if message_parts else ""

    if command == "send":
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

    elif command == "history":
        history = get_message_history()
        print(_format_history_for_llm(history))

    elif command == "config":
        config = get_config()
        # Output as JSON for bash to parse
        print(json.dumps(config))

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()`}`;
}

/**
 * Generate agent instructions markdown
 */
function generateAgentInstructions() {
    return `# Agent Communication Instructions

You are an AI agent that communicates with a human ONLY through the messaging API.
You never talk directly to the human - all communication goes through CLI commands.

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

## First Action
1. Run \`history\` to check for existing context
2. Run \`send "Hello! I am ready."\` to introduce yourself

## News Feed Announcements (Activity Logging)
To communicate with other agents or log your status to the News Feed user, send a JSON-formatted message:

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
3. Run \`ask "What would you like me to do?"\` to wait for instructions
4. If you get CONTINUE_WAITING, run \`wait\` to keep waiting`;
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

## Scheduling Delayed Tasks

You can schedule tasks to run at a future time:

\`\`\`bash
cat > agent_state/.scheduled_tasks.json << 'EOF'
[
  {
    "id": "unique-id",
    "task": "Description of what to do",
    "run_at": "2024-01-15T15:30:00Z",
    "priority": 1
  }
]
EOF
\`\`\``;
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
CONFIG_FILE="$STATE_DIR/agent_config.json"
ALLOWED_PERMS_FILE="$STATE_DIR/allowed_permissions.json"
SUMMARY_FILE="$STATE_DIR/agent_summary.md"
CONVERSATION_FILE="$STATE_DIR/conversation_history.json"
SCHEDULED_TASKS_FILE="$STATE_DIR/.scheduled_tasks.json"
AGENT_RESPONSE_FILE="$STATE_DIR/.agent_response.txt"
AGENT_PID_FILE="$STATE_DIR/.agent_pid"
LAST_RUN_FILE="$STATE_DIR/.last_run"

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
        local new_provider new_model new_approval new_sandbox new_project_path
        new_provider=$(jq -r '.model_provider // empty' "$CONFIG_FILE" 2>/dev/null)
        new_model=$(jq -r '.model // empty' "$CONFIG_FILE" 2>/dev/null)
        new_approval=$(jq -r '.approval_mode // empty' "$CONFIG_FILE" 2>/dev/null)
        new_sandbox=$(jq -r '.sandbox_mode // empty' "$CONFIG_FILE" 2>/dev/null)
        new_project_path=$(jq -r '.project_path // empty' "$CONFIG_FILE" 2>/dev/null)
        
        # Update if values exist
        [ -n "$new_provider" ] && MODEL_PROVIDER="$new_provider"
        [ -n "$new_model" ] && MODEL="$new_model"
        [ -n "$new_approval" ] && APPROVAL_MODE="$new_approval"
        [ -n "$new_sandbox" ] && SANDBOX_MODE="$new_sandbox"
        [ -n "$new_project_path" ] && PROJECT_ROOT="$new_project_path"
    fi
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
    local api_provider api_model api_approval api_sandbox
    api_provider=$(echo "$config_json" | jq -r '.model_provider // empty' 2>/dev/null)
    api_model=$(echo "$config_json" | jq -r '.model // empty' 2>/dev/null)
    api_approval=$(echo "$config_json" | jq -r '.approval_mode // empty' 2>/dev/null)
    api_sandbox=$(echo "$config_json" | jq -r '.sandbox_mode // empty' 2>/dev/null)
    
    # Update if values exist (API takes precedence for these settings)
    [ -n "$api_provider" ] && MODEL_PROVIDER="$api_provider"
    [ -n "$api_model" ] && MODEL="$api_model"
    [ -n "$api_approval" ] && APPROVAL_MODE="$api_approval"
    [ -n "$api_sandbox" ] && SANDBOX_MODE="$api_sandbox"
    
    log INFO "Fetched config from API: provider=$MODEL_PROVIDER, approval=$APPROVAL_MODE, sandbox=$SANDBOX_MODE"
}

# Validate config against allowed permissions
# Returns 0 if valid, 1 if invalid (and sends error message)
validate_config() {
    # If no permissions file or empty, allow all
    if [ -z "$ALLOWED_PERMISSIONS" ] || [ "$ALLOWED_PERMISSIONS" = "{}" ]; then
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
        local allowed_list
        allowed_list=$(echo "$ALLOWED_PERMISSIONS" | jq -r 'keys | join(", ")' 2>/dev/null)
        log ERROR "Provider '$check_provider' is not allowed. Allowed: $allowed_list"
        send_message "❌ Configuration Error: Provider '$check_provider' is not allowed by your permission settings. Allowed providers: $allowed_list. Please update your config using the dashboard." "1"
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
                    local sandbox_list
                    sandbox_list=$(echo "$allowed_sandboxes" | jq -r 'join(", ")' 2>/dev/null)
                    log ERROR "Sandbox mode '$sandbox_value' not allowed. Allowed: $sandbox_list"
                    send_message "❌ Configuration Error: Sandbox mode '$sandbox_value' is not allowed. Allowed modes: $sandbox_list. Please update your config." "1"
                    return 1
                fi
            fi
            
            # Check bypass flag (full-auto + no sandbox)
            if [ "$APPROVAL_MODE" = "full-auto" ] && [ "$SANDBOX_MODE" = "none" ]; then
                local bypass_allowed
                bypass_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".\\"$check_provider\\".\\"--dangerously-bypass-approvals-and-sandbox\\" // false" 2>/dev/null)
                if [ "$bypass_allowed" != "true" ]; then
                    log ERROR "Full bypass mode not allowed"
                    send_message "❌ Configuration Error: Full bypass mode (--dangerously-bypass-approvals-and-sandbox) is not allowed by your permissions." "1"
                    return 1
                fi
            fi
            ;;
        claude)
            # Check permission mode
            local allowed_modes
            allowed_modes=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".claude.\\"--permission-mode\\" // []" 2>/dev/null)
            
            if [ -n "$allowed_modes" ] && [ "$allowed_modes" != "[]" ] && [ "$allowed_modes" != "null" ]; then
                if ! echo "$allowed_modes" | jq -e "index(\\"$APPROVAL_MODE\\")" >/dev/null 2>&1; then
                    local mode_list
                    mode_list=$(echo "$allowed_modes" | jq -r 'join(", ")' 2>/dev/null)
                    log ERROR "Permission mode '$APPROVAL_MODE' not allowed. Allowed: $mode_list"
                    send_message "❌ Configuration Error: Permission mode '$APPROVAL_MODE' is not allowed. Allowed modes: $mode_list." "1"
                    return 1
                fi
            fi
            
            # Check skip permissions (sandbox_mode = none means skip all)
            if [ "$SANDBOX_MODE" = "none" ]; then
                local skip_allowed
                skip_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".claude.\\"--dangerously-skip-permissions\\" // false" 2>/dev/null)
                if [ "$skip_allowed" != "true" ]; then
                    log ERROR "Skip permissions not allowed"
                    send_message "❌ Configuration Error: Skip permissions mode (--dangerously-skip-permissions) is not allowed." "1"
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
                    send_message "❌ Configuration Error: No-sandbox mode is not allowed for Gemini." "1"
                    return 1
                fi
            else
                local sandbox_allowed
                sandbox_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".gemini.\\"--sandbox\\" // false" 2>/dev/null)
                if [ "$sandbox_allowed" != "true" ]; then
                    log ERROR "Sandbox mode not allowed for Gemini"
                    send_message "❌ Configuration Error: Sandbox mode is not allowed for Gemini." "1"
                    return 1
                fi
            fi
            
            # Check yolo mode
            if [ "$APPROVAL_MODE" = "full-auto" ]; then
                local yolo_allowed
                yolo_allowed=$(echo "$ALLOWED_PERMISSIONS" | jq -r ".gemini.\\"--yolo\\" // false" 2>/dev/null)
                if [ "$yolo_allowed" != "true" ]; then
                    log ERROR "YOLO mode not allowed for Gemini"
                    send_message "❌ Configuration Error: YOLO mode (--yolo) is not allowed for Gemini." "1"
                    return 1
                fi
            fi
            ;;
    esac
    
    return 0
}

# Check if stop was requested
check_stop_flag() {
    [ -f "$STOP_FLAG" ]
}

# Handle stop request - kill running agent and send message
handle_stop() {
    log WARN "Stop requested by user"
    
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
    
    # Send stopped message to user
    send_message "⏹ Agent stopped. Waiting for new instructions." "0"
    
    # Clear stop flag
    rm -f "$STOP_FLAG"
    
    log SUCCESS "Agent stopped, continuing to poll for messages"
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
    exit 0
}

trap cleanup SIGINT SIGTERM

check_for_messages() {
    cd "$SCRIPT_DIR"
    # Use check-attachments to download images and get message text
    local received_images_dir="$STATE_DIR/received_images"
    mkdir -p "$received_images_dir"
    uv run message_helper.py check-attachments "$received_images_dir" 2>/dev/null || echo ""
}

get_history() {
    cd "$SCRIPT_DIR"
    uv run message_helper.py history 2>/dev/null || echo "No history available. This is a new session."
}

has_new_messages() {
    local check_result="$1"
    [ -n "$check_result" ] && [ "$check_result" != "No new messages." ]
}

send_message() {
    local message="$1"
    local priority="\${2:-0}"
    cd "$SCRIPT_DIR"
    local output
    output=$(uv run message_helper.py send "$message" --priority "$priority" 2>&1)
    local exit_code=$?
    
    if [ $exit_code -eq 0 ] && ! echo "$output" | grep -q "Failed to send\\|error\\|ERROR"; then
        log INFO "API Output: $output"
        return 0
    else
        log ERROR "Failed to send message: $output"
        return 1
    fi
}

# Run CLI command in background with stop flag monitoring
# Usage: run_cli_in_background "command" "arg1" "arg2" ...
# Returns: exit code of CLI or 143 if killed by stop
run_cli_in_background() {
    local cmd_args=("$@")
    
    # Run command in background
    "\${cmd_args[@]}" &
    local cli_pid=$!
    
    # Save PID for stop handling
    echo "$cli_pid" > "$AGENT_PID_FILE"
    
    log INFO "CLI started with PID $cli_pid"
    
    # Poll while CLI is running
    while kill -0 "$cli_pid" 2>/dev/null; do
        # Check for stop flag
        if check_stop_flag; then
            log WARN "Stop requested - killing CLI process $cli_pid"
            kill "$cli_pid" 2>/dev/null || true
            wait "$cli_pid" 2>/dev/null || true
            rm -f "$AGENT_PID_FILE"
            return 143  # SIGTERM exit code
        fi
        sleep 1
    done
    
    # Wait for process to finish and get exit code
    wait "$cli_pid" 2>/dev/null
    local exit_code=$?
    
    rm -f "$AGENT_PID_FILE"
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
To send an image to the user, use the upload command:
  cd $SCRIPT_DIR
  uv run message_helper.py upload /path/to/your/image.png

This returns an attachment ID. Then send a message mentioning you've uploaded the image.
The image will appear inline in the user's chat.

IMPORTANT: Do NOT send images as base64 text. Use the upload command.

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
- If you can write files, update $STATE_DIR/agent_summary.md before exiting
- Answer the user's question directly and concisely
PROMPT
}

run_agent() {
    local prompt="$1"
    
    log INFO "Waking up agent..."
    
    local prompt_file
    prompt_file=$(mktemp)
    echo "$prompt" > "$prompt_file"
    
    # Change to project root directory (agent files stay in SCRIPT_DIR)
    cd "$PROJECT_ROOT"
    
    # Handle different CLI tools based on provider
    case "$MODEL_PROVIDER" in
        claude)
            # Use Claude CLI directly
            # -p = print mode (non-interactive), prompt is positional argument
            # Note: Claude doesn't have sandbox modes like Codex - uses permission modes instead
            local claude_args=()
            
            # Add model if specified and not 'default' (Claude CLI uses its own default)
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                claude_args+=("--model" "$MODEL")
            fi

            # Print mode - non-interactive, reads prompt from stdin
            claude_args+=("-p")
            # Output format for non-interactive execution
            claude_args+=("--output-format" "text")
            
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
            send_message "�� Received message, about to run: $cmd_preview" "0"

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            # Pass prompt via stdin - this handles long multi-line prompts correctly
            echo "$prompt" | claude "\${claude_args[@]}" 2>&1 | tee "$stdout_capture" || true
            
            rm -f "$prompt_file"
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                captured_output=$(cat "$stdout_capture")
                
                if [ -n "$captured_output" ]; then
                    # Try to extract meaningful response from the output
                    # Be less aggressive with filtering - only remove known CLI noise
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
            
        gemini)
            # Use Gemini CLI directly
            # Use -p flag for prompt (more reliable than positional)
            # Gemini uses --sandbox (boolean) and --approval-mode
            local gemini_args=()
            
            # Add model if specified and not 'default' (Gemini CLI uses its own default)
            if [ -n "$MODEL" ] && [ "$MODEL" != "default" ]; then
                gemini_args+=("--model" "$MODEL")
            fi
            
            # Add output format
            gemini_args+=("-o" "text")
            # Handle sandbox mode - Gemini uses boolean --sandbox/--no-sandbox flags
            case "$SANDBOX_MODE" in
                none)
                    gemini_args+=("--no-sandbox")
                    ;;
                workspace-write|read-only)
                    gemini_args+=("--sandbox")
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
            
            # Prompt is passed via stdin (required for long multi-line prompts)
            # Passing long prompts as positional arguments can fail silently

            # Build command string for notification (show flags only)
            local cmd_preview="gemini"
            for arg in "\${gemini_args[@]}"; do
                cmd_preview+=" $arg"
            done
            cmd_preview+=" (prompt from stdin)"

            log INFO "Running: gemini \${gemini_args[*]} (prompt from stdin)"

            # Send notification to user about what command is being executed
            send_message "�� Received message, about to run: $cmd_preview" "0"

            # Capture stdout as fallback in case agent doesn't write to response file
            local stdout_capture="$STATE_DIR/.agent_stdout.txt"
            # Pass prompt via stdin - this handles long multi-line prompts correctly
            echo "$prompt" | gemini "\${gemini_args[@]}" 2>&1 | tee "$stdout_capture" || true
            
            rm -f "$prompt_file"
            log SUCCESS "Agent session completed"
            
            # If no response file but we captured stdout, use that as the response
            if [ ! -f "$AGENT_RESPONSE_FILE" ] && [ -f "$stdout_capture" ]; then
                local captured_output
                # Get the stdout content
                captured_output=$(cat "$stdout_capture")
                
                if [ -n "$captured_output" ]; then
                    # Try to extract meaningful response from the output
                    # Be less aggressive with filtering - only remove known CLI noise
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
                    
                    # If filtered output is empty, try keeping more content
                    if [ -z "$filtered_output" ]; then
                        # Just remove obvious UI elements, keep everything else
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
            
        codex-cli)
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
                codex_args+=("--cd" "$SCRIPT_DIR")
            fi
            
            # Add model if specified
            if [ -n "$MODEL" ]; then
                codex_args+=("--model" "$MODEL")
            fi
            
            codex_args+=("-")
            
            # Build command string for notification (without the prompt from stdin)
            local cmd_preview="codex exec"
            for arg in "\${codex_args[@]}"; do
                [[ "$arg" != "-" ]] && cmd_preview+=" $arg"
            done
            cmd_preview+=" -"
            
            log INFO "Running: codex \${codex_args[*]}"
            
            # Send notification to user about what command is being executed
            send_message "�� Received message, about to run: $cmd_preview" "0"
            
            cat "$prompt_file" | codex "\${codex_args[@]}" 2>&1 || true
            rm -f "$prompt_file"
            log SUCCESS "Agent session completed"
            ;;
            
        *)
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
                codex_args+=("--cd" "$SCRIPT_DIR")
            fi
            
            # Handle model and provider for codex
            case "$MODEL_PROVIDER" in
                default)
                    # Use Codex default (ChatGPT account)
                    if [ -n "$MODEL" ] && [ "$MODEL" != "gpt-5.1-codex-max" ]; then
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
            
            codex_args+=("-")
            
            # Build command string for notification (without the prompt from stdin)
            local cmd_preview="codex exec"
            for arg in "\${codex_args[@]}"; do
                [[ "$arg" != "-" ]] && cmd_preview+=" $arg"
            done
            cmd_preview+=" -"
            
            log INFO "Running: codex \${codex_args[*]:0:5}... (prompt from stdin)"
            
            # Send notification to user about what command is being executed
            send_message "�� Received message, about to run: $cmd_preview" "0"
            
            cat "$prompt_file" | codex "\${codex_args[@]}" 2>&1 || true
            rm -f "$prompt_file"
            log SUCCESS "Agent session completed"
            ;;
    esac
    
    # Check for response file (required for all agents)
    if [ -f "$AGENT_RESPONSE_FILE" ]; then
        local response
        response=$(cat "$AGENT_RESPONSE_FILE")
        if [ -n "$response" ]; then
            log INFO "Sending agent response to API..."
            
            # Parse priority from response (format: "message|priority")
            local message="$response"
            local priority="0"
            
            if [[ "$response" =~ \\|[0-2]$ ]]; then
                # Extract priority (last character after |)
                priority="\${response##*|}"
                # Remove priority suffix from message
                message="\${response%|*}"
            fi
            
            log INFO "Message: $message (Priority: $priority)"
            if send_message "$message" "$priority"; then
                log SUCCESS "Response sent to user"
            else
                log ERROR "Failed to send response to user"
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
    session_count=$(jq '.session_count' "$CONVERSATION_FILE" 2>/dev/null || echo "0")
    session_count=$((session_count + 1))
    jq ".session_count = $session_count" "$CONVERSATION_FILE" > "$CONVERSATION_FILE.tmp" && mv "$CONVERSATION_FILE.tmp" "$CONVERSATION_FILE"
}

main() {
    # Load allowed permissions ONCE at startup (immutable during runtime)
    load_allowed_permissions
    
    # Load initial config
    load_config
    
    log INFO "Starting Agent Runner"
    log INFO "  Model: $MODEL_PROVIDER / $MODEL"
    log INFO "  Approval Mode: $APPROVAL_MODE"
    log INFO "  Sandbox Mode: $SANDBOX_MODE"
    log INFO "  Agent Name: $AGENT_NAME"
    log INFO "  Poll Interval: \${POLL_INTERVAL}s"
    log INFO ""
    log INFO "Waiting for messages... (Ctrl+C to stop)"
    
    echo $$ > "$RUNNING_FLAG"
    
    local history
    history=$(get_history)
    
    # Check if this is a new agent (no previous messages)
    local is_new_agent="false"
    if echo "$history" | grep -qi "new session\\|No previous conversation\\|No history available"; then
        is_new_agent="true"
    fi
    
    if [ "$is_new_agent" = "true" ]; then
        log INFO "First run detected - sending introduction message"
        if send_message "Hello! I am $AGENT_NAME and I am ready to assist you. What would you like me to help with?"; then
            log SUCCESS "Introduction message sent!"
        else
            log ERROR "Failed to send introduction message"
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
        
        local scheduled_task
        scheduled_task=$(check_scheduled_tasks)
        
        if [ -n "$scheduled_task" ]; then
            log SUCCESS "Scheduled task triggered!"
            log INFO "Task: $scheduled_task"
            
            history=$(get_history)
            local task_prompt
            task_prompt=$(build_agent_prompt "SCHEDULED TASK: $scheduled_task" "$history")
            run_agent "$task_prompt"
            process_scheduled_task "$scheduled_task"
            log INFO "Scheduled task completed"
        fi
        
        local check_result
        check_result=$(check_for_messages)
        
        if has_new_messages "$check_result"; then
            log SUCCESS "New message(s) received!"
            log INFO "Messages: $check_result"
            
            history=$(get_history)
            local prompt
            prompt=$(build_agent_prompt "$check_result" "$history")
            run_agent "$prompt"
            
            log INFO "Agent completed, resuming watch..."
        fi
        
        sleep "$POLL_INTERVAL"
    done
}

main`;
}

/**
 * Legacy function - generates simple API guide for backwards compatibility
 */
function generateApiGuide(apiKey, baseUrl, agentName = 'Your Agent Name', encryptionSalt = null) {
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const helperFolder = `chatspace/${agentFolder}`;

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
    const agentDir = `chatspace/${agentFolder}`;
    const hasEncryption = encryptionSalt !== null;

    const pythonHelper = generateMessageHelperPython(hasEncryption);
    const agentInstructions = generateAgentInstructions();
    const oneshotInstructions = generateOneshotInstructions();
    const agentRunner = generateAgentRunner();

    const passwordBlock = hasEncryption ? `
echo "🔐 End-to-end encryption is enabled. Your password never leaves this machine."
read -sp "Enter your account password (used for encryption): " USER_PASSWORD
echo ""` : `
USER_PASSWORD=""`;

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
MODEL="\${MODEL:-gpt-5.1-codex-max}"
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
    generateMainCLIScript
};
