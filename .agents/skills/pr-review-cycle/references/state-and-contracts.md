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
│   ├── task-binding-provenance/
│   │   ├── <sha256(taskId)>.json
│   │   └── <sha256(taskId)>.sha256
│   ├── worker-results/
│   │   ├── <sha256(taskId)>.json
│   │   └── <sha256(taskId)>.sha256
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

Archived state remains read-only recovery evidence. The narrow resolved-root
batch adoption in `reply-resolve` enumerates only bounded canonical archive
directories under `<git-common-dir>/codex/pr-review/archive/`. It rejects a
symlinked root, candidate, or evidence file, pins no-follow directory
descriptors, opens files read-only and no-follow, and requires stable pre/post
device, inode, mode, size, timestamps, and exact byte count. The 10,000-name
limit is applied before any canonical candidate is read or parsed, while
`.partial` entries are ignored. Selection requires one canonical immutable
proof lineage rather than one archive directory. Every matching carrier is
independently schema-valid and terminal, and its one completed schema-v3 task
must project exactly to one active terminal `not-applicable` GitHub-thread task.
Every carrier must reproduce the same complete selected-root proof rows in
stable root order, including root, reply, task, disposition, resolution, and
historical-HEAD identity. At least one origin must retain exactly one correlated
reply intent plus resolve intent per root. Multiple complete origins deduplicate
only when their normalized proof-and-intent authority is identical. A later
replay carrier may differ in terminal metadata and unrelated state or events,
but it is tolerated only with the exact canonical task-and-proof projection and
zero selected-root intents. Partial or conflicting intent footprints and every
divergent projection are fatal. Archive name, timestamp, enumeration order, and
latest or earliest position never establish authority. Each live reply must
equal the deterministic body rebuilt from origin state and task evidence. Root creation must be no later than
logical reply intent, logical intent no later than its persisted event, and
that reply event no later than exact resolve intent. Resolve intent must be no
earlier than the live reply's represented-second start, and preserved durable
`resolvedAt` no earlier than resolve intent; intent events and proof are bounded
by archived state and terminal timestamps. GitHub's second-granular reply
timestamp represents an interval rather than an exact mutation instant, so
logical intent and its event may follow the represented second's start. The
reply-intent event must still precede that second's exclusive end: `.999`
passes only when it does not follow resolve intent, while the next second's
`.000` fails. A later observation-form `resolvedAt` cannot precede the
resolve-intent event, while equality with the resolve intent is the canonical
recovery form and intentionally permits the event envelope's few milliseconds
of persistence latency.
Historical ancestry reads actual objects with replacement refs disabled and
refuses nonempty common-directory `info/grafts`, including for linked
worktrees. A deterministic sorted fingerprint of every matching carrier binds
the two complete archive reads, so additions, removals, or content changes fail
as races while list-only reordering is harmless. Fully paginated live roots and
replies must match those records twice. The transition writes only the ordinary current thread proof and
task completion; it never changes an archive, copies evidence into a sidecar,
appends a mutation event, or mutates GitHub. Manual state/proof copying and
thread reopening are not recovery mechanisms.

Archive adoption may require one preceding state-only `verify-resolve`
bootstrap when its already-resolved live roots circularly block ordinary
aggregate verification. The bootstrap is not archive evidence. It requires
pristine aggregate, threadless, and local proof; one selected actionable
Integrated GitHub-threadless remediation; exactly one exclusive terminal
`not-applicable` GitHub-thread task with at least two live resolved roots; and
only unresolved, exclusively mapped actionable Integrated or Resolved
GitHub-thread roots outside that batch. The complete canonical-root mapping,
clean equal local/pushed/live/durable heads, and state revision must match across
two full snapshots. An additional or ineligible remediation, any unknown,
missing, duplicate, shared, or extra-resolved root, or any snapshot race fails
without a checkpoint.

