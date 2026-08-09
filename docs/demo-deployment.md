# Demo deployment

This runbook deploys a repeatable Sky Bar demonstration to one Linux host.
The dedicated demo stack runs PostgreSQL on a private backend network, the app
on private backend and edge networks, and Caddy as the only host-facing service
on TCP 80, TCP 443, and UDP 443. Caddy obtains and renews the HTTPS certificate
and proxies to the app. The root `docker-compose.yml` remains development
tooling and must not be used for this topology.

This is an operator workflow for a single host, not a complete production
platform. In particular, its automatic dumps remain on the application host
unless you copy them elsewhere.

## Prepare the host

Use a persistent clone of the repository on a supported Ubuntu or Debian host.
The deployment script requires Bash plus standard commands from `coreutils`,
`diffutils`, `findutils`, and `util-linux`, as well as Git, curl, GnuPG, OpenSSL, CA
certificates, and Docker Engine with the Docker Compose plugin. Install the
common command dependencies first:

```bash
sudo apt-get update
sudo apt-get install bash ca-certificates coreutils curl diffutils findutils git gnupg openssl util-linux
```

Install Docker Engine and the Compose plugin from Docker's official repository
for the host distribution, enable the daemon, and verify both commands before
deploying:

```bash
docker version
docker compose version
```

The deploying account must be able to talk to the Docker daemon. Membership in
the `docker` group is effectively root access; grant it deliberately, only to
a trusted local account, and log out and back in before relying on the new
membership. Follow Docker's platform-specific instructions when the host uses
Debian or another non-Ubuntu distribution.

Point an `A` record (and an `AAAA` record only when IPv6 routing works) for the
demo hostname at this host. Allow inbound TCP 80 and TCP 443 through the cloud
firewall and host firewall; allow UDP 443 for HTTP/3. Outbound DNS and HTTPS
must work so Caddy can obtain a certificate. Do not continue until public DNS
resolves to the host. Port 80 is required for normal certificate issuance and
redirects even though users browse to HTTPS.

Run deployments only from a clean Git worktree at a resolvable commit. The
command locks each Compose project so two deploys cannot mutate the same stack
at once.

## Create the environment file

Generate a new file rather than copying secrets from another installation:

```bash
scripts/demo-deploy.sh --init-env --env-file .env.demo
```

Initialization refuses to overwrite a file, writes it with mode `0600`, and
generates distinct random values for the session secret, access-capability key,
and PostgreSQL password. It prints only the human-supplied fields still needing
attention, never generated secrets. Complete the domain, ACME email,
administrator email, and administrator display name in the file. Alternatively,
copy `.env.demo.example`, fill every placeholder with unique values, and run
`chmod 600 .env.demo`.

Keep administrator-password files outside the checkout. Keep alternate
environment files outside it too, unless the file is at the repository root
and is named exactly `.env` or starts with `.env.`. The script rejects every
other repository-local environment path. The Docker build context excludes
those root `.env` variants, dumps, backups, deployment state, and other local
artifacts, but secrets should not be placed in arbitrary source files.

The parser accepts a deliberately small literal `KEY=value` format. Do not add
shell syntax, interpolation, command substitutions, quoted multiline values,
or `export`: the file is validated and never sourced. Keep the PostgreSQL
password URI-safe because it is embedded in the database URL. The Compose
project name identifies the installation and also namespaces its volumes,
state, backups, and deployment lock; do not casually change it after the first
deploy.

Keep `SESSION_SECRET`, the PostgreSQL password, and every
`ACCESS_CAPABILITY_KEYS` secret distinct. Capability keys use an active-first
`key-id:secret` list such as `v2:<current>,v1:<previous>`. Rate limits must be
positive integers and the configured log level must be one supported by the
application.

Validate the host, configuration, Compose model, and pinned Caddy image before
making deployment changes:

```bash
scripts/demo-deploy.sh --env-file .env.demo --check
```

`--check` does not start, stop, create, or remove deployment containers or
volumes. It may build or update Docker image/cache data while validating the
Caddy configuration.

