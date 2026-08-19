# Integrated-HEAD verification

Change-development final verification is local, receipt-bound evidence review of
one clean integrated HEAD. It does not grant push, pull-request, CI, GitHub, or
merge authority. The workflow-owned `development_integration_verifier` is
distinct from both the reusable specialist reviewers and the PR-review
`integration_verifier`.

## Admission

Invoke the verifier only after the lifecycle has generated a context conforming
to
[`development-verifier-context.schema.json`](../schemas/development-verifier-context.schema.json)
in the `verifying` phase. The context must name
`development_integration_verifier`, bind the current verification round and
input identity, and match the exact clean checkout HEAD. Targeted validation
must have passed, every reviewer selected by each immutable stored specialist
route must have supplied exact-HEAD evidence in canonical order, and no
specialist finding may remain unresolved. Missing, malformed, oversized,
incomplete, dirty, or stale input is not verifier-ready and must fail closed.
Plan acceptance, amendment, and packet binding conservatively enforce these
500-item and 256-KiB limits before consuming later implementation authority.

The caller supplies the generated context and its canonical SHA-256 digest. The
verifier repeats that exact digest as `contextDigest`; it never substitutes the
context's semantic `inputIdentityDigest`. Recording the result rechecks the
current clean HEAD, lifecycle phase, context digest, and closed result schema.

## Evidence review

The context is intentionally concise and excludes command output, raw logs,
full diffs, and transcripts. It retains the complete review semantics or fails
closed before invocation when the closed context limits cannot hold them. The
verifier assesses:

- original accepted and effective objective, scope, non-goals, specialization,
  profile, scenarios, decisions, criteria, and checklist mappings;
- every append-only amendment and its receipt-bound provenance;
- each immutable task packet's plan identity, binding, dependencies, ownership,
  forbidden paths, validation authority, planning signals, stored specialist
  route, and planning-helper evidence;
- each worker result, changed-path authority verdict, unexpected dependency,
  provenance receipt, terminal identity, integrated commit, and integration
  transition order;
- the immutable validation plan and every append-only command result at the
  exact HEAD;
- reusable specialist guidance and results under the
  [reviewer contracts](../../aerstello-specialists/references/reviewer-contracts.md),
  without live rerouting or treating a clean specialist result as workflow
  completion authority;
- complete source-qualified finding substance, dispositions, repeated-finding
  human authorizations, release baseline, protected release ref, latest release,
  and frozen-migration count when applicable.

Any missing authority, stale identity, conflicting evidence, scope or profile
misuse, ownership breach, dependency or integration-order error, insufficient
validation, unresolved finding, or release/migration inconsistency is a
finding. A changed HEAD invalidates the round without deleting its history and
requires new exact-HEAD validation and review evidence.

## Result and authority boundary

The verifier remains read-only and non-delegating. It never invokes reusable
specialists, edits files or lifecycle state, creates commits, integrates work,
pushes, requests review, or writes to GitHub. It returns only one raw JSON object
conforming to
[`development-verification-result.schema.json`](../schemas/development-verification-result.schema.json):
the exact `headSha`, exact `contextDigest`, `clean` or `findings` status, a
concise summary, stable source-qualified findings, and `recordedAt` timestamp.
A clean result becomes Development-ready only after the lifecycle independently
revalidates all exact-HEAD gates. That finalization captures the live source
outside the lock and rechecks revision plus exact HEAD under lock. Capture
errors or races do not mutate state; progress drift starts a fresh integrated
round and material drift follows the decision/amendment route. Delivery remains
a separate workflow.
