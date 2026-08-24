# PR review-cycle internal architecture

This is the canonical maintainer map for the PR review capability. It explains
where behavior belongs and how the layers collaborate. It does not restate the
normative lifecycle rules; those remain in
[state and contracts](state-and-contracts.md),
[orchestration](orchestration.md), and
[GitHub review](github-review.md). Operators should use the
[operator guide](../README.md).

## Capability boundary

The capability owns durable PR-review state, fixed remediation task contracts,
isolated task worktrees, GitHub review evidence and mutations, targeted
validation, specialist evidence, CI collection, and the Done transition. Its
canonical implementation, schemas, focused tests, fixtures, hooks, and
documentation live under `.agents/skills/pr-review-cycle/`.

The root npm scripts, `.codex` hooks, and agent definitions are discovery and
invocation adapters. They must stay thin. The canonical ownership inventory is
`ownership.json`; update it whenever a capability-owned file is added, moved,
or retired.

The following remain separate capabilities consumed at explicit boundaries:

- release state and released-migration checks;
- related Playwright-BDD scenario selection and execution;
- change-development planning and implementation;
- specialist routing and read-only specialist roles.

Issue #25 owns future pull-request preparation. PR review currently starts from
an explicit existing PR and proves its exact live head independently. A future
handoff must pass an exact commit through a separately reviewed public contract;
do not import change-development internals or infer a handoff from shared state.

## Public surfaces and composition roots

Public modules are explicit, implementation-light façades:

| Surface | Responsibility |
| --- | --- |
| `scripts/contracts/contracts.mjs` | Stable validation, constants, gates, unions, and contract identities. |
| `scripts/state/state.mjs` | Stable named exports for state locations, evidence, services, and safe public operations. |
| `scripts/github/github.mjs` | Stable GitHub workflow factory, read operations, errors, and constants. |

Consumers import these façades or a deliberately public neutral utility, not a
private implementation file from another layer. Internal modules import the
canonical owner directly and never import their own public façade. This keeps
the dependency graph acyclic and makes façade export changes deliberate.

`scripts/worktree/worktree.mjs` is the single owner of isolated task-worktree
operations, not a generic façade over the rest of the capability.

Executable composition belongs only at these roots:

- `scripts/state/cli.mjs` parses state commands, invokes public state
  operations, renders JSON or concise errors, and performs no domain work.
- `scripts/github/cli.mjs` parses GitHub commands and constructs concrete Git,
  GitHub, state, archive, and journal adapters.
- `scripts/github/create-workflow.mjs` wires those adapters into workflow use
  cases without owning evidence or mutation rules.
- `scripts/worktree/cli.mjs` parses worktree commands and invokes the worktree
  façade.
- `scripts/hooks/*.mjs` adapt Codex hook input to the public capability surface.

Root `package.json` scripts and `.codex/hooks.json` point at these composition
roots. They do not contain a second implementation or schema.

## Dependency layers

Dependencies flow downward through these layers:

1. **Contracts** — `scripts/contracts/` owns closed data shapes, validation,
   gates, unions, and identities. It never mutates workflow state or external
   systems; targeted-selection contracts may read their bounded repository
   inventory.
2. **Pure transition policy** — `scripts/state/transitions/` builds next-state
   values from supplied state and evidence without filesystem, GitHub, Git,
   clock, or process I/O.
3. **Evidence and adapters** — `scripts/state/evidence/`,
   `scripts/github/evidence/`, `scripts/github/graphql/`,
   `scripts/github/adapters/`, and `scripts/github/archive/` acquire and verify
   facts. They do not checkpoint state or authorize transitions.
4. **State services and GitHub workflow use cases** —
   `scripts/state/services/` and `scripts/github/workflow/` compose pure policy
   with explicit evidence owners.
5. **Composition roots and façades** — the public façade modules, workflow
   factory, CLIs, and hooks expose stable entrypoints and wire concrete
   dependencies.

Do not bypass a layer with dynamic imports, duplicate a validator near a
caller, or create a generic helper bucket. Put reusable code in the narrowest
named owner that expresses its authority. Only genuinely capability-neutral
utilities belong under root `scripts/lib/`.

## State mutation path

All active-state writes follow one guarded path:

```text
CLI or GitHub workflow use case
  -> state service
  -> verified evidence plus pure transition builder
  -> checkpoint.mjs under the active-state lock
  -> revision and private transition-policy authorization
  -> atomic state write, event append, and rollback protection
```

`scripts/state/checkpoint.mjs` alone creates the private transition-policy
capability. Protected checkpoint transactions and
`createTransitionPolicy` are not public façade exports. Generic checkpointing
cannot manufacture evidence-owned fields, replace immutable sidecars, or use a
protected transition on behalf of a specialized service.

