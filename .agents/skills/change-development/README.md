# How change development works

The `$change-development` capability plans, implements, and resumes one durable
Aerstello change. It preserves the exact source, Git observations, decisions,
specialist evidence, accepted plan, immutable worker packets and results,
central integration receipts, exact-HEAD validation, review results, and
finding dispositions so another session can continue without reconstructing
intent.

For `implement` and `full`, this capability stops at `development-ready` after
local exact-HEAD validation, stored-route specialist review, and the read-only
`development_integration_verifier` are clean. It does not push, prepare or
review a pull request, run CI, merge, or write to GitHub. Issue reads through
the standalone source adapter are read-only.

## Terms

- **Change ID**: operator-supplied stable identifier for one durable planning record.
- **Planning ref / Planning SHA**: explicit clean commit used to read repository content and assess the plan. A branch name alone is insufficient; initialization resolves it to a commit.
- **Source**: exactly one issue, UTF-8 direct-request file, repository-plan path at the Planning SHA, or committed partial implementation compared with an explicit base.
- **Observation**: normalized, immutable evidence of source and Git state at a point in time.
- **Accepted plan**: canonical validated `plan.json`. Acceptance freezes it permanently.
- **Decision**: a normalized candidate-plan resolution before acceptance, or an append-only operator resolution of accepted-plan source drift afterward.
- **Amendment**: authorized append-only plan evolution containing provenance, delta, the complete resulting normalized plan, and old/new digest receipts.
- **Task packet**: immutable, receipt-protected binding of one accepted-plan task to its exact base SHA, paths, decisions, criteria, specialist route, and validation commands.
- **Implementation result**: one worker's schema-valid `implemented`, `blocked`, `failed`, or `no-change` report, checked against its packet and Git evidence.
- **Wave**: at most three dependency-ready bound tasks whose ownership and produced/consumed artifacts do not conflict.
- **Integration intent**: durable record of one accepted worker commit and the exact clean central base, written before cherry-pick.
- **Verification round**: immutable validation plan, append-only command intents and results, stored-route specialist evidence, verifier context/result, and finding dispositions bound to one clean integrated HEAD.
- **Development-ready**: local proof that the exact HEAD, source, plan, task set, validation, specialist evidence, and final verifier result are all current and clean; it is not delivery authority.
- **Exact next action**: one bounded command or operator action stored in state and emitted by status/hooks.

## Minimality and scope authority

Every newly accepted plan carries a receipt-protected minimal-closure contract
and an applicable canonical scope assessment bound to its source, Planning SHA,
and exact candidate plan. Only `within-scope` admits the plan. Trim and bounded
minor-amendment outcomes return to planning; material change enters the durable
human-decision route; insufficient evidence fails closed. Historical accepted
records remain readable, but an unfinished legacy change must adopt this
authority append-only before gaining new execution or finalization authority.

Assessment cadence is limited to admission, a task boundary when packet
tripwires or worker discovery require it, and the exact integrated HEAD. Every
new packet binds both the accepted and observed deterministic inventories. An
unchanged comparison binds without model assessment and preserves the current
scope evidence; changed inventories require `within-scope` task evidence naming
the exact canonical trigger IDs. Structured worker discovery invalidates the
prior task evidence and admits assessment only for the exact packet, result,
and discovery receipts. Task evidence also binds criterion need, removal
counterfactual, forbidden expansion, and a fail-closed discovery return. A
worker never expands its packet. Decisions and amendments are append-only and
exact-evidence-bound; a minor amendment covers only necessary adjacent work
with no material trigger or independent workstream.

`npm run change:status` reports the compact current scope status, boundary,
decision count, and guarded-return count. Validation, verification, and
Development-ready require a current `within-scope` assessment for the exact
integrated HEAD, effective plan, ordered amendments and operator-decision
receipt digests, minimal closure, and terminal task-set identity. Historical
zero-decision assessments may omit the optional decision sequence. A
`trim-required` integrated result returns to
bounded removal or simplification work.

