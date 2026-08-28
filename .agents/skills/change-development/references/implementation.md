# Implementation contract

## Upgrade and bind

New durable records use development-state v2. A historical v1 record and its
transition chain remain valid, but no execution transition may rewrite it
implicitly. At an accepted `ready-to-implement` boundary, run:

```bash
npm run change:state -- upgrade-state \
  --change-id <change-id> --expected-revision <revision>
```

The upgrade requires the exact clean central HEAD and named branch recorded by
v1 state. Plan acceptance in `implement` and `full` mode has the same
named-branch requirement; detached plan acceptance and archival remain valid
for `plan-only`. It writes a receipt-protected transition and derives compact task
summaries from the effective accepted plan.

Execution advancement is authoritative only for changes initialized in
`implement` or `full` mode. Upgrade, binding, wave scheduling, task start,
result acceptance, integration, reconciliation, and finalization all enforce
that same gate. A `plan-only` change stops at its accepted plan; previously
invalid plan-only execution can still be rejected, cleaned up, amended, or
archived so operators can unwind it without granting further execution authority.

Create one implementation-task v1 JSON packet for a dependency-ready task,
then bind it:

```bash
npm run change:state -- bind-task \
  --change-id <change-id> --expected-revision <revision> \
  --packet /path/to/task-packet.json
```

The packet repeats the exact change, plan revision and digest, Planning SHA,
current clean task base SHA, specialization and route, decision resolutions,
acceptance criteria, dependencies, and direct required validation. Its allowed
paths must be within the plan's anticipated ownership; forbidden paths and
commands may narrow that scope. Binding cannot expand or reinterpret the plan,
and dependencies must already be `integrated` or `no-change`. The canonical
packet and SHA-256 receipt live below
`implementation/tasks/<task-id>/<binding>.json[.sha256]`. Separate immutable
provenance, planning-signal, specialist-route, and required behavior-mapper
sidecars repeat its plan-bound evidence. Routed behavior-mapper evidence must
exactly equal the receipt-protected clean evidence selected by both the packet's
plan revision and digest; a clean report cannot contain findings, and amendment
replay never substitutes evidence from a later revision. A changed packet requires explicit
rejection and a plan amendment; no sidecar is rewritten.

Binding is the live-policy boundary: every new binding reloads the current
specialist registry and rejects a stale specialization or route before writing
packet, provenance, event, or transition evidence. It also preflights final
verifier capacity through the canonical final-context composer, overlaying the
pending packet before writing any packet, provenance, route, receipt, event,
transition, or state. It rejects validation metadata conflicts with
affected-area checks or any still-authoritative packet, including retained
terminal packets. No admission path truncates or drops semantic evidence.
After binding, the packet's
canonical digest and durable replay use its immutable structural contract plus
the receipt-bound route, planning-signal, and behavior-mapper sidecars. Results,
recovery, cleanup, and finalization never reinterpret historical packet authority
through a later registry revision; a packet bound after that revision must obey it.

Each packet also binds the current minimal-closure digest, criterion need,
removal counterfactual, forbidden-expansion statements, deterministic scope
tripwires, and worker discovery return contract. A triggered task boundary
requires a current applicable `task`-phase scope assessment before binding.
Workers report structured tripwire differences and unexpected dependencies but
cannot change paths, criteria, dependencies, public or persistent surfaces,
validation, or authority. Discovery returns to central assessment and replan;
it is never silently absorbed into the worker commit.

Plan ownership can never name `.git` as a root or nested exact path segment;
`.git`, `.git/config`, and `nested/.git/hooks` are repository metadata rather
than implementation surfaces. Lookalikes such as `.gitignore`, `.github`, and
`nested/.gitkeep` remain ordinary repository paths. Receipt-valid historical
plans are replayed unchanged, but an unsafe historical ownership entry cannot
bind an executable packet: append an explicit amendment replacing it with safe
ownership before binding.

