# Pull-request review and remediation cycle

## Architecture and roles

Sky Bar keeps PR remediation repository-local. It does not run a daemon or
hosted implementation service.

- The **main Codex agent** is the sole orchestrator, logical active-state writer,
  commit integrator, GitHub review requester, evidence replier, and review-thread
  resolver.
- GitHub **`@codex review`** is the canonical independent reviewer. It produces a
  standard GitHub review against a recorded commit.
- **`review_fix_worker`** agents implement one immutable, path-bounded task in a
  dedicated worktree and return structured JSON.
- The read-only **`integration_verifier`** checks the combined result after
  integration and before the next GitHub review.

Workers and the verifier never write to GitHub. In particular, they do not
reply to findings, call `resolveReviewThread`, request reviews, or change review
state.

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

## Exact-SHA review and resolution cycle

Before requesting review, the orchestrator proves that no worker is active, all
prior tasks are completed, the checkout is clean, validation passed for the
current SHA, the branch is pushed, local HEAD equals the PR head, state records
that exact SHA, and a live GitHub query reports zero unresolved canonical
threads. The orchestrator then posts exactly:

```text
@codex review
```

Record the request kind, comment ID/URL, request timestamp, and requested SHA.
Read the resulting standard review through structured GitHub data and accept it
only when:

```text
review commit == requested head == current PR head
```

Other reviews are stale. A clean result may instead be the canonical Codex
thumbs-up reaction on the recorded request comment, provided the recorded
request SHA still equals the current PR head. The request is the exact-SHA
anchor for that reaction. Never infer commit identity from prose, use
`@codex address that feedback`, or let a worker or verifier write to GitHub.

For an applicable review with findings, the order is fixed:

1. Triage every finding and form bounded worker packets.
2. Run the bounded workers, validate their results, and integrate accepted
   commits centrally in dependency order.
3. Run the read-only integration verifier.
4. Validate the current head, push it, and prove local HEAD equals the PR head.
5. Reply to each source thread with concise commit and validation evidence, then
   invoke `resolveReviewThread`.
6. Re-query live threads and record exact-head proof of zero unresolved
   canonical threads.
7. Request the next canonical review only if the review allowance permits it.

The orchestrator owns every step that changes shared state or GitHub. A
successful resolution mutation is not enough; only the subsequent live query is
zero-unresolved proof.

## Durable state and recovery

State is stored outside tracked files under:

```text
<absolute-git-common-dir>/codex/pr-review/pr-<number>/state.json
```

An active pointer, concise `events.ndjson`, lock files, a compaction backup, and
archived cycles live under the same repository-specific directory. Updates are
schema-validated, revision-checked, locked, limited to 64 KiB, and written by
temporary-file rename. State never contains raw logs, complete diffs, stack
traces, or full review transcripts.

State commands:

```bash
node scripts/pr-review-state.mjs init --pr 123 --base origin/main --head HEAD
node scripts/pr-review-state.mjs path
node scripts/pr-review-state.mjs validate
node scripts/pr-review-state.mjs show
node scripts/pr-review-state.mjs migrate
node scripts/pr-review-state.mjs recover
node scripts/pr-review-state.mjs checkpoint --input /tmp/state.json --expected-revision 4
node scripts/pr-review-state.mjs archive
node scripts/pr-review-state.mjs archive --abandon-reason "superseded PR"
```

GitHub workflow helper commands:

```bash
node scripts/pr-review-github.mjs status --pr 123
node scripts/pr-review-github.mjs reply-resolve --pr 123 --task finding-a
node scripts/pr-review-github.mjs request --pr 123 --kind discovery
node scripts/pr-review-github.mjs collect --pr 123
node scripts/pr-review-github.mjs complete --pr 123
```

These helpers do not broaden ownership: only the orchestrator runs mutating
commands. Request kind `verification` is reserved for the one exact-head review
allowed after the third discovery review.

Schema version 2 distinguishes integration, source-thread completion, review
outcome evidence, and exact-head completion. Version-1 state requires an
explicit atomic migration that first writes a pre-migration backup and preserves
stable identities and dispositions; ordinary state reads never migrate it
silently. Terminal task records are compacted to durable identity, source,
fingerprint, disposition, integration, and resolution summaries instead of
retaining execution-only detail.

`SessionStart` injects a compact recovery brief on startup, resume, and after
compaction. `PreCompact` validates and checkpoints Git metadata only from the
recorded integration checkout. Neither hook parses Codex transcript files.

If state is corrupt, inspect `state.backup.json`, Git history, structured GitHub
metadata, and CI artifacts. Do not reconstruct decisions from transcripts.
Normal archival requires phase `complete`. To intentionally abandon another
phase, confirm the PR number, supply an explicit reason, and preserve that reason
with the archived cycle; archival then clears its active pointer.

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
At this point a task is `integrated`: its code is central, but its source
finding is not yet resolved.

## Validation and loop breakers

Workers run narrow tests. Once per integrated batch the orchestrator runs:

```bash
npm run check
npm run check:release-state
npm run check:released-migrations
```

Also run database migration and E2E gates when root `AGENTS.md` requires them.
The integration verifier then checks finding resolution, ownership, unrelated
behavior, inconsistent assumptions, tests, and migration rules. After the
current-head push, evidence reply, thread resolution, and live re-query, a task
becomes `completed`. A threadless task becomes completed through successful
verification. Neither outcome alone means the review cycle is `complete`.

If the same semantic finding recurs in two consecutive rounds, perform focused
root-cause escalation. Run at most three discovery reviews. If the third has
actionable findings, integrate and complete their fixes, then use the one
authorized exact-head verification review. If that verification is stale or
contains new findings, move to `awaiting-human-decision`, report the exact
evidence and decision needed, and do not request another review automatically.

The cycle is `complete` only when the clean review submission or eligible
thumbs-up applies to the integration head, all findings have dispositions,
every task is completed, Git is clean, validation is current, all recorded Git
and outcome SHAs agree, and a live query proves zero unresolved canonical
threads. Until then, report `awaiting-human-decision` or the active phase
truthfully rather than claiming completion.

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
