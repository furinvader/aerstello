# Agent guide

## Start here

Sky Bar is a TypeScript npm-workspace application. Preserve the distinction between the **Sky Bar software name** and the **administrator-configured venue name**. Financial history must never be rewritten by later venue, guest, room, or product edits.

## Project lifecycle status

Sky Bar is a **pre-release initial implementation**. It has never held production data and has no released API, database, migration, or browser-storage formats. Treat the project as greenfield until the owner explicitly changes this section.

While this status remains in effect, consolidate schema changes directly into `apps/api/migrations/0001_initial.sql` and keep `schema.ts` aligned. Rewrite the initial migration instead of adding numbered follow-up migrations, and recreate disposable development and test databases and browser state after format changes. Do not add compatibility paths, backfills, or upgrade machinery for earlier development-only formats.

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

## Validation

Run the narrowest relevant test during development, then finish with:

```bash
npm run check
```

For cross-device, PWA, offline, or billing changes also run:

```bash
docker compose up -d db
npm run test:e2e
```
