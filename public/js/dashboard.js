/**
 * Dashboard JavaScript - Handles agent message polling and notifications
 */

// Global state for the current agent
let currentAgentId = null;
let lastPollTime = new Date().toISOString();
let pollingInterval = null;
let isInitialized = false;

/**
 * Initialize the dashboard when the page loads
 */
function initializeDashboard() {
  // Prevent double initialization
  if (isInitialized) {
    return;
  }
  isInitialized = true;
  
  console.log('Initializing dashboard...');
  
  // Get the agent ID from the page
  const agentElement = document.querySelector('[data-agent-id]');
  if (agentElement) {
    currentAgentId = agentElement.dataset.agentId;
  }
  
  // Add event listener only once
  document.addEventListener('newAgentMessage', handleNewMessage);
  
  // Start polling for new messages
  startMessagePolling();
}

/**
 * Start polling for new agent messages
 */
function startMessagePolling() {
  // Clear any existing interval before creating a new one
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  pollingInterval = setInterval(pollForMessages, 5000);
}

/**
 * Poll the server for new messages
 */
async function pollForMessages() {
  if (!currentAgentId) return;
  
  try {
    const response = await fetch(`/api/user/messages/${currentAgentId}?since=${lastPollTime}`);
    const data = await response.json();
    
    if (data.messages && data.messages.length > 0) {
      // Update last poll time
      lastPollTime = new Date().toISOString();
      
      // Process each new message
      data.messages.forEach(message => {
        // Dispatch event once for each message
        document.dispatchEvent(new CustomEvent('newAgentMessage', { 
          detail: message 
        }));
      });
    }
  } catch (error) {
    console.error('Error polling for messages:', error);
  }
}

/**
 * Handle new message events
 */
function handleNewMessage(event) {
  const message = event.detail;
  
  // Display the message in the UI
  displayMessage(message);
  
  // Show notification
  showNotification(message);
}

/**
 * Display a message in the message list
 */
function displayMessage(message) {
  const messageList = document.getElementById('message-list');
  if (!messageList) return;
  
  const messageElement = document.createElement('div');
  messageElement.className = 'message';
  messageElement.innerHTML = `
    <div class="message-header">
      <span class="agent-name">${message.agentName}</span>
      <span class="timestamp">${new Date(message.timestamp).toLocaleString()}</span>
    </div>
    <div class="message-content">${message.content}</div>
  `;
  
  messageList.insertBefore(messageElement, messageList.firstChild);
}

/**
 * Show a browser notification for a new message
 */
function showNotification(message) {
  // Check if notifications are supported and permitted
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('New message from ' + message.agentName, {
      body: message.content,
      icon: '/favicon.ico',
      tag: message.id // Use message ID as tag to prevent duplicate notifications
    });
  }
}

/**
 * Request notification permission if needed
 */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeDashboard);
} else {
  initializeDashboard();
}

// Request notification permission
requestNotificationPermission();
