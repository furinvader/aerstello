# GitHub review, CI, and completion

Read this reference before reading or writing GitHub review data, recording CI,
requesting `@codex review`, resolving threads, or finishing a cycle.

## Setup and ownership

- Enable Codex cloud and Code review for the repository.
- Authenticate the GitHub connector or run `gh auth status`.
- Read root `AGENTS.md` and trust the repository hooks through `/hooks`.
- Keep complete Git history and tags available for release checks.

The main orchestrator alone requests reviews, posts evidence, closes threads,
and writes durable state. Workers and the integration verifier never write to
GitHub.

Scope control adds no GitHub command and changes none of the native review,
thread, CI, or Done evidence. Every existing mutation/transition gate now also
requires receipt-valid scope authority, a `ready` compact gate, exact active
and live PR HEAD applicability, and—when acting on a task—the matching root
classification. Missing legacy projection, invalid receipts, material or minor
decision gates, returned state, or stale HEAD fails closed before a GitHub
mutation or state checkpoint.

## Review-ready gate

A commit is review-ready only when:

- no worker is active and all accepted fixes are Integrated;
- no task is queued, running, or blocked;
- the checkout is clean;
- the union of related local checks passed for the current commit;
- selected E2E scenarios passed when needed;
- relevant release and migration checks passed;
- the branch is pushed and local HEAD equals the GitHub PR head;
- the state checkpoint records that Review commit; and
- a fresh GitHub query shows no open Codex review threads from prior rounds.

It must also have current receipt-valid scope proof for the exact live PR HEAD.
This does not replace any item above. `status` remains read-only and renders a
concise scope authority/source/minimal-closure line, exact-HEAD current/stale
line, root classification plus smallest alternative and approved boundary,
blocker, and next action. `advance` returns `scope-blocked` without mutation
when that proof is not ready.

Done repeats the same current scope gate immediately before completion: scope
proof must still be receipt-valid, `ready`, and bound to the current local,
pushed, integration, and live PR HEAD. Clean review, green CI/full E2E, closed
threads, and every other native completion condition remain independently
required.

Full local checks and full local E2E are not review-ready requirements.

## Request and accept a review

Only the orchestrator posts the exact top-level comment:

```text
@codex review
```

Record the request kind, comment ID/URL, time, and Review commit immediately.
Never use `@codex address that feedback`.

The supported helper commands are:

```bash
npm run review:github -- status --pr 123
npm run review:github -- status --human
npm run review:github -- advance --pr 123
npm run review:github -- reply-resolve --pr 123 --task finding-a
npm run review:github -- verify-resolve --pr 123 --task local-finding
npm run review:github -- verify-resolve --pr 123 --task-set-json '["threadless-a","threadless-b"]'
npm run review:github -- request --pr 123
npm run review:github -- collect --pr 123
npm run review:github -- collect-ci --pr 123
npm run review:github -- complete --pr 123
```

`status` is read-only diagnostic output. Its `reviewObservation` has status
`not-applicable` (no pending request), `waiting` (no response), `collectable`
(one supported response), `ambiguous` (malformed, duplicate, or cross-channel
evidence), or `stale` (HEAD mismatch). `outcome` is `clean`, `findings`, or
`null`; `evidenceType` is `review-submission`, `request-reaction`,
`issue-comment`, or `null`; `evidenceIds` are typed identifiers. Request
readiness is `already-ready`, `marked-ready`, or `recovered-ready`.
`already-ready` means the initial exact PR is OPEN and non-draft;
`marked-ready` means the fresh intent owner confirmed its mark-ready mutation by
a full reread; `recovered-ready` means a prior/concurrent intent or lost
response was proven live. A concurrent request non-owner may return waiting;
retry recovers the one exact durable comment.

`advance` returns `{phase,revision,performedTransitions,terminal,waiting,nextAction}`.
Its terminals are `waiting`, `triage`, `escalation`, `failure`, and `done`; its
write names are `review-outcome`, `verification-escalation`, `ci-validation`,
and `cycle-completion`. It waits for absent review or CI, revalidates two live
snapshots and every gate between writes, and never requests review, resolves a
finding, or archives.
Conditional payloads are `escalation`, `ciValidation`, and `completed`.

