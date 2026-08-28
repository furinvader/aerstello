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
Admission also requires the receipt-authoritative minimal-closure digest and a
current applicable `within-scope` assessment for the exact integrated HEAD,
effective plan, ordered amendment receipts, ordered operator-decision receipt
digests, and terminal task-set digest. Historical zero-decision evidence may
omit the optional decision sequence. The
verifier reviews that supplied proof; it never reruns canonical scope analysis
or substitutes a live assessment.
One canonical composer defines the semantic item identities, kinds, digests,
summaries, ordering, UTF-8 chunking, 500-item limit, and 256-KiB full-context
limit used by both admission and final context construction. It accepts
receipt-valid durable artifacts and explicit pending overlays. Placeholders are
allowed only for evidence made inevitable by current accepted authority; no
path truncates, groups, drops, or invents arbitrary future prose. Plan
acceptance, amendment, packet binding, implementation-result acceptance,
validation-plan creation, validation-result recording, specialist-plan
creation, specialist-result recording, verifier-result recording, finding
disposition, and repeated-finding authorization all run the composer before
any sidecar, receipt, transition, event, or state mutation.

Release or migration applicability reserves one release item before capture;
validation-plan admission substitutes the exact protected `origin/main`
release evidence without changing that semantic slot. Known validation
results, routed specialist summaries, mapper records, historical findings and
dispositions, and human authorizations use the same projection as the final
context. A finding is admitted only with its full source-qualified identity,
summary, evidence, inevitable disposition authority, and any required repeated
authorization reservation. Exact dispositions and authorizations are checked
again before persistence. The disposition reservation is a schema-minimal
exact authority object including source, finding, fingerprint, reason, and
remediation IDs. An actionable exact disposition must also fit one viable
follow-on amendment, provenance record, replacement criterion, and replacement
task, including the potential behavior-mapper row for that task's eventual
route; the guarded exact amendment replaces that reservation. Authorization
reason and authorizer are limited to 1024 and 256 UTF-8 bytes, and the
reservation uses the worst JSON-escaped representation so it remains finite
and conservative for control characters and multibyte input.

Finding-result admission projects the exact current identity, summary,
evidence, one inevitable disposition slot, and authorization only for an
actually applicable repeat. It does not guess the later disposition choice,
amendment, or reset round; each exact disposition, authorization, amendment,
and last-disposition transition is separately preflighted before persistence.
Material source refresh uses the exact new source identity and full checklist
mappings before its observation receipt, rejects captured or legacy identity
text above the implementation-plan 4000-code-point bound, and lets `resolve`
substitute and recheck exact decision authority.

Before an execution result can become terminal, the projection reserves a
64-character integration commit plus the maximum deterministic transition
revision. Before a validation intent is written, it reserves the exact maximum
command-result summary shape (status, exit, and output digest). Pre-capture
release projection reserves the complete protected-ref summary shape (status,
base/ref SHAs, latest tag, and frozen migration count). Exact later records
replace these same semantic slots rather than append underestimated evidence.

Plan, packet, worker-result, and specialist-plan projections include their
known route summaries but no synthetic findings. The first exact specialist
result activates equal dynamic shares of the remaining 100 source-role-
qualified fingerprints across still-unrecorded reviewers. Each share includes
schema-minimal identity, summary, evidence, disposition, and authorization only
for actually applicable repeats. Later-round applicability skips missing
same-role rounds and stops at an intervening clean same-role receipt; current-
round findings alone occupy the aggregate after an amendment reset. For two
reviewers this admits compact 50 then 50, rejects a 51-finding first result
without mutation, and lets a clean first reviewer leave 100 slots to the final
reviewer. Every routed reviewer still records in canonical order before
disposition becomes available. Capacity rejection is retryable and changes no
durable byte.

The last non-actionable disposition separately projects the reset next round,
including every historical finding/disposition and the complete routed
reviewer allocation inventory, before it may transition back to `integrated`.
An unfit next round leaves that disposition and all durable state unchanged.

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

Separate PR preparation may transform the exact current scope receipts with
[`buildDevelopmentScopeHandoff`](../scripts/handoff/contracts.mjs). That pure,
bounded projection requires the receipt-valid canonical terminal task set and
recomputes its digest plus the exact HEAD/task-set subject digest. The resulting
projection is compatible input authority, not evidence that targeted
validation, official review, CI, E2E, threads, delivery, or merge gates passed.
