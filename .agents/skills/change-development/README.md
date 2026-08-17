# How change development works

The `$change-development` capability creates and resumes a durable implementation plan for one Aerstello change. It preserves the exact planning source, Git observation, decisions, specialist evidence, and accepted plan so another session can continue without reconstructing intent.

This capability stops at planning readiness. It does not execute planned tasks, start implementation workers, conduct a PR review cycle, merge, or write to GitHub. Issue reads through the standalone adapter are read-only.

## Terms

- **Change ID**: operator-supplied stable identifier for one durable planning record.
- **Planning ref / Planning SHA**: explicit clean commit used to read repository content and assess the plan. A branch name alone is insufficient; initialization resolves it to a commit.
- **Source**: exactly one issue, UTF-8 direct-request file, repository-plan path at the Planning SHA, or committed partial implementation compared with an explicit base.
- **Observation**: normalized, immutable evidence of source and Git state at a point in time.
- **Accepted plan**: canonical validated `plan.json`. Acceptance freezes it permanently.
- **Decision**: a normalized candidate-plan resolution before acceptance, or an append-only operator resolution of accepted-plan source drift afterward.
- **Amendment**: authorized append-only plan evolution containing provenance, delta, the complete resulting normalized plan, and old/new digest receipts.
- **Exact next action**: one bounded command or operator action stored in state and emitted by status/hooks.

## Start or resume

Run commands from the repository root or use `npm --prefix /path/to/aerstello run …` from a nested workspace.

```bash
npm run change:state -- init \
  --change-id issue-22 \
  --mode plan-only \
  --base-branch main \
  --planning-ref <full-commit-sha> \
  --source /path/to/source-descriptor.json
npm run change:state -- path
npm run change:state -- show
npm run change:status
```

Initialization requires a change ID, mode, base branch, explicit Planning ref, and exactly one source. The modes are:

- `plan-only`: planning is complete at `ready-to-implement` and may be archived normally.
- `implement`: retain active state at `ready-to-implement` for the implementation capability.
- `full`: retain active state at `ready-to-implement` for implementation and later lifecycle work.

Supported sources are a GitHub repository plus issue number, a UTF-8 direct-request file, a tracked repository-plan path read from the Planning SHA, or a committed partial implementation with an explicit comparison base. Dirty planning snapshots and non-commit refs fail closed. Pass one JSON file to `--source`; its exact shape is one of:

```json
{ "type": "github-issue", "repository": "owner/repository", "issueNumber": 22, "relationshipIntent": "resolves" }
```

```json
{ "type": "direct-request", "path": "/path/to/request.md", "relationshipIntent": "resolves" }
```

```json
{ "type": "repository-plan", "path": "plans/change.md", "relationshipIntent": "resolves" }
```

```json
{ "type": "partial-implementation", "comparisonBase": "main", "relationshipIntent": "partial" }
```

`relationshipIntent` is optional and defaults to `reference-only`; accepted values are `reference-only`, `partial`, and `resolves`. Use `--expected-pr-base-branch` when the intended PR base differs from `--base-branch`.

Use the following lifecycle commands through `npm run change:state --`:

| Command | Purpose |
| --- | --- |
| `init` | Validate the clean Planning SHA and create the one active change |
| `path` | Print the durable path for the active or named change |
| `show` | Print machine-readable current state |
| `validate` | Validate the candidate or accepted plan and its evidence |
| `refresh-source` | Read the source outside the lock, then classify drift |
| `accept-plan` | Persist the immutable accepted plan and receipts |
| `record-decision` | Resolve accepted-plan source drift while `awaiting-decision` |
| `amend-plan` | Append an authorized complete resulting plan without rewriting history |
| `recover` | Finish only an exact matching interrupted transition |
| `archive` | Archive an abandoned change or normally completed `plan-only` change |

Pass the current state revision with `--expected-revision` to `refresh-source`, `accept-plan`, `record-decision`, `amend-plan`, and `archive`. Revision conflicts fail closed. `recover` instead verifies the exact committed interrupted intent and receipt chain; it does not accept a guessed revision. Uncommitted hidden transition staging is rollback-only. An intact committed intent may restore only its exactly embedded evidence and deterministic receipts; conflicting or tampered artifacts block.

`validate --plan` proves acceptance readiness only against the active durable state. It first validates that state's complete receipt, transition, and source-observation chain, then binds the candidate to the exact change, source capture, and Planning SHA. Without an active state it may report candidate schema errors, but readiness is always false and the command fails with a durable-state-required error.

Before acceptance, put every planning choice and its resolution in the
candidate plan's normalized `decisions`; `record-decision` is not a substitute
for that plan payload. The command is reserved for an accepted plan that moved
to `awaiting-decision` after source drift. Receipt-valid decision evidence from
the former pre-accept behavior blocks `accept-plan` for explicit reconciliation;
the capability never guesses that a legacy reason or other prose equals a plan
resolution.

A post-accept decision input is a strict JSON object. Use `resolve` before
incorporating material drift into an amendment, or `retain-plan` to authorize
the unchanged accepted plan when the repository is still clean at the Planning
SHA:

```json
{
  "id": "source-drift-2026-08-17",
  "reason": "The refreshed source adds a planning requirement.",
  "authorization": "operator-confirmed",
  "trigger": "source-refresh",
  "disposition": "resolve"
}
```

A non-retain decision records the initiating Git observation in the next durable state. If that transition is interrupted, recovery requires the same HEAD, branch (including detached state), and cleanliness before completing it. This exception is limited to a semantically valid `decision-recorded` transition whose predecessor is an accepted plan in `awaiting-decision` and whose immutable decision evidence matches that predecessor; an old planning-phase intent or relabeled intent cannot grant it. `retain-plan` recovery remains stricter and requires clean HEAD at the Planning SHA.

An amendment input records provenance separately from the complete resulting plan passed with `--plan`. Its `delta` must be a nonempty object; `invalidatedEvidence` is a unique string list and may be empty:

```json
{
  "id": "include-refreshed-requirement",
  "reason": "Incorporate the authorized source change.",
  "authorization": "operator-confirmed",
  "trigger": "source-drift-2026-08-17",
  "delta": { "summary": "Add the new criterion and its planned task." },
  "invalidatedEvidence": []
}
```

Read [planning](references/planning.md) for source, checklist, validation, and drift rules. Read [state and recovery](references/state-and-recovery.md) before recovery, abandonment, or archival.

## Hooks and trust

`SessionStart` and `PreCompact` run independent change-development handlers beside the PR-review handlers in the same matcher groups. Matching commands may run independently and concurrently; neither capability depends on handler order. The change handlers are no-op-safe when no change is active, emit bounded context, and perform no network work during compaction.

After `.codex/hooks.json` changes, inspect and renew project hook trust with `/hooks`. No new `SubagentStop` handler or agent adapter belongs to this capability.

## Handoff boundary

At `ready-to-implement`, verify `npm run change:status` reports no unresolved decision and one exact next action. For `plan-only`, archive when desired. For `implement` or `full`, leave the active record in place for the separate implementation capability introduced by later work.
