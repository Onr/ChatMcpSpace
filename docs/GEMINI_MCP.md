# Gemini MCP connection

ChatMCP.Space exposes a Streamable HTTP MCP server at:

```text
https://chatmcp.space/mcp
```

In Gemini, choose **Connect to an MCP server** and enter that full URL. Gemini discovers the ChatMCP OAuth authorization server, registers as a public OAuth client, and opens ChatMCP sign-in and consent when needed. Sign in to the verified account whose agents you want to see, then approve the requested access.

The first integration exposes one read-only tool, `list_agents`, which returns the names and IDs of agents owned by the consenting account. It does not provide chat contents, API keys, or encryption keys. OAuth access tokens expire after 15 minutes; clients can renew access using their rotated refresh token. The server supports token revocation; remove the custom app in Gemini to disconnect it.

## Deployment checks

- Apply database migration `059_add_mcp_oauth.sql`.
- Configure `BASE_URL` to the public HTTPS site origin.
- Ensure the reverse proxy forwards `/.well-known/*`, `/oauth/*`, `/mcp`, and `/mcp-guide` to the Express app without rewriting MCP POST requests.
- In a Gemini account that offers custom connected apps, enter `https://chatmcp.space/mcp`, complete login and consent, then invoke `list_agents`. This browser acceptance check remains pending until tested after deployment.

The browser guide is available at [https://chatmcp.space/mcp-guide](https://chatmcp.space/mcp-guide).

## Live verification on October 13, 2026

The original Gemini error persisted because the production process had started
before the MCP routes were added. Both `/mcp` and OAuth discovery returned HTML
404 pages until the supervised application was restarted.

After restart, migration 059 was applied and public HTTPS checks passed for the
MCP authorization challenge, both protected-resource discovery URLs,
authorization-server metadata, dynamic client registration, the registered
client's redirect to sign-in, and the connection guide. The temporary test client
was removed after verification. Eight focused automated tests also passed.

Gemini's actual signed-in browser flow still requires user verification. Retry
the full `/mcp` URL now. On future releases, restart the supervised application
and verify public MCP and OAuth responses before asking users to connect.

## Browser acceptance test

`tests/e2e/mcp-connection.js` uses a real Chromium browser against the configured
public site. It creates an isolated verified test account and agent, registers a
loopback OAuth client, submits the real sign-in form, approves consent, exchanges
the resulting PKCE authorization code, and invokes `list_agents`. It also checks
that Cancel returns `access_denied`. Its test account, agent, OAuth grants, and
browser session are removed afterward. No verification email is sent.

Run it on the application host with the normal database configuration and a
Playwright Chromium installation:

```sh
LIVE_MCP_VERIFY=1 node tests/e2e/mcp-connection.js
```

Screenshots and the latest successful result are written to
`test-results/mcp-verification/`. This verifies ChatMCP's browser flow with a
verification client; it does not log into or claim acceptance by Gemini itself.

Browser testing uncovered a sign-in issue that server-only tests missed: the
landing page used a manual fetch redirect and then unconditionally navigated to
the dashboard. Password sign-in now returns the server-selected continuation as
JSON to that form, including the MFA destination when required. Native form and
Google sign-in redirects remain supported. Browser consent returns to a
same-origin completion document before opening the registered callback, so a
provider's subsequent redirects are not kept inside the form submission. The
site's restrictive form policy remains intact.

## Gemini long-state compatibility

An actual Gemini authorization request used a 1,078-character opaque `state`
value. The original 1,024-character application limit rejected it even though
the required protocol, PKCE, redirect, resource, and scope parameters were valid.
The limit is now 8,192 characters, and state must be a single non-empty string.
Oversized or ambiguous state receives a specific validation error. State is
preserved exactly through sign-in, consent approval, and cancellation.

Regression tests cover 1,024, 1,078, 4,096, and 8,192-character values, rejection
above the limit and for repeated state parameters, and a full long-state flow
using a Google-style callback origin. The live server accepted the previously
rejected Gemini request after deployment and redirected it to sign-in.

OAuth treats state as client-provided opaque data; see
[RFC 6749, authorization requests](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1).

## OAuth request limits

MCP operations have separate one-minute budgets: registration 20 requests,
authorization and consent 60, token operations 120, and revocation 60. They use
the existing middleware's trusted-identity/IP keying. They do not consume the
password-login budget, which remains six requests per minute. A legitimate
connection can therefore complete its multiple protocol steps without being
counted as repeated password attempts.

The live browser acceptance test no longer inserts rate-limit waits. It fails
if the normal connection or cancellation flow receives HTTP 429.

## Consent handoff and repeated submissions

Browser approval or denial redirects to `/oauth/authorize/complete` in the same
session, then a nonce-authorized script navigates to the registered callback. A
visible continuation link is available if automatic navigation does not run.
The completion route validates the opaque authorization ID, account, session,
and expiration; callback URLs never come from its query parameters.

An identical repeated consent submission recovers the saved completion instead
of issuing another code or reporting it as expired. CSRF, account, decision, and
expiration checks still apply. Stale forms have an explanatory recovery page and
connection instructions. Start a fresh connection from Gemini after encountering
an old error page rather than resubmitting that old form.

The browser acceptance test includes a callback that redirects to a second
origin, covering a provider handoff that a single-hop callback does not exercise.
