# Reviewer contracts

All planning helpers and risk reviewers are read-only, non-delegating, and forbidden from GitHub writes or caller-state mutation.

- `behavior_mapper`: inspect the caller-supplied planning subject at its exact SHA and return concise planning advice and unresolved uncertainty. Its output is advisory and must be verified before the caller binds its plan or contract.
- `security_reviewer`: review the exact integrated HEAD for Secure/HttpOnly cookie flags, session hashes and revocation, recovery races, role and capability-exchange boundaries, key rotation and replay, rate limits, idempotency, and token or identity leakage.
- `offline_realtime_reviewer`: review the exact integrated HEAD for IndexedDB host partitioning and UUID retention, quarantine rather than silent retry, billing conflicts and online-only edges, SSE ordering/cursors/reconnect/authorization, revalidation and authoritative refetch, cache clearing, and revocation.

Specialist evidence keeps the persisted fields `reviewerId`, `headSha`, `status` (`clean` or `findings`), and a non-empty `summary`. Callers validate it with an explicit `planning` or `review` phase and the exact `subjectSha`. Planning evidence is bound to the caller's planning subject; review evidence is bound to the integrated HEAD and becomes stale after that HEAD advances. A clean result is advisory, grants no permission, and cannot by itself satisfy a workflow completion gate.
