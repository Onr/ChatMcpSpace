# Guest agent sharing requirements

Status: proposed feature; not implemented or deployed. This extends the
[sharing review](AGENT_SHARING_COLLABORATION_REVIEW_2026-10-02.md).
Implementation details: [build specification](AGENT_SHARING_BUILD_SPEC_2026-10-09.md),
with requirements and verification steps for the guest pilot and collaboration features.

## Product contract

An owner can share one agent or an explicitly selected set of their agents with
someone who has no account. The recipient opens a link, optionally enters a
password chosen by the owner, and uses the shared agents without registering,
verifying an email address, or unlocking the owner's account encryption.

The guest experience includes conversation, questions and answers, uploading
photos and files, viewing supported images, downloading uploaded files and agent
results, and interacting with supported HTML forms and rich content. Guest
sharing is a working conversation, not a read-only transcript.

Only the selected agents and their explicitly shared conversations and artifacts
are available. The owner's private history, other agents, account settings,
credentials and administrative controls are outside the share. Feature parity
means the full conversation experience within this boundary; it does not confer
ownership or account administration.

## Owner and recipient flows

1. The owner chooses **Share** on an agent, or selects several agents and chooses
   **Share selected agents**. Selecting all currently owned agents is supported;
   newly created agents are not automatically included later.
2. The owner chooses **Anyone with the link** or **Link and password**, sets the
   password if desired, and reviews the selected agents, conversation audience,
   history access and execution permissions. The owner may set an expiry.
3. The app creates a guest workspace link. The owner copies the link and sends
   the password separately. The share remains manageable from the owner's view.
4. The recipient opens the link and enters the password when required. A display
   name labels their messages; it is not a verified identity. No account is needed.
5. A single-agent share opens that conversation. A multi-agent share shows only
   the selected agents, each with its own conversation and attachments.
6. The owner can revoke the link, remove an individual guest session, remove an
   agent from the share, or replace the password. Revocation blocks subsequent
   API access and queued work; password replacement requires guests to unlock
   again. A recipient can leave and clear their local guest session.

Default to a new conversation for each guest and agent so unrelated recipients
do not see each other's uploads or messages. Offer a clearly labeled common room
when the owner wants recipients to collaborate. Show who can read the room,
including the owner. Existing shared history requires explicit owner selection;
private history is never included automatically.

A forwarded link (and password, when enabled) grants access to its holder.
Passwords restrict entry; they do not verify who the recipient is. Use separate
links for recipients when independent revocation matters.

## Implementation boundaries

### Scoped guest identity

Use dedicated guest principals and sessions. Never set the owner's `userId` on a
guest request, distribute the owner's API key, or turn a guest session into a
normal authenticated account session. General account and agent-management APIs
must reject guest credentials even when a guest is browsing while also signed in
to an unrelated account.

Model a share, its explicit agent allowlist, guest principals, guest sessions and
conversation grants. Resolve every requested agent, room, message, question,
attachment, download and rich-content action through the current grant. Hiding
navigation is not authorization. Do not accept an owner or sender identity from
request JSON. Guest names must be visibly distinguished from verified accounts.

Issue cryptographically random link secrets, store only their hashes, and redact
them from logs. Prefer a URL fragment exchanged through a POST for a scoped,
HttpOnly, Secure, SameSite session cookie; remove the fragment after exchange.
Apply CSRF protection to guest mutations and no-store caching to private guest
responses. Do not include credentials in download URLs or third-party referrals.

Store passwords using a salted password hash, never plaintext. Rate-limit unlock
attempts across application instances by share and client, cap expensive password
verification, and return generic unlock failures. Check expiry, revocation,
password revision and the current agent allowlist on every request, including
polling and downloads. Permission expansion must require an owner action.

### Encryption without an account

Guests need their own browser-generated identity keys and conversation-key
envelopes. The existing shared UI's account-key unlock flow cannot be reused as a
guest prerequisite. Never send the owner's account key or private identity key.

