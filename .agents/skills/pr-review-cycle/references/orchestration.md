# Planning, integration, and validation

Read this reference before assigning workers, managing worktrees, integrating
fixes, or choosing local tests.

## Plan fixed tasks

Group comments that share one root cause under one stable finding key. Each task
must record:

- the Review commit and finding evidence;
- dependencies and affected areas;
- allowed and forbidden paths;
- acceptance criteria;
- exact unit and integration commands;
- exact E2E scenario IDs, tags, or test selectors when needed;
- exact browser projects and why each selected check is relevant.

The instructions are fixed after delegation. If a related command, selector, or
project cannot be determined, stop and repair the plan. Neither a worker nor the
orchestrator may substitute a full local test run.

Bind each accepted packet before delegation:

```bash
npm run review:state -- bind-task-packet --task-packet /tmp/task-a.json --expected-revision 4
```

The guarded binding is the durable identity used by worker-result acceptance
and integrated validation. Do not delegate, validate a result, or build a
remediation plan from an unbound or changed packet.

## Separate tasks safely

Tasks cannot run together when they overlap anticipated writes, change and use
the same contract, touch the same schema or migration, share fixtures or
generated output, or depend on each other's behavior.

Serialize these areas unless an explicit ownership decision proves isolation:

```text
package.json
package-lock.json
.codex/**
.agents/**
.github/**
packages/shared/src/contracts.ts
apps/api/src/schema.ts
apps/api/migrations/**
shared Playwright fixtures and global steps
```

Use no more than four implementation workers. Every parallel writer needs an
isolated worktree based on the Review commit and a non-overlapping path set. If
the active Codex surface cannot keep a writer in its assigned worktree, run
writers one at a time.

## Manage worktrees

```bash
npm run review:worktree -- create --pr 123 --task finding-a --base <review-commit>
npm run review:worktree -- inspect --pr 123 --task finding-a
npm run review:worktree -- remove --pr 123 --task finding-a
```

Creation refuses existing paths and branches. Removal uses the saved PR/task
manifest, refuses unknown or dirty paths, and does not delete task branches.
Remove a worktree only after its commit was Integrated or intentionally rejected.

## Accept and integrate worker results

Before integration, confirm:

1. The result matches the fixed task ID and Review commit.
2. An implemented result names a real descendant commit with a nonempty tree diff from the Review commit.
3. Git-derived changed paths exactly equal the reported paths, every changed path is allowed, and no forbidden path changed.
4. The exact required validations ran and have concise results.
5. The commit contains no unrelated work.
6. Unexpected dependencies were reported instead of silently included.

Cherry-pick accepted commits centrally in dependency order. Resolve conflicts
only in the integration checkout. Checkpoint each successful integration.
Integrated means the code is central; it does not mean the finding is Resolved.

## Validate the integrated batch

Worker task packets declare only the exact targeted commands that each worker
must run. Do not force integrated-area checks into every worker packet. After
integration, the orchestrator mechanically adds the following checks from the
batch's recognized `affectedAreas` to the union of all declared worker commands,
de-duplicates that union, and runs it once:

Save that operational union before running it:

```bash
npm run review:state -- validation-plan /tmp/task-a.json /tmp/task-b.json
npm run review:state -- run-validation
```

Before the first discovery review, a pristine cycle has no remediation tasks.
Provide its explicitly selected checks without inventing one:

```bash
npm run review:state -- validation-plan --initial-selection /tmp/initial-validation.json
npm run review:state -- run-validation
```

The selection document has schema version 1 plus `headSha`, `affectedAreas`,
and `requiredValidation`. It must select at least one exact targeted command and
match the clean integration HEAD. Initial-selection mode is otherwise
unavailable after durable task or review evidence exists, with one narrow
recovery: a taskless schema-v2 migration may preserve a pending exact-head
review while discarding legacy targeted-validation proof. After that review is
collected as clean, the same explicit selection may rebuild validation only
when the current request, outcome, and latest history entry are identical and
all review SHAs match the clean integration HEAD. Findings, pending or stale
reviews, tasks, and inconsistent history remain ineligible, and the applicable
clean review is not repeated. An ordinary taskless clean review with existing
passing validation cannot use this mode to replace that proof.

