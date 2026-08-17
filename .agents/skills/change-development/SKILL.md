---
name: change-development
description: Plan or resume durable Aerstello changes from an issue, direct request, repository plan, or partial implementation. Use when Codex must preserve planning provenance, resolve source drift, validate an immutable accepted implementation plan, recover interrupted planning state, or hand a ready plan to a later implementation workflow.
---

# Change development

Use this capability to turn one explicit source into durable, reviewable planning state. It plans and resumes work; it does not run implementation workers, orchestrate PR review, mutate GitHub, or merge changes.

1. Read the [operator guide](README.md) before starting or resuming a change.
2. Read [planning](references/planning.md) when selecting a source, creating or validating a plan, refreshing the source, or recording a decision or amendment.
3. Read [state and recovery](references/state-and-recovery.md) when interpreting phases, recovering an interrupted transition, handling repository drift, abandoning, or archiving.
4. Apply the selected profile and deterministic routes from the [Aerstello specialist capability](../aerstello-specialists/SKILL.md). Treat its guidance as advisory; the accepted plan and exact source remain authoritative.
5. Use `npm run change:state -- <command>` for state transitions and `npm run change:status` for bounded human-readable context. Stop on ambiguous input, invalid evidence, or a blocked recovery instead of guessing.

An accepted plan is immutable. Record an authorized amendment as a new append-only artifact; never rewrite the accepted plan or an earlier amendment.
