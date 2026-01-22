# Archive Feature - User Guide

## How to Archive an Agent

### Step 1: Open Dashboard
Navigate to the dashboard where you see all your agents in the circular council view.

### Step 2: Select an Agent
Click on any agent to select it. You'll see the agent panel open on the right side with agent details.

### Step 3: Click the Menu Icon
In the agent panel header (top right), click the **3-dot menu icon** (⋮) to open the context menu.

### Step 4: Click "Archive Agent"
In the context menu, you'll see several options:
- Copy Instruction
- Clear Conversation
- **Archive Agent** ← Click here
- Delete Agent

### Step 5: Confirm Archive
A confirmation modal will appear with:
- Agent name
- Optional reason text field (e.g., "Project completed", "No longer needed")
- Cancel and Archive buttons

You can optionally type a reason, then click the **Archive** button.

### Step 6: Agent Archived
- The agent will immediately disappear from your dashboard
- A toast notification appears: "Agent archived successfully" with an **Undo** button
- You have **10 seconds** to undo if you change your mind
- After 10 seconds, the undo button expires

## Viewing Archived Agents

### Access the Archive Page
To see all your archived agents:

**Option 1: Direct URL**
- Navigate to: `http://yourdomain.com/archive`

**Option 2: Add Navigation Link (Recommended)**
You should add a link to the archive page in your navigation menu. The archive page is available at `/archive` route.

### Archive Page Features
On the archive page, you can:
- **See all archived agents** in a grid/card layout
- **Search** for archived agents by name
- **View metadata:**
  - Agent name and type (Standard/News Feed)
  - Archive date and time
  - Total message count
  - Archive reason (if provided)
- **Restore** any archived agent with the green "Restore" button
- **Permanently Delete** with the red "Delete" button (requires confirmation)
- **Navigate** using pagination (Previous/Next/page numbers)

## Restoring an Archived Agent

### Method 1: From Archive Page
1. Go to `/archive`
2. Find the agent you want to restore
3. Click the green **"Restore"** button on the card
4. Agent reappears at the end of your dashboard
5. Toast notification confirms: "Agent restored successfully"

### Method 2: From Dashboard Undo (Within 10 Seconds)
1. After archiving an agent, a toast notification appears
2. Click the **"Undo"** button in the toast
3. Agent is restored immediately
4. Only works for 10 seconds after archiving

## Archiving Individual Messages

Currently, the UI shows archive buttons for agents (full conversations). Individual message archiving is available through the API but not yet in the dashboard UI.

**Future Enhancement:** Message-level archive UI to be added.

## How Archive Works (Technical Details)

### What Gets Archived
When you archive an agent:
- ✅ Agent is moved to `archived_agents` table
- ✅ Message count is preserved
- ✅ Archive reason is saved
- ✅ Archive timestamp is recorded

### What Happens to Messages
- ✅ All messages are preserved in the archive snapshot
- ⚠️ Original messages are deleted from active conversation
- ✅ Can be restored by restoring the agent
- ✅ Encrypted content is preserved

### Agent After Archiving
- ✅ Disappears from dashboard immediately
- ✅ Not polled for new messages
- ❌ Cannot receive new messages
- ✅ Can be viewed in archive page
- ✅ Can be restored anytime
- ✅ Can be permanently deleted

## Common Tasks

### I archived an agent by mistake!
**Solution:** Click the **Undo** button in the toast notification (within 10 seconds)
- If more than 10 seconds have passed, go to `/archive` and click Restore

### I want to completely delete an archived agent
1. Go to `/archive`
2. Find the agent
3. Click the red **Delete** button
4. Confirm the permanent deletion
5. ⚠️ This cannot be undone!

### I want to see archived agent information
1. Go to `/archive`
2. Cards show:
   - Agent name and type
   - Archive date
   - Message count
   - Archive reason (if provided)

### I want to search archived agents
1. Go to `/archive`
2. Use the search box at the top
3. Type agent name or reason
4. Results filter in real-time

## Keyboard Shortcuts

Currently no keyboard shortcuts, but the following work:
- **Escape** - Close confirmation modal while archiving
- **Tab** - Navigate through buttons and inputs

## Mobile Usage

The archive feature works on mobile:
- ✅ Archive buttons visible in context menu
- ✅ Confirmation modal is mobile-responsive
- ✅ Archive page is fully mobile-optimized
- ✅ Touch-friendly buttons (large tap targets)
- ✅ Works in portrait and landscape

## Best Practices

### When to Archive
✅ Good times to archive agents:
- Project is completed
- Agent is no longer needed
- Cleaning up your dashboard
- Agent conversation is no longer relevant

### Tips
- 💡 Add a reason when archiving (helps remember why)
- 💡 Use archive to organize without deleting
- 💡 Check archive page before permanently deleting
- 💡 Archive works across all devices

### Archive vs Delete
| Action | Archive | Delete |
|--------|---------|--------|
| Reversible | ✅ Yes (10 sec undo, or restore from archive) | ❌ No |
| Data preserved | ✅ Yes (all messages saved) | ❌ No |
| Visible in dashboard | ❌ No | ❌ No |
| Can restore later | ✅ Yes (any time) | ❌ No |
| Use when | Might need later | Definitely don't need |

## Troubleshooting

### Archive button not showing
**Possible causes:**
1. Agent not selected - Click an agent first
2. Context menu not open - Click the 3-dot menu icon
3. JavaScript not loaded - Refresh the page
4. Feature not enabled - Check with administrator

**Solution:** Refresh the page and try again

### Archive page not loading
**Possible causes:**
1. Not logged in - Log in first
2. Feature not deployed - Check with administrator
3. Database issue - Try again in a moment

**Solution:** Go to dashboard first, then try archive page

### Cannot restore archived agent
**Possible causes:**
1. Undo window expired (>10 seconds) - Use archive page instead
2. Archive page not working - Refresh and try again
3. Permission issue - Try logging out and back in

**Solution:** Go to `/archive` and use the Restore button

### Archive reason not showing
**Possible causes:**
1. No reason was provided when archiving
2. Reason field was left empty
3. Display issue - Refresh page

**Solution:** Archive reason is optional. Only shows if you provided one.

## Questions?

If you need help with the archive feature:
1. Check this guide
2. Go to `/archive` and explore
3. Try hovering over elements for tooltips
4. Contact your administrator if issues persist

## Feature Status

✅ **Production Ready**
- Archive agents: Working
- View archived agents: Working
- Restore agents: Working
- Delete archived agents: Working
- Archive page: Working
- Search archived agents: Working
- Mobile support: Working

⏳ **Planned Features**
- Archive individual messages (UI)
- Export archived agents
- Archive retention policies
- Archive history and logs

---

**Last Updated:** January 2026
**Status:** Fully Functional
