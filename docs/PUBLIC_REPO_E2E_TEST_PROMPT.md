You are the end-to-end test agent for the public ChatMcpSpace repository, running on a machine separate from the developer's server. The developer cannot see your terminal; everything they learn comes from your final report. This brief is reusable: when you receive it again, start a new round, reuse healthy setup from earlier rounds and compare results with the previous round. Do the work, not just a plan.

GOAL
Prove, on this machine only, that a fresh user can: clone the public repo, run a local server, register, connect a real agent to that local server, see the agent receive and answer messages in the localhost UI, and share that agent with (a) a second registered account and (b) a guest link, with replies reaching each recipient and revocation blocking access. Also run the repo's own sharing checks. Visually inspect every step with screenshots.

HARD RULES
- Test only against localhost. Never call chatmcp.space or any production server from the agent you set up, never deploy, push, merge, open PRs, or change production.
- You are probably connected to chatmcp.space yourself. Keep your own identity out of the test: start the local server and local agent in a CLEAN environment (env -i or a fresh shell with only PATH/HOME/LANG), never reuse your own API key, CHATSPACE_* variables or state files, and never start a second listener under your own identity. Before the local agent sends anything, print its configured base URL (secrets redacted) and confirm it is http://localhost:<port>. If it is not, stop and report.
- Synthetic data and throwaway accounts only (for example owner-<round>@example.test). No real secrets in screenshots or reports.
- Installing normal developer packages (Node 22+, PostgreSQL, Redis, ripgrep, Playwright/Chromium) is allowed on a test or developer machine. Do not run destructive repairs, reboot, disable security features, or delete anything you did not create. If a prerequisite is missing and you cannot install it, mark affected cases BLOCKED and continue with the rest.
- Use free ports. 3000, 5432 and 6379 may already be in use; detect and pick free ones, and never stop services you did not start.
- Windows: run the server in WSL2 (Ubuntu) if available. If only native Windows is available, try it, and record exactly where it fails. `npm run test:sharing` is Linux-only.

REPEATABLE WORKSPACE
- Base directory: ~/chatmcp-public-e2e/ (create if missing). Keep one clone at ~/chatmcp-public-e2e/repo, reused across rounds.
- Each round: create rounds/<UTC yyyymmddThhmmssZ>-<6 random hex>/ and write its id to rounds/LATEST after finishing. Record the previous round id.
- Clone https://github.com/Onr/ChatMcpSpace.git (or `git fetch` an existing clone), then check out the commit named in the TEST_COMMIT line at the top of this message; use origin/main if it says latest or there is no TEST_COMMIT line. Record the exact HEAD SHA. Do not edit tracked files; if a fix is needed to proceed, put it in the round directory as a patch and report it separately.
- Fresh database per round: chatmcp_e2e_<round short id>. Fresh .env per round (copied from .env.example). Keep a manifest of every process, port, database and directory the round created, and clean up only those at the end. Keep reports, screenshots and logs.

SETUP (record every command and exit code)
1. Machine facts: OS, kernel, arch, Node/npm, PostgreSQL, Redis versions, free disk/RAM.
2. `npm ci` (or `npm install` if no lockfile). Record any vulnerability, deprecation or audit warnings verbatim.
3. Database: create the round database. Follow the README (`psql -f src/db/schema.sql`) and also note whether the server's startup migration runner applies migrations (check startup logs; record the highest migration applied). Report any conflict between the README and actual behaviour.
4. .env: set DB_*, REDIS_URL, PORT, BASE_URL=http://localhost:<port>, a random SESSION_SECRET, LOCAL_MODE=true, FEATURE_SHARED_CONVERSATIONS=true, FEATURE_GUEST_SHARING=true. Note: .env.example ships both sharing flags false while docs/SHARED_CONVERSATIONS.md says the example enables sharing; report whether that is still true.
5. Start the server (`npm start` or `./scripts/start_app.sh --local`), wait for HTTP 200 on /, capture the first 200 lines of the log.

