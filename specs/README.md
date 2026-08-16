# Feature specifications

The `.feature` files are the product acceptance contract. `playwright-bdd` generates Playwright tests from every scenario and fails when a step has no implementation.

Feature files own user-visible behavior, stable scenario IDs, and execution-scope tags. They do not own browser setup, database reset, helper code, or cleanup. Those concerns belong to capability-focused modules under `tests/e2e`; see [the E2E guide](../tests/e2e/README.md).

When behavior changes:

1. Update or add the Gherkin scenario first.
2. Implement the behavior without weakening an existing invariant.
3. Add or update its step definition in the owning `tests/e2e/**/*.steps.ts` capability module.
4. Add lower-level tests for calculation, authorization, timing, or transaction rules.

Feature scenarios run against the real PWA, Fastify API, and PostgreSQL database. An automatic test-scoped fixture resets deterministic E2E seed data before every scenario and retry.

Every scenario must have exactly one globally unique `@id-...` tag. Area tags such as `@area-auth`, `@area-access`, `@area-ordering`, `@area-billing`, `@area-management`, `@area-localization`, `@area-pwa`, and `@area-security` select related capability coverage. Execution tags add required environments: `@device-responsive`, `@browser-webkit`, `@browser-firefox`, and `@cross-device`.

Run a focused selection with `npm run test:e2e:related -- --id <stable-id>` or `npm run test:e2e:related -- --tag <tag>`. Selectors are repeatable and combined as a Cucumber OR expression. The planner validates every selector and refuses scenarios whose required browser projects were not explicitly supplied. Tablet Chromium is the default; tagged WebKit and Firefox scenarios require `--project mobile-webkit` and/or `--project desktop-firefox` as applicable.
