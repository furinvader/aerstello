# Scope assessment contract

## Authority and preparation

The authoritative source says what outcome is requested through required criteria and explicit non-goals. The accepted plan narrows that request into criteria and invariants while keeping optional implementation guidance distinct from requirements. Ordered append-only amendments may change accepted scope; they do not rewrite earlier decisions. The implementation shape is the concrete mechanism proposed or present in the exact subject.

The caller prepares one normalized packet and remains responsible for source capture, plan acceptance, amendments, task binding, and lifecycle state. Keep two semantic sections distinct: `sourceScope` records the source objective, required criteria, non-goals, and optional implementation guidance; `acceptedScope` records the candidate or accepted criteria, invariants, minimal sufficient closure, and authorized, unauthorized, and deferred implementation shape.

Include:

- the phase and exact source type, identity, and digest;
- the accepted plan digest, ordered amendment digests, and task-packet digest when those artifacts exist; `planDigest` and `taskPacketDigest` are null before their respective artifacts exist and must never contain placeholders, task-packet identity can exist only after accepted-plan identity, amendment digests must remain empty until an accepted-plan digest exists, and `source-draft` requires both downstream digests to be null and the amendment list to be empty;
- the subject digest and, for `task`, `integrated-head`, and `review-finding`, its exact Git SHA; phase never implies that a plan or task-packet artifact exists, so their digests remain null-capable and missing artifacts require `insufficient-evidence`;
- the semantic `acceptedScope` candidate during `plan`, even before an accepted-plan digest exists; only `source-draft` uses null because no accepted-scope candidate exists yet;
- source-required criteria, source non-goals, accepted criteria and invariants, and optional implementation guidance in separate stable-ID lists;
- a concise deterministic change inventory naming paths, dependencies, public surfaces, persistent surfaces, subsystems, and every implementation mechanism mapped separately to source criteria, accepted criteria, invariants, non-goals, or guidance;
- any quantitative tripwires as observations only.

The 64 KiB packet and 32 KiB result limits bound context. They are never scope or materiality evidence.

## Assessment

Classify each mechanism as `required`, `implementation-choice`, `speculative`, `necessary-minor-expansion`, `material-scope-change`, or `insufficient-evidence`. Judge necessity from the source objective and requirements together with the accepted criteria, invariants, minimal closure, and authorized/unauthorized/deferred shape, not from line, file, diff, byte, or token counts.

Every `required` or `implementation-choice` coverage row must cite positive
authority through a source-required criterion, accepted criterion, or invariant.
Non-goals and optional implementation guidance may explain a classification,
but cannot provide that affirmative authority by themselves. A mechanism named
in unauthorized or deferred accepted shape cannot be classified `required` or
`implementation-choice`; that disposition alone does not prevent a valid
`speculative` or `necessary-minor-expansion` classification.

Every authority ID cited by a coverage row must also appear in the same
authority field of that mechanism's `changeInventory.mappings` row. Authority
from another mechanism or another ID namespace never satisfies this rule; a
mapping may expose additional authority that its coverage row does not use. A
mapping with no authority remains eligible only for a citation-empty
nonaffirmative classification such as `speculative` or
`insufficient-evidence`.

Positive authority in an inventory mapping establishes relevance and
traceability, not counterfactual necessity. A rejected or deferred nonmaterial
mechanism may therefore remain `speculative` when its coverage rationale records
that removing it preserves the authoritative outcome, accepted scope, and
minimal closure. Classify it `necessary-minor-expansion` only when the removal
counterfactual instead establishes that the mechanism is necessary, and ground
that claim through the correspondence rules below.

For `minor-amendment-required` and `human-decision-required`, each `necessary-minor-expansion` row must share
at least one positive authority ID, in the same field, with both its inventory
mapping and `scopeDelta`; source criteria, accepted criteria, and invariants are
equally valid positive namespaces, including invariant-only grounding. For a
minor verdict, every positive ID in `scopeDelta` must be
used by at least one `necessary-minor-expansion` row. This bidirectional
grounding permits multiple mechanisms to share one authority and permits strict
subsets, but IDs in different namespaces do not correspond.

Necessary-minor precedence does not hide independent removable work. A
`minor-amendment-required` result may retain positively grounded rejected or
deferred work as `necessary-minor-expansion` while classifying independent
unsupported nonmaterial work as `speculative`. In that mixed result,
`unnecessaryWork` is the order-insensitive exact set of speculative mechanisms
and `smallerSufficientAlternative` gives their removal. A pure minor result has
neither speculative work nor a smaller alternative. Material scope changes and
insufficient-evidence claims remain ineligible for this verdict, and a deficient
material inventory surface can never be trimmed this way.

