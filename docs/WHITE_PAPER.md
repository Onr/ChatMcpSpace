# ChatMcpSpace: dependable delegation and human agency

Version 1.1 · September 13, 2026

Companion to the [Manifesto](../MANIFESTO.md). This paper translates the charter into product structure, engineering responsibilities, and a method for deciding what deserves to exist.

## Abstract

As agents gain the ability to act across tools and machines, people inherit a coordination problem: defining work, granting authority, tracking progress, answering decisions, and judging results. A communication channel helps connect these activities. A dependable delegation system must also preserve intent, make authority understandable, and distinguish activity from evidence of completion.

ChatMcpSpace's purpose is to make that delegation useful while preserving human agency and attention. Its proposed organizing unit is an outcome with an accountable owner, a clear scope, observable progress, and reviewable evidence. Conversations support this unit; agents execute it; coordination connects the parts.

The product is also the person's shared home for multiple independently running agents. An agent may join from Hermes or another framework without moving its runtime into ChatMcpSpace. User-to-agent conversations, agent-to-agent collaboration, and user-authorized central direction belong in the same space.

This is a design white paper grounded in the repository, not a research publication or production certification. Its principles are intended to last. Its implementation proposals and dated feature decisions remain open to evidence.

## 1. The human problem

A capable assistant can still be expensive to supervise. A user may need to check several sessions, translate between workers, repeat context, discover silent failures, and determine whether a cheerful completion message is justified. The burden grows when activity is distributed across projects, providers, and machines.

The opportunity is to reduce the distance between a person's intention and a result they can use. That requires both competent action and an understandable relationship between the person and the system.

The initial audience is a builder or small-team technical lead already using agents. This is a starting hypothesis supported by the current terminal-based setup and local runners. The enduring purpose extends beyond that audience; broader access should be earned through simpler setup, accessible interaction, and reliable recovery.

Meaningful outcomes can include building, learning, investigating, maintaining, and creating. The user decides what is worthwhile. The product should support exploratory work whose useful result is a clearer question or an informed decision, as well as work that produces a concrete artifact.

## 2. The durable product model

The proposed core journey is:

**Express intent → agree on the outcome → act within authority → resolve material decisions → present evidence → accept or revise.**

Five concepts should remain understandable even as the implementation changes:

| Concept | Responsibility |
|---|---|
| Outcome | Holds the desired result, completion criteria, scope, and relevant constraints. |
| Agent | Performs assigned work using defined capabilities and authority. |
| Run | Records a bounded attempt, its trigger, progress, resource use where known, and disposition. |
| Decision | Identifies a specific unresolved choice and the context needed to resolve it. |
| Evidence | Connects a result to artifacts, checks, observations, and remaining uncertainty. |

These are conceptual responsibilities, not a requirement for five screens or five database tables. Start with the smallest implementation that preserves the distinctions.

Connection state belongs alongside work state. Recent contact does not prove progress; an offline worker does not erase its completed result. Preserve user decisions and work records across refreshes and reconnects.

Scope changes should update the brief visibly. Work should not silently expand because an agent discovers another possible improvement. Exploratory assignments may authorize discovery, but their limits should still be understood.

## 3. Autonomy and authority

### Connected agents are full participants

Support three paths as part of the product contract: the user messages an external agent and receives its response here; an authorized peer exchanges messages with that agent; a user-chosen central agent gives it an assignment and receives its result. Creation inside ChatMcpSpace must not be a prerequisite for any of these paths.

Separate communication from runtime hosting. A connector beside an existing agent can receive work from ChatMcpSpace, invoke that agent through its supported interface, and return its response. An outbound connection allows a worker behind a home network to participate without exposing its local API to the internet. The external agent keeps its tools, memory, and runtime policies.

Central control has explicit levels: conversational direction, assignment tracking, and any runtime operations the adapter actually supports. Report unsupported stop, restart, model change, or process management honestly. A local Chief of Staff cannot acquire control of a remote machine merely because its agent joined the space.

Distinguish a user's instruction from a peer's message, preserve sender identity, and route replies to the originating conversation. Prevent repeated delivery from re-running consequential work and prevent automated replies from turning into endless agent conversations. Shared-space participation follows the user's collaboration policy and does not imply cross-account access.

### Authority follows the assignment

Separate the freedom to choose a method from the authority to affect a resource. An agent may have broad discretion about implementing a requested change while having narrow access to a workspace and no authority to publish it.

An assignment should carry a usable policy: objective, permitted resources, delegation allowance, resource limits, and external actions already authorized. Routine reads, edits, tests, and corrections within that policy should proceed without repeated approval.

