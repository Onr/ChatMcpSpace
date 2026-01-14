# Double Notification Fix - Summary

## Issue
When an agent sent a message, users received double notifications.

## Root Causes Found

The issue was located in `public/js/dashboard.js` and was caused by THREE separate bugs:

### Bug #1: Duplicate Event Dispatch (Primary Cause)
**Location:** Lines 61-67 (original)

The `pollForMessages()` function was dispatching the 'newAgentMessage' event **twice** for each message:

```javascript
// BAD CODE:
data.messages.forEach(message => {
  document.dispatchEvent(new CustomEvent('newAgentMessage', { detail: message }));
  
  // Duplicate dispatch!
  document.dispatchEvent(new CustomEvent('newAgentMessage', { detail: message }));
});
```

**Impact:** Each message triggered two notifications immediately.

### Bug #2: Duplicate Event Listeners (Secondary Cause)
**Location:** Lines 14-26 (original)

The `initializeDashboard()` function could be called multiple times without checking if it was already initialized, leading to multiple event listeners:

```javascript
// BAD CODE:
function initializeDashboard() {
  // No guard against multiple calls
  document.addEventListener('newAgentMessage', handleNewMessage);
  // If called twice, two listeners = two notifications
}
```

**Impact:** If the page was re-initialized (e.g., via SPA navigation), each listener would fire, doubling the notifications.

### Bug #3: Multiple Polling Intervals (Tertiary Cause)
**Location:** Lines 31-35 (original)

The `startMessagePolling()` function created new `setInterval` calls without clearing previous ones:

```javascript
// BAD CODE:
function startMessagePolling() {
  // No cleanup of previous intervals
  setInterval(pollForMessages, 5000);
  // Calling this twice = two intervals polling simultaneously
}
```

**Impact:** Multiple polling intervals could run simultaneously, causing messages to be fetched and processed multiple times.

## Fixes Applied

### Fix #1: Remove Duplicate Event Dispatch
```javascript
// FIXED CODE:
data.messages.forEach(message => {
  // Dispatch event once for each message
  document.dispatchEvent(new CustomEvent('newAgentMessage', { 
    detail: message 
  }));
});
```

### Fix #2: Prevent Double Initialization
```javascript
// FIXED CODE:
let isInitialized = false;

function initializeDashboard() {
  // Prevent double initialization
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  
  // Add event listener only once
  document.addEventListener('newAgentMessage', handleNewMessage);
  // ...
}
```

### Fix #3: Clear Previous Polling Intervals
```javascript
// FIXED CODE:
let pollingInterval = null;

function startMessagePolling() {
  // Clear any existing interval before creating a new one
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  pollingInterval = setInterval(pollForMessages, 5000);
}
```

## Additional Safeguard

The notification system already had a safeguard in place using the Notification API's `tag` property:

```javascript
new Notification('New message from ' + message.agentName, {
  body: message.content,
  icon: '/favicon.ico',
  tag: message.id // Prevents duplicate notifications with same ID
});
```

However, this only helps if notifications are dispatched with unique IDs. The bugs above were causing separate notification calls with different timing, bypassing this safeguard.

## Testing Recommendations

1. **Test Single Message:**
   ```bash
   curl -X POST http://localhost:3000/api/agent/messages \
     -H "X-API-Key: YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"content":"Test message","priority":"normal","urgent":false,"agentName":"test3"}'
   ```
   Expected: ONE notification appears.

2. **Test Multiple Messages:**
   Send 3 messages in quick succession.
   Expected: THREE notifications appear (one per message).

3. **Test Page Refresh:**
   - Send a message
   - Refresh the page
   - Send another message
   Expected: ONE notification for each message.

4. **Test Tab Switching:**
   - Open dashboard in one tab
   - Switch to another tab
   - Send a message
   - Return to dashboard tab
   Expected: ONE notification.

## Prevention Measures

### Code Review Checklist
- [ ] Event listeners added only once
- [ ] Intervals/timeouts properly cleared before creation
- [ ] Initialization guards in place
- [ ] No duplicate function calls

### Recommended Tests
Add these Jest tests:

```javascript
describe('Dashboard Notifications', () => {
  beforeEach(() => {
    // Reset initialization state
    isInitialized = false;
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
  });

  it('should initialize only once', () => {
    initializeDashboard();
    initializeDashboard();
    // Should not throw error or create duplicates
  });

  it('should trigger notification only once per message', () => {
    const spy = jest.spyOn(window, 'showNotification');
    const mockMessage = { id: '123', content: 'Test', agentName: 'test3' };
    
    document.dispatchEvent(new CustomEvent('newAgentMessage', { 
      detail: mockMessage 
    }));
    
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('should clear previous interval when starting new one', () => {
    const clearIntervalSpy = jest.spyOn(window, 'clearInterval');
    
    startMessagePolling();
    const interval1 = pollingInterval;
    
    startMessagePolling();
    
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval1);
  });
});
```

## Files Changed

- `public/js/dashboard.js` - Fixed all three bugs related to double notifications

## Impact

- ✅ Users now receive exactly ONE notification per agent message
- ✅ No duplicate polling intervals
- ✅ No duplicate event listeners
- ✅ Page refreshes don't cause double initialization
- ✅ Memory efficient (no interval/listener leaks)

## Verification

After deploying this fix:
1. All existing agent messages will continue to work
2. No breaking changes to the API
3. Backward compatible with all agent integrations
4. UI behavior unchanged except for the bug fix