GitHub mutations have an additional recovery boundary:

```text
fully verified live snapshot
  -> durable deterministic mutation intent
  -> one GitHub mutation through the adapter
  -> fully paginated live reread
  -> guarded state-service checkpoint
```

A mutation response is not final evidence. Request, reply, resolution, and
readiness paths use their own journal identities and re-prove live state before
checkpointing. Read-only operations such as status never acquire mutation
authority.

## Evidence ownership

Evidence is acquired once by its canonical owner and passed explicitly:

- `scripts/state/evidence/` owns immutable task packets, binding provenance,
  worker-result receipts, specialist bundles, and targeted-validation plans.
- `scripts/github/graphql/` owns complete remote reads;
  `scripts/github/evidence/` classifies actors, reviews, and CI without writing.
- `scripts/github/threads/` owns canonical root, reply, recovery, and proof
  identities.
- `scripts/github/archive/` owns bounded, no-follow archive traversal and
  lineage proof. The state layer accepts only its closed validated adoption
  envelope.
- `scripts/github/mutation-journal.mjs` owns recoverable GitHub mutation intent;
  it is not a replacement for state evidence.
- `scripts/state/git-authority.mjs` owns replacement-disabled commit and delta
  proof for worker results and integration.

Durable mutable state lives under `<git-common-dir>/codex/pr-review/`, shared by
linked worktrees. Schemas stay under `schemas/`; sidecars and receipts carry
larger immutable evidence so the active state remains bounded. Archives are
read-only recovery evidence and are never rewritten to make recovery pass.

## Test layout

Tests live next to their owners:

- `scripts/contracts/*.test.mjs` exercises pure schemas, gates, and unions;
- `scripts/state/transitions/*.test.mjs` exercises pure state transitions;
- `scripts/state/services/*.test.mjs` exercises evidence-to-transition
  composition and protected write authority;
- state, GitHub, thread, archive, workflow, adapter, hook, and worktree tests
  remain beside those modules;
- `scripts/structure.test.mjs` enforces ownership, import direction, façade
  exports, composition roots, and forbidden legacy paths;
- `scripts/**/test-support/` and owner-local `fixtures/` contain focused test
  support rather than production helpers.

Add a focused owner test and a composed persisted-flow test when a change
crosses an evidence or mutation boundary. Test through public façades only when
the public contract is what the test protects; internal behavior tests should
import the canonical owner directly.

## Extension recipes

### Add or change a contract

1. Put the validator or identity in the narrow `scripts/contracts/` owner.
2. Add its adjacent focused test.
3. Export it from `contracts.mjs` only when another layer needs a stable public
   contract.
4. Update exact façade and structure expectations when the public surface
   changes.

### Add a guarded state transition

1. Add a pure builder under `scripts/state/transitions/`.
2. Add or extend a named service under `scripts/state/services/` that owns the
   required evidence.
3. Route the write through `checkpoint.mjs`; do not export private policy
   creation or add another active-state writer.
4. Cover the builder, the service authority boundary, rollback behavior, and a
   composed persisted flow.
5. Expose only the smallest stable named operation through `state.mjs`.

### Add GitHub evidence or a command

1. Put GraphQL acquisition, classification, thread proof, or mutation code in
   its existing narrow owner.
2. Compose it in one `scripts/github/workflow/` use case and wire that use case
   in `create-workflow.mjs`.
3. Keep `github/cli.mjs` to parsing, invocation, rendering, and error mapping.
4. For a mutation, add deterministic journal intent, live rereads, race guards,
   and the exact state service that accepts the evidence.
5. Update `github.mjs` only for a deliberately public consumer contract.

### Add an adapter, hook, or external handoff

1. Keep the checked-in adapter thin and point it at a public façade or CLI.
2. Define an explicit exact-commit contract; never share mutable internal
   objects across capabilities.
3. Update `ownership.json`, structural tests, package scripts or hook discovery,
   and focused help/status tests together.
4. Link to the owning capability's normative documentation instead of copying
   its rules here.

## Cross-capability coordination

The review orchestrator calls release-state and released-migration checks but
does not own their implementation. It consumes explicit related-E2E selectors
and browser projects but does not scan feature files heuristically. It consumes
specialist routes and exact-HEAD results but does not redefine the specialist
registry. It may later accept an issue #25 PR-preparation handoff, but only
through a reviewed exact-SHA interface; until that lands, standalone explicit
PR initialization remains the supported boundary.

When a change spans these boundaries, split ownership into dependent tasks and
serialize shared `.agents/**`, `.codex/**`, `.github/**`, and package-manifest
surfaces. The capability's operator, state, orchestration, and GitHub rules stay
in their existing canonical references.
