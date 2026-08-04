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
locked, validated, limited to 30 KB, and committed with temporary-file rename.
Keep raw logs, complete diffs, stack traces, and transcripts out of state and
events.

## State commands

```bash
node scripts/pr-review-state.mjs init --pr 123 --base origin/main --head HEAD
node scripts/pr-review-state.mjs path
node scripts/pr-review-state.mjs validate
node scripts/pr-review-state.mjs show
node scripts/pr-review-state.mjs recover
node scripts/pr-review-state.mjs checkpoint --input /tmp/state.json --expected-revision 4
node scripts/pr-review-state.mjs archive
```

`init` derives `owner/name` only from an unambiguous GitHub `origin`; otherwise
pass `--repository owner/name`. It never discovers or guesses a PR number.
`checkpoint` replaces the complete document and fails on revision drift.

## Active state

Use `docs/agents/pr-review-state.schema.json` as the wire contract. Preserve:

- base, requested, reviewed, and integration SHAs as distinct values;
- GitHub node/database IDs and URLs;
- a release baseline derived from `scripts/release-state.mjs`;
- stable decision/task IDs and semantic fingerprints;
- concise validation and error summaries;
- one explicit next action.

Retain completed tasks only as concise summaries. Put detailed history in Git,
GitHub, CI artifacts, or concise `events.ndjson` entries.

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
