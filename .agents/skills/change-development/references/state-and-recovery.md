# State and recovery contract

## Shared layout

Mutable state lives below `<git-common-dir>/codex/change-development/`, so linked worktrees see one active lifecycle:

```text
change-development/
├── active.json
├── locks/
│   ├── lifecycle.lock/
│   ├── <change-id>.lock/
│   └── operations/<change-id>.integration.lock/
├── archive-lifecycle.json            # atomic self-digesting envelope; present only during archive
├── archives/<change-id>/
│   └── archive-receipt.json[.sha256]
├── worktrees/
│   ├── changes/<change-id>/<task-id>/     # registered worker worktree
│   ├── manifests/<change-id>/
│   │   ├── <task-id>.creation.json[.sha256]
│   │   └── <task-id>.json[.sha256]
│   └── tombstones/<change-id>/
│       ├── <task-id>.removal.json[.sha256]
│       └── <task-id>.json[.sha256]
└── changes/<change-id>/
    ├── state.json
    ├── events.jsonl
    ├── worktree.json[.sha256]
    ├── source/
    │   ├── initial.json[.sha256]
    │   └── observations/<revision>.json[.sha256]
    ├── plan/
    │   ├── plan.json[.sha256]
    │   ├── planning-evidence.json[.sha256]
    │   └── amendments/
    │       ├── <number>.json[.sha256]
    │       └── <number>.evidence.json[.sha256]
    ├── decisions/<decision-id>.json[.sha256]
    ├── implementation/
    │   ├── tasks/<task-id>/<binding>.json[.sha256]
    │   ├── provenance/<task-id>/<binding>.json[.sha256]
    │   ├── planning-signals/<task-id>/<binding>.json[.sha256]
    │   ├── specialist-routes/<task-id>/<binding>.json[.sha256]
    │   ├── behavior-mapper/<task-id>/<binding>.json[.sha256] # when routed
    │   ├── results/<task-id>/<attempt>.json[.sha256]
    │   └── rejections/<task-id>/<revision>.json[.sha256]
    ├── verification/
    │   ├── rounds/<round>/
    │   │   ├── validation-plan.json[.sha256]
    │   │   ├── validation-intents/<command-id>.json[.sha256]
    │   │   ├── validation-results/<command-id>.json[.sha256]
    │   │   ├── specialist-plan.json[.sha256]
    │   │   ├── specialists/<reviewer-id>.json[.sha256]
    │   │   ├── verifier-context.json[.sha256]
    │   │   ├── verifier-result.json[.sha256]
    │   │   └── findings/<fingerprint>.json[.sha256]
    │   └── authorizations/<fingerprint>/<round>.json[.sha256]
    └── transitions/
        ├── .<eight-digit-revision>.<pid>.<uuid>.pending/ # uncommitted; rollback-only
        └── <eight-digit-revision>/
            ├── intent.json[.sha256]
            ├── receipt.json[.sha256]
            └── complete
```

Source observations and committed transition directories use eight-digit revision names; amendments use four-digit sequence names. A pending transition directory is transient staging and does not establish an intent. Recovery may remove only a recognized pending directory with the expected staging contents; it never promotes one. The root archive lifecycle is one atomically written envelope whose `intentDigest` binds its embedded intent, with no companion receipt. An archived change separately receives the immutable `archive-receipt.json` and its SHA-256 receipt. Bracketed `.sha256` denotes the canonical receipt beside its JSON artifact. `worktree.json` binds local Git checkpointing to the linked worktree that initialized the change: all linked worktrees share the common-directory state, but `PreCompact` from another worktree warns and leaves its Git observation unchanged.

Large immutable evidence stays outside `state.json`. Initial and refreshed source observations, accepted plan, decision records, amendments, task packets, worker results, worktree manifests/tombstones, and verification rounds use canonical JSON SHA-256 receipts. `state.json` contains bounded mutable coordination data: mode, phase, revision, source/plan digests, current Git observation, unresolved decisions, checklist status, compact execution task summaries, the active wave of at most three task IDs, an optional integration intent, compact verification identities and counts, and the exact next action.

Development-state v1 remains a valid historical format so its immutable
transition intents can still be replayed. New records are v2. An accepted v1
record accepts and preserves its plan without synthesizing `execution`; it
moves to v2 only through the explicit `upgrade-state` transition at the
exact recorded clean, named-branch Git observation; ordinary execution writes
never perform an implicit upgrade. That transition preserves plan and Git identity while
creating receipt-valid unbound execution summaries.

