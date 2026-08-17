# Aerstello

Aerstello is a tablet-first, installable hospitality-operations PWA for one venue. Hosts manage rooms, guests, products, open tabs, guest access requests, and bills. Guests receive device-bound access to their tab and can report self-service items.

Aerstello is the software name. The venue name is configured by an administrator and snapshotted onto every bill.

## Quick start

Requirements: Node 24, npm 11, Docker with Compose.

```bash
cp .env.example .env
npm install
npm run db:start:dev
npm run assets:generate
npm run build
npm run db:migrate
printf '%s\n' "$AERSTELLO_ADMIN_PASSWORD" | npm run admin:create -- --email you@example.com --name "Your name" --password-stdin
npm run dev
```

Open `http://localhost:5173`. On first login the administrator is sent to Venue Settings and must enter the venue name before billing is enabled.

For a populated local system instead of creating an administrator manually:

```bash
read -rsp 'Development seed administrator password: ' SEED_ADMIN_PASSWORD
printf '\n'
export SEED_ADMIN_PASSWORD
npm run db:seed -w @aerstello/api
unset SEED_ADMIN_PASSWORD
```

The development seed creates `admin@aerstello.test`, requires an explicit password of at least 12 characters, and refuses to run when `NODE_ENV=production`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start API and PWA development servers |
| `npm run check:shared` | Build and unit-test the shared contracts and utilities |
| `npm run check:api` | Build shared code and run related API type and unit checks |
| `npm run check:web` | Build shared code and run related web type and unit checks |
| `npm run check:workflow` | Check review and repository tooling |
| `npm run test:specialists` | Check Aerstello specialist profiles and routing |
| `npm run test:change-development` | Check durable change planning and recovery tooling |
| `npm run check:full` | Type-check, test, and production-build all workspaces |
| `npm test` | Run unit and component tests |
| `npm run test:e2e:related -- …` | Run selected Gherkin scenarios and browser projects |
| `npm run test:e2e:full` | Run every E2E scenario and browser project (CI gate) |
| `npm run review:status` | Show the active PR review state and next action |
| `npm run change:status` | Show the active change-development phase and exact next action |
| `npm run change:state -- <command>` | Initialize, validate, refresh, decide, amend, recover, or archive durable planning state |
| `npm run lint:commit -- --last` | Validate the latest commit message |
| `npm run db:start:dev` | Start a healthy loopback-only development PostgreSQL service |
| `npm run db:migrate` | Apply pending PostgreSQL migrations |
| `npm run admin:create -- …` | Create or recover the initial administrator |
| `npm run db:migrate:dev -w @aerstello/api` | Apply migrations directly from TypeScript during API development |
| `npm run assets:generate` | Generate required 192px and 512px PWA icons |
| `npm run release:state` | Inspect production marker/tag state as JSON |
| `npm run check:release-state` | Fail on stale or inconsistent release metadata |
| `npm run check:released-migrations` | Enforce immutable released migration blobs |

Before E2E tests, start PostgreSQL with `npm run db:start:dev` and install the
Playwright browsers with `npx playwright install`. Related E2E requires an
explicit scenario selector and defaults to `tablet-chromium`; it never falls
back to the full suite.

```bash
npm run test:e2e:related -- --id settlement-rejects-a-tab-changed-after-confirmation-opened
npm run test:e2e:related -- --tag area-auth --project mobile-webkit
```

## Repository map

- `apps/web`: React/Vite PWA, offline mutation queue, host and guest interfaces.
- `apps/api`: Fastify API, PostgreSQL schema/migrations, security, business transactions, and live events.
- `packages/shared`: validation contracts, permission rules, money and localization helpers.
- `specs/features`: product behavior as executable Gherkin feature specifications.
- `tests/e2e`: Playwright-BDD step definitions.
- `docs`: architecture, operations, and product/test conventions.

Read [AGENTS.md](./AGENTS.md) before making automated changes and [docs/architecture.md](./docs/architecture.md) before changing financial, authentication, or offline behavior.

For durable planning from an issue, direct request, repository plan, or partial
implementation, use the repository `$change-development` skill and its
[canonical operator guide](./.agents/skills/change-development/README.md). It
preserves source evidence and an immutable accepted plan for later execution.

For long-running pull-request review remediation, use the repository
`$pr-review-cycle` skill and follow the concise
[PR review-cycle guide](./.agents/skills/pr-review-cycle/README.md). Local agents run
related checks; CI runs the complete checks and E2E matrix. Production releases
follow the [marker-and-annotated-tag contract](./.release/README.md).
Reusable domain guidance and deterministic risk routing live in the
[Aerstello specialist guide](./.agents/skills/aerstello-specialists/README.md).

## Contributing

Commit messages follow Conventional Commits and are checked in CI. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the allowed types, formatting rules,
scope guidance, and examples.

## Production

Set a unique `SESSION_SECRET` and an `ACCESS_CAPABILITY_KEYS` keyring as described in
[the operations guide](./docs/operations.md); each secret must have at least 32 random
characters. Serve the app through HTTPS. Then:

```bash
docker compose build
docker compose up -d
docker compose exec app npm run db:migrate
printf '%s\n' "$AERSTELLO_ADMIN_PASSWORD" | docker compose exec -T app npm run admin:create -- --email admin@example.com --name "Admin" --password-stdin
```

Back up the PostgreSQL volume before upgrades. See [docs/operations.md](./docs/operations.md) for backup, restore, health checks, and deployment constraints.
