# End-to-end test structure

Playwright-BDD 9.2 discovers the canonical fixture first and then every capability step module, in this exact order:

```text
tests/e2e/fixtures/test.ts
tests/e2e/**/*.steps.ts
```

`tests/e2e/fixtures/test.ts` owns the extended `playwright-bdd` test, scenario-scoped state, the deterministic database reset, and universal teardown. Each `*.steps.ts` file owns registrations for one product capability and must import that exact `test` export without aliasing, then bind its keywords with exactly `createBdd(test)`. Support modules may provide stateless helpers, but may not register steps. The former `tests/e2e/steps/app.steps.ts` monolith must not exist.

Define each producer/consumer cluster with an adjacent `createScenarioState(...)` factory and obtain it through the `scenarioState` fixture, so Playwright creates it afresh for every scenario and retry. Single-step scratch values stay local. Do not add top-level `let`/`var`, mutable array/object/`Map`/`Set` singletons, or exported mutable E2E state. Reset seeded database data before each scenario. Register secondary browser contexts, PostgreSQL clients, API replica processes, routes, and browser streams immediately with the scenario `ResourceRegistry`; teardown is sequential LIFO and continues through cleanup failures.

## Capability ownership

Step wording has one owner even when scenarios in several feature files reuse it. In particular:

| Shared phrase | Owning capability |
| --- | --- |
| `the seeded Aerstello venue` | authentication / login bootstrap |
| `an authenticated administrator` | authentication / login bootstrap |
| `an approved guest device for {string} in room {string}` | guest access / guest devices |

Other registrations stay with the capability they exercise: authentication and host sessions, guest access and guest devices, management, ordering and billing, localization, responsive PWA behavior, and security regressions. Consumers reuse an owner's phrase; they do not register a duplicate expression.

The bounded capability modules are:

- authentication: login/bootstrap, account/profile, host accounts, and sessions;
- guest access: request queue, access request, grant exchange, guest devices, self-service catalog, self-service undo, and self-service recovery;
- management: rooms, guests, catalog, and realtime concurrency;
- ordering: order entry, offline recovery, dashboard, settlement, and bills;
- security regressions: capabilities/rate limits, authorization, replay binding, financial integrity, and session/realtime;
- one module each for localization, responsive/PWA behavior, and venue settings.

## Execution boundaries

The default E2E project is `tablet-chromium`. `npm run test:e2e:related -- --id <stable-id>` and `--tag <tag>` select related scenarios; repeat selectors to form an OR scope. Add `--project mobile-webkit` for `@browser-webkit` scenarios and `--project desktop-firefox` for `@browser-firefox` scenarios. The installable-manifest scenario is intentionally special: it carries both browser tags and must run in both of those projects. See [`specs/README.md`](../../specs/README.md) for the selector contract.

The suite deliberately uses `workers: 1` and `fullyParallel: false`. Database resets and the fixed auxiliary API endpoints form a serialized boundary, so increasing either setting is not a harmless speed optimization. The primary API and web defaults are ports `3001` and `5173`. Auxiliary API replicas share the reserved fixed range `3199` through `3204`; keep those assignments stable and clean every spawned process after its scenario.

Before running browser tests, use `npm run typecheck:e2e` and `npm run test:e2e:structure`. The structure check protects discovery order, canonical fixture use, registration ownership, and scenario-state isolation.
