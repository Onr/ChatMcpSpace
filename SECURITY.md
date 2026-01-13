# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Instead, please send an email or contact the maintainers privately with:

1. A description of the vulnerability
2. Steps to reproduce the issue
3. Potential impact
4. Any suggested fixes (optional)

## Response Timeline

- **Initial response**: Within 48 hours
- **Status update**: Within 7 days
- **Fix timeline**: Depends on severity, typically within 30 days

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Security Best Practices

When deploying this application:

1. Always use HTTPS in production
2. Set strong, unique values for `SESSION_SECRET`
3. Use environment variables for all secrets
4. Keep dependencies updated
5. Follow the principle of least privilege for database users
