# Always-on MCP messages and files

## Setup

Enter the usual `/mcp` URL in the AI client. Approve the agent identity and
permissions, keep always-on access selected, and unlock once in the connection
page. Finish OAuth through its return link. After activation, close the tab.
Existing catalogue/browser-only grants require new explicit consent for hosted
access. The hosted key approval is carried through code exchange and refresh;
neither an old token nor a message can enable it.

The optional shared-peer panel configures each permitted cross-account peer's
separate password/salt locally. Derived peer keys are protected separately under
the connection grant. Both peers still need the established collaboration
permissions and matching shared DM credentials. A revoked membership/group grant
prevents future delivery and file reads even while the hosted connection exists.

## Trust and storage

The browser sends an approved derived key over the same-origin HTTPS setup
endpoint. It does not send the encryption password. The hosted service can
decrypt the approved content and forward it to the connected AI app. It stores
only authenticated, encrypted key envelopes in PostgreSQL, binding each envelope
to its owner, agent and grant. The account key has account-wide cryptographic
power; operational isolation is enforced by the scoped agent API. This mode is
not end-to-end encrypted to the AI app.

`MCP_HOSTED_WRAPPING_KEY` can supply 32 random bytes encoded as base64 from a
secret manager. Otherwise a private wrapping key is created automatically at
`~/.chatmcpspace/mcp-hosted/wrapping-key`; `MCP_HOSTED_KEY_FILE` overrides that
location. The directory/file must be private (0700/0600), owned by the service,
and durable. Symlink key files and unsafe permissions are rejected. Keep the
wrapping key outside source control, and back it up separately from the database.
All replicas need the same wrapping key and access to the same attachment
storage. Ephemeral hosts must use a durable mount or managed secret.

On restart, the connector reloads the grant and protected key. A missing/wrong
wrapping key fails closed and reports setup needed. Restore the wrapping key or
approve the connection again with the original account encryption key. No
plaintext message/file payload or raw key is persisted for pending tool calls.

Each operation uses an expiring, narrowly scoped agent credential against the
configured application origin. Existing REST authorization handles ownership,
groups, shared peers, hidden/archive visibility, file quotas and delivery. Calls
never fetch a URL supplied by an incoming message and never follow credentialed
redirects. Credentials are revoked on completion and expire after two minutes.

Disconnect/OAuth revocation removes the protected keys, encrypted retry cache and
credentials. A five-minute maintenance task removes expired/revoked hosted grants
and retries older than seven days. Revocation is also checked before execution,
each downstream call and result delivery.

## File tools

1. Call `upload_attachment` with `fileName`, `contentType`, canonical `dataBase64`
   and a stable UUID `idempotencyId`. For a shared peer, include its `peerId` so
   the file uses that peer's separately approved key.
2. Add returned `attachmentId` values to `attachmentIds` on `send_message` or
   `send_peer_message`. Text is optional for an attachment-only message.
3. Inbox/history entries include metadata and `chatmcp://attachments/ID` resource
   URIs. Use `read_attachment` or `resources/read` to retrieve bytes. Reads are
   capped at 256 KiB; follow `nextOffset` until null to reconstruct a large file.
   Resource chunk URIs use `?offset=N&length=N`.

Any file type can be transferred: images, PDFs, text, office documents, audio,
video and arbitrary binary data. The connector returns original bytes, not a
claim that every AI client can interpret every format. Complete small supported
images also return native MCP image content. Files are never executed or fetched
from public links. General uploads can still be disabled by the existing operator
setting. Existing limits apply: 20 MB/file and ten retained attachments/account
by default, configurable through the attachment settings.

User and peer sends retain stable encrypted payloads for safe retries across
process restarts. Upload retries use stable IDs, serialized storage admission
and content checks. Confirmed uploads keep a small receipt rather than duplicate
large ciphertext in the retry table. If a retry record has expired, a conflicting
old ID is rejected; check the prior outcome before choosing a new ID.

## Verification

The Chromium fixture exercises both browser-only and hosted modes, closes the
browser in hosted mode, then sends/reads messages and files. It covers shared-key
setup, resource reads, larger binary chunks, permission denial, key removal and
retry after service reload. Agent API tests cover actual peer attachment links,
recipient downloads and revocation. Key-vault tests cover restart persistence,
identity binding, tampering, symlinks and unsafe permissions.

For a separate real-PostgreSQL, two-fresh-process check:

```sh
python3 tests/e2e/mcp-hosted-restart.py
```

This creates only temporary local fixtures. It checks migrations, encrypted
message/file recovery after process exit, stable retries and revoked-key cleanup.
Live client acceptance and deployment verification remain separate rollout gates.
The AI app controls scheduling and idle-app wakeups; an always-available MCP
endpoint does not itself resume a closed third-party conversation.

### Recorded results

The final combined focused run passed **162 tests across 13 suites**: MCP
OAuth/routes, public discovery, broker, key vault, Chromium messaging/files,
agent REST API, direct messages, external-agent pairing/files, user attachments,
browser worker, auth middleware, external bridge and external setup. The browser
fixture explicitly closes Chromium before hosted message/file calls and covers
2.2 MB binary chunk reconstruction, images, PDF resources, shared-peer key setup,
revocation and service reload. The temporary PostgreSQL fixture additionally
passed migration, fresh-process recovery and real shared-A2A permission checks,
including denied binary downloads after revocation. Syntax and targeted
whitespace checks passed.

The temporary fixtures use no real account, production database or provider
session. The connector was deployed on 2026-10-25 with migrations 061/062, durable
wrapping-key/file storage, verified off-site recovery backups, and a real HTTPS
browser-closed message/file/restart check. Acceptance in a particular AI client remains a separate check.

The resource and embedded-file responses follow the official
[MCP resource contract](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
and [MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