Its sole transition completes the selected remediation and changes only
`threadResolutionStatus.threadlessVerification` from pristine to passed with
the singleton task ID, exact current integration HEAD, and current assertion
time. Aggregate `status`, `headSha`, `threads`, `updatedAt`, and
`localVerification` remain byte-for-byte unchanged. An identical retry still
repeats every live, checkout, head, topology, and revision guard.
Completed-retry bootstrap handling is armed only when the terminal task's immutable
`thread:` and `discussion:` aliases resolve through the canonical live mapping
to at least two distinct root identities. Dual aliases for one root count once,
so an ordinary one-root terminal task keeps the guarded threadless retry. The
command does not enumerate or read archives, copy archived evidence, consult or
append the mutation journal, mutate GitHub, or synthesize aggregate thread
rows. The following `reply-resolve` remains the only authority for archive
selection, immutable archive proof, historical ancestry,
intent/reply/timestamp correlation, live evidence, race checks, and the
adoption checkpoint.

Pull-request `state` and `isDraft` are volatile GitHub evidence, never durable
review-state fields. `status` reports them without writing. A review request
against an otherwise ready draft first journals the deterministic
`ready:<pr>:<pr-node>:<head>` mutation intent, marks it ready, then rereads and
revalidates the exact PR before posting `@codex review`; that intent is
recoverable after a lost mutation response. Issue 25 owns creating ready PRs.
Monitor pending work with `advance`, not passive `status` polling.

Readiness is volatile GitHub evidence: `pullRequest` exposes `state` and
`isDraft`; `pullRequestReadiness` is `already-ready`, `marked-ready`, or
`recovered-ready`. The recoverable ready journal intent is
`ready:<pr>:<pr-node>:<head>`, not a state schema addition. `status` remains a
read-only diagnostic and reports the unchanged durable `codexReview` plus a
canonical `reviewObservation`: `not-applicable`, `waiting`, `collectable`,
`ambiguous`, or `stale`. Status, collect, and advance share the classifier for
review submissions, reactions, structural comments, timestamps, SHA, roots,
and ambiguity; checkpointing requires two equal complete snapshots.
Issue 25 preparation creates ready PRs; `advance` rejects drafts and never
performs the ready mutation.

## State commands

```bash
npm run review:state -- init --pr 123 --base origin/main --head HEAD
npm run review:state -- init --pr 123 --base origin/main --head HEAD --review-limit 8
npm run review:state -- path
npm run review:state -- validate
npm run review:state -- bind-task-packet --task-packet /tmp/task.json --expected-revision 4
npm run review:state -- replan-task-packet --task '<opaque-id>' --expected-revision 4
npm run review:state -- validate-result --task-packet /tmp/task.json --worker-result /tmp/result.json
npm run review:state -- accept-result --task-packet /tmp/task.json --worker-result /tmp/result.json --expected-revision 5
npm run review:state -- backfill-result --task-packet /tmp/task.json --worker-result /tmp/result.json --expected-revision 8
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
npm run review:state -- set-review-limit --pr 123 --expected-revision 4 --limit 8
npm run review:state -- set-review-limit --pr 123 --expected-revision 5 --unlimited
npm run review:state -- archive
npm run review:state -- archive --abandon-reason "superseded PR"
```

`init` derives the repository only from an unambiguous GitHub `origin` and never
guesses a PR number. Pass `--repository owner/name` when needed. `checkpoint`
replaces the complete document and rejects revision drift. Normal archival
requires Done; earlier archival requires an explicit durable abandonment reason.

Schema v3's optional `reviewRequestLimit` is a durable policy value: missing or
`null` means no configured request-count cap, while a finite value is a positive
safe-integer total limit (at most `9007199254740991`). Used requests equal
migrated discovery provenance plus the complete
native `reviewHistory`; every entry counts regardless of its outcome. The
guarded setter cannot lower the limit below that total, rewrite request history,
clear an evidence escalation, or exhaust the cycle while the exact next GitHub
request intent is recoverable. Generic checkpoints cannot change the policy. Reaching the
limit keeps review-ready state valid but blocks the next request before any
mutation. Active state remains bounded to 64 KiB, so unlimited describes policy,
not unbounded storage.

