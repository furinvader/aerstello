---
name: scope-review
description: Assess whether proposed or completed Aerstello work is the smallest sufficient implementation of an exact authoritative source and accepted plan. Use at draft boundaries that commit to material implementation surfaces; do not use it to authorize scope changes or perform general architecture review.
---

# Scope Review

Return bounded, read-only evidence about implementation scope. Do not mutate caller state, GitHub, plans, tasks, worktrees, or repository content, and do not delegate the assessment.

1. Require the caller to prepare the exact normalized packet defined in [the assessment contract](references/assessment-contract.md). Fail closed when evidence is absent, stale, or not bound to the exact subject.
2. Compare source scope, accepted scope, and append-only amendments with the concrete implementation shape. Treat quantitative measurements only as prompts to inspect evidence.
3. Choose exactly one schema-defined verdict and validate the result. A material expansion always requires a human decision; this skill never authorizes it.
4. Return only the assessment to the caller. The caller owns every lifecycle transition or follow-up action.

Read [the assessment contract](references/assessment-contract.md) for packet preparation, verdict rules, materiality triggers, applicability checks, and examples.