When related E2E validation names a selector that the task itself will add, the
packet may declare `plannedE2ESelectors` entries binding each selector to one
owned, non-forbidden `specs/features/**/*.feature` path. This optional field is
part of the canonical packet digest, while structural validation remains
checkout-independent. Binding proves existing selectors against the exact task
base Git tree and rejects planned selectors that already exist. Result
acceptance proves every planned selector was introduced at its declared path in
the exact worker commit. Exact-tree indexing retains every canonical
`@tag-token` occurrence for base-collision detection, but realization follows
related-E2E runnable association: feature tags inherited by a `Scenario` or
`Scenario Outline`, and tags directly attached to either declaration, count as
runnable only when that scenario's directly attached tags contain exactly one
stable `@id-*` selector. A feature-level ID is inherited as a selector but does
not satisfy the scenario-ID requirement. Missing or duplicate directly attached
stable IDs, orphan tags, and tags cleared by unsupported constructs do not
realize any selector for that scenario, even if the same packet realizes a
different selector. Selector-like text in comments and step prose is ignored
during binding, acceptance, and durable replay. For the OR-union of scenarios
matched by a validation's selectors, `@browser-webkit` requires
`mobile-webkit` and `@browser-firefox` requires `desktop-firefox`; every
required project must be present, while extra projects are allowed. Existing
selectors are checked in the exact task-base tree, and planned selectors plus
their browser-project union are re-evaluated in the exact worker tree during
acceptance and durable replay. A packet carrying related-E2E selector validation
first proves the whole exact-tree feature catalog is valid: every `Scenario` and
`Scenario Outline` must have exactly one directly attached stable `@id-*`,
including scenarios unrelated to the packet selectors. Feature-level tags may
still be inherited, but do not satisfy that direct stable-ID requirement. The
same whole-catalog proof runs at the worker commit before result evidence is
accepted and is repeated from the immutable base and worker commits during
durable replay. Packets without related-E2E selectors remain independent of
unrelated feature-catalog validity; this includes unit-only packets and valid
non-E2E system validations whose selector and project metadata are both empty.
Unknown, unsafe, duplicate,
unused, unowned, forbidden, or unrealized declarations fail closed. Packets
without the field retain the original contract.

## Isolated worktrees and waves

Create, inspect, and remove the packet-bound worker worktree through the facade:

```bash
npm run change:worktree -- create \
  --change <change-id> --task <task-id> \
  --base <full-task-base-sha> --packet <sha256:packet-digest>
npm run change:worktree -- inspect --change <change-id> --task <task-id>
npm run change:worktree -- recover --change <change-id> --task <task-id>
npm run change:worktree -- remove --change <change-id> --task <task-id>
```

Creation is allowed only for the receipt-valid bound packet named by active v2
state. It uses the deterministic branch `codex/change-<change-id>/<task-id>` and
an owned path below the shared change-development root. Immutable manifest and
receipt evidence prevent identity, repository, path, base, or packet collisions.
Creation takes the per-change state lock while it revalidates bound-task
authorization and writes the complete receipt-protected creation intent. It
releases that lock before physical `git worktree add`; interruption after the
intent is recovered only from that exact durable identity. Receipt-backed
creation/removal intents make interruption recoverable without guessing.
Removal is allowed only after state records integration, `no-change`,
or explicit rejection; it refuses a dirty or unregistered worktree, records a
receipt-protected tombstone, and preserves the task branch for audit.

Bind only the dependency-ready tasks intended for the next non-conflicting
wave, then create their worktrees and schedule the wave. Integrate every
accepted result before scheduling a later wave; terminal `no-change` work does
not require integration. A conflicting task
waits to bind until earlier integration advances the central base:

```bash
npm run change:state -- schedule-wave \
  --change-id <change-id> --expected-revision <revision>
npm run change:state -- start-task \
  --change-id <change-id> --expected-revision <revision> \
  --task-id <task-id> --worker-id <stable-worker-id>
```

