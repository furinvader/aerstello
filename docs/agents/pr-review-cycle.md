# How the PR review cycle works

Sky Bar keeps review work in the repository. One main agent coordinates the
cycle; there is no separate implementation service. Start or resume it with:

```text
Use $pr-review-cycle to continue the current PR remediation session.
```

## The eight steps

1. **Restore the saved state.** The main agent reads the PR's durable state and
   checks Git, GitHub, CI, and release information. It never rebuilds decisions
   from a chat transcript.
2. **Confirm the current commit.** It confirms the explicit PR number, local
   commit, pushed PR head, and release status. A release exists only when a valid
   production marker and matching annotated tag are reachable from `main`.
3. **Ask Codex to review that exact commit.** Only the main agent posts
   `@codex review`. A result counts only when it applies to the recorded Review
   commit, which must still be the current PR head.
4. **Plan the findings.** The main agent groups comments with one root cause and
   creates independent, fixed tasks. Each task names its owned paths, acceptance
   criteria, exact related tests, E2E selectors, browser projects, and reasons.
5. **Run isolated fix workers.** Each worker starts from the Review commit in a
   separate worktree, edits only its assigned paths, runs only its recorded
   validation, and returns one structured result. Workers never push, integrate,
   update central state, delegate, or write to GitHub.
6. **Integrate and test the batch.** The main agent accepts valid worker commits,
   integrates them in dependency order, and runs the union of related checks.
   Browser checks use selected scenarios and normally `tablet-chromium`. The
   read-only verifier then checks the combined result.
7. **Push and run review plus CI.** The main agent pushes the new Review commit,
   posts evidence, closes fixed Codex threads, and confirms none remain open.
   After targeted local checks pass, Codex review and full GitHub Actions may run
   at the same time.
8. **Finish only when every gate matches.** The cycle is Done when Codex is clean,
   full CI including the full E2E matrix is green for the same Review commit,
   every finding has an outcome, and GitHub shows no open Codex threads.

## Glossary

| Term | Meaning |
| --- | --- |
| **Review commit** | The exact pushed commit sent to Codex. |
| **Integrated** | A worker commit is now on the central PR branch. |
| **Resolved** | The fix was verified, evidence was posted, and its Codex thread is closed. |
| **Done** | Codex is clean and full CI, including full E2E, is green for the Review commit, with no open Codex threads. |

The machine state still uses task status `completed` for Resolved and cycle
phase `complete` for Done. These are storage names, not extra workflow stages.

## Review-ready and Done

Review-ready is the handoff from targeted local work to Codex and CI. It means:

- no worker is active and accepted fixes are Integrated;
- the checkout is clean;
- the union of related local checks passed;
- selected E2E scenarios passed when needed;
- relevant release-policy checks passed;
- the branch is pushed and local HEAD equals the PR head; and
- GitHub was queried after prior thread closures and shows none still open.

Review-ready does not require local `check:full` or local full E2E. GitHub
Actions runs `npm run check:full` and `npm run test:e2e:full`. Related browser
tests use explicit stable selectors and default to `tablet-chromium`; add a
project only when responsive, touch, installation, cross-device, or
browser-specific behavior needs it. Unknown related-test selection is a
planning error, never permission to fall back to the full local suite.

When collecting an exact-head canonical `COMMENTED` review submission, treat it
as clean only if its body is a string whose trimmed content is empty and no
canonical root is attached. A nonempty body is findings even without an inline
root, while an attached canonical root is findings even with an empty body.
Missing or non-string bodies are unsupported and fail closed; the workflow does
not interpret prose, badge text, or severity wording. The Done transition
freshly rechecks a recorded clean review against the same live body and root
rules.

For a pristine taskless first review, save and run the explicit initial targeted
validation selection, then use `refresh-threads --pr <number>` to record guarded
exact-head proof that the fully paginated canonical Codex thread set is empty.
This read-only GitHub operation fails closed if any canonical root exists and
does not verify later threadless remediation tasks.

After read-only integration verification, resolve one eligible non-thread task
with `verify-resolve --pr <number> --task <id>`. Eligibility covers an
actionable Integrated `local` or `github-threadless` fix, plus a
`not-applicable` task whose disposition is `duplicate`, `already-fixed`,
`stale`, `invalid`, `policy-conflict`, or `out-of-scope`;
`needs-human-decision` remains ineligible. This state-only command is the
orchestrator's guarded assertion that the selected task passed verifier review
at the exact current HEAD. It rechecks a clean checkout, equal
local/pushed/live heads, task ancestry, state revision, and the fully paginated
canonical root set without writing to GitHub or creating a mutation journal.
It completes only the selected local task, or adds only the selected threadless
ID while retaining prior exact-HEAD proof. GitHub-thread tasks remain on
`reply-resolve`. The verifier assertion is guarded transition input; no
separate persisted verifier-artifact schema is implied. `--task` is always one
opaque task ID for either command and is preserved byte-for-byte; commas,
whitespace, quotes, and backslashes have no separator or escape meaning.

