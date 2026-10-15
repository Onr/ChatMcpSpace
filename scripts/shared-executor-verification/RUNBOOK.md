# Round 8: retained dedicated VM only

Review `developer-review.md`, `verification-round.json`, every emitted patch and
complete adapted driver before execution. This packet is diagnostic executor
verification, not permission to enable guest sharing or deploy. No developer
machine access is required for manual verification. Authorized direct SSH is
limited to the retained guest, using its pinned host key and ordinary account.
Do not install packages/Podman on the laptop, weaken global protections,
access production, send credentials, push/merge or send
external messages. Preserve old rounds and this immutable source.

On the laptop, verify the archive's supplied byte length/SHA-256 before safe
extraction. Reject traversal, duplicate/absolute names, links/special files, more
than 256 members or more than 16 MiB expanded bytes. Verify every manifest entry
and the source metadata before copying into the retained VM. Do not run any
engine harness on the laptop or receiving developer computer. The laptop should
remain online while its single-use Wormhole transfer is active.

Use the existing ordinary UID1000 guest, Node22, rootless Podman4.9.3/overlay,
delegated cgroup v2, and retained pinned diagnostic image. Do not pull mutable
images. Record versions, virt/ownership/controller/engine/image identity and
disk/RAM before and after. If the guest needs repair, stop and record the exact
prerequisite; do not substitute rootful execution or weaken policy.

Create a fresh private guest round directory with this packet's root files,
`originals/` and `patches/`. All adapted drivers and the recorder must be beside
`verification-round.json`, `restrictedExecutor.js` and `protocol.js`.
Create an empty mode0700 `evidence/` directory. Require at least 128 MiB disposable
disk plus 24 MiB tmpfs RAM. Take an exclusive round-driver lock in this directory;
only one driver may run at a time. Do not reuse prior fixture directories. Retain
each driver's stdout/stderr and actual exit, even when a later targeted run passes.
The workspace worker is a separate file and joins the live parent's private lock;
it does not import the executor or open driver logs. Preserve its stderr and exact
exit. Readiness and completion documents are published atomically, and parent
cleanup includes failures before readiness. The remote-default test restores
the prior HOME value in finally, including probe/task failures.

With scoped guest sudo only, set `/etc/agent-sharing-verification-guest` to this
packet's roundId and create a **fresh dedicated** output tmpfs at most24MiB and
256inodes, UID/GID1000 mode0700 nosuid,nodev,noexec. Record exact mountpoint,
findmnt/stat/statfs identity before use. Require noninteractive sudo; if unavailable,
report the prerequisite rather than requesting passwords. No host mounts.

When this source includes executorHostPolicy.js, verify its manifest hash before
loading the module. It refuses piped host core handlers, since they ignore core
limits and start outside task namespaces/cgroups. First record that refusal under
the original VM policy. Only on this dedicated disposable guest, a scoped operator
may temporarily select a non-piped core-file pattern for verification. Preserve the
original bytes/hash in a root-owned private receipt; change no crash service,
package, permanent config, network/seccomp or CPU/memory/PID limit. Record the
temporary policy, actual zero soft/hard task core limits and any crash collectors.
Restore the original pattern only after exact task absence and stopped-writer
proof. Refuse to overwrite an unexpected concurrent policy change. Retain receipt
and any uncertainty. This is executor prerequisite setup, not a timing-budget
exception or permission to change the laptop/production host. A core-size limit
alone does not meet the boundary while a host pipe remains configured.

Set the environment in the ordinary guest shell, using the actual fresh directory
as `verification_dir` and the actual dedicated mount as `verification_store`:

```bash
cd "$verification_dir"
export AGENT_SHARING_GUEST_READY="$(node -p 'require("./verification-round.json").roundId')"
export AGENT_SHARING_EXPECTED_SOURCE="$(node -p 'require("./verification-round.json").sourceSha256')"
export AGENT_SHARING_ROUND_DIR="$PWD"
export AGENT_SHARING_EXECUTOR="$PWD/restrictedExecutor.js"
export AGENT_SHARING_CONSUMER="$PWD/consumer-reference.js"
export AGENT_SHARING_OUTPUT_STORE="$verification_store"
export PODMAN_PATH="$PWD/podman-phase-recorder.js"
export AGENT_SHARING_IMAGE='docker.io/library/node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c'
```