The state gate selects `discovery` for the first three durable requests and
repeatable `verification` thereafter. By default there is no configured
request-count cap. If the operator configured a finite total limit, every
persisted request—including pending or later-stale evidence—consumes one slot,
and the gate rejects the next request before journaling or GitHub mutation once
the limit is reached. Findings from any allowed request return to triage. A
clean result from the final allowed request can still satisfy Done.

Read structured GitHub data. An ordinary review applies only when:

```text
review commit == recorded Review commit == current PR head
```

Any mismatch is stale. Do not infer commit identity from ordinary review prose.
A canonical exact-head `COMMENTED` review submission is clean only when its
body is a string with empty trimmed content and it has no attached canonical
root. Any nonempty trimmed body is findings even without an inline root, and
any attached canonical root is findings even when the body is empty. A missing
or non-string body is unsupported evidence and fails closed; never parse prose,
badge text, or severity wording to weaken that classification. Completion
rechecks the recorded clean review against these same live body and root rules.
Codex's official top-level comment may prove clean when it follows the recorded
request, its body has never been edited, and it contains exactly one full
structured `**Reviewed commit:** \`<lowercase-sha-prefix>\`` anchor line. The
prefix must resolve uniquely through complete local Git history to the recorded
request, integration, pushed, and live PR commit. Surrounding prose does not
participate in classification. Record the immutable comment identity as
`issue-comment` evidence only when no canonical review root was created at or
after the request. Count resolved as well as unresolved roots so later
resolution cannot erase findings history; unresolved threads remain the final
review-ready and Done gate. Ignore unrelated canonical comments without the
marker. Edited, malformed, duplicate, case-changed, unresolvable, ambiguous, or
wrong-head marker evidence fails closed. A clean thumbs-up on the recorded
request may also be accepted while its commit remains current. Multiple
canonical reviews, structural comments, or reactions are ambiguous; foreign or
pre-request evidence is not applicable.

## Resolve findings

After central integration, verification, targeted validation, and push, the
orchestrator replies to each source thread with concise commit and test evidence
and closes it. Then query GitHub again. Mark a finding Resolved only when GitHub
confirms its Codex thread is closed. A threadless finding becomes Resolved after
successful verification.

A successful close mutation alone is not confirmation. Integrated is not
Resolved, and neither means Done.

For each selected root, prefer the `unnecessary-mechanism-defect` removal or
trim path when it is sufficient. A `material-scope-change` cannot be resolved
by an earlier PR implementation: it requires an explicit decision, and an
approved replan must return with a new exact-head classification before these
GitHub gates reopen. This enforces correctness of the current PR rather than
preserving obsolete review-round machinery.

For an actionable Integrated `local` or `github-threadless` fix, or a selected
`not-applicable` task with disposition `duplicate`, `already-fixed`, `stale`,
`invalid`, `policy-conflict`, or `out-of-scope`, run `verify-resolve` only after
the read-only integration verifier has approved that task at the exact current
HEAD. `needs-human-decision` is never eligible. The command is the
orchestrator's guarded assertion of that verifier result: it repeats
clean-checkout, equal local/pushed/live HEAD, ancestry, state-revision, and fully
paginated canonical-root checks before writing task state. It never mutates
GitHub or creates a mutation journal. A local assertion completes only the
selected task. A threadless assertion adds only the selected task ID to
exact-HEAD threadless proof while preserving prior IDs. This assertion is
transition input, not a persisted verifier-artifact schema. GitHub-thread tasks
continue to use `reply-resolve`. For both commands, `--task` is one opaque task
ID preserved byte-for-byte; commas, whitespace, quotes, and backslashes are not
separators or escapes.