## Deploy and update without replacing data

For the first deployment or a normal update, preserve the PostgreSQL volume:

```bash
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist
```

In an interactive terminal, an existing database defaults to `persist`, so an
operator may use `scripts/demo-deploy.sh --env-file .env.demo` (or
`just demo-deploy -- --env-file .env.demo`). The `just` command runner is
optional and is needed only for that recipe. Agents and other non-interactive
callers must always pass an explicit `--db-mode`.

Persist mode starts and waits for PostgreSQL, backs up an existing database,
checks the recorded migration manifest, builds the images, runs the compiled
migrations, creates an administrator only when no active administrator exists,
starts the app and proxy, and checks both internal readiness and the external
`https://<domain>/api/v1/health` endpoint with strict TLS verification.

The command records the deployed Git commit and sorted migration hashes only
after the external health check succeeds. Previously recorded migrations may
not be changed, renamed, removed, duplicated, malformed, or moved outside
`apps/api/migrations`; adding a new migration is allowed.

### Adopt an existing database

If the named PostgreSQL volume already contains a database but this checkout
has no deployment state, inspect the database and backups first, then explicitly
adopt the current migration files as its baseline:

```bash
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist --adopt-existing-db
```

Adoption does not bypass migrations or health checks. The baseline remains
provisional until deployment succeeds, so a failed adoption does not publish
misleading state.

## Administrator password handling

A fresh or rewritten database requires an administrator password. In an
interactive terminal, the command prompts twice without echoing. It does not
place the password in process arguments, environment files, logs, state, or its
summary.

For automation, create a dedicated password file outside the repository. It
must contain exactly one password line of at least 12 characters, with no
carriage return. A final newline is allowed. The file must be regular rather
than a symlink, owned by the current user, and have no group or world
permissions. For example, prepare it without echoing the password:

```bash
umask 077
read -r -s -p 'Administrator password file value: ' ADMIN_PASSWORD
printf '\n'
printf '%s\n' "$ADMIN_PASSWORD" > /secure/path/sky-bar-admin-password
unset ADMIN_PASSWORD
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist \
  --admin-password-file /secure/path/sky-bar-admin-password
```

Delete or rotate the automation secret according to your secret-management
policy after bootstrap. A supplied file is always checked for ownership,
permissions, and location during preflight. If an active administrator already
exists, persist mode preserves its credentials and sessions and does not read
the password value.

## Rewrite a demo database

Rewrite is destructive to the named PostgreSQL data volume and is intended for
deliberately resetting disposable demo data. It still builds and validates the
replacement first, starts and backs up the old database, and aborts if either
the database or backup is unhealthy. Supply the exact configured Compose
project name as the confirmation:

```bash
scripts/demo-deploy.sh --env-file .env.demo --db-mode rewrite \
  --confirm-rewrite sky-bar-demo \
  --admin-password-file /secure/path/sky-bar-admin-password
```

Use the actual `COMPOSE_PROJECT_NAME` value from your environment file in place
of `sky-bar-demo`. The command removes only that project's explicitly named
PostgreSQL volume. It preserves Caddy's certificate and configuration volumes,
recreates the database, migrates it, creates the administrator, and publishes
new state only after HTTPS health succeeds. It never uses `docker compose down
-v`, a wildcard, or a global Docker prune.

If deployment state exists but the PostgreSQL volume is missing, use the same
explicit rewrite confirmation before allowing an empty replacement database to
be created. First investigate whether the host mounted the wrong Docker data
root or the project name changed.

## Backup, state, and restoration

Before changing an existing database, the deploy command creates a timestamped
PostgreSQL custom-format dump beneath `.demo-backups/<project>/`, restricts it
to mode `0600`, and validates it with `pg_restore --list` before publishing its
final filename. Backup or validation failure stops the deployment, including a
rewrite.

These dumps are host-local safety copies, not off-host disaster recovery.
Regularly copy them to encrypted, access-controlled storage on another system,
retain multiple recovery points, and test restoration. They contain guest and
financial personal data.

