#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
INVOCATION_DIRECTORY="$PWD"
COMPOSE_FILE="compose.demo.yml"
ENV_EXAMPLE="$REPOSITORY_ROOT/.env.demo.example"
DEFAULT_ENV_FILE="$REPOSITORY_ROOT/.env.demo"

ACTION=deploy
ENV_FILE_ARGUMENT=''
ENV_FILE=''
DB_MODE=''
CONFIRM_REWRITE=''
ADMIN_PASSWORD_FILE_ARGUMENT=''
ADMIN_PASSWORD_FILE=''
ADOPT_EXISTING_DB=false

CURRENT_MANIFEST_TEMP=''
FINAL_MANIFEST_TEMP=''
BACKUP_PARTIAL=''
INIT_ENV_TEMP=''
STATE_STAGING_DIRECTORY=''
PUBLISHED_GENERATION_DIRECTORY=''
PUBLISHED_GENERATION_TARGET=''
STATE_LINK_TEMP=''
CURRENT_STATE_LINK=''
ADMIN_PASSWORD=''

usage() {
  cat <<'EOF'
Usage: scripts/demo-deploy.sh [options]

Deploy options:
  --env-file PATH             Use PATH instead of .env.demo.
  --db-mode persist|rewrite   Preserve and migrate, or replace, the demo database.
  --confirm-rewrite NAME      Confirm a non-interactive rewrite with the project name.
  --admin-password-file PATH  Read a required initial administrator password from PATH.
  --adopt-existing-db         Adopt current migrations for an unmanaged existing database.

Other actions:
  --init-env                  Create a private environment file with generated secrets.
  --check                     Validate prerequisites and configuration without changing the stack.
  --help                      Show this help.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

cleanup() {
  ADMIN_PASSWORD=''
  if [[ -n "$CURRENT_MANIFEST_TEMP" && -f "$CURRENT_MANIFEST_TEMP" ]]; then
    rm -f -- "$CURRENT_MANIFEST_TEMP"
  fi
  if [[ -n "$FINAL_MANIFEST_TEMP" && -f "$FINAL_MANIFEST_TEMP" ]]; then
    rm -f -- "$FINAL_MANIFEST_TEMP"
  fi
  if [[ -n "$BACKUP_PARTIAL" && -f "$BACKUP_PARTIAL" ]]; then
    rm -f -- "$BACKUP_PARTIAL"
  fi
  if [[ -n "$INIT_ENV_TEMP" && -f "$INIT_ENV_TEMP" ]]; then
    rm -f -- "$INIT_ENV_TEMP"
  fi
  if [[ -n "$STATE_LINK_TEMP" && ( -e "$STATE_LINK_TEMP" || -L "$STATE_LINK_TEMP" ) ]]; then
    rm -f -- "$STATE_LINK_TEMP"
  fi
  if [[ -n "$STATE_STAGING_DIRECTORY" && -d "$STATE_STAGING_DIRECTORY" ]]; then
    rm -rf -- "$STATE_STAGING_DIRECTORY"
  fi
  if [[ -n "$PUBLISHED_GENERATION_DIRECTORY" && -d "$PUBLISHED_GENERATION_DIRECTORY" ]]; then
    local selected_generation=''
    if [[ -n "$CURRENT_STATE_LINK" && -L "$CURRENT_STATE_LINK" ]]; then
      selected_generation="$(readlink -- "$CURRENT_STATE_LINK" 2>/dev/null || true)"
    fi
    if [[ "$selected_generation" != "$PUBLISHED_GENERATION_TARGET" ]]; then
      rm -rf -- "$PUBLISHED_GENERATION_DIRECTORY"
    fi
  fi
}
trap cleanup EXIT

need_value() {
  local option="$1"
  local value="${2-}"
  [[ -n "$value" && "$value" != --* ]] || die "$option requires a value."
}

while (($# > 0)); do
  case "$1" in
    --init-env)
      [[ "$ACTION" == deploy ]] || die '--init-env cannot be combined with another action.'
      ACTION=init
      shift
      ;;
    --check)
      [[ "$ACTION" == deploy ]] || die '--check cannot be combined with another action.'
      ACTION=check
      shift
      ;;
    --env-file)
      need_value "$1" "${2-}"
      ENV_FILE_ARGUMENT="$2"
      shift 2
      ;;
    --db-mode)
      need_value "$1" "${2-}"
      DB_MODE="$2"
      shift 2
      ;;
    --confirm-rewrite)
      need_value "$1" "${2-}"
      CONFIRM_REWRITE="$2"
      shift 2
      ;;
    --admin-password-file)
      need_value "$1" "${2-}"
      ADMIN_PASSWORD_FILE_ARGUMENT="$2"
      shift 2
      ;;
    --adopt-existing-db)
      ADOPT_EXISTING_DB=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

