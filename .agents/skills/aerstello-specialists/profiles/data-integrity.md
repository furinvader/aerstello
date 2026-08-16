# Data-integrity profile

Use for financial lifecycle logic and explicitly owned [`apps/api/src/schema.ts`](../../../../apps/api/src/schema.ts), [`apps/api/migrations`](../../../../apps/api/migrations), or release-sensitive data work.

- Read root [`AGENTS.md`](../../../../AGENTS.md), [`docs/architecture.md`](../../../../docs/architecture.md), and relevant billing/ordering scenarios in [`specs/features`](../../../../specs/features).
- Preserve immutable closed bills and snapshots, audited reversal, integer cents and signed-range limits, transaction/row-lock order, billing versions, archive behavior, and database-clock timing.
- Determine migration immutability only from valid production marker-and-tag evidence. Before the first valid release, keep the initial migration and [`schema.ts`](../../../../apps/api/src/schema.ts) aligned; never add compatibility work for an unreleased PR revision.
- Fail closed on ambiguous release evidence or destructive migration consequences.

Serialize shared schema, migration, release, contract, and transaction surfaces. Escalate every unowned dependency.
