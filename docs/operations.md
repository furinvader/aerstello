# Operations

## Configuration

Production requires `DATABASE_URL`, `SESSION_SECRET`, and HTTPS. `TRUST_PROXY=true` is appropriate only behind a trusted reverse proxy. Keep PostgreSQL and the API on a private network and expose only the HTTPS proxy.

`RATE_LIMIT_MAX` controls the per-IP request ceiling in each one-minute window and defaults to `300`. Raise it only when a trusted reverse proxy is configured correctly and operational traffic requires it.

## Health and migrations

- Liveness/readiness: `GET /api/v1/health` verifies database connectivity.
- Run `npm run db:migrate` before starting a newly deployed version.
- Migrations are recorded in `schema_migrations` and applied exactly once.

## Backup and restore

Create regular encrypted PostgreSQL dumps and test restoration:

```bash
docker compose exec -T db pg_dump -U skybar -Fc skybar > skybar.backup
docker compose exec -T db pg_restore -U skybar -d skybar --clean --if-exists < skybar.backup
```

Store backups outside the application host. Back up before upgrades, retain multiple recovery points, and restrict access because guest names and financial records are personal data.

## Recovery

- Recover administrator access with `npm run admin:create -- …`; this resets only that account's credentials.
- Revoke a lost host device from Account or reset the password, which revokes other sessions.
- Guest access can be revoked by archiving the guest or revoking their device sessions.
- A mistaken settlement is corrected with an admin bill void; do not edit database bill rows manually.