## Phases

- `initializing`: durable creation has started but has not completed.
- `planning`: source is stable and the plan is being prepared or validated.
- `awaiting-decision`: an accepted plan requires an explicit source-drift decision.
- `ready-to-implement`: accepted plan and readiness evidence are complete.
- `implementing`: v2 task packets, waves, worker results, or dependency-ordered integration are in progress.
- `integrating`: a durable central integration intent exists and must be reconciled exactly.
- `integrated`: every planned task is integrated or receipt-backed `no-change`; exact-HEAD validation may start.
- `validating`: an immutable validation plan is pending, running, failed, or awaiting explicit replacement.
- `specialist-review`: validation passed and stored-route reviewer planning or canonical-order result collection is active.
- `verifying`: all routed specialist evidence is complete and the final verifier context/result or Development-ready finalization is pending.
- `development-ready`: every local exact-HEAD gate is receipt-valid, current, and clean; delivery authority is still absent.
- `blocked`: integrity, evidence, or repository state prevents safe continuation.
- `recovering`: an exact interrupted transition is being verified and completed.
- `abandoned`: the operator intentionally ended the change without implementation readiness.

`plan-only` reaches normal completion at `ready-to-implement` and may be
archived. `implement` and `full` continue through bounded execution,
integration, and local verification to `development-ready`. Push, PR, GitHub,
CI, review-cycle, delivery, and merge work remain outside this state machine.

## Locking and transitions

Initialization, `active.json`, and archive operations take the global lifecycle lock. State transitions take the per-change lock. If both are needed, always acquire global then change; never invert that order. A stale lock is reclaimed only after the fixed threshold when its recorded process is dead on the current host, or when an incomplete lock has remained stale for that threshold. Other contention times out; never delete a lock heuristically.

Integration and integration reconciliation additionally hold the per-change
integration-operation lock across intent persistence, external Git mutation,
and state reconciliation. Task rejection takes that same operation lock before
the ordinary change lock, so rejection cannot erase or reinterpret an intent
while Git is changing; this operation-before-change order must never be
inverted. Operation locks use the same owner-token, dead-owner, incomplete-lock,
timeout, and stale-reclaim rules. Failure releases live ownership, while a dead
owner is reclaimed only through those rules before exact reconciliation.

Worker creation takes only the per-change lock while it revalidates the active
bound packet and completes the receipt-protected creation intent. Physical Git
worktree creation happens after releasing that lock and may resume only from
the exact intent. Archive continues to take the global lifecycle lock before
the change lock. Thus creation cannot race archive before authority is durable:
creation-first makes archive wait and then requires normal worktree cleanup,
while archive-first removes active authorization so later creation leaves no
intent or Git identity. This does not invert the canonical lifecycle-then-change
order for operations that require both locks.

Every transition has a proposed revision, intent record, receipt, concise event, and completion marker. The intent becomes committed only when its fully written staging directory is atomically renamed to the eight-digit revision directory. It embeds `authoritativeEvidence` entries with each domain sidecar's exact path, label, canonical digest, and complete value. State, receipts, and completion markers use atomic `fsync` plus rename writes. `events.jsonl` is canonically reconstructed and atomically rewritten instead of appended in place. Revision mismatches fail closed. Network work is never performed while a state lock is held.

Central integration is a deliberate exception to a single locked filesystem
transition: `integrate-task` first commits the intent under the lock, runs
`git cherry-pick --no-edit` outside it, then reconciles under the lock. The
persisted intent is the only authority for an interrupted integration. The
owning central branch is part of that authority. A clean single-parent central
commit on that exact branch must have the recorded base as parent and an
equivalent delta to the recorded worker commit. `integrated` is a separate
receipt-protected finalization transition that also proves every terminal
worker manifest has a matching removal tombstone.

## Recovery

Run `npm run change:status` first. Use `recover` only when its exact next action identifies an interrupted transition. Recovery may complete a transition only when its intact committed intent, current revision, digests, repository observation, and enumerated crash boundary match exactly. From the intent's authoritative bundle it may materialize only the exact bound domain sidecar or a missing matching sidecar receipt. It may also reconstruct the exact deterministic transition receipt, canonical event history, and completion marker.

Git-checkpoint recovery has no evidence-free historical fallback. Its
authoritative bundle must contain the receipt-bound observation sidecar named
for that exact checkpoint revision, and recovery must match the current branch,
HEAD, and cleanliness to that observation. A checkpoint intent without that
exact observation is rejected without completing the transition or changing
state and event history.

