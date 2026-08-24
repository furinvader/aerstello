# PR review-cycle operator guide

Aerstello keeps pull-request review state in the repository's Git common
directory so the cycle can be resumed from any linked worktree. One main agent
orchestrates the cycle. Start or resume it with:

```text
Use $pr-review-cycle to continue the current PR remediation session.
```

This guide is the command and recovery entrypoint for operators. Maintainers
changing the implementation should first read the
[internal architecture map](references/internal-architecture.md). Normative
rules remain in the phase references:

- [State and contracts](references/state-and-contracts.md) covers durable
  state, migrations, task packets, worker results, checkpoints, and archives.
- [Orchestration](references/orchestration.md) covers task planning, isolated
  workers, integration, targeted validation, specialist review, and the final
  verifier.
- [GitHub review](references/github-review.md) covers review requests, evidence
  collection, thread resolution, CI, completion, and loop breakers.

## Lifecycle

1. Restore durable state and confirm the repository, PR, release state, local
   commit, pushed commit, and live PR head.
2. Run the selected targeted validation for the exact current commit.
3. Ask Codex to review that exact pushed commit. Only the main orchestrator
   posts `@codex review`.
4. Convert findings into fixed, path-limited task packets and run workers in
   isolated worktrees.
5. Accept and integrate worker commits, rerun the combined targeted checks,
   and run the routed exact-HEAD specialist reviews and read-only verifier.
6. Push, post concise fix evidence, resolve applicable Codex threads, and
   confirm with a fresh GitHub query that no thread remains open.
7. Request another exact-commit review when findings changed the head. Codex
   review and full GitHub Actions may run concurrently after targeted checks.
8. Finish only when the clean review, green full CI including full E2E, current
   PR head, and no-open-thread proof all name the same Review commit.

## Terms and status

| Term | Meaning |
| --- | --- |
| **Review commit** | The exact pushed commit sent to Codex. |
| **Integrated** | An accepted worker commit is on the central PR branch. |
| **Resolved** | The fix was verified, evidence was posted, and its Codex thread is closed. |
| **Done** | Codex is clean and full CI, including full E2E, is green for the Review commit, with no open Codex threads. |

Machine state uses task status `completed` for Resolved and cycle phase
`complete` for Done. These are storage names, not extra lifecycle stages.

Use the human status view for a compact operational summary:

```bash
npm run review:status
npm run review:github -- status --human
```

`status` is read-only. It reports the volatile PR readiness, exact commit
relationship, current phase, Codex result, tasks, targeted validation,
specialist evidence, CI, open threads, and next action. Monitor a pending cycle
with the poll-safe operational command:

```bash
npm run review:github -- advance --pr 123
```

`advance` records only stable review, CI, and completion progress. It never
requests review, resolves a finding, or archives state.

## Common commands

Inspect or restore state:

```bash
npm run review:state -- show
npm run review:state -- validate
npm run review:state -- recover
npm run review:state -- path
```

Operate the GitHub portion of the cycle:

```bash
npm run review:github -- status --pr 123
npm run review:github -- request --pr 123
npm run review:github -- advance --pr 123
npm run review:github -- reply-resolve --pr 123 --task finding-a
npm run review:github -- verify-resolve --pr 123 --task local-finding
npm run review:github -- collect --pr 123
npm run review:github -- collect-ci --pr 123
npm run review:github -- complete --pr 123
```

Inspect an isolated task worktree:

```bash
npm run review:worktree -- inspect --pr 123 --task finding-a
```

From a nested workspace, point npm at the checkout root:

```bash
npm --prefix "$(git rev-parse --show-toplevel)" run review:state -- show
npm --prefix "$(git rev-parse --show-toplevel)" run review:github -- status --human
```

Command help is authoritative for command-specific options:

```bash
npm run review:state -- --help
npm run review:github -- --help
npm run review:worktree -- --help
```

## Review-ready and Done

A commit is review-ready when all accepted fixes are Integrated, no worker is
active or blocked, the checkout is clean, targeted checks passed, applicable
release checks passed, the branch is pushed, local HEAD equals the live PR
head, and a fresh query shows no open thread from an earlier round.

GitHub Actions owns `npm run check:full` and `npm run test:e2e:full`; they are
not normal local review-ready checks. Related browser validation uses explicit
selectors and projects, normally `tablet-chromium`. Unknown test selection is a
planning error, not permission to run the full suite locally.

Done is stricter than review-ready. The current PR head must have one applicable
clean Codex result, authoritative green full CI including the full E2E matrix,
outcomes for every finding, exact-current-HEAD verification for completed local
tasks, and a fresh no-open-thread result.

New pull-request preparation remains owned by issue #25. It must produce a
ready, non-draft PR. The review request command can defensively recover a draft
promotion, but `advance` never changes PR readiness.

## Request limits and exact-commit recovery

New cycles are unlimited by default. A finite review-request limit is optional,
counts every durable request, and blocks only the next request when exhausted.
Set or remove it with an exact revision guard:

```bash
npm run review:state -- set-review-limit --pr 123 --expected-revision 8 --limit 10
npm run review:state -- set-review-limit --pr 123 --expected-revision 9 --unlimited
```

When a request becomes stale only because HEAD advanced, follow the reported
recovery action. Missing, edited, duplicated, foreign, unsupported, or
conflicting review evidence remains a human decision. Do not synthesize an
outcome or post another review request manually.

## Archive and recovery

Archive a Done cycle with:

```bash
npm run review:state -- archive
```

An unfinished cycle may be archived only when the operator explicitly abandons
it with a durable reason:

```bash
npm run review:state -- archive --abandon-reason "superseded PR"
```

Recovery starts with `npm run review:state -- recover`, followed by fresh Git,
GitHub, CI, and release checks. Use state, its preserved backups and event log,
Git history, structured GitHub data, and CI artifacts. Never reconstruct
decisions from a chat transcript, rewrite an archive, delete manifests as
cleanup, or silently migrate older state.

## Setup

1. Enable Codex cloud and Code review for the GitHub repository.
2. Authenticate the GitHub connector or `gh`.
3. Open `/hooks` and trust the repository hooks; changed hooks require review
   again.
4. Keep complete Git history and tags available and protect production release
   tags from updates and deletion.

## Troubleshooting

- **Status cannot be restored:** run `npm run review:state -- recover`; validate
  and explicitly migrate old state before continuing.
- **Local and live commits differ:** stop and identify the intended Review
  commit. Review evidence for another commit is stale.
- **A thread still appears open:** query GitHub again after the close operation;
  a successful mutation response is not confirmation.
- **Related tests are unknown:** return to task planning and record exact
  commands, selectors, projects, and reasons.
- **Specialist evidence is missing or stale:** rebuild the exact-current-HEAD
  plan from immutable packet provenance and rerun only its routed reviewers.
- **CI failed:** inspect the exact-commit workflow and artifacts. Run full E2E
  locally only when explicitly requested or while diagnosing that failure.
- **Release state is inconsistent:** run `npm run release:state`,
  `npm run check:release-state`, and `npm run check:released-migrations`; fetch
  missing refs or tags instead of assuming pre-release state.
- **A stable finding repeats:** investigate its root cause before applying
  another patch.

For exact recovery predicates and exceptional transition sequences, use the
[state](references/state-and-contracts.md),
[orchestration](references/orchestration.md), and
[GitHub](references/github-review.md) phase references rather than copying
their rules into an operator runbook.
