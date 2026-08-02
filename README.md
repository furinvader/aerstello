# Sky Bar

Sky Bar is a tablet-first, installable bar-operations PWA for one venue. Hosts manage rooms, guests, products, open tabs, guest access requests, and bills. Guests receive device-bound access to their tab and can report self-service items.

Sky Bar is the software name. The venue name is configured by an administrator and snapshotted onto every bill.

## Quick start

Requirements: Node 24, npm 11, Docker with Compose.

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run assets:generate
npm run build
npm run db:migrate
npm run admin:create -- --email you@example.com --password "a-secure-12+-character-password" --name "Your name"
npm run dev
```

Open `http://localhost:5173`. On first login the administrator is sent to Venue Settings and must enter the venue name before billing is enabled.

For a populated local system instead of creating an administrator manually:

```bash
npm run db:seed -w @sky-bar/api
```

The development seed is `admin@skybar.test` / `SkyBarTest123!` and must never be used in production.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start API and PWA development servers |
| `npm run check` | Type-check, test, and production-build all workspaces |
| `npm test` | Run unit and component tests |
| `npm run test:e2e` | Generate and run executable Gherkin E2E tests |
| `npm run lint:commit -- --last` | Validate the latest commit message |
| `npm run db:migrate` | Apply pending PostgreSQL migrations |
| `npm run admin:create -- …` | Create or recover the initial administrator |
| `npm run db:migrate:dev -w @sky-bar/api` | Apply migrations directly from TypeScript during API development |
| `npm run assets:generate` | Generate required 192px and 512px PWA icons |

Before E2E tests, start PostgreSQL with `docker compose up -d db` and install the Playwright browsers with `npx playwright install`.

## Repository map

- `apps/web`: React/Vite PWA, offline mutation queue, host and guest interfaces.
- `apps/api`: Fastify API, PostgreSQL schema/migrations, security, business transactions, and live events.
- `packages/shared`: validation contracts, permission rules, money and localization helpers.
- `specs/features`: product behavior as executable Gherkin feature specifications.
- `tests/e2e`: Playwright-BDD step definitions.
- `docs`: architecture, operations, and product/test conventions.

Read [AGENTS.md](./AGENTS.md) before making automated changes and [docs/architecture.md](./docs/architecture.md) before changing financial, authentication, or offline behavior.

## Contributing

Commit messages follow Conventional Commits and are checked in CI. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the allowed types, formatting rules,
scope guidance, and examples.

## Production

Set a unique `SESSION_SECRET` of at least 32 random characters and serve the app through HTTPS. Then:

```bash
docker compose build
docker compose up -d
docker compose exec app npm run db:migrate
docker compose exec app npm run admin:create -- --email admin@example.com --password "…" --name "…"
```

Back up the PostgreSQL volume before upgrades. See [docs/operations.md](./docs/operations.md) for backup, restore, health checks, and deployment constraints.
