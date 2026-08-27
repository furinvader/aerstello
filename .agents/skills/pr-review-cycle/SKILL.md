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

Read root `AGENTS.md` and the [operator guide](README.md), then run
`npm run review:state -- show`. Confirm
the repository, explicit PR, base, local head, GitHub head, saved state, and
`npm run release:state -- --json`. Never guess missing identity or treat
inconsistent release metadata as pre-release. Explicitly migrate old state and
preserve its backup.

Load receipt-valid scope authority and its exact-head evidence before expanded
execution. New state uses `init --scope-authority`; the only later scope
commands are `scope-authority --input`, `scope-classify --input`,
`scope-decision --input`, `scope-return`, and `scope-resume --input`. Missing,
partial, stale, or mismatched standalone, imported, or legacy-adoption
authority fails closed. Legacy adoption preserves review history and is
unavailable while a worker is active.

## Phase 2: Plan fixes for the Review commit

Triage applicable Codex findings by root cause. Give each worker fixed
instructions with exact owned paths, acceptance criteria, related commands, E2E
selectors, browser projects, and reasons. Missing related-test selection is a
planning error, never permission to run a full local suite.

Bind each root to one of the five canonical classifications documented in the
[state reference](references/state-and-contracts.md). A minor-amendment verdict
still requires a decision and authority amendment. Remove or simplify an
unnecessary mechanism first; judge correctness against the accepted scope and
the current PR, not an obsolete intermediate implementation. Task binding and
worker progress require a receipt-valid exact-HEAD classification for the exact
remediation shape.

Use the [Aerstello specialist registry](../aerstello-specialists/SKILL.md) to
select one primary profile and compatible risk tags for each task. Record the
explicit pre-bind `browserVisible` and `testSelectionUncertain` signals and run
`behavior_mapper` before binding whenever it appears in `planningHelpers`.
Profiles guide the work; they never grant paths, commands, selectors, projects,
or criteria.

Use at most four independent implementation workers. Parallel writers require
separate worktrees from the reviewed commit and non-overlapping ownership.
Workers must not broaden scope, update central state, integrate, push, delegate,
or write to GitHub. Finish planning helpers before writers and reserve the
four-thread session capacity for required post-integration reviewers.

## Phase 3: Integrate and verify

Validate each structured worker result before cherry-picking it centrally in
dependency order. Integrated means only that the code has landed; the finding
is not yet Resolved. Run the union of related checks after each batch, then run
only the reusable `riskReviewers` selected for the exact integrated HEAD. Turn
their valid findings into ordinary fixed tasks. After all required evidence is
current and clean, this PR workflow independently selects and runs
`integration_verifier` alone with generated specialist context and the routed
final-verification priority. A clean specialist result cannot resolve a task or
satisfy Done.

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
may also be the canonical Bot's immutable post-request top-level comment when
it contains exactly one full structured `Reviewed commit` anchor whose
lowercase Git prefix resolves uniquely through complete local history to every
current head. Surrounding prose is not classified. This structural marker is
clean only when no canonical review root was created at or after the request,
including a root that was later resolved; unresolved threads remain separate
review-ready and Done gates. A thumbs-up on the recorded request is also
eligible. Multiple canonical evidence items are ambiguous.

## Phase 6: Finish or recover

Done requires a clean applicable Codex result, green full CI and full E2E for
the same Review commit, every finding with an outcome, and a fresh GitHub query
showing no open Codex threads. Archive only then, unless the operator explicitly
abandons the cycle with a durable reason.

Monitor a pending cycle with `npm run review:github -- advance --pr <number>`.
It is poll-safe and never requests a review, resolves findings, or archives.
Use `status` only for read-only inspection. PR creation remains outside this
cycle: issue 25 preparation must create ready PRs. Only `request` may
defensively promote a draft after journaling `ready:<pr>:<pr-node>:<head>`;
`advance` rejects drafts and never performs a readiness mutation. It repeatedly
proves OPEN/non-draft, request-anchor, root, CI, and revision gates. It waits
for no response or pending CI, triages findings, escalates only verification
ambiguity, fails discovery ambiguity, records failed CI, and reaches idempotent
Done without archive or any new review request.

Phase 5 requires fresh OPEN/non-draft PR evidence. Before `@codex review`,
only `request` may journal the ready intent and promote an otherwise ready
draft; `advance` is never a readiness-mutation path.

The request result is `already-ready`, `marked-ready`, or `recovered-ready`.
Diagnostic status reports `not-applicable`, `waiting`, `collectable`,
`ambiguous`, or `stale` canonical observations without writes.

If work stops earlier, checkpoint the exact next action. Recover from saved
state, Git, structured GitHub data, and CI artifacts—never from a transcript.
For material expansion, record the decision and use the guarded return/resume
boundary; neither side mutates the other workflow's state. A second material
expansion beyond the last approved boundary for the same root stops as churn.
If the same finding returns twice, investigate its root cause. Continue the
exact-commit review cycle until clean by default; stop requesting only when an
explicit durable operator limit is exhausted or evidence requires human review.
