# Agent guide

## Start here

Aerstello is a TypeScript npm-workspace application. Preserve the distinction between the **Aerstello software name** and the **administrator-configured venue name**. Financial history must never be rewritten by later venue, guest, room, or product edits.

## Project lifecycle status

Aerstello is currently a **pre-release initial implementation** because no valid
production release marker-and-tag pair exists. Release status is derived from
Git history by `npm run release:state`, never from `package.json`, a migration
number, or an earlier commit or PR revision.

A valid production release is an annotated Git tag named
`vMAJOR.MINOR.PATCH`. Its commit must be reachable from the protected release
branch, currently `main`, and contain the matching
`.release/markers/vMAJOR.MINOR.PATCH.json`. The marker must identify product
`aerstello`, the same stable version and tag, channel `production`, and a valid
release timestamp. A marker without its tag is pending preparation, not release
evidence. A release-like tag without a valid matching marker is inconsistent
and must be reported rather than guessed around.

A migration becomes released and immutable only after it appears in a valid
production release. Unreleased migrations may be edited, renamed, reordered,
squashed, replaced, or deleted. Before the first valid release, consolidate
schema changes directly into `apps/api/migrations/0001_initial.sql`, keep
`apps/api/src/schema.ts` aligned, and recreate disposable development/test
databases and browser state after format changes. After releases exist, preserve
every migration that appeared in any valid release and add forward migrations
for changes to released schema. Never add compatibility paths, backfills,
legacy shims, or extra migrations solely for earlier development or PR states.

Before editing:

1. Read the relevant scenario in `specs/features`.
2. Read `docs/architecture.md` for financial, authentication, realtime, or offline changes.
3. Inspect shared contracts before creating a duplicate web/API type.
4. Follow the commit policy in `CONTRIBUTING.md` when creating commits.

## Working rules

- Use integer euro cents. Never calculate persisted money with floating point.
- Settlement is a whole-tab, online-only transaction. Lock the tab/items and snapshot venue, guest, room, product, and price data.
- Closed bills and bill lines are immutable. Correction is an audited bill void that reopens original order items.
- Archive referenced records. Do not cascade-delete financial or access history.
- All replayable mutations require client UUID idempotency keys.
- Host offline support is limited to cached-catalog order batches and eligible unbilled-item voids. Never silently resolve a billing conflict.
- Guest self-service items are server-timed provisional entries for 10 seconds. Billing must reject tabs with an active undo window.
- Host sessions and guest device grants stay in Secure, HttpOnly cookies. Never expose session tokens through application JSON.
- Add every new user-visible behavior to a `.feature` file and bind it to Playwright-BDD steps.
- User-facing UI must work in DE/IT/EN, with German as the fallback. Product DE text is required.

## Repository organization

Co-locate agent-specific implementation, schemas, tests, fixtures, hooks, and
operator documentation under the owning `.agents/skills/<skill>/` directory.
Keep only discovery/configuration adapters and genuinely shared,
capability-neutral utilities outside it. Do not add compatibility wrappers or
duplicate canonical schemas or operator guides. Release-state and related-E2E
remain separately owned capabilities consumed by the review skill.

## Change development

- Follow the [canonical change-development guide](./.agents/skills/change-development/README.md)
  when planning, implementing, or resuming a durable change from an issue,
  direct request, repository plan, or committed partial implementation.
  Accepted plans and bound worker packets are immutable. Workers stay in their
  assigned worktrees and exact path/validation scope; the central orchestrator
  alone accepts results and integrates exact commits. For `implement` and
  `full`, continue through receipt-protected exact-HEAD validation, stored-route
  specialist review, the read-only development verifier, finding remediation,
  and `development-ready`. Stop there: push, PR work, official review, CI,
  GitHub writes, delivery, and merge belong to separate workflows.

## Scope assessment

- When creating or materially editing an implementation issue or plan, use the [scope-review capability](./.agents/skills/scope-review/README.md) at a draft commitment boundary that commits to a subsystem, dependency, public or persistent surface, cross-capability work, policy change, or repository-wide enforcement.

## Code Review Rules

### Release and migration compatibility

- Evaluate compatibility against valid production marker-and-tag pairs, not
  intermediate commits. Edits to unreleased migrations are allowed; report any
  modification or deletion of a migration that appeared in a valid release.
- Do not recommend shims, backfills, legacy paths, or extra migrations solely
  for an earlier revision of the same PR.

### PR review cycle

- Follow the [canonical PR review-cycle guide](./.agents/skills/pr-review-cycle/README.md)
  for exact-commit gates, role boundaries, thread resolution, validation,
  recovery, and loop breakers. The main orchestrator owns state, integration,
  and GitHub writes; fix workers and the verifier stay within their fixed roles.
- Apply the profile selected from the
  [Aerstello specialist registry](./.agents/skills/aerstello-specialists/README.md)
  as guidance only. The bound task packet remains authoritative for paths,
  dependencies, acceptance criteria, and validation.

## Validation

Use the smallest relevant checks for ordinary changes. During an active PR
review cycle, use only the exact commands, selectors, and browser projects
selected under the canonical guide; GitHub Actions remains authoritative for
`npm run check:full` and `npm run test:e2e:full`.
