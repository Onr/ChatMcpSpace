# Test Documentation

## Structure

- **`api/`**: Integration tests for API endpoints.
- **`fixtures/`**: Static data used in tests.
- **`python/`**: Tests for Python helper scripts.
- **`utils/`**: Unit tests for utility functions.
- **`test-results/`**: Output logs from CLI tests.

## Setup Patterns

### Mocking
We use `jest` for mocking. External services (Email, TTS) should always be mocked.

```javascript
jest.mock('../../src/services/emailService');
```

### Database
Database tests use `pg-mem` to simulate a PostgreSQL database in memory. This ensures tests are fast and isolated.

### Fixtures
Place reusable JSON data or large string templates in `tests/fixtures/`.

## Running Tests

- `npm test`: Run all tests
- `npm run test:coverage`: Run with coverage report
- `npm run test:watch`: Run in watch mode
