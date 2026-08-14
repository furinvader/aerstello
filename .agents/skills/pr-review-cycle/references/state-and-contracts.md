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
│   ├── task-packets/
│   │   └── <sha256(taskId)>.json
│   ├── specialist-reviews/
│   │   ├── <head>-r<revision>.json
│   │   └── <head>-r<revision>.plan.sha256
│   ├── targeted-validation-plan.json
│   └── events.ndjson
└── archive/
```

Only the main orchestrator is the logical writer. Writes are locked,
revision-checked, schema-validated, limited to 64 KiB, and committed by atomic
rename. Keep raw logs, full diffs, stack traces, and transcripts out of state.

## State commands

```bash
npm run review:state -- init --pr 123 --base origin/main --head HEAD
npm run review:state -- path
npm run review:state -- validate
npm run review:state -- bind-task-packet --task-packet /tmp/task.json --expected-revision 4
npm run review:state -- validate-result --task-packet /tmp/task.json --worker-result /tmp/result.json
npm run review:state -- specialist-plan --input /tmp/specialist-plan.json --expected-revision 4
npm run review:state -- specialist-record --input /tmp/specialist-result.json --expected-revision 4
npm run review:state -- specialist-context
npm run review:state -- validation-plan --initial-selection /tmp/initial-validation.json
npm run review:state -- validation-plan
npm run review:state -- validation-plan --replace
npm run review:state -- run-validation
npm run review:state -- show
npm run review:state -- migrate
npm run review:state -- recover
npm run review:state -- checkpoint --input /tmp/state.json --expected-revision 4
npm run review:state -- archive
npm run review:state -- archive --abandon-reason "superseded PR"
```

`init` derives the repository only from an unambiguous GitHub `origin` and never
guesses a PR number. Pass `--repository owner/name` when needed. `checkpoint`
replaces the complete document and rejects revision drift. Normal archival
requires Done; earlier archival requires an explicit durable abandonment reason.

State schema v3 upgrades are explicit. Migration from v1 or v2 first saves an
exact versioned backup and must preserve stable finding/task identities, source
IDs, finding keys, and outcomes. Never let an unrelated read silently migrate
state.

Before delegation, `bind-task-packet` atomically persists the complete accepted
schema-v3 packet under `task-packets/<sha256(taskId)>.json`, verifies its
canonical SHA-256 identity, and records that digest on its actionable task.
Object key order does not affect the digest; array order and every packet value,
including specialization and risks, do. The sidecar and binding are immutable.
Missing or changed sidecars fail recovery, result acceptance, validation
planning, and specialist routing.

Completed historical schema-v2 tasks remain readable. An unbound task may
receive an explicitly planned schema-v3 packet. An active task already bound to
a legacy packet cannot be inferred, silently rebound, or assigned a fallback
profile; it requires an explicit replan through the dedicated legacy error.
State remains schema v3 because canonical packets and specialist evidence are
durable, digest-verified sidecars rather than duplicated task fields.

`specialist-reviews/<head>-r<revision>.json` stores concise guarded planning and
review evidence. Its immutable planning fields are anchored by the adjacent
`.plan.sha256` receipt; reviewer records and operational timestamps are excluded
from the semantic plan identity. A receipt-only interrupted create reports
pending evidence and the same exact guarded plan may finish it; changed packets,
signals, or routes conflict. Pre-bind plans carry the full canonical
packet plus the explicit `browserVisible` and `testSelectionUncertain` signals
without adding those signals to task packets, and bind behavior-mapper evidence
to the packet's exact reviewed commit. Record, status, recovery, and binding
reads all verify the receipt and the packet's task ID, digest, specialization,
risk tags, and canonical route.
Post-integration plans cover the exact bound packets and required reviewers for
one integration HEAD. `specialist-record` accepts only the planned reviewer and
exact HEAD/revision. `specialist-context` is read-only and produces the guarded
input for the final verifier, including every exact immutable packet, its
canonical route, required reviewer results, and targeted-validation proof. Any
HEAD change makes the prior bundle stale; clean specialist evidence is not
task-resolution, GitHub, review-request, or Done evidence.

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
For the first discovery review of a pristine taskless cycle, use
`--initial-selection` with a schema-v1 document containing the exact integration
HEAD, nonempty affected areas, and nonempty targeted validation. This creates a
plan with no remediation task IDs; it cannot be combined with task packets or
used after arbitrary task or review evidence exists. The same explicit selection
is narrowly available after a migrated taskless pending review is collected as
a clean exact-head outcome while validation remains `not-run`. That recovery
requires no tasks, exact current request/outcome/history identity and kind, and
requested, reviewed, request, outcome, and integration SHAs that all match. It
does not reconstruct or trust a missing legacy plan and does not repeat the
still-applicable review. It cannot replace an existing passing proof after an
ordinary taskless review.

A native schema-v3 taskless cycle has one separate fail-closed recovery when a
clean discovery review remains internally consistent but its reviewed commit is
now one historical SHA behind the integration HEAD. The active state must be
`recovering`, contain no tasks, retain an exact latest request/outcome/history
triple whose clean request, outcome, requested, and reviewed SHAs all equal that
one prior SHA, and still have a discovery or verification request available.
The current checkout and recorded Git snapshot must be clean and exact, with no
blocked reason, verification escalation, or human-decision task. Use a current-
HEAD `--initial-selection` (and `--replace` when the historical sidecar exists)
to run a fresh nonempty targeted selection. This preserves the historical
request, outcome, and review ledger byte-for-byte; it never makes the old review
current or permits replacement of the resulting current-HEAD validation proof.

A third, migration-only route exists for a schema-v2 source with a nonempty
all-completed task set and an exact-head passed, nonempty legacy targeted proof.
For a `ready-for-review` or `complete` source, canonical migration of the
immutable `state.v2.backup.json` must reproduce the active `recovering` state
exactly. An `awaiting-review` source may instead preserve its exact pending
request. After one guarded clean exact-head outcome is collected, canonical
migration plus exactly that outcome transition must reproduce the active
`validating` state, with only checkpoint revision and timestamp metadata
normalized. The active state must have targeted validation `not-run`, a clean
exact current integration HEAD, no actionable Integrated tasks, no blocked
reason, verification escalation, or `needs-human-decision` disposition, and
every task must remain completed. The backup projection must match repository,
PR, integration HEAD, tasks, request, review history, outcome, and thread
evidence. This proof authorizes only a fresh explicit `--initial-selection`
plan. Never restore the legacy validation result or repeat the preserved review;
run every selected check again and record new exact-head targeted validation.

## What state must preserve

Use `.agents/skills/pr-review-cycle/schemas/pr-review-state.schema.json` as the machine contract. Preserve:

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

Validate tasks against `.agents/skills/pr-review-cycle/schemas/review-fix-task.schema.json`. The machine
contract is called a task packet; human guidance calls it fixed task
instructions. It must include the Review commit, finding and evidence, decisions,
dependencies, affected areas, owned and forbidden paths, acceptance criteria,
one specialization from the canonical registry, a unique compatible `riskTags`
array, and exact validation commands. Empty risk arrays are valid. When E2E is
relevant, record exact scenario selectors, browser projects, and the reason for
each selection.

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

Every affected area and risk must be compatible with the selected primary
profile. Split cross-domain work into dependent tasks normally. Use the broad
`data-integrity` profile only for an unsplittable highest-risk root cause whose
existing packet evidence documents why it cannot be split. Profile guidance
never expands ownership or validation.

## Worker results

Validate results against `.agents/skills/pr-review-cycle/schemas/review-fix-result.schema.json`. A worker
returns one raw JSON object with status `implemented`, `blocked`,
`not-applicable`, or `failed`. `implemented` requires a commit SHA. Each
validation entry records only its exact command, result, and concise summary.
The schema-v3 result echoes the packet specialization exactly and does not
repeat risk tags.
`validate-result` proves that the Review commit and worker commit exist, proves
ancestry, and derives the NUL-delimited, no-renames tree diff between them.
Implemented work requires a nonempty diff. Reject any mismatch between those
Git-derived paths and the reported unique `changedPaths`, missing required
validation, ownership violation, unexpected path, or raw log.

The orchestrator alone decides whether to accept and Integrate a result.
