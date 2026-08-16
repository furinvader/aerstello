# Contracts profile

Use for explicitly owned shared contracts, validation, permissions, money, or localization helpers in `packages/shared/**`.

- Read root [`AGENTS.md`](../../../../AGENTS.md), [`docs/architecture.md`](../../../../docs/architecture.md), relevant [`specs/features`](../../../../specs/features), and the consumers in [`apps/api/src`](../../../../apps/api/src) and [`apps/web/src`](../../../../apps/web/src).
- Keep persisted money in integer euro cents and preserve validation and permission boundaries.
- Assess every current API and web consumer; avoid duplicate local types and require targeted checks for both sides when the task plan owns them.
- Serialize a contract producer before dependent API/web tasks unless explicit ownership and dependency evidence proves isolation.

Escalate consumer, migration, or schema edits outside the exact task. A profile does not make concurrent contract and consumer writes safe.