Verify exact source length/hash before **any** require/engine invocation, including
targeted drivers. Retain `/etc` marker evidence. Syntax-check all drivers. File
hash verification and syntax checks are not runtime passes. The recorder verifies
the guest marker and forwards actual argv/stdin/environment unchanged to
`/usr/bin/podman`. Its helper/protocol imports must be present. It saves complete
bounded control outputs in the same evidence directory as the driver.

Run sequentially, capturing each complete stdout/stderr and exit separately:

```bash
timeout --signal=TERM --kill-after=10s 1200s node --max-old-space-size=128 executor-verification-harness-r8.js
timeout --signal=TERM --kill-after=10s 1200s node --max-old-space-size=128 round8-additional-harness.js
timeout --signal=TERM --kill-after=10s 300s node workspace-bind-audit-r8.js
timeout --signal=TERM --kill-after=10s 300s node task-mount-race-r8.js
timeout --signal=TERM --kill-after=10s 120s node task-files-targeted-r8.js
timeout --signal=TERM --kill-after=5s 60s node --max-old-space-size=128 task-file-limits-r8.js
python3 tmpfs-exhaustion-r8.py
node policy-path-harness-r8.js "$AGENT_SHARING_EXECUTOR"
node --expose-gc --max-old-space-size=128 consumer-only-harness.js
timeout --signal=TERM --kill-after=10s 300s node query-error-audit-r8.js
timeout --signal=TERM --kill-after=10s 1200s node --max-old-space-size=128 round8-additional-harness.js fault
```

The original 180-child workload, 10,000ms budget, pids128, CPU1 and memory512MiB
must remain unchanged in all three repeats. Preserve failed repeats. The optimized
source has one combined unshare helper; the parent still validates full OCI and
effective identities plus final state. Record probe, create-to-start, actual task
CPU/PID denial and cleanup timings. Observer initialization now uses the already
saved exact-ID inspection and exact PID/starttime before its live Podman query,
reducing repeated control CLI activity during startup. Do not claim live evidence
from initialized state alone.

Both main and additional workload samplers retain partial `ENOENT`/`ENODEV`
observations when a cgroup disappears during teardown. The observation records
which file ended sampling; it never establishes writer stoppage or enforcement.
Required live-limit, CPU/PID/OOM evidence, original workload results and final
exact-ID/process/cgroup absence checks must still pass independently. Other read
errors fail. Earlier rounds aborted by sampler errors remain recorded as failures.

Create/after, init/after and start/before cancellations require complete atomic
ready documents and a recorded abort before barrier release. Keep stack/phase
evidence on any failure. The original four-second timeout stays unchanged and is
reported independently from the new ten-second live-marker positive control. A
pass for the latter never rewrites a blocked/failed original case. Keep the real
configuration-query failure, retained paths and quarantine check separate from
ordinary cancellation/absence tests. Case6 also needs independent CPU enforcement;
if the combined main check aborts before it, run a separately recorded bounded CPU
subcase using the existing reviewed workload, with live cgroup measurements.
Consumer-only checks are real filesystem tests on the guest, independent of task
execution. Record their stdout report as evidence and keep their scope separate.

Use `cleanupTaskFiles` only after every create linked to its exact mounted paths
returned a valid immutable ID and real silent absence was established. Never
delete output-store entries by prefix, delete arbitrary names/IDs, follow archive
symlinks, or remove uncertain paths. A failed/unknown create must preserve paths
and evidence. Record exact configuration-directory inode/owner before inducing an
engine fault; operator recovery must compare that identity before removal.
Do not clear persistent runner receipts or pretend this module proves recovery.