Schema v3 optionally carries `staleDiscoveryDispositions` so documents written
before this recovery contract remain readable. The array is append-only and
bounded to the three possible discovery ordinals. Every record has schema
version 1, a deterministic SHA-256 `dispositionId`, the exact `requestId`,
`requestHeadSha`, distinct `liveHeadSha`, one complete canonical discovery
`evidence` object, a SHA-256 `responseFingerprint` over the exact response and
immutable attached-root source evidence, reason `head-drift`, and `disposedAt`.
Manual validation binds
it to exactly one native null-outcome discovery history row, enforces history
order and unique disposition/request/response identities, and rejects migrated
provenance. Generic checkpoints cannot add, remove, reorder, or edit the ledger;
only guarded task completion may append an exact validated record.

State schema v3 upgrades are explicit. Migration from v1 or v2 first saves an
exact versioned backup and must preserve stable finding/task identities, source
IDs, finding keys, and outcomes. Never let an unrelated read silently migrate
state.

Before delegation, `bind-task-packet` atomically persists the complete accepted
schema-v3 packet under `task-packets/<sha256(taskId)>.json`, verifies its
canonical SHA-256 identity, persists the receipt-verified pre-bind plan under
`task-binding-provenance/<sha256(taskId)>.json`, and records the packet digest
on its actionable task. The provenance captures the packet digest and reviewed
HEAD, specialist-plan revision and receipt digest, both explicit planning
signals, canonical route, and any required clean planning-phase behavior-mapper
result. Binding writes all immutable sidecars under one state lock before the
digest checkpoint. An adjacent immutable SHA-256 receipt covers the complete
binding provenance, including its mapper record. An interrupted exact write is
retryable; changed, missing, or unverifiable sidecars or receipts fail closed.
Object key order does not affect the digest; array order and every packet value,
including specialization and risks, do. The sidecar and binding are immutable.
Missing or changed sidecars fail recovery, result acceptance, validation
planning, and specialist routing.

Completed historical schema-v2 tasks remain readable. An unbound task may
receive an explicitly planned schema-v3 packet. An active task already bound to
a legacy packet cannot be inferred, silently rebound, or assigned a fallback
profile. For one genuine migration-origin schema-v2 binding in neutral
`proposed`, `blocked`, or `failed` execution—or already `integrated`—use
`replan-task-packet --task <opaque-id> --expected-revision <n>`. The guarded
transition verifies the exact `state.v2.backup.json` identity and task digest,
rejects any packet, provenance, or provenance-receipt sidecar, accepts no
replacement packet, and deletes nothing. `queued`, `running`, `implemented`,
completed, or worker/branch/worktree/worker-commit-bearing tasks are rejected.
It clears only that safe legacy digest, resets a pre-integration task to neutral
`proposed` execution, preserves an Integrated task's central commit and
resolution, and invalidates targeted validation. Then run ordinary explicit
schema-v3 `specialist-plan` and `bind-task-packet`; the generic checkpoint still
cannot clear or replace a digest. `--task` is one byte-for-byte opaque ID—commas,
spaces, quotes, and backslashes are not separators.
State remains schema v3 because canonical packets and specialist evidence are
durable, digest-verified sidecars rather than duplicated task fields.

`validate-result` is diagnostic only. Before a bound task becomes Integrated,
`accept-result` performs the expected-revision guarded durable transition. It
reloads the immutable packet and runs the shared worker-commit inspector used by
the CLI, retries, accepted-evidence reads, reconciliation, recovery, backfill,
and final integration. The inspector requires one non-root, non-merge worker
commit `W` with sole parent `P`; the packet Review commit must be ancestral to
`P`, and `P` must already be ancestral to the exact current integration HEAD.
It separately requires every declared dependency to be durably Integrated or
Resolved and ancestral to both `P` and that integration HEAD. It derives
NUL-delimited, no-renames changed paths only from `P` to `W`, with submodule
ignoring forced off so repository configuration cannot hide gitlink changes.
Before any authority read, replacement-disabled Git resolves the actual common
Git directory, including for linked worktrees; a nonempty common-dir
`info/grafts` fails closed while an absent or empty file is inert. Every
subsequent Git authority read disables replacement objects so a local
`refs/replace/*` entry cannot rewrite commit existence, parents, trees,
ancestry, paths, or patch evidence. The transition then writes a canonical
envelope of at most 64 KiB under `worker-results/<sha256(taskId)>.json`. The
envelope binds the PR, task, packet digest, Review commit, canonical result
digest, and full result. Its adjacent immutable receipt is written first and
covers the complete envelope; compact task state then records only the result
digest. Exact retries finish an interrupted receipt, envelope, or state
boundary. Different bytes, tampering, missing evidence, and orphans fail closed.