Scheduling is deterministic, caps a wave at three tasks, and serializes tasks
whose path ownership overlaps or whose produced/consumed artifacts conflict.
Repository-root and nested `package.json` or `package-lock.json` paths are shared
surfaces. The exact roots and descendants of `.agents`, `.codex`, `.github`, and
`apps/api/migrations` are also shared and serialize against unrelated writers;
segment lookalikes such as `.agentsx`, `.codex-notes`, `.githubish`, and
`apps/api/migrations-old` are ordinary disjoint ownership. Scheduling also transiently reads every eligible receipt-bound packet
in accepted-plan order and admits only the first task that declares a given
planned E2E selector; a later duplicate owner stays bound only until the first
owner integrates, while tasks with distinct selectors may run together. That
integration advances central HEAD, so the duplicate owner's old-base packet is
then stale: scheduling rejects it with `TASK_BASE_STALE`, and it must be
explicitly rejected and replaced through the amendment/replan flow before the
replacement is bound at the advanced central HEAD. Selector ownership is not
added to the durable execution summary or schemas.
Every task in a wave shares the recorded clean central base and must already
have a complete receipt-valid active worktree manifest; an interrupted creation
remains bound until `change:worktree recover` completes it. Start each scheduled
task before invoking the exact `implementation_worker` adapter in its assigned
worktree with its immutable packet. A worker cannot delegate, widen
scope, change validation, integrate, push, or mutate central durable state.

## Results

The worker's final message is one raw implementation-result v1 JSON object with
status `implemented`, `blocked`, `failed`, or `no-change`. Accept it with:

```bash
npm run change:state -- accept-result \
  --change-id <change-id> --expected-revision <revision> \
  --result /path/to/result.json --worker-cwd /path/to/worker-worktree
```

The result must repeat the packet identities, digest, specialization, and task
base, and must report the exact required validation commands. For
`implemented`, Git must prove exactly one direct descendant commit from the
task base; NUL-delimited changed paths must exactly match the result and remain
inside allowed paths and outside forbidden paths. For `no-change`, the worker
checkout must be clean and still exactly at the task base; a packet declaring
`plannedE2ESelectors` cannot complete as `no-change` because those selectors
were proven absent at binding and must be realized by an implementation.
`blocked` and `failed` remain valid fail-closed outcomes, carry no worker commit,
and move durable state to `blocked`; do not claim success or silently expand
the packet. Both successful outcomes, `implemented` and `no-change`, require
every exact packet validation command to report `passed`; rejected success
evidence cannot advance the task or satisfy dependencies. Each attempt result is preserved at
`implementation/results/<task-id>/<attempt>.json[.sha256]`.
Before preserving any result, the lifecycle overlays its exact summary,
validation records, unexpected dependencies, changed-path authority, and
terminal authority into the canonical verifier projection. A successful result
retains the larger of deterministic integration and truthful
integration-conflict rejection/replacement authority already reserved when its
packet was bound. A `blocked` or `failed` result
omits impossible integration evidence and instead reserves one viable
rejection-bound replacement bundle: amendment and provenance, replacement
criterion and task, potential behavior-mapper evidence, result, validation,
and integration authority. Explicit rejection repeats this gate with the exact
rejected task before persistence. An oversized result or rejection leaves the
result sidecar, receipts, event log, transition inventory, and state
byte-for-byte unchanged and may be retried with consolidated evidence.
These remediation envelopes use bounded canonical summaries and exact known
task IDs, binding/attempt numbers, and invalidated-evidence paths. Their item
and serialized-byte footprints therefore include required identity
normalization and UTF-8 chunking before packet or result authority becomes
immutable.
The bound-packet projection uses all exact required validation commands and a
schema-minimal allowed changed path, while also preserving the complete
direct-rejection replacement branch. Result acceptance keeps the larger
success-versus-conflict-recovery branch until exact integration completes.
Integration therefore cannot strand a receipt-valid accepted result by
expanding the verifier envelope after the last write boundary that can reject
or consolidate it.
Failure and explicit-rejection blockers use one deterministic representation
capped at 2000 Unicode code points. Short blocker text is byte-for-byte
unchanged; longer text is marked as truncated while the complete prose remains
unchanged in its immutable result or rejection sidecar and replay regenerates
the same bounded blocker.

## Central integration

After all results in the active wave are accepted, integrate each accepted task
in dependency order:

```bash
npm run change:state -- integrate-task \
  --change-id <change-id> --expected-revision <revision> --task-id <task-id>
```

