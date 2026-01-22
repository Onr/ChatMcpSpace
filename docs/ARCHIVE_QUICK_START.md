# Archive Feature - Quick Start Visual Guide

## 1. Archive an Agent (3 Steps)

### Step 1: Select Agent
```
Dashboard View:
┌─────────────────────────────────────────────┐
│  Your Agents (Circular Council)             │
│                                             │
│        ◯ Agent 1                            │
│       ◯ Agent 2 ← CLICK HERE                │
│      ◯ Agent 3                              │
│     ◯ Agent 4                               │
│                                             │
│  (Agent panel opens on right side)          │
└─────────────────────────────────────────────┘
```

### Step 2: Open Menu
```
Agent Panel (Right Side):
┌─────────────────────────┐
│ Agent Name       ⋮ ← CLICK│ (3-dot menu)
├─────────────────────────┤
│ Last seen: 2 hours ago  │
│ Messages: 42            │
│ Status: Active          │
└─────────────────────────┘
```

### Step 3: Click Archive
```
Context Menu Opens:
┌──────────────────────────┐
│ Copy Instruction         │
│ Clear Conversation       │
│ Archive Agent ← CLICK    │ (Amber/Warning color)
│ Delete Agent             │
└──────────────────────────┘

Confirmation Modal:
┌────────────────────────────────────┐
│ 📦 Archive this agent?             │
├────────────────────────────────────┤
│ Archive [Agent Name]?              │
│                                    │
│ Reason (optional):                 │
│ ┌──────────────────────────────┐   │
│ │ Project completed            │   │
│ └──────────────────────────────┘   │
│                                    │
│ [Cancel]  [Archive]                │
└────────────────────────────────────┘
```

## 2. Undo Archive (Within 10 Seconds)

```
Toast Notification (Top Right):
┌──────────────────────────────────────┐
│ ✓ Agent archived (42 messages)       │
│                      [UNDO]          │
│                                      │
│ (Auto-disappears after 10 seconds)   │
└──────────────────────────────────────┘

Expires:
┌──────────────────────────────────────┐
│ ✓ Agent archived (42 messages)       │
│                                      │
│ (Undo expired - cannot click)        │
└──────────────────────────────────────┘
```

## 3. View Archived Agents

### Navigate to Archive Page
```
URL: http://yourdomain.com/archive

OR

Add this to your navigation menu:
┌─────────────────────────┐
│ 🏠 Dashboard            │
│ 📋 Settings             │
│ 📦 Archives      ← LINK │ (Recommended)
│ 🔑 API Keys             │
│ 👤 Profile              │
└─────────────────────────┘
```

### Archive Page Layout
```
┌─────────────────────────────────────────────────────────┐
│ ARCHIVES                                                │
│ ← Back to Dashboard                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Search: [________________________]                       │
│ (Search by agent name or reason)                        │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Archived Agents (3 total)                               │
│                                                         │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│ │ 👤 Agent 1   │  │ 👤 Agent 2   │  │ 👤 Agent 3   │   │
│ │              │  │              │  │              │   │
│ │ News Feed    │  │ Standard     │  │ Standard     │   │
│ │              │  │              │  │              │   │
│ │ Jan 21, 2pm  │  │ Jan 20, 4am  │  │ Jan 19, 11pm │   │
│ │ 42 messages  │  │ 127 messages │  │ 89 messages  │   │
│ │              │  │              │  │              │   │
│ │ "Completed"  │  │ "No longer   │  │ (no reason)  │   │
│ │              │  │  needed"     │  │              │   │
│ │ [Restore]    │  │ [Restore]    │  │ [Restore]    │   │
│ │ [Delete]     │  │ [Delete]     │  │ [Delete]     │   │
│ └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ [Previous] 1 2 3 [Next]  (Pagination)                   │
└─────────────────────────────────────────────────────────┘
```

## 4. Restore from Archive

### Option A: From Archive Page
```
┌──────────────────────────┐
│ 👤 Agent Name            │
│ Standard                 │
│ Jan 21, 2pm              │
│ 42 messages              │
│ "Project completed"      │
│                          │
│ [Restore] ← CLICK (Green)│
│ [Delete]                 │
└──────────────────────────┘

Result:
✓ Agent restored successfully
Agent reappears at end of dashboard
```

### Option B: Undo (Within 10 Seconds)
```
Toast appears:
┌──────────────────────────────────────┐
│ ✓ Agent archived (42 messages)       │
│                      [UNDO] ← CLICK  │
└──────────────────────────────────────┘

Result:
✓ Agent restored to dashboard
✓ Appears in same position
```

## 5. Permanently Delete

```
Archive Page Card:
┌──────────────────────────┐
│ 👤 Agent Name            │
│ ...metadata...           │
│                          │
│ [Restore]                │
│ [Delete] ← CLICK (Red)   │
└──────────────────────────┘

Confirmation Dialog:
┌────────────────────────────────────┐
│ ⚠️  Permanent Delete?              │
├────────────────────────────────────┤
│ This cannot be undone!             │
│                                    │
│ Permanently delete [Agent Name]?   │
│ All archived data will be lost.    │
│                                    │
│ [Cancel]  [Delete Permanently]     │
└────────────────────────────────────┘

Result:
✓ Agent permanently deleted
✗ Cannot be recovered
```

