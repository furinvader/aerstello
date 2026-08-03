# Operations

## Configuration

Production requires `DATABASE_URL`, an explicitly configured nondefault `SESSION_SECRET`, an explicit `ACCESS_CAPABILITY_KEYS` keyring, and HTTPS. Startup fails when production uses the development database URL, omits either secret setting, or uses a shipped placeholder. The supplied Compose service publishes the app directly and therefore defaults `TRUST_PROXY` to `false`. Set `TRUST_PROXY=true` only when clients can reach the app exclusively through a trusted reverse proxy that replaces forwarded headers. Keep PostgreSQL and the API on a private network and expose only the HTTPS proxy.

`ACCESS_CAPABILITY_KEYS` is a comma-separated, active-first list of up to eight `key-id:secret` entries, for example `v2:<current>,v1:<previous>`. Key identifiers are immutable labels of at most 32 letters, digits, underscores, or hyphens; each secret must be unique, contain at least 32 non-whitespace characters, and come from a secret manager. These values never belong in API payloads or logs. The first key issues new and idempotently replayed guest-access status capabilities. Retained prior keys verify and reissue requests created under those versions.

Use this sequence for the first rolling upgrade from a release that derived access capabilities from `SESSION_SECRET`:

1. Back up the database and run migrations while leaving `SESSION_SECRET` unchanged.
2. Set the first key, such as `v1`, to exactly the current `SESSION_SECRET` value and deploy the new release to every replica. This makes capability tokens and verifiers byte-for-byte compatible with old replicas during the overlap.
3. Drain every old replica. Keep `ACCESS_CAPABILITY_KEYS` pinned, then rotate `SESSION_SECRET` and restart the new replicas. Host and ordinary guest cookies signed under the old session secret stop authenticating, while pending access capabilities remain recoverable.
4. To rotate access capabilities later, prepend a new identifier and secret, deploy it everywhere, and retain each prior entry until no pending request or lost grant exchange can still reference it. Remove old entries only after that recovery window. Never reuse an identifier for different key material.

If an idempotent access-request replay returns `CAPABILITY_KEY_UNAVAILABLE`, restore the removed key under its original identifier before retrying; issuing a replacement token would violate mutation recovery. A same-device grant retry after session rotation is authorized only by the original status capability plus its already-bound grant UUID and rekeys only that one guest session.

`RATE_LIMIT_MAX` controls the ordinary per-IP request ceiling in each one-minute window and defaults to `300`. Guest access-status polling also applies this ceiling per access capability while `ACCESS_STATUS_IP_LIMIT_MAX` provides a broader per-IP ceiling, defaulting to `3000`, so many legitimate guests can poll behind one shared address without allowing rotating invalid tokens to bypass an address-level limit. Counters are stored in PostgreSQL and shared by every API replica. Raise either value only when a trusted reverse proxy is configured correctly and operational traffic requires it.

## Health and migrations

- Liveness/readiness: `GET /api/v1/health` verifies database connectivity.
- Build the API, then run `npm run db:migrate` before starting a newly deployed version. Production migration and administrator commands execute the compiled files included in the runtime image.
- Migrations are recorded in `schema_migrations`, applied in lexical order, and serialized across concurrent runners with a PostgreSQL advisory lock.
- When upgrading a database that contains bills from before `0007_bill_timezone.sql`, set `LEGACY_BILL_TIMEZONE` to the IANA timezone used when those bills were settled. Compose forwards this host variable into the app container; when it is not needed, the empty Compose default is treated as unset. The corrective migration refuses to proceed without an operator-supplied value for affected data, preventing the current venue timezone from silently changing historical bill dates.
- Realtime invalidation records are trimmed as they are written, retaining only the latest 10,000 identity slots so sustained activity cannot grow the table without bound.

## Backup and restore

Create regular encrypted PostgreSQL dumps and test restoration:

```bash
docker compose exec -T db pg_dump -U skybar -Fc skybar > skybar.backup
docker compose exec -T db pg_restore -U skybar -d skybar --clean --if-exists < skybar.backup
```

Store backups outside the application host. Back up before upgrades, retain multiple recovery points, and restrict access because guest names and financial records are personal data.

## Recovery

- Recover administrator access by piping a secret-manager value or a password captured with a non-echoing prompt into `npm run admin:create -- --email … --name … --password-stdin`; this resets that account's credentials and revokes all of its existing sessions without exposing the password in the process arguments.
- Revoke a lost host device from Account or reset the password, which revokes other sessions.
- Guest access can be revoked by archiving the guest or revoking their device sessions.
- A mistaken settlement is corrected with an admin bill void; do not edit database bill rows manually.