Integration is deliberately two-stage. Under the state lock, the command first
persists an integration intent binding the task, worker commit, exact clean
central base, and owning central branch. Outside the lock it cherry-picks that
commit only from that branch. It then reacquires
the lock and accepts only a clean, single-parent central commit whose delta is
equivalent to the worker commit. A failed cherry-pick leaves the durable intent
in `integrating` for inspection; never discard or overwrite it. One
per-change integration-operation lock spans all three stages, and
`reject-task` takes the same lock before its state lock. Consequently same-task
and sibling rejection cannot race integration or clean-base reconciliation;
rejection also refuses whenever Git still reports `CHERRY_PICK_HEAD`, even when
the index and porcelain are otherwise clean. The operator must explicitly abort
or skip the cherry-pick before rejection can preserve or clear integration intent;
after sequencer cleanup, rejection still refuses a sibling task while the durable
intent names another task. Reconcile or reject the intent-owning task first; only
that task may clear its persisted intent. Normal failure releases ownership and
interrupted ownership follows the exact
dead-owner reclaim and reconciliation path.

If one wave member reports `blocked` or `failed`, or is explicitly rejected, a
dependency-ready accepted sibling remains integrable after the active wave
closes. The complete blocked-reason list must exactly equal canonical
receipt-backed task blockers in accepted-plan order; any Git, integrity, or
other non-task blocker prevents integration. Reconciliation restores every
remaining failure and rejection blocker and returns state to `blocked`.
Rejection evidence is immutable and identity-bound to the task packet; missing,
duplicate, or mismatched evidence fails closed. A task whose dependency failed
or was rejected is never eligible.

If the process stops after intent persistence or after a successful
cherry-pick, use the exact revision reported by status:

```bash
npm run change:state -- reconcile-integration \
  --change-id <change-id> --expected-revision <revision>
```

If the clean central checkout is still on the recorded owning branch at the
recorded base, reconciliation applies the exact persisted worker commit before
checking it. It rejects a detached or different branch, a dirty checkout, or
unrelated/non-equivalent central work. If a conflict reveals an
unplanned dependency, abort only Git's in-progress cherry-pick back to the
recorded base, then record rejection before removing the worktree:

```bash
npm run change:state -- reject-task \
  --change-id <change-id> --expected-revision <revision> \
  --task-id <task-id> --reason "<concise reason>"
npm run change:worktree -- remove --change <change-id> --task <task-id>
```

Append a plan amendment that replaces the rejected task with a new task ID and
explicitly lists every stale packet, result, and provenance path in
`invalidatedEvidence`. The Planning SHA remains immutable while the amendment
records the current clean integration HEAD; completed task definitions and
their referenced decisions and criteria cannot change.

After every task is `integrated` or `no-change`, remove each terminal worktree
and finish the bounded handoff:

```bash
npm run change:state -- finalize-integration \
  --change-id <change-id> --expected-revision <revision>
```

Only this tombstone-verified transition reaches `integrated`. In `implement` or
`full` mode, continue through the local verification lifecycle described in
[verification](verification.md): persist and run the exact-HEAD validation
plan, derive reusable reviewers from receipt-valid stored packet routes, record
their results in canonical order, run the workflow-owned read-only final
verifier, and disposition any findings. The validation and specialist phases
never reinterpret a terminal packet through the live registry.

Before targeted validation starts, the exact integrated HEAD needs one current
applicable `within-scope` assessment bound to the effective plan, ordered
amendment receipts, current minimal closure, terminal task-set digest, and
exact HEAD. Trim creates bounded removal or simplification work; material or
insufficient authority blocks. Later handoff consumes only the pure bounded
projection documented in the [operator guide](../README.md), never worker or
integration lifecycle authority.

An actionable finding returns to ordinary implementation only through a
fingerprint-triggered append-only amendment that adds new remediation criterion
and task IDs, covers every actionable sibling, and preserves every terminal
task plus its referenced decisions and criteria. After remediation integration,
start a new verification round at the new exact HEAD; prior rounds remain
immutable. Stop at `development-ready`, not `integrated`. That final state is
local evidence only: push, PR preparation, GitHub writes, official review, CI,
delivery, and merge remain separate workflows.

Abandonment follows the same cleanup authority boundary. Reject active work,
recover any partial creation or removal, remove it while active state still
authorizes cleanup, and verify receipt-valid tombstones plus physical path and
Git worktree-registration absence before archiving. Archived state never grants
worktree deletion authority.