The guarded transition persists a local assertion in `localVerification` for
the exact integration HEAD. After HEAD drift, retain the old proof only as
history and rerun targeted validation plus read-only verifier approval before
calling `verify-resolve --task <id>` for each completed local task. The first
new-HEAD assertion records only its selected task; later same-HEAD assertions
accumulate coverage. A task already covered at the current HEAD is an
idempotent state retry only after every clean-checkout, equal-HEAD, ancestry,
canonical-root, and state-revision guard runs again. Do not request review or
mark Done until passed current-HEAD coverage exactly includes every completed
local task.

When integration advances after a completed threadless assertion, rerun the
targeted checks and read-only verifier for every task in the preserved proof at
the new HEAD, then pass that complete set to `verify-resolve` through one
`--task-set-json '["task-a","task-b"]'` string-array value. This is the only
multi-task encoding; `--task` always remains one opaque ID, even when it
contains a comma. JSON decoding preserves whitespace, quotes, backslashes, and
commas inside each ID. Selection order is irrelevant after decoding, but every
ID must be a unique nonempty string and the selected set must exactly equal the
preserved set; a partial, extra, unknown, ineligible, local, or
not-yet-completed selection is rejected before checkpointing. The command
atomically re-attests only that complete preserved threadless task-ID set at
the current HEAD while leaving the aggregate thread proof invalidated. A
one-task preserved set continues to use the ordinary opaque `--task` form, and
an already-current exact-set retry is idempotent. It rechecks every recorded
thread but may leave additional uniquely mapped roots unrecorded for
`reply-resolve`. If one such root was already replied to and resolved at a
prior integration HEAD, run `reply-resolve` next. Recovery is allowed only
through the sole exact prior-HEAD reply and its matching durable reply/resolve
intent lookups, with the prior HEAD proven as an integration ancestor; it
performs no duplicate GitHub mutation. Extra replies or markers, changed
resolution, HEAD drift, or state-revision drift fail closed.

One recovery-only batch variant exists for roots already resolved by an
archived cycle. First use `verify-resolve` to complete the actionable
GitHub-threadless remediation at the exact current HEAD. With a pristine
aggregate thread proof, `reply-resolve --task <terminal-non-actionable-id>` may
then select one canonical immutable proof lineage for the same repository and
PR. Every matching archive must be independently schema-valid and terminal,
carry exactly one completed task that projects exactly to the active
`not-applicable` task, and reproduce the complete selected-root proof rows in
stable root order. At least one origin archive must retain every reply and
resolve intent; multiple origins deduplicate only when their normalized proof
and intent authority is identical. A later replay carrier is allowed only with
that exact task-and-proof projection and zero selected-root intents. Partial or
conflicting intents and missing, duplicated, or divergent proof fail closed;
archive names, timestamps, ordering, and latest or earliest position are never
authority. Every authoritative archived proof row, historical HEAD, reply and resolve intent,
deterministic client ID, live canonical root, root comment, direct reply,
exact deterministic body, marker, author, parent, URL, timestamp, and resolution
state must agree, while all other live canonical roots still map uniquely to
active tasks. Root creation must be no later than logical reply intent, logical
intent no later than its persisted event, and that reply event no later than
the exact resolve intent. Resolve intent must be no earlier than the live
reply's represented-second start, and preserved durable proof no earlier than
resolve intent; intent events and proof must not postdate archived state or
terminal evidence. GitHub's second-granular reply timestamp represents an
interval rather than an exact mutation instant, so logical intent and its event
may follow the represented second's start. The reply-intent event must still be
before that second's exclusive end: `.999` is accepted only when it does not
follow resolve intent, and the next second's `.000` is rejected. When durable
`resolvedAt` is later than the resolve intent, the resolve-intent event must be
no later than that proof. Exact equality between `resolvedAt` and the resolve
intent denotes recovery's logical intent timestamp and may precede the event
envelope by its persistence latency.
Archive-local terminal metadata plus unrelated tasks, proofs, and events do not
enter the lineage authority, but each carrier still passes its own immutable
envelope validation. Linux reads archive files through pinned no-follow
directory descriptors rooted at `/proc/self/fd/<fd>`. Darwin instead uses the
standalone main-thread CLI's one synchronous process-cwd owner; `/dev/fd` child
traversal is never treated as available. Its authorized nested root and
candidate scopes pin and prove the current `.` before resolving and opening the
saved prior cwd, then require followed `.`, descriptor, and absolute-path
identities to agree before target open or `chdir` and before any scoped read. A
replaced saved path is not entered before target traversal; only an exact
re-proof of the initially pinned cwd makes that failure recoverable. Scopes
reject Promise or thenable callbacks and attempt and prove restoration in
`finally`. Recoverable nesting failures restore the caller cwd and release the
owner. An unprovable outer restoration or pre-target cwd poisons cwd and exits
before any continued workflow action. Worker-thread, overlapping-store, unsupported-
platform, and generic concurrent-library use fail closed without strategy
fallback. Both supported paths retain no-follow file opens, stable inode, size,
exact-byte, 128-KiB state, 16-MiB events, and 10,000-entry checks before parse or
candidate traversal.
Historical ancestry ignores replacement refs and rejects a nonempty
common-directory `info/grafts`, including in linked worktrees. The command
performs two complete evidence and head reads and one guarded state checkpoint;
it performs no GitHub mutation and no active or archived journal write. Missing,
edited, foreign, non-ancestral, or mixed-lineage evidence is fatal. A sorted
fingerprint binds every matching carrier across both reads: additions,
removals, and content changes are races, while enumeration-only reordering is
harmless. Do not manually copy proof or intent data and do not reopen threads.
Ordinary unresolved roots and the existing single-root prior-HEAD recovery keep
their existing `reply-resolve` paths.

