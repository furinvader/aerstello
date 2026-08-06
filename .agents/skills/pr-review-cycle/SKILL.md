---
name: pr-review-cycle
description: Orchestrate and resume Sky Bar pull-request review remediation with canonical GitHub `@codex review`, exact-SHA triage, isolated fix workers, central integration, and durable recovery state. Use when asked to resolve or continue the current PR review cycle, request Codex review and address its findings, recover a long-running PR remediation session, or delegate independent review fixes. Do not use for ordinary one-file edits or reviews unrelated to an active pull request cycle.
---

# Resolve a PR review cycle

Keep the primary Codex agent as the sole orchestrator, logical state writer,
central integrator, GitHub review requester, evidence replier, and review-thread
resolver. Workers and the verifier never write to GitHub. Use GitHub
`@codex review` as the canonical independent reviewer, bounded workers for
accepted fixes, and the local verifier only after integration.

Read these repository contracts when their phase becomes relevant:

- Read [references/state-and-contracts.md](references/state-and-contracts.md)
  before initializing, recovering, checkpointing, or delegating tasks.
- Read [references/orchestration.md](references/orchestration.md) before building
  task batches, creating worktrees, integrating commits, or verifying fixes.
- Read [references/github-review.md](references/github-review.md) before reading
  GitHub review data, posting `@codex review`, or closing a cycle.

## 1. Recover exact context

- Read root `AGENTS.md`, this skill, and active state from
  `node scripts/pr-review-state.mjs show`.
- Explicitly migrate schema-v1 state before continuing; migration must create a
  backup and preserve dispositions and stable identities. Never migrate state
  silently during an unrelated command.
- Resolve the repository, explicit PR number, base SHA, local HEAD, pushed PR
  head, and `npm run release:state -- --json`. Reconcile them with recorded
  state. Never guess a PR, SHA, release, or review result.
- Stop release-sensitive work when release metadata is inconsistent. Record a
  concise blocker and exact next action.
- Treat state under the Git common directory as active memory. Never parse a
  Codex transcript to reconstruct decisions.

## 2. Request the canonical review

Only the orchestrator may request review. Before posting, require every
condition below:

- No implementation worker is active.
- Every accepted worker commit is integrated.
- Every prior task is completed; none is queued, running, or blocked.
- The integration checkout is clean.
- Required validation passed for the current SHA, including release policy.
- The branch is pushed, local HEAD equals the GitHub PR head, and the state
  checkpoint records that exact SHA.
- A live thread query proves there are zero unresolved canonical review threads.

Post exactly `@codex review` through the authenticated GitHub connector or
`gh`. Record the request kind, comment ID/URL, requested SHA, and timestamp.
Never use `@codex address that feedback` or ask workers to post GitHub comments.

## 3. Collect and triage the review

- Read structured GitHub review data. A standard review is applicable only when
  `review commit == requested head == current PR head`. A clean result may also
  be the canonical Codex thumbs-up on the recorded request comment, but only
  while `request head == current PR head`. Otherwise record it as stale.
- Record a clean applicable review as a completed round with no findings.
- Classify every finding as `actionable`, `duplicate`, `already-fixed`, `stale`,
  `invalid`, `policy-conflict`, `out-of-scope`, or `needs-human-decision`.
- Combine comments with one root cause. Generate stable semantic fingerprints
  from normalized behavior, affected contract, and evidence; do not create one
  worker per comment.
- Persist every disposition and the structured GitHub source identifiers.

## 4. Build safe task batches

- Build a dependency and write-conflict graph. Put tasks in the same batch only
  when they have no dependency, contract coupling, fixture coupling, generated
  output overlap, schema interaction, or anticipated path overlap.
- Serialize root package/lock files, `.codex/**`, `.agents/**`, `.github/**`,
  shared contracts, API schema/migrations, and shared Playwright fixtures or
  global steps unless an explicit ownership decision proves isolation.
- Cap implementation workers at four. Parallel writers require separate
  worktrees from the exact reviewed head and non-overlapping ownership.
- If the active Codex surface cannot reliably constrain a worker to its assigned
  worktree, serialize writers. Read-only exploration may still run in parallel.

## 5. Delegate immutable packets

- Create worktrees with `scripts/pr-review-worktree.mjs` and record their path,
  branch/detached state, and exact base SHA.
- Validate every task packet against
  `docs/agents/review-fix-task.schema.json`. Include allowed and forbidden paths,
  dependencies, acceptance criteria, and narrow validation.
- Spawn only `review_fix_worker` for implementation. Give it the immutable
  packet and assigned worktree. Workers must not broaden scope, write central
  state, integrate, push, comment, request review, or delegate.
- Wait for every worker in the batch before integration.

## 6. Validate and integrate results

- Validate the final raw JSON against
  `docs/agents/review-fix-result.schema.json`. Reject or rerun a result when its
  task ID, commit SHA, ownership, required validation, or scope is wrong.
- Require workers to report unexpected dependencies instead of absorbing them.
- Inspect accepted commits and cherry-pick them centrally in dependency order.
  Resolve conflicts only in the integration checkout. Marking a task
  `integrated` means only that its code landed; its finding remains open. Run
  narrow checks after each dependency cluster and checkpoint state after every
  successful integration.
- Remove generated worktrees only after their commits are integrated or
  intentionally discarded. Never force-remove a dirty or unknown path.

## 7. Verify the combined result

- Spawn `integration_verifier` read-only after integration and before another
  GitHub review. Give it the tasks, decisions, reviewed SHA, and integrated SHA.
- Require it to check finding resolution, ownership, unrelated behavior,
  inconsistent assumptions, tests, and released-migration policy.
- Convert valid verifier findings into ordinary tasks. The verifier never edits
  or requests GitHub review.

## 8. Validate, resolve, and loop safely

- Workers run narrow tests only. The orchestrator runs the integrated gate once
  per batch: `npm run check`, release-state and migration checks, and database/
  E2E validation when the changed area requires it.
- After verifier approval, validate and push the stable integration head, prove
  local HEAD equals PR head, and checkpoint that SHA. Then reply to every source
  thread with concise fix and validation evidence, resolve it, and re-query live
  threads until zero unresolved canonical threads are proven. Only then request
  the next canonical review.
- A task becomes `completed` only after its source thread is resolved with that
  evidence, or after successful threadless verification. The cycle becomes
  `complete` only after a clean exact-head outcome and every completion gate.
- If one semantic finding recurs in two consecutive rounds, perform focused
  root-cause escalation instead of repeating the patch. Allow at most three
  discovery reviews. If fixes follow the third, one additional exact-head
  verification review is authorized. A stale verification outcome or any new
  verification finding moves the cycle to `awaiting-human-decision`; do not
  request another review automatically.

## 9. Finish or pause truthfully

- Finish only when the clean outcome applies to the integration head, every
  finding has a disposition, every task is completed, validation and exact-head
  thread proof pass, and no actionable or human-decision finding remains.
- Archive complete state normally. Archive any other phase only with an explicit
  abandonment reason that is recorded durably.
- If the run must end earlier, atomically checkpoint concise state and report
  the exact next action. Never imply that work will continue asynchronously.
