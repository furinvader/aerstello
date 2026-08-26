# Scope review

`$scope-review` is Aerstello's stateless, read-only assessment of whether proposed or completed work is the smallest sufficient implementation of an authoritative source and accepted scope.

Invoke it when creating or materially editing an implementation issue or plan at a draft commitment boundary that commits to a subsystem, dependency, public or persistent surface, cross-capability change, policy change, or repository-wide enforcement. The caller prepares a bounded packet for one exact subject, applies the assessment only when every echoed identity still matches, and retains authority over amendments and implementation.

The capability does not crawl the repository, maintain state, delegate, run a lifecycle, mutate GitHub, or authorize scope changes. See [the assessment contract](references/assessment-contract.md) for the normalized packet, five verdicts, stale-evidence rules, and examples.

The canonical schema is [`schemas/scope-assessment.schema.json`](schemas/scope-assessment.schema.json). The pure validator in [`scripts/validate-assessment.mjs`](scripts/validate-assessment.mjs) enforces the 64 KiB packet and 32 KiB result envelopes and exact applicability.