If there is no applicable ordinary carrier for the active task, a stricter
aggregate archive mode may retain multiple historical task partitions. The
active task must be terminal `already-fixed`, have a null integration commit,
and name at least two canonical roots through explicit `thread:` and/or
`discussion:` sources. Fully paginated live identity normalizes both aliases
and counts dual aliases for one root once. One schema-valid
terminal historical full carrier must cover exactly that exclusive live-root
set. Its completed GitHub-thread tasks form the only disjoint cover: every task
owns its full explicit root partition, has one observed historical HEAD, and
projects actionable to `fixed` with a commit or already-fixed to
`already-fixed` with null. A partial carrier is relevant only when it contains
an exact union of whole anchored partitions. Intent-only carriers, sliced or
overlapping partitions, alternate covers, and collections of partial carriers
without a full anchor are rejected.
Every archive that names the active task ID in either a task object or proof
row is relevant, including an active carrier whose provenance is wholly
off-selection or whose task object is missing. After the full carrier anchors
historical task IDs, any same-repository/PR archive naming one of those IDs in
a task object, proof-row `taskIds`, or `archiveProvenance.historicalTaskId` is
relevant too. For each relevant historical or
active-replay carrier, selection scans every archived GitHub-thread task whose
canonical thread/discussion sources touch a selected root and all proof rows
naming an anchored task. Hidden off-selection proof, unanchored overlap, or an
incomplete whole partition is fatal. Selected roots, partition count, and carrier/root
roles, relevant carriers, and selected intent footprints consume one cumulative
node budget before projection cloning, sorting, intent, and live lineage work;
intent evidence is indexed once per carrier.

Origin and replay are classified separately for each carried root. A carrier
can replay five older roots and originate four newer ones, but every root must
have at least one exact reply-plus-resolve origin at that root's own historical
HEAD. Equivalent duplicate origins normalize identically; wrong-PR, wrong-HEAD,
partial, duplicated, aliased, cross-partition, or conflicting intent footprints
fail closed. Lineage proves each actionable historical commit to its proof
HEAD, proof HEAD to carrier durable HEAD, and carrier HEAD to current HEAD. The
two inventory reads fingerprint archive ID, content, partition/root role, and
normalized authority in stable order and rerun every distinct ancestry
relation. Harmless enumeration reordering does not change the fingerprint.

