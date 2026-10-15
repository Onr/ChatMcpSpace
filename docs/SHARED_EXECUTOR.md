# Shared executor boundary

S06 uses a rootless Podman adapter as the reference executor. The adapter is
fail-closed: guest or protocol-2 work cannot fall back to a host shell, the
existing provider runner, Docker-in-Docker, or an unrestricted subprocess.

The operator must provision a pinned image and a rootless Podman 4.9.3 service
with overlay storage on Linux x86_64. Other architectures, versions/storage drivers fail closed until their
complete initialized mount contract is reviewed and tested. The
adapter checks both `podman info` rootless status and local image availability
before each run. Every engine invocation explicitly passes the global
`--remote=false` option, including probes, execution and forced removal. Filtering
remote environment variables alone does not override a remote default in user
configuration. Actual configuration precedence still needs the real-engine gate.
It starts a fresh container with:

- no network (`--network=none`);
- a read-only root filesystem and a private `tmpfs` for `/tmp`;
- all Linux capabilities dropped and `no-new-privileges`;
- bounded PIDs, memory, CPU and output;
- one approved workspace mounted at `/workspace`;
- no host home directory, credential directory, provider socket or container
  control socket;
- an explicit allowlist for non-secret environment variables only.

The adapter also supplies `src/shared/restricted-seccomp.json` from its private
mode-0700 engine directory and checks the complete initialized filter before
startup. This pins default syscall denial rather than inheriting host defaults.
It retains the no-capability Podman 4.9.3 filter, narrows socket creation to
isolated IP/netlink families, denies the audit netlink protocol, and admits only
the native x86_64 ABI. Unix, packet, crypto and host-vsock socket creation is
denied; `socketpair` remains available for local subprocess pipes and IPC.
Multiplexed compatibility syscalls and io_uring have no allow rule.

An actual VM audit of the preceding source reached a fake host listener through
a pathname Unix socket in `/workspace` under `--network=none`. Network namespaces
isolate the abstract Unix namespace, while a pathname socket is reached through
its filesystem name ([network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html),
[unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html)). Checking the workspace
for sockets once would not prevent a later replacement. The syscall filter
enforces the boundary for the task and its descendants without scanning or
following workspace files. Profiles requiring pathname socket clients or other
ABIs are unsupported by this adapter. Existing legacy command/API runners keep
their behavior; they remain unavailable for restricted protocol-2 execution.