`.demo-state/<project>/` holds generations containing the deployed commit and
migration manifest; an atomic `current` pointer selects the last successful
generation. Keep this directory in the persistent checkout, include it in host
recovery planning, and do not edit it manually. A failed build, migration,
bootstrap, or health check leaves the prior current generation intact.

To restore, stop the app and proxy without deleting volumes, preserve another
copy of the current database, restore the selected custom dump with
`pg_restore`, and rerun persist deployment so migrations and both health checks
complete. Use the database/user/project values from the same environment file:

```bash
docker compose --env-file .env.demo -f compose.demo.yml stop caddy app
umask 077
install -d -m 700 /secure/backups
docker compose --env-file .env.demo -f compose.demo.yml exec -T db \
  pg_dump -U skybar -Fc skybar > /secure/backups/before-restore.backup
docker compose --env-file .env.demo -f compose.demo.yml exec -T db \
  pg_restore --list < /secure/backups/before-restore.backup
docker compose --env-file .env.demo -f compose.demo.yml exec -T db \
  pg_restore --list < .demo-backups/sky-bar-demo/TIMESTAMP.dump
docker compose --env-file .env.demo -f compose.demo.yml exec -T db \
  pg_restore -U skybar -d skybar --clean --if-exists < .demo-backups/sky-bar-demo/TIMESTAMP.dump
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist
```

Replace the project directory and dump filename with the selected validated
backup. Keep `/secure/backups` outside the repository checkout, protect its
safety dump as personal data, and validate the dump with `pg_restore --list`
before proceeding. Do not restore over a running application and do not delete
the Caddy volumes.

## Secret rotation

To rotate access capabilities, prepend a new unique key identifier and secret
to `ACCESS_CAPABILITY_KEYS`, retain older entries until no pending access
request or lost grant exchange can reference them, deploy in persist mode, and
then remove expired entries in a later deployment. Never reuse an identifier
for different key material. Removing a key too early can make an idempotent
access-request replay unrecoverable until that exact key is restored.

Rotating `SESSION_SECRET` is independent and signs users out by invalidating
existing cookies. Rotate the PostgreSQL password only as a coordinated database
credential change; editing only the environment file will make the existing
database unreachable. Back up before every rotation and keep all three secret
classes distinct.

## Troubleshooting

- **Preflight reports a dirty worktree:** commit or safely set aside intended
  changes. Generated environment, state, and backup paths are ignored, but the
  deployment source itself must be reproducible.
- **The environment file is rejected:** check ownership and mode `0600`, remove
  shell syntax, fill all required fields, use a URI-safe database password, and
  verify secret/keyring and positive-integer requirements.
- **Docker or Compose is unavailable:** start Docker and grant the deploying
  user access to its socket; confirm both `docker version` and `docker compose
  version` work from the same account.
- **Caddy validation or certificate issuance fails:** verify public DNS, ports
  80/443, outbound connectivity, the ACME email and domain, and that no other
  service owns those ports. An `AAAA` record with broken IPv6 is a common cause.
- **Backup fails:** do not force the deployment. Confirm the old database can
  start, disk space is available, and `.demo-backups/<project>/` is writable;
  then rerun so a validated dump is created.
- **Migration-manifest validation fails:** deploy migration files that extend
  the recorded history. Do not edit state or rewrite migration hashes to hide a
  changed migration. Use rewrite only when discarding demo data is intended.
- **External health fails after internal health passes:** inspect app and Caddy
  logs, DNS, firewall, proxy ports, and certificate issuance. State remains on
  the last healthy generation; correct the cause and rerun persist mode.
- **A deploy appears stuck:** check for another operator using the same Compose
  project. Do not remove the lock while that process is alive.

Useful read-only diagnostics include:

```bash
docker compose --env-file .env.demo -f compose.demo.yml ps
docker compose --env-file .env.demo -f compose.demo.yml logs --tail 100 app caddy db
curl --fail --show-error --silent https://your.demo.example/api/v1/health
```