`backfill-result` is limited to native schema-v3 Integrated or completed tasks
whose original result is supplied. It additionally proves that the central
commit remains ancestral to the current integration HEAD and that `P` is
ancestral to the central commit's sole parent. Exact equivalence emits the
binary full-index `P`-to-`W` patch with renames, external diffs, text conversion,
and submodule ignoring disabled, and forces short applyable gitlink deltas. It
seeds a unique temporary Git directory, index, and object database from the
central parent, declares the same SHA-1 or SHA-256 object format, and uses the
real object database only as a read alternate. Its environment contains no
inherited Git settings, system and user configuration and attributes are
disabled, and the temporary Git directory's highest-
precedence `info/attributes` forces the deterministic built-in `merge=text`
driver. Repository `.gitattributes`, local configuration, and custom merge
drivers therefore cannot affect the proof or execute. It applies the patch
cached with three-way semantics and no whitespace relaxation, and requires the
complete generated tree to equal the central commit's actual tree. Conflicts
fail closed. The temporary Git directory, index, and objects are removed in
`finally`, so validation and recovery do not change the checkout, repository
index, refs, configuration, or repository object database. This proof is
base-independent for nonoverlapping same-file history while preserving exact
paths, statuses, modes, gitlink pointers, whitespace, added/deleted bytes, and
binary content; patch IDs are not authority. `accept-result` applies the same
proof at the bootstrap boundary when the old workflow already marked a task
implemented.
The final Implemented-to-Integrated checkpoint reruns parent, dependency, path,
central ancestry, and exact-delta checks against the then-current HEAD. Schema-
v1/v2 migration never synthesizes worker-result evidence.

`specialist-reviews/<head>-r<revision>.json` stores concise guarded planning and
review evidence. Its immutable planning fields are anchored by the adjacent
`.plan.sha256` receipt; reviewer records and operational timestamps are excluded
from the semantic plan identity. A receipt-only interrupted create reports
pending evidence and the same exact guarded plan may finish it; changed packets,
signals, or routes conflict. Pre-bind plans carry the full canonical
packet plus the explicit `browserVisible` and `testSelectionUncertain` signals
without adding those signals to task packets, and bind behavior-mapper evidence
to the packet's exact reviewed commit. This is the PR workflow's translation of
the reusable planning `subjectSha`; the persisted `reviewedHeadSha` contract is
unchanged. Record, status, recovery, and binding reads all verify the receipt
and the packet's task ID, digest, specialization, risk tags, and canonical
workflow-neutral route.
Post-integration plans cover the exact bound packets for both Integrated and
Resolved actionable tasks, plus their required risk reviewers, for one
integration HEAD. A packet-backed Resolved task retains its ancestral integrated
commit, immutable pre-bind provenance, receipt-valid worker result, and route in
every later final-verifier context; it is not reclassified as a terminal
non-packet outcome. Plans reuse each verified pre-bind signal set and route,
while `riskReviewers` select review-phase evidence only; planning-phase behavior
mapping is not rerun against the integration HEAD.
`specialist-record` accepts only a planned reusable role and exact HEAD/revision;
it never accepts `integration_verifier`. `specialist-context` is read-only and
produces the guarded input for the PR workflow's final verifier, including every
exact immutable packet, every receipt-verified result with packet, Review,
worker, and integrated commit identities, phase-qualified pre-bind signals, route, reviewed-HEAD
mapper result, separate exact-integration-HEAD risk results, targeted-validation
proof, and `finalVerification` descriptor. Terminal verifier-eligible tasks not
represented by a packet-backed Integrated entry appear in deterministic
`taskOutcomes` alongside the packet evidence; packet-backed tasks are not
duplicated there. Any uncovered actionable, nonterminal, failed, or human-gated
task blocks final-verifier readiness. Any
HEAD change makes the prior bundle stale; clean specialist evidence is not
task-resolution, GitHub, review-request, or Done evidence.