Escalation is for a real boundary: a material change of scope, access expansion, an unresolved preference essential to correctness, or an external effect outside standing authorization. The agent should prepare a concrete result or proposal before asking whenever possible.

Provider adapters must translate policy into actual enforcement. A generic setting is not evidence that every provider implements the same boundary. Unsupported guarantees must be disclosed or the operation restricted. Missing policy must not silently widen authority.

Delegated workers should receive only the context and capabilities needed for their assignment, within the parent's authority. The parent remains responsible for synthesis. One task budget should include its delegated work; delegation must not become a way around a limit.

## 4. An experience that releases attention

The home experience should make three things clear: what needs the person, what moved forward, and where to inspect the work. Detailed conversations and team views remain available without requiring the user to reconstruct the outcome from them.

A decision should explain the choice, a recommendation when justified, and the material tradeoffs. It should support free-text correction and remember prior authorization. A progress update should report a meaningful change, not simply another sign of life.

A result should explain what was achieved, link to the output, describe verification, and identify limitations. Work may be accepted by the user or by a verification rule the user deliberately configured. The system should preserve which basis was used.

Quiet is a successful state when nothing needs attention. Users should control routine notifications. Pending decisions must remain findable even when alerts are muted. Voice and accessible interaction can be essential access paths; their value cannot be judged solely by majority usage.

Visual character should make the workspace welcoming and memorable. Stable agent identities are useful. Any additional navigation metaphor should demonstrate that it helps people locate, understand, or coordinate work.

## 5. Engineering duties implied by the promise

- **Durability:** retain briefs, decisions, results, and scope changes through interruptions.
- **Recoverability:** handle duplicate delivery and retries without duplicating consequential work; show failures with a usable recovery path.
- **Control:** distinguish pause, stop request, acknowledgement, and verified termination. Explain the limits of control over remote workers.
- **Interoperability:** define adapter contracts for prompts, capabilities, authority, exit behavior, and cancellation. Validate effects as well as generated arguments.
- **Privacy:** document content, metadata, credentials, and optional external services separately. Minimize data collection and preserve protection when adding features.
- **Portability:** design practical export and migration paths for user-owned records and outputs; do not claim they exist before implementation.
- **Verification:** maintain release checks for first connection, delegation, decisions, results, reconnect, mobile access, and stopping. Historical passing tests cannot certify a changed release.

Implement these incrementally around the existing messaging and runner infrastructure. A broad rewrite would need its own evidence that it lowers risk or removes a specific limitation.

## 6. What deserves to ship

A feature proposal should name its user, the job it helps complete, its unique contribution, the complexity it introduces, and how its benefit will be assessed. It should explain whether a simpler existing capability could do the job.

A removal proposal should name the dependency and migration path, whose work or access could be harmed, how records will survive, and how to restore the capability if the decision proves wrong. Low usage alone is insufficient when a feature serves essential accessibility or recovery needs.

Use these dispositions precisely:

- **Remove:** retire the capability and its maintained product surface.
- **Consolidate:** preserve the user job while eliminating a duplicate implementation or concept.
- **Keep:** maintain the capability because it serves a distinct valuable job.
- **Defer:** postpone something not yet delivered; this is not feature removal.

Hiding a feature is useful for reducing first-run complexity, but it does not remove its maintenance cost. It should not substitute indefinitely for a decision.

## 7. Actual feature-removal recommendations — September 2026

These judgments use inspected source and product reasoning. Usage, support burden, and accessibility dependence have not been measured. They supersede the earlier interpretation of “unship” as primarily hiding controls or removing copy. This document authorizes no deletion; it specifies candidates for a subsequent implementation task.

