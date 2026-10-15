# Selected-provider fixture preflight

This packet inspects the exact synthetic project files approved by the owner.
It does not install or launch Codex, contact a model/provider, build or pull an
image, change network/core/mount policy, enable sharing or deploy anything.
It does not inspect the laptop or any authentication store.

The owner selected `notes-onro-1` and authorized a new invented fixture in the
dedicated VM at `/home/ubuntu/agent-sharing-projects/notes-onro-1-compat`.
The remote agent prepared `example-garden.md` (214 bytes) and
`example-observatory.md` (218 bytes). A developer read-only SSH inspection
confirmed UID/GID1000, directory0700/files0600, canonical path, exact file set,
regular files without extra links, bounded stable reads and their fixed SHA-256
values. The manifest pins those actual files; the older repository's invented
README/meeting proposal is a separate fixture and was not copied here.

## Run scope

Run only on the retained dedicated Linux VM as its ordinary UID/GID1000 account.
Verify the received archive length/hash and every artifact-manifest entry before
using it. Preserve its source commit and original manifests. Do not replace a
manifest hash or adjust permissions/files to turn a failed inspection into a pass.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 inspect-provider-fixture.py notes-fixture-manifest.json
```

Exit0 with `fixtureVerified:true` records one stable file snapshot against the
reviewed manifest. `agentExecuted`, `compatibilityReady` and `releaseReady` are
always false. Exit2 means inspection failed; retain evidence and report the
prerequisite instead of changing the workspace. No file contents are printed.
Reads can update filesystem access times; file data and configuration are not
written. This finite observation is not proof against later owner-side mutation
or permission to run an agent on the project.

## Actual runtime remains blocked

The laptop agent reportedly uses Codex CLI0.160.1, target
`x86_64-unknown-linux-musl`. The VM has no established Codex installation or
actual-runtime image. The proposed built-in OpenAI provider and fixed
`gpt-6.1-sol` model have not been applied. OpenAI's
[model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
documents that model; a catalog entry does not verify a test account's access.

A complete actual-agent packet needs a digest-pinned reviewed runtime, an
owner-selected test authentication mechanism and approved request/billing scope,
and a tested provider boundary retaining credentials outside task-readable
files/environment. Keep the executor's network-none/seccomp/mount policy.
Codex's proposed workspace-write/never flags alone do not supply that boundary.
Do not copy a login store, inject owner/connector credentials into task code,
change to unrestricted networking, or substitute a host CLI.

OpenAI documents [CLI authentication](https://learn.chatgpt.com/docs/auth) and
[credential separation for sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/security).
The app-server's [dynamic tool interface](https://learn.chatgpt.com/docs/app-server)
does not establish that every tool is routed through this application's grant
checks. Its behavior must be reviewed and verified for the pinned client version
before integration, including denial of built-in/unapproved actions.

The actual compatibility execution packet is not ready yet. S06 actual-provider
compatibility, S07 and S16-S18 remain open; guest sharing stays disabled.
L01-L03 remain deferred.