Packet-side minor representability selects the byte-minimal mixed projection
jointly: every rejected or deferred grounded nonmaterial row may be speculative
or necessary, ordinary affirmative rows remain affirmative or may anchor the
minor delta, and unsupported nonmaterial rows remain speculative. The
projection contains at least one same-field grounded necessary anchor and
counts the exact serialized coverage, authority openings, repeated mechanism
identities, `unnecessaryWork` commas, and smaller-alternative toggle. Unique
authority incidence is minimized exactly. Shared-authority search is bounded;
an incomplete search may reject an oversized witness only when a globally
admissible relaxed lower bound also exceeds the result envelope.

Materiality triggers are closed and complete: a new subsystem, new dependency, public surface, persistent surface, cross-capability work, policy change, repository-wide enforcement, independent workstream, new criterion, non-goal reversal, sensitive policy, replacement of the accepted approach, or repeated expansion. A tripwire can request closer inspection but cannot select or exclude any verdict.

Apply authority before materiality and materiality before trimming. First
determine whether the named material surface is explicitly required by the
authoritative source and explicitly authorized by accepted scope. When both the
authoritative source and accepted scope provide that exact authority, the
mechanism is not a new material scope change: assess its necessity normally and
allow `within-scope`, `minor-amendment-required`, or another grounded ordinary
verdict when every other condition holds. A result must not relabel that surface
`material-scope-change` while claiming its inventory field's native materiality
category. A distinct material expansion remains representable under its own
non-native category. If either authority is
absent, classify the material commitment as `material-scope-change` and return
`human-decision-required`, even when the mechanism appears removable. Never
downgrade that mechanism to `speculative` or the assessment to
`trim-required`. Use `trim-required` only when every removable mechanism is
nonmaterial and removing it preserves sufficient closure of the authoritative
outcome and accepted scope. For that verdict, `unnecessaryWork` must name the
complete set of `speculative` coverage mechanisms exactly once; ordering has no
meaning.

A `human-decision-required` result may also classify an independent removable
nonmaterial mechanism as `speculative` when at least one other coverage row is
the material scope change that requires the decision. The material inventory
surface requiring that decision remains `material-scope-change` with its exact
category. When the result exposes only the native categories forced by deficient
material inventory, rejected or deferred work outside that inventory remains
`speculative` when the removal counterfactual proves it removable, even if its
mapping exposes positive authority. Work actually found necessary remains
`necessary-minor-expansion` with its same-field authority echoed in
`scopeDelta`, while independent unsupported nonmaterial work also remains
`speculative`; none of those rows may be relabeled `material-scope-change`
using only those forced native categories. A distinct non-native material
category may instead identify a genuine additional `material-scope-change`. In this
material-plus-minor result,
mixed coverage does not change authority-before-materiality or
materiality-before-trimming precedence, and `unnecessaryWork` remains empty.
Packet-side human representability uses the byte-minimal speculative projection
for removable rejected or deferred nonmaterial rows, regardless of mapping
authority. It selects the byte-minimal stable material anchor because that
selection leaves the projected grounded-minor set unchanged, while an explicit
result may still claim a properly grounded necessary minor sibling.

For `human-decision-required`, `scopeDelta.materialSurfaces` and the categories
in `materialityTriggers` must be the same order-insensitive set, with exactly
one trigger per category. A dependency, public surface, persistent surface, or
subsystem in the material inventory that lacks either explicit source-required
authority or accepted-shape authorization must use `material-scope-change`
coverage and include, respectively, `new-dependency`, `public-surface`,
`persistent-surface`, or `new-subsystem` in both sets. An inventory entry with
both authorities remains eligible for ordinary necessity assessment.

Return exactly one verdict:

- `within-scope`: every mechanism is supported and no work, delta, evidence, or human decision remains.
- `trim-required`: name each unnecessary mechanism and a smaller sufficient alternative.
- `minor-amendment-required`: describe a necessary minor delta, map it to existing criteria, show that it creates no material surface, and remove any independent speculative nonmaterial work.
- `human-decision-required`: name at least one material trigger and present the smallest expansion, a narrow alternative, and consequences of deferral without authorizing either.
- `insufficient-evidence`: name the missing exact evidence and make no affirmative scope conclusion.

## Applicability and staleness

Validate the packet before assessment and the result before use. Then compare the result's complete binding with the packet byte-for-byte by value. Also verify that every referenced criterion and invariant ID exists in the packet. Any mismatch, missing exact SHA, changed source capture, changed plan or amendment order, changed task packet, or changed subject makes the assessment inapplicable. Fail closed and request a new assessment; never repair identities or mutate the inputs.

## Examples

- A direct local fix mapped to the accepted defect criterion is `within-scope`.
- Adding an unrequested generic repository checker only as a local, bounded,
  unenforced helper with no new subsystem, policy, or repository-wide
  commitment is `trim-required`; remove the checker and retain the direct fix.
- A small adjacent helper and focused test needed to express an existing criterion is `minor-amendment-required` when it adds no material surface.
- Turning that checker into a new subsystem, policy, or repository-wide
  enforcement is `human-decision-required`, with both the smallest expansion
  and the narrow implementation documented; removability does not lower the
  verdict.
- If the exact plan digest, task packet, or applicable Git SHA is unavailable, return `insufficient-evidence`.
