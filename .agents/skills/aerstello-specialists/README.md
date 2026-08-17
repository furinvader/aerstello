# Aerstello specialist capability

This workflow-neutral capability classifies Aerstello work by one primary domain profile and a small set of risk tags. It supplies guidance plus deterministic planning-helper and risk-reviewer routing; it never expands write ownership or validation.

The canonical machine contract is `registry.json`. `scripts/validate-registry.mjs` exports the registry validator, specialization validator, router, and phase-qualified exact-subject evidence helpers for any calling workflow.

## Profiles

| ID | Primary concern |
| --- | --- |
| `web` | React/PWA and browser-facing behavior |
| `api` | Fastify services, authorization, transactions, and SSE |
| `contracts` | Shared API/web contracts, validation, permissions, and money |
| `data-integrity` | Financial history, schema, migrations, and release evidence |
| `behavior-tests` | Gherkin mapping, Playwright-BDD bindings, and project selection |
| `ops-workflow` | CI, deployment, release tooling, and agent infrastructure |

Cross-domain work should normally become ordered dependent tasks. If it cannot be split safely, choose the profile owning the highest-risk invariant, list all actual affected areas, and serialize the task. Compatibility validation must pass before binding.

## Reusable routing concerns

- `planningHelpers` names advisory helpers that run against the caller's exact planning subject before its plan or contract is bound.
- `riskReviewers` names reusable reviewers that run against the exact integrated HEAD.
- `supplementalGuidance` adds another profile's knowledge without granting paths, validation, or other authority.
- `finalVerificationPriority` is `standard` or `high`. The calling workflow selects, invokes, and governs its own final verifier.

## Routing example

```js
const route = routeSpecialists({
  specialization: 'web',
  riskTags: ['responsive', 'authentication'],
  browserVisible: true,
  testSelectionUncertain: false,
});
```

The result lists `behavior_mapper` under `planningHelpers` and `security_reviewer` under `riskReviewers`, with standard final-verification priority. It does not name or invoke a final verifier. Changing risk-tag order does not change helper, reviewer, or reason order. Billing, money, migration, or release risk adds data-integrity guidance and raises final-verification priority; deployment or workflow risk adds operations guidance; offline or realtime risk adds `offline_realtime_reviewer`.

Unknown profiles, risks, incompatible affected areas, and uncertain missing routing data are planning errors. A clean specialist statement is advisory: it cannot resolve a finding, authorize edits, write GitHub, or satisfy a workflow's completion gate. When integrated HEAD changes, exact-HEAD review evidence is stale and must be rerun.
