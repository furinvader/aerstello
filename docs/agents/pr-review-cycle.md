# Pull-request review and remediation cycle

## Architecture and roles

Sky Bar keeps PR remediation repository-local. It does not run a daemon or
hosted implementation service.

- The **main Codex agent** is the sole orchestrator, logical active-state writer,
  GitHub review requester, and commit integrator.
- GitHub **`@codex review`** is the canonical independent reviewer. It produces a
  standard GitHub review against a recorded commit.
- **`review_fix_worker`** agents implement one immutable, path-bounded task in a
  dedicated worktree and return structured JSON.
- The read-only **`integration_verifier`** checks the combined result after
  integration and before the next GitHub review.

Use the repository skill with prompts such as:

```text
Use $pr-review-cycle to continue the current PR remediation session.
```

The skill should not be used for unrelated one-file edits.

## Required setup

1. Enable Codex cloud and **Code review** for this GitHub repository.
2. Authenticate the GitHub connector or verify `gh auth status`.
3. Trust the project and inspect/trust the repository hooks with `/hooks`.
   Trust is hash-based; changed hooks require review again.
4. Protect `vMAJOR.MINOR.PATCH` tags with a GitHub ruleset that forbids tag
   updates and deletion, and keep complete Git history and tags available
   locally. Local inspection cannot recover a tag deleted from the remote.

Project configuration caps spawned subagent threads at four, defaults ordinary
subagents to medium reasoning, gives the verifier high reasoning, and does not
pin an account-specific model. GitHub Codex remains the canonical reviewer;
the local verifier is an integration gate, not a replacement reviewer.

## Exact-SHA review cycle

Before requesting review, the orchestrator proves that no worker is active, all
accepted commits are integrated, the checkout is clean, validation passed for
the current SHA, the branch is pushed, local HEAD equals the PR head, and state
records that exact SHA. The orchestrator then posts exactly:

```text
@codex review
```

Record the request comment ID/URL, request timestamp, and requested SHA. Read
the resulting standard review through structured GitHub data and accept it only
when:

```text
review commit == requested head == current PR head
```

Other reviews are stale. Never infer commit identity from prose, use
`@codex address that feedback`, or let a worker write to GitHub.

## Durable state and recovery

State is stored outside tracked files under:

```text
<absolute-git-common-dir>/codex/pr-review/pr-<number>/state.json
```

An active pointer, concise `events.ndjson`, lock files, a compaction backup, and
archived cycles live under the same repository-specific directory. Updates are
schema-validated, revision-checked, locked, limited to 30 KB, and written by
temporary-file rename. State never contains raw logs, complete diffs, stack
traces, or full review transcripts.

Commands:

```bash
node scripts/pr-review-state.mjs init --pr 123 --base origin/main --head HEAD
node scripts/pr-review-state.mjs path
node scripts/pr-review-state.mjs validate
node scripts/pr-review-state.mjs show
node scripts/pr-review-state.mjs recover
node scripts/pr-review-state.mjs checkpoint --input /tmp/state.json --expected-revision 4
node scripts/pr-review-state.mjs archive
```

`SessionStart` injects a compact recovery brief on startup, resume, and after
compaction. `PreCompact` validates and checkpoints Git metadata only from the
recorded integration checkout. Neither hook parses Codex transcript files.

If state is corrupt, inspect `state.backup.json`, Git history, structured GitHub
metadata, and CI artifacts. Do not reconstruct decisions from transcripts. To
archive stale state, confirm the PR number and use the archive command; this
moves the complete cycle under the Git common directory and clears its active
pointer.

## Findings, tasks, and worker results

Triage every applicable finding as actionable, duplicate, already fixed, stale,
invalid, policy conflict, out of scope, or requiring a human decision. Merge
comments with the same root cause and assign stable semantic fingerprints.

Checked-in contracts:

- [`pr-review-state.schema.json`](./pr-review-state.schema.json)
- [`review-fix-task.schema.json`](./review-fix-task.schema.json)
- [`review-fix-result.schema.json`](./review-fix-result.schema.json)

Task packets include the reviewed SHA, normalized finding/evidence, applicable
decisions, dependencies, allowed/forbidden paths, acceptance criteria, and
required validation. Worker results use status `implemented`, `blocked`,
`not-applicable`, or `failed`; implemented work requires a commit SHA. Results
contain concise validation summaries, not logs.

The `SubagentStop` hook validates the final message from `review_fix_worker`. It
requests one corrected raw JSON response, then allows termination with a warning
instead of creating an infinite loop.

## Parallelism, worktrees, and integration

Tasks may share a batch only when they have no dependency, anticipated write
overlap, shared contract/schema/fixture/generated-file coupling, or behavior
dependency. Root dependencies/configuration, Codex/GitHub configuration, shared
contracts, API schema/migrations, and shared Playwright fixtures are serialized
by default.

Parallel writers require worktrees from the exact reviewed SHA:

```bash
node scripts/pr-review-worktree.mjs create --pr 123 --task finding-a --base <sha>
node scripts/pr-review-worktree.mjs inspect --pr 123 --task finding-a
node scripts/pr-review-worktree.mjs remove --pr 123 --task finding-a
```

The helper uses deterministic sanitized identifiers, refuses existing or dirty
worktrees, records ownership manifests, never removes unknown paths, and keeps
cleanup idempotent. If the Codex surface cannot constrain a worker to its
worktree, serialize writers.

Only the orchestrator inspects and cherry-picks worker commits, in dependency
order. Workers never resolve conflicts with one another. Run narrow checks
after each dependency cluster and checkpoint every successful integration.

## Validation and loop breakers

Workers run narrow tests. Once per integrated batch the orchestrator runs:

```bash
npm run check
npm run check:release-state
npm run check:released-migrations
```

Also run database migration and E2E gates when root `AGENTS.md` requires them.
The integration verifier then checks finding resolution, ownership, unrelated
behavior, inconsistent assumptions, tests, and migration rules.

If the same semantic finding recurs in two consecutive rounds, perform focused
root-cause escalation. After three automatic review rounds, stop with a
consolidated human-decision report. Finish only when the review applies to the
integration head, all findings have dispositions, no task is queued/running/
blocked, and validation passes.

## Release semantics and troubleshooting

Release status comes only from a valid marker and annotated stable tag reachable
from `main`. A pending marker is not a release. Inspect policy with:

```bash
npm run release:state
npm run check:release-state
npm run check:released-migrations
```

Exit code `1` means a policy failure; `2` means an operational or usage failure.
If Git refs or tags are missing, fetch them explicitly rather than treating the
repository as pre-release. If `gh` or the connector is unavailable, repair
authentication before requesting review. If hooks do not run, open `/hooks` and
trust the current definitions.