Candidate-plan readiness is likewise receipt-bound: `validate --plan` first validates the active durable state and source evidence, then requires exact candidate identity at that state's Planning SHA. With no active state, schema inspection is possible but acceptance readiness is false.

An interrupted non-retain `decision-recorded` transition may resume only when
its predecessor contains an accepted plan in `awaiting-decision` and at its
exact initiating Git observation: HEAD, branch or detached state, and
cleanliness must all match the observation already bound into the intended next
state. Recovery verifies the immutable decision record and reconstructs the
transition semantics before allowing that exception. Planning-phase decision
intents, relabeled intents, and inconsistent evidence are rejected.
`retain-plan` requires the clean Planning SHA before execution and the exact
clean integrated HEAD once terminal task authority exists.

A missing or tampered committed intent, its SHA-256 receipt, or its authoritative evidence bundle blocks recovery. Existing domain evidence or receipts that conflict with the embedded path, value, or digest also block; orphan evidence is never attached heuristically. Recovery does not invent evidence beyond an intact authoritative intent, skip revisions, or delete locks. A recognized transient pending directory is uncommitted and rollback-only. Resolve other integrity failures through an explicit authorized decision or amendment when the state machine permits it; otherwise abandon while retaining evidence.

Validation execution is serialized by the same per-change operation lock used
to protect integration. A receipt-protected command intent precedes direct
`shell:false` argv execution. Retry reuses that exact intent and any existing
append-only result; it never invents another attempt or repeats a completed
command. Result recording and phase completion recheck the initiating revision,
plan/task-set identity, and exact clean HEAD. A crash at a normal transition
boundary is handled by `recover`; an intent whose command has no result is
resumed by `run-validation`. Failed plan evidence is retained.
`validation-plan --replace` creates a transient-rerun round; corrective work
uses the exact failed-result receipt to authorize an ordinary amendment.

A late source capture is receipt-protected at the exact integrated HEAD.
Progress-only drift clears stale verification proof and returns to `integrated`;
material drift preserves terminal task authority while entering the existing
decision/amendment route. Late retain-plan and source-driven amendments cannot
reuse validation, specialist, context, or verifier evidence from that round.

Specialist plans, canonical-order reviewer results, verifier contexts/results,
finding dispositions, and repeated-finding authorizations are ordinary
receipt-protected transition evidence. Recovery restores only values named by
an intact authoritative transition intent. It never reroutes historical
packets, reclassifies findings, deletes prior rounds, or authorizes remediation.
If the checkout HEAD changes, checkpointing blocks the current round; restoring
the exact HEAD may resume it, while an integrated remediation commit requires a
new round.

When state is `integrating`, use `reconcile-integration` rather than generic
`recover`. On the exact owning branch at the clean recorded base it applies the
persisted worker commit; at its clean resulting commit it verifies and records
the delta. A detached or different branch, dirty checkout, or
unrelated/non-equivalent commit fails closed and preserves the
intent for inspection. If inspection proves a real unplanned dependency, abort
only the in-progress cherry-pick to the intent base, record `reject-task`, remove
that rejected worktree, and append the explicit new-ID plan amendment. Do not
reset, repeat, or broaden work based on guesswork.

`SessionStart` may report bounded recovery context. `PreCompact` performs only local filesystem and Git observation, may append a revision-guarded Git checkpoint under the change lock, and performs no source refresh or network work. It refuses to checkpoint from a non-owning linked worktree and directs an active integration intent to `reconcile-integration`. Its durable state preserves the exact next action so a resumed session can continue safely.

An implementation-mode execution checkpoint validates the exact durable owning
branch, HEAD, and cleanliness. A `plan-only` lifecycle, including native v2
state with a non-null execution summary, instead uses the clean Planning SHA as
its checkpoint identity and may remain detached. In implementation modes,
branch drift, detached HEAD, an advanced commit, or dirtiness is
stored as receipt-protected observation evidence and blocks without replacing
the expected Git identity. Recovery uses the same derivation and requires that
exact recorded observation. Restoring identity clears only Git reasons:
plan-only or never-started execution returns to `ready-to-implement`, active or
terminal-but-unfinalized execution returns to `implementing`, finalized
integration returns to `integrated`, and receipt-valid verification summaries
return to their derived `validating`, `specialist-review`, or `verifying`
phase. A completed `development-ready` transition remains terminal. No
checkpoint can synthesize integration or development finalization.
