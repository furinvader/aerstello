# Planning contract

## Source identity and observations

Initialize from exactly one source:

- a GitHub repository identity and issue number;
- a UTF-8 direct-request file;
- a tracked repository-plan path read from the Planning SHA; or
- committed partial implementation compared with an explicit base.

Network reads happen before acquiring a state lock. Prefer already normalized connector data; the standalone CLI may use its injectable, read-only `gh api graphql` adapter. Issue observations retain normalized repository/issue identity, title, body, state, author, timestamps, every paginated comment identity and body digest, and an aggregate digest. No command in this capability writes to GitHub.

A connector-provided comment array must prove completeness with `commentsComplete: true` or an exact `commentsTotalCount`. A final connection may instead prove completion with `pageInfo.hasNextPage: false` or an exact `totalCount`. Missing or contradictory completeness evidence fails closed.

The initial observation is immutable. Each refresh writes another observation and compares it with the accepted baseline. A refresh is:

- **unchanged** when normalized source identity and content are identical;
- **progress-only** when only recognized task completion changes; or
- **unreviewed/material drift** when body, comment, or checklist identity/content changed in a way that can affect intent.

After acceptance, material drift moves state to `awaiting-decision`; it never edits `plan.json`.
Before acceptance, all choices belong in the candidate plan's normalized
`decisions`, including their authoritative resolutions. `record-decision` is
reserved for accepted-plan source drift and cannot create planning-phase
sidecars. If receipt-valid legacy pre-accept decision evidence exists,
acceptance stops for explicit reconciliation rather than inferring a plan
resolution from its prose.

## Checklist identities

Markdown task lists exclude fenced code, indented code, and quoted examples. A stable marker has the form `aerstello:item=<lowercase-hyphen-id>` and must occur exactly once. Duplicate or malformed markers are invalid.

Unmarked legacy items bind to their exact normalized text and structural position. If legacy items are duplicated, reordered, removed, or textually changed, classify their identity as ambiguous. Do not guess a mapping. Checklist mappings bind each source identity to its `criterionIds` and `taskIds`. Decisions, scenarios, and the product-scenario disposition remain separate plan records; tasks reference their applicable decision and scenario IDs.

## Plan contents

An implementation-plan v1 records:

- source type, identity, and digest;
- objective, scope, and non-goals;
- Planning SHA and base branches;
- stable criterion, decision, and scenario IDs;
- explicit no-product-scenario disposition where appropriate;
- validated global specialist metadata;
- checklist mappings; and
- a planned dependency DAG with anticipated paths, ownership, validation intent, and specialist-routing signals.

Anticipated paths and validation intent are non-executable planning data. Implementation-plan v1 represents anticipated paths as unambiguous, whitespace-free repository-relative ownership prefixes; it does not accept whitespace-bearing path strings, environment assignments, or shell syntax that could instead be executable input. `bind-task` converts one dependency-ready planned task into a narrower immutable packet with exact allowed and forbidden paths and direct validation commands; it cannot expand the accepted plan.

Repository-relative ownership excludes any root or nested exact `.git` path
segment because Git metadata is never an implementation surface. `.gitignore`,
`.github/workflows`, and nested `.gitkeep` names are not `.git` segments and
remain valid. Candidate validation, readiness, acceptance, and amendments apply
this rule before durable evidence changes. Existing receipt-valid accepted
plans remain immutable historical evidence; replace unsafe historical
ownership through an explicit append-only amendment before binding a packet.

## Validation and specialist evidence

Validate both JSON Schema and semantic contracts. Load the canonical specialist registry anew for each candidate-plan acceptance and amendment validation, and use its validation, routing, and planning-evidence helpers. Recompute every task route with explicit `browserVisible` and `relatedTestSelectionUncertain` signals; stored routes are never trusted for new acceptance. Receipt-valid historical accepted plans and amendments remain immutable replay evidence and are not reinterpreted through a later registry revision.

Reject a plan with unresolved test selection, duplicate IDs, invalid criterion or decision references, missing criterion ownership, unknown dependencies, dependency cycles, consumer work ordered before its producer, overlapping planned ownership, or cross-domain work marked unsplittable without a reason. Require clean current Planning-SHA `behavior_mapper` evidence whenever the final route requires it.

Acceptance requires every readiness gate to pass and writes immutable canonical JSON plus its SHA-256 receipt. Record each later accepted-source-drift decision independently. An amendment must include authorization, provenance and delta, the previous plan digest, current repository SHA, invalidated evidence, the new digest, and the complete resulting normalized plan. Never rewrite the original plan or prior amendments.

After execution starts, an amendment retains the original Planning SHA. It may
record a later clean central integration HEAD only through the explicit replan
path: active work is rejected first, its worktree is safely removed, every
stale packet/result/provenance path is named in `invalidatedEvidence`, and the
replacement uses a new task ID. Already `integrated` or `no-change` task
definitions and their referenced criteria and decisions are immutable. New
packets bind the amended plan to the then-current central task base.

When verification is active, an amendment must be finding-driven: its trigger
is the exact stable fingerprint of an actionable source-role-qualified finding,
and its disposition names the amendment plus new replacement criterion and task
IDs. The resulting plan preserves every terminal task definition and the
completed specialization, adds each disposition-bound ordinary remediation
criterion/task, and covers every remaining actionable sibling finding in the
same guarded amendment. It may overlap a terminal task's paths only for that
exact remediation; overlap among new or active tasks remains invalid. A
repeated semantic finding requires receipt-protected human authorization before
disposition. The amendment resets current verification applicability, not its
append-only history; after remediation integration a new exact-HEAD validation
and review round is required.

For `implement` and `full`, acceptance also initializes bounded execution
summaries from the effective plan. Existing v1 records remain historically
valid, but execution writes require the explicit receipt-protected
`upgrade-state` transition described in [implementation](implementation.md).
