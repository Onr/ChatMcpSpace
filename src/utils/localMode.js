/**
 * Local (self-hosted) mode helpers.
 *
 * When LOCAL_MODE is enabled, someone running this project on their own machine
 * can register and sign in with just an email and a password. It removes only
 * the parts of the sign-up flow that need external services the operator may
 * not have: the emailed verification code (SMTP) and Google OAuth.
 *
 * Credentials are still required. Passwords are still hashed, sessions still
 * apply, and CSRF/rate limiting are untouched.
 */

const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);

let productionOverrideLogged = false;

/**
 * Whether LOCAL_MODE has been asked for, regardless of whether it is honoured.
 * @returns {boolean}
 */
function isLocalModeRequested() {
  const raw = process.env.LOCAL_MODE;
  return typeof raw === 'string' && TRUTHY_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Whether the relaxed local sign-up flow is active.
 *
 * The flag is deliberately ignored under NODE_ENV=production so that a stray
 * environment variable cannot silently disable email verification on a public
 * deployment. Ignoring (rather than exiting) keeps a misconfiguration from
 * turning into an outage.
 *
 * @returns {boolean}
 */
function isLocalAuthMode() {
  if (!isLocalModeRequested()) {
    return false;
  }

  if (process.env.NODE_ENV === 'production') {
    if (!productionOverrideLogged) {
      productionOverrideLogged = true;
      console.error(
        '[local-mode] LOCAL_MODE is set but NODE_ENV=production; ignoring it. ' +
        'Email verification remains required.'
      );
    }
    return false;
  }

  return true;
}

/**
 * Whether Google OAuth is usable. Without real credentials the sign-in buttons
 * lead to an error page, so local installs hide them instead.
 * @returns {boolean}
 */
function isGoogleAuthConfigured() {
  return Boolean(
    (process.env.GOOGLE_CLIENT_ID || '').trim() &&
    (process.env.GOOGLE_CLIENT_SECRET || '').trim()
  );
}

/**
 * Reset memoised warning state. Intended for tests.
 */
function resetLocalModeWarnings() {
  productionOverrideLogged = false;
}

module.exports = {
  isLocalModeRequested,
  isLocalAuthMode,
  isGoogleAuthConfigured,
  resetLocalModeWarnings
};