Local assertions are also persisted as `localVerification` task-ID coverage for
the exact current integration HEAD. If HEAD advances, the old proof remains
historical while review and Done stay closed. Rerun targeted validation and the
read-only verifier, then call `verify-resolve --task <id>` separately for each
completed local task. The first successful assertion at the new HEAD starts a
new set containing only that task; later same-HEAD assertions accumulate IDs.
A retry already covered at that HEAD is state-idempotent, but still repeats all
clean-checkout, HEAD, ancestry, canonical-root, and state-revision guards.

If integration HEAD advances after a threadless task was already completed,
repeat current-HEAD targeted validation and read-only verifier approval for
every task in the preserved proof. Then select the complete set atomically with
one explicit JSON string-array option, for example
`verify-resolve --pr <number> --task-set-json '["threadless-a","threadless-b"]'`.
This is the only multi-task encoding: `--task threadless-a,threadless-b` means
one literal task ID containing a comma. JSON decoding preserves whitespace,
quotes, backslashes, and commas in each ID. Order does not matter after
decoding, but IDs must be unique nonempty strings and the selection must exactly
equal the preserved task-ID set. Partial, extra, unknown, ineligible, local, or
not-yet-completed selections are rejected before checkpointing. A singleton
preserved set keeps the ordinary opaque `--task` form, and an already-current
exact-set retry is idempotent. The successful transition refreshes only that
complete threadless proof at the current HEAD without fabricating an aggregate
thread proof or discarding recorded thread rows. Additional uniquely mapped
live roots remain for `reply-resolve`. When one such root already has the exact
reply and resolution from a prior integration HEAD, `reply-resolve` may recover
it only after the refresh, from that sole immutable reply plus the correlated
durable reply and resolve intent lookups and proven prior-HEAD ancestry. It does
not repeat either GitHub mutation. Extra replies or markers and any resolution,
live-HEAD, or state-revision drift are rejected.

A schema-v2 migration may preserve a taskless pending review for the exact
integration HEAD while deliberately clearing legacy targeted-validation proof.
After that preserved review is collected as clean, `validation-plan
--initial-selection <file>` may rebuild the explicit nonempty selection without
requesting the review again. This exception requires no tasks and exact matching
current request, outcome, latest history entry, kind, and requested/reviewed
SHAs. It rejects pending, finding, stale, dirty, or inconsistent states and does
not infer checks from a missing legacy plan or replace an existing passing proof
after an ordinary taskless review.

A separate native schema-v5 route recovers a taskless clean discovery review
after the integration HEAD advances. The clean request, outcome, requested, and
reviewed SHAs must still agree on one prior commit different from the current
HEAD, and the latest history entry must exactly equal the active evidence. The
state must be `recovering`, have no tasks, blockers, escalation, or human
decision, retain another discovery or verification request allowance, and have
a clean exact current checkout. Use a nonempty current-HEAD
`validation-plan --initial-selection` selection (`--replace` may replace only
the stale plan sidecar), then run it normally. The old review ledger is preserved
byte-for-byte and remains historical.

After that fresh targeted proof passes, run `refresh-threads --pr <number>`.
The read-only command requires equal clean local, pushed, and live current
heads, fully paginates the canonical root set, rechecks state revision and live
HEAD, and succeeds only when no canonical root exists. It records an aggregate
passed empty-thread proof for the current HEAD while retaining historical
threadless evidence, with no GitHub or journal mutation. A new exact-current-
HEAD review is still required; the historical clean result cannot satisfy Done.

There is one further migration-only `--initial-selection` route for completed
tasks. Its immutable `state.v2.backup.json` must contain a nonempty all-completed
task set and an exact-head passed, nonempty legacy targeted proof. A schema-v2
`ready-for-review` or `complete` source is eligible only when canonical migration
reproduces the active `recovering` state exactly. A schema-v2 `awaiting-review`
source may preserve its exact pending request; after one guarded clean exact-head
outcome is collected, canonical migration plus exactly that outcome transition
must reproduce the active `validating` state, normalizing only checkpoint
revision and timestamp metadata. The active state must have targeted validation
`not-run`, a clean exact current integration HEAD, zero actionable Integrated
tasks, and no blocked reason, verification escalation, or
`needs-human-decision` disposition. Repository, PR, HEAD, task, request, review
history, outcome, and thread identities must match the backup projection. The
backup authorizes a fresh explicit plan only: run all selected checks again and
record new exact-head validation; never reuse the legacy pass or repeat the
preserved review. Native schema-v5 states and missing, mismatched, tampered, or
multi-transition provenance are rejected.

