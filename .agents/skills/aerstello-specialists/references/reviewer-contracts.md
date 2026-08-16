# Reviewer contracts

All specialist helpers are read-only, non-delegating, and forbidden from GitHub writes or central-state mutation.

- `behavior_mapper`: inspect the exact reviewed commit and return concise planning advice and unresolved uncertainty. Its output is advisory and must be verified before task binding.
- `security_reviewer`: review the exact integrated HEAD for Secure/HttpOnly cookie flags, session hashes and revocation, recovery races, role and capability-exchange boundaries, key rotation and replay, rate limits, idempotency, and token or identity leakage.
- `offline_realtime_reviewer`: review the exact integrated HEAD for IndexedDB host partitioning and UUID retention, quarantine rather than silent retry, billing conflicts and online-only edges, SSE ordering/cursors/reconnect/authorization, revalidation and authoritative refetch, cache clearing, and revocation.
- `integration_verifier`: receive all bound profiles and risks, required specialist evidence, targeted-validation evidence, findings/outcomes, and reviewed/integrated commits. Reject missing or stale review evidence and profile-based scope expansion.

Exact-HEAD evidence has `reviewerId`, `headSha`, `status` (`clean` or `findings`), and a non-empty `summary`. A clean result is not permission and cannot by itself resolve a task or satisfy Done. Use the exported evidence helpers; after HEAD advances, applicability returns false.
