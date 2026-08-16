# Operations/workflow profile

Use for explicitly owned Docker, deployment, CI, release tooling, repository scripts, `.agents/**`, `.codex/**`, or `.github/**` work.

- Read root [`AGENTS.md`](../../../../AGENTS.md), [`docs/architecture.md`](../../../../docs/architecture.md), relevant [`specs/features`](../../../../specs/features), [`CONTRIBUTING.md`](../../../../CONTRIBUTING.md), and the owning capability documentation. Keep `.codex` discovery adapters thin and canonical implementations co-located under their owning skill.
- Resolve paths from the repository top level and support linked worktrees. Preserve hook JSON and CLI output contracts, bounded correction, durable state under the Git common directory, and exact-commit evidence.
- Keep [`scripts/lib/release-state.mjs`](../../../../scripts/lib/release-state.mjs), [`scripts/run-related-e2e.mjs`](../../../../scripts/run-related-e2e.mjs), and [`.codex/hooks.json`](../../../../.codex/hooks.json) separately owned. Never expose secrets through arguments, logs, state, or committed configuration.
- Serialize `.agents/**`, `.codex/**`, `.github/**`, package manifests, and other shared tooling surfaces.

Escalate ambiguous ownership, release evidence, path discovery, or contract changes. Do not create duplicate registries, schemas, or operator guides.
