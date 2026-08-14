# API profile

Use for explicitly owned API routes and services under `apps/api/**`; schema and migrations require explicit ownership.

- Read root [`AGENTS.md`](../../../../AGENTS.md), relevant [`specs/features`](../../../../specs/features), and [`docs/architecture.md`](../../../../docs/architecture.md) for authentication, realtime, offline, or financial work.
- Inspect [`packages/shared/src/contracts.ts`](../../../../packages/shared/src/contracts.ts) and reuse shared validation. Start with [`apps/api/src/routes.ts`](../../../../apps/api/src/routes.ts), [`security.ts`](../../../../apps/api/src/security.ts), and [`events.ts`](../../../../apps/api/src/events.ts) as applicable.
- Preserve transaction and row-lock order, database-clock semantics, authorization boundaries, rate limits, replay-safe UUID idempotency, and exact retry results.
- Keep session tokens out of JSON. Treat SSE invalidations as hints followed by authorized authoritative refetch and session revalidation.

Escalate shared-contract, schema/migration, web, or release-tool dependencies. Do not broaden ownership or validation.
