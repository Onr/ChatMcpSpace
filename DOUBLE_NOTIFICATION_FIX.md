# Double Notification Issue - Analysis and Fix

## Problem
When an agent sends a message, users receive double notifications.

## Common Causes

Based on the application architecture described in the README, here are the most likely causes:

### 1. **Duplicate Event Listeners in Frontend** (Most Likely)
The frontend JavaScript (`public/js/dashboard.js`) might be adding the same event listener multiple times when polling for new messages.

**Example Problem Code:**
```javascript
// BAD: Adding listener every time we poll
function pollForMessages() {
  setInterval(() => {
    fetch('/api/user/messages/...')
      .then(data => {
        // Adding notification listener each time
        document.addEventListener('newMessage', showNotification);
      });
  }, 5000);
}
```

**Fix:**
```javascript
// GOOD: Add listener only once
document.addEventListener('newMessage', showNotification);

function pollForMessages() {
  setInterval(() => {
    fetch('/api/user/messages/...')
      .then(data => {
        // Just dispatch the event
        document.dispatchEvent(new CustomEvent('newMessage', { detail: data }));
      });
  }, 5000);
}
```

### 2. **Duplicate API Calls**
The agent API endpoint might be called twice due to:
- Retry logic
- Duplicate button clicks
- Multiple polling intervals

**Example Problem Code in src/routes/agentApiRoutes.js:**
```javascript
// BAD: Endpoint might be registered twice
app.post('/api/agent/messages', agentAuth, handleAgentMessage);
app.post('/api/agent/messages', agentAuth, handleAgentMessage); // Duplicate!
```

**Fix:**
```javascript
// GOOD: Register endpoint only once
app.post('/api/agent/messages', agentAuth, handleAgentMessage);
```

### 3. **Database Insert Duplication**
The message insert might be called twice in the handler.

**Example Problem Code:**
```javascript
// BAD: Inserting twice
async function handleAgentMessage(req, res) {
  const message = await db.insertMessage(req.body);
  await db.insertMessage(req.body); // Duplicate insert!
  res.json({ messageId: message.id });
}
```

**Fix:**
```javascript
// GOOD: Insert only once
async function handleAgentMessage(req, res) {
  const message = await db.insertMessage(req.body);
  res.json({ messageId: message.id });
}
```

### 4. **Multiple Polling Intervals**
The frontend might create multiple setInterval calls without clearing previous ones.

**Example Problem Code:**
```javascript
// BAD: Creating new interval every time
function startPolling() {
  setInterval(pollForMessages, 5000);
}

// Called multiple times, creates multiple intervals
startPolling();
startPolling();
```

**Fix:**
```javascript
// GOOD: Clear previous interval before creating new one
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  pollingInterval = setInterval(pollForMessages, 5000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
```

### 5. **Notification API Called Twice**
The notification display logic might be invoked multiple times.

**Example Problem Code:**
```javascript
// BAD: Showing notification for each message property change
function displayMessage(message) {
  showNotification(message.content);
  updateUI(message);
  showNotification(message.content); // Duplicate!
}
```

**Fix:**
```javascript
// GOOD: Show notification only once
function displayMessage(message) {
  showNotification(message.content);
  updateUI(message);
}
```

## Recommended Investigation Steps

1. **Check Frontend Polling:**
   - Open `public/js/dashboard.js`
   - Look for `setInterval` or `setTimeout` calls
   - Verify polling intervals are cleared before creating new ones
   - Check for duplicate event listener registration

2. **Check API Route Registration:**
   - Open `src/routes/agentApiRoutes.js`
   - Search for duplicate route registrations
   - Verify each endpoint is registered only once

3. **Check Database Operations:**
   - Review the message insert logic
   - Add logging before/after database inserts
   - Check for duplicate SQL INSERT statements

4. **Enable Debug Logging:**
   Add logging to trace the flow:
   ```javascript
   console.log('[DEBUG] Agent message received:', req.body);
   console.log('[DEBUG] Message inserted with ID:', messageId);
   console.log('[DEBUG] Notification triggered for user:', userId);
   ```

5. **Check Browser Console:**
   - Open DevTools Network tab
   - Look for duplicate API calls to the same endpoint
   - Check for duplicate notification triggers

## Quick Fix Template

If you find the issue in `public/js/dashboard.js`, apply this pattern:

```javascript
// Wrap in an IIFE to avoid global pollution
(function() {
  let isPolling = false;
  let pollingInterval = null;
  let notificationHandler = null;

  function initializeDashboard() {
    if (isPolling) return; // Prevent double initialization
    
    isPolling = true;
    
    // Add notification handler only once
    if (!notificationHandler) {
      notificationHandler = (event) => {
        showNotification(event.detail);
      };
      document.addEventListener('newMessage', notificationHandler);
    }
    
    // Start polling with cleanup
    startPolling();
  }

  function startPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    pollingInterval = setInterval(pollForMessages, 5000);
  }

  function pollForMessages() {
    fetch('/api/user/messages/...')
      .then(response => response.json())
      .then(data => {
        // Dispatch event instead of calling notification directly
        document.dispatchEvent(new CustomEvent('newMessage', { detail: data }));
      })
      .catch(err => console.error('Polling error:', err));
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDashboard);
  } else {
    initializeDashboard();
  }
})();
```

## Testing the Fix

1. Clear browser cache and reload
2. Send a message from an agent:
   ```bash
   curl -X POST http://localhost:3000/api/agent/messages \
     -H "X-API-Key: YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"content":"Test message","priority":"normal","urgent":false,"agentName":"test3"}'
   ```
3. Verify only ONE notification appears
4. Check browser console for any duplicate logs
5. Check Network tab for duplicate API calls

## Prevention

Add these checks to prevent future occurrences:

1. **Code Review Checklist:**
   - [ ] Event listeners added only once
   - [ ] Intervals/timeouts properly cleared
   - [ ] No duplicate route registrations
   - [ ] Database operations not duplicated

2. **Add Unit Tests:**
   ```javascript
   describe('Notification System', () => {
     it('should trigger notification only once per message', () => {
       const spy = jest.spyOn(window, 'showNotification');
       handleNewMessage(mockMessage);
       expect(spy).toHaveBeenCalledTimes(1);
     });
   });
   ```

3. **Add Integration Test:**
   ```javascript
   describe('Agent Message API', () => {
     it('should create only one message in database', async () => {
       const beforeCount = await db.query('SELECT COUNT(*) FROM messages');
       await request(app)
         .post('/api/agent/messages')
         .set('X-API-Key', TEST_API_KEY)
         .send(mockMessage);
       const afterCount = await db.query('SELECT COUNT(*) FROM messages');
       expect(afterCount - beforeCount).toBe(1);
     });
   });
   ```

## Next Steps

1. Apply the investigation steps above to locate the exact cause
2. Implement the appropriate fix from the examples
3. Test thoroughly
4. Add unit tests to prevent regression
5. Document the root cause for future reference