Successful aggregate adoption still performs zero GitHub, journal, or archive
mutation and one guarded task-completion checkpoint. Imported rows map to the
fresh active task and `already-fixed` disposition, retain their per-root
observed heads, and receive strict closed `archiveProvenance`: version 1,
historical task ID, historical `fixed` or `already-fixed` disposition, nullable
historical commit, UTF-8 reply-body SHA-256, and one shared authority
fingerprint. Every later live proof gate validates the recorded reply's exact
header head (exact lowercase 40 or 64 hex), sole marker anchor, actor, parent,
URL, no-edit state, historical task
line, and body digest without rereading archives. A later full active-task
carrier is a valid aggregate replay only when every selected row retains
consistent provenance, it has zero selected-root intents, and it contains no
unanchored selected-root task or off-partition historical proof. Legacy rows
remain provenance-free. A genuine valid provenance-free active-task carrier
uses ordinary single-head adoption; malformed ordinary carriers fail there,
while stripping an aggregate carrier to active-ID legacy rows never falls
through to aggregate recovery.
Multiline already-fixed task content remains valid because the full UTF-8 body
hash is authoritative, but the task block, single validation boundary, and sole
deterministic marker must parse without ambiguity. Marker-shaped task content
or a second validation boundary rejects before the adoption checkpoint.

The checkpoint is capability-separated: only the fully validated archive
importer calls `checkpointArchiveTaskCompletion` with a closed envelope binding
the selected task, exact newly resolved roots, per-row reply/body/provenance
fingerprints, and common authority. State revalidates it under lock before
authorizing `archive-task-completion`. Ordinary `checkpointTaskCompletion`
categorically rejects caller-supplied archive envelopes and newly introduced
provenance; generic `checkpointState` rejects provenance creation too. Every
resolved adopted row is immutable afterward and replay is idempotent only for
byte-identical provenance and authority.

If the live resolved batch makes ordinary `verify-resolve` circular, the first
command has one state-only bootstrap topology. The selection must be a singleton
and the sole actionable Integrated GitHub-threadless remediation. Aggregate,
threadless, and local proof must all be pristine. Exactly one exclusive terminal
`already-fixed`, null-commit, `not-applicable` GitHub-thread task must own at
least two live resolved roots;
every other fully paginated canonical root must be unresolved and owned only by
either an actionable Integrated or Resolved GitHub-thread task or an eligible
terminal `already-fixed`, null-commit task that will use ordinary
`reply-resolve` afterward. Unknown, missing,
duplicate, shared, additionally resolved, or ambiguously remediated roots fail
closed. Two complete live snapshots must reproduce the exact candidate, root
mapping, local/pushed/live/durable head identities, and state revision.

Success completes only the selected remediation and replaces only pristine
threadless proof with singleton exact-current-HEAD coverage. It preserves the
aggregate status, head, rows, timestamp, and local proof byte-for-byte and is
idempotent only after all guards run again. A completed retry enters this
bootstrap only when the terminal task's immutable `thread:` and `discussion:`
aliases resolve through the canonical live mapping to at least two distinct
root identities. Dual aliases for one root count once, keeping that task on the
ordinary fully guarded threadless retry. This command performs no GitHub
mutation, no mutation-journal read or write, and no archive read or write; its
two fully paginated GitHub reads are intentional. It never synthesizes
aggregate proof. Run `reply-resolve` second; it alone selects and trusts one
immutable archive and retains every ordinary projection, intent, reply-body,
timestamp, ancestry, live-evidence, and race gate.
For a composite retained batch followed by new current work, use exactly:
`verify-resolve --task <remediation-id>`,
`reply-resolve --task <retained-aggregate-id>`, and then ordinary
`reply-resolve --task <current-root-task-id>`. Only the third command posts a
reply or resolves a thread.
For PR #35 those task IDs are, in order,
`pr-review-multi-historical-archive-aggregate-adoption-r2`,
`retained-pr35-nine-roots-r1`, and
`retained-pr35-portable-archive-reader-r1`.

