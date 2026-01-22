# Archive Feature Implementation Plan

## Overview
This plan outlines the implementation of a comprehensive archive system that allows users to archive:
1. Individual messages (both agent messages and user messages)
2. Entire agent conversation histories

The archived content will remain accessible through a clean, dedicated archive view while being hidden from the main active conversation flows.

---

## 1. Database Schema Changes

### 1.1 New Tables

#### `archived_agents` Table
Stores metadata about archived agents (entire conversation history).

```sql
CREATE TABLE archived_agents (
  archived_agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  agent_name VARCHAR(255) NOT NULL, -- Snapshot of agent name at archive time
  agent_type VARCHAR(20) NOT NULL,  -- Snapshot of agent type
  total_messages INTEGER NOT NULL DEFAULT 0, -- Count of messages at archive time
  archive_reason TEXT,               -- Optional: why was this archived?
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id) -- An agent can only be archived once
);

CREATE INDEX idx_archived_agents_user_id ON archived_agents(user_id);
CREATE INDEX idx_archived_agents_archived_at ON archived_agents(archived_at DESC);
```

#### `archived_messages` Table
Stores references to individual archived messages.

```sql
CREATE TABLE archived_messages (
  archived_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,       -- Agent message
  user_message_id UUID REFERENCES user_messages(user_message_id) ON DELETE CASCADE, -- User message
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('agent_message', 'user_message')),
  content_snapshot TEXT,             -- Optional: snapshot of content at archive time (for display)
  has_attachments BOOLEAN DEFAULT FALSE,
  archive_note TEXT,                 -- Optional: user note about why this was archived
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (message_type = 'agent_message' AND message_id IS NOT NULL AND user_message_id IS NULL) OR
    (message_type = 'user_message' AND user_message_id IS NOT NULL AND message_id IS NULL)
  )
);

CREATE INDEX idx_archived_messages_user_id ON archived_messages(user_id);
CREATE INDEX idx_archived_messages_agent_id ON archived_messages(agent_id);
CREATE INDEX idx_archived_messages_archived_at ON archived_messages(archived_at DESC);
CREATE INDEX idx_archived_messages_message_id ON archived_messages(message_id);
CREATE INDEX idx_archived_messages_user_message_id ON archived_messages(user_message_id);
```

### 1.2 Migration File
Create: `src/db/migrations/014_add_archive_support.sql`

---

## 2. Backend Implementation

### 2.1 Archive Service (`src/services/archiveService.js`)

New service module to handle archive operations:

```javascript
// Core functions:
// - archiveAgent(userId, agentId, reason)
// - unarchiveAgent(userId, archivedAgentId)
// - archiveMessage(userId, messageId, messageType, note)
// - unarchiveMessage(userId, archivedMessageId)
// - getArchivedAgents(userId, { limit, offset })
// - getArchivedAgentDetails(userId, archivedAgentId)
// - getArchivedMessages(userId, agentId, { limit, offset })
// - isAgentArchived(agentId)
// - isMessageArchived(messageId, messageType)
```

**Key behaviors:**
- When archiving an agent: create `archived_agents` entry, but DO NOT delete the agent or messages (preserve all data)
- When archiving a message: create `archived_messages` entry with content snapshot
- Support pagination for archive views
- Handle encryption: archived content snapshots should remain encrypted if original was encrypted
- Prevent archiving already-archived items (return appropriate error)

### 2.2 API Routes

#### User API Routes (`src/routes/userApiRoutes.js`)

Add the following endpoints:

**Archive Operations:**
```
POST   /api/user/agents/:agentId/archive
       Body: { reason?: string }
       Response: { success: true, archivedAgentId: uuid }

DELETE /api/user/agents/:agentId/archive (unarchive)
       Response: { success: true }

POST   /api/user/messages/:messageId/archive
       Body: { messageType: 'agent_message' | 'user_message', note?: string }
       Response: { success: true, archivedMessageId: uuid }

DELETE /api/user/messages/archive/:archivedMessageId (unarchive)
       Response: { success: true }
```

