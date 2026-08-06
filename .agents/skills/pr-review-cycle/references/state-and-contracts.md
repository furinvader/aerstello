# State and contract reference

## Contents

- [State location](#state-location)
- [State commands](#state-commands)
- [Active state](#active-state)
- [Task packets](#task-packets)
- [Worker results](#worker-results)

## State location

Mutable state is repository-scoped and outside the tracked worktree:

```text
<absolute-git-common-dir>/codex/pr-review/
├── active.json
├── pr-<number>/
│   ├── state.json
│   ├── state.backup.json
│   └── events.ndjson
└── archive/
```

Only the primary orchestrator is the logical writer. Writes are revisioned,
locked, validated, limited to 64 KiB, and committed with temporary-file rename.
Keep raw logs, complete diffs, stack traces, and transcripts out of state and
events.

Active state uses schema version 2. Loading version 1 does not silently upgrade
it: the orchestrator must run the explicit atomic migration, which first keeps a
pre-migration backup. Migration preserves stable task/finding identities,
source IDs, fingerprints, and dispositions while compacting terminal execution
details.

## State commands

```bash
node scripts/pr-review-state.mjs init --pr 123 --base origin/main --head HEAD
node scripts/pr-review-state.mjs path
node scripts/pr-review-state.mjs validate
node scripts/pr-review-state.mjs show
node scripts/pr-review-state.mjs migrate
node scripts/pr-review-state.mjs recover
node scripts/pr-review-state.mjs checkpoint --input /tmp/state.json --expected-revision 4
node scripts/pr-review-state.mjs archive
node scripts/pr-review-state.mjs archive --abandon-reason "superseded PR"
```

`init` derives `owner/name` only from an unambiguous GitHub `origin`; otherwise
pass `--repository owner/name`. It never discovers or guesses a PR number.
`checkpoint` replaces the complete document and fails on revision drift.
Normal archival requires phase `complete`; any earlier phase requires an
explicit abandonment reason, which is stored with the archived cycle.

## Active state

Use `docs/agents/pr-review-state.schema.json` as the wire contract. Preserve:

- base, requested, reviewed, and integration SHAs as distinct values;
- GitHub node/database IDs and URLs;
- a release baseline derived from `scripts/release-state.mjs`;
- stable decision/task IDs and semantic fingerprints;
- discovery versus verification request kind and the one-time verification
  allowance;
- review outcome evidence and an exact-head thread-resolution proof containing
  the unresolved thread IDs;
- concise validation and error summaries;
- one explicit next action.

`integrated` records that a worker change landed centrally. `completed` records
that the source thread was answered and resolved, or that a threadless task
passed verification. `complete` is the cycle phase after a clean exact-head
review outcome, zero unresolved threads, current validation, clean Git, and all
tasks completed. Completion requires equality among the request, outcome,
requested, reviewed, integration, validation, thread-proof, and live Git SHAs.
Head drift invalidates validation and thread proof and returns terminal or
review-ready state to recovery. Retain terminal tasks only as compact identity,
source, fingerprint, disposition, integration, and resolution summaries. Put
execution detail in Git, GitHub, CI artifacts, or concise `events.ndjson`
entries.

## Task packets

Validate against `docs/agents/review-fix-task.schema.json`. A packet is
immutable after delegation and includes the exact reviewed head, normalized
finding/evidence, decisions, dependencies, owned paths, forbidden paths,
acceptance criteria, and required validation.

## Worker results

Validate against `docs/agents/review-fix-result.schema.json`. The worker emits
one raw JSON object with status `implemented`, `blocked`, `not-applicable`, or
`failed`. `implemented` requires a commit SHA. Validation entries contain only
command, result, and concise summary. Never accept raw logs or full diffs.
