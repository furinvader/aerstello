---
name: issue-scope-planning
description: Review an exact Aerstello implementation issue against repository evidence, decide whether it should remain one delivery, be trimmed, or become a tracking umbrella with bounded child issues, and produce a concrete technical plan. Use before change-development when issue scope or delivery boundaries are uncertain. Do not use it to implement work or mutate GitHub.
---

# Issue Scope Planning

Turn an ambiguous or broad implementation issue into the smallest coherent,
reviewable delivery contract. This is a read-only planning capability: it
recommends issue wording and boundaries but does not authorize scope changes.

## Establish exact evidence

1. Capture the issue title, body, state, complete comments, identifier,
   `updatedAt`, and a digest of that exact source. Record the exact repository
   SHA being inspected. Fail closed when the source is incomplete or drifts
   while planning.
2. For every dependency or related issue used as evidence or in a delivery
   recommendation, capture its identifier, title, body, state, complete
   comments, `updatedAt`, and an exact-source digest. Revalidate that revision
   before the recommendation and handoff. Also inspect the relevant feature
   specifications, architecture rules, shared contracts, and current code
   seams. Use `$aerstello-specialists` to select the repository guidance and
   risk signals that apply to the proposed work.
3. Inventory each requirement, explicit non-goal, material implementation
   surface, workstream, dependency, activation or cutover point, and validation
   obligation. Distinguish current repository facts from proposals and
   unresolved decisions.

## Choose the delivery shape

Choose exactly one recommendation:

- **Keep one resolving issue** when one coherent change can satisfy the
  requirements, activate safely, and be validated independently.
- **Trim or clarify the issue** when optional, speculative, duplicated, or
  premature work can be removed without losing the objective.
- **Create a tracking umbrella with ordered resolving children** when semantic
  workstreams have independent ownership, dependencies, activation, or useful
  validation boundaries.
- **Request a human decision** when evidence is insufficient or a product,
  policy, ownership, or sequencing choice materially changes the contract.

Never split by line count, file count, estimated effort, or a fixed number of
children. A proposal can be within the authoritative scope and still require
multiple deliveries. Do not derive the delivery shape mechanically from a
`$scope-review` verdict.

## Draft decision-complete issue contracts

For one resolving issue, provide:

- objective and exact requirement ownership;
- dependencies and prerequisites, or an explicit statement that current
  repository state is sufficient;
- owned implementation surfaces and explicit exclusions;
- ordered technical actions tied to observed repository seams;
- stable, externally meaningful acceptance markers;
- validation allocated to the behavior or contract it proves; and
- a planning gate that requires rebinding the accepted source and current
  repository state before implementation.

For a split, make the parent tracking-only and reference-only. Draft each child
as one resolving source for one PR, with status, objective, owned requirements
and surfaces, out-of-scope work, dependencies, ordered technical actions,
acceptance markers, validation, and its planning gate. Include the dependency
DAG and landing order. Do not guess interfaces that an earlier child has not
landed. Assign activation or cutover to exactly one child, and schedule cleanup
only after its replacement is proven.

In either form, include an evidence header with source identity and repository
SHA, the delivery-shape finding and rationale, a complete requirement-to-issue
ownership map, and every unresolved decision. No requirement may be silently
dropped or owned by both a tracking parent and a resolving child.

## Check and hand off

Run `$scope-review` at each material draft commitment boundary for the exact
retained issue or, for a split, the exact rewritten tracking-parent draft and
each exact child draft. Preserve its evidence and verdict without using it to
authorize additions or removals; a human accepts material scope and
issue-boundary changes.

After acceptance, hand each resolving issue source separately to
`$change-development`. Never hand off the tracking umbrella. Rebind the exact
accepted source, current protected base, and landed dependencies at that
boundary.

Stop before editing repository files, accepting an implementation plan,
implementing code, creating or editing GitHub content, or taking any other
external mutation. Report drift, incomplete evidence, and unresolved material
decisions instead of expanding the work.