**Archive Viewing:**
```
GET    /api/user/archive/agents
       Query: ?limit=50&offset=0
       Response: {
         archivedAgents: [{
           archivedAgentId, agentId, agentName, agentType,
           totalMessages, archiveReason, archivedAt
         }],
         total: number
       }

GET    /api/user/archive/agents/:archivedAgentId
       Response: {
         agent: { archivedAgentId, agentId, agentName, ... },
         messages: [{
           messageId, userMessageId, messageType, content,
           createdAt, hasAttachments, ...
         }],
         total: number
       }

GET    /api/user/archive/messages
       Query: ?agentId=uuid&limit=50&offset=0
       Response: {
         archivedMessages: [{
           archivedMessageId, messageType, contentSnapshot,
           hasAttachments, archiveNote, archivedAt, ...
         }],
         total: number
       }
```

#### Agent API Impact
- Modify `GET /api/agent/messages` to exclude archived agents (if agent is archived, return 403 or empty)
- Modify `POST /api/agent/messages` to prevent sending to archived agents

### 2.3 Update Existing Queries

Modify these services/routes to filter out archived content from active views:

**Dashboard queries:**
- `GET /api/user/agents` - exclude agents that exist in `archived_agents`
- `GET /api/user/messages` - exclude messages in `archived_messages`
- `GET /api/user/messages/:agentId/since` - exclude archived messages

**Implementation approach:**
```sql
-- Example: Filter out archived agents
SELECT a.* FROM agents a
LEFT JOIN archived_agents aa ON a.agent_id = aa.agent_id
WHERE a.user_id = $1 AND aa.archived_agent_id IS NULL
ORDER BY a.position;

-- Example: Filter out archived messages
SELECT m.* FROM messages m
LEFT JOIN archived_messages am ON m.message_id = am.message_id
WHERE m.agent_id = $1 AND am.archived_message_id IS NULL
ORDER BY m.created_at DESC;
```

---

## 3. Frontend Implementation

### 3.1 Dashboard UI Updates (`views/dashboard.ejs` + `public/css/style.css`)

#### Archive Button/Menu
Add archive functionality to the agent UI:

**Mobile view:**
- Add "Archive" option to agent long-press menu or settings
- Add individual message archive button (trash/archive icon on message hover/swipe)

**Desktop view:**
- Add archive button to agent header (3-dot menu or dedicated icon)
- Add archive icon to individual messages (appears on hover)

#### Archive View Navigation
Add a new navigation option to access archives:

```html
<!-- Add to sidebar/navigation -->
<a href="/archive" class="archive-nav-link">
  <i class="fas fa-archive"></i> Archives
</a>
```

### 3.2 Archive Dashboard Page (`views/archive.ejs`)

Create a dedicated archive page with:

**Layout:**
```
┌─────────────────────────────────────────┐
│  Archives                        [Back] │
├─────────────────────────────────────────┤
│  Tabs: [Archived Agents] [Archived Msgs]│
├─────────────────────────────────────────┤
│                                          │
│  [List of archived items]                │
│                                          │
│  Each item shows:                        │
│  - Agent name / Message preview          │
│  - Archive date                          │
│  - Reason/note (if provided)             │
│  - [View] [Unarchive] buttons            │
│                                          │
└─────────────────────────────────────────┘
```

**Features:**
- Search/filter archived items
- Sort by archive date, agent name, etc.
- Pagination for large archives
- Bulk operations (future: select multiple to unarchive)

### 3.3 Archived Conversation View

When viewing an archived agent's conversation:

```
┌─────────────────────────────────────────┐
│  🗄️ [Agent Name] (Archived)      [Back] │
│  Archived on: Jan 20, 2026              │
│  Reason: Project completed              │
│                                          │
│  [Unarchive Agent] [Delete Permanently] │
├─────────────────────────────────────────┤
│                                          │
│  [Full conversation history]             │
│  (Read-only view)                        │
│                                          │
│  - All messages displayed                │
│  - Attachments viewable                  │
│  - No reply capability                   │
│                                          │
└─────────────────────────────────────────┘
```

**Styling:**
- Use muted colors to indicate archived/inactive state
- Add watermark or banner: "This conversation is archived"
- Disable message input/reply features

### 3.4 Dashboard JavaScript Updates (`public/js/dashboard.js`)

