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
node scripts/pr-review-github.mjs status --pr 123
node scripts/pr-review-github.mjs status --human
node scripts/pr-review-github.mjs reply-resolve --pr 123 --task finding-a
node scripts/pr-review-github.mjs verify-resolve --pr 123 --task local-finding
node scripts/pr-review-github.mjs verify-resolve --pr 123 --task-set-json '["threadless-a","threadless-b"]'
node scripts/pr-review-github.mjs request --pr 123 --kind discovery
node scripts/pr-review-github.mjs request --pr 123 --kind human-final
node scripts/pr-review-github.mjs collect --pr 123
node scripts/pr-review-github.mjs collect-ci --pr 123
node scripts/pr-review-github.mjs complete --pr 123
```

Read structured GitHub data. An ordinary review applies only when:

```text
review commit == recorded Review commit == current PR head
```

Any mismatch is stale. Do not infer commit identity from ordinary review prose.
A `human-final` request is supported only after the guarded durable operator
authorization. Before any journal intent or GitHub mutation, and again after
fresh state/GitHub reads, trusted time must be at or after its `notBefore`.
Recovered or newly created request evidence must also have a GitHub timestamp
at or after that bound. The helper preserves the first four 3+1 ledger entries,
appends exactly one fifth entry, and recovery may never post it twice.

A canonical exact-head `COMMENTED` review submission is clean only when its
body is a string with empty trimmed content and it has no attached canonical
root. Any nonempty trimmed body is findings even without an inline root, and
any attached canonical root is findings even when the body is empty. A missing
or non-string body is unsupported evidence and fails closed; never parse prose,
badge text, or severity wording to weaken that classification. Completion
rechecks the recorded clean review against these same live body and root rules.
Codex's official top-level comment may prove clean only when its first line is
exactly `Codex Review: Didn't find any major issues. Nice work!` or
`Codex Review: Didn't find any major issues. :tada:`, it follows the recorded
request, its body has never been edited, and it has exactly one structured
`**Reviewed commit:** \`<abbreviated-sha>\`` anchor line, whose prefix resolves
uniquely through complete local Git history to the recorded request,
integration, pushed, and live PR commit. Record its immutable comment identity
as `issue-comment` evidence. A clean thumbs-up on the recorded request may also
be accepted while its commit remains current. Multiple canonical reviews,
clean comments, or reactions are ambiguous; foreign, pre-request, malformed,
unresolvable, or stale evidence fails closed. Any other canonical post-request
comment beginning with the shared no-major-issues prefix is unsupported clean
evidence and fails closed rather than being treated as absent.

## Resolve findings

After central integration, verification, targeted validation, and push, the
orchestrator replies to each source thread with concise commit and test evidence
and closes it. Then query GitHub again. Mark a finding Resolved only when GitHub
confirms its Codex thread is closed. A threadless finding becomes Resolved after
successful verification.

A successful close mutation alone is not confirmation. Integrated is not
Resolved, and neither means Done.

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

The same read-only empty-root refresh is narrowly available after native-v4
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

## Done gate

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

Run at most three discovery reviews. If the third needs fixes, Integrate and
Resolve them, confirm review-ready state, then allow one verification review for
that exact commit. A stale verification result or any new verification finding
moves the cycle to `awaiting-human-decision`. Report the evidence and required
decision; do not request another review automatically.

Only an explicit durable operator decision may make one exception: bind it to
the exact verification-findings outcome with `authorize-final-review`, record a
trusted RFC 3339 `notBefore`, and request `--kind human-final` no earlier than
that time. This is not a fourth discovery round: reviewRound remains 3,
verification use remains sticky, and the fifth immutable ledger entry consumes
the exception. Clean evidence enters ordinary validation and Done gates.
Findings, stale head or request proof, unsupported evidence, and ambiguity are
terminal `awaiting-human-decision` outcomes; no second final request is allowed.

If the same stable finding returns in two consecutive rounds, pause repeated
patching and investigate the root cause.

## Recovery

Run `node scripts/pr-review-state.mjs recover`, then re-read Git, GitHub, and CI.
If state is invalid, use `state.backup.json`, Git history, structured GitHub
metadata, and CI artifacts. Never reconstruct decisions from Codex transcripts.
Explicitly migrate old state. To abandon a non-Done cycle, record the PR number
and reason durably before archival.