After Development-ready, separate PR preparation may call the pure
[`buildDevelopmentScopeHandoff`](scripts/handoff/contracts.mjs) projection with
receipt-validated closure, effective-plan, ordered amendment, decision,
canonical terminal task-set, and integrated-assessment records. The terminal
task-set receipt is required; the builder recomputes both its digest and the
subject digest from the exact handoff HEAD instead of accepting caller-declared
task or subject identities. It returns only bounded source, plan, amendment,
closure, exact-HEAD, canonical assessment-pair, decision, deferred-follow-up,
and capture-time identities. It does not read or mutate durable state, create a
sidecar, initialize PR review, satisfy review or CI gates, or carry raw issue,
plan, diff, log, or transcript payloads. Issues 25 and 26 own PR preparation and
delivery coordination.

## Start or resume

Run commands from the repository root or use `npm --prefix /path/to/aerstello run …` from a nested workspace.

```bash
npm run change:state -- init \
  --change-id issue-22 \
  --mode plan-only \
  --base-branch main \
  --planning-ref <full-commit-sha> \
  --source /path/to/source-descriptor.json
npm run change:state -- path
npm run change:state -- show
npm run change:status
```

Initialization requires a change ID, mode, base branch, explicit Planning ref, and exactly one source. The modes are:

- `plan-only`: planning is complete at `ready-to-implement` and may be archived normally.
- `implement`: retain active state at `ready-to-implement` for the implementation capability.
- `full`: retain active state at `ready-to-implement` for implementation and later lifecycle work.

Supported sources are a GitHub repository plus issue number, a UTF-8 direct-request file, a tracked repository-plan path read from the Planning SHA, or a committed partial implementation with an explicit comparison base. Dirty planning snapshots and non-commit refs fail closed. Pass one JSON file to `--source`; its exact shape is one of:

```json
{ "type": "github-issue", "repository": "owner/repository", "issueNumber": 22, "relationshipIntent": "resolves" }
```

```json
{ "type": "direct-request", "path": "/path/to/request.md", "relationshipIntent": "resolves" }
```

```json
{ "type": "repository-plan", "path": "plans/change.md", "relationshipIntent": "resolves" }
```

```json
{ "type": "partial-implementation", "comparisonBase": "main", "relationshipIntent": "partial" }
```

`relationshipIntent` is optional and defaults to `reference-only`; accepted values are `reference-only`, `partial`, and `resolves`. Use `--expected-pr-base-branch` when the intended PR base differs from `--base-branch`.

Use the following lifecycle commands through `npm run change:state --`:

| Command | Purpose |
| --- | --- |
| `init` | Validate the clean Planning SHA and create the one active change |
| `path` | Print the durable path for the active or named change |
| `show` | Print machine-readable current state |
| `validate` | Validate the candidate or accepted plan and its evidence |
| `refresh-source` | Read the source outside the lock, then classify drift |
| `accept-plan` | Persist the immutable accepted plan and receipts |
| `adopt-scope` | Append scope authority to an unfinished legacy accepted plan |
| `assess-scope` | Record exact task or integrated-HEAD scope evidence |
| `record-scope-decision` | Append one exact operator scope decision receipt |
| `resume-scope-return` | Resume a guarded return bound to the active handoff authority |
| `record-decision` | Resolve accepted-plan source drift while `awaiting-decision` |
| `amend-plan` | Append an authorized complete resulting plan without rewriting history |
| `recover` | Finish only an exact matching interrupted transition |
| `archive` | Archive an abandoned change or normally completed `plan-only` change |
| `upgrade-state` | Explicitly receipt-protect a v1 accepted record as execution-capable v2 |
| `bind-task` | Bind one immutable task packet to the effective plan and clean central base |
| `schedule-wave` | Select up to three dependency-ready, non-conflicting bound tasks |
| `start-task` | Record one scheduled worker attempt as running |
| `accept-result` | Validate and preserve one worker result against packet and Git evidence |
| `integrate-task` | Persist integration intent, cherry-pick the worker commit, and reconcile |
| `reconcile-integration` | Apply or finish an interrupted integration from the persisted intent |
| `reject-task` | Receipt-record a bounded rejection before worktree cleanup and replan |
| `finalize-integration` | Prove all terminal worktrees removed and enter `integrated` |
| `validation-plan` | Persist the immutable exact-HEAD targeted validation plan; use `--replace` only for a failed plan |
| `run-validation` | Resume direct `shell:false` execution of pending validation argv and append concise results |
| `specialist-plan` | Union receipt-valid stored task routes in canonical reviewer order |
| `specialist-record` | Record one routed exact-HEAD reusable reviewer result |
| `verifier-context` | Print the deterministic bounded context for `development_integration_verifier` |
| `verifier-record` | Record one schema-valid result bound to the exact context and HEAD |
| `finding-authorize` | Receipt-protect a human decision required by a repeated semantic finding |
| `finding-disposition` | Append one source-kind and source-role-qualified finding disposition |
| `finalize-development` | Recheck every local exact-HEAD gate and enter `development-ready` |