case "$DB_MODE" in
  ''|persist|rewrite) ;;
  *) die '--db-mode must be persist or rewrite.' ;;
esac

if [[ "$ACTION" != deploy ]]; then
  [[ -z "$DB_MODE" ]] || die "--db-mode cannot be combined with --$ACTION."
  [[ -z "$CONFIRM_REWRITE" ]] || die "--confirm-rewrite cannot be combined with --$ACTION."
  [[ -z "$ADMIN_PASSWORD_FILE_ARGUMENT" ]] || die "--admin-password-file cannot be combined with --$ACTION."
  [[ "$ADOPT_EXISTING_DB" == false ]] || die "--adopt-existing-db cannot be combined with --$ACTION."
fi

resolve_user_path() {
  local raw="$1"
  local absolute
  if [[ "$raw" == /* ]]; then
    absolute="$raw"
  else
    absolute="$INVOCATION_DIRECTORY/$raw"
  fi
  local directory base
  directory="$(dirname -- "$absolute")"
  base="$(basename -- "$absolute")"
  printf '%s/%s\n' "$(realpath -m -- "$directory")" "$base"
}

command -v realpath >/dev/null 2>&1 || die 'realpath is required.'
ENV_FILE="$(resolve_user_path "${ENV_FILE_ARGUMENT:-$DEFAULT_ENV_FILE}")"
if [[ -n "$ADMIN_PASSWORD_FILE_ARGUMENT" ]]; then
  ADMIN_PASSWORD_FILE="$(resolve_user_path "$ADMIN_PASSWORD_FILE_ARGUMENT")"
fi

path_is_inside_repository() {
  [[ "$1" == "$REPOSITORY_ROOT" || "$1" == "$REPOSITORY_ROOT/"* ]]
}

validate_env_build_context_path() {
  if ! path_is_inside_repository "$ENV_FILE"; then
    return
  fi
  case "$ENV_FILE" in
    "$REPOSITORY_ROOT/.env"|"$REPOSITORY_ROOT/.env."*) return ;;
    *) die 'A repository-local --env-file must be a root .env or .env.* file so Docker excludes it from the build context.' ;;
  esac
}

initialize_environment() {
  command -v openssl >/dev/null 2>&1 || die 'openssl is required for --init-env.'
  [[ -f "$ENV_EXAMPLE" ]] || die "Missing environment template: $ENV_EXAMPLE"
  validate_env_build_context_path
  [[ ! -e "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die "Refusing to overwrite existing environment file: $ENV_FILE"
  [[ -d "$(dirname -- "$ENV_FILE")" ]] || die 'The environment file parent directory does not exist.'

  local postgres_secret session_secret capability_secret
  postgres_secret="$(openssl rand -hex 32)"
  session_secret="$(openssl rand -hex 32)"
  capability_secret="$(openssl rand -hex 32)"
  while [[ "$session_secret" == "$postgres_secret" ]]; do
    session_secret="$(openssl rand -hex 32)"
  done
  while [[ "$capability_secret" == "$postgres_secret" || "$capability_secret" == "$session_secret" ]]; do
    capability_secret="$(openssl rand -hex 32)"
  done

  INIT_ENV_TEMP="$(mktemp "$(dirname -- "$ENV_FILE")/.env.demo.tmp.XXXXXX")"
  chmod 600 -- "$INIT_ENV_TEMP"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      POSTGRES_PASSWORD=*) printf 'POSTGRES_PASSWORD=%s\n' "$postgres_secret" ;;
      SESSION_SECRET=*) printf 'SESSION_SECRET=%s\n' "$session_secret" ;;
      ACCESS_CAPABILITY_KEYS=*) printf 'ACCESS_CAPABILITY_KEYS=v1:%s\n' "$capability_secret" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$ENV_EXAMPLE" > "$INIT_ENV_TEMP"
  chmod 600 -- "$INIT_ENV_TEMP"
  if ! ln -- "$INIT_ENV_TEMP" "$ENV_FILE" 2>/dev/null; then
    die "Refusing to overwrite existing environment file: $ENV_FILE"
  fi
  rm -f -- "$INIT_ENV_TEMP"
  INIT_ENV_TEMP=''

  note "Created private demo environment file: $ENV_FILE"
  note 'Complete these human-supplied values before deploying:'
  note '  SKY_BAR_DOMAIN'
  note '  ACME_EMAIL'
  note '  ADMIN_EMAIL'
  note '  ADMIN_NAME'
}

if [[ "$ACTION" == init ]]; then
  initialize_environment
  exit 0
fi

declare -A CONFIG=()
readonly -a CONFIG_KEYS=(
  COMPOSE_PROJECT_NAME SKY_BAR_DOMAIN ACME_EMAIL ADMIN_EMAIL ADMIN_NAME
  POSTGRES_PASSWORD SESSION_SECRET ACCESS_CAPABILITY_KEYS LOG_LEVEL
  RATE_LIMIT_MAX ACCESS_STATUS_IP_LIMIT_MAX
)
declare -A ALLOWED_CONFIG_KEYS=()
for config_key in "${CONFIG_KEYS[@]}"; do
  ALLOWED_CONFIG_KEYS["$config_key"]=1
done

validate_private_file() {
  local path="$1"
  local description="$2"
  [[ -f "$path" && ! -L "$path" ]] || die "$description must be a regular, non-symlink file: $path"
  local owner mode mode_value
  owner="$(stat -c '%u' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [[ "$owner" == "$(id -u)" ]] || die "$description must be owned by the current user."
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Could not validate $description permissions."
  mode_value=$((8#$mode))
  (( (mode_value & 0077) == 0 )) || die "$description must have no group or world permissions (use mode 0600)."
  [[ -r "$path" ]] || die "$description is not readable."
}

load_environment() {
  validate_env_build_context_path
  validate_private_file "$ENV_FILE" 'The demo environment file'
  local line key value line_number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((line_number += 1))
    [[ "$line" != *$'\r'* ]] || die "The environment file contains a carriage return on line $line_number."
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      die "Malformed environment entry on line $line_number; use literal KEY=value syntax."
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${ALLOWED_CONFIG_KEYS[$key]-}" ]] || die "Unknown demo environment key on line $line_number: $key"
    [[ ! -v "CONFIG[$key]" ]] || die "Duplicate demo environment key: $key"
    if [[ "$value" == *'$'* || "$value" == *'`'* || "$value" == *'\'* || "$value" == *'"'* || "$value" == *"'"* || "$value" == *'#'* ]]; then
      die "Quotes, comments, escapes, and shell interpolation are not allowed in the demo environment file ($key)."
    fi
    [[ "$value" != ' '* && "$value" != *' ' ]] || die "Leading or trailing whitespace is not allowed in the demo environment file ($key)."
    CONFIG["$key"]="$value"
  done < "$ENV_FILE"

  for key in "${CONFIG_KEYS[@]}"; do
    [[ -v "CONFIG[$key]" ]] || die "Missing demo environment key: $key"
  done
}

validate_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

validate_configuration() {
  local project="${CONFIG[COMPOSE_PROJECT_NAME]}"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die 'COMPOSE_PROJECT_NAME must use lowercase letters, digits, underscores, or hyphens.'

  local label='[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
  local domain_pattern="^${label}(\\.${label})+$"
  [[ ${#CONFIG[SKY_BAR_DOMAIN]} -le 253 && "${CONFIG[SKY_BAR_DOMAIN]}" =~ $domain_pattern ]] || die 'SKY_BAR_DOMAIN must be a hostname without a scheme, port, path, or wildcard.'
  validate_email "${CONFIG[ACME_EMAIL]}" || die 'ACME_EMAIL is not a valid email address.'
  validate_email "${CONFIG[ADMIN_EMAIL]}" || die 'ADMIN_EMAIL is not a valid email address.'
  [[ "${CONFIG[ADMIN_NAME]}" =~ [^[:space:]] && ${#CONFIG[ADMIN_NAME]} -le 200 ]] || die 'ADMIN_NAME must contain a non-whitespace name of at most 200 characters.'

  [[ "${CONFIG[POSTGRES_PASSWORD]}" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] || die 'POSTGRES_PASSWORD must contain 32-256 URI-safe characters.'
  [[ "${CONFIG[SESSION_SECRET]}" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] || die 'SESSION_SECRET must contain 32-256 non-whitespace safe characters.'
  [[ "${CONFIG[POSTGRES_PASSWORD]}" != "${CONFIG[SESSION_SECRET]}" ]] || die 'POSTGRES_PASSWORD and SESSION_SECRET must be distinct.'

  local -a capability_entries
  local old_ifs="$IFS"
  IFS=',' read -r -a capability_entries <<< "${CONFIG[ACCESS_CAPABILITY_KEYS]}"
  IFS="$old_ifs"
  ((${#capability_entries[@]} >= 1 && ${#capability_entries[@]} <= 8)) || die 'ACCESS_CAPABILITY_KEYS must contain between one and eight keys.'
  declare -A capability_ids=()
  declare -A capability_secrets=()
  local entry identifier secret
  for entry in "${capability_entries[@]}"; do
    [[ "$entry" == *:* ]] || die 'Each ACCESS_CAPABILITY_KEYS entry must use key-id:secret syntax.'
    identifier="${entry%%:*}"
    secret="${entry#*:}"
    [[ "$identifier" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || die 'ACCESS_CAPABILITY_KEYS contains an invalid key identifier.'
    [[ "$secret" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] || die 'Each access-capability secret must contain 32-256 safe characters.'
    [[ ! -v "capability_ids[$identifier]" ]] || die 'ACCESS_CAPABILITY_KEYS key identifiers must be unique.'
    [[ ! -v "capability_secrets[$secret]" ]] || die 'ACCESS_CAPABILITY_KEYS secrets must be unique.'
    [[ "$secret" != "${CONFIG[POSTGRES_PASSWORD]}" && "$secret" != "${CONFIG[SESSION_SECRET]}" ]] || die 'Database, session, and access-capability secrets must be distinct.'
    capability_ids["$identifier"]=1
    capability_secrets["$secret"]=1
  done

  case "${CONFIG[LOG_LEVEL]}" in
    fatal|error|warn|info|debug|trace|silent) ;;
    *) die 'LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent.' ;;
  esac
  [[ "${CONFIG[RATE_LIMIT_MAX]}" =~ ^[1-9][0-9]*$ ]] || die 'RATE_LIMIT_MAX must be a positive integer.'
  [[ "${CONFIG[ACCESS_STATUS_IP_LIMIT_MAX]}" =~ ^[1-9][0-9]*$ ]] || die 'ACCESS_STATUS_IP_LIMIT_MAX must be a positive integer.'
}

load_environment
validate_configuration

if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
  validate_private_file "$ADMIN_PASSWORD_FILE" 'The administrator password file'
  path_is_inside_repository "$ADMIN_PASSWORD_FILE" && die 'The administrator password file must be outside the repository build context.'
fi

if [[ "$ACTION" == deploy && -z "$DB_MODE" && ! -t 0 ]]; then
  die 'Non-interactive deployment requires --db-mode persist or --db-mode rewrite.'
fi
if [[ "$DB_MODE" == persist && -n "$CONFIRM_REWRITE" ]]; then
  die '--confirm-rewrite is valid only with rewrite mode.'
fi
if [[ "$DB_MODE" == rewrite && "$ADOPT_EXISTING_DB" == true ]]; then
  die '--adopt-existing-db is valid only with persist mode.'
fi
if [[ "$DB_MODE" == rewrite && -n "$CONFIRM_REWRITE" && "$CONFIRM_REWRITE" != "${CONFIG[COMPOSE_PROJECT_NAME]}" ]]; then
  die '--confirm-rewrite must exactly match COMPOSE_PROJECT_NAME.'
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

for required_command in docker git curl stat id sha256sum find sort cmp date mktemp realpath flock; do
  require_command "$required_command"
done

cd -- "$REPOSITORY_ROOT"
[[ -f "$COMPOSE_FILE" ]] || die "Missing Compose file: $REPOSITORY_ROOT/$COMPOSE_FILE"
[[ -d apps/api/migrations ]] || die 'Missing apps/api/migrations directory.'

git_root="$(git rev-parse --show-toplevel)"
[[ "$(realpath -m -- "$git_root")" == "$REPOSITORY_ROOT" ]] || die 'The deployment script must run from its own Git repository checkout.'
DEPLOYED_SHA="$(git rev-parse --verify HEAD)"
[[ "$DEPLOYED_SHA" =~ ^[0-9a-f]{40,64}$ ]] || die 'Could not resolve the deployed Git commit.'
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || die 'The Git worktree must be clean; commit or remove uncommitted files before deployment.'

PROJECT_NAME="${CONFIG[COMPOSE_PROJECT_NAME]}"

compose() (
  local key
  for key in "${CONFIG_KEYS[@]}"; do
    export "$key=${CONFIG[$key]}"
  done
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
)

docker info >/dev/null
docker compose version >/dev/null
compose config --quiet >/dev/null

if [[ "$ACTION" == check ]]; then
  compose build caddy
  note 'Demo deployment configuration is valid; no deployment containers or volumes were changed.'
  exit 0
fi

DB_VOLUME="${PROJECT_NAME}-postgres-data"
STATE_DIRECTORY="$REPOSITORY_ROOT/.demo-state/$PROJECT_NAME"
GENERATIONS_DIRECTORY="$STATE_DIRECTORY/generations"
CURRENT_STATE_LINK="$STATE_DIRECTORY/current"
BACKUP_DIRECTORY="$REPOSITORY_ROOT/.demo-backups/$PROJECT_NAME"

mkdir -p -- "$STATE_DIRECTORY"
chmod 700 -- "$STATE_DIRECTORY"
exec {DEPLOY_LOCK_FD}> "$STATE_DIRECTORY/deploy.lock"
flock -n "$DEPLOY_LOCK_FD" || die "Another deployment is already running for project $PROJECT_NAME."

DATABASE_EXISTS=false
if docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
  DATABASE_EXISTS=true
fi

STATE_EXISTS=false
CURRENT_STATE_DIRECTORY=''
if [[ -e "$CURRENT_STATE_LINK" || -L "$CURRENT_STATE_LINK" ]]; then
  [[ -L "$CURRENT_STATE_LINK" ]] || die 'Deployment state current pointer is not a symbolic link.'
  current_target="$(readlink -- "$CURRENT_STATE_LINK")"
  [[ "$current_target" =~ ^generations/[A-Za-z0-9._-]+$ ]] || die 'Deployment state current pointer is invalid.'
  CURRENT_STATE_DIRECTORY="$STATE_DIRECTORY/$current_target"
  [[ -d "$CURRENT_STATE_DIRECTORY" ]] || die 'Deployment state current generation is missing.'
  STATE_EXISTS=true
fi

if [[ "$DATABASE_EXISTS" == false && "$STATE_EXISTS" == true && "$DB_MODE" != rewrite ]]; then
  die 'Deployment state exists but the PostgreSQL volume is missing; investigate or use explicitly confirmed rewrite mode.'
fi

if [[ -z "$DB_MODE" ]]; then
  if [[ "$DATABASE_EXISTS" == true ]]; then
    cat <<'EOF'
An existing Sky Bar demo database was found.

  1) Persist it and apply pending migrations
  2) Rewrite it from scratch and delete all current demo data

EOF
    read -r -p 'Choose [1]: ' database_choice
    case "${database_choice:-1}" in
      1) DB_MODE=persist ;;
      2) DB_MODE=rewrite ;;
      *) die 'Choose 1 for persist or 2 for rewrite.' ;;
    esac
  else
    DB_MODE=persist
  fi
fi

if [[ "$DB_MODE" == persist && -n "$CONFIRM_REWRITE" ]]; then
  die '--confirm-rewrite is valid only with rewrite mode.'
fi
if [[ "$DB_MODE" == rewrite && "$ADOPT_EXISTING_DB" == true ]]; then
  die '--adopt-existing-db is valid only with persist mode.'
fi
if [[ "$DB_MODE" == rewrite && "$DATABASE_EXISTS" == false && "$STATE_EXISTS" == false ]]; then
  die 'No existing database or prior deployment state was found; use persist mode for the initial deployment.'
fi
if [[ "$DB_MODE" == persist && "$ADOPT_EXISTING_DB" == true && "$DATABASE_EXISTS" == false ]]; then
  die '--adopt-existing-db requires an existing PostgreSQL volume.'
fi

verify_volume_ownership() {
  local owner
  owner="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$DB_VOLUME")"
  if [[ -n "$owner" && "$owner" != '<no value>' && "$owner" != "$PROJECT_NAME" ]]; then
    die "Refusing to use PostgreSQL volume $DB_VOLUME because its Compose project label is owned by $owner."
  fi
}

if [[ "$DATABASE_EXISTS" == true ]]; then
  verify_volume_ownership
fi

build_migration_manifest() {
  local destination="$1"
  local -a files=()
  declare -A prefixes=()
  mapfile -d '' files < <(LC_ALL=C find apps/api/migrations -maxdepth 1 -type f -name '*.sql' -print0 | LC_ALL=C sort -z)
  ((${#files[@]} > 0)) || die 'No SQL migration files were found.'
  : > "$destination"
  local path filename prefix digest
  for path in "${files[@]}"; do
    [[ "$path" =~ ^apps/api/migrations/[0-9]{4}_[a-z0-9_]+\.sql$ ]] || die "Unsupported migration filename: $path"
    filename="${path##*/}"
    prefix="${filename%%_*}"
    [[ ! -v "prefixes[$prefix]" ]] || die "Migration files contain duplicate numeric prefix $prefix."
    prefixes["$prefix"]="$path"
    digest="$(sha256sum -- "$path")"
    digest="${digest%% *}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "Could not hash migration: $path"
    printf '%s  %s\n' "$digest" "$path" >> "$destination"
  done
}

CURRENT_MANIFEST_TEMP="$(mktemp "${TMPDIR:-/tmp}/sky-bar-demo-migrations.XXXXXX")"
build_migration_manifest "$CURRENT_MANIFEST_TEMP"

validate_recorded_state() {
  [[ "$STATE_EXISTS" == true ]] || return
  local sha_path="$CURRENT_STATE_DIRECTORY/deployed-sha"
  local manifest_path="$CURRENT_STATE_DIRECTORY/migrations.sha256"
  [[ -f "$sha_path" && ! -L "$sha_path" ]] || die 'Deployment state is missing deployed-sha.'
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || die 'Deployment state is missing migrations.sha256.'
  local prior_sha
  prior_sha="$(< "$sha_path")"
  [[ "$prior_sha" =~ ^[0-9a-f]{40,64}$ ]] || die 'Deployment state contains an invalid deployed Git SHA.'

  declare -A current_hashes=()
  declare -A recorded_hashes=()
  declare -A current_prefixes=()
  declare -A recorded_prefixes=()
  local manifest_pattern='^([0-9a-f]{64})  (apps/api/migrations/[0-9]{4}_[a-z0-9_]+\.sql)$'
  local line digest path filename prefix
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $manifest_pattern ]] || die 'Current migration manifest is malformed.'
    digest="${BASH_REMATCH[1]}"
    path="${BASH_REMATCH[2]}"
    [[ ! -v "current_hashes[$path]" ]] || die "Current migration manifest contains a duplicate path: $path"
    filename="${path##*/}"
    prefix="${filename%%_*}"
    [[ ! -v "current_prefixes[$prefix]" ]] || die "Current migration manifest contains duplicate numeric prefix $prefix."
    current_hashes["$path"]="$digest"
    current_prefixes["$prefix"]="$path"
  done < "$CURRENT_MANIFEST_TEMP"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $manifest_pattern ]] || die 'Recorded migration manifest is malformed; use rewrite or restore valid deployment state.'
    digest="${BASH_REMATCH[1]}"
    path="${BASH_REMATCH[2]}"
    [[ ! -v "recorded_hashes[$path]" ]] || die "Recorded migration manifest contains a duplicate path: $path"
    filename="${path##*/}"
    prefix="${filename%%_*}"
    [[ ! -v "recorded_prefixes[$prefix]" ]] || die "Recorded migration manifest contains duplicate numeric prefix $prefix."
    recorded_hashes["$path"]="$digest"
    recorded_prefixes["$prefix"]="$path"
  done < "$manifest_path"
  ((${#recorded_hashes[@]} > 0)) || die 'Recorded migration manifest is empty.'

  for path in "${!recorded_hashes[@]}"; do
    if [[ ! -v "current_hashes[$path]" ]]; then
      die "Previously deployed migration $path is missing or renamed. Use database rewrite for disposable data or add an intentional forward migration."
    fi
    if [[ "${current_hashes[$path]}" != "${recorded_hashes[$path]}" ]]; then
      die "Previously deployed migration $path was modified. Use database rewrite for disposable data or add an intentional forward migration."
    fi
  done
}

start_database() {
  compose up -d --wait db
}

create_validated_backup() {
  mkdir -p -- "$BACKUP_DIRECTORY"
  chmod 700 -- "$BACKUP_DIRECTORY"
  local timestamp final_path
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_PARTIAL="$(mktemp "$BACKUP_DIRECTORY/sky-bar-${timestamp}.XXXXXX.partial")"
  chmod 600 -- "$BACKUP_PARTIAL"
  compose exec -T db pg_dump -U skybar -d skybar -Fc > "$BACKUP_PARTIAL"
  [[ -s "$BACKUP_PARTIAL" ]] || die 'PostgreSQL backup was empty.'
  compose exec -T db pg_restore --list < "$BACKUP_PARTIAL" >/dev/null
  final_path="${BACKUP_PARTIAL%.partial}.dump"
  mv -- "$BACKUP_PARTIAL" "$final_path"
  BACKUP_PARTIAL=''
  chmod 600 -- "$final_path"
  note "Created and validated local database backup: $final_path"
}

load_admin_password() {
  if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
    local -a password_lines=()
    mapfile -t password_lines < "$ADMIN_PASSWORD_FILE"
    ((${#password_lines[@]} == 1)) || die 'The administrator password file must contain exactly one line.'
    ADMIN_PASSWORD="${password_lines[0]}"
  else
    [[ -t 0 ]] || die 'Administrator creation requires --admin-password-file in non-interactive mode.'
    local confirmation
    read -r -s -p 'Administrator password: ' ADMIN_PASSWORD
    printf '\n'
    read -r -s -p 'Confirm administrator password: ' confirmation
    printf '\n'
    [[ "$ADMIN_PASSWORD" == "$confirmation" ]] || die 'Administrator passwords did not match.'
  fi
  ((${#ADMIN_PASSWORD} >= 12)) || die 'The administrator password must contain at least 12 characters.'
  [[ "$ADMIN_PASSWORD" != *$'\r'* ]] || die 'The administrator password file contains a carriage return.'
}

create_administrator() {
  [[ -n "$ADMIN_PASSWORD" ]] || load_admin_password
  printf '%s\n' "$ADMIN_PASSWORD" | compose run --rm --no-deps -T app \
    npm run admin:create -- \
    --email "${CONFIG[ADMIN_EMAIL]}" \
    --name "${CONFIG[ADMIN_NAME]}" \
    --password-stdin
  ADMIN_PASSWORD=''
}

active_administrator_count() {
  local count
  count="$(compose exec -T db psql -U skybar -d skybar -tAc \
    "SELECT count(*) FROM hosts WHERE role='admin' AND active=true")"
  count="${count//[[:space:]]/}"
  [[ "$count" =~ ^[0-9]+$ ]] || die 'Could not determine whether an active administrator exists.'
  printf '%s\n' "$count"
}

run_migrations() {
  compose run --rm --no-deps app npm run db:migrate
}

wait_for_app_health() {
  local container_id status attempt
  for attempt in {1..60}; do
    container_id="$(compose ps -q app)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ "$status" == healthy ]]; then
        return
      fi
      [[ "$status" != unhealthy ]] || die 'The application container reported an unhealthy status.'
    fi
    sleep 2
  done
  die 'Timed out waiting for the application health check.'
}

start_application() {
  compose up -d app caddy
  wait_for_app_health
  curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-all-errors \
    --max-time 15 "https://${CONFIG[SKY_BAR_DOMAIN]}/api/v1/health" >/dev/null
}

confirm_rewrite() {
  if [[ -n "$CONFIRM_REWRITE" ]]; then
    [[ "$CONFIRM_REWRITE" == "$PROJECT_NAME" ]] || die '--confirm-rewrite must exactly match COMPOSE_PROJECT_NAME.'
    return
  fi
  [[ -t 0 ]] || die "Non-interactive rewrite requires --confirm-rewrite $PROJECT_NAME."
  local entered
  note 'Rewrite will permanently delete all current demo data from the PostgreSQL volume.'
  read -r -p "Type $PROJECT_NAME to confirm: " entered
  [[ "$entered" == "$PROJECT_NAME" ]] || die 'Rewrite confirmation did not match the Compose project name.'
}

verify_source_unchanged() {
  local final_sha
  final_sha="$(git rev-parse --verify HEAD)"
  [[ "$final_sha" == "$DEPLOYED_SHA" ]] || die 'Git HEAD changed during deployment; state was not updated.'
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] || die 'The Git worktree changed during deployment; state was not updated.'
  FINAL_MANIFEST_TEMP="$(mktemp "${TMPDIR:-/tmp}/sky-bar-demo-migrations-final.XXXXXX")"
  build_migration_manifest "$FINAL_MANIFEST_TEMP"
  cmp -s -- "$CURRENT_MANIFEST_TEMP" "$FINAL_MANIFEST_TEMP" || die 'Migration files changed during deployment; state was not updated.'
}

publish_state() {
  verify_source_unchanged
  mkdir -p -- "$GENERATIONS_DIRECTORY"
  chmod 700 -- "$GENERATIONS_DIRECTORY"
  STATE_STAGING_DIRECTORY="$(mktemp -d "$GENERATIONS_DIRECTORY/.staging.XXXXXX")"
  printf '%s\n' "$DEPLOYED_SHA" > "$STATE_STAGING_DIRECTORY/deployed-sha"
  cp -- "$CURRENT_MANIFEST_TEMP" "$STATE_STAGING_DIRECTORY/migrations.sha256"
  chmod 600 -- "$STATE_STAGING_DIRECTORY/deployed-sha" "$STATE_STAGING_DIRECTORY/migrations.sha256"

  local generation_name generation_directory
  generation_name="$(date -u +%Y%m%dT%H%M%SZ)-${DEPLOYED_SHA:0:12}-$$"
  generation_directory="$GENERATIONS_DIRECTORY/$generation_name"
  [[ ! -e "$generation_directory" && ! -L "$generation_directory" ]] || die 'A deployment state generation name collision occurred; retry the deployment.'
  STATE_LINK_TEMP="$STATE_STAGING_DIRECTORY/.current-link"
  ln -s -- "generations/$generation_name" "$STATE_LINK_TEMP"
  PUBLISHED_GENERATION_DIRECTORY="$generation_directory"
  PUBLISHED_GENERATION_TARGET="generations/$generation_name"
  mv -T -- "$STATE_STAGING_DIRECTORY" "$generation_directory"
  STATE_STAGING_DIRECTORY=''
  STATE_LINK_TEMP="$generation_directory/.current-link"
  mv -Tf -- "$STATE_LINK_TEMP" "$CURRENT_STATE_LINK"
  STATE_LINK_TEMP=''
  PUBLISHED_GENERATION_DIRECTORY=''
  PUBLISHED_GENERATION_TARGET=''
}

deploy_persist() {
  if [[ "$DATABASE_EXISTS" == true ]]; then
    start_database
    create_validated_backup
    if [[ "$STATE_EXISTS" == true ]]; then
      validate_recorded_state
    elif [[ "$ADOPT_EXISTING_DB" != true ]]; then
      die 'An existing unmanaged database requires --adopt-existing-db or explicitly confirmed rewrite mode.'
    else
      note 'Adopting current migration files as the baseline after this deployment becomes healthy.'
    fi
    compose build app caddy
    compose stop app caddy
  else
    [[ "$STATE_EXISTS" == false ]] || die 'The PostgreSQL volume is missing; explicitly confirm rewrite instead of silently replacing it.'
    load_admin_password
    compose build app caddy
    start_database
  fi

  run_migrations
  local administrator_count
  administrator_count="$(active_administrator_count)"
  if ((administrator_count == 0)); then
    create_administrator
  else
    note 'An active administrator already exists; existing credentials and sessions were preserved.'
  fi
  start_application
  publish_state
}

deploy_rewrite() {
  compose build app caddy
  if [[ "$DATABASE_EXISTS" == true ]]; then
    start_database
    create_validated_backup
  else
    note 'The previously recorded PostgreSQL volume is missing; no pre-rewrite backup can be created.'
  fi
  load_admin_password
  confirm_rewrite
  compose down --remove-orphans
  if [[ "$DATABASE_EXISTS" == true ]]; then
    verify_volume_ownership
    docker volume rm "$DB_VOLUME"
  fi
  start_database
  run_migrations
  create_administrator
  start_application
  publish_state
}

case "$DB_MODE" in
  persist) deploy_persist ;;
  rewrite) deploy_rewrite ;;
  *) die 'Internal error: no database mode was selected.' ;;
esac

note "Sky Bar demo deployment is healthy at https://${CONFIG[SKY_BAR_DOMAIN]}"
note "Deployed Git commit: $DEPLOYED_SHA"