One native schema-v3 exception handles a taskless clean discovery review whose
four review SHAs still agree with each other but differ from the newer current
integration HEAD. It requires a `recovering` state, exact latest active review
evidence, zero tasks and actionable Integrated IDs, a clean exact current
checkout, no blockers or escalation, and remaining discovery-or-verification
allowance. Save a nonempty explicit selection for the current HEAD, using
`--replace` only to replace the stale historical plan sidecar, then run every
selected check again. The transition changes only targeted-validation proof;
the prior request, outcome, and history stay immutable and remain stale until a
new current-HEAD review is requested. A same-HEAD review or an already-passing
recovery proof is not replaceable through this route.

Initial selection also has one migration-only completed-task route. An
immutable `state.v2.backup.json` must prove an exact-head passed, nonempty
legacy targeted proof and a nonempty all-completed task set. A
`ready-for-review` or `complete` source is eligible only when canonical
migration reproduces the active `recovering` state exactly. An
`awaiting-review` source is eligible only after migration preserves its exact
pending request and one guarded clean exact-head outcome is collected: canonical
migration plus that single outcome transition must reproduce the active
`validating` state, normalizing only checkpoint revision and timestamp metadata.
In either case targeted validation must be `not-run`, the current integration
HEAD and checkout must be exact and clean, there must be zero actionable
Integrated tasks, and no blocked reason, verification escalation, or
`needs-human-decision` disposition. Use the backup only to authorize a fresh
explicit plan. Run the selected checks again and record new exact-head proof;
never adopt the legacy pass or repeat a preserved review. Native schema-v3
cycles and missing, mismatched, modified, or multi-transition migration
provenance remain ineligible.

The packet list must exactly cover the current actionable Integrated tasks. The
saved plan is tied to the clean integration commit, records each command as it
finishes, and lets `run-validation` skip commands already attempted after an
interruption. A changed commit, dirty checkout, malformed plan, or incomplete
task list is an error. After a failed plan, fix the cause and create a fresh
plan with `validation-plan --replace` rather than substituting a broader check.

| Area | Normal integrated check |
| --- | --- |
| API | `npm run check:api` |
| Web | `npm run check:web` |
| Shared contract | `npm run check:shared`, then both API and web checks |
| Review tooling | `npm run check:workflow` |
| Documentation | No automatic command; preserve any declared relevant schema, link, or lint check |

Run `npm run check:release-state` and `npm run check:released-migrations` when
release or migration policy is relevant. Release status comes only from a valid
marker plus matching annotated stable tag reachable from `main`. Never add a
compatibility migration for an unreleased PR revision.

For browser-visible changes, use `npm run test:e2e:related` with explicit stable
scenario selectors. Default to `tablet-chromium`. Add WebKit, Firefox, mobile,
or other projects only when the behavior is responsive, touch-specific,
installation-specific, cross-device, or browser-specific. The command must
refuse an empty selector and must never fall back to all scenarios.

`npm run check:full` and `npm run test:e2e:full` are GitHub Actions gates.
Running full E2E locally is exceptional: an explicit operator request, diagnosis
of a full-suite CI failure, or a release investigation while CI is unavailable.

## Verify the combined change

Run `integration_verifier` read-only after integration. Give it the findings,
outcomes, fixed task instructions, worker results, Review commit, integrated
commit, and targeted validation. It checks correctness, security, data
integrity, regressions, ownership, inconsistent assumptions, selected-test
sufficiency, and released migrations. It does not edit or write to GitHub.

A missing or uncertain related-test selection is a verifier finding and returns
to planning. It is never resolved by requesting the full local suite.
