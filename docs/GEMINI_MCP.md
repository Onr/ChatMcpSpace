# MCP connection

Connect an OAuth-capable MCP client to:

```text
https://chatmcp.space/mcp
```

Sign in, approve one agent and the desired message/file permissions, leave
**Keep working after I close the browser** selected, and unlock encryption once.
Use the return link to finish OAuth in the AI app. When the connection page says
always-on access is active, you can close the browser. No local listener install
or repeated pairing is needed.

Always-on mode retains a protected copy of the approved encryption key on the
server and processes messages/files for the connected AI app. The account key
has account-wide cryptographic power; API permissions bind operations to the
approved agent and permitted peers. Messages, files and retry payloads remain
encrypted at rest. This connector is not end-to-end encrypted to the AI app.
Browser-only mode is still available if you decline hosted key access.

Tools include `list_agents`, `get_connection_status`, `read_inbox`, `read_thread`,
`send_message`, `send_peer_message`, `ack_message`, `upload_attachment`, and
`read_attachment`. Files of any MIME type are supported within the configured
size/quota limits (20 MB per file by default). Upload once, then pass returned
attachment IDs to user or peer messages. Downloads use bounded chunks and MCP
resources, with native image blocks for complete small images. An AI app's own
file interpretation and UI capabilities still apply.

For shared peers in other accounts, configure their separate shared encryption
password and salt once in the optional connection-page panel. Passwords are
used locally to derive a key; only the derived key is protected by the hosted
service. Existing collaboration permissions are checked again for delivery and
file access. See [hosted operations](MCP_HOSTED_CONNECTOR.md) for details.

Existing grants never silently acquire message/file/hosted access. Reconnect for
fresh consent when upgrading. Access tokens last 15 minutes and refresh tokens
rotate. Disconnect on the connection page or revoke OAuth to remove hosted keys,
retry records and credentials. Hosted availability does not automatically wake
an idle AI app; the app determines when it invokes tools.

## Deployment checks

- Apply migrations 059, 061 and 062 through the normal migration runner, alongside earlier application migrations.
- Set `BASE_URL` to the public HTTPS origin and allow the application to reach its own authenticated agent API on that origin. Credentialed internal calls reject redirects.
- Use a durable private wrapping-key file, or set `MCP_HOSTED_WRAPPING_KEY` from a secret manager. All replicas must share the wrapping key, database and attachment storage. Back up the wrapping key separately from the database.
- Forward `/.well-known/*`, `/oauth/*` and `/mcp*` to Express; allow the configured file size plus base64 overhead in proxy request limits. Other JSON APIs retain their normal small limit.
- Verify fresh OAuth and message/file round trips in each actual AI client before claiming compatibility. Local tests do not establish vendor acceptance.

The optional legacy browser worker requires one process or grant-aware routing.
Always-on mode uses durable database state and does not require browser affinity.

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
