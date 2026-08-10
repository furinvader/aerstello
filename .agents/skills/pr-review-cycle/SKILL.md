---
name: pr-review-cycle
description: Orchestrate and resume Aerstello pull-request review remediation with official GitHub `@codex review`, exact-commit matching, isolated fix workers, central integration, targeted local validation, full CI evidence, and durable recovery state. Use when asked to resolve or continue the current PR review cycle, request Codex review and address its findings, recover a long-running PR remediation session, or delegate independent review fixes. Do not use for ordinary one-file edits or reviews unrelated to an active pull request cycle.
---

# Resolve a PR review cycle

The main agent is the sole orchestrator. It owns durable state, central
integration, GitHub writes, and review requests. Fix workers use isolated
worktrees and fixed, path-limited instructions. Workers and the read-only
verifier never write to GitHub.

Use four human terms throughout the cycle:

- **Review commit:** the exact pushed commit sent to Codex.
- **Integrated:** a worker commit is on the central PR branch.
- **Resolved:** the fix was verified, evidence was posted, and its Codex thread
  is closed.
- **Done:** Codex is clean and full CI, including full E2E, is green for the
  same Review commit, with no open Codex threads.

Internal state still uses `completed` for Resolved and `complete` for Done.

Read the phase reference before acting in that phase:

- [State and contracts](references/state-and-contracts.md): restore, migrate,
  checkpoint, archive, task instructions, and worker results.
- [Orchestration](references/orchestration.md): plan tasks, create worktrees,
  integrate, verify, and select targeted local checks.
- [GitHub review](references/github-review.md): request or collect a review,
  resolve threads, record CI, apply loop breakers, and finish.

## Phase 1: Restore and confirm

Read root `AGENTS.md` and run `node scripts/pr-review-state.mjs show`. Confirm
the repository, explicit PR, base, local head, GitHub head, saved state, and
`npm run release:state -- --json`. Never guess missing identity or treat
inconsistent release metadata as pre-release. Explicitly migrate old state and
preserve its backup.

## Phase 2: Plan fixes for the Review commit

Triage applicable Codex findings by root cause. Give each worker fixed
instructions with exact owned paths, acceptance criteria, related commands, E2E
selectors, browser projects, and reasons. Missing related-test selection is a
planning error, never permission to run a full local suite.

Use at most four independent implementation workers. Parallel writers require
separate worktrees from the reviewed commit and non-overlapping ownership.
Workers must not broaden scope, update central state, integrate, push, delegate,
or write to GitHub.

## Phase 3: Integrate and verify

Validate each structured worker result before cherry-picking it centrally in
dependency order. Integrated means only that the code has landed; the finding
is not yet Resolved. Run the union of related checks after each batch, then use
the read-only integration verifier. Turn valid verifier findings into normal
planned tasks.

For browser changes, run selected scenarios with `tablet-chromium` by default.
Add projects only for responsive, touch, installation, or browser-specific
behavior. CI, not the normal local cycle, owns `check:full` and full E2E.

## Phase 4: Resolve findings

Push the stable commit and confirm that local HEAD equals the GitHub PR head.
Post concise fix and validation evidence to each Codex thread, close it, then
query GitHub again. Mark the finding Resolved only after GitHub confirms the
thread is closed, or after successful verification for a threadless finding.

## Phase 5: Request review and CI

The commit is review-ready when no worker remains active, accepted fixes are
Integrated, targeted local checks passed, relevant release checks passed, the
checkout is clean and pushed, local HEAD equals the PR head, and GitHub confirms
there are no open Codex threads.

Only the orchestrator posts exactly `@codex review`. Record the Review commit
and request evidence. After targeted validation and push, Codex review and full
CI may run concurrently. Accept ordinary review evidence only when the review
commit, recorded request commit, and current PR head all match. Clean evidence
may also be the canonical Bot's official top-level no-major-issues comment when
its structured `Reviewed commit` anchor resolves uniquely through complete
local Git history to every current head, or a thumbs-up on the recorded request.
Either form must follow the request; multiple canonical evidence items are
ambiguous.

## Phase 6: Finish or recover

Done requires a clean applicable Codex result, green full CI and full E2E for
the same Review commit, every finding with an outcome, and a fresh GitHub query
showing no open Codex threads. Archive only then, unless the operator explicitly
abandons the cycle with a durable reason.

If work stops earlier, checkpoint the exact next action. Recover from saved
state, Git, structured GitHub data, and CI artifacts—never from a transcript.
If the same finding returns twice, investigate its root cause. Stop automatic
review requests at the round limits in the GitHub reference.

One human-only exception exists after exact verification findings: a durable
operator decision may authorize one `human-final` review with an RFC 3339
`notBefore` bound. Use the guarded state command, keep the 3+1 counters and
first four ledger entries unchanged, and let the GitHub helper enforce trusted
time plus every ordinary review-ready gate. Clean may proceed to Done gates;
findings, staleness, unsupported, or ambiguous evidence stop terminally for a
human and never create another automatic round.
