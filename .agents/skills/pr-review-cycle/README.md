# How the PR review cycle works

Aerstello keeps review work in the repository. One main agent coordinates the
cycle; there is no separate implementation service. Start or resume it with:

```text
Use $pr-review-cycle to continue the current PR remediation session.
```

## The eight steps

1. **Restore the saved state.** The main agent reads the PR's durable state and
   checks Git, GitHub, CI, and release information. It never rebuilds decisions
   from a chat transcript.
2. **Confirm the current commit.** It confirms the explicit PR number, local
   commit, pushed PR head, and release status. A release exists only when a valid
   production marker and matching annotated tag are reachable from `main`.
3. **Ask Codex to review that exact commit.** Only the main agent posts
   `@codex review`. A result counts only when it applies to the recorded Review
   commit, which must still be the current PR head.
4. **Plan the findings.** The main agent groups comments with one root cause and
   creates independent, fixed tasks. Each task names its owned paths, acceptance
   criteria, one specialist profile, compatible risks, exact related tests, E2E
   selectors, browser projects, and reasons. A `behavior_mapper` listed in the
   reusable route's `planningHelpers` runs before the immutable packet is bound.
5. **Run isolated fix workers.** Each worker starts from the Review commit in a
   separate worktree, edits only its assigned paths, runs only its recorded
   validation, and returns one structured result. Workers never push, integrate,
   update central state, delegate, or write to GitHub.
6. **Integrate and test the batch.** The main agent accepts valid worker commits,
   integrates them in dependency order, and runs the union of related checks.
   Browser checks use selected scenarios and normally `tablet-chromium`. It then
   runs only routed exact-HEAD risk reviewers, converts findings into ordinary
   tasks, and confirms their evidence is current and clean. The PR workflow then
   selects and runs its own read-only `integration_verifier` alone, using the
   generated context's aggregated final-verification priority.
7. **Push and run review plus CI.** The main agent pushes the new Review commit,
   posts evidence, closes fixed Codex threads, and confirms none remain open.
   After targeted local checks pass, Codex review and full GitHub Actions may run
   at the same time.
8. **Finish only when every gate matches.** The cycle is Done when Codex is clean,
   full CI including the full E2E matrix is green for the same Review commit,
   every finding has an outcome, and GitHub shows no open Codex threads.

## Glossary

| Term | Meaning |
| --- | --- |
| **Review commit** | The exact pushed commit sent to Codex. |
| **Integrated** | A worker commit is now on the central PR branch. |
| **Resolved** | The fix was verified, evidence was posted, and its Codex thread is closed. |
| **Done** | Codex is clean and full CI, including full E2E, is green for the Review commit, with no open Codex threads. |

The machine state still uses task status `completed` for Resolved and cycle
phase `complete` for Done. These are storage names, not extra workflow stages.

## Durable state and recovery

Use the npm façades directly from the repository root:

```bash
npm run review:state -- show
npm run review:github -- status --human
npm run review:github -- advance --pr 123
npm run review:worktree -- inspect --pr 123 --task finding-a
```

New cycles have no configured review-request count cap. To start with a finite
total limit, pass `--review-limit <positive-safe-integer>` to `review:state init`.
Change that policy with an exact revision guard:

```bash
npm run review:state -- set-review-limit --pr 123 --expected-revision 8 --limit 10
npm run review:state -- set-review-limit --pr 123 --expected-revision 9 --unlimited
```

Every durable request record counts, including pending or later-stale requests.
The first three requests retain the historical `discovery` kind; later requests
use repeatable `verification`. Reaching a finite limit blocks only the next
GitHub request, not triage, remediation, validation, or completion from a clean
final allowed review.

Native schema-v3 state may also contain the optional bounded
`staleDiscoveryDispositions` ledger. Each append-only record binds one latest
null-outcome discovery request and its uniquely classifiable canonical response
to the exact request HEAD and the different live recovery HEAD. Its response
fingerprint covers exact response content and immutable attached-root source
evidence, so a same-classification edit cannot be adopted. The original
request and null history row remain unchanged and continue to count toward the
request limit. Older schema-v3 documents without the ledger remain readable;
migrated request provenance cannot acquire a disposition.

