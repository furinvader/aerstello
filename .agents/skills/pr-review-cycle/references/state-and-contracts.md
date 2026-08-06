# Durable state and machine contracts

Read this reference before initializing, recovering, migrating, checkpointing,
archiving, or delegating a task.

## State location and ownership

Mutable state is repository-scoped and outside tracked worktrees:

```text
<absolute-git-common-dir>/codex/pr-review/
├── active.json
├── pr-<number>/
│   ├── state.json
│   ├── state.backup.json
│   ├── targeted-validation-plan.json
│   └── events.ndjson
└── archive/
```

Only the main orchestrator is the logical writer. Writes are locked,
revision-checked, schema-validated, limited to 64 KiB, and committed by atomic
rename. Keep raw logs, full diffs, stack traces, and transcripts out of state.

## State commands

```bash
node scripts/pr-review-state.mjs init --pr 123 --base origin/main --head HEAD
node scripts/pr-review-state.mjs path
node scripts/pr-review-state.mjs validate
node scripts/pr-review-state.mjs validate-result --task-packet /tmp/task.json --worker-result /tmp/result.json
node scripts/pr-review-state.mjs validation-plan /tmp/task-a.json /tmp/task-b.json
node scripts/pr-review-state.mjs validation-plan --replace /tmp/task-a.json /tmp/task-b.json
node scripts/pr-review-state.mjs run-validation
node scripts/pr-review-state.mjs show
node scripts/pr-review-state.mjs migrate
node scripts/pr-review-state.mjs recover
node scripts/pr-review-state.mjs checkpoint --input /tmp/state.json --expected-revision 4
node scripts/pr-review-state.mjs archive
node scripts/pr-review-state.mjs archive --abandon-reason "superseded PR"
```

`init` derives the repository only from an unambiguous GitHub `origin` and never
guesses a PR number. Pass `--repository owner/name` when needed. `checkpoint`
replaces the complete document and rejects revision drift. Normal archival
requires Done; earlier archival requires an explicit durable abandonment reason.

State schema v3 upgrades are explicit. Migration from v1 or v2 first saves an
exact versioned backup and must preserve stable finding/task identities, source
IDs, finding keys, and outcomes. Never let an unrelated read silently migrate
state.

`targeted-validation-plan.json` is a resumable sidecar, not trusted input to a
generic checkpoint. `validation-plan` derives its deterministic, de-duplicated
commands from fixed task packets and requires those packet IDs to exactly match
the actionable Integrated tasks. It preserves affected areas plus each check's
kind, reason, E2E selectors, and browser projects, and binds them to the state
revision and integration commit. `run-validation` serializes execution,
executes the saved argv directly without a shell, records each attempted command
atomically, and holds the same PR lock until a guarded transition turns the
finished plan into targeted validation proof. Recovery output reports plan progress.
Old or migrated states have no plan and must be validated again before review.

## What state must preserve

Use `docs/agents/pr-review-state.schema.json` as the machine contract. Preserve:

- base, requested, reviewed, integration, validation, and current Git SHAs as
  separate values;
- GitHub IDs, URLs, request kind, timestamps, and review outcome evidence;
- release evidence from `scripts/release-state.mjs`;
- stable decision, finding, and task identities;
- targeted local validation and full GitHub Actions validation, each tied to an
  exact commit and recording its source, scope, and result;
- full E2E evidence for the Review commit;
- a fresh list of open Codex thread IDs for the current commit;
- concise errors and one explicit next action.

Human terms translate to the current machine fields as follows:

| Human term | Machine representation |
| --- | --- |
| Review commit | Recorded requested SHA/current PR head |
| Integrated | Task status `integrated` |
| Resolved | Task status `completed` |
| Done | Cycle phase `complete` |

Do not collapse these states. Head drift makes prior targeted validation,
review, CI, and thread confirmation stale. A cycle is Done only when all gates
refer to the same Review commit.

Keep terminal records compact. Git, GitHub, CI artifacts, and concise
`events.ndjson` entries carry execution detail.

## Fixed task instructions

Validate tasks against `docs/agents/review-fix-task.schema.json`. The machine
contract is called a task packet; human guidance calls it fixed task
instructions. It must include the Review commit, finding and evidence, decisions,
dependencies, affected areas, owned and forbidden paths, acceptance criteria,
and exact validation commands. When E2E is relevant, record exact scenario
selectors, browser projects, and the reason for each selection.

`affectedAreas` must include at least one recognized code or policy area: `api`,
`web`, `shared`, `workflow`, `documentation`, `release`, or `migration`. Worker
commands remain the worker's targeted checks. The orchestrator separately adds
deterministic integrated-area checks when it builds the batch validation union.
Validation commands use the direct-command allowlist: no environment prefixes,
shells or other wrappers, control or redirection syntax, npm option wrappers,
globs, substitutions, or broad root/full-suite commands. Related E2E is valid
only through the exact repository wrapper with matching selector and project
metadata, recorded as system validation.

Instructions do not change after delegation. An unknown related command,
selector, or project is a planning error. Fix the plan instead of asking a
worker to choose tests or run a full local fallback.

## Worker results

Validate results against `docs/agents/review-fix-result.schema.json`. A worker
returns one raw JSON object with status `implemented`, `blocked`,
`not-applicable`, or `failed`. `implemented` requires a commit SHA. Each
validation entry records only its exact command, result, and concise summary.
`validate-result` proves that the Review commit and worker commit exist, proves
ancestry, and derives the NUL-delimited, no-renames tree diff between them.
Implemented work requires a nonempty diff. Reject any mismatch between those
Git-derived paths and the reported unique `changedPaths`, missing required
validation, ownership violation, unexpected path, or raw log.

The orchestrator alone decides whether to accept and Integrate a result.