At end, independently inspect every recorded exact container ID and late-start
interval, its PID/starttime and cgroup descendants. Preserve uncertainty and report
it. Restore only round-owned configuration faults, confirm exact absence, then
remove owned fixture/staging paths using recorded identity. Confirm the exact
output store is empty before scoped unmount and check its underlying empty owned
directory before removal. Preserve guest/tools/image and all original reports.
Confirm laptop Docker baseline IDs/services were unchanged.

Return complete reports, raw evidence, all complete final drivers/patches and
source hashes in a bounded sanitized archive with manifest and SHA-256. Do not
include symlinks, genuine secrets, cookies or Wormhole codes. Publish a fresh
two-hour single-use Wormhole sender and return its private code, archive length
and hash so the developer agent can receive it itself. Keep the laptop online.

Use the established `BEGIN_AGENT_SHARING_REPORT` / `END_AGENT_SHARING_REPORT`
envelope with round_id/previous_round_id, exact source commit/hash, machine/image,
all eight statuses and per-subcase commands/exits/evidence, findings, warnings,
cleanup/uncertainty, artifacts, limitations and next action. Overall PASS requires
the actual original assertions and release gates; do not count mocks, syntax,
targeted retests or unavailable CPU/provider/application checks as those passes.
Read every required result record as well as the driver exit. The main driver
requires 13 PASS records, the additional driver requires 18, and its fault mode
requires one. Missing, malformed, extra, BLOCKED, SKIPPED or UNVERIFIED records
must yield a nonzero exit. A longer timeout positive control does not replace
the original four-second timeout liveness assertion. Preserve original runs and
hash separately any verifier repair; do not relabel an earlier exit-zero run.

The public-runner component kit is prepared separately with:

```bash
python3 scripts/shared-executor-verification/prepare-runner-component.py \
  --destination /path/to/new-private-component-kit \
  --previous-round PREVIOUS_ROUND_ID
```

The builder uses committed runtime sources in a disposable private checkout and
never reads bridge state or credentials. It emits the exact public bundle,
complete fixed fixture, reference crypto/bridge code, metadata and a hash manifest.
Apply the same VM-only preflight, scoped core-policy receipt, dedicated bounded
output mount and ordinary-user environment rules before running its
`runner-integration.js`. Drivers run sequentially; never reuse a running round's
marker or store. The command is
`timeout --signal=TERM --kill-after=10s 300s node --max-old-space-size=128 runner-integration.js`.
This checks actual bundle execution, encrypted text/photo input, verified output
bytes, typed guest questions, encrypted journal reload and rekey delivery with
exactly one real task. The API is a fixture and journal reload uses a fresh runner
instance in the same driver process; it is not a live-server authorization or
OS-process restart pass. Its30s component budget does not replace the original4s
timeout or10s PID gates. Independently verify exact-ID/PID/cgroup absence and
store/policy restoration afterward. Exclude `runner-fixture/private` from every
archive: it holds newly generated test crypto state. Preserve failures and source
hashes; do not enable guest sharing based on this component result.

For the separate OS-process restart scope, use a fresh kit/round/store and append
`--process-restart` to that command. The complete `runner-process.js` is included
and hashed by the builder. The real public runner runs in a child belonging to
the live driver lock, with the API fixture served over IPC. The driver kills
that runner with SIGKILL only after the encrypted ready journal is persisted
and the task has completed; a different OS process reads the on-disk journal
and sends its verified bytes after key rotation. Both runner PID/start identities,
SIGKILL/normal exits and exactly one actual task creation must be recorded.
This establishes delivery recovery after a runner crash at that point; it is
not a live server, in-flight action replay, revocation, power-loss or model/provider
pass. Independent cleanup must additionally check both runner identities stopped.
Generated crypto state remains excluded from archives in both modes. Never
replace a failed full-round timing or authorization gate with this component.

Barrier readers wait for the publisher's temporary hardlink to be removed before
reading. Bounds, no-follow opens and all size/mtime/ctime checks still apply; a
changed or malformed complete document fails instead of being retried as success.
Missing/dying cgroup files end a sample with an explicit partial-evidence record.
That record is not stoppage or enforcement proof: live positives, original task
results and independent exact-ID/PID/cgroup absence assertions remain required.