From a nested npm workspace directory such as `apps/api`, prefix npm with the
checkout's Git root so npm selects the root package scripts:

```bash
npm --prefix "$(git rev-parse --show-toplevel)" run review:state -- show
npm --prefix "$(git rev-parse --show-toplevel)" run review:github -- status --human
npm --prefix "$(git rev-parse --show-toplevel)" run review:worktree -- inspect --pr 123 --task finding-a
```

The scripts discover checked-in skill, schema, and feature resources from this
skill and the checkout's Git top level. Mutable review state is different: it
always lives under `<git-common-dir>/codex/pr-review/`, so every linked worktree
shares the same active pointer, state, archives, locks, manifests, and task
worktrees.

State migration is explicit and one-way. Preserve the exact pre-migration
backup, validate it before writing schema v3, and never migrate active state
downward. Archive a Done cycle, or an abandoned cycle with an explicit durable
reason, into a new timestamped directory and clear the active pointer. Never
rewrite an archive, delete worktree manifests as cleanup, or prune stale Git
worktree registrations as part of state recovery. Recover from state, its
backups and event log, Git, structured GitHub data, and CI evidence—not from a
chat transcript.

Schema-v3 task packets are persisted immutably under `task-packets/` before
their digest is checkpointed. The same locked transition also persists hashed,
immutable `task-binding-provenance/` evidence for the exact receipt-verified
pre-bind signals, route, and reviewed-HEAD behavior-mapper result. An adjacent
immutable `.sha256` receipt covers that complete provenance, including mapper
evidence. Exact-HEAD
specialist plans and concise results live under `specialist-reviews/`, with an
immutable `.plan.sha256` receipt next to each mutable result bundle. Recovery
verifies packet, binding-provenance and its receipt, plan receipt, and result
evidence.
Missing, altered, pending, stale, clean, or finding specialist evidence is
reported explicitly; no profile, risk, or planning signal is inferred for
legacy bound tasks. These sidecars keep the active state schema at v3 and move
with the PR directory when it is archived.

Worker validation output is not durable acceptance. The orchestrator runs the
revision-guarded `accept-result` transition, which receipt-binds the complete
canonical schema-v3 result under `worker-results/` before integration. Generic
checkpoints cannot add or rewrite that digest, and the final verifier context
includes every receipt-verified result. Native-v3 work already Integrated at
the contract boundary may use `backfill-result` with its original result and
exact worker-to-central commit-delta proof; migrated state never fabricates one.
The worker result names one non-root, non-merge commit `W` with sole parent
`P`. The Review commit may precede `P` because dependencies can already be
Integrated, but ownership is always the no-renames `P`-to-`W` delta. Integration
accepts a named central commit `C` only when `P` is ancestral to `C`'s parent.
Before inspecting any commit, the inspector uses replacement-disabled Git to
resolve the actual common Git directory, including from a linked worktree. It
refuses a nonempty `<git-common-dir>/info/grafts`; an absent or empty file is
inert. All remaining authority reads ignore replacement refs and read the actual
commit objects. The inspector emits the binary full-index `P`-to-`W` patch
without renames, external diffs, text conversion, or ignored submodules, and
forces the applyable short gitlink format. It applies that patch with cached
three-way semantics inside a unique temporary Git directory, index, and object
store rooted at `C`'s parent, and requires the complete resulting tree to equal
`C`'s actual tree. The proof clears inherited Git configuration, disables
system and user configuration and attributes, and gives temporary
`info/attributes` highest precedence with the built-in `merge=text` driver, so
repository attributes and custom merge drivers cannot affect or execute during
authority inspection. It reads repository objects only through an alternate;
the temporary repository declares the same SHA-1 or SHA-256 object format. All
temporary authority files and object writes are removed in `finally`. This
permits an exact cherry-pick over nonoverlapping same-file history while
preserving paths, statuses, modes, gitlink pointers, whitespace, added/deleted
bytes, and binary content. Whitespace-normalizing patch identities are not
authority.

