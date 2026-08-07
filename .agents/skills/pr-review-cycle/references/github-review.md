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
node scripts/pr-review-github.mjs request --pr 123 --kind discovery
node scripts/pr-review-github.mjs collect --pr 123
node scripts/pr-review-github.mjs collect-ci --pr 123
node scripts/pr-review-github.mjs complete --pr 123
```

Read structured GitHub data. An ordinary review applies only when:

```text
review commit == recorded Review commit == current PR head
```

Any mismatch is stale. Do not infer commit identity from ordinary review prose.
Codex's official top-level
`Codex Review: Didn't find any major issues. Nice work!` comment may prove clean
only when it follows the recorded request, has the exact structured
`**Reviewed commit:** \`<abbreviated-sha>\`` anchor, and that prefix resolves
uniquely through complete local Git history to the recorded request,
integration, pushed, and live PR commit. Record its immutable comment identity
as `issue-comment` evidence. A clean thumbs-up on the recorded request may also
be accepted while its commit remains current. Multiple canonical reviews,
clean comments, or reactions are ambiguous; foreign, pre-request, malformed,
unresolvable, or stale evidence fails closed.

## Resolve findings

After central integration, verification, targeted validation, and push, the
orchestrator replies to each source thread with concise commit and test evidence
and closes it. Then query GitHub again. Mark a finding Resolved only when GitHub
confirms its Codex thread is closed. A threadless finding becomes Resolved after
successful verification.

A successful close mutation alone is not confirmation. Integrated is not
Resolved, and neither means Done.

For an actionable `local` or `github-threadless` task, run `verify-resolve`
only after the read-only integration verifier has approved that selected task
at the exact current HEAD. The command is the orchestrator's guarded assertion
of that verifier result: it repeats clean-checkout, equal local/pushed/live
HEAD, ancestry, state-revision, and fully paginated canonical-root checks before
writing task state. It never mutates GitHub or creates a mutation journal. A
local assertion completes only the selected task. A threadless assertion adds
only the selected task ID to exact-HEAD threadless proof while preserving prior
IDs. This assertion is transition input, not a persisted verifier-artifact
schema. GitHub-thread tasks continue to use `reply-resolve`.

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

## Done gate

The cycle is Done only when all of these facts apply to one Review commit:

1. The commit remains review-ready and is the current PR head.
2. Codex returned a clean applicable review, clean issue comment, or eligible clean thumbs-up.
3. Full GitHub Actions checks passed.
4. The full E2E suite and complete browser/device matrix passed in CI.
5. Every finding has a recorded outcome and every actionable task is Resolved.
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

If the same stable finding returns in two consecutive rounds, pause repeated
patching and investigate the root cause.

## Recovery

Run `node scripts/pr-review-state.mjs recover`, then re-read Git, GitHub, and CI.
If state is invalid, use `state.backup.json`, Git history, structured GitHub
metadata, and CI artifacts. Never reconstruct decisions from Codex transcripts.
Explicitly migrate old state. To abandon a non-Done cycle, record the PR number
and reason durably before archival.
