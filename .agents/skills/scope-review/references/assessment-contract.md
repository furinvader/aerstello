# Scope assessment contract

## Authority and preparation

The authoritative source says what outcome is requested through required criteria and explicit non-goals. The accepted plan narrows that request into criteria and invariants while keeping optional implementation guidance distinct from requirements. Ordered append-only amendments may change accepted scope; they do not rewrite earlier decisions. The implementation shape is the concrete mechanism proposed or present in the exact subject.

The caller prepares one normalized packet and remains responsible for source capture, plan acceptance, amendments, task binding, and lifecycle state. Keep two semantic sections distinct: `sourceScope` records the source objective, required criteria, non-goals, and optional implementation guidance; `acceptedScope` records the candidate or accepted criteria, invariants, minimal sufficient closure, and authorized, unauthorized, and deferred implementation shape.

Include:

- the phase and exact source type, identity, and digest;
- the accepted plan digest, ordered amendment digests, and task-packet digest when those artifacts exist; `planDigest` and `taskPacketDigest` are null before their respective artifacts exist and must never contain placeholders, and amendment digests must remain empty until an accepted-plan digest exists;
- the subject digest and, for `task`, `integrated-head`, and `review-finding`, its exact Git SHA; phase never implies that a plan or task-packet artifact exists, so their digests remain null-capable and missing artifacts require `insufficient-evidence`;
- the semantic `acceptedScope` candidate during `plan`, even before an accepted-plan digest exists; only `source-draft` uses null because no accepted-scope candidate exists yet;
- source-required criteria, source non-goals, accepted criteria and invariants, and optional implementation guidance in separate stable-ID lists;
- a concise deterministic change inventory naming paths, dependencies, public surfaces, persistent surfaces, subsystems, and every implementation mechanism mapped separately to source criteria, accepted criteria, invariants, non-goals, or guidance;
- any quantitative tripwires as observations only.

The 64 KiB packet and 32 KiB result limits bound context. They are never scope or materiality evidence.

## Assessment

Classify each mechanism as `required`, `implementation-choice`, `speculative`, `necessary-minor-expansion`, `material-scope-change`, or `insufficient-evidence`. Judge necessity from the source objective and requirements together with the accepted criteria, invariants, minimal closure, and authorized/unauthorized/deferred shape, not from line, file, diff, byte, or token counts.

Materiality triggers are closed and complete: a new subsystem, new dependency, public surface, persistent surface, cross-capability work, policy change, repository-wide enforcement, independent workstream, new criterion, non-goal reversal, sensitive policy, replacement of the accepted approach, or repeated expansion. A tripwire can request closer inspection but cannot select or exclude any verdict.

Return exactly one verdict:

- `within-scope`: every mechanism is supported and no work, delta, evidence, or human decision remains.
- `trim-required`: name each unnecessary mechanism and a smaller sufficient alternative.
- `minor-amendment-required`: describe a necessary minor delta, map it to existing criteria, and show that it creates no material surface.
- `human-decision-required`: name at least one material trigger and present the smallest expansion, a narrow alternative, and consequences of deferral without authorizing either.
- `insufficient-evidence`: name the missing exact evidence and make no affirmative scope conclusion.

## Applicability and staleness

Validate the packet before assessment and the result before use. Then compare the result's complete binding with the packet byte-for-byte by value. Also verify that every referenced criterion and invariant ID exists in the packet. Any mismatch, missing exact SHA, changed source capture, changed plan or amendment order, changed task packet, or changed subject makes the assessment inapplicable. Fail closed and request a new assessment; never repair identities or mutate the inputs.

## Examples

- A direct local fix mapped to the accepted defect criterion is `within-scope`.
- Adding an unrequested generic repository checker around that fix is `trim-required`; remove the checker and retain the direct fix.
- A small adjacent helper and focused test needed to express an existing criterion is `minor-amendment-required` when it adds no material surface.
- Expanding the work into a new subsystem or repository-wide enforcement is `human-decision-required`, with both the smallest expansion and the narrow implementation documented.
- If the exact plan digest, task packet, or applicable Git SHA is unavailable, return `insufficient-evidence`.