Nested specialist routes use the workflow-neutral v2 shape: `planningHelpers`,
`riskReviewers`, `supplementalGuidance`, and `finalVerificationPriority`. They
never contain the PR verifier. Read-only `specialist-context` adds the PR-owned
`finalVerification` descriptor for `integration_verifier` and reports it ready
only after every routed exact-current-HEAD risk result is present and clean.

A task in neutral `proposed`, `blocked`, or `failed` execution—or already
`integrated`—whose packet digest came directly from an immutable schema-v2
migration backup has one narrow recovery command:

```bash
npm run review:state -- replan-task-packet --task '<opaque-id>' --expected-revision <n>
```

It accepts no packet, verifies the backup's state/task identity and digest,
rejects schema-v3 sidecar evidence, deletes nothing, and cannot change a native
schema-v3 or completed binding. `queued`, `running`, and `implemented` tasks are
rejected, as is any nominally safe status that still has a worker, branch,
worktree, or worker commit. Safe pre-integration execution returns to a neutral
Proposed task; Integrated commit and resolution facts remain. Targeted proof is
invalidated. Follow it with the normal explicit schema-v3 `specialist-plan` and
`bind-task-packet` flow. The task option is one opaque value, not a comma list.

## Review-ready and Done

Review-ready is the handoff from targeted local work to Codex and CI. It means:

- no worker is active and accepted fixes are Integrated;
- the checkout is clean;
- the union of related local checks passed;
- selected E2E scenarios passed when needed;
- relevant release-policy checks passed;
- the branch is pushed and local HEAD equals the PR head; and
- GitHub was queried after prior thread closures and shows none still open.

Review-ready does not require local `check:full` or local full E2E. GitHub
Actions runs `npm run check:full` and `npm run test:e2e:full`. Related browser
tests use explicit stable selectors and default to `tablet-chromium`; add a
project only when responsive, touch, installation, cross-device, or
browser-specific behavior needs it. Unknown related-test selection is a
planning error, never permission to fall back to the full local suite.

Use `advance --pr <number>` for polling: it records a uniquely stable review
outcome, authoritative CI result, and Done transition only when every live gate
still applies. `status` is deliberately read-only. New PR preparation (issue
25) must create a ready, non-draft pull request; request-time draft promotion is
only a defensive recovery boundary.

`status` is diagnostic: it reports volatile `pullRequest.state` and `isDraft`,
the unchanged durable `codexReview`, and one `reviewObservation` of
`not-applicable`, `waiting`, `collectable`, `ambiguous`, or `stale` with exact
evidence identities. `advance` is the operational poller. It waits without a
write for review or missing/pending CI, stops in triage for findings, preserves
verification escalation, records failed CI, and reaches Done only after clean
review and CI are repeatedly re-proven. It never requests review, resolves
findings, or archives.

`request` returns `pullRequestReadiness` as `already-ready`, `marked-ready`,
or `recovered-ready`. Draft promotion proves the ordinary gates, journals
`ready:<pr>:<pr-node>:<head>`, rereads OPEN/non-draft PR, HEAD, roots, and
revision before posting the request, and recovers that intent after a lost
response. This volatile readiness is not a review-state schema field.

`advance` is the monitoring command: no response and missing/pending CI wait;
findings stop in triage; verification ambiguity escalates while discovery
ambiguity fails closed; failed CI is recorded; clean plus green CI records
outcome, CI, and Done; Done is idempotent and never archives. It repeatedly
re-proves OPEN/non-draft state, HEAD, request anchor, roots, CI, and revision
between writes, and never requests another review or resolves findings.

When collecting an exact-head canonical `COMMENTED` review submission, treat it
as clean only if its body is a string whose trimmed content is empty and no
canonical root is attached. A nonempty body is findings even without an inline
root, while an attached canonical root is findings even with an empty body.
Missing or non-string bodies are unsupported and fail closed; the workflow does
not interpret prose, badge text, or severity wording. The Done transition
freshly rechecks a recorded clean review against the same live body and root
rules.

