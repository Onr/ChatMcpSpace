/**
 * Tests for notification deduplication logic
 * 
 * These tests verify that the dual-layer (in-memory + sessionStorage) 
 * notification tracking prevents duplicate voice notifications.
 */

// Mock sessionStorage for Node.js environment
const createMockSessionStorage = () => {
    const store = {};
    return {
        getItem: (key) => store[key] || null,
        setItem: (key, value) => { store[key] = value; },
        removeItem: (key) => { delete store[key]; },
        clear: () => { Object.keys(store).forEach(key => delete store[key]); }
    };
};

// Test constants matching dashboard.js
const GLOBAL_NOTIFICATION_TTL = 300000; // 5 minutes
const NOTIFIED_MESSAGES_STORAGE_KEY = 'dashboard_notified_messages';

describe('Notification Deduplication', () => {
    let sessionStorage;
    let globalNotifiedMessages;

    beforeEach(() => {
        // Reset state before each test
        sessionStorage = createMockSessionStorage();
        globalNotifiedMessages = new Set();
    });

    // Helper functions (replicated from dashboard.js for testing)
    function loadNotifiedMessagesFromStorage() {
        try {
            const stored = sessionStorage.getItem(NOTIFIED_MESSAGES_STORAGE_KEY);
            if (!stored) return new Map();
            const parsed = JSON.parse(stored);
            const now = Date.now();
            const result = new Map();
            for (const [id, ts] of Object.entries(parsed)) {
                if (now - ts < GLOBAL_NOTIFICATION_TTL) {
                    result.set(id, ts);
                }
            }
            return result;
        } catch (e) {
            return new Map();
        }
    }

    function saveNotifiedMessagesToStorage(messagesMap) {
        try {
            const obj = Object.fromEntries(messagesMap);
            sessionStorage.setItem(NOTIFIED_MESSAGES_STORAGE_KEY, JSON.stringify(obj));
        } catch (e) {
            // ignore
        }
    }

    function isMessageNotified(messageId) {
        if (!messageId) return false;
        if (globalNotifiedMessages.has(messageId)) return true;
        const stored = loadNotifiedMessagesFromStorage();
        if (stored.has(messageId)) {
            globalNotifiedMessages.add(messageId);
            return true;
        }
        return false;
    }

    function markMessageAsNotified(messageId) {
        if (!messageId) return;
        const now = Date.now();
        globalNotifiedMessages.add(messageId);
        const stored = loadNotifiedMessagesFromStorage();
        stored.set(messageId, now);
        saveNotifiedMessagesToStorage(stored);
    }

    describe('isMessageNotified', () => {
        it('should return false for a message not yet notified', () => {
            const result = isMessageNotified('msg-123');
            expect(result).toBe(false);
        });

        it('should return true for a message in in-memory set', () => {
            globalNotifiedMessages.add('msg-123');
            const result = isMessageNotified('msg-123');
            expect(result).toBe(true);
        });

        it('should return true for a message in sessionStorage', () => {
            const stored = new Map([['msg-456', Date.now()]]);
            saveNotifiedMessagesToStorage(stored);

            const result = isMessageNotified('msg-456');
            expect(result).toBe(true);
        });

        it('should sync sessionStorage entries to in-memory set on lookup', () => {
            const stored = new Map([['msg-789', Date.now()]]);
            saveNotifiedMessagesToStorage(stored);

            expect(globalNotifiedMessages.has('msg-789')).toBe(false);
            isMessageNotified('msg-789');
            expect(globalNotifiedMessages.has('msg-789')).toBe(true);
        });

        it('should return false for null messageId', () => {
            const result = isMessageNotified(null);
            expect(result).toBe(false);
        });

        it('should return false for undefined messageId', () => {
            const result = isMessageNotified(undefined);
            expect(result).toBe(false);
        });
    });

    describe('markMessageAsNotified', () => {
        it('should add message to in-memory set', () => {
            markMessageAsNotified('msg-new');
            expect(globalNotifiedMessages.has('msg-new')).toBe(true);
        });

        it('should persist message to sessionStorage', () => {
            markMessageAsNotified('msg-persist');

            const stored = loadNotifiedMessagesFromStorage();
            expect(stored.has('msg-persist')).toBe(true);
        });

        it('should store timestamp with message', () => {
            const before = Date.now();
            markMessageAsNotified('msg-timed');
            const after = Date.now();

            const stored = loadNotifiedMessagesFromStorage();
            const ts = stored.get('msg-timed');
            expect(ts).toBeGreaterThanOrEqual(before);
            expect(ts).toBeLessThanOrEqual(after);
        });

        it('should not throw for null messageId', () => {
            expect(() => markMessageAsNotified(null)).not.toThrow();
        });
    });

    describe('TTL behavior', () => {
        it('should expire old entries when loading from storage', () => {
            // Simulate an old entry (older than TTL)
            const oldTimestamp = Date.now() - GLOBAL_NOTIFICATION_TTL - 1000;
            sessionStorage.setItem(NOTIFIED_MESSAGES_STORAGE_KEY, JSON.stringify({
                'msg-old': oldTimestamp,
                'msg-recent': Date.now()
            }));

            const stored = loadNotifiedMessagesFromStorage();
            expect(stored.has('msg-old')).toBe(false);
            expect(stored.has('msg-recent')).toBe(true);
        });

        it('should keep entries within TTL window', () => {
            // Entry just within the TTL
            const recentTimestamp = Date.now() - (GLOBAL_NOTIFICATION_TTL / 2);
            sessionStorage.setItem(NOTIFIED_MESSAGES_STORAGE_KEY, JSON.stringify({
                'msg-within-ttl': recentTimestamp
            }));

            const stored = loadNotifiedMessagesFromStorage();
            expect(stored.has('msg-within-ttl')).toBe(true);
        });
    });

    describe('Duplicate prevention scenarios', () => {
        it('should prevent duplicate notification when message is checked twice rapidly', () => {
            // First check - not notified
            expect(isMessageNotified('msg-rapid')).toBe(false);

            // Mark as notified
            markMessageAsNotified('msg-rapid');

            // Second check - should be notified
            expect(isMessageNotified('msg-rapid')).toBe(true);
        });

        it('should prevent duplicate after simulated page refresh (in-memory clear)', () => {
            // Mark message as notified
            markMessageAsNotified('msg-refresh');

            // Simulate page refresh - clear in-memory but keep sessionStorage
            globalNotifiedMessages.clear();

            // Should still be notified from sessionStorage
            expect(isMessageNotified('msg-refresh')).toBe(true);
        });

        it('should prevent duplicate across 60+ seconds (main bug scenario)', () => {
            // This tests the specific bug where duplicates occurred 60+ seconds apart
            const messageId = 'msg-delayed-dup';

            // First notification
            expect(isMessageNotified(messageId)).toBe(false);
            markMessageAsNotified(messageId);

            // Simulate 60 seconds passing (within the 5-minute TTL)
            // In real scenario, in-memory might be cleared but sessionStorage persists
            globalNotifiedMessages.clear();

            // Second check after 60 seconds - should still be blocked
            expect(isMessageNotified(messageId)).toBe(true);
        });

        it('should allow notification for different messages', () => {
            markMessageAsNotified('msg-first');

            expect(isMessageNotified('msg-first')).toBe(true);
            expect(isMessageNotified('msg-second')).toBe(false);
        });
    });
});
