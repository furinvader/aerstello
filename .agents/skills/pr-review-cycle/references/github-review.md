# GitHub review reference

## Contents

- [Prerequisites](#prerequisites)
- [Request gate](#request-gate)
- [Review acceptance](#review-acceptance)
- [Loop termination](#loop-termination)
- [Recovery](#recovery)

## Prerequisites

- Enable Codex cloud and code review for the repository.
- Authenticate the GitHub connector or verify `gh auth status`.
- Read root `AGENTS.md` review rules.
- Trust project hooks through `/hooks` before relying on lifecycle recovery.

## Request gate

The orchestrator alone requests reviews, replies with evidence, invokes
`resolveReviewThread`, and verifies live thread state. Workers and the verifier
never write to GitHub. The top-level request comment is exactly:

```text
@codex review
```

First prove: no active worker; all accepted commits integrated; every prior task
completed; no queued, running, or blocked task; clean checkout; validation
passed for current SHA; branch pushed; local HEAD equals GitHub PR head; state
checkpoint records that SHA; and a live re-query reports zero unresolved
canonical threads. Record request kind, comment ID/URL, request time, and
requested SHA immediately. Never use `@codex address that feedback`.

The approved helper command surface keeps these mutations orchestrator-only:

```bash
node scripts/pr-review-github.mjs status --pr 123
node scripts/pr-review-github.mjs reply-resolve --pr 123 --task finding-a
node scripts/pr-review-github.mjs request --pr 123 --kind discovery
node scripts/pr-review-github.mjs collect --pr 123
node scripts/pr-review-github.mjs complete --pr 123
```

Use request kind `verification` only for the one authorized exact-head
verification review after the third discovery review.

## Review acceptance

Read structured review, request-comment, reaction, and PR data. Record outcome
source IDs and timestamps. An ordinary review is applicable only when:

```text
review commit == requested head == current PR head
```

Any mismatch makes the review stale. Do not recover commit identity from prose
or infer that an earlier review applies to a later commit.

A clean outcome may instead be a canonical Codex thumbs-up reaction on the
recorded request comment. Accept that reaction only when the comment is the
current recorded request and `request head == current PR head`; the request is
the reaction's exact-SHA anchor. A reaction on another comment or after head
drift is stale.

For every fixed finding, first integrate centrally, run the verifier, validate
and push the current head, and prove it is the PR head. The orchestrator then
posts concise commit and validation evidence to the source thread and resolves
it. Re-query live threads after every resolution batch; a successful mutation
response alone is not proof that zero unresolved threads remain.

## Loop termination

Run no more than three discovery reviews. When the third discovery review needs
fixes, complete the integration, evidence replies, resolutions, and zero-thread
proof, then allow one exact-head verification review. A stale verification or
new verification findings moves state to `awaiting-human-decision`; report the
evidence and required decision instead of requesting another review.

Finish only on a clean applicable exact-head outcome with every finding
disposed, every task completed, zero unresolved canonical threads, clean Git,
and current validation. `integrated` is not `completed`, and neither by itself
makes the cycle `complete`.

## Recovery

Run `node scripts/pr-review-state.mjs recover`, then re-read live Git and GitHub
state. If state is invalid, use `state.backup.json`, Git history, structured
GitHub metadata, and CI artifacts; never reconstruct decisions from Codex
transcripts. Run the explicit state migration when recovery finds schema version
1. Archive a complete cycle normally; abandoning any other phase requires a
durably recorded reason.