For these nine verification commands, `verifier-context` is the only read-only
command and takes `--change-id` only. Every other command mutates lifecycle
state and requires both `--change-id` and `--expected-revision`.
`specialist-record`, `verifier-record`, and `finding-disposition` additionally
take `--input <json>` matching, respectively, the canonical
[`development-specialist-result.schema.json`](schemas/development-specialist-result.schema.json),
[`development-verification-result.schema.json`](schemas/development-verification-result.schema.json),
and
[`development-finding-disposition.schema.json`](schemas/development-finding-disposition.schema.json)
schemas. `finding-authorize --input <json>` takes the exact closed object
`{ "fingerprint": "…", "reason": "…", "authorizedBy": "…" }`; no other keys
are accepted. `validation-plan --replace` is valid only after immutable failed
validation evidence exists and means a transient same-HEAD rerun. Corrective
work instead uses an amendment triggered by
`validation-failure:<result-digest>` and adds a new owned criterion and task.
See [verification](references/verification.md) for
the full lifecycle and evidence constraints.

`resume-scope-return --input <json>` accepts exactly `scopeReturn` plus
`activeHandoffAuthority`. The latter is a `{ "value": <imported handoff>,
"digest": <canonical PR scope-authority digest> }` receipt. Under the change
lock, the lifecycle validates that receipt, derives the same handoff from the
active effective plan, closure, ordered amendments and decisions, terminal task
receipts, integrated assessment, and returned capture time, then requires its
digest to equal the envelope authority before any durable record can advance.

Pass the current state revision with `--expected-revision` to every mutating
state command. Revision conflicts fail closed. `recover` instead verifies the
exact committed interrupted intent and receipt chain; it does not accept a
guessed revision. Uncommitted hidden transition staging is rollback-only. An
intact committed intent may restore only its exactly embedded evidence and
deterministic receipts; conflicting or tampered artifacts block.

`validate --plan` proves acceptance readiness only against the active durable state. It first validates that state's complete receipt, transition, and source-observation chain, then binds the candidate to the exact change, source capture, and Planning SHA. Without an active state it may report candidate schema errors, but readiness is always false and the command fails with a durable-state-required error.

Before acceptance, put every planning choice and its resolution in the
candidate plan's normalized `decisions`; `record-decision` is not a substitute
for that plan payload. The command is reserved for an accepted plan that moved
to `awaiting-decision` after source drift. Receipt-valid decision evidence from
the former pre-accept behavior blocks `accept-plan` for explicit reconciliation;
the capability never guesses that a legacy reason or other prose equals a plan
resolution.

A post-accept decision input is a strict JSON object. Use `resolve` before
incorporating material drift into an amendment, or `retain-plan` to authorize
the unchanged accepted plan when the repository is still clean at the Planning
SHA:

```json
{
  "id": "source-drift-2026-08-17",
  "reason": "The refreshed source adds a planning requirement.",
  "authorization": "operator-confirmed",
  "trigger": "source-refresh",
  "disposition": "resolve"
}
```