Add functions:
```javascript
// Archive operations
async function archiveAgent(agentId, reason)
async function unarchiveAgent(archivedAgentId)
async function archiveMessage(messageId, messageType, note)
async function unarchiveMessage(archivedMessageId)

// Archive UI
function showArchiveConfirmation(agentId, agentName)
function showMessageArchiveDialog(messageId, messageType)
function openArchiveView()
function loadArchivedAgents()
function loadArchivedMessages(agentId)
```

Add UI handlers:
- Right-click context menu on messages with "Archive" option
- Confirmation dialogs before archiving (prevent accidental archives)
- Toast notifications for successful archive/unarchive operations
- Update agent polling to skip archived agents

---

## 4. Agent Instructions Update

### 4.1 Update Agent Documentation

**File:** `chatspace/agentsmcpspace_dev_local/AGENT_INSTRUCTIONS.md`

Add section explaining archive behavior:

```markdown
## Archived Agents and Messages

If you try to send a message to an archived agent or if your agent is archived:
- You will receive a 403 Forbidden error
- The user has intentionally archived this conversation
- DO NOT retry sending messages to archived agents
- Inform the user that the agent/conversation is archived if they ask

To check if your agent is archived, you can poll normally - the API will return an appropriate error if archived.
```

### 4.2 Message Helper Updates

**File:** `chatspace/agentsmcpspace_dev_local/message_helper.py`

Update error handling to recognize archive-related errors:
```python
# Handle 403 responses that indicate archived status
if response.status_code == 403:
    error_data = response.json()
    if error_data.get('code') == 'AGENT_ARCHIVED':
        print("ERROR: This agent has been archived by the user.")
        print("You cannot send messages to archived agents.")
        sys.exit(1)
```

---

## 5. Security & Privacy Considerations

### 5.1 Authorization
- Users can only archive/unarchive their own agents and messages
- Validate `user_id` matches on all archive operations
- Prevent cross-user archive access

### 5.2 Encryption
- Archived message content snapshots must respect encryption settings
- If original message was encrypted, snapshot should remain encrypted
- Archive metadata (reason, notes) can be plaintext (not sensitive)
- Decrypt archived content client-side when viewing (same as active messages)

### 5.3 Data Retention
- Archiving does NOT delete data (soft archive)
- Future enhancement: Add "Delete Permanently" option with confirmation
- Consider adding auto-archive policy (e.g., agents inactive > 90 days)

---

## 6. Testing Strategy

### 6.1 Unit Tests

Create: `tests/services/archiveService.test.js`

Test cases:
- Archive agent successfully
- Prevent archiving already-archived agent
- Archive individual message (agent and user messages)
- Unarchive agent and messages
- Verify archived content is filtered from active queries
- Handle encrypted message snapshots correctly
- Pagination of archived lists

### 6.2 Integration Tests

Create: `tests/api/archiveRoutes.test.js`

Test cases:
- POST /api/user/agents/:agentId/archive
- GET /api/user/archive/agents
- GET /api/user/archive/agents/:archivedAgentId
- POST /api/user/messages/:messageId/archive
- DELETE /api/user/messages/archive/:archivedMessageId
- Verify 403 on sending to archived agent
- Test authorization (user can't archive other user's agents)

### 6.3 Frontend Tests

Manual testing checklist:
- Archive agent from dashboard
- View archived agent conversation
- Unarchive agent and verify it reappears
- Archive individual message
- View archived messages list
- Filter/search archives
- Mobile responsive behavior
- Encryption works in archive view

---

## 7. Implementation Phases

### Phase 1: Backend Foundation (Highest Priority)
**Estimated complexity: Medium**

1. Create migration `014_add_archive_support.sql`
2. Create `src/services/archiveService.js`
3. Add archive API routes to `src/routes/userApiRoutes.js`
4. Update existing queries to filter archived content
5. Write unit tests for archive service
6. Write integration tests for archive API

**Verification:** All tests pass, API endpoints work via Postman/curl

### Phase 2: Basic UI Integration
**Estimated complexity: Medium**

1. Add archive buttons to dashboard UI
2. Add confirmation dialogs
3. Implement archive/unarchive API calls in `dashboard.js`
4. Update dashboard polling to exclude archived agents
5. Add toast notifications

**Verification:** Can archive/unarchive from dashboard, active view updates correctly

