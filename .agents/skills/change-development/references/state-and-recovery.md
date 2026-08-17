# State and recovery contract

## Shared layout

Mutable state lives below `<git-common-dir>/codex/change-development/`, so linked worktrees see one active lifecycle:

```text
change-development/
├── active.json
├── locks/
│   ├── lifecycle.lock/
│   └── <change-id>.lock/
├── archive-lifecycle.json            # atomic self-digesting envelope; present only during archive
├── archives/<change-id>/
│   └── archive-receipt.json[.sha256]
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
    └── transitions/
        ├── .<eight-digit-revision>.<pid>.<uuid>.pending/ # uncommitted; rollback-only
        └── <eight-digit-revision>/
            ├── intent.json[.sha256]
            ├── receipt.json[.sha256]
            └── complete
```

Source observations and committed transition directories use eight-digit revision names; amendments use four-digit sequence names. A pending transition directory is transient staging and does not establish an intent. Recovery may remove only a recognized pending directory with the expected staging contents; it never promotes one. The root archive lifecycle is one atomically written envelope whose `intentDigest` binds its embedded intent, with no companion receipt. An archived change separately receives the immutable `archive-receipt.json` and its SHA-256 receipt. Bracketed `.sha256` denotes the canonical receipt beside its JSON artifact. `worktree.json` binds local Git checkpointing to the linked worktree that initialized the change: all linked worktrees share the common-directory state, but `PreCompact` from another worktree warns and leaves its Git observation unchanged.

Large immutable evidence stays outside `state.json`. Initial and refreshed source observations, accepted plan, decision records, and amendments use canonical JSON SHA-256 receipts. `state.json` contains bounded mutable coordination data: mode, phase, revision, source/plan digests, current Git observation, unresolved decisions, checklist status, and the exact next action.

## Phases

- `initializing`: durable creation has started but has not completed.
- `planning`: source is stable and the plan is being prepared or validated.
- `awaiting-decision`: an accepted plan requires an explicit source-drift decision.
- `ready-to-implement`: accepted plan and readiness evidence are complete.
- `blocked`: integrity, evidence, or repository state prevents safe continuation.
- `recovering`: an exact interrupted transition is being verified and completed.
- `abandoned`: the operator intentionally ended the change without implementation readiness.

`plan-only` reaches normal completion at `ready-to-implement` and may be archived. `implement` and `full` remain active there for the later implementation workflow.

## Locking and transitions

Initialization, `active.json`, and archive operations take the global lifecycle lock. State transitions take the per-change lock. If both are needed, always acquire global then change; never invert that order. A stale lock is reclaimed only after the fixed threshold when its recorded process is dead on the current host, or when an incomplete lock has remained stale for that threshold. Other contention times out; never delete a lock heuristically.

Every transition has a proposed revision, intent record, receipt, concise event, and completion marker. The intent becomes committed only when its fully written staging directory is atomically renamed to the eight-digit revision directory. It embeds `authoritativeEvidence` entries with each domain sidecar's exact path, label, canonical digest, and complete value. State, receipts, and completion markers use atomic `fsync` plus rename writes. `events.jsonl` is canonically reconstructed and atomically rewritten instead of appended in place. Revision mismatches fail closed. Network work is never performed while a state lock is held.

## Recovery

Run `npm run change:status` first. Use `recover` only when its exact next action identifies an interrupted transition. Recovery may complete a transition only when its intact committed intent, current revision, digests, repository observation, and enumerated crash boundary match exactly. From the intent's authoritative bundle it may materialize only the exact bound domain sidecar or a missing matching sidecar receipt. It may also reconstruct the exact deterministic transition receipt, canonical event history, and completion marker.

Candidate-plan readiness is likewise receipt-bound: `validate --plan` first validates the active durable state and source evidence, then requires exact candidate identity at that state's Planning SHA. With no active state, schema inspection is possible but acceptance readiness is false.

An interrupted non-retain `decision-recorded` transition may resume only when
its predecessor contains an accepted plan in `awaiting-decision` and at its
exact initiating Git observation: HEAD, branch or detached state, and
cleanliness must all match the observation already bound into the intended next
state. Recovery verifies the immutable decision record and reconstructs the
transition semantics before allowing that exception. Planning-phase decision
intents, relabeled intents, and inconsistent evidence are rejected;
`retain-plan` continues to require clean HEAD at the Planning SHA.

A missing or tampered committed intent, its SHA-256 receipt, or its authoritative evidence bundle blocks recovery. Existing domain evidence or receipts that conflict with the embedded path, value, or digest also block; orphan evidence is never attached heuristically. Recovery does not invent evidence beyond an intact authoritative intent, skip revisions, or delete locks. A recognized transient pending directory is uncommitted and rollback-only. Resolve other integrity failures through an explicit authorized decision or amendment when the state machine permits it; otherwise abandon while retaining evidence.

`SessionStart` may report bounded recovery context. `PreCompact` performs only local filesystem and Git observation, may append a revision-guarded Git checkpoint under the change lock, and performs no source refresh or network work. Its durable state preserves the exact next action so a resumed session can continue safely.
