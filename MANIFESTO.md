# The ChatMcpSpace Manifesto

**Keep your work moving. Keep your attention yours.**

Version 1.1 · September 13, 2026

This is the project's guiding charter. It states the purpose and commitments that future designs should serve. It describes our direction, not a claim that every commitment is already fulfilled. The [white paper](docs/WHITE_PAPER.md) explains how to apply it.

## Why we exist

People carry ideas they have too little time, energy, or support to realize. Powerful tools can help, but they can also create another responsibility: configuring them, watching them, interpreting their activity, and repairing their mistakes.

ChatMcpSpace exists to make capable assistance dependable enough to entrust with real work.

Our mission is to help people pursue meaningful goals with agents they can direct, understand, and trust—while preserving ownership of their work and freedom over their attention.

Our vision is a workspace a person can leave with confidence and return to with clarity. Work progresses within agreed boundaries. Decisions arrive with context. Results come with evidence. The person remains the author of the purpose.

## A shared home for the person and their agents

ChatMcpSpace is the central place where the person lives with their agents: speaks to them, receives their work, and helps them work together. Agents may run on different machines, use different models, and belong to different frameworks. An existing Hermes-style agent should be able to join this space while keeping its own runtime, identity, tools, and memory.

The person can message any connected agent and receive its response here. Connected agents can discover and communicate with permitted collaborators. A central agent, chosen by the person, can give direction, delegate work, follow progress, and bring the results together across that community.

Participation must not depend on having been created by ChatMcpSpace. The shared home connects independently capable agents; each runtime continues to enforce its own capabilities and authority. Central direction does not imply unrestricted control of every machine.

## The joy we owe the user

The first joy is relief: “I do not have to hold every detail in my head.”

The second is momentum: “Something I care about moved forward.”

The third is understanding: “I can see what happened and decide what comes next.”

The fourth is possibility: “I can attempt something that used to feel beyond my reach.”

The deepest is freedom: “I can close this and return to my life.”

We will make room for beauty, curiosity, play, and recognizable character. Delight earns its place when it welcomes people, helps them understand, or makes useful work feel satisfying. It must respect their time, abilities, and preferences.

## Our commitments

### 1. The person owns the purpose

Agents help carry out a person's intent. The person can change direction, question a recommendation, reject a result, and stop the work. The system must make these choices understandable and effective.

We will help users accomplish what matters to them. We will not quietly replace their goals with more engagement, more agent activity, or more consumption.

### 2. Delegation should release attention

An accepted assignment should reduce the user's coordination burden. Agents should retain relevant context, handle routine steps, recover from ordinary failures, and bring back a coherent result.

Every interruption spends attention. We owe the user a reason for spending it. Questions should arrive with enough context to answer and enough preparation to make the decision concrete.

### 3. Autonomy belongs inside understood authority

Once a person authorizes work, agents should be free to carry it forward without asking the same permission repeatedly. They may choose methods, make routine corrections, and prepare reviewable results within that scope.

Access to files, collaborators, credentials, resources, and external actions must follow understandable authority. Agents cannot grant themselves a wider mandate. Delegation must preserve or narrow that authority.

Users may deliberately grant broad access. Our responsibility is to make that choice explicit, accurately represented, and revocable where technically possible.

### 4. Truth is part of the interface

Activity, progress, completion, and acceptance are different facts. We will represent them honestly.

We will show uncertainty, stale information, failed checks, and partial results. We will distinguish a requested stop from a confirmed stop. We will describe permissions and privacy through actual behavior and boundaries.

Confidence should come from evidence the user can inspect.

### 5. Ownership must survive convenience

Users should retain meaningful choices about models, machines, and where their work lives. We will favor interoperable interfaces and portable records, and make data handling understandable.

Where a provider or deployment limits these choices, we will say so. We will not make leaving artificially difficult or require unnecessary disclosure to deliver ordinary value.

### 6. Coordination must earn its complexity

Several agents are useful when their cooperation produces a better result or reduces the user's effort. Every worker should have a purpose, a scope, and a responsible owner.

A coordinator should absorb management work and resolve fragmented findings. Its success is a coherent outcome delivered within the user's constraints.

This applies equally to agents created here and agents connected from elsewhere. The user should not have to become the messenger between incompatible tools. Direct conversation with each agent must remain available even when a central coordinator is in use.

### 7. Simplicity includes subtraction

Every feature consumes some combination of attention, learning, maintenance, and trust. Its continued existence must be justified by the value it delivers.

We will consolidate duplicate concepts and remove features whose costs exceed their benefits. We will preserve user work and essential access while doing so. Past effort is a reason to learn, not an obligation to retain a feature forever.

### 8. Reliability is care made concrete

A clear recovery path, a preserved draft, an effective stop, a readable mobile screen, and an honest error are expressions of respect.

We will test the journeys on which users depend. We will treat accessibility and continuity as part of the product's quality. People should not need to become maintainers to recover from an ordinary failure.

### 9. Success belongs outside the dashboard

We will judge progress by useful outcomes, the quality of results, the supervision required, and the confidence people have in returning to their work.

We will listen for what became possible in a person's life. Time spent watching agents, message volume, and worker counts cannot establish that value.

## The question every generation must answer

Before adding, preserving, or removing a capability, ask:

**Does this help a person accomplish something worthwhile with less supervision and clearer control?**

Name the person, the benefit, the burden, and the evidence. Consider whose access might be lost. Choose the smallest dependable expression of the value.

Models, interfaces, and architectures will change. This charter should remain useful through those changes. Future maintainers may amend it openly when experience shows a better way to serve people. Record what changed, why, and whose experience informed the decision.

We build for the moment a person sees worthwhile progress, understands it, and feels free to choose what comes next.

## Amendment record

- **1.1, September 13, 2026:** Clarified the founder's intent: ChatMcpSpace is the user's shared home for independently running agents, including Hermes-style agents, with direct user conversations, peer collaboration, and user-chosen central direction. Runtime hosting is optional; membership and coordination must not depend on where an agent was created. Version 1.0 is preserved in checkpoint commit `41b2058`.