For a pristine taskless first review, save and run the explicit initial targeted
validation selection, then use
`npm run review:github -- refresh-threads --pr <number>` to record guarded
exact-head proof that the fully paginated canonical Codex thread set is empty.
This read-only GitHub operation fails closed if any canonical root exists and
does not verify later threadless remediation tasks.

After read-only integration verification, resolve one eligible non-thread task
with `npm run review:github -- verify-resolve --pr <number> --task <id>`.
Eligibility covers an
actionable Integrated `local` or `github-threadless` fix, plus a
`not-applicable` task whose disposition is `duplicate`, `already-fixed`,
`stale`, `invalid`, `policy-conflict`, or `out-of-scope`;
`needs-human-decision` remains ineligible. This state-only command is the
orchestrator's guarded assertion that the selected task passed verifier review
at the exact current HEAD. It rechecks a clean checkout, equal
local/pushed/live heads, task ancestry, state revision, and the fully paginated
canonical root set without writing to GitHub or creating a mutation journal.
It completes only the selected local task, or adds only the selected threadless
ID while retaining prior exact-HEAD proof. GitHub-thread tasks remain on
`reply-resolve`. The verifier assertion is guarded transition input; no
separate persisted verifier-artifact schema is implied. `--task` is always one
opaque task ID for either command and is preserved byte-for-byte; commas,
whitespace, quotes, and backslashes have no separator or escape meaning.

Local assertions are also persisted as `localVerification` task-ID coverage for
the exact current integration HEAD. If HEAD advances, the old proof remains
historical while review and Done stay closed. Rerun targeted validation and the
read-only verifier, then call
`npm run review:github -- verify-resolve --task <id>` separately for each
completed local task. The first successful assertion at the new HEAD starts a
new set containing only that task; later same-HEAD assertions accumulate IDs.
A retry already covered at that HEAD is state-idempotent, but still repeats all
clean-checkout, HEAD, ancestry, canonical-root, and state-revision guards.

If integration HEAD advances after a threadless task was already completed,
repeat current-HEAD targeted validation and read-only verifier approval for
every task in the preserved proof. Then select the complete set atomically with
one explicit JSON string-array option, for example
`npm run review:github -- verify-resolve --pr <number> --task-set-json '["threadless-a","threadless-b"]'`.
This is the only multi-task encoding: `--task threadless-a,threadless-b` means
one literal task ID containing a comma. JSON decoding preserves whitespace,
quotes, backslashes, and commas in each ID. Order does not matter after
decoding, but IDs must be unique nonempty strings and the selection must exactly
equal the preserved task-ID set. Partial, extra, unknown, ineligible, local, or
not-yet-completed selections are rejected before checkpointing. A singleton
preserved set keeps the ordinary opaque `--task` form, and an already-current
exact-set retry is idempotent. The successful transition refreshes only that
complete threadless proof at the current HEAD without fabricating an aggregate
thread proof or discarding recorded thread rows. Additional uniquely mapped
live roots remain for `reply-resolve`. When one such root already has the exact
reply and resolution from a prior integration HEAD, `reply-resolve` may recover
it only after the refresh, from that sole immutable reply plus the correlated
durable reply and resolve intent lookups and proven prior-HEAD ancestry. It does
not repeat either GitHub mutation. Extra replies or markers and any resolution,
live-HEAD, or state-revision drift are rejected.

