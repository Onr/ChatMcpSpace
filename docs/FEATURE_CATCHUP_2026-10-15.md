# Conversation and settings improvements — October 15, 2026

## Chat and Council Chamber

- Use the reply arrow on a message to quote it in the composer. Cancel the quote
  with ×. Sent replies keep their reference after a refresh; click the quote to
  jump to an original that is loaded in the transcript.
- Shared reply previews resolve from the reader's visible history. Replying to a
  restricted message does not copy its text into an everyone-visible payload.
  Deleted or unloaded originals show an unavailable placeholder.
- Reply drafts stay with their conversation. Failed sends retain the draft;
  recovery of a previous outbox message preserves a newer reply selection.
- Drop an agent onto a Council Chamber group to add it. Existing memberships
  remain intact. Empty groups are visible drop targets. Sidebar group headers
  accept agent drops too. A failed request leaves memberships unchanged.
- The agent-name menu stays above messages. Button hover and send transitions
  use short visual effects and respect reduced-motion preferences.

## Settings

- Usage starts folded. Per-agent rows expand individually inside a scrollable
  area, keeping the rest of Settings reachable.
- Copy MCP address copies the public `/mcp` URL without including an API key.
  A selection fallback is available when clipboard access is unavailable.
- Pi joins Hermes, OpenClaw, and compatible agents in the setup selector.
  Its request directs setup through the existing native Pi provider runner.

## Permissions

CLI permission setup now saves an explicit owner grant to the server and local
runtime files. Subsequent dashboard saves cannot replace it with the previous
server ceiling. The grant endpoint requires the owner's API key and rejects
scoped runtime credentials. Ordinary dashboard choices remain bounded by the
owner's ceiling. Codex workspace mode opens the configured project root too.

## Model discovery

- A server job refreshes the public OpenRouter catalog every three hours and
  preserves the previous catalog when a request fails. Newly discovered native
  IDs are marked **New, untested**. Antigravity IDs are never guessed.
- Native metadata discovery covers Codex's model catalog, Claude's SDK control
  initialization, Copilot's `models.list` interface, Gemini's API or installed CLI catalog,
  and existing Antigravity, Pi, Kilo, API, and local-server model sources.
- Discovery sends no inference prompt, runs no agent tools, and does not start a
  login flow. A CLI-listed model means the tool advertises it; it does not prove
  an inference request will succeed for every account.
- Older Gemini CLI versions do not expose an OAuth model roster. Their bundled
  model names can be read without an API key or a login flow; new names from
  that source remain unconfirmed.
- The shared managed listener refreshes metadata in the background every three
  hours. An unavailable CLI or unsupported discovery interface leaves existing
  choices intact. Model dropdown caches refresh after five minutes.

Generated CLI version: **1.5.11**. Existing installations receive generated
runner changes through their normal update flow.

## Validation

The full Jest run passed 114 suites and 1,668 tests, with 51 tests skipped.
One existing process-lock test exceeded its timeout while browser checks were
running; its complete 39-test suite passed in an isolated rerun. Follow-up
checks passed all 151 model-discovery and generated-runner tests. All six
Chromium checks passed, covering mobile and desktop menu layering, Settings,
quoted replies, and an actual pointer drag into a Council Chamber group.

After restarting the application and managed listener, the live server returned
the updated reply script and accepted the explicit owner permission grant. Its
model API returned the refreshed public catalog and untested model labels.

Implementation references: [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
[Copilot SDK](https://github.com/github/copilot-sdk),
[Pi](https://github.com/earendil-works/pi), and
[OpenRouter model listing](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
