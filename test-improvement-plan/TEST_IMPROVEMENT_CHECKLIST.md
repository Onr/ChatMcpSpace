# Test Improvement Checklist
**AI Agent Messaging Platform - Comprehensive Testing Plan**

*Generated: 2026-01-03*

---

## Current Test Status

**Existing Coverage:**
- ✅ Agent deletion with cascading deletes (3 tests)
- ✅ Agent ordering by creation timestamp (1 test)
- ✅ Python message helper functionality (9 tests)
- ✅ API guide generator (2 tests)

**Total: 15 Jest test cases**

---

## Phase 1: Critical Security & Authentication (Weeks 1-2)

### 1.1 Test Infrastructure Setup
- [x] Add coverage reporting to package.json
  - [x] Add `test:coverage` script with `jest --runInBand --coverage`
  - [x] Add `test:watch` script with `jest --runInBand --watch`
  - [x] Configure coverage thresholds in jest.config.js (70% global)
  - [x] Add coverage directory to .gitignore
- [x] Create test fixtures directory: `tests/fixtures/`
- [x] Document test setup patterns in `tests/README.md`

### 1.2 Authentication Middleware (`src/middleware/authMiddleware.js`)
- [x] Test valid API key authentication
- [x] Test invalid API key rejection
- [x] Test missing API key handling
- [x] Test session token validation
- [x] Test session token expiration
- [x] Test unauthorized access attempts
- [x] Test SQL injection attempts on auth endpoints
- [x] Test concurrent authentication requests

### 1.3 Authentication Service (`src/services/authService.js`)
- [x] Test user registration with valid data
- [x] Test duplicate username/email handling
- [x] Test password hashing consistency
- [x] Test password verification (correct/incorrect)
- [x] Test API key generation uniqueness
- [x] Test API key collision prevention
- [x] Test bcrypt salt rounds configuration
- [x] Test user lookup functions

### 1.4 Input Validation (`src/utils/validation.js`)
- [x] Test SQL injection pattern detection
  - [x] Test `' OR '1'='1` patterns
  - [x] Test `'; DROP TABLE` patterns
  - [x] Test union-based injection attempts
- [x] Test XSS payload detection
  - [x] Test `<script>` tag sanitization
  - [x] Test event handler attributes (onclick, onerror)
  - [x] Test JavaScript protocol URLs
- [x] Test boundary cases
  - [x] Empty strings
  - [x] Null values
  - [x] Undefined values
  - [x] Very long strings (>1MB)
- [x] Test Unicode/special character handling
- [x] Test email format validation
- [x] Test length limit enforcement

### 1.5 Encryption Helper (`src/utils/encryptionHelper.js`)
- [x] Test encryption/decryption round-trip accuracy
- [x] Test encryption with salt
- [x] Test encryption without salt
- [x] Test handling of corrupted encrypted payloads
- [x] Test decryption failure scenarios
- [x] Test key derivation function
- [x] Test IV (initialization vector) generation

---

## Phase 2: API Routes & Security Middleware (Weeks 3-4)

### 2.1 CSRF Middleware (`src/middleware/csrfMiddleware.js`)
- [ ] Test CSRF token generation
- [ ] Test valid CSRF token acceptance
- [ ] Test invalid CSRF token rejection
- [ ] Test missing CSRF token handling
- [ ] Test double-submit cookie pattern
- [ ] Test CSRF token expiration

### 2.2 Rate Limiting Middleware (`src/middleware/rateLimitMiddleware.js`)
- [ ] Test normal traffic (under limit)
- [ ] Test rate limit enforcement (over limit)
- [ ] Test rate limit reset behavior
- [ ] Test per-user vs global limits
- [ ] Test abuse scenarios (rapid requests)
- [ ] Test rate limit headers (X-RateLimit-*)
- [ ] Test distributed rate limiting (Redis-based)

