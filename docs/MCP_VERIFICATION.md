# MCP verification

Verified against the live public site on October 15, 2026.

## Result

ChatMCP's complete browser flow passes with a real loopback OAuth verification
client. The Gemini application itself has not been tested in a signed-in Google
session, so this result does not establish Gemini-specific acceptance.

The integration currently exposes only `list_agents`, returning the consenting
account's agent names and IDs. It does not expose encrypted chat contents or
provide message-sending tools.

## User-visible flow tested in Chromium

1. Open the connection guide and verify the displayed MCP URL.
2. Start authorization from a registered client while signed out.
3. Fill and submit the actual public site's password sign-in form.
4. Automatically return to the consent screen for the requesting client.
5. Click **Allow access** and return to the registered client with matching state.
6. Exchange the code using PKCE and successfully invoke `list_agents`.
7. Start authorization again while signed in and click **Cancel**. Confirm the
   client receives `access_denied` without an authorization code.

No browser JavaScript exceptions or form-policy errors occurred in the final
run. The test completes without artificial rate-limit waits and fails on any
unexpected OAuth HTTP 429 response.

Screenshots:

- [Connection guide](../test-results/mcp-verification/01-guide.png)
- [Sign-in page](../test-results/mcp-verification/02-sign-in.png)
- [Consent screen](../test-results/mcp-verification/03-consent.png)
- [Verification client result](../test-results/mcp-verification/04-verification-client-result.png)
- [Machine-readable browser result](../test-results/mcp-verification/result.json)

The last screenshot is the verification client's result display, not Gemini UI.

## Additional verification

- 63 automated tests passed across seven MCP, authorization, sign-in, MFA,
  registration, authentication, and logging suites.
- A separate live HTTP test passed discovery, password sign-in, consent, PKCE
  exchange, initialization, tool discovery, account isolation, refresh-token
  rotation, renewed tool access, and denial after revocation.
- Temporary reserved-domain accounts, agents, client registrations, grants,
  tokens, and browser sessions were cleaned up after each run. No verification
  emails were sent and no existing user's credentials or messages were used.

## Changes made during verification

The browser test exposed a sign-in bug missed by server-only tests: manual fetch
redirects hid the response's Location header, and the landing page then forced
navigation to the dashboard. The sign-in form now requests a JSON response and
uses the server-selected continuation, including the MFA destination when
required. Native form redirects remain supported.

The latest consent handoff uses a same-origin completion document before opening
the registered callback, retaining the restrictive form policy. This supersedes
the earlier approach of adding the registered callback origin to that policy.

Both changes were deployed by restarting the supervised application and were
included in the final live browser test.

To repeat the browser check, use the guarded
[`tests/e2e/mcp-connection.js`](../tests/e2e/mcp-connection.js) test on the
application host with Chromium installed and `LIVE_MCP_VERIFY=1`.

## Gemini request compatibility follow-up

A subsequent actual Gemini connection exposed a state-length limit missing from
the earlier test cases. The rejected request contained 1,078 characters of state,
above the application's old 1,024-character cap. The other required parameters
were valid. State values up to 8,192 characters are now accepted as a single
non-empty string, with exact preservation on approval and cancellation.

Twelve focused MCP, sign-in continuation, and logging tests passed after this
change. The previously rejected live Gemini request was replayed without
authenticating or granting access and returned HTTP 302 to `/login` instead of
HTTP 400. Production health checks also passed after deployment. The reusable
browser test now generates state of the same length for future runs; the browser
suite was not rerun for this input-validation-only change.

## OAuth rate-limit follow-up

A real Gemini consent request hit the shared six-per-minute password-login
budget. Registration, authorization, consent, token exchange, renewal, and
revocation had all been consuming that same quota. Earlier browser-test waits
masked this operational problem.

MCP now has independent bounded budgets for registration, authorization and
consent, token operations, and revocation. Password login retains its existing
six-per-minute protection. Regression tests use the real rate-limit middleware
to exhaust the password quota, then complete authorization, consent, exchange,
eight renewals, and revocation. They also verify excessive registrations remain
blocked independently and the password quota stays exhausted.

After deployment, 49 tests passed across six relevant suites. The live Chromium
test passed the full long-state sign-in, consent, callback, tool call, and Cancel
flow without waits or HTTP 429 responses. Temporary test data and the downloaded
browser were removed afterward.

## Consent completion follow-up

The next reported error showed an approval form being treated as expired. The
production log showed a successful HTTP 303 approval, followed several seconds
later by a repeated POST returning HTTP 400, rather than an initial timeout.

Browser consent now redirects to a same-origin GET completion document and then
navigates to the registered client with a nonce-authorized script and a visible
fallback link. This separates the provider's redirect chain from the form
navigation. Identical same-session, same-account, same-CSRF, same-decision
retries reuse the saved completion without creating another code. Missing,
tampered, or expired completions show a recovery page.

Twenty-five focused tests passed, including duplicate submissions, tampered
CSRF and decisions, inaccessible completion IDs, expiration, and one-code-only
issuance. The updated live Chromium test also passed approval, a provider
callback redirecting to a second origin, `list_agents`, and cancellation, with
no JavaScript or rate-limit errors. The actual Gemini confirmation remains
subject to the user's fresh connection attempt.