Done is stricter. A clean Codex review, full green CI, full E2E, the current PR
head, the no-open-thread check, and passed exact-current-HEAD coverage for every
completed local task must all refer to the same Review commit. Review requests
use that same local-proof gate.

Native active state uses schema v5. The explicit `migrate` command accepts v1
through v4 and finishes at v5; it never runs during `show` or `recover`. A v4
migration first preserves the exact source bytes as `state.v4.backup.json`, and
an existing backup must be byte-identical before any state, pointer, backup, or
journal mutation may proceed.

The automatic ledger ends after three discovery reviews and one verification
review. If that verification ends in findings, an operator may explicitly
authorize one human-only final review by naming an existing durable decision:

```bash
node scripts/pr-review-state.mjs authorize-final-review --decision-id decision-123 --not-before 2026-08-10T13:00:00Z --summary "One final review" --expected-revision 9
node scripts/pr-review-github.mjs request --pr 123 --kind human-final
```

Schema v5 stores this authorization once, bound to the exact verification
findings outcome. It preserves the 3+1 counters and entries, and the GitHub
helper enforces the trusted time before journaling, after fresh reads, and on
the request's GitHub timestamp. The human-final request becomes the fifth and
last ledger entry. A clean result proceeds through the same exact-head local,
thread, CI, full-E2E, and Done gates. Findings, staleness, unsupported evidence,
or ambiguity return terminally to human decision and cannot authorize another
request.

If the human-final outcome is findings and the operator explicitly authorizes
remediation-only work, record a separate existing durable decision:

```bash
node scripts/pr-review-state.mjs authorize-post-final-remediation --decision-id decision-456 --summary "Remediate the final findings without another review" --expected-revision 12
```

The immutable schema-v5 authorization binds trusted process time and the exact
fifth human-final findings outcome. It does not reset either counter, append a
review entry, or enable a GitHub request. While the state remains
`awaiting-human-decision`, only the exact nonempty set of actionable Integrated
task packets may supply a fresh targeted-validation plan; active or failed
tasks, blockers, human-decision tasks, stale proof, initial-selection mode,
dirty or wrong HEADs, and packet mismatches fail closed. Passing or failing
validation remains terminal and never instructs another review. Fresh
validation, verifier, thread, and CI evidence may make the tasks Resolved, but
Done remains impossible without applicable clean exact-head Codex evidence;
there is no second human-final request.

## Read the current status

Run:

```bash
npm run review:status
```

The output translates machine state into plain English. For example:

```text
PR: #24
Current commit: abc1234 (matches PR head)
Phase: Fixing
Codex review: Findings need resolution
Tasks: 0 Resolved, 2 pending
  - billing-settlement: Integrated — Reject a changed tab
  - stale-session: worker running — Refresh an expired session
Targeted local tests: Passed (npm run check:api)
Full CI: Not Run
Open Codex threads: 2
Next action: Integrate the remaining result and run the selected tests.
```

## Setup

1. Enable Codex cloud and Code review for the GitHub repository.
2. Authenticate the GitHub connector or `gh`.
3. Open `/hooks` and trust the repository hooks; changed hooks require review
   again.
4. Protect `vMAJOR.MINOR.PATCH` tags from updates and deletion, and keep full
   history and tags available locally.

## Troubleshooting pointers

- **Status cannot be restored:** run
  `node scripts/pr-review-state.mjs recover`. Use the saved backup, Git,
  structured GitHub data, and CI artifacts—not transcripts. Old state requires
  an explicit migration.
- **Review is stale:** compare the review commit, recorded Review commit, and
  current PR head. Request a new review only after the current commit is
  review-ready.
- **A thread still appears open:** query GitHub again after the close operation.
  A successful mutation response is not confirmation.
- **Related tests are unknown:** return to task planning and record exact
  commands, selectors, projects, and reasons. Do not run full local E2E as a
  fallback.
- **CI failed:** inspect the exact-commit workflow and its artifacts. Run full
  E2E locally only when explicitly requested or when diagnosing that failure.
- **Release state is inconsistent:** run `npm run release:state`,
  `npm run check:release-state`, and `npm run check:released-migrations`. Fetch
  missing refs or tags; do not assume the project is pre-release.
- **Review rounds repeat:** investigate a finding that returns twice. After
  three discovery reviews, only one exact-commit verification review is allowed;
  new or stale verification evidence needs a human decision. A human-final
  request exists only through the explicit one-shot, time-gated authorization
  above and is never retried automatically.

Machine contracts and command details live in the
[PR review state schema](./pr-review-state.schema.json),
[task schema](./review-fix-task.schema.json), and
[worker result schema](./review-fix-result.schema.json). The skill's phase
references cover [durable state](../../.agents/skills/pr-review-cycle/references/state-and-contracts.md),
[integration and validation](../../.agents/skills/pr-review-cycle/references/orchestration.md),
and [GitHub review and CI](../../.agents/skills/pr-review-cycle/references/github-review.md).
