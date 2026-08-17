# Implementation contract

## Upgrade and bind

New durable records use development-state v2. A historical v1 record and its
transition chain remain valid, but no execution transition may rewrite it
implicitly. At an accepted `ready-to-implement` boundary, run:

```bash
npm run change:state -- upgrade-state \
  --change-id <change-id> --expected-revision <revision>
```

The upgrade requires the exact clean central HEAD and branch recorded by v1
state. It writes a receipt-protected transition and derives compact task
summaries from the effective accepted plan.

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
sidecars repeat its plan-bound evidence. A changed packet requires explicit
rejection and a plan amendment; no sidecar is rewritten.

When related E2E validation names a selector that the task itself will add, the
packet may declare `plannedE2ESelectors` entries binding each selector to one
owned, non-forbidden `specs/features/**/*.feature` path. This optional field is
part of the canonical packet digest, while structural validation remains
checkout-independent. Binding proves existing selectors against the exact task
base Git tree and rejects planned selectors that already exist. Result
acceptance proves every planned selector was introduced at its declared path in
the exact worker commit. Unknown, unsafe, duplicate, unused, unowned,
forbidden, or unrealized declarations fail closed. Packets without the field
retain the original contract.

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
Receipt-backed creation/removal intents make interruption recoverable without
guessing. Removal is allowed only after state records integration, `no-change`,
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
the packet. Each attempt result is preserved at
`implementation/results/<task-id>/<attempt>.json[.sha256]`.

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
in `integrating` for inspection; never discard or overwrite it.

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

Only this tombstone-verified transition reaches `integrated`. Stop there:
integrated-HEAD specialist verification, PR preparation, GitHub writes,
CI/review gates, and delivery are owned by issue #24 and later workflows.