## Run Codex and CI together

Once targeted local validation passes and the Review commit is pushed, Codex
review and GitHub Actions may run concurrently. CI owns:

```bash
npm run check:full
npm run test:e2e:full
```

Record the workflow run, attempt-specific `Full validation` check-run ID, source
`github-actions`, full scope, exact commit, and result. A run for another commit is stale. A partial workflow or targeted local
result cannot satisfy the full CI gate. Only the `Full validation` job from
`.github/workflows/ci.yml` counts; missing workflow identity fails closed.

Before the first discovery review in a pristine taskless cycle, run
`refresh-threads --pr <number>` after targeted validation. It records guarded
exact-head proof only when the fully paginated canonical Codex root set is empty;
it never marks a threadless remediation task verified and never writes GitHub.

The same read-only empty-root refresh is narrowly available after native-v3
taskless clean-review HEAD-drift recovery. First rebuild nonempty targeted
validation at the current HEAD through the explicit initial-selection route.
The retained latest clean request and outcome must match each other exactly on
one different prior SHA, the state must remain `recovering` with review
allowance and no tasks, blockers, escalation, or human decision, and local,
pushed, and live PR heads must all equal the current state HEAD. The command
fully paginates canonical roots, re-reads state revision and live PR HEAD, and
checkpoints only an aggregate passed empty-thread proof at the current HEAD. It
preserves historical threadless evidence and performs no GitHub or journal
mutation. Any live root, evidence mismatch, exhausted allowance, or state/head
race fails closed; the historical clean review remains stale and must not be
used for Done.

It is also available after native-v3 taskless pending-request HEAD drift. First
checkpoint the new clean HEAD and rerun an explicit nonempty current-HEAD
targeted selection. The active request must exactly equal the latest immutable
history request, both outcomes and `reviewedHeadSha` must remain `null`, and no
task, blocker, escalation, or human decision may exist. The pending row remains
unchanged and counts toward any finite total limit.

`refresh-threads` then fully rereads the original request anchor, request
reactions, canonical reviews/comments/roots, local and pushed Git, and the live
PR head. Missing, edited, foreign, conflicting, or otherwise ambiguous evidence
cannot enter recovery; verification ambiguity is durably escalated to a human.

For a discovery request, status and refresh distinguish four cases:

- `pure-head-drift`: no canonical response exists. No disposition is written;
  with no root, the existing empty-proof recovery applies.
- `disposition-ready` or `dispositioned`: exactly one supported response is
  bound durably to the original request/prior HEAD and the different current
  live HEAD. Its fingerprint covers exact response content and immutable
  attached-root source evidence. A clean response may restore readiness after
  final proof.
- `actionable-stale-findings`: the unique response contains findings or its own
  canonical roots. Append the disposition, then use ordinary triage, task
  mapping, reply, and resolution; never auto-resolve those roots.
- `ambiguous-human-decision`: the anchor or response is missing, edited,
  duplicated, foreign, unsupported, multiple, conflicting, same-head,
  migrated, or inconsistently bound. Stop for a human.

Disposition refresh takes a second fully paginated snapshot and compares the
exact response identity and root state, then repeats checkout,
local/pushed/live-head, and state-revision guards before its state-only
checkpoint. A request anchor with any edit timestamp fails the immutable-anchor
check even if its current text was restored. It never writes GitHub, creates a
request journal, synthesizes a current-head outcome, fills the original null
history outcome, or changes the request ordinal. Identical disposition/proof
retries lock state and atomically reread the current revision without writing;
any evidence, root, head, or revision race fails closed. The
next `request` derives its kind from full durable history. If that history has
exhausted a finite limit, disposition and proof remain, and only the replacement
request is blocked with the exact command to raise or remove the limit.

## Done gate

Poll pending review work with `npm run review:github -- advance --pr <number>`.
The supported command surface therefore includes `advance --pr <number>`.
It records only stable canonical review, CI, and completion transitions; it
never requests a new review, resolves findings, or archives state. `status`
remains a read-only observation command.

