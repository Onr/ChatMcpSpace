# Contributing to ChatMcpSpace

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js v14 or higher
- PostgreSQL v12 or higher
- Redis (optional, for session storage)

### Development Setup

1. Fork and clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment file:
   ```bash
   cp .env.example .env
   ```
4. Set up the database:
   ```bash
   createdb agent_messaging_platform
   psql -d agent_messaging_platform -f src/db/schema.sql
   ```
5. Start the development server:
   ```bash
   npm run dev
   ```

## How to Contribute

### Reporting Issues

- Check existing issues before creating a new one
- Use the issue template if available
- Include steps to reproduce, expected behavior, and actual behavior

### Pull Requests

1. Create a feature branch: `git checkout -b feature/your-feature-name`
2. Make your changes with clear commit messages
3. Write or update tests as needed
4. Run tests: `npm test`
5. Push and open a PR against `main`

### Code Style

- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions small and focused
- Follow existing code patterns

### Testing

All new features should include tests. Run the test suite with:

```bash
npm test
npm run test:coverage  # for coverage report
```

## Questions?

Open an issue for any questions about contributing.
