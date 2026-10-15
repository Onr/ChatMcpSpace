# Check agent sharing

Run this from the project directory on Linux:

```bash
npm run test:sharing
```

The command needs the project's Node dependencies, PostgreSQL server binaries,
`timeout` and `rg` already installed. Run it as your ordinary user. It prepares
temporary Chromium if necessary, creates a private
test database without a TCP listener, and removes its temporary services afterward.
It does not use your application database URL, enable production sharing or call
an AI provider. If a prerequisite is missing, it reports it and stops.

For a quick receipt regression check without a browser or PostgreSQL server, run
`npm run test:receipts`. These Jest tests also run with the ordinary `npm test`
suite. They cover the single sending check, gray server double checks, blue
agent-read double checks, owner/member and guest updates, native acknowledgement
ordering, failed optional requests and preservation of mobile scroll and drafts.

The `Sharing regressions` GitHub Actions workflow runs both commands on pushes
and pull requests once the workflow is committed and pushed. The full command
creates its own PostgreSQL database so receipt authorization tests cannot be
silently skipped for a missing test database, and compares actual check colors
in owner/member and guest browsers before a reply. Browser failure screenshots
are retained in the workflow artifacts for seven days.

Expected result: `APPLICATION CHECKS: PASS`. The command checks:

- Current grant/device scope and concurrent revocation or expiry.
- Bound action approvals, cancellation states, held results, queue limits and fair admissions.
- Broker denial, exact launch digests, lost start replies, retained receipt recovery and staged input integrity.
- Guest encryption keys surviving refresh while staying non-exportable.
- An owner selecting two agents and provisioning guest access.
- Two guests joining without accounts, with separate conversations.
- Photo previews, uploads/downloads, questions and interactive forms.
- Denial of another guest's room, unselected agents and unsafe rich content.
- Retry after key rotation, removal of one guest and revocation of the link.
- The registered-friend conversation flow.
- Sharing from a mobile dashboard with an expired CSRF token: automatic refresh,
  an editable email field, preserved draft and successful sharing.
- Owner and guest mobile layouts, retained drafts and scoped execution-permission controls.
- Screenshot comparisons for shared-chat cards at 390, 688 and 1280 pixels,
  readable long names, bounded scrolling and separate Leave controls.
- Opening a shared chat after dashboard refresh, including closing the mobile
  list when selecting the conversation already on screen.

These checks use synthetic data and local test servers. A real subprocess
receives an attributed guest message and returns an encrypted reply through the
application service. Provider-specific subprocess fixtures check selected models
without calling a paid provider. Expected final line: `TRUSTED SHARING CHECKS: PASS`.
Trusted sharing uses the owner's normal tools and permissions. Restricted
container/MCP conformance remains a separate optional mode.

The private disposable PostgreSQL cluster disables disk durability for speed;
this command makes no power-loss or database-durability claim. Browser coverage
is Chromium only. Redis rate limiting and the full regression are separate checks.

To verify it yourself:

1. Open an existing agent's regular conversation as owner. Press **Share** in the
   header or the agent-icon menu. After sharing, the people icon/count opens the
   same controls. The email field accepts typing while the preview loads. If a
   connection error occurs, press **Try again** in the panel; your email stays
   filled in. Expired CSRF tokens refresh automatically.
2. Unlock your account locally using your **account encryption password**. Keep
   the panel open through preparation, then send an account invitation or create
   and copy a guest link. If you set a **Guest access code**, send that code with
   the link. Invitees never need your account encryption password.
3. Open the invitation in another browser profile. Check the inviter and agent
   name, choose **Join chat**, and wait for encrypted access. Keep the owner's
   dashboard open and unlocked during admission; it provisions access automatically.
   If the guest is waiting, the owner's dashboard shows an access setup notice.
   Choose **Unlock locally**, enter the owner's account encryption password
   there, and leave the guest page open. Access should activate automatically
   without reselecting the shared conversation. A **Retry access setup** button
   is available if setup fails. Already admitted participants do not need the
   owner to remain online to send messages; agent execution still needs its runtime.
   The joined chat appears under **Shared with you** as an agent card. Tap the
   card to open the ordinary conversation. On a phone, this closes the chat list
   so the messages are visible, including when that chat was already selected.
4. Send a guest message and confirm it appears in the owner's same regular chat.
   Send an owner reply, upload/download a photo or file, answer a question, and
   submit an interactive form. Switch away from the chat and return on both sides;
   its transcript and draft should belong to that conversation.
   The owner also sees earlier private history marked **Owner only · private
   history**. Invitees cannot see those original private rows; history explicitly
   included when sharing remains shared. Imported copies should appear once.
   During an upload, repeated Send taps should produce one message and one file.
   If an earlier request has an uncertain outcome, the owner sees recovery
   controls: **Skip earlier request** continues with queued messages; **Retry
   earlier request** may repeat actions the earlier attempt performed.
5. Ask the agent for an owner-only reply, a reply to the owner plus one selected
   guest, and a reply to everyone. The owner should receive every reply. Guests
   should receive only the replies whose audience includes them.
   All three replies and guest messages stay together in the owner's regular
   conversation. Audience badges show **Owner only**, **Owner + names**, or
   **Everyone** with icons and distinct colours. Guest messages show **Guest ·
   name** and a blue accent. Earlier private history keeps its owner-only label.
6. On a phone-sized screen, open the chat list, switch conversations and return.
   The composer and Send button should remain reachable. In a conversation with
   earlier messages, scroll to the top to retrieve them automatically. The viewport
   should stay on the same message while an earlier page is prepended.
   The selected chat should show its name and loading state immediately. Shared
   messages should appear while earlier private history loads separately; that
   history remains labelled owner-only. Opening the list during loading must
   leave it open until you close it or select a chat. If a connection stalls,
   choose **Try again**; a failed private-history request has its own retry button.
7. Remove one guest, replace or disable the guest link, and check the affected
   participant loses access and gets the correct rejoin guidance.

If a message is visible but the agent does not reply, confirm the selected
provider is installed, signed in and enabled in the agent's local permission
settings. Switching the model in the browser does not install or authenticate
that connection. AgentsMCPspace's Claude connection was configured and verified
with live replies; see the [reply delivery report](AGENT_REPLY_DELIVERY_FIXES_2026-10-12.md).

Message checks show **one gray check** while sending, **two gray checks** after
server storage and **two blue checks** after the agent acknowledges decrypted
input. The blue state can appear before a reply. Another participant reading
the chat does not trigger it. Send a short message and watch the checks change
without reopening the conversation; your draft and scroll position should stay
in place. See the [receipt regression details](MESSAGE_RECEIPTS_2026-10-13.md).

The legacy account-free browser fixture also covers separate guest rooms. Normal
in-place sharing uses the owner's existing conversation for every invitee.

Both sharing flags are enabled for this workspace after the automated checks.
The running server must load those flags, and agents must run the regenerated
shared-capable listener. See the [trusted sharing verification report](TRUSTED_AGENT_SHARING_VERIFICATION.md)
for the observed service state and remaining per-agent setup.