| Existing addition | Recommendation | Why and what survives | Gate before removal |
|---|---|---|---|
| Animated navigation between dashboard and settings, including button-text morphing | **Remove the navigation-delay feature.** | `page-transitions.js` deliberately waits 400 ms before navigation when `main` exists. Immediate normal navigation serves the same job. Retain modest nonblocking visual polish where useful. | Restore clear links; verify keyboard, modified-click, back/forward, and restored-page behavior. Remove associated obsolete handlers and styles. |
| Separate Local News Feed Agent setup, marker files, and generated per-provider posting instructions | **Consolidate into a project activity stream; retire the special setup feature after replacement.** | Activity history is valuable. Requiring a special agent identity and distributed helper instructions creates another setup and maintenance obligation. This session's missing configured helper path illustrates that fragility. Do not assume this feed consumes an LLM run; the inspected code describes fire-and-forget posting. | Preserve feed history and ingestion compatibility. Provide a stable configured destination. Migrate explicit logging integrations and repository instructions before retiring helpers. No removal of the currently required activity log is implied. |
| Circular Council navigation alongside the agent list, including orbit sizing, group zoom, and separate focus/resize state | **Candidate for full removal as a navigation mode.** | The list already supports locating agents and groups. A second navigation system adds layout, mobile, and keyboard obligations. Retain recognizable marble avatars, names, colors, and useful group relationships. | Compare representative users locating agents and understanding teams in both views. Retire the circular mode if it offers no distinct benefit. Migrate selection/group state. If it proves valuable, keep it with a defined purpose. |
| Separate persistent rich-content history controls in the main conversation and side-chat tiles | **Consolidate into one shared result viewer.** | Preserve rich output, history, downloads, and comparison. Eliminate separately maintained interaction logic where the same viewer can serve both contexts. | Verify that users can inspect the result relevant to each chat without losing history or useful simultaneous comparisons. Shared code alone may suffice; do not remove a useful view merely because it shares behavior. |
| Bundled `max-access` setup profile spanning providers and broad communication | **Retire the convenience bundle after granular grants are equally usable.** | Users may still choose broad authority explicitly for a particular agent. Removing the bundle reduces accidental coupling between unrelated grants. | Preserve existing deliberate grants; support repeatable noninteractive configuration and migrate CLI callers before removing the flag/profile. |

Recommended order: remove the artificial navigation delay first; replace and retire special news-feed setup second; evaluate Council removal third. Consolidation of result viewers should accompany frontend maintenance. Retire the broad-access bundle only once its replacement preserves expert workflows.

The Council recommendation is deliberately stronger than the earlier review's “keep it optional.” Making a second navigation mode optional still leaves its implementation to maintain. Its distinctive appearance deserves consideration, but needs evidence of value to justify that ongoing responsibility.

### Features to keep

Keep direct agent conversations, free-text answers, local execution, provider choice, mobile access, archive, scheduling, scoped inter-agent communication, and rich results. Each supports a distinct part of delegation or continuity.

Keep voice access and text-to-speech unless equivalent access is preserved; voice notifications are already opt-in in the inspected browser code. Keep pinned side chats where they support actual comparison or parallel decisions. Keep the Chief of Staff as optional coordination for users who benefit from it. This review has no evidence sufficient to justify deleting those capabilities.

Do not count proposed marketplaces or live sharing as features removed: the reviewed documents describe future work, not proof of shipped capabilities.

## 8. How to know the project is improving

Measure useful outcomes accepted per returning user, alongside rework, interruptions, recovery, and perceived supervision burden. Count stable outcomes rather than multiplying success by worker or message count. Pair measurements with examples of what users achieved and whether the work was useful.

Ask people whether they can step away comfortably, whether returning is clear, and whether the system made an otherwise difficult undertaking possible. Include new users, experts, and people relying on alternative interaction methods.

Collect minimal metadata for measurement. Do not require private conversation capture to understand basic product health. Establish baselines before setting numerical promises, and never equate agent runtime with time saved.

## 9. Stewardship across generations

Treat the manifesto as the durable purpose, this paper as the evolving interpretation, and dated reports as evidence and implementation proposals. If they conflict, explain the conflict and update the interpretation explicitly; do not silently redefine the purpose through accumulated features.

Review the charter when the audience or operating model materially changes, and periodically with users and maintainers. Keep an amendment record with the old principle, the proposed change, evidence, affected users, and the responsible maintainer's decision. Preserve the ability to disagree and revise.

For each significant release, record which commitment it advances, what burden it removes, and what evidence will show that the change helped. A future generation should inherit both the freedom to improve the project and enough reasoning to understand why it exists.

## Repository basis

- [Dashboard](../views/dashboard.ejs), [dashboard behavior](../public/js/dashboard.js), and [multi-chat](../public/js/multi-chat.js): navigation modes and rich-content surfaces.
- Page transitions (`public/js/page-transitions.js`, since removed): navigation delay and button morphing.
- [Generated setup and runner](../src/utils/apiGuideGenerator.js): news-feed setup, provider instructions, permission profiles, and runtime adapters.
- [Voice control](../public/js/voice-control.js): speech interaction and opt-in notification setting.

External research and live production behavior were not independently verified for this paper. Its enduring commitments are normative; proposed mechanisms are not presented as shipped guarantees.

## Amendment record

- **1.1, September 13, 2026:** Clarified the founder's intent: ChatMcpSpace is the user's shared home for independently running agents, including Hermes-style agents, with direct user conversations, peer collaboration, and user-chosen central direction. Runtime hosting is optional; membership and coordination must not depend on where an agent was created. Version 1.0 is preserved in checkpoint commit `41b2058`.