A separate recovery-only `reply-resolve --task <id>` path may adopt a batch of
already-resolved roots from one canonical immutable archive-proof lineage. It is available only
for a terminal non-actionable GitHub-thread task, an otherwise pristine current
aggregate thread proof, and current-HEAD verifier coverage for a completed
actionable GitHub-threadless remediation. Every live canonical root must first
map uniquely to an active task. Every same-PR, same-repository archive carrying
the task must be independently valid and terminal, project its one completed
task exactly to the active task, and carry the identical complete selected-root
proof rows in stable root order. One or more lineage origins must retain the
complete reply and resolve intent authority and correlate exactly with the
unchanged live roots, comments, deterministic reply bodies, markers, authors,
timestamps, and resolution state. Multiple origins are accepted only when
their normalized proof and intent authority is identical. Later replay
archives may carry different terminal metadata, unrelated tasks, proof rows,
or events, but are tolerated only when their selected proof projection is
identical and they contain zero selected-root mutation intents; partial or
conflicting intent evidence and every divergent projection fail closed. Archive
names, timestamps, enumeration order, and latest or earliest position never
establish authority. The production reader pins real no-follow archive and
candidate directory descriptors, opens evidence files read-only and no-follow,
requires stable pre/post inode and byte evidence, and applies the 10,000-entry
bound before reading any canonical candidate; `.partial` entries stay ignored.
Timestamp evidence must place root creation no later than the logical reply
intent, that intent no later than its persisted event, and the reply event no
later than the exact resolve intent. Resolve intent must be no earlier than the
live reply's represented-second start, and the preserved durable proof no
earlier than resolve intent. Intent events and proof remain bounded by archived
state and terminal evidence. GitHub's second-granular reply timestamp represents
an interval, not an exact mutation instant: logical intent and its event may
occur after the represented second's start, but the event must be before its
exclusive end. `.999` within that second is valid only when it does not follow
resolve intent, while the next second's `.000` is not. A resolve proof recorded
later than its intent must also follow the persisted resolve-intent event; exact
equality with the resolve intent is the recovery form that deliberately stores
the logical intent time, so its event envelope may be milliseconds later.
Historical ancestry
uses actual Git objects with replacement refs disabled and refuses a nonempty
common-directory `info/grafts`, including from linked worktrees.
It fingerprints the sorted complete carrier inventory and rereads the lineage,
GitHub, Git heads, checkout cleanliness, ancestry, and state revision before one
ordinary task-completion checkpoint. Added, removed, or altered carriers fail
as a race, while list-only reordering is harmless. It posts no reply,
resolves no thread, creates no intent, and appends no mutation-journal event.
Use `verify-resolve` for the remediation task first; never copy proof rows or
journal events manually, and never reopen a resolved thread to manufacture a
normal resolution path. Single-root prior-HEAD recovery and ordinary unresolved
thread handling remain the normal `reply-resolve` behavior.

When the resolved archive batch itself prevents the remediation's ordinary
aggregate-proof gate, use a two-command state-only bootstrap. First run
`verify-resolve --task <remediation-id>` for the sole actionable Integrated
GitHub-threadless remediation. This exception exists only when the aggregate,
threadless, and local proofs are pristine; one exclusive terminal
`not-applicable` GitHub-thread task owns at least two live resolved roots; and
every other fully paginated canonical root is unresolved and maps exclusively
to an actionable Integrated or Resolved GitHub-thread task. The command proves
twice that the hypothetical singleton remediation proof enables the existing
archive-adoption predicate, while rechecking clean equal local, pushed, live,
and durable heads plus the exact state revision. It then completes only that
remediation and records only singleton exact-current-HEAD threadless coverage.
Aggregate status, head, rows, timestamp, and local proof remain byte-for-byte
unchanged. An exact retry repeats all topology, pagination, head, checkout, and
revision guards before returning idempotently. Completed-retry bootstrap
handling is armed only when the terminal task's immutable `thread:` and
`discussion:` aliases resolve through the canonical live mapping to at least
two distinct root identities. Both aliases for the same root count once, so an
ordinary one-root terminal task retains the guarded completed-threadless retry
path.

Then run `reply-resolve --task <terminal-id>` to select and verify the immutable
archive through the ordinary batch-adoption path. The bootstrap never reads an
archive, trusts archived proof early, reads or writes the mutation journal,
mutates GitHub, or fabricates aggregate thread rows. Unique archive selection,
exact intent/reply/timestamp evidence, ancestry, live rereads, races, and the
single adoption checkpoint remain solely `reply-resolve` responsibilities.

