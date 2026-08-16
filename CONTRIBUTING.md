# Contributing to Aerstello

## Commit messages

We follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

Use this format:

```text
<type>[optional scope][!]: <description>
```

Allowed types are:

- `feat`
- `fix`
- `refactor`
- `perf`
- `docs`
- `test`
- `build`
- `ci`
- `style`
- `chore`
- `revert`

Follow these rules:

- Each commit represents one logical change.
- Use an imperative description.
- Keep the header at or below 72 characters.
- Do not end the description with a period.
- Use a stable subsystem or package name as the optional scope.
- Explain motivation and consequences in the body when they are not obvious.
- Use Git trailers for issue references and other metadata.
- Mark breaking changes with `!` and explain them using `BREAKING CHANGE:`.

Pull requests are squash-merged using the pull request title as the commit
header and the pull request body as the commit body. The pull request title must
therefore also follow this Conventional Commit format. Leave room for GitHub's
appended ` (#<number>)` so the resulting header remains at or below 72
characters. For a breaking change, include `!` in the title and a
`BREAKING CHANGE:` footer in the pull request body.

Stable scopes include `web`, `api`, `shared`, `db`, `pwa`, `e2e`, `docs`, and
`ci`. This list is illustrative rather than exhaustive; prefer an existing
scope when it accurately describes the change.

Examples:

```text
feat(web): add room filtering to guest selection
fix(api): reject settlement during the guest undo window
docs: explain the production backup procedure
```

A breaking change uses both markers and explains the consequence in the
footer:

```text
feat(api)!: replace the guest access response

The new response keeps device grant details under an access object.

BREAKING CHANGE: API clients must read the grant from access.grant
Refs: #123
```

Commit messages are checked in CI. To validate a commit locally, run:

```bash
npm run lint:commit -- --last --verbose
```

Long-running pull-request remediation uses the repository-local Codex workflow
documented in the [canonical PR review-cycle guide](./.agents/skills/pr-review-cycle/README.md).
The main orchestrator owns GitHub review requests and integration; fix workers
operate only from fixed, path-limited task instructions in isolated worktrees.
Workers run only the validation written in those instructions. After integration,
the orchestrator runs the union of related checks, normally using
`tablet-chromium` for selected browser scenarios. GitHub Actions owns
`npm run check:full` and `npm run test:e2e:full`.

A PR review cycle is Done only when a clean Codex review and green full CI,
including full E2E, apply to the same Review commit and GitHub shows no open
Codex review threads. Codex review and CI may run together after targeted local
validation and push.
