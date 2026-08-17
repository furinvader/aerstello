## Stable checklist mapping

Support hidden stable markers such as:

```markdown
- [ ] <!-- aerstello:item=change-development --> Add the change-development workflow
```

## Acceptance criteria

- [ ] `.agents/skills/change-development/` exists as the canonical planning/state capability.
- [ ] Issue, request, local-plan, and recovery inputs are supported by explicit contracts.
- [ ] An accepted plan has immutable content and a verified receipt.
- [ ] Scope, non-goals, criteria, decisions, profiles, risks, task graph, and issue mappings are machine-validated.
- [ ] Cyclic, unknown, contradictory, or ambiguous plans fail closed.
- [ ] Source issue body and new-comment drift is detected without silently altering the plan.
- [ ] Checklist mappings use stable IDs where available and report ambiguity otherwise.
- [ ] Plan amendments are append-only and receipt-protected.
- [ ] State lives under the Git common directory and is shared across linked worktrees.
- [ ] Locks, revision guards, event history, recovery, archive, and abandonment behavior are tested.
- [ ] Human status output gives the exact next action.
- [ ] No GitHub issue mutation or implementation execution is introduced prematurely.
- [ ] Ownership manifests and structure tests keep the capability co-located.