The baseline syscall table is the effective zero-capability OCI policy observed
in every retained Round13 boundary receipt. Its canonical SHA256 is
`0a305e976b9acee07c9c3e9035da9cde358ab28583f7900f4871b0f97223747a`;
the installed system profile was16,401B SHA256
`cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`.
`tests/fixtures/sharedSeccompBaseline.json` retains that independent baseline.
Non-socket rules/default denial are preserved and tests check socket allowances
are a subset. See the [containers/common profile](https://github.com/containers/common/blob/v0.57.4/pkg/seccomp/seccomp.json)
and adjacent Apache license attribution. Matching OCI metadata is not a substitute
for actual enforcement tests or the remaining complete release/security review.

Tasks also have zero soft and hard `RLIMIT_CORE` limits, verified in the complete
initialized OCI spec. Before probing, creating or starting a task, the adapter
reads the fixed host procfs core pattern and refuses external crash-handler pipes
or unreadable/ambiguous policy. It does not modify host settings. Linux ignores
core-size limits for piped handlers and runs those handlers in the initial host
namespaces, outside the task boundary ([core(5)](https://man7.org/linux/man-pages/man5/core.5.html)).
Use an executor host provisioned with a non-piped core policy. Merely setting a
container core limit on an Apport/systemd-coredump host does not meet this boundary.
Do not disable crash collection on an unrelated or production machine to make a
test pass. Scoped policy changes used on the dedicated verification VM are
recorded and restored; they are not production provisioning evidence.

Probes, execution and removal use an adapter-generated private `CONTAINERS_CONF`.
Its directories are mode 0700 and its file is mode 0600, outside the workspace;
the file is removed after confirmed cleanup. It clears configured
mounts, volumes and host environment forwarding, ignores image volumes and points
OCI hooks at an empty private directory. Inherited `CONTAINERS_CONF_OVERRIDE` and
other configuration environment variables are excluded. Execution and its forced
removal share the same configuration. HOME/runtime access remains for local image
storage and rootless operation; custom containers.conf defaults are unsupported.
If configuration cleanup also fails, the original execution error code is retained
alongside the cleanup error. In particular an unconfirmed container removal must
remain unconfirmed, so the runner retains task paths for review. Cleanup failure
after an otherwise successful operation also fails closed.

Round 5 confirmed that independent mounts.conf handling can expose a host canary
despite this configuration. The adapter now refuses existing user, system or
distribution mounts.conf files and `/etc/system-fips`, without reading their
contents or disabling FIPS policy. Use a suitable dedicated executor environment;
do not alter unrelated host policy to bypass this prerequisite.

After create, the adapter initializes the exact container without starting task
code, inspects its identity/state and reads the complete OCI spec through a fixed
bounded no-follow host control reader in Podman's user namespace. It validates
every mount destination/source/type/option, including generated hosts/hostname,
private tmpfs and cgroup mounts; an arbitrary copied source in userdata is denied.
Unknown, duplicate, missing or weakened mounts fail before start. Read-only root,
namespace isolation, no-new-privileges, absence of hooks/devices/capabilities and
finite CPU/memory/PID settings are checked too. Workspace and task directory
identity and automatic configuration are rechecked after initialization.

The Round 6 report reproduces pathname replacement followed by restoration during
init: the restored source path and configured mount source can both look correct
while the effective bind exposes a different inode. The revision now keeps
no-follow directory descriptors for workspace, inputs and outputs open through
execution and cleanup. Device/inode comparisons use exact bigint identities.
The same fixed control helper in Podman's user namespace pins `/proc/PID`, opens
the initialized process root, verifies it against the validated OCI root, and
reads directory identities through that root. It compares effective binds against
the retained descriptors, checks process start time and mount namespace stability,
then re-inspects initialized state/PID before start. Missing procfs access, any
identity mismatch, or changed/uninitialized state fails before task argv starts;
there is no host-source-path fallback. Directory-handle cleanup errors preserve
an uncertain execution's identity and retained configuration receipt.

Linux documents that [the proc process root includes its namespace mounts](https://man7.org/linux/man-pages/man5/proc_pid_root.5.html).
Access uses ptrace permission checks, so the rootless VM must demonstrate the
helper can read the initialized namespace without extra privileges. The local
tests model runtime mount receipts and use real host descriptors/procfs for
negative controls; they do not demonstrate rootless container mounts. Actual
enforcement, initialized-process lifetime and final bind/race behavior remain
required VM/security-review gates. Round 7 demonstrates the old revision rejecting
real workspace/input/output substitutions, but the complete round still failed.
No S06 completion is asserted from this change.

The next revision combines the bounded OCI read/contract validation and effective
mount receipt in one `podman unshare` process. The parent repeats both validations
and retains the final initialized-state/PID check. OCI input stays bounded at
256 KiB; the combined response allows that spec plus a bounded 16 KiB receipt.
Cancellation is checked after each review command so an aborted task does not
start another review phase. The deadline still begins before create: no runtime,
CPU, memory or PID budget was increased. This removes one engine/helper startup;
only a new real-engine round can determine whether PID repeatability improves.

The fixed synchronous control reader additionally uses a 32 MiB V8 old-generation
heap and one V8 background worker. These are host helper settings; task argv,
environment, CPU, memory, PID limits and deadlines stay unchanged. Bounded input
and output, both boundary validations, final state and writer checks remain.
This limits helper resource use; it is not a certification of request timing on a
contended VM. Record guest CPU steal alongside control/task/cleanup timings and
preserve every failed original repeat when reviewing executor capacity.

Podman documents [init as the pre-start filesystem/spec inspection boundary](https://docs.podman.io/en/v4.9.3/markdown/podman-init.1.html).
The [reviewed containers/common automatic-mount implementation](https://github.com/containers/common/blob/v0.57.4/pkg/subscriptions/subscriptions.go)
selects mounts.conf independently of containers.conf and can copy host files during
initialization. The installed-version package/configuration contract still needs
the retained VM rerun; fixtures cannot certify it.

The adapter now creates a container first and uses its full immutable ID for
startup, removal and the independent `container exists` postcondition. Cancellation
during creation waits for the bounded create command; task code is never started
after cancellation. Cancellation/overflow stop through the engine before killing
the attach client, wait for that client, then remove again and verify absence.
Removal explicitly uses `--force --time=0` to avoid competing with the bounded
control timeout. Only a normal exit code 1 with empty stdout and stderr confirms
absence; configuration errors can also return 1. Engine/storage errors, signals,
timeouts and diagnostics are uncertain. Success is withheld until this postcondition passes. An uncertain
outcome retains the private configuration and task files, and quarantines further
execution through that engine in the current process. Operator recovery and crash
recovery remain release gates. Command fixtures do not certify actual Podman
termination, cgroup emptiness or the remaining mount boundary.

Round 6 also identified the actual Podman inspection state after init as
`initialized`, which the adapter now requires. A merely `created` container is
not accepted for review. Inspection can include long literal argv and has the
same 256 KiB bound as the OCI reader; other control responses retain 16 KiB bounds.
These revisions follow the [Podman state mapping](https://github.com/containers/podman/blob/v4.9.3/libpod/define/containerstate.go)
and [forced-removal timeout contract](https://docs.podman.io/en/v4.9.3/markdown/podman-rm.1.html#time-t-seconds).
Their actual runtime behavior still needs a new complete VM round. The Round 6
report states that its separate candidate failed workspace substitution and PID
repeatability; that candidate is not certified and is not enabled here.

The first adapter profile does not support external network destinations. A
future network profile needs a separate reviewed proxy and destination policy;
changing `--network=none` in configuration is not an approved shortcut.

An owner-controlled profile is explicit about the image, workspace and argv:

```json
{
  "provider": "restricted",
  "model": "project-tools",
  "executor": "rootless-podman",
  "workspaceAlias": "Website",
  "image": "registry.example.test/chatspace/project-tools@sha256:<digest>",
  "workspaceRoot": "/srv/chatspace/workspaces/website",
  "taskOutputStore": "/srv/chatspace/task-outputs",
  "argv": ["/usr/local/bin/project-agent"]
}
```

The profile file is local owner configuration. A guest request cannot change
the image, mount, argv, environment allowlist or network mode.
The runner checks that the workspace does not overlap its credential/private
history journal, private attachment directory or owner profile file. It checks
both configured and canonical paths, including existing symlink parents, before
writing a shared journal or invoking the adapter. These checks preserve legacy
private command/HTTP profiles; arbitrary shared workspace relocation is unsupported.

Protocol-2 tasks must use this adapter. The runner verifies the context's approved
device and workspace before invoking it, and never routes that work through its
legacy host command or HTTP profiles. Legacy protocol-1 and private executions
retain their existing behavior. The image must contain a literal SHA-256 digest;
mutable image tags are rejected. The conversation transcript is supplied on stdin.

Restricted shared batches also require exactly one owner-controlled profile with
the claimed provider and model. Missing/unmatched/duplicate selections fail
before decryption, staging or invocation; there is no first-profile fallback.
Saved results remain held if that profile disappears before delivery. Restoring
the profile permits delivery of the retained encrypted output without rerunning
the task. Legacy protocol-1 and private default-profile selection is unchanged.
The selected notes agent's separate actual-runtime/credential/network and project
prerequisites are recorded in [the compatibility target](AGENT_SHARING_NOTES_COMPATIBILITY.md).

Workspace approval compares the original directory inode with both the resolved
path and the original pathname. The executor retains that identity and rechecks
it after its engine probe, before starting a task. Replacement at either of these
checked stages fails closed. The final engine bind still uses a pathname: these
checks do not prove an atomic bind against concurrent host-side replacement.
Keep workspace parent paths owner-controlled and stable, and verify the remaining
bind/startup races on the actual engine before certifying S06.

The current coarse grant supports `workspace.read` and `workspace.execute`, with
optional `workspace.write`. Without write permission the workspace mount is read
only. Resources must contain only the matching workspace alias, and the budget
must specify `maxRuntimeMs` between 1,000 and 900,000. The adapter cannot enforce
more specific tool permissions, external destinations or spending budgets;
such policies fail closed. The runner now binds its entire `workspace.execute`
launch to a server action before invoking the adapter. It can support an owner
approval for that coarse execution, while preserving the original grant policy.
Read/write approvals inside an arbitrary command remain unsupported. A separately
reviewed native/provider tool boundary is still required for daily collaboration.
Cancellation force-removes
the named container and reports an unconfirmed outcome if removal fails.
An absent or null expiry supports the existing non-expiring grant contract;
supplied expiry values must be valid future date strings. Empty strings, booleans,
numbers and objects are rejected. The server remains responsible for current
grant/revision/revocation authorization; the snapshot check cannot establish it.

The bound launch records the fixed provider/model, image digest, argv, filtered
environment, read-only mode, runtime ceiling, transcript hash and staged input
file hashes. Server responses must match the independently computed action digest
and return a one-time execution nonce. Waiting for owner approval launches no
command; denial, expiry, a changed response or lost start acknowledgement prevents
launch. The runner retains start intent before requesting consumption. Restart
never repeats an uncertain action. Uploaded file inventory and bytes are checked
again before container startup, including no-follow reads and bounded hashes.

An authenticated server authorization response supplies an absolute task deadline.
The local watchdog includes approval waiting and cannot extend that deadline from
a later response. Missing or invalid deadlines fail closed, so upgrade the server
before the connector. Conmon retains the separate finite execution timer described
below; this is not a per-request provider-token or billing cap.

Outcome receipts retain output hash, duration and trusted stoppage evidence.
Receipt transport failure persists the exact acknowledgement for a later retry,
without an execution callback. A recovered receipt does not automatically publish
a lost result or resolve an uncertain batch. If an owner resolved the runtime
before acknowledgement, preserve the local receipt for review rather than erase
it. A native/model error cannot supply its own proof of process absence.

Protocol-2 attachments are staged in private task directories outside the project,
then mounted at `/task-inputs` read only with `nosuid,nodev,noexec`. The transcript
contains container paths, never the connector's attachment paths. A task accepts
at most ten inputs and 20 MB in total. Result files must be regular files directly
under `/task-outputs`; arbitrary host paths, project paths and symlinks are rejected.
Only the exact `/task-outputs/<leaf>` representation is accepted; `.`/`..`, trailing
slashes, duplicate separators and traversal aliases are rejected before file reads.
The runner snapshots at most ten result files / 20 MB into its encrypted journal
before deleting task directories. Restart, delivery retry and key rotation use
the saved bytes and never rerun the agent or reopen mutable output paths.

The owner-controlled `taskOutputStore` must be a Linux tmpfs bounded to at most
24 MiB and 256 inodes. Ordinary directories and the host's large shared `/dev/shm`
are rejected. This bounds bytes and inode creation while the child is running,
before publication validation. For a disposable test or a reviewed executor host,
an operator can mount a dedicated store with `size=20000000,nr_inodes=128,mode=0700`
and the executor user's uid/gid, plus `nosuid,nodev,noexec`. Do not mount over an
existing data directory. The adapter verifies the actual dedicated mount from a
bounded `/proc/self/mountinfo` read, requires `rw,nosuid,nodev,noexec`, executor
uid/gid ownership and mode 0700, and retains the store inode for later checks.
Missing/stacked mount records, bind aliases and changed ownership/modes fail
closed. Each task mounts only its own private output directory;
the bounded backing store itself is not exposed. Missing/full stores fail closed.

Engine probes, execution and forced removal all receive the same filtered
environment; connector secrets and remote-engine environment settings are omitted.
When removal is unconfirmed, task paths remain in the connector's private journal
and their directories remain held for executor review. Do not clean them or retry
the execution until the operator confirms the container is gone.
The runner also persists a separate retained execution receipt with task/container
identity, configuration and task directory paths. Restart or server batch recovery
cannot erase that receipt or automatically unblock restricted execution. Legacy
private providers can still run. An operator recovery workflow that verifies
exact container/writer cleanup before clearing receipts remains required; do not
delete receipts or retained paths to bypass review. A crash before the adapter
returns a receipt still needs supervisor recovery and remains a release gate.
Crash cleanup,
store exhaustion recovery and container mount/escape behavior still need the real
S06/S07 lifecycle checks; filesystem/subprocess fixtures do not certify isolation.

Protocol2 runner tasks now acquire durable admission before task-file allocation
or copying uploaded bytes. The default supervisor directory is
`~/.local/state/AgentsMCPspace/restricted-executor`, outside every shared workspace.
All runners for that OS account use one exclusive admission: at most one staged/
executing task, at most 20,000,000 staged input bytes and ten inputs through the
existing task-file limits. This conservative serialization also prevents concurrent
workspace writes by those restricted runners. It does not limit existing private
provider capabilities, server queue length, spending or total shared upload storage.

Admission and stage identities are recorded with fsync and atomic replacement in
private disk storage, before launch. Receipt states distinguish admission, staging,
execution, stopped and review required. Closing handles, process death or server
batch recovery cannot clear the admission. Successful adapter completion plus
task-file cleanup releases it; an execution error without explicit cleanup evidence
retains admission and stage paths. Root/directory/receipt replacement and unreviewed
files prevent release. There is no PID expiry, directory-name glob cleanup or
automatic crash retry. Do not choose a different supervisor directory to bypass a
retained receipt. Operator recovery still requires independently verifying exact
container/writer absence. A production operator recovery command remains open;
do not delete the admission or change its configured root to resume work.

An operator can now review the retained admission from the repository checkout:

```bash
node scripts/shared-executor-recovery.js inspect
```

Run as the original ordinary executor account with its runtime environment. The
default is the same supervisor root used by its runners. `--root` selects an
explicit existing configured root; `--podman` selects a trusted absolute local
engine binary. Inspection pins the root/admission, bounds and validates the
private receipt/CID, checks PID/start identities, and independently queries the
exact local container with fresh minimal settings. An existing container must
match the recorded task, lease, name and pinned image. It prints selected metadata
and blockers, never credentials, task contents or raw engine diagnostics.
Exit2 means review completed with unresolved recovery requirements; exit1 means
review itself failed. Neither permits deleting paths, changing the supervisor root
or retrying. This command does not stop containers, remove staging or release
admission. The mutation/release phase is still a production gate.

New admissions also persist the Linux kernel boot ID before staging. Recovery
review reports whether that ID matches the current boot. A reboot can reuse PID,
start-time and tmpfs inode values, so changed boots and legacy receipts without a
boot ID require independent recovery review. A matching boot is necessary, but
does not establish container absence, stopped writers or permission to release
admission. The VM component test simulates mismatched receipt metadata; it does
not claim a real reboot or power-loss test.

Protocol2 executions now journal an engine identity before `create`: the random
container name, pinned image, local engine path and private configuration directory
identity. Podman receives a cidfile outside every task mount and labels binding
the task and admission nonce. After creation, its exact stdout ID must match the
bounded no-follow cidfile. The initialized container must retain those labels;
the initialized PID/start identity is journaled before startup. Unknown create
results still retain admission and configuration for review. A cidfile or label
alone never authorizes deleting a container.

New journaled startups also record the actual cgroup-v2 leaf and libpod scope
directory inodes before executing task argv. A fixed host reader pins the
initialized process, checks its start time and unified cgroup membership, and
requires the exact container-ID scope, domain mode, live PID and enforced
512 MiB/one-CPU/128-PID limits. Missing or changed kernel evidence prevents
startup. The dependency-free downloadable runner includes this fixed reader;
verification packets include and hash its source when required. Legacy receipts
without this identity remain inspectable and block descendant recovery.

Linux's [cgroup-v2 population state](https://docs.kernel.org/admin-guide/cgroup-v2.html#un-populated-notification)
covers live processes in the hierarchy, including descendants. Recording the
correct hierarchy enables later operator proof; recording alone neither proves
stoppage nor permits admission release. The dedicated VM confirmed matching
kernel inodes and limits for an actual task and child, then killed the runner
and observed watchdog stoppage with admission retained. The operator mutation
and release workflow is still required.

The adapter records exact-ID absence only after forced removal, attach closure
and the independent normally exited silent absence query. That durable checkpoint
allows staged files/admission to release after cancellation or task failure;
server outcome remains uncertain and execution never automatically retries.
Error-supplied cleanup flags have no authority. Podman removes its cidfile with
the container; its missing file is accepted only after the checkpoint, not as
absence evidence. Retained CID files require matching content/inode/owner/mode
before release. This behavior is documented in the
[Podman 4.9.3 removal contract](https://docs.podman.io/en/v4.9.3/markdown/podman-rm.1.html).

The original execution deadline includes creation and boundary review. A monotonic
clock check also enforces it at each launch/publication boundary, including when
an overdue JavaScript timer has not run. Creation additionally sets Podman's
independent conmon timeout and zero stop grace. That secondary watchdog bounds
runtime if the connector dies; its whole-second rounding and runtime-only clock
do not replace the original deadline or establish immediate grant revocation.
Watchdog termination never releases admission or authorizes a retry. Exact-ID
cleanup, writer checks and retained-receipt recovery remain required.

A dedicated VM audit killed a running connector after observing both its task and
child. Conmon stopped the exact container and both process identities; the cgroup
was empty or removed. The ten-second component proof is separate from the still
blocked original four-second full-driver proof. The initial audit incorrectly
required exit137; Podman reported -1. That failed audit is retained alongside the
fresh process/cgroup proof, with unchanged executor source. Both audit containers
were independently absent and both owned bounded stores checked and unmounted.

A separate real VM audit covers normal staged bytes, cancellation after create,
and killed owners at creating/created/starting/running phases. Private receipts
survive death and block a fresh admission. Recovery in that audit validates exact
ID/name/task/lease/image before removing only its fixtures. All new stores were
identity/ownership/flags/capacity/emptiness checked and unmounted; old Round8 stores
remain untouched. This is diagnostic component evidence, not the complete runner,
provider, power-loss recovery or a full S06/release certification.

The 2026-10-05 VM component audit exercised a real rootless staged-input/output
task and killed a real executing runner. The durable admission blocked a second
task. The audit then performed its own exact-ID fixture recovery; both IDs were
independently absent and its empty bounded tmpfs was unmounted. This is diagnostic
image/component evidence, not a provider, complete runner or full S06 pass. Round9
and the subsequent unchanged PID profiling still include timeouts.

The current development host does not have Podman, Docker, nerdctl or
bubblewrap. Its `unshare --user --map-root-user --mount --pid --net` probe
fails while writing `/proc/self/uid_map` with `Operation not permitted`. The
real rootless executor gate is therefore blocked here. The fail-closed adapter
and negative tests are implemented, but no isolation pass is claimed until a
disposable Linux host has the pinned image and can run the required tests for
private-file reads, symlink escapes, forbidden network, environment secrets and
writes outside `/workspace`.

On this Ubuntu host, AppArmor also restricts unprivileged user namespaces. The
distribution supplies an application-specific Podman profile. Do not disable the
global restriction to bypass this prerequisite. Installing Podman is currently
blocked by unrelated unfinished kernel packages, and the user-selected production
image/workspace remains unspecified. See the
[Ubuntu AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
and [Podman run contract](https://docs.podman.io/en/stable/markdown/podman-run.1.html).

Approved shared exports on Linux are opened relative to a pinned directory
handle through `/proc/self/fd`, with nonblocking no-follow leaf opens and inode
checks. A replacement pipe cannot block publication. Reads are bounded to the
inspected size plus one overflow byte (at most 20,000,001 bytes). Length, size,
mtime and ctime changes reject capture, including observed same-inode rewrites.
These checks do not establish an atomic snapshot against a concurrent writer;
the real executor lifecycle must establish that task writers have stopped before
capture. Private/account exports retain the same approved-directory contract.
Renaming or replacing the configured directory cannot redirect a publication
read into another host directory. Platforms without these handles fail closed
for shared exports. This does not replace container isolation or action/output
review; an unrestricted host tool remains outside the guest release contract.


Operator `inspect` is read-only. Explicit `stop --receipt-sha256 <reviewed-hash>`
requires a stopped original runner on the recorded boot and complete unchanged
receipt identities. It takes a kernel operator lock and durably records intent
before removing only the exact task ID. Five absence/process/hierarchy checks
confirm stopped writers. Failures preserve an uncertain audit and admission.
Stop retains all task files, engine settings and the original admission; exit2
means release remains unresolved. Inspect again and retain its selected report.
No implicit retry or output publication follows recovery. The actual VM API stop
component passed; complete production recovery and runtime gates remain open.


After reviewing a successful stop, an operator can explicitly discard that
stopped task's temporary inputs, outputs and engine settings and retire admission:

```bash
node scripts/shared-executor-recovery.js release --root /absolute/supervisor/root \
  --receipt-sha256 REVIEWED_RECEIPT_SHA256 --stop-operation STOP_OPERATION_UUID \
  --discard-task-files
```

The command independently rechecks stopped writers and exact absence. It bounds
and pins inventories, writes durable intent before disposal, and atomically
archives admission into the operation audit after disposal. Original receipt/CID
and stop/release audits remain. Pre-commit interruption retains admission and
root identities; inspect again and resume the same explicit review if identities
still match. Post-commit empty-directory failures return exit2 with pending
cleanup; audit records identify retained empty roots. An uncertain sync outcome
requires inspection of the operation audit before further recovery. Legacy or
changed-boot/incomplete identities require separate manual review. No expiry,
blanket delete or external-action retry is permitted. VM component checks passed
actual CLI release and fresh admission; full runtime/application gates stay open.


All restricted runs now require the fixed kernel reader before startup. After
exact-ID removal, the original process and exact cgroup leaf/scope must prove
stopped writers before output can return or admission can record absence.
Uncertain queries or live writers hold results and retain configuration/admission.
Normal and operator recovery use the same bounded process observer. A final
monotonic deadline and cancellation check follows durable cleanup; late output is
withheld even if task exit was successful. Standalone source consumers must include
executorCgroup.js; downloadable bundles embed it. Actual VM task/child completion,
cancellation, overflow, original four-second timeout, late-cleanup output holding
and killed-owner recovery passed as components. The unchanged full runtime suite,
PID repeats, selected real agent and application/release gates remain required.