For the first guest pilot, an unlocked owner provisions a new guest's conversation
keys. Show an explicit waiting state until this completes; guests still do not need
an account. The first pilot does not promise first use while the owner is offline.
For later offline-first onboarding, design and review an invitation-key bootstrap:
an owner-created invitation key protected by a high-entropy link secret, with server-side password
verification controlling delivery of the encrypted bootstrap. Wrap only the
selected conversation keys, and establish a separate identity for each guest.
A common invitation secret must not allow separate guests to decrypt each other's rooms; resolve this explicitly
before shipping offline-first onboarding.
Do not derive all guest encryption solely from a human-chosen password or serve
plaintext conversation keys as a convenience fallback.

Key rotation must include remaining eligible guest identities and the runtime.
Revocation cannot erase already downloaded files or keys. Losing browser keys
requires an explicit rejoin/recovery flow without restoring revoked access.

### Files and interactive HTML

Reuse the encrypted attachment format and established size/retention limits.
Check scope before accepting upload bytes or returning downloads. Bind artifact
IDs to the authorized conversation and validate references when sending messages;
knowing another file's ID must not grant access. Allow supported raster previews
and downloads of permitted files, including agent-generated results.

Reuse the existing rich-content schema and sanitization behavior. Shared chats
currently render text and image/file controls; they do not yet invoke the rich
renderer. Integrate that renderer explicitly and route form submissions through
the guest conversation API, preserving question, reply and sender attribution.
Do not call owner-only dashboard handlers. Supported interactive HTML must work
without granting arbitrary scripts access to app sessions, keys, other rooms or
account APIs. Preserve the existing sanitizer's script/event-handler restrictions.

### Agent execution

Apply the sharing review's execution-grant rules to guest work as well as account
members. Restricting a web session to one agent does not restrict that agent's
filesystem or tool authority. Carry guest ID, share ID, agent ID, room ID and the
current grant revision through queuing, execution and artifact publication.
Recheck grants before claiming queued work and before protected actions. Preserve
the owner's private capabilities separately. An active tool that cannot be stopped
must be reported honestly after revocation; do not promise rollback of completed
external effects.

## Acceptance criteria

- In a fresh browser with no account, open a single-agent link, chat, answer a
  question, upload a photo and a document, view the photo, download both uploads
  and generated results, and submit a supported interactive HTML form.
- Repeat with several selected agents; switch agents without mixing histories,
  files or interactive form destinations. New owner agents remain unshared.
- A protected share reveals no agent names, messages or files before successful
  unlock. Wrong passwords and repeated attempts are rejected and rate-limited.
- Changing agent, room, message, question or file IDs cannot access another share,
  another guest's separate conversation, an unselected agent or private history.
- Guest sessions cannot reach account settings, credentials, agent creation,
  deletion, global controls, member administration or owner APIs.
- Link revocation, expiry, guest removal, agent removal and password replacement
  invalidate existing access as specified, including bookmarked downloads and
  polling. Revoked queued work is never claimed.
- Rich HTML cannot read sessions or encryption keys, execute injected handlers,
  impersonate an owner, or submit into another conversation.
- Refresh, reconnect and retry retain attribution without duplicate execution.
  Missing encryption keys produce a clear recovery state, never plaintext fallback.
- Test desktop and mobile keyboard flows, offline agents, file limits and expired
  sessions. Verify with a real runtime in addition to simulated API responses.

## Delivery order

Build guest principals and grant enforcement first, then password/link sessions
and key onboarding, then the owner sharing UI and guest workspace. Complete
attachment and rich-content parity and adversarial integration tests before
enabling guest links. Gate rollout on the execution boundaries from the sharing
review; do not label a conversation-only boundary as machine isolation.

The main roadmap schedules guest access in phases 3–4 and the verified pilot in
phase 5. Follow S01–S16 in the implementation plan for the full first guest release.
Offline-first encryption bootstrap is L01, not a prerequisite for the owner-online
pilot. Photos, files, downloads, multi-agent selection, optional passwords and
supported interactive HTML are all first-pilot requirements.
