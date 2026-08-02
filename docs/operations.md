# Operations

## Configuration

Production requires `DATABASE_URL`, an explicitly configured nondefault `SESSION_SECRET`, and HTTPS. Startup fails when production uses either shipped placeholder secret. The supplied Compose service publishes the app directly and therefore defaults `TRUST_PROXY` to `false`. Set `TRUST_PROXY=true` only when clients can reach the app exclusively through a trusted reverse proxy that replaces forwarded headers. Keep PostgreSQL and the API on a private network and expose only the HTTPS proxy.

`RATE_LIMIT_MAX` controls the ordinary per-IP request ceiling in each one-minute window and defaults to `300`. Guest access-status polling also applies this ceiling per access capability while `ACCESS_STATUS_IP_LIMIT_MAX` provides a broader per-IP ceiling, defaulting to `3000`, so many legitimate guests can poll behind one shared address without allowing rotating invalid tokens to bypass an address-level limit. Raise either value only when a trusted reverse proxy is configured correctly and operational traffic requires it.

## Health and migrations

- Liveness/readiness: `GET /api/v1/health` verifies database connectivity.
- Build the API, then run `npm run db:migrate` before starting a newly deployed version. Production migration and administrator commands execute the compiled files included in the runtime image.
- Migrations are recorded in `schema_migrations`, applied in lexical order, and serialized across concurrent runners with a PostgreSQL advisory lock.
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
