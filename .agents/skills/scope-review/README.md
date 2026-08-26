# Scope review

`$scope-review` is Aerstello's stateless, read-only assessment of whether proposed or completed work is the smallest sufficient implementation of an authoritative source and accepted scope.

Invoke it when creating or materially editing an implementation issue or plan at a draft commitment boundary that commits to a subsystem, dependency, public or persistent surface, cross-capability change, policy change, or repository-wide enforcement. The caller prepares a bounded packet for one exact subject, applies the assessment only when every echoed identity still matches, and retains authority over amendments and implementation.

The capability does not crawl the repository, maintain state, delegate, run a lifecycle, mutate GitHub, or authorize scope changes. See [the assessment contract](references/assessment-contract.md) for the normalized packet, five verdicts, stale-evidence rules, and examples.

## Operative minimality rules

Apply every rule below to the exact assessment subject. These rules guide the
read-only verdict; they do not authorize an amendment or implementation.

1. Map every implementation mechanism to exact source authority, an accepted
   criterion or invariant, an authorized amendment, or necessary minimal
   closure. Treat an unmapped mechanism as unsupported scope.
2. Apply the removal counterfactual: if removing a mechanism still satisfies
   the authoritative outcome and accepted scope, require its removal.
3. Prefer the smallest local, direct fix that fully satisfies the mapped
   authority over a broader or more indirect mechanism.
4. Do not accept infrastructure for hypothetical future consumers. A current,
   authoritative need must justify every such mechanism.
5. Treat optional implementation guidance and indicative directory trees as
   non-mandatory unless the accepted scope shows that they are required for
   sufficient closure.
6. Do not assume broad source language makes an expansion safe. Surface any
   material expansion for a human decision before execution.
7. Findings in newly introduced machinery do not by themselves justify
   hardening that machinery. Assess removal or simplification before proposing
   further work on it.
8. Use line, file, diff, byte, token, or other quantitative size measurements
   only as tripwires for closer inspection, never as scope evidence or verdict
   thresholds.

The canonical schema is [`schemas/scope-assessment.schema.json`](schemas/scope-assessment.schema.json). The pure validator in [`scripts/validate-assessment.mjs`](scripts/validate-assessment.mjs) enforces the 64 KiB packet and 32 KiB result envelopes and exact applicability.
