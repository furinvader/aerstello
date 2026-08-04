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

The orchestrator alone posts the top-level PR comment:

```text
@codex review
```

First prove: no active worker; all accepted commits integrated; clean checkout;
validation passed for current SHA; branch pushed; local HEAD equals GitHub PR
head; state checkpoint records that SHA. Record comment ID/URL, request time,
and requested SHA immediately. Never use `@codex address that feedback`.

## Review acceptance

Read structured review and PR data whenever GitHub exposes it. Record review
submission ID and commit ID. Accept findings only when:

```text
review commit == requested head == current PR head
```

Any mismatch makes the review stale. Do not recover commit identity from prose
or infer that an earlier review applies to a later commit.

## Loop termination

Finish only on a clean applicable review with every finding disposed, no queued,
running, or blocked task, and required validation passing. Escalate a semantic
finding repeated in two consecutive rounds. Stop for a human decision after
three automatic review rounds.

## Recovery

Run `node scripts/pr-review-state.mjs recover`, then re-read live Git and GitHub
state. If state is invalid, use `state.backup.json`, Git history, structured
GitHub metadata, and CI artifacts; never reconstruct decisions from Codex
transcripts. Archive stale cycles with the state CLI after confirming the PR.