## Status Indicators

### Agent Archive Status

**Active Agent (Dashboard):**
```
✓ Visible in dashboard
✓ Can receive messages
✓ Can be archived
✗ Not in archive page
```

**Archived Agent (Archive Page):**
```
✗ Not visible in dashboard
✗ Cannot receive messages
✓ Visible in archive page
✓ Can be restored
✓ Can be permanently deleted
```

## Timeline Example

```
Timeline of Agent Lifecycle:
────────────────────────────────────────────────

T=0:00   Agent created
         → Appears in dashboard

T=10:00  Archive button clicked
         → Confirmation modal

T=10:02  "Archive" clicked in modal
         → Agent disappears from dashboard
         → Toast notification: "Undo" available
         → Agent moved to archive_agents table

T=10:05  Still within 10 seconds
         → "Undo" button still active
         → Can click to restore

T=10:12  10 seconds expired
         → "Undo" button no longer clickable
         → Agent available in /archive page

T=12:00  User navigates to /archive
         → Sees archived agent card
         → Can click "Restore" or "Delete"

T=12:05  "Restore" clicked
         → Agent appears at end of dashboard
         → Toast: "Agent restored successfully"
         → Available in dashboard again

T=12:10  User archives same agent again
         → Repeat process...
```

## API Endpoints (For Developers)

```
Archive an agent:
POST /api/user/agents/:agentId/archive
Body: { reason?: "optional reason" }

Restore an agent:
DELETE /api/user/agents/:agentId/archive

Get archived agents:
GET /api/user/archive/agents?limit=20&offset=0

View specific archived agent:
GET /api/user/archive/agents/:archivedAgentId

Permanently delete:
DELETE /api/user/archive/:archivedAgentId
```

## Colors & Icons

```
Archive Actions:
🟨 Amber/Warning Color - Archive operations
📦 Archive Icon        - Archive button
⏳ Toast              - Confirmation notification

States:
✓ Green   - Restore, Success
✗ Red     - Delete, Danger
🟨 Amber  - Archive, Warning
🟦 Blue   - Info, Neutral
```

## Mobile View

```
Mobile Dashboard:
┌──────────────────┐
│ Agent Selection  │
│ (Simplified list)│
│                  │
│ [Agent 1 ⋮]      │
│ [Agent 2 ⋮]      │
│ [Agent 3 ⋮] ← Tap menu
│                  │
│ Context Menu:    │
│ ┌──────────────┐ │
│ │ Copy Inst.   │ │
│ │ Clear Conv.  │ │
│ │ Archive ← Tap│ │
│ │ Delete       │ │
│ └──────────────┘ │
└──────────────────┘

Mobile Archive Page:
┌──────────────────┐
│ ARCHIVES         │
│ ← Dashboard      │
├──────────────────┤
│ Search: [___]    │
├──────────────────┤
│ [Agent 1 Card]   │
│ [Restore][Delete]│
│                  │
│ [Agent 2 Card]   │
│ [Restore][Delete]│
│                  │
│ [Agent 3 Card]   │
│ [Restore][Delete]│
│                  │
│ < 1 2 3 >        │
└──────────────────┘
```

## Troubleshooting Flowchart

```
PROBLEM: Archive button not visible
├─ Select an agent? YES ──→ Continue
└─ Select an agent? NO  ──→ Click agent first ✓

PROBLEM: Cannot find archive page
├─ URL: /archive? YES ──→ Works (add to menu)
└─ URL: /archive? NO  ──→ Try: domain.com/archive ✓

PROBLEM: Agent still in dashboard after archiving
├─ Page refreshed? YES ──→ Refresh again ✓
└─ Page refreshed? NO  ──→ F5 or Cmd+R ✓

PROBLEM: Cannot restore archived agent
├─ Within 10 seconds? YES ──→ Click Undo ✓
└─ Within 10 seconds? NO  ──→ Go to /archive, click Restore ✓

PROBLEM: Archive page not loading
├─ Logged in? YES ──→ Check with admin
└─ Logged in? NO  ──→ Log in first ✓
```

## Summary

| Action | Location | Time to Complete | Reversible |
|--------|----------|------------------|-----------|
| Archive Agent | Dashboard 3-dot menu | 5 seconds | ✅ Yes (10 sec) |
| View Archived | `/archive` page | Instant | N/A |
| Restore (Undo) | Toast notification | 2 seconds | ✅ Within 10 sec |
| Restore (Page) | Archive page card | 5 seconds | ✅ Any time |
| Delete | Archive page card | 10 seconds | ❌ No |

---

**Archive feature is ready to use!**

Next Steps:
1. Go to dashboard
2. Select any agent
3. Click 3-dot menu
4. Click "Archive Agent"
5. Try it out!