A schema-v2 migration may preserve a taskless pending review for the exact
integration HEAD while deliberately clearing legacy targeted-validation proof.
After that preserved review is collected as clean,
`npm run review:state -- validation-plan --initial-selection <file>` may rebuild
the explicit nonempty selection without
requesting the review again. This exception requires no tasks and exact matching
current request, outcome, latest history entry, kind, and requested/reviewed
SHAs. It rejects pending, finding, stale, dirty, or inconsistent states and does
not infer checks from a missing legacy plan or replace an existing passing proof
after an ordinary taskless review.

A separate native schema-v3 route recovers a taskless clean review
after the integration HEAD advances. The clean request, outcome, requested, and
reviewed SHAs must still agree on one prior commit different from the current
HEAD, and the latest history entry must exactly equal the active evidence. The
state must be `recovering`, have no tasks, blockers, escalation, or human
decision, retain configured review-request allowance, and have a clean exact
current checkout. Use a nonempty current-HEAD
`npm run review:state -- validation-plan --initial-selection` selection
(`--replace` may replace only
the stale plan sidecar), then run it normally. The old review ledger is preserved
byte-for-byte and remains historical.

After that fresh targeted proof passes, run
`npm run review:github -- refresh-threads --pr <number>`.
The read-only command requires equal clean local, pushed, and live current
heads, fully paginates the canonical root set, rechecks state revision and live
HEAD, and succeeds only when no canonical root exists. It records an aggregate
passed empty-thread proof for the current HEAD while retaining historical
threadless evidence, with no GitHub or journal mutation. A new exact-current-
HEAD review is still required; the historical clean result cannot satisfy Done.

A native schema-v3 taskless pending request has a separate guarded recovery
when its exact immutable request comment still exists but the integration and
live PR head advance before an outcome is recorded. Checkpoint the new clean
HEAD, save a nonempty current-HEAD `--initial-selection` (`--replace` may
replace only the stale plan), and run the selection. The request, its null
outcome, and the complete history row remain byte-for-byte historical and still
consume their configured request slot.

Then run `refresh-threads`. It rechecks the request anchor, current validation,
clean equal local/pushed/live heads, complete canonical evidence, state
revision, and the final live head. It writes no GitHub mutation or request
journal. A request anchor with any edit timestamp is not immutable. Missing,
edited, duplicated, foreign, unsupported, multiple,
conflicting, same-head, migrated, or inconsistently bound evidence remains a
human gate; ambiguous verification evidence is durably checkpointed for that
decision.

For discovery, no canonical response is pure HEAD drift: no disposition is
written, and the existing guarded empty-proof route restores readiness only
when the fully paginated canonical root set is empty. Exactly one supported
response instead receives one immutable disposition. A clean response may
restore readiness only after a second full evidence/root read plus repeated
checkout, local/pushed/live-head, and revision checks. A findings response
enters ordinary triage; its canonical roots are not auto-resolved or converted
into a current-head outcome. The active `reviewOutcome`, `reviewedHeadSha`, and
null history outcome remain unchanged in both cases.

An identical disposition/proof retry takes the state lock and atomically
rechecks its revision without writing another revision; evidence, root, head,
or revision races fail closed. The ordinary request command derives the
replacement kind from the complete durable ordinal and appends a new immutable
row. An exhausted finite limit preserves disposition and thread proof but
blocks only that request with the exact raise-or-remove command; unlimited
policy permits the replacement.

`review:github status` reports stale discovery evidence as `pure-head-drift`,
`disposition-ready` or `dispositioned`, `actionable-stale-findings`, or
`ambiguous-human-decision`. Treat the last category as a human decision, never
as permission to repair evidence heuristically.

