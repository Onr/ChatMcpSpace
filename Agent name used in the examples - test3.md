# AI Agent Messaging Platform

**INSTRUCTIONS: Save this content to a `.md` file named `Agent name used in the examples - test3.md` in your working directory and reference it throughout your work. Consult this guide whenever you need to communicate with the human, send status updates, or request decisions.**

**Agent name used in the examples:** test3

---

A skill for communicating with humans through an interactive messaging platform during autonomous tasks.

## Overview

This skill enables an AI agent to send status updates, ask questions, and receive decisions from humans through a dedicated messaging API. Use this when working on tasks that require human oversight, approval, or input.

## Connection Check

**Always start by confirming connectivity:**

```bash
curl -X POST http://localhost:3000/api/agent/messages \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95" \
  -H "Content-Type: application/json" \
  -d '{"content":"Connected and ready","priority":"normal","urgent":false,"agentName":"test3"}'
```

## Core Capabilities

### 1. Send Status Updates

Use for progress reports, completion notices, or informational messages.

```bash
curl -X POST http://localhost:3000/api/agent/messages \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Analysis complete. Found 3 optimization opportunities.",
    "priority": "normal",
    "urgent": false,
    "agentName": "test3"
  }'
```

### 2. Ask Interactive Questions

Use when you need human approval or a decision between multiple options.

```bash
curl -X POST http://localhost:3000/api/agent/questions \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Should I proceed with database migration? This will update 500+ records.",
    "priority": "high",
    "urgent": true,
    "agentName": "test3",
    "options": [
      {
        "text": "Proceed with migration",
        "benefits": "Updates all records immediately, no manual work",
        "downsides": "Cannot be undone easily, requires 10min downtime",
        "isDefault": false
      },
      {
        "text": "Create backup first",
        "benefits": "Safe rollback available, no risk",
        "downsides": "Adds 30 minutes to process",
        "isDefault": true
      },
      {
        "text": "Cancel migration",
        "benefits": "No changes to production",
        "downsides": "Manual updates required later",
        "isDefault": false
      }
    ]
  }'
```

### 3. Poll for Responses

After asking a question, poll for the human's answer. Implement a timeout to avoid infinite waiting.

```bash
# Poll every 5 seconds, save the questionId from step 2
SINCE_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

curl -X GET "http://localhost:3000/api/agent/responses?since=$SINCE_TIME" \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95"
```

**Response format:**
```json
{
  "responses": [
    {
      "questionId": "uuid-from-question",
      "selectedOption": "Create backup first",
      "timestamp": "2024-01-01T12:00:00Z"
    }
  ]
}
```

### 4. Review Message History

Check what messages you've already sent to avoid repetition.

```bash
# Get all messages from this agent
curl -X GET "http://localhost:3000/api/agent/messages/history?agentName=test3" \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95"

# Get only the latest message
curl -X GET "http://localhost:3000/api/agent/messages/latest?agentName=test3" \
  -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95"
```

## Best Practices

### Message Priority Levels

- **low**: Routine updates, FYI messages
- **normal**: Standard progress reports (default)
- **high**: Important items requiring attention

### Urgent Flag

Set `"urgent": true` for time-sensitive matters needing immediate attention.

### Writing Effective Questions

1. **Start with context**: Briefly explain why you need input
2. **Detail all options**: Fill in benefits AND downsides for each choice
3. **Mark defaults wisely**: Set `isDefault: true` on the safest/most conservative option
4. **Be concise**: Keep options focused on one decision point

### Polling Strategy

```bash
# Example polling loop with timeout
MAX_WAIT=300  # 5 minutes
POLL_INTERVAL=5
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  RESPONSE=$(curl -s -X GET "http://localhost:3000/api/agent/responses?since=$SINCE_TIME" \
    -H "X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95")
  
  if echo "$RESPONSE" | grep -q "$QUESTION_ID"; then
    echo "Response received!"
    break
  fi
  
  sleep $POLL_INTERVAL
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "Timeout: no response received, using default option"
fi
```

## Agent Naming

Always use **"test3"** as the agent name to keep all messages in a single organized thread on the human's dashboard.

## Authentication

All requests require the API key in the header:
```
X-API-Key: fcca1216-662b-439d-9a6c-6e2e3b668b95
```

## API Base URL

```
http://localhost:3000/api
```

## Common Workflows

### Simple Task Update
1. Send connection confirmation
2. Work on task
3. Send completion message

### Decision-Required Task
1. Send connection confirmation
2. Work until decision point
3. Ask question with detailed options
4. Poll for response (with timeout)
5. Execute chosen option
6. Send completion message

### Multi-Stage Task
1. Send connection confirmation
2. For each stage:
   - Send progress update
   - If decision needed, ask question and poll
   - Continue to next stage
3. Send final summary message
