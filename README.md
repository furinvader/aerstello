# Aerstello

Aerstello is a tablet-first, installable hospitality-operations PWA for one venue. Hosts manage rooms, guests, products, open tabs, guest access requests, and bills. Guests receive device-bound access to their tab and can report self-service items.

Aerstello is the software name. The venue name is configured by an administrator and snapshotted onto every bill.

## Quick start

Requirements: Node 24, npm 11, Docker with Compose. The repository's
`docker-compose.yml` is development tooling; it publishes the API directly and
is not the HTTPS demo stack.

```bash
cp .env.example .env
docker compose up -d db
npm install
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
| `npm run check:full` | Type-check, test, and production-build all workspaces |
| `npm test` | Run unit and component tests |
| `npm run test:e2e:related -- …` | Run selected Gherkin scenarios and browser projects |
| `npm run test:e2e:full` | Run every E2E scenario and browser project (CI gate) |
| `npm run review:status` | Show the active PR review state and next action |
| `npm run lint:commit -- --last` | Validate the latest commit message |
| `npm run db:migrate` | Apply pending PostgreSQL migrations |
| `npm run admin:create -- …` | Create or recover the initial administrator |
| `npm run db:migrate:dev -w @aerstello/api` | Apply migrations directly from TypeScript during API development |
| `just demo-deploy -- …` | Run the guarded, single-host HTTPS demo deployment (optional Just runner) |
| `npm run assets:generate` | Generate required 192px and 512px PWA icons |
| `npm run release:state` | Inspect production marker/tag state as JSON |
| `npm run check:release-state` | Fail on stale or inconsistent release metadata |
| `npm run check:released-migrations` | Enforce immutable released migration blobs |

Before E2E tests, start PostgreSQL with `docker compose up -d db` and install the
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

For long-running pull-request review remediation, use the repository
`$pr-review-cycle` skill and follow the concise
[PR review-cycle guide](./docs/agents/pr-review-cycle.md). Local agents run
related checks; CI runs the complete checks and E2E matrix. Production releases
follow the [marker-and-annotated-tag contract](./.release/README.md).

## Contributing

Commit messages follow Conventional Commits and are checked in CI. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the allowed types, formatting rules,
scope guidance, and examples.

## Demo deployment

For a repeatable, single-host demo behind automatic HTTPS, use the guarded
deployment command and the dedicated `compose.demo.yml` stack. It keeps
PostgreSQL private and publishes only Caddy on ports 80 and 443.

Prepare the host with Docker Engine and the Docker Compose plugin from the
official repository for its Linux distribution. Docker socket access is
effectively root access, so grant it only to a trusted deploying account. See
the demo deployment runbook for the complete host prerequisites.

```bash
scripts/demo-deploy.sh --init-env --env-file .env.demo
# Edit the domain, ACME email, and administrator identity before continuing.
scripts/demo-deploy.sh --env-file .env.demo --check
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist
```

The deploy command can generate a secure starting configuration with
`--init-env`; see the [demo deployment runbook](./docs/demo-deployment.md) for
DNS and firewall preparation, password handling, database adoption and rewrite
recovery. The host-local safety dumps it creates are not off-host disaster
recovery backups.

For production configuration, secret rotation, health checks, backup policy,
and release constraints, see the [operations guide](./docs/operations.md).
