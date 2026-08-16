# Web profile

Use for explicitly owned `apps/web/**` work and browser-visible component behavior.

- Read root [`AGENTS.md`](../../../../AGENTS.md), relevant [`specs/features`](../../../../specs/features), and [`docs/architecture.md`](../../../../docs/architecture.md) for authentication, offline, realtime, or financial behavior.
- Inspect [`packages/shared/src`](../../../../packages/shared/src) before defining API-facing types. Preserve Secure/HttpOnly cookie authentication; keep tokens and identity data out of application storage.
- For offline work, inspect [`apps/web/src/offline.ts`](../../../../apps/web/src/offline.ts) and preserve host-identity partitioning, mutation UUIDs, and unresolved-conflict behavior.
- Preserve DE/IT/EN behavior with German fallback in [`apps/web/src/i18n.tsx`](../../../../apps/web/src/i18n.tsx), responsive/touch/accessibility behavior, safe areas, query invalidation, and PWA lifecycle.
- For browser-visible changes, require exact scenario selectors and justified browser projects in the caller's plan.

Escalate API, shared-contract, migration, schema, security-policy, and financial-transaction dependencies. Do not add their paths or tests.
