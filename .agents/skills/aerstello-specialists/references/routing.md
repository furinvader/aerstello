# Deterministic routing

Validate specialization metadata before binding it into any workflow contract. Supply both boolean signals explicitly; omission is a planning error.

`behavior_mapper` is required when the work is browser-visible, the profile is `behavior-tests`, risk includes `localization` or `responsive`, or test selection is uncertain. It advises on exact scenarios, steps, selectors, commands, and projects before the caller binds them.

`security_reviewer` is required for `authentication` or `authorization`. `offline_realtime_reviewer` is required for `offline` or `realtime`. Both review the current integrated HEAD. `billing`, `money`, `migration`, or `release` adds supplemental `data-integrity` guidance and sets `finalVerificationPriority` to `high`; otherwise it is `standard`. `deployment` or `workflow` adds supplemental `ops-workflow` guidance without changing priority. Supplemental guidance is omitted when it is already the primary profile.

Router order follows registry reviewer order, not input risk order. It deduplicates planning helpers, risk reviewers, supplemental profiles, and reasons. It returns no final-verifier ID and never names or invokes a workflow role. It also returns no paths, commands, selectors, projects, criteria, or validation entries. Callers must reject any use of profile guidance to expand an already-bound plan.

If specialist findings require edits, convert them into ordinary owned tasks. When integrated HEAD changes, discard stale integrated-HEAD evidence and rerun the required risk-review set before the calling workflow performs final verification.
