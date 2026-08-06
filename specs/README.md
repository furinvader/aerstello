# Feature specifications

The `.feature` files are the product acceptance contract. `playwright-bdd` generates Playwright tests from every scenario and fails when a step has no implementation.

When behavior changes:

1. Update or add the Gherkin scenario first.
2. Implement the behavior without weakening an existing invariant.
3. Add or update its step definition in `tests/e2e/steps`.
4. Add lower-level tests for calculation, authorization, timing, or transaction rules.

Feature scenarios run against the real PWA, Fastify API, and PostgreSQL database. The `Before` hook resets deterministic E2E seed data for scenario isolation.
