---
name: aerstello-specialists
description: Select and apply Aerstello domain profiles, risk tags, and deterministic read-only specialist routing. Use when planning, implementing, investigating, or reviewing work in apps/web, apps/api, packages/shared, financial or migration logic, executable behavior tests, or repository operations, including exact-subject planning and integrated-HEAD risk evidence.
---

# Aerstello specialists

Use this skill as project guidance, never as permission. Exact owned paths, acceptance criteria, dependencies, and validation supplied by the calling workflow remain authoritative.

## Apply a profile

1. Read root `AGENTS.md` and the relevant feature scenarios.
2. Validate the caller-provided `specialization`, `affectedAreas`, and `riskTags` with `scripts/validate-registry.mjs`. Do not invent a generic fallback.
3. Read only the selected guide under `profiles/`, plus `docs/architecture.md` when the work concerns financial, authentication, realtime, or offline behavior.
4. Use `routeSpecialists` with explicit `browserVisible` and `testSelectionUncertain` signals. Read [references/routing.md](references/routing.md) when integrating the result into a workflow.
5. Apply [references/reviewer-contracts.md](references/reviewer-contracts.md) with an explicit `planning` or `review` phase and exact subject SHA when requesting or checking read-only specialist evidence.
6. Stop and report an unexpected dependency instead of changing profile, paths, tests, selectors, or projects.

Run `node --test .agents/skills/aerstello-specialists/scripts/*.test.mjs` after changing this capability.
