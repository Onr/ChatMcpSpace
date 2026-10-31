## Public Release Checklist

This repository is a public-safe copy of the application, synced from the private
development repo and stripped of internal tooling, planning docs, and credentials.

Excluded from this repo:
- Real `.env` files
- Runtime chat/agent state under `chatspace/` and `.chatspace/`
- Uploaded files
- Local databases and runtime caches under `data/`
- Private keys and TLS certificates under `keys/`
- Local logs and temporary files
- Internal planning/audit/review docs, dev-scratch scripts, and this server's own
  health-monitoring tooling (which depends on an internal agent-messaging setup that
  isn't part of this product)

Before publishing:
1. Review `.env.example`, `.env.production.example`, and `.env.staging.example`.
2. Set your own repository URL in `README.md` and `package.json` if needed.
3. Create fresh credentials for SMTP, Google OAuth, Redis, PostgreSQL, and session signing.
4. If you want TTS support, provide your own `keys/service-account.json` outside git or use `GOOGLE_APPLICATION_CREDENTIALS`.
5. Run `npm ci` to install the dependencies pinned in `package-lock.json`.
6. Run `npm run migrate` to apply the migrations in `src/db/migrations/`, including
   `063_agent_identity_and_proactivity.sql`. Back up your database and configuration first.
7. Review [the latest release notes](docs/RELEASE_2026-10-31.md).

## Self-hosting with built-in account verification

This app ships with two ready-to-use signup/verification paths so external users can
create accounts on your instance without any custom auth work:
- **Email verification** — see `docs/EMAIL_VERIFICATION.md` (configure `EMAIL_HOST` /
  `EMAIL_USER` / `EMAIL_PASSWORD`).
- **Google OAuth sign-in** — see `src/config/passport.js` and set `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` in your `.env`.