### 2.3 Agent API Routes (`src/routes/agentApiRoutes.js`)
- [ ] Test POST `/api/agent/messages` with valid payload
- [ ] Test POST `/api/agent/messages` with invalid data
- [ ] Test POST `/api/agent/messages` with different priority levels
- [ ] Test POST `/api/agent/messages` with encryption enabled
- [ ] Test POST `/api/agent/questions` with options
- [ ] Test POST `/api/agent/questions` without options
- [ ] Test GET `/api/agent/responses` with valid cursor
- [ ] Test GET `/api/agent/responses` with since parameter
- [ ] Test GET `/api/agent/responses` for new agents
- [ ] Test concurrent message submissions

### 2.4 User API Routes (`src/routes/userApiRoutes.js`)
- [ ] Test GET `/api/user/agents` listing (already tested for ordering)
- [ ] Test GET `/api/user/messages/:agentId` retrieval
- [ ] Test GET `/api/user/messages/:agentId` for non-existent agent
- [ ] Test POST `/api/user/messages` sending
- [ ] Test POST `/api/user/responses` submission
- [ ] Test message pagination
- [ ] Test message filtering by priority
- [ ] Test urgent message handling

### 2.5 Email API Routes (`src/routes/emailApiRoutes.js`)
- [ ] Test email verification token generation
- [ ] Test email verification token validation
- [ ] Test expired token handling
- [ ] Test invalid token handling
- [ ] Test resend verification email

### 2.6 Integration Tests
- [ ] Create `tests/integration/` directory
- [ ] Test complete user registration flow
  - [ ] Register → Receive email → Verify → Login
- [ ] Test complete agent communication flow
  - [ ] Create agent → Send message → Ask question → Receive response
- [ ] Test message encryption end-to-end
  - [ ] Agent sends encrypted → User receives decrypted → User replies encrypted
- [ ] Test agent deletion cascade (already partially covered)
- [ ] Test concurrent user sessions
- [ ] Test OAuth login flow (Google)

---

## Phase 3: Service Layer & Infrastructure (Ongoing)

### 3.1 Email Service (`src/services/emailService.js`)
- [ ] Test email template rendering
- [ ] Test email delivery success
- [ ] Test email delivery failure handling
- [ ] Test invalid email address handling
- [ ] Test email queue processing
- [ ] Test email rate limiting
- [ ] Mock nodemailer for tests

### 3.2 TTS Service (`src/services/ttsService.js`)
- [ ] Test TTS URL generation
- [ ] Test TTS URL validation
- [ ] Test Google TTS API integration
- [ ] Test fallback when TTS unavailable
- [ ] Test audio format handling
- [ ] Mock Google TTS API for tests

### 3.3 Database Connection (`src/db/connection.js`)
- [ ] Test connection pool initialization
- [ ] Test connection pool exhaustion scenarios
- [ ] Test database reconnection on failure
- [ ] Test connection timeout handling
- [ ] Test concurrent transaction handling
- [ ] Test connection leak detection

### 3.4 Database Initialization (`src/db/init.js`)
- [ ] Test schema creation
- [ ] Test index creation
- [ ] Test constraint creation
- [ ] Test idempotent initialization (running twice)

### 3.5 Database Migrations (`src/db/migrations/`)
- [ ] Test migration execution
- [ ] Test migration rollback
- [ ] Test migration versioning
- [ ] Test idempotent migrations

### 3.6 Error Handling
- [ ] Test error middleware (`src/middleware/errorMiddleware.js`)
  - [ ] Test 404 handling
  - [ ] Test 500 error responses
  - [ ] Test error message sanitization
  - [ ] Test no stack trace leakage to users
- [ ] Test error handler utility (`src/utils/errorHandler.js`)
  - [ ] Test error formatting consistency
  - [ ] Test different error types
- [ ] Test security logger (`src/utils/securityLogger.js`)
  - [ ] Test suspicious activity logging
  - [ ] Test log sanitization (no PII/secrets)
  - [ ] Test audit trail completeness
- [ ] Test application logger (`src/utils/logger.js`)
  - [ ] Test log level filtering
  - [ ] Test log rotation
  - [ ] Test structured logging format

