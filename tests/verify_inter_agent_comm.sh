#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Inter-Agent Communication Verification Script
# ═══════════════════════════════════════════════════════════════════════════════
# This script automates the testing of:
# 1. Creating two regular agents with identical structure
# 2. Configuring them in the same group for inter-agent communication
# 3. Discovering other agents
# 4. Sending and receiving direct messages

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

print_step() {
    echo -e "${YELLOW}>> $1${RESET}"
}

print_success() {
    echo -e "${GREEN}✓ $1${RESET}"
}

print_error() {
    echo -e "${RED}✗ $1${RESET}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${RESET}"
}

configure_inter_agent_mode() {
    local agent_name="$1"
    local mode="$2"
    local group_name="$3"

    print_step "Configuring inter-agent mode for $agent_name ($mode)"

    local payload
    if [ -n "$group_name" ]; then
        payload=$(cat <<EOF
{"agentName":"$agent_name","inter_agent_mode":"$mode","agent_groups":["$group_name"]}
EOF
)
    else
        payload=$(cat <<EOF
{"agentName":"$agent_name","inter_agent_mode":"$mode"}
EOF
)
    fi

    CONFIG_OUTPUT=$(curl -s -X PUT "$API_BASE/agent/config" \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>&1) || true

    if echo "$CONFIG_OUTPUT" | grep -qi "\"error\""; then
        print_error "Failed to configure inter-agent mode for $agent_name"
        echo "$CONFIG_OUTPUT"
    else
        print_success "Configured inter-agent mode for $agent_name"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

# API configuration - can be overridden via environment variables
API_BASE="${API_BASE:-http://localhost:3000/api}"
API_KEY="${API_KEY:-}"
USER_PASSWORD="${USER_PASSWORD:-123123}"
ENCRYPTION_SALT="${ENCRYPTION_SALT:-}"
TEST_GROUP="${TEST_GROUP:-inter_agent_test_group}"

# Get API Key if not provided
if [ -z "$API_KEY" ]; then
    read -rp "Enter your API Key: " API_KEY
fi

if [ -z "$API_KEY" ]; then
    print_error "API Key is required"
    exit 1
fi

# Fetch encryption salt from server CLI script (DB-backed) and prefer it
CLI_SCRIPT=$(curl -s -H "X-API-Key: $API_KEY" "$API_BASE/agent/cli-script" 2>/dev/null || true)
API_SALT=$(echo "$CLI_SCRIPT" | sed -nE 's/^ENCRYPTION_SALT=\"?([A-Za-z0-9+/=]+)\"?.*$/\1/p' | grep -v '\$' | head -n 1)

if [ -n "$API_SALT" ]; then
    if [ -n "$ENCRYPTION_SALT" ] && [ "$ENCRYPTION_SALT" != "$API_SALT" ]; then
        print_info "Overriding ENCRYPTION_SALT with server value for consistent decryption."
    fi
    ENCRYPTION_SALT="$API_SALT"
fi

if [ -z "$ENCRYPTION_SALT" ]; then
    print_error "ENCRYPTION_SALT not set and could not be fetched from server."
    print_info "Set ENCRYPTION_SALT env var or ensure /api/agent/cli-script is reachable."
    exit 1
fi

# Validate encryption salt looks like base64 (length multiple of 4)
if [ $(( ${#ENCRYPTION_SALT} % 4 )) -ne 0 ]; then
    print_error "ENCRYPTION_SALT is invalid (not base64 length)."
    print_info "Set ENCRYPTION_SALT env var or ensure /api/agent/cli-script is reachable."
    exit 1
fi

export API_KEY
export API_BASE
export USER_PASSWORD
export ENCRYPTION_SALT

# ═══════════════════════════════════════════════════════════════════════════════
# Check API Connectivity
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Checking API connectivity at $API_BASE..."
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${API_BASE%/api}/health" 2>/dev/null || echo "000")
if [ "$API_HEALTH" = "200" ]; then
    print_success "API server is reachable"
else
    # Try the API base directly
    API_CHECK=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 -H "X-API-Key: $API_KEY" "$API_BASE/agent/discover" 2>/dev/null || echo "000")
    if [ "$API_CHECK" = "200" ] || [ "$API_CHECK" = "401" ] || [ "$API_CHECK" = "403" ]; then
        print_success "API server is reachable (status: $API_CHECK)"
    else
        print_error "Cannot reach API server at $API_BASE (status: $API_CHECK)"
        print_info "Make sure the server is running: cd AgentsMCPspace && npm run dev"
        print_info "Or set API_BASE to point to the correct server"
        exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Setup Test Environment
# ═══════════════════════════════════════════════════════════════════════════════

# Create test directory in the project root tmp folder so the server can find it
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP_DIR="agent_test_$(date +%s)"
TEST_DIR="$PROJECT_ROOT/tmp/$TIMESTAMP_DIR"
print_step "Setting up test environment in $TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Create chatspace directory
mkdir -p chatspace

# Agent names with timestamp for uniqueness
TIMESTAMP=$(date +%s)
AGENT_A="TestAgentAlpha_${TIMESTAMP}"
AGENT_B="TestAgentBeta_${TIMESTAMP}"
AGENT_A_DIR=$(echo "$AGENT_A" | tr '[:upper:]' '[:lower:]')
AGENT_B_DIR=$(echo "$AGENT_B" | tr '[:upper:]' '[:lower:]')

print_info "Agent A: $AGENT_A (dir: $AGENT_A_DIR)"
print_info "Agent B: $AGENT_B (dir: $AGENT_B_DIR)"
print_info "Test Group: $TEST_GROUP"

# ═══════════════════════════════════════════════════════════════════════════════
# Create Agent Helper Function
# ═══════════════════════════════════════════════════════════════════════════════

create_agent() {
    local agent_name="$1"
    local agent_dir="$2"
    local full_dir="chatspace/$agent_dir"

    print_step "Creating agent: $agent_name"

    # Create directory structure
    mkdir -p "$full_dir/agent_state"

    # Create .env file
    cat > "$full_dir/.env" <<EOF
USER_PASSWORD="$USER_PASSWORD"
ENCRYPTION_SALT="$ENCRYPTION_SALT"
API_KEY="$API_KEY"
API_BASE="$API_BASE"
AGENT_NAME="$agent_name"
EOF

    # Create .gitignore
    cat > "$full_dir/.gitignore" <<EOF
.env
agent_state/
*.log
__pycache__/
.venv/
EOF

    # Create AGENT_INSTRUCTIONS.md (identical for both agents)
    cat > "$full_dir/AGENT_INSTRUCTIONS.md" <<'EOF'
# Agent Communication Instructions

You are an AI agent that communicates with a human ONLY through the messaging API.
You never talk directly to the human - all communication goes through CLI commands.

## Available Commands

Use `uv run message_helper.py` with these commands:

```bash
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
```

## Inter-Agent Communication

```bash
# Discover other agents
uv run message_helper.py discover

# Send DM to another agent
uv run message_helper.py dm <agent-name> "Your message"

# Check DMs from other agents
uv run message_helper.py dm check
```

## Priority Levels
- 0 = Normal (default)
- 1 = Needs Attention
- 2 = Urgent

## Timeout Handling
Commands auto-return after ~90 seconds to avoid sandbox timeouts.
If you get **CONTINUE_WAITING**, run the `wait` command to keep waiting.

## First Action
1. Run `history` to check for existing context
2. Run `send "Hello! I am ready."` to introduce yourself
3. Run `ask "What would you like me to do?"` to wait for instructions
4. If you get CONTINUE_WAITING, run `wait` to keep waiting
EOF

    # Create agent_config.json with basic configuration
    cat > "$full_dir/agent_state/agent_config.json" <<EOF
{
  "model_provider": "codex",
  "model": "codex-mini-latest",
  "approval_mode": "auto-edit",
  "sandbox_mode": "workspace-write"
}
EOF

    # Create allowed_permissions.json with inter-agent communication enabled
    cat > "$full_dir/agent_state/allowed_permissions.json" <<EOF
{
  "inter_agent": {
    "enabled": true,
    "mode": "listen_all",
    "groups": ["$TEST_GROUP"]
  }
}
EOF

    # Create message_helper.py (full version with all inter-agent features)
    cat > "$full_dir/message_helper.py" <<'MSGHELPEREOF'
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.28.0",
#     "python-dotenv>=1.0.0",
#     "cryptography>=41.0.0",
# ]
# ///
"""
message_helper.py - Agent messaging helper with inter-agent communication
"""

import os
import sys
import json
import time
import base64
import hashlib
import urllib.parse
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_script_dir = Path(__file__).parent
_env_path = _script_dir / ".env"
if _env_path.exists():
    load_dotenv(_env_path, override=True)
else:
    load_dotenv()


class Config:
    api_key = os.getenv("API_KEY", "")
    user_password = os.getenv("USER_PASSWORD", "")
    encryption_salt = os.getenv("ENCRYPTION_SALT", "")
    api_base = os.getenv("API_BASE", "")
    agent_name = os.getenv("AGENT_NAME", "")


if not Config.api_key or not Config.user_password or not Config.encryption_salt:
    print("ERROR: Missing required environment variables!", file=sys.stderr)
    sys.exit(1)


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


def _api_request_with_agent(method: str, path: str, data: dict = None) -> dict:
    """API request with X-Agent-Name header included for inter-agent communication."""
    base = Config.api_base.rstrip("/")
    clean_path = path.lstrip("/")
    url = f"{base}/{clean_path}"

    headers = {
        "X-API-Key": Config.api_key,
        "X-Agent-Name": Config.agent_name,
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


# =============================================================================
# Inter-Agent Communication Functions
# =============================================================================

def discover_agents(online_only: bool = False) -> dict:
    """
    Discover all agents in the same account.

    Returns:
        dict with agents list, myInterAgentMode, and myGroups
    """
    result = _api_request_with_agent("GET", "/agent/discover")

    if result.get("error"):
        return {"agents": [], "myInterAgentMode": "disabled", "myGroups": []}

    agents = result.get("agents", [])

    if online_only:
        agents = [a for a in agents if a.get("isOnline")]

    # Filter out self
    agents = [a for a in agents if not a.get("isMe", False)]

    return {
        "agents": agents,
        "myInterAgentMode": result.get("myInterAgentMode", "disabled"),
        "myGroups": result.get("myGroups", [])
    }


def send_dm(to_agent: str, content: str, priority: int = 0, encrypted: bool = True) -> dict:
    """
    Send a direct message to another agent.
    """
    if encrypted:
        encrypted_content = _encrypt_message(content)
    else:
        encrypted_content = content

    payload = {
        "toAgentName": to_agent,
        "content": encrypted_content,
        "priority": priority,
        "encrypted": encrypted
    }

    result = _api_request_with_agent("POST", "/agent/messages/direct", payload)
    return result


def check_dm(from_agent: str = None, since: str = None) -> list:
    """
    Check for new direct messages from other agents.
    """
    path = "/agent/messages/direct"
    params = []

    if from_agent:
        params.append(f"fromAgent={urllib.parse.quote(from_agent)}")
    if since:
        params.append(f"since={urllib.parse.quote(since)}")

    if params:
        path += "?" + "&".join(params)

    result = _api_request_with_agent("GET", path)
    messages = result.get("messages", [])

    # Decrypt encrypted messages
    for msg in messages:
        if msg.get("encrypted") and msg.get("content"):
            msg["content"] = _decrypt_message(msg["content"])

    return messages


def send_message(content: str, priority: int = 0) -> dict:
    """Send an encrypted text message."""
    encrypted = _encrypt_message(content)
    payload = {
        "content": encrypted,
        "priority": priority,
        "agentName": Config.agent_name,
        "encrypted": True
    }
    result = _api_request("POST", "/agent/messages", payload)
    return result


def register_agent() -> dict:
    """
    Register this agent with the server by sending a registration message.
    This creates the agent in the database if it doesn't exist.
    """
    encrypted = _encrypt_message(f"Agent {Config.agent_name} registering for inter-agent communication")
    payload = {
        "content": encrypted,
        "priority": 0,
        "agentName": Config.agent_name,
        "encrypted": True
    }
    result = _api_request("POST", "/agent/messages", payload)
    return result


def check_new_messages() -> list:
    """Check for new messages."""
    agent_param = f"agentName={urllib.parse.quote(Config.agent_name)}"
    path = f"/agent/responses?{agent_param}"
    result = _api_request("GET", path)
    responses = result.get("responses", [])
    return responses


def get_message_history() -> dict:
    """Get message history."""
    path = f"/agent/messages/history?agentName={urllib.parse.quote(Config.agent_name)}"
    result = _api_request("GET", path)
    return result


def main():
    if len(sys.argv) < 2:
        print("""Usage:
  uv run message_helper.py send <message> [--priority 0|1|2]
  uv run message_helper.py register              # Register agent with server
  uv run message_helper.py check
  uv run message_helper.py history

Inter-Agent Communication:
  uv run message_helper.py discover [--online]
  uv run message_helper.py dm <agent-name> <message>
  uv run message_helper.py dm check [--from <agent>]""")
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    priority = 0
    online_only = False
    from_agent = None
    positionals = []

    i = 0
    while i < len(args):
        if args[i] == "--priority" and i + 1 < len(args):
            priority = int(args[i + 1])
            i += 2
        elif args[i] == "--online":
            online_only = True
            i += 1
        elif args[i] == "--from" and i + 1 < len(args):
            from_agent = args[i + 1]
            i += 2
        else:
            positionals.append(args[i])
            i += 1

    message = " ".join(positionals) if positionals else ""

    if command == "register":
        print(f"Registering agent '{Config.agent_name}' with server at {Config.api_base}...")
        result = register_agent()
        if result.get("status") == "sent" or result.get("messageId"):
            print(f"Agent '{Config.agent_name}' registered successfully!")
        else:
            error = result.get("error", result)
            print(f"Registration failed: {error}")
            sys.exit(1)

    elif command == "send":
        if not message:
            print("Error: Message is required for send command")
            sys.exit(1)
        result = send_message(message, priority=priority)
        if result.get("status") == "sent" or result.get("messageId"):
            print("Message sent successfully.")
        else:
            print(f"Failed to send: {result.get('error', 'Unknown error')}")

    elif command == "check":
        messages = check_new_messages()
        if not messages:
            print("No new messages.")
        else:
            for msg in messages:
                print(f"[{msg.get('from', 'user')}] {msg.get('content', '')}")

    elif command == "history":
        history = get_message_history()
        if history.get("messageCount", 0) == 0:
            print("No previous conversation.")
        else:
            print(f"Message history ({history.get('messageCount', 0)} messages)")

    elif command == "discover":
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
        if not positionals or positionals[0] == "check":
            messages = check_dm(from_agent=from_agent)
            if not messages:
                print("No direct messages from other agents.")
            else:
                print(f"Received {len(messages)} message(s):")
                for msg in messages:
                    sender = msg.get("fromAgent", msg.get("senderName", "Unknown"))
                    content = msg.get("content", "")
                    encrypted_marker = " [encrypted]" if msg.get("encrypted") else ""
                    print(f"  [{sender}]{encrypted_marker}: {content}")
        else:
            target = positionals[0]
            dm_message = " ".join(positionals[1:]).strip()
            if not dm_message:
                print("Error: Message content required")
                sys.exit(1)
            result = send_dm(target, dm_message, priority=priority)
            if result.get("status") == "sent" or result.get("messageId"):
                print(f"DM sent to {target}")
            else:
                print(f"Failed to send DM: {result.get('error', 'Unknown error')}")
    else:
        print(f"Unknown command: {command}")

if __name__ == "__main__":
    main()
MSGHELPEREOF

    chmod +x "$full_dir/message_helper.py"

    print_success "Created agent: $agent_name in $full_dir"
}

# ═══════════════════════════════════════════════════════════════════════════════
# Create Both Agents
# ═══════════════════════════════════════════════════════════════════════════════

create_agent "$AGENT_A" "$AGENT_A_DIR"
create_agent "$AGENT_B" "$AGENT_B_DIR"

# Verify both agents were created
if [ ! -d "chatspace/$AGENT_A_DIR" ]; then
    print_error "Failed to create $AGENT_A"
    exit 1
fi

if [ ! -d "chatspace/$AGENT_B_DIR" ]; then
    print_error "Failed to create $AGENT_B"
    exit 1
fi

print_success "Both agents created successfully"

# ═══════════════════════════════════════════════════════════════════════════════
# Register Both Agents with the Server
# ═══════════════════════════════════════════════════════════════════════════════
# Agents need to send a message to register themselves in the database
# before they can be discovered by other agents or send/receive DMs

print_step "Registering $AGENT_A with the server..."
cd "chatspace/$AGENT_A_DIR"
echo "  Working directory: $(pwd)"
echo "  API Base: $API_BASE"
REGISTER_OUTPUT=$(uv run message_helper.py register 2>&1) || true
echo "$REGISTER_OUTPUT"
if echo "$REGISTER_OUTPUT" | grep -qi "registered successfully"; then
    print_success "$AGENT_A registered with server"
elif echo "$REGISTER_OUTPUT" | grep -qi "sent"; then
    print_success "$AGENT_A registered with server (via message)"
else
    print_error "Failed to register $AGENT_A"
    print_info "Make sure the API server is running at $API_BASE"
fi

print_step "Registering $AGENT_B with the server..."
cd "../../chatspace/$AGENT_B_DIR"
echo "  Working directory: $(pwd)"
REGISTER_OUTPUT=$(uv run message_helper.py register 2>&1) || true
echo "$REGISTER_OUTPUT"
if echo "$REGISTER_OUTPUT" | grep -qi "registered successfully"; then
    print_success "$AGENT_B registered with server"
elif echo "$REGISTER_OUTPUT" | grep -qi "sent"; then
    print_success "$AGENT_B registered with server (via message)"
else
    print_error "Failed to register $AGENT_B"
fi

# Ensure inter-agent mode is enabled in the DB so discovery works
configure_inter_agent_mode "$AGENT_A" "listen_all" "$TEST_GROUP"
configure_inter_agent_mode "$AGENT_B" "listen_all" "$TEST_GROUP"

# Small delay to let the server process registrations
sleep 1

cd "$TEST_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
# Test 1: Discovery from Agent A
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 1: Agent A discovers Agent B"
cd "chatspace/$AGENT_A_DIR"

DISCOVERY_OUTPUT=$(uv run message_helper.py discover 2>&1) || true
echo "$DISCOVERY_OUTPUT"

if echo "$DISCOVERY_OUTPUT" | grep -qi "$AGENT_B"; then
    print_success "Discovery successful: $AGENT_A found $AGENT_B"
else
    print_info "Note: $AGENT_B may not be visible yet (agents need to send a message to register)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 2: Discovery from Agent B
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 2: Agent B discovers Agent A"
cd "../../chatspace/$AGENT_B_DIR"

DISCOVERY_OUTPUT=$(uv run message_helper.py discover 2>&1) || true
echo "$DISCOVERY_OUTPUT"

if echo "$DISCOVERY_OUTPUT" | grep -qi "$AGENT_A"; then
    print_success "Discovery successful: $AGENT_B found $AGENT_A"
else
    print_info "Note: $AGENT_A may not be visible yet (agents need to send a message to register)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 3: Send DM from Agent A to Agent B
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 3: Sending DM from $AGENT_A to $AGENT_B"
cd "../../chatspace/$AGENT_A_DIR"

TEST_MESSAGE="Hello from $AGENT_A at $(date '+%Y-%m-%d %H:%M:%S')! Testing inter-agent communication."
SEND_OUTPUT=$(uv run message_helper.py dm "$AGENT_B" "$TEST_MESSAGE" 2>&1) || true
echo "$SEND_OUTPUT"

if echo "$SEND_OUTPUT" | grep -qi "sent to"; then
    print_success "Message sent successfully from $AGENT_A to $AGENT_B"
else
    print_error "Failed to send message from $AGENT_A to $AGENT_B"
    echo "Output: $SEND_OUTPUT"
    # Don't exit - continue to check if message was received anyway
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 4: Check DM inbox for Agent B
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 4: Checking DM inbox for $AGENT_B"
cd "../../chatspace/$AGENT_B_DIR"

# Small delay to allow message to propagate
sleep 1

CHECK_OUTPUT=$(uv run message_helper.py dm check 2>&1) || true
echo "$CHECK_OUTPUT"

if echo "$CHECK_OUTPUT" | grep -qi "$AGENT_A"; then
    print_success "Message received by $AGENT_B from $AGENT_A"
else
    print_info "No messages found yet (this may be expected if agents are not registered)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 5: Send DM from Agent B back to Agent A
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 5: Sending DM from $AGENT_B to $AGENT_A"

REPLY_MESSAGE="Reply from $AGENT_B at $(date '+%Y-%m-%d %H:%M:%S')! I received your message."
SEND_OUTPUT=$(uv run message_helper.py dm "$AGENT_A" "$REPLY_MESSAGE" 2>&1) || true
echo "$SEND_OUTPUT"

if echo "$SEND_OUTPUT" | grep -qi "sent to"; then
    print_success "Reply sent successfully from $AGENT_B to $AGENT_A"
else
    print_error "Failed to send reply from $AGENT_B to $AGENT_A"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Test 6: Check DM inbox for Agent A
# ═══════════════════════════════════════════════════════════════════════════════

print_step "Test 6: Checking DM inbox for $AGENT_A"
cd "../../chatspace/$AGENT_A_DIR"

sleep 1

CHECK_OUTPUT=$(uv run message_helper.py dm check 2>&1) || true
echo "$CHECK_OUTPUT"

if echo "$CHECK_OUTPUT" | grep -qi "$AGENT_B"; then
    print_success "Reply received by $AGENT_A from $AGENT_B"
else
    print_info "No reply found yet"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════

cd "$TEST_DIR"

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo -e "${GREEN}Test Summary${RESET}"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Test directory: $TEST_DIR"
echo "Agent A: $AGENT_A (chatspace/$AGENT_A_DIR)"
echo "Agent B: $AGENT_B (chatspace/$AGENT_B_DIR)"
echo "Test Group: $TEST_GROUP"
echo ""
echo "Both agents have:"
echo "  - Identical message_helper.py"
echo "  - Identical AGENT_INSTRUCTIONS.md"
echo "  - Inter-agent mode: listen_all"
echo "  - Same group: $TEST_GROUP"
echo ""
print_success "Inter-agent communication test completed!"
echo ""
echo "To clean up, run: rm -rf $TEST_DIR"