A material refresh records its new source observation only after the canonical
projection includes the exact refreshed identity and every changed checklist
mapping, including complete captured text, plus a viable decision-bound
criterion, task, amendment, result, integration, and post-amend verification
lifecycle. The later non-retain decision substitutes its exact decision ID and
rechecks the same envelope before recording the initiating Git observation in
the next durable state. If that transition is interrupted, recovery
requires the same HEAD, branch (including detached state), and cleanliness
before completing it. This exception is limited to a semantically valid
`decision-recorded` transition whose predecessor is an accepted plan in
`awaiting-decision` and whose immutable decision evidence matches that
predecessor; an old planning-phase intent or relabeled intent cannot grant it.
`retain-plan` recovery remains stricter and requires the clean Planning SHA
before execution or the exact clean integrated HEAD after terminal work.

An amendment input records provenance separately from the complete resulting plan passed with `--plan`. Its `delta` must be a nonempty object; `invalidatedEvidence` is a unique string list and may be empty:

```json
{
  "id": "include-refreshed-requirement",
  "reason": "Incorporate the authorized source change.",
  "authorization": "operator-confirmed",
  "trigger": "source-drift-2026-08-17",
  "delta": { "summary": "Add the new criterion and its planned task." },
  "invalidatedEvidence": []
}
```

Read [planning](references/planning.md) for source, checklist, validation, and
drift rules. Read [implementation](references/implementation.md) for packet,
worktree, result, wave, and integration rules. Read
[state and recovery](references/state-and-recovery.md) before recovery,
abandonment, or archival. Read [verification](references/verification.md) for
the exact final evidence and authority boundary.

## Exact-HEAD verification and findings

One canonical semantic-evidence composer drives both admission and the final
`verifier-context`. It fixes item identities, kinds, digests, summaries,
ordering, UTF-8 chunking, the 500-item ceiling, and the 256-KiB full-envelope
ceiling. It consumes receipt-valid evidence plus explicit pending overlays and
uses placeholders only for evidence made inevitable by accepted authority; it
never truncates, drops, or guesses future prose. Plan acceptance and amendment,
packet binding, implementation-result acceptance, validation-plan and result
recording, specialist-plan and result recording, verifier-result recording,
finding disposition, and repeated-finding authorization all run that same
projection before writing a sidecar, receipt, transition, event, or state.
Capacity failure is therefore retryable and leaves durable bytes unchanged.
Each earlier layer reserves the smallest successful authority already made
inevitable: accepted tasks include one bindable packet/result shape, bound
packets substitute their exact ownership and validation commands while
reserving the larger direct-rejection replacement branch, and implemented
results retain that branch through integration-conflict recovery. Validation
plans reserve both the maximum deterministic command-result record and the
failed-result remediation amendment. Release-aware plans likewise reserve a
protected-ref release record before capture. Remediation reservations use
bounded canonical row envelopes and exact known IDs, checklist text, and
invalidated-evidence paths, so their serialized bytes and UTF-8 chunks dominate
the smallest truthful follow-on authority rather than a short generic label.

After `finalize-integration`, `validation-plan` derives one receipt-protected
plan from terminal packet, result, provenance, and integration identities at
the current clean HEAD. Its command union is parsed before persistence;
`run-validation` executes argv directly with `shell:false`, persists intent
before execution, and stores only exit/signal summaries plus an output digest.
A failure remains immutable and may be followed by an explicit transient
`validation-plan --replace` round or an exact failed-result corrective
amendment. Release or migration work always resolves its baseline and release
authority from protected `origin/main`, independent of the development base,
and binds that evidence to the exact validation HEAD.

After validation passes, `specialist-plan` consumes each terminal packet's
receipt-valid stored route without live rerouting. It unions reusable risk
reviewers in canonical order; `specialist-record` accepts each required
exact-HEAD result in that order. When no reviewer is routed, the lifecycle
advances directly to `verifying`. The workflow then supplies the generated
`verifier-context` and its canonical digest to the registered, read-only,
non-delegating `development_integration_verifier`, and records only its raw
schema-valid result with `verifier-record`.