`targeted-validation-plan.json` is a resumable sidecar, not trusted input to a
generic checkpoint. `validation-plan` derives its deterministic, de-duplicated
commands from fixed task packets and requires those packet IDs to exactly match
the actionable Integrated and Resolved packet-backed tasks. Thus a later HEAD
reruns prior fix checks together with newly Integrated checks. It preserves affected areas plus each check's
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
clean review remains internally consistent but its reviewed commit is
now one historical SHA behind the integration HEAD. The active state must be
`recovering`, contain no tasks, retain an exact latest request/outcome/history
triple whose clean request, outcome, requested, and reviewed SHAs all equal that
one prior SHA, and still have configured review-request allowance.
The current checkout and recorded Git snapshot must be clean and exact, with no
blocked reason, verification escalation, or human-decision task. Use a current-
HEAD `--initial-selection` (and `--replace` when the historical sidecar exists)
to run a fresh nonempty targeted selection. This preserves the historical
request, outcome, and review ledger byte-for-byte; it never makes the old review
current or permits replacement of the resulting current-HEAD validation proof.

A native schema-v3 taskless pending request may likewise recover after pure
HEAD drift, but it never gains an outcome. The active request must equal the
latest history request exactly, both outcome fields must be `null`,
`reviewedHeadSha` must remain `null`, and the request SHA must be the one prior
HEAD. The state is `recovering`, native rather than migrated, with a clean exact
current checkout and no tasks, blockers, escalation, or human-decision work.
Use a nonempty current-HEAD `--initial-selection` and run it normally. A finite
limit may already be exhausted: the pending history row still counts, while
validation and empty-proof recovery remain available.

After current validation passes, `refresh-threads` proves the original request
comment is still immutable and fully paginates responses and canonical roots.
Verification evidence retains its durable human-escalation route. Discovery
with no canonical response is pure drift: it receives no disposition and may
record only current empty-thread proof when no canonical root exists. Exactly
one supported discovery response may instead append one disposition bound to
the prior request HEAD and current live HEAD. Missing, edited, duplicated,
foreign, unsupported, multiple, conflicting, same-head, migrated, or
inconsistently bound evidence fails closed for human judgment.

A clean disposition restores `ready-for-review` only after a second full
evidence/root read and repeated clean local, pushed, live, revision, and state
checks. A findings disposition moves to ordinary `triaging` and invalidates the
aggregate thread proof; roots still require ordinary task mapping, reply, and
resolution. Neither path changes `reviewRequest`, `reviewOutcome`,
`reviewedHeadSha`, its null history outcome, request ordinal, or finite-limit
usage. Identical current-revision retries take the state lock, reread the
revision, and return the existing disposition and proof without another
revision; changed evidence, roots, heads, or revision fail closed. A finite
exhausted limit retains the proof and exact setter action,
while unlimited policy permits a replacement whose kind comes from the full
history ordinal.

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
`validate-result` proves that the Review commit and worker commit exist, that
the worker commit is one non-root, non-merge commit `W`, and that its sole
parent `P` is between the Review commit and current integration HEAD. It derives
the NUL-delimited, no-renames changed paths only from `P` to `W`; dependency
ancestry is checked separately and never contributes ownership paths.
Implemented work requires a nonempty commit-local diff. Reject any mismatch between those
Git-derived paths and the reported unique `changedPaths`, missing required
validation, ownership violation, unexpected path, or raw log.

The orchestrator alone decides whether to accept and Integrate a result.
