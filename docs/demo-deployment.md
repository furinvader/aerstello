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
The deployment script requires Node.js 24, Bash, plus standard commands from `coreutils`,
`diffutils`, `findutils`, and `util-linux`, as well as Git, curl, GnuPG, OpenSSL, CA
certificates, and Docker Engine with the Docker Compose plugin. Install the
common command dependencies first:

```bash
sudo apt-get update
sudo apt-get install bash ca-certificates coreutils curl diffutils findutils git gnupg openssl util-linux
```

Install a supported Node.js 24 release using the same controlled package or
runtime-management process used for the source checkout, then verify
`node --version`. Node runs the repository's release and administrator-input
preflight checks; deployment fails closed when it is unavailable.

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
at once. Fetch `origin/main` and annotated release tags before deployment. The
command checks release metadata and released-migration immutability for the
exact checkout before it changes containers, volumes, or database state.

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

Persist mode records an atomic pending source and migration descriptor, starts
and waits for PostgreSQL, creates a source-bound backup bundle for an existing
database, checks the recorded and database migration history, builds the images, runs the compiled
migrations, creates an administrator only when no active administrator exists,
starts the app and proxy, and checks both internal readiness and this host's
local Caddy listener using the configured hostname and SNI with strict TLS
verification.

The command promotes pending state to the deployed Git commit and sorted
migration hashes only after the HTTPS health check succeeds. Pending state
survives a failed first deployment or update so an exact-checkout retry can
resume safely. A different commit or migration manifest is rejected rather
than implicitly adopted. Previously recorded migrations may
not be changed, renamed, removed, duplicated, malformed, or moved outside
`apps/api/migrations`. Before the first valid production release, consolidate
schema changes into `0001_initial.sql` and explicitly rewrite disposable demo
data when its recorded hash differs. Add a forward migration only after the
affected schema migration has been frozen by a valid production release.

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
replacement first, starts and backs up the old database against the old
matching source descriptor before installing candidate pending state, and
aborts if either the database or backup is unhealthy. A durable replacement
marker binds a recreated volume to that candidate even when an interrupted
rewrite used the same migration filenames; an exact-checkout persist retry
finishes it without misclassifying the new database as old current state.
Supply the exact configured Compose
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

Before changing an existing database, the deploy command atomically publishes
a timestamped private bundle beneath `.demo-backups/<project>/`. Each bundle
contains a PostgreSQL custom-format dump, its digest, the exact database
migration names, matching current and pending deployment descriptors, and an
explicit selector identifying which descriptor covers the dumped database. A
database still at the healthy baseline selects `current`; one containing an
applied pending-only migration selects `pending`. The
dump is validated with `pg_restore --list`; incomplete bundles are removed and
backup or validation failure stops the deployment, including a rewrite.

These dumps are host-local safety copies, not off-host disaster recovery.
Regularly copy them to encrypted, access-controlled storage on another system,
retain multiple recovery points, and test restoration. They contain guest and
financial personal data.

`.demo-state/<project>/` holds generations containing the deployed commit and
migration manifest; an atomic `current` pointer selects the last successful
generation and `pending` binds an interrupted attempt to its exact candidate.
Keep this directory in the persistent checkout, include it in host recovery
planning, and do not edit it manually. A failed build, migration, bootstrap, or
health check leaves the prior current generation intact and retains pending for
an exact retry.

Never restore a standalone dump or manually pair a dump with deployment state.
Use the guarded restore action with one intact source-bound bundle. It validates
the bundle digest, project and volume ownership, exact checkout SHA and
migration manifest, and creates a second source-bound safety bundle before it
stops the application and replaces database contents:

```bash
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist \
  --restore-backup .demo-backups/sky-bar-demo/TIMESTAMP.bundle \
  --confirm-restore sky-bar-demo
scripts/demo-deploy.sh --env-file .env.demo --db-mode persist
```

Replace the project and bundle names with their configured values. Check out
the commit recorded in the bundle before restoring. The restore refuses raw,
tampered, foreign, or source-mismatched backups and restores the matching
current/pending descriptors only after database migration names agree. A
current-selected dump must contain every current migration. A pending-selected
dump may represent a partially applied replacement, but every recorded database
migration must belong to that pending manifest. A current-selected restore does
not revive an unrelated pending candidate. State
publication uses a durable restore transaction; if publication is interrupted,
the next deploy or restore completes that transaction before ordinary state
validation. If the database replacement itself is interrupted, retry with the
exact original bundle. The transaction binds that bundle identity and records
the completed pre-restore safety bundle, so the retry reruns restoration without
trying to validate or back up a possibly partial database. It never deletes the
Caddy volumes.

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
- **Migration-manifest validation fails:** do not edit state or rewrite hashes.
  Before the first valid production marker-and-tag pair, consolidate schema
  work in `0001_initial.sql` and use explicitly confirmed rewrite for disposable
  demo data; do not add a forward migration, compatibility shim, or backfill for
  an earlier demo or PR state. Only migrations frozen by a valid production
  release are extended with intentional forward migrations.
- **Local HTTPS health fails after internal health passes:** inspect app and
  Caddy logs, DNS, firewall, proxy ports, and certificate issuance. Current
  remains on the last healthy generation and pending retains the exact retry;
  correct the cause and rerun persist mode from the same checkout.
- **A deploy appears stuck:** check for another operator using the same Compose
  project. Do not remove the lock while that process is alive.

Useful read-only diagnostics include:

```bash
docker compose --env-file .env.demo -f compose.demo.yml ps
docker compose --env-file .env.demo -f compose.demo.yml logs --tail 100 app caddy db
curl --fail --show-error --silent https://your.demo.example/api/v1/health
```
