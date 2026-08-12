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

## Code Review Rules

### Release and migration compatibility

- Evaluate compatibility against valid production marker-and-tag pairs, not
  intermediate commits. Edits to unreleased migrations are allowed; report any
  modification or deletion of a migration that appeared in a valid release.
- Do not recommend shims, backfills, legacy paths, or extra migrations solely
  for an earlier revision of the same PR.

### PR review cycle

- The main orchestrator alone writes durable review state, integrates fixes,
  posts evidence replies, resolves review threads, and requests GitHub reviews.
  Fix workers and the integration verifier never write to GitHub.
- The **Review commit** is the exact pushed commit sent to Codex. Accept a review
  only when its commit matches both the recorded Review commit and the current
  PR head. A Codex thumbs-up on the recorded request is clean evidence only
  while that request still points to the current PR head.
- **Integrated** means a worker commit is on the central PR branch. **Resolved**
  means the fix was verified, evidence was posted, and the Codex thread was
  closed. **Done** means Codex is clean, full CI including full E2E is green for
  that same Review commit, and GitHub shows no open Codex threads.
- Internal state may call Resolved `completed` and Done `complete`. Do not treat
  Integrated as Resolved or Done. After closing threads, query GitHub again to
  confirm that none remain open.
- Fix workers receive fixed, path-limited task instructions and work in isolated
  worktrees. They must not broaden scope. Parallel workers require non-overlapping
  write sets.

## Validation

Workers run only the exact commands, E2E selectors, and browser projects in
their task instructions. Missing or uncertain test selection is a planning
error; never fall back to a full local suite.

After integrating a batch, the orchestrator runs the union of its related
checks. Browser-visible changes use only related scenarios and default to
`tablet-chromium`. Add projects only when responsive, touch, installation, or
browser-specific behavior requires them. Release-state and released-migration
checks remain required when relevant.

GitHub Actions owns `npm run check:full` and `npm run test:e2e:full`. Normal
review rounds use targeted local checks and `npm run test:e2e:related` when
needed. Full local E2E is reserved for an explicit request, CI diagnosis, or an
exceptional release investigation when CI is unavailable. After targeted
validation and push, Codex review and CI may run at the same time.
