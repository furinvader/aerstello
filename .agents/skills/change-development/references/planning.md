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

Anticipated paths and validation intent are non-executable planning data. Exact binding ownership and commands belong to the later implementation workflow.

## Validation and specialist evidence

Validate both JSON Schema and semantic contracts. Load the canonical specialist registry and use its validation, routing, and planning-evidence helpers. Recompute every task route with explicit `browserVisible` and `relatedTestSelectionUncertain` signals; stored routes are never trusted without recomputation.

Reject a plan with unresolved test selection, duplicate IDs, invalid criterion or decision references, missing criterion ownership, unknown dependencies, dependency cycles, consumer work ordered before its producer, overlapping planned ownership, or cross-domain work marked unsplittable without a reason. Require clean current Planning-SHA `behavior_mapper` evidence whenever the final route requires it.

Acceptance requires every readiness gate to pass and writes immutable canonical JSON plus its SHA-256 receipt. Record each later decision independently. An amendment must include authorization, provenance and delta, the previous plan digest, current repository SHA, invalidated evidence, the new digest, and the complete resulting normalized plan. Never rewrite the original plan or prior amendments.