### 3.7 Page Routes (`src/routes/pageRoutes.js`)
- [ ] Test GET `/register` page render
- [ ] Test GET `/login` page render
- [ ] Test GET `/dashboard` authenticated access
- [ ] Test GET `/dashboard` unauthenticated redirect
- [ ] Test GET `/settings` page render
- [ ] Test CSRF token injection in forms

### 3.8 Redis Client (`src/utils/redisClient.js`)
- [ ] Test Redis connection initialization
- [ ] Test Redis connection failure handling
- [ ] Test session storage/retrieval
- [ ] Test session expiration
- [ ] Test Redis reconnection

---

## Phase 4: Performance & Load Testing (Future)

### 4.1 Performance Benchmarks
- [ ] Install load testing tool (Artillery or k6)
- [ ] Create load test scenarios
  - [ ] User registration load test
  - [ ] Concurrent message sending
  - [ ] High-frequency polling
  - [ ] Database query performance
- [ ] Establish baseline metrics
- [ ] Set performance regression alerts

### 4.2 Database Performance
- [ ] Profile slow queries
- [ ] Test index effectiveness
- [ ] Test connection pool sizing
- [ ] Test query result caching

### 4.3 Memory & Resource Testing
- [ ] Test memory leak detection
- [ ] Test file descriptor limits
- [ ] Test graceful shutdown
- [ ] Test resource cleanup

---

## Quick Wins (High Impact, Low Effort)

Priority order for immediate implementation:

1. **✅ Add Coverage Reporting** (5 minutes)
   - Add scripts to package.json
   - Configure thresholds in jest.config.js

2. **Input Validation Tests** (1-2 hours)
   - Pure functions, easy to test in isolation
   - High security impact

3. **Encryption Helper Tests** (1 hour)
   - Clear input/output validation
   - Already have Python tests as reference

4. **Error Handler Tests** (1 hour)
   - Straightforward unit tests
   - Improves debugging experience

5. **API Guide Generator** (30 minutes)
   - Already started in TODO_TESTS.md
   - Just needs completion

---

## Testing Best Practices Checklist

- [ ] All tests use descriptive names (describe what, not how)
- [ ] Tests are independent (no shared state)
- [ ] Tests use proper setup/teardown (beforeEach/afterEach)
- [ ] Database tests use pg-mem for isolation
- [ ] External APIs are mocked (email, TTS, OAuth)
- [ ] Secrets never appear in test code
- [ ] Test fixtures are in dedicated directory
- [ ] Integration tests clearly marked
- [ ] Performance tests run separately
- [ ] CI/CD integration configured

---

## Coverage Goals

**Target Metrics:**
- Lines: 70%+
- Branches: 70%+
- Functions: 70%+
- Statements: 70%+

**Per-Directory Targets:**
- `src/middleware/`: 90%+ (critical security)
- `src/services/`: 80%+ (core business logic)
- `src/routes/`: 85%+ (API surface)
- `src/utils/`: 75%+ (utilities)
- `src/db/`: 60%+ (infrastructure)

---

## Test Execution Commands

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch

# Run specific test file
npm run test tests/api/agentDeletion.test.js

# Run tests matching pattern
npm run test -- --testNamePattern="authentication"

# Run integration tests only
npm run test tests/integration/

# Run performance tests (when implemented)
npm run test:performance
```

---

## Progress Tracking

**Current Status:**
- Total Items: ~150+
- Completed: 4 (agent deletion, ordering, Python helper, API guide)
- In Progress: 0
- Remaining: ~146

**Estimated Effort:**
- Phase 1 (Critical): ~40 hours
- Phase 2 (Medium): ~60 hours
- Phase 3 (Ongoing): ~80 hours
- Phase 4 (Future): ~40 hours

**Last Updated:** 2026-01-03
**Next Review:** After Phase 1 completion

---

## Notes

- Mark items with ✅ when completed
- Add dates to completed items for tracking
- Update progress tracking section weekly
- Review and adjust phases based on findings
- Prioritize security and authentication tests
- Don't skip quick wins - they build momentum
- Document any new test patterns discovered
- Keep TODO_TESTS.md in sync with this checklist