### Phase 3: Archive View Page
**Estimated complexity: Medium-High**

1. Create `views/archive.ejs` page
2. Add route `/archive` in `src/routes/pageRoutes.js`
3. Create `public/js/archive.js` for archive page logic
4. Add archive-specific CSS in `public/css/style.css`
5. Implement archived conversation viewer
6. Add navigation link to archives

**Verification:** Can view full archive, navigate conversations, unarchive from archive page

### Phase 4: Polish & Edge Cases
**Estimated complexity: Low-Medium**

1. Add search/filter to archive view
2. Implement pagination
3. Add archive reason/note capture UI
4. Mobile responsive refinements
5. Error handling improvements
6. Agent instruction documentation updates

**Verification:** Full user flow works smoothly, edge cases handled gracefully

---

## 8. Future Enhancements (Out of Scope for Initial Implementation)

1. **Bulk Operations**
   - Select multiple messages to archive at once
   - Archive agents in bulk

2. **Auto-Archive Policies**
   - Auto-archive agents inactive for X days
   - User-configurable archive rules

3. **Archive Export**
   - Export archived conversations to JSON/PDF
   - Backup archived data

4. **Archive Tags/Categories**
   - Tag archives (e.g., "completed projects", "old experiments")
   - Filter by tags

5. **Permanent Deletion**
   - "Delete Permanently" option with strong confirmation
   - Scheduled deletion after archive period

6. **Archive Analytics**
   - View archive statistics (total archived, archive rate, etc.)
   - Archive timeline visualization

---

## 9. Database Impact Analysis

### Storage Considerations
- Each archived agent adds 1 row to `archived_agents`
- Each archived message adds 1 row to `archived_messages`
- Original `agents`, `messages`, `user_messages` tables remain unchanged (no deletion)
- Content snapshots in `archived_messages` duplicate some data (trade-off for performance)

### Query Performance
- Archive filtering adds LEFT JOIN to main queries
- Indexes on `archived_agents(agent_id)` and `archived_messages(message_id/user_message_id)` ensure fast lookups
- Archive view queries are separate, won't impact active dashboard performance

### Migration Safety
- Migration is non-destructive (only adds tables)
- Can be rolled back by dropping the two new tables
- No data migration required initially

---

## 10. Success Criteria

The archive feature is successfully implemented when:

✅ Users can archive entire agent conversations with optional reason
✅ Users can archive individual messages with optional notes
✅ Archived agents disappear from active dashboard
✅ Archived messages are hidden from conversation view
✅ Dedicated archive page shows all archived content
✅ Users can view full archived conversations (read-only)
✅ Users can unarchive agents and messages
✅ Agents cannot send messages to archived agents (403 error)
✅ All archive operations respect user authorization
✅ Encrypted messages remain encrypted in archives
✅ Mobile UI works smoothly
✅ All tests pass (unit + integration)
✅ Documentation updated for agents

---

## 11. Design Decisions (APPROVED)

1. **When archiving an agent, should we also archive all its messages automatically?**
   - ✅ **DECISION: YES** - Archiving an agent implies archiving the entire conversation
   - Individual message archives are for cherry-picking specific messages

2. **Should unarchiving an agent restore it to its original position or append to end?**
   - ✅ **DECISION: Append to end** - Unarchived agents go to the end (highest position + 1)

3. **Should we prevent new messages to archived agents at the API level?**
   - ✅ **DECISION: YES** - Agents can READ archived messages but CANNOT SEND new ones (403 AGENT_ARCHIVED error)

4. **Do we need soft-delete vs hard-delete for archives?**
   - ✅ **DECISION: Soft archive** - Archives preserve all data, hard-delete is a Phase 4 enhancement

5. **Should archived content count toward storage limits (if we add quotas)?**
   - ✅ **DECISION: YES** - Archives count toward user storage quota

---

## Summary

This plan provides a comprehensive roadmap for implementing a robust archive system that:
- Preserves all data (non-destructive)
- Provides clean separation between active and archived content
- Maintains security and encryption standards
- Offers intuitive UI for managing archives
- Can be implemented in manageable phases
- Allows for future enhancements

**Recommended starting point:** Phase 1 (Backend Foundation) - build the database schema and API endpoints first, then layer UI on top.