There is one further migration-only `--initial-selection` route for completed
tasks. Its immutable `state.v2.backup.json` must contain a nonempty all-completed
task set and an exact-head passed, nonempty legacy targeted proof. A schema-v2
`ready-for-review` or `complete` source is eligible only when canonical migration
reproduces the active `recovering` state exactly. A schema-v2 `awaiting-review`
source may preserve its exact pending request; after one guarded clean exact-head
outcome is collected, canonical migration plus exactly that outcome transition
must reproduce the active `validating` state, normalizing only checkpoint
revision and timestamp metadata. The active state must have targeted validation
`not-run`, a clean exact current integration HEAD, zero actionable Integrated
tasks, and no blocked reason, verification escalation, or
`needs-human-decision` disposition. Repository, PR, HEAD, task, request, review
history, outcome, and thread identities must match the backup projection. The
backup authorizes a fresh explicit plan only: run all selected checks again and
record new exact-head validation; never reuse the legacy pass or repeat the
preserved review. Native schema-v3 states and missing, mismatched, tampered, or
multi-transition provenance are rejected.

Done is stricter. A clean Codex review, full green CI, full E2E, the current PR
head, the no-open-thread check, and passed exact-current-HEAD coverage for every
completed local task must all refer to the same Review commit. Review requests
use that same local-proof gate.

## Diagnostic status and operational monitoring

Run:

```bash
npm run review:status
npm run review:github -- advance --pr 123
```

`review:status` is read-only diagnostic output. Use `advance` as the operational
poller. The human diagnostic output translates machine state into plain English:

```text
PR: #24
PR readiness: OPEN
Live review observation: Waiting
Current commit: abc1234 (matches PR head)
Phase: Fixing
Codex review: Findings need resolution
Tasks: 0 Resolved, 2 pending
  - billing-settlement: Integrated — Reject a changed tab
  - stale-session: worker running — Refresh an expired session
Targeted local tests: Passed (npm run check:api)
Specialist reviews: Clean (security_reviewer)
Full CI: Not Run
Open Codex threads: 2
Next action: Integrate the remaining result and run the selected tests.
```

## Setup

1. Enable Codex cloud and Code review for the GitHub repository.
2. Authenticate the GitHub connector or `gh`.
3. Open `/hooks` and trust the repository hooks; changed hooks require review
   again.
4. Protect `vMAJOR.MINOR.PATCH` tags from updates and deletion, and keep full
   history and tags available locally.

## Troubleshooting pointers

- **Status cannot be restored:** run
  `npm run review:state -- recover`. Use the saved backup, Git,
  structured GitHub data, and CI artifacts—not transcripts. Old state requires
  an explicit migration.
- **Review is stale:** compare the review commit, recorded Review commit, and
  current PR head. Request a new review only after the current commit is
  review-ready.
- **A thread still appears open:** query GitHub again after the close operation.
  A successful mutation response is not confirmation.
- **Related tests are unknown:** return to task planning and record exact
  commands, selectors, projects, and reasons. Do not run full local E2E as a
  fallback.
- **Specialist evidence is missing or stale:** verify every packet sidecar,
  its binding provenance and historical pre-bind receipt, rebuild the
  exact-current-HEAD plan, and rerun only its required `riskReviewers`.
  Do not infer legacy planning signals, rerun a reviewed-HEAD behavior mapper at
  integration HEAD, or treat an earlier risk-review clean result as current.
- **CI failed:** inspect the exact-commit workflow and its artifacts. Run full
  E2E locally only when explicitly requested or when diagnosing that failure.
- **Release state is inconsistent:** run `npm run release:state`,
  `npm run check:release-state`, and `npm run check:released-migrations`. Fetch
  missing refs or tags; do not assume the project is pre-release.
- **Review rounds repeat:** investigate a stable finding that returns twice.
  Otherwise keep requesting exact-commit reviews until Codex is clean. There is
  no configured request-count cap by default; an explicit durable limit pauses
  only the next request when exhausted. Exact-anchor HEAD drift is recoverable,
  while missing, altered, duplicated, foreign, unsupported, multiple,
  conflicting, or otherwise ambiguous evidence still needs a human decision.

Machine contracts and command details live in the
[PR review state schema](./schemas/pr-review-state.schema.json),
[task schema](./schemas/review-fix-task.schema.json), and
[worker result schema](./schemas/review-fix-result.schema.json). The skill's phase
references cover [durable state](./references/state-and-contracts.md),
[integration and validation](./references/orchestration.md),
and [GitHub review and CI](./references/github-review.md).
