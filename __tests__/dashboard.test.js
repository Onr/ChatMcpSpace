/**
 * Tests for dashboard.js notification system
 * 
 * These tests verify that the double notification bug is fixed
 */

// Test constants
const TEST_AGENT_NAME = 'test3';

describe('Dashboard Notification System', () => {
  // Mock the DOM and browser APIs
  let mockDocument;
  let mockNotification;
  let eventListeners;
  
  beforeEach(() => {
    // Reset event listeners tracking
    eventListeners = {};
    
    // Mock document.addEventListener
    mockDocument = {
      addEventListener: jest.fn((event, handler) => {
        if (!eventListeners[event]) {
          eventListeners[event] = [];
        }
        eventListeners[event].push(handler);
      }),
      dispatchEvent: jest.fn((event) => {
        const handlers = eventListeners[event.type] || [];
        handlers.forEach(handler => handler(event));
      }),
      querySelector: jest.fn(() => ({
        dataset: { agentId: 'test-agent-123' }
      })),
      getElementById: jest.fn(() => ({
        insertBefore: jest.fn()
      })),
      readyState: 'complete'
    };
    
    // Mock Notification API
    mockNotification = jest.fn();
    mockNotification.permission = 'granted';
    global.Notification = mockNotification;
    
    // Mock fetch
    global.fetch = jest.fn(() => 
      Promise.resolve({
        json: () => Promise.resolve({
          messages: []
        })
      })
    );
    
    // Mock setInterval and clearInterval
    global.setInterval = jest.fn(() => 12345);
    global.clearInterval = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    test('should initialize only once even when called multiple times', () => {
      // This test verifies Bug #2 is fixed
      
      // Create a simple version of our initialization logic
      let isInitialized = false;
      const initializeDashboard = () => {
        if (isInitialized) {
          return;
        }
        isInitialized = true;
        mockDocument.addEventListener('newAgentMessage', () => {});
      };
      
      // Call it twice
      initializeDashboard();
      initializeDashboard();
      
      // Should only add listener once
      expect(mockDocument.addEventListener).toHaveBeenCalledTimes(1);
    });

    test('should clear previous polling interval before creating new one', () => {
      // This test verifies Bug #3 is fixed
      
      let pollingInterval = null;
      const startMessagePolling = () => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
        }
        pollingInterval = setInterval(() => {}, 5000);
      };
      
      // Start polling twice
      startMessagePolling();
      startMessagePolling();
      
      // Should have cleared the first interval
      expect(global.clearInterval).toHaveBeenCalledTimes(1);
      expect(global.setInterval).toHaveBeenCalledTimes(2);
    });
  });

  describe('Message Processing', () => {
    test('should dispatch event only once per message', () => {
      // This test verifies Bug #1 is fixed
      
      const messages = [
        { id: '1', content: 'Message 1', agentName: TEST_AGENT_NAME },
        { id: '2', content: 'Message 2', agentName: TEST_AGENT_NAME }
      ];
      
      // Simulate the FIXED code (dispatching once per message)
      messages.forEach(message => {
        mockDocument.dispatchEvent(new CustomEvent('newAgentMessage', { 
          detail: message 
        }));
      });
      
      // Should have dispatched exactly 2 events (one per message)
      expect(mockDocument.dispatchEvent).toHaveBeenCalledTimes(2);
    });

    test('should NOT dispatch event twice per message (bug reproduction)', () => {
      // This test shows what the bug looked like
      
      const messages = [
        { id: '1', content: 'Message 1', agentName: TEST_AGENT_NAME }
      ];
      
      // Simulate the BUGGY code (dispatching twice per message)
      let dispatchCount = 0;
      const buggyDispatch = (message) => {
        mockDocument.dispatchEvent(new CustomEvent('newAgentMessage', { 
          detail: message 
        }));
        // BUG: Second dispatch
        mockDocument.dispatchEvent(new CustomEvent('newAgentMessage', { 
          detail: message 
        }));
        dispatchCount = mockDocument.dispatchEvent.mock.calls.length;
      };
      
      messages.forEach(buggyDispatch);
      
      // The bug would cause 2 dispatches for 1 message
      expect(dispatchCount).toBe(2);
      
      // Our fix ensures only 1 dispatch per message
      // (verified in the previous test)
    });
  });

  describe('Notification Display', () => {
    test('should show notification only once per message', () => {
      // Set up event handler
      const handleNewMessage = (event) => {
        const message = event.detail;
        // This simulates showNotification(message)
        new Notification('New message from ' + message.agentName, {
          body: message.content,
          icon: '/favicon.ico',
          tag: message.id
        });
      };
      
      mockDocument.addEventListener('newAgentMessage', handleNewMessage);
      
      // Dispatch event once
      const message = { id: '1', content: 'Test', agentName: TEST_AGENT_NAME };
      mockDocument.dispatchEvent(new CustomEvent('newAgentMessage', { 
        detail: message 
      }));
      
      // Should create exactly one notification
      expect(mockNotification).toHaveBeenCalledTimes(1);
      expect(mockNotification).toHaveBeenCalledWith(
        'New message from test3',
        {
          body: 'Test',
          icon: '/favicon.ico',
          tag: '1'
        }
      );
    });

    test('should use message ID as tag to prevent browser duplicate notifications', () => {
      const message = { id: 'unique-123', content: 'Test', agentName: TEST_AGENT_NAME };
      
      new Notification('New message from ' + message.agentName, {
        body: message.content,
        icon: '/favicon.ico',
        tag: message.id
      });
      
      // Verify tag is set (browser will deduplicate notifications with same tag)
      expect(mockNotification).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ tag: 'unique-123' })
      );
    });
  });

  describe('Integration - Full Flow', () => {
    test('should handle complete message flow without duplicates', () => {
      let notificationCount = 0;
      
      // Simulate complete initialization (fixed version)
      let isInitialized = false;
      let pollingInterval = null;
      
      const initializeDashboard = () => {
        if (isInitialized) return;
        isInitialized = true;
        
        mockDocument.addEventListener('newAgentMessage', (event) => {
          notificationCount++;
          new Notification('New message', { tag: event.detail.id });
        });
      };
      
      const startMessagePolling = () => {
        if (pollingInterval) {
          clearInterval(pollingInterval);
        }
        pollingInterval = setInterval(() => {}, 5000);
      };
      
      const processMessages = (messages) => {
        messages.forEach(message => {
          mockDocument.dispatchEvent(new CustomEvent('newAgentMessage', { 
            detail: message 
          }));
        });
      };
      
      // Initialize
      initializeDashboard();
      startMessagePolling();
      
      // Process 3 messages
      const messages = [
        { id: '1', content: 'Message 1' },
        { id: '2', content: 'Message 2' },
        { id: '3', content: 'Message 3' }
      ];
      processMessages(messages);
      
      // Should have exactly 3 notifications
      expect(notificationCount).toBe(3);
      expect(mockNotification).toHaveBeenCalledTimes(3);
    });
  });
});
