# Operations

## Configuration

Production requires `DATABASE_URL`, an explicitly configured nondefault `SESSION_SECRET`, an explicit `ACCESS_CAPABILITY_KEYS` keyring, and HTTPS. Startup fails when production uses the development database URL, omits either secret setting, or uses a shipped placeholder. The supplied Compose service publishes the app directly and therefore defaults `TRUST_PROXY` to `false`. Set `TRUST_PROXY=true` only when clients can reach the app exclusively through a trusted reverse proxy that replaces forwarded headers. Keep PostgreSQL and the API on a private network and expose only the HTTPS proxy.

The root `docker-compose.yml` is development tooling, not a production or demo
topology. For a single-host HTTPS demonstration, use `compose.demo.yml` only
through the guarded [demo deployment runbook](./demo-deployment.md). That stack
sets `TRUST_PROXY=true`, keeps the API and database off host ports, and makes
Caddy the only public service.

`ACCESS_CAPABILITY_KEYS` is a comma-separated, active-first list of up to eight `key-id:secret` entries, for example `v2:<current>,v1:<previous>`. Key identifiers are immutable labels of at most 32 letters, digits, underscores, or hyphens; each secret must be unique, contain at least 32 non-whitespace characters, and come from a secret manager. These values never belong in API payloads or logs. The first key issues new and idempotently replayed guest-access status capabilities. Retained prior keys verify and reissue requests created under those versions.

Keep access-capability secrets distinct from `SESSION_SECRET`. To rotate access capabilities, prepend a new identifier and secret, deploy the same ordered keyring to every replica, and retain each prior entry until no pending request or lost grant exchange can still reference it. Remove old entries only after that recovery window. Never reuse an identifier for different key material. Session-secret rotation is independent: it revokes cookies without invalidating retained access capabilities.

If an idempotent access-request replay returns `CAPABILITY_KEY_UNAVAILABLE`, restore the removed key under its original identifier before retrying; issuing a replacement token would violate mutation recovery. A same-device grant retry after session rotation is authorized only by the original status capability plus its already-bound grant UUID and rekeys only that one guest session.

`RATE_LIMIT_MAX` controls the ordinary per-IP request ceiling in each one-minute window and defaults to `300`. Guest access-status polling also applies this ceiling per access capability while `ACCESS_STATUS_IP_LIMIT_MAX` provides a broader per-IP ceiling, defaulting to `3000`, so many legitimate guests can poll behind one shared address without allowing rotating invalid tokens to bypass an address-level limit. Counters are stored in PostgreSQL and shared by every API replica. Raise either value only when a trusted reverse proxy is configured correctly and operational traffic requires it.

## Health and migrations

- Liveness/readiness: `GET /api/v1/health` verifies database connectivity.
- Build the API, then run `npm run db:migrate` before starting it. Production migration and administrator commands execute the compiled files included in the runtime image.
- The sole initial migration is recorded in `schema_migrations` and concurrent runners are serialized with a PostgreSQL advisory lock. While no valid production release marker-and-tag pair exists, schema changes are consolidated into that initial migration and disposable development and test databases are recreated. Once released, every migration blob that appeared in a valid release is immutable; run `npm run check:released-migrations` before deployment.
- Realtime invalidation records are trimmed as they are written, retaining only the latest 10,000 identity slots so sustained activity cannot grow the table without bound.

## Production releases

Production release status comes from an annotated `vMAJOR.MINOR.PATCH` tag on
the protected `main` history plus a valid matching marker in the tagged commit.
A marker alone remains pending and does not freeze migrations. Follow the
[release marker procedure](../.release/README.md), including the local
release-candidate review, final clean GitHub `@codex review`, tag creation, and
post-tag policy checks. Protect stable release tags from update and deletion in
GitHub. Never use the package version as release evidence.

## Backup and restore

Create regular encrypted PostgreSQL dumps and test restoration:

```bash
docker compose exec -T db pg_dump -U skybar -Fc skybar > skybar.backup
docker compose stop app
docker compose exec -T db psql -U skybar -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS skybar WITH (FORCE)'
docker compose exec -T db psql -U skybar -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE skybar OWNER skybar'
docker compose exec -T db pg_restore -U skybar -d skybar < skybar.backup
```

Store backups outside the application host. Back up before upgrades, retain multiple recovery points, and restrict access because guest names and financial records are personal data.

The demo deploy command also writes a validated, permission-restricted backup
bundle to `.demo-backups/<project>/` before changing an existing database. The
bundle binds its dump digest and exact database migration names to matching
current/pending source state. Guarded restore accepts an older ancestor bundle
from a clean current checkout only when all selected migration paths and
digests are still preserved. It recreates the whole `skybar` database rather
than applying an in-place `pg_restore --clean`. When prior database data exists
it first creates and validates one safety bundle; after volume loss it records
the absence of that safety evidence and can recreate only the deterministic,
exactly labelled PostgreSQL volume from an intact off-host bundle. Exact-bundle
retries retain that original classification and never back up a crash-created
empty or partial database. Never restore a dump separately or pair it with
unrelated state, and never add a compatibility migration solely for an
unreleased recovery point. This is a host-local rollback aid only: copy the
whole bundle to encrypted off-host storage if it must serve as disaster
recovery. Its companion `.demo-state/<project>/` directory contains successful
and interrupted source/migration identity and should remain with a persistent
checkout, but an intact off-host bundle remains usable after both state and
volume loss. See the
[demo deployment runbook](./demo-deployment.md#backup-state-and-restoration).

## Recovery

- Recover administrator access by piping a secret-manager value or a password captured with a non-echoing prompt into `npm run admin:create -- --email … --name … --password-stdin`; this resets that account's credentials and revokes all of its existing sessions without exposing the password in the process arguments.
- Revoke a lost host device from Account or reset the password, which revokes other sessions.
- Guest access can be revoked by archiving the guest or revoking their device sessions.
- A mistaken settlement is corrected with an admin bill void; do not edit database bill rows manually.