`status` is diagnostic and non-mutating. It exposes volatile
`pullRequest.state`/`pullRequest.isDraft`, unchanged durable `codexReview`, and
`reviewObservation` with `not-applicable`, `waiting`, `collectable`,
`ambiguous`, or `stale` status plus typed evidence IDs. `request` reports
`already-ready`, `marked-ready`, or `recovered-ready`; it journals the exact
`ready:<pr>:<pr-node>:<head>` intent before defensive promotion. Issue 25 PR
preparation must create ready PRs rather than depending on that recovery path.

`advance` waits for no response or missing/pending CI, stops at findings,
durably escalates verification ambiguity, rejects discovery ambiguity, records
failed CI, and only records clean+green Done after repeating all live gates. It
never creates another request, resolves a finding, or archives state.

The exact observation shape is `reviewObservation: {status, outcome,
evidenceType, evidenceIds}`. Status, collect, and advance share its canonical
classifier: actor identity, timestamp, exact SHA, body and root state,
reaction, structural marker, fingerprint, and duplicate/cross-channel
ambiguity rules are identical.

Request reads volatile OPEN/non-draft readiness. For a defensively promoted
draft it journals `ready:<pr>:<pr-node>:<head>` before the exact mark-ready
mutation, then rereads PR, head, roots, and revision before either mutation.
Retries recover that intent without duplicate review comments. Collection and
advancement use the same canonical response classifier and require two matching
complete response/root snapshots before any checkpoint; races fail closed.

The cycle is Done only when all of these facts apply to one Review commit:

1. The commit remains review-ready and is the current PR head.
2. Codex returned a clean applicable review, clean issue comment, or eligible clean thumbs-up.
3. Full GitHub Actions checks passed.
4. The full E2E suite and complete browser/device matrix passed in CI.
5. Every finding has a recorded outcome, every actionable task is Resolved,
   and every completed local task has passed exact-current-HEAD verifier proof.
6. A fresh GitHub query shows no open Codex review threads.

Before saving Done, read the exact-commit CI rollup again and confirm that the
same successful full workflow run is still authoritative.

The machine phase remains `complete`; human status should display Done. Archive
normally only after this gate passes.

## Loop breakers

Continue exact-commit review, remediation, and verification until Codex returns
clean. The first three durable requests are discovery reviews; every later
request is a repeatable verification review. An optional durable operator limit
is the only request-count stop, and exhaustion pauses only a new request until
the operator raises/removes the limit or stops the cycle.

An exact recorded request that becomes stale because the live HEAD advances is
recoverable for either kind. Missing, edited, duplicated, foreign, unsupported,
multiple, conflicting, or otherwise ambiguous canonical evidence remains a
fail-closed human escalation and is not cleared by changing a request limit.

If the same stable finding returns in two consecutive rounds, pause repeated
patching and investigate the root cause.

## Recovery

Run `npm run review:state -- recover`, then re-read Git, GitHub, and CI.
If state is invalid, use `state.backup.json`, Git history, structured GitHub
metadata, and CI artifacts. Never reconstruct decisions from Codex transcripts.
Explicitly migrate old state. To abandon a non-Done cycle, record the PR number
and reason durably before archival.
# Request dispatch recovery

The request intent is durable before any GitHub write. Immediately before the
single `AddReviewRequest` attempt, the workflow records a durable dispatch
marker while holding the PR request-owner lock. An intent without that marker
may be reclaimed after a dead owner; a marker without a uniquely visible
comment is intentionally **uncertain** and `request` returns waiting rather
than replaying a potentially accepted mutation. `clientMutationId` is a
correlation value, not GitHub idempotency. Wait, then rerun
`npm run review:github -- request --pr <number>` to checkpoint the one exact
immutable viewer comment; multiple candidates fail closed. This pre-checkpoint
uncertainty cannot be reconciled by `advance`; once the request is checkpointed,
monitor it with `advance`.