Plan, packet, worker-result, and specialist-plan admission reserve only their
known route and result summaries; they do not invent future findings. At each
`specialist-record` boundary, the exact pending result activates the dynamic
remaining 100-fingerprint aggregate reservation across still-unrecorded
reviewers, including schema-minimal identity, summary, evidence, disposition,
and any actually applicable repeat authorization for each reserved share.
Later rounds reuse the largest applicable prior same-role identities;
applicability skips rounds without that reviewer and stops at an intervening
clean same-role receipt. With two reviewers, compact 50 then 50 records exactly
100 findings, while a clean first result leaves the schema-v1 maximum of 100 to
the final reviewer. A 51-finding first result or an over-capacity exact result
is rejected byte-for-byte before persistence and may be consolidated and
retried. All reviewers still record before any disposition.

While routed reviewers remain, each accepted specialist result keeps the phase
at `specialist-review`, even when it contains findings. Recording the final
routed result advances to `blocked` if any collected specialist finding exists,
or to `verifying` when all are clean; finding disposition cannot begin before
that final routed result. Any final-verifier finding moves the lifecycle to
`blocked`. Every finding receives a stable source-role-qualified fingerprint;
append a disposition for every exact source finding. Non-actionable
dispositions may return the state to `integrated` for a new round only after
the last disposition proves the complete reset next-round validation and
routed-review projection can fit. Actionable
findings remain unresolved until one guarded amendment, triggered by the
fingerprint, covers every actionable sibling and adds new ordinary remediation
criteria and task IDs while preserving terminal task definitions. Implement
and integrate that work, then start a new exact-HEAD round. A semantic finding
repeated in consecutive applicable rounds requires `finding-authorize` with its
exact fingerprint, reason, and authorizer before any disposition or amendment.
Authorization reason and authorizer are bounded to 1024 and 256 UTF-8 bytes,
respectively, so required authorization evidence can be reserved
conservatively after JSON escaping and exact text can be rechecked before
persistence. Finding admission reserves a schema-minimal exact disposition.
Result admission does not guess a later actionable/non-actionable choice,
amendment prose, or reset round. Each exact disposition, authorization,
amendment, and last-disposition next-round transition separately substitutes
its newly known authority into the canonical projection before persistence and
fails atomically if it cannot fit.

Every validation, review, disposition, amendment, and finalization transition
rechecks the clean verification HEAD. An advance or dirty checkout invalidates
current applicability without deleting prior round history. Run
`finalize-development` only after a clean verifier result. It captures the live
refreshable source outside the state lock, then rechecks revision and the exact
clean verification HEAD under lock. Progress-only drift returns terminal work
to `integrated`; material drift enters the decision/amendment route. Capture
errors and races leave state unchanged. Finalization independently
requires current source and checklist evidence, no decisions, blockers,
findings, active wave, or integration intent, and only `integrated` or
`no-change` tasks.

## Hooks and trust

`SessionStart` and `PreCompact` run independent change-development handlers beside the PR-review handlers in the same matcher groups. Matching commands may run independently and concurrently; neither capability depends on handler order. The change handlers are no-op-safe when no change is active, emit bounded context, and perform no network work during compaction.

`SubagentStop` has a separate exact `^implementation_worker$` matcher. Its
handler accepts only the worker's raw schema-valid result object and validates
its document shape; guarded `accept-result` later cross-validates the object
against the immutable packet, worktree, and Git. The handler is independent of
the existing exact `^review_fix_worker$` matcher. The implementation worker
adapter may not delegate, integrate, mutate central state, push, or write to
GitHub.

After `.codex/hooks.json` changes, inspect and renew project hook trust with
`/hooks`. Do not use implementation workers until that exact hook configuration
is trusted.

## Handoff boundary

At `ready-to-implement`, verify `npm run change:status` reports no unresolved
decision and one exact next action. For `plan-only`, archive when desired. For
`implement` or `full`, upgrade an inherited v1 record if required, then follow
the dependency graph through binding, worktree execution, result acceptance,
and central integration.

For `implement` and `full`, continue from `integrated` through the exact next
validation, specialist, verifier, finding-remediation, and finalization actions
until status reaches `development-ready`. Stop there. Do not push, open or
update a PR, request or resolve review, run CI, coordinate delivery, merge, or
otherwise mutate GitHub as part of this capability. Those actions begin in a
separate PR preparation or review-cycle workflow using the same exact HEAD.
