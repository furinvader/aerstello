# Behavior-tests profile

Use for explicitly owned [`specs/features`](../../../../specs/features), [`tests/e2e`](../../../../tests/e2e), scenario mapping, and Playwright-BDD bindings.

- Read root [`AGENTS.md`](../../../../AGENTS.md), [`docs/architecture.md`](../../../../docs/architecture.md), and [`specs/features`](../../../../specs/features); map user-visible behavior to exact existing or new Gherkin scenarios and stable tags.
- Inspect the capability-owned bindings under [`tests/e2e`](../../../../tests/e2e) before adding steps. Distinguish a product-spec change from test-only implementation work.
- Default browser-visible targeted validation to `tablet-chromium`. Add `mobile-webkit`, `desktop-firefox`, responsive, touch, installation, or cross-device coverage only for a documented behavior reason.
- Treat missing selectors, projects, tags, or scenario mapping as unresolved planning information; never substitute a broad local E2E run.

Production code is outside this profile unless the task explicitly owns it. Do not infer production paths, selectors, projects, or commands.
