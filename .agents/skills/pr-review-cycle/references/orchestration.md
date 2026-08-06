# Orchestration reference

## Contents

- [Conflict graph](#conflict-graph)
- [Worktrees](#worktrees)
- [Worker acceptance](#worker-acceptance)
- [Integration verification](#integration-verification)
- [Validation](#validation)

## Conflict graph

Tasks conflict when they overlap anticipated writes; change and consume the
same contract; alter the same schema/migration; modify shared fixtures or
generated outputs; touch root dependencies/configuration; or depend on one
another's behavior.

Serialize these areas by default:

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

Document an explicit ownership decision before treating any listed area as
parallel-safe.

## Worktrees

```bash
node scripts/pr-review-worktree.mjs create --pr 123 --task finding-a --base <reviewed-sha>
node scripts/pr-review-worktree.mjs inspect --pr 123 --task finding-a
node scripts/pr-review-worktree.mjs remove --pr 123 --task finding-a
```

Creation refuses existing paths/branches. Removal identifies a worktree only by
PR/task manifest, refuses unknown or dirty paths, and is idempotent. The helper
does not delete task branches.

## Worker acceptance

Before integrating, confirm:

1. Task ID matches the immutable packet.
2. Implemented status has a real commit based on the reviewed SHA.
3. Changed paths are a subset of ownership and contain no forbidden path.
4. Required validations are present and concise.
5. The commit contains no unrelated work.
6. Unexpected dependencies were reported rather than silently included.

## Integration verification

Run `integration_verifier` after all accepted commits in a batch are integrated.
Give it the accepted findings, decisions, task packets, worker results, and
integrated diff. It stays read-only and reports evidence-backed correctness,
security, data-integrity, regression, ownership, consistency, and test gaps.

## Validation

Run narrow checks after each dependency cluster. Before the next review run:

```bash
npm run check
npm run check:release-state
npm run check:released-migrations
```

Also run database migration/E2E validation for billing, PWA, offline, cross-
device, migration, or other areas required by root `AGENTS.md`. Do not run the
complete browser suite independently in every worker.
