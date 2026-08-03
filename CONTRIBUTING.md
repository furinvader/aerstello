# Contributing to Sky Bar

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