BASELINE CHECKS
6. `npm run test:receipts` and, on Linux, `npm run test:sharing`. Expected final lines include `APPLICATION CHECKS: PASS` and `TRUSTED SHARING CHECKS: PASS`. Record the tail of each output.

END-TO-END CASES (Playwright with Chromium, separate browser contexts per person; screenshot each step at 1280px and 390px wide; save as NN-<step>-<width>.png)
A. Owner signup: register owner at /register (local mode, no email), land on dashboard, set/unlock the encryption password if asked.
B. Connect an agent: from /settings copy the localhost setup command (the `/setup` script) and run it in a new empty project directory, in the clean environment. Give the agent a name like e2e-agent-<round>. Use a real provider CLI that is already installed and logged in on this machine (claude, codex, gemini...). If none is available, write a tiny scripted responder that uses the generated message_helper/runner to reply "e2e-echo: <message>", and mark provider-dependent results PLUMBING-ONLY. Confirm the agent appears online in the dashboard and that its runner enrolled trusted sharing (look for /api/agent/sharing-status and the enroll step in its log; Node 22+ required).
C. Private chat: owner sends "ping <round>"; verify in the UI that the message shows sent/read receipts and the agent's reply appears without a page reload. Also ask the agent to send a question with options; answer it in the UI and confirm the agent receives the answer.
D. Share with a registered user: register a second account (member) in a separate browser context. Owner opens the agent, chooses Share, invites the member by email as Collaborator. Member accepts. Keep the owner page open and unlocked until pending access clears. Member sends a message in the shared conversation; confirm the agent receives it attributed to the member and its reply appears in BOTH the member's and owner's views. Confirm the member cannot see the owner's private conversation or other agents.
E. Guest link without password: owner creates a guest link (Share with guests). Open it in a fresh incognito context, set a display name, send a message, confirm the reply appears for the guest. Upload a small synthetic image and confirm the preview.
F. Guest link with password: create a password link; wrong password is rejected, right password works. Refresh the guest page and confirm the conversation and keys survive.
G. Revocation: remove one guest session, then revoke a link; confirm the guest gets an access-denied state and further messages are not delivered. Remove the member from the shared chat and confirm they lose access.
H. Visual review: look at your screenshots and list any layout, contrast, overflow, broken icon, or confusing-step problems (especially mobile 390px), with the screenshot filename.

Mark each of 1-6 and A-H as PASS, FAIL, BLOCKED, UNVERIFIED or PLUMBING-ONLY. Never infer a PASS you did not observe. For each FAIL give exact reproduction steps, expected vs actual, log excerpt and screenshot name.

CLEANUP
Stop only the processes you started, drop only the round database, free the ports you used. Leave the clone, installed tools and the round directory. Report anything you could not clean up.

REPORT
Write report.md and report.json in the round directory, then post this envelope in your own conversation so the human sees it, and DM it to the agent named in REPLY_TO (if the brief was pasted by a human, reply to them). Attach the key screenshots and report.md if your tools support attachments; otherwise list their paths.

BEGIN_PUBLIC_E2E_REPORT
round_id; previous_round_id; repo_commit; tested_at_utc
machine: OS/kernel/arch, Node, PostgreSQL, Redis, provider CLI used (or scripted responder)
setup: each step 1-5 with status, command, exit code, notes (migrations applied, doc conflicts)
baseline: test:receipts and test:sharing status and final lines
cases: A-H each with status, observed result, evidence filenames
findings: severity (critical/high/medium/low), title, reproduction, expected vs actual, suggested fix
warnings: npm audit / deprecation / security warnings seen, verbatim summary
visual: UI issues with screenshot names
cleanup: removed / retained / uncertain
comparison: what changed versus previous_round_id (or "first round")
next_action: the single most useful fix or retest for the developer
END_PUBLIC_E2E_REPORT
