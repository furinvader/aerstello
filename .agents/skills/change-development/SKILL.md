---
name: change-development
description: Plan, implement, or resume durable Aerstello changes from an issue, direct request, repository plan, or partial implementation. Use when Codex must preserve planning provenance, resolve source drift, validate an immutable accepted plan, run bounded implementation workers, integrate exact worker commits, or recover interrupted lifecycle state.
---

# Change development

Use this capability to turn one explicit source into durable, reviewable planning
and implementation state. It may bind accepted-plan tasks, run bounded workers
in isolated worktrees, and integrate exact accepted worker commits. It does not
perform integrated-HEAD verification, orchestrate PR review, mutate GitHub, or
merge a pull request.

1. Read the [operator guide](README.md) before starting or resuming a change.
2. Read [planning](references/planning.md) when selecting a source, creating or validating a plan, refreshing the source, or recording a decision or amendment.
3. Read [state and recovery](references/state-and-recovery.md) when interpreting phases, recovering an interrupted transition, handling repository drift, abandoning, or archiving.
4. Read [implementation](references/implementation.md) before upgrading state, binding a task packet, creating a worker worktree, accepting a result, or integrating a commit.
5. Apply the selected profile and deterministic routes from the [Aerstello specialist capability](../aerstello-specialists/SKILL.md). Treat its guidance as advisory; the accepted plan and immutable task packet remain authoritative.
6. Use `npm run change:state -- <command>` for lifecycle transitions, `npm run change:worktree -- <command>` for owned worker worktrees, and `npm run change:status` for bounded human-readable context. Stop on ambiguous input, invalid evidence, or a blocked recovery instead of guessing.

An accepted plan is immutable. Record an authorized amendment as a new append-only artifact; never rewrite the accepted plan or an earlier amendment.

Implementation stops at `integrated`. Issue #24 owns integrated-HEAD specialist
verification, PR preparation, GitHub writes, and delivery gates.
