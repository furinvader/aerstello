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
RESTORE_BACKUP_ARGUMENT=''
RESTORE_BACKUP=''
CONFIRM_RESTORE=''

CURRENT_MANIFEST_TEMP=''
FINAL_MANIFEST_TEMP=''
RESTORED_MIGRATIONS_TEMP=''
BACKUP_PARTIAL=''
CREATED_BACKUP_PATH=''
INIT_ENV_TEMP=''
STATE_STAGING_DIRECTORY=''
RESTORE_STATE_STAGING=''
RESTORE_PENDING_PREVIOUS=''
RESTORE_TRANSACTION_STAGING=''
REWRITE_REPLACEMENT_STAGING=''
PUBLISHED_GENERATION_DIRECTORY=''
PUBLISHED_GENERATION_TARGET=''
STATE_LINK_TEMP=''
PENDING_STATE_STAGING=''
CURRENT_STATE_LINK=''
ADMIN_PASSWORD=''
RESTORE_RECOVERED=false
REWRITE_REPLACEMENT=false
REWRITE_REPLACEMENT_SHA=''

usage() {
  cat <<'EOF'
Usage: scripts/demo-deploy.sh [options]

Deploy options:
  --env-file PATH             Use PATH instead of .env.demo.
  --db-mode persist|rewrite   Preserve and migrate, or replace, the demo database.
  --confirm-rewrite NAME      Confirm a non-interactive rewrite with the project name.
  --admin-password-file PATH  Read a required initial administrator password from PATH.
  --adopt-existing-db         Adopt current migrations for an unmanaged existing database.
  --restore-backup PATH       Restore one source-bound backup bundle.
  --confirm-restore NAME      Confirm restore with the exact project name.

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
  if [[ -n "$RESTORED_MIGRATIONS_TEMP" && -f "$RESTORED_MIGRATIONS_TEMP" ]]; then
    rm -f -- "$RESTORED_MIGRATIONS_TEMP"
  fi
  if [[ -n "$BACKUP_PARTIAL" && -d "$BACKUP_PARTIAL" ]]; then
    rm -rf -- "$BACKUP_PARTIAL"
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
  if [[ -n "$PENDING_STATE_STAGING" && -d "$PENDING_STATE_STAGING" ]]; then
    rm -rf -- "$PENDING_STATE_STAGING"
  fi
  if [[ -n "$RESTORE_PENDING_PREVIOUS" && -d "$RESTORE_PENDING_PREVIOUS" ]]; then
    if [[ -n "$PENDING_STATE_DIRECTORY" && ! -e "$PENDING_STATE_DIRECTORY" && ! -L "$PENDING_STATE_DIRECTORY" ]]; then
      mv -T -- "$RESTORE_PENDING_PREVIOUS" "$PENDING_STATE_DIRECTORY" || true
    else
      rm -rf -- "$RESTORE_PENDING_PREVIOUS"
    fi
  fi
  if [[ -n "$RESTORE_STATE_STAGING" && -d "$RESTORE_STATE_STAGING" ]]; then
    rm -rf -- "$RESTORE_STATE_STAGING"
  fi
  if [[ -n "$RESTORE_TRANSACTION_STAGING" && -d "$RESTORE_TRANSACTION_STAGING" ]]; then
    rm -rf -- "$RESTORE_TRANSACTION_STAGING"
  fi
  if [[ -n "$REWRITE_REPLACEMENT_STAGING" && -f "$REWRITE_REPLACEMENT_STAGING" ]]; then
    rm -f -- "$REWRITE_REPLACEMENT_STAGING"
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
    --restore-backup)
      need_value "$1" "${2-}"
      RESTORE_BACKUP_ARGUMENT="$2"
      shift 2
      ;;
    --confirm-restore)
      need_value "$1" "${2-}"
      CONFIRM_RESTORE="$2"
      shift 2
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
if [[ -n "$RESTORE_BACKUP_ARGUMENT" ]]; then
  RESTORE_BACKUP="$(resolve_user_path "$RESTORE_BACKUP_ARGUMENT")"
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

validate_private_directory() {
  local path="$1"
  local description="$2"
  [[ -d "$path" && ! -L "$path" ]] || die "$description must be a directory, not a symbolic link: $path"
  local owner mode mode_value
  owner="$(stat -c '%u' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [[ "$owner" == "$(id -u)" ]] || die "$description must be owned by the current user."
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Could not validate $description permissions."
  mode_value=$((8#$mode))
  (( (mode_value & 0077) == 0 )) || die "$description must have no group or world permissions (use mode 0700)."
  [[ -r "$path" && -x "$path" ]] || die "$description is not accessible."
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
if [[ -n "$RESTORE_BACKUP" ]]; then
  [[ "$ACTION" == deploy ]] || die '--restore-backup is valid only for deployment.'
  [[ "$DB_MODE" == persist ]] || die '--restore-backup requires --db-mode persist.'
  [[ "$ADOPT_EXISTING_DB" == false ]] || die '--restore-backup cannot be combined with --adopt-existing-db.'
  [[ "$CONFIRM_RESTORE" == "${CONFIG[COMPOSE_PROJECT_NAME]}" ]] || die '--confirm-restore must exactly match COMPOSE_PROJECT_NAME.'
elif [[ -n "$CONFIRM_RESTORE" ]]; then
  die '--confirm-restore requires --restore-backup.'
fi
if [[ "$DB_MODE" == rewrite && -n "$CONFIRM_REWRITE" && "$CONFIRM_REWRITE" != "${CONFIG[COMPOSE_PROJECT_NAME]}" ]]; then
  die '--confirm-rewrite must exactly match COMPOSE_PROJECT_NAME.'
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

for required_command in node docker git curl stat id sha256sum find sort cmp date mktemp realpath flock; do
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

node scripts/release-state.mjs --check --base HEAD --head HEAD --release-ref origin/main
node scripts/check-released-migrations.mjs --base HEAD --head HEAD --release-ref origin/main
node scripts/validate-demo-admin.mjs \
  --email "${CONFIG[ADMIN_EMAIL]}" --name "${CONFIG[ADMIN_NAME]}" \
  || die 'Administrator profile validation failed.'

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
PENDING_STATE_DIRECTORY="$STATE_DIRECTORY/pending"
RESTORE_TRANSACTION_DIRECTORY="$STATE_DIRECTORY/restore-transaction"
REWRITE_REPLACEMENT_MARKER="$STATE_DIRECTORY/rewrite-replacement"
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
PENDING_EXISTS=false
CURRENT_STATE_DIRECTORY=''
if [[ -e "$CURRENT_STATE_LINK" || -L "$CURRENT_STATE_LINK" ]]; then
  [[ -L "$CURRENT_STATE_LINK" ]] || die 'Deployment state current pointer is not a symbolic link.'
  current_target="$(readlink -- "$CURRENT_STATE_LINK")"
  [[ "$current_target" =~ ^generations/[A-Za-z0-9._-]+$ ]] || die 'Deployment state current pointer is invalid.'
  CURRENT_STATE_DIRECTORY="$STATE_DIRECTORY/$current_target"
  [[ -d "$CURRENT_STATE_DIRECTORY" ]] || die 'Deployment state current generation is missing.'
  STATE_EXISTS=true
fi

if [[ -e "$PENDING_STATE_DIRECTORY" || -L "$PENDING_STATE_DIRECTORY" ]]; then
  [[ -d "$PENDING_STATE_DIRECTORY" && ! -L "$PENDING_STATE_DIRECTORY" ]] || die 'Pending deployment state is invalid.'
  PENDING_EXISTS=true
fi

if [[ -e "$REWRITE_REPLACEMENT_MARKER" || -L "$REWRITE_REPLACEMENT_MARKER" ]]; then
  [[ -f "$REWRITE_REPLACEMENT_MARKER" && ! -L "$REWRITE_REPLACEMENT_MARKER" ]] ||
    die 'Rewrite replacement marker is invalid.'
  REWRITE_REPLACEMENT_SHA="$(< "$REWRITE_REPLACEMENT_MARKER")"
  [[ "$REWRITE_REPLACEMENT_SHA" =~ ^[0-9a-f]{40,64}$ ]] ||
    die 'Rewrite replacement marker contains an invalid deployed Git SHA.'
  if [[ "$PENDING_EXISTS" != true ]]; then
    [[ -d "$RESTORE_TRANSACTION_DIRECTORY" && ! -L "$RESTORE_TRANSACTION_DIRECTORY" ]] ||
      die 'Rewrite replacement marker requires pending deployment state or an active restore transaction.'
  fi
  REWRITE_REPLACEMENT=true
fi

if [[ "$DATABASE_EXISTS" == false && "$STATE_EXISTS" == true && "$DB_MODE" != rewrite && "$REWRITE_REPLACEMENT" != true ]]; then
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
if [[ "$DB_MODE" == rewrite && "$DATABASE_EXISTS" == false && "$STATE_EXISTS" == false && "$PENDING_EXISTS" == false ]]; then
  die 'No existing database or prior deployment state was found; use persist mode for the initial deployment.'
fi
if [[ "$DB_MODE" == persist && "$ADOPT_EXISTING_DB" == true && "$DATABASE_EXISTS" == false ]]; then
  die '--adopt-existing-db requires an existing PostgreSQL volume.'
fi

verify_volume_ownership() {
  local labels project_owner logical_owner
  labels="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}' "$DB_VOLUME")"
  project_owner="${labels%%|*}"
  logical_owner="${labels#*|}"
  [[ "$project_owner" == "$PROJECT_NAME" && "$logical_owner" == postgres-data ]] ||
    die "Refusing to use PostgreSQL volume $DB_VOLUME without exact Compose project and postgres-data ownership labels."
}

if [[ "$DATABASE_EXISTS" == true ]]; then
  verify_volume_ownership
fi

build_migration_manifest() {
  local destination="$1"
  local -a files=()
  declare -A prefixes=()
  mapfile -d '' files < <(LC_ALL=C find apps/api/migrations -mindepth 1 -maxdepth 1 -name '*.sql' -print0 | LC_ALL=C sort -z)
  ((${#files[@]} > 0)) || die 'No SQL migration files were found.'
  : > "$destination"
  local path filename prefix digest
  for path in "${files[@]}"; do
    [[ -f "$path" && ! -L "$path" ]] || die "Migration entry must be a regular, non-symlink file: $path"
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

validate_state_descriptor() {
  local directory="$1"
  local description="$2"
  local sha_path="$directory/deployed-sha"
  local manifest_path="$directory/migrations.sha256"
  [[ -f "$sha_path" && ! -L "$sha_path" ]] || die "$description is missing deployed-sha."
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || die "$description is missing migrations.sha256."
  local sha
  sha="$(< "$sha_path")"
  [[ "$sha" =~ ^[0-9a-f]{40,64}$ ]] || die "$description contains an invalid deployed Git SHA."
  validate_migration_manifest_file "$manifest_path" "$description"
}

validate_migration_manifest_file() {
  local manifest_path="$1"
  local description="$2"
  declare -A paths=()
  declare -A prefixes=()
  local manifest_pattern='^([0-9a-f]{64})  (apps/api/migrations/[0-9]{4}_[a-z0-9_]+\.sql)$'
  local line path filename prefix count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $manifest_pattern ]] || die "$description contains a malformed migration manifest."
    path="${BASH_REMATCH[2]}"
    [[ ! -v "paths[$path]" ]] || die "$description contains a duplicate migration path: $path"
    filename="${path##*/}"
    prefix="${filename%%_*}"
    [[ ! -v "prefixes[$prefix]" ]] || die "$description contains duplicate migration prefix $prefix."
    paths["$path"]=1
    prefixes["$prefix"]=1
    ((count += 1))
  done < "$manifest_path"
  ((count > 0)) || die "$description contains an empty migration manifest."
}

validate_pending_state() {
  [[ "$PENDING_EXISTS" == true ]] || return 0
  validate_state_descriptor "$PENDING_STATE_DIRECTORY" 'Pending deployment state'
  [[ "$(< "$PENDING_STATE_DIRECTORY/deployed-sha")" == "$DEPLOYED_SHA" ]] ||
    die 'Pending deployment belongs to a different Git commit; restore that checkout or explicitly rewrite.'
  if [[ "$REWRITE_REPLACEMENT" == true ]]; then
    [[ "$(< "$PENDING_STATE_DIRECTORY/deployed-sha")" == "$REWRITE_REPLACEMENT_SHA" ]] ||
      die 'Rewrite replacement marker differs from pending deployment state.'
  fi
  cmp -s -- "$CURRENT_MANIFEST_TEMP" "$PENDING_STATE_DIRECTORY/migrations.sha256" ||
    die 'Pending deployment migration manifest differs from this checkout; restore that checkout or explicitly rewrite.'
}

prepare_pending_state() {
  if [[ "$PENDING_EXISTS" == true ]]; then
    validate_pending_state
    return
  fi
  PENDING_STATE_STAGING="$(mktemp -d "$STATE_DIRECTORY/.pending.XXXXXX")"
  printf '%s\n' "$DEPLOYED_SHA" > "$PENDING_STATE_STAGING/deployed-sha"
  cp -- "$CURRENT_MANIFEST_TEMP" "$PENDING_STATE_STAGING/migrations.sha256"
  chmod 600 -- "$PENDING_STATE_STAGING/deployed-sha" "$PENDING_STATE_STAGING/migrations.sha256"
  mv -- "$PENDING_STATE_STAGING" "$PENDING_STATE_DIRECTORY"
  PENDING_STATE_STAGING=''
  PENDING_EXISTS=true
}

validate_recorded_state() {
  [[ "$STATE_EXISTS" == true ]] || return 0
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
      die "Previously deployed migration $path is missing or renamed. Use confirmed rewrite for disposable pre-release data or restore matching source-bound state."
    fi
    if [[ "${current_hashes[$path]}" != "${recorded_hashes[$path]}" ]]; then
      die "Previously deployed migration $path was modified. Use confirmed rewrite for disposable pre-release data or restore matching source-bound state."
    fi
  done
}

start_database() {
  compose up -d --wait db
}

read_database_migrations() {
  DATABASE_MIGRATIONS=()
  local present
  present="$(compose exec -T db psql -U skybar -d skybar -tAc \
    "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 'missing' ELSE 'present' END")"
  present="${present//[[:space:]]/}"
  case "$present" in
    missing) return ;;
    present) ;;
    *) die 'Could not determine whether schema_migrations exists.' ;;
  esac
  mapfile -t DATABASE_MIGRATIONS < <(compose exec -T db psql -U skybar -d skybar -tAc \
    'SELECT name FROM schema_migrations ORDER BY name')
}

validate_database_migrations() {
  read_database_migrations
  declare -A candidate=()
  declare -A applied=()
  local line path name
  while IFS= read -r line || [[ -n "$line" ]]; do
    path="${line#*  }"
    candidate["${path##*/}"]=1
  done < "$CURRENT_MANIFEST_TEMP"
  for name in "${DATABASE_MIGRATIONS[@]}"; do
    [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ && -v "candidate[$name]" ]] ||
      die "Database contains migration $name which is absent from this checkout; refusing an ambiguous rollback."
    applied["$name"]=1
  done
  if [[ "$STATE_EXISTS" == true && "$REWRITE_REPLACEMENT" != true ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      path="${line#*  }"
      name="${path##*/}"
      [[ -v "applied[$name]" ]] ||
        die "Database is older than recorded deployment state because migration $name is missing."
    done < "$CURRENT_STATE_DIRECTORY/migrations.sha256"
  fi
}

select_database_state_descriptor() {
  declare -A current_names=()
  declare -A pending_names=()
  declare -A applied_names=()
  local line path name
  if [[ "$STATE_EXISTS" == true ]]; then
    validate_state_descriptor "$CURRENT_STATE_DIRECTORY" 'Current deployment state'
    while IFS= read -r line || [[ -n "$line" ]]; do
      path="${line#*  }"
      current_names["${path##*/}"]=1
    done < "$CURRENT_STATE_DIRECTORY/migrations.sha256"
  fi
  if [[ "$PENDING_EXISTS" == true ]]; then
    validate_state_descriptor "$PENDING_STATE_DIRECTORY" 'Pending deployment state'
    while IFS= read -r line || [[ -n "$line" ]]; do
      path="${line#*  }"
      pending_names["${path##*/}"]=1
    done < "$PENDING_STATE_DIRECTORY/migrations.sha256"
  fi
  [[ "$STATE_EXISTS" == true || "$PENDING_EXISTS" == true ]] ||
    die 'Database has no source-bound current or pending deployment descriptor.'

  if [[ "$REWRITE_REPLACEMENT" == true ]]; then
    [[ "$PENDING_EXISTS" == true ]] || die 'Rewrite replacement requires pending deployment state.'
    [[ "$(< "$PENDING_STATE_DIRECTORY/deployed-sha")" == "$REWRITE_REPLACEMENT_SHA" ]] ||
      die 'Rewrite replacement marker differs from pending deployment state.'
  fi

  local pending_required="$REWRITE_REPLACEMENT"
  for name in "${DATABASE_MIGRATIONS[@]}"; do
    [[ "$name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] || die "Database migration name is malformed: $name"
    applied_names["$name"]=1
    if [[ "$REWRITE_REPLACEMENT" == true ]]; then
      [[ -v "pending_names[$name]" ]] ||
        die "Replacement database contains migration $name outside pending deployment state."
    elif [[ ! -v "current_names[$name]" ]]; then
      pending_required=true
      [[ -v "pending_names[$name]" ]] ||
        die "Database contains unexplained migration $name outside current and pending deployment state."
    fi
  done
  if [[ "$STATE_EXISTS" == true && "$REWRITE_REPLACEMENT" != true ]]; then
    for name in "${!current_names[@]}"; do
      [[ -v "applied_names[$name]" ]] ||
        die "Database is older than recorded current state because migration $name is missing."
    done
  else
    pending_required=true
  fi

  if [[ "$pending_required" == true ]]; then
    [[ "$PENDING_EXISTS" == true ]] || die 'Database requires pending deployment state, but none exists.'
    for name in "${DATABASE_MIGRATIONS[@]}"; do
      [[ -v "pending_names[$name]" ]] ||
        die "Database migration $name is not covered by pending deployment state."
    done
    DATABASE_STATE_KIND=pending
    DATABASE_STATE_DIRECTORY="$PENDING_STATE_DIRECTORY"
  else
    DATABASE_STATE_KIND=current
    DATABASE_STATE_DIRECTORY="$CURRENT_STATE_DIRECTORY"
  fi
}

validate_database_for_source_bound_backup() {
  read_database_migrations
  select_database_state_descriptor
}

validate_rewritten_database_empty() {
  read_database_migrations
  ((${#DATABASE_MIGRATIONS[@]} == 0)) ||
    die 'Replacement PostgreSQL volume unexpectedly contains recorded migrations.'
}

create_validated_backup() {
  select_database_state_descriptor
  mkdir -p -- "$BACKUP_DIRECTORY"
  chmod 700 -- "$BACKUP_DIRECTORY"
  local timestamp final_path dump_path
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_PARTIAL="$(mktemp -d "$BACKUP_DIRECTORY/sky-bar-${timestamp}.XXXXXX.partial")"
  chmod 700 -- "$BACKUP_PARTIAL"
  dump_path="$BACKUP_PARTIAL/database.dump"
  compose exec -T db pg_dump -U skybar -d skybar -Fc > "$dump_path"
  [[ -s "$dump_path" ]] || die 'PostgreSQL backup was empty.'
  compose exec -T db pg_restore --list < "$dump_path" >/dev/null
  (cd -- "$BACKUP_PARTIAL" && sha256sum database.dump > dump.sha256)
  : > "$BACKUP_PARTIAL/database-migrations.txt"
  if ((${#DATABASE_MIGRATIONS[@]} > 0)); then
    printf '%s\n' "${DATABASE_MIGRATIONS[@]}" > "$BACKUP_PARTIAL/database-migrations.txt"
  fi
  mkdir -- "$BACKUP_PARTIAL/state"
  if [[ "$STATE_EXISTS" == true ]]; then
    mkdir -- "$BACKUP_PARTIAL/state/current"
    cp -- "$CURRENT_STATE_DIRECTORY/deployed-sha" "$CURRENT_STATE_DIRECTORY/migrations.sha256" \
      "$BACKUP_PARTIAL/state/current/"
  fi
  if [[ "$PENDING_EXISTS" == true ]]; then
    mkdir -- "$BACKUP_PARTIAL/state/pending"
    cp -- "$PENDING_STATE_DIRECTORY/deployed-sha" "$PENDING_STATE_DIRECTORY/migrations.sha256" \
      "$BACKUP_PARTIAL/state/pending/"
  fi
  printf 'schemaVersion=1\nproject=%s\ndatabaseState=%s\n' \
    "$PROJECT_NAME" "$DATABASE_STATE_KIND" > "$BACKUP_PARTIAL/metadata"
  chmod 600 -- "$dump_path" "$BACKUP_PARTIAL/dump.sha256" \
    "$BACKUP_PARTIAL/database-migrations.txt" "$BACKUP_PARTIAL/metadata"
  final_path="${BACKUP_PARTIAL%.partial}.bundle"
  mv -- "$BACKUP_PARTIAL" "$final_path"
  BACKUP_PARTIAL=''
  CREATED_BACKUP_PATH="$final_path"
  note "Created and validated source-bound database backup: $final_path"
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
    --max-time 15 --resolve "${CONFIG[SKY_BAR_DOMAIN]}:443:127.0.0.1" \
    "https://${CONFIG[SKY_BAR_DOMAIN]}/api/v1/health" >/dev/null
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
  if [[ "$REWRITE_REPLACEMENT" == true ]]; then
    rm -f -- "$REWRITE_REPLACEMENT_MARKER"
    REWRITE_REPLACEMENT=false
    REWRITE_REPLACEMENT_SHA=''
  fi
  if [[ "$PENDING_EXISTS" == true ]]; then
    rm -rf -- "$PENDING_STATE_DIRECTORY"
    PENDING_EXISTS=false
  fi
}

validate_restore_transaction_context() {
  validate_private_directory "$RESTORE_TRANSACTION_DIRECTORY" 'The restore transaction'
  local file
  for file in phase generation-name database-state-kind bundle-path bundle-digest \
      database-migrations.txt safety-backup-path; do
    validate_private_file "$RESTORE_TRANSACTION_DIRECTORY/$file" "The restore transaction $file record"
  done

  local database_state_kind
  database_state_kind="$(< "$RESTORE_TRANSACTION_DIRECTORY/database-state-kind")"
  case "$database_state_kind" in
    current|pending) ;;
    *) die 'Restore transaction database-state selector is invalid.' ;;
  esac
  local selected_state="$RESTORE_TRANSACTION_DIRECTORY/$database_state_kind"
  validate_private_directory "$selected_state" "The restore transaction selected $database_state_kind state"
  validate_state_descriptor "$selected_state" "Restore transaction selected $database_state_kind state"
  if [[ "$database_state_kind" == current ]]; then
    [[ ! -e "$RESTORE_TRANSACTION_DIRECTORY/pending" && ! -L "$RESTORE_TRANSACTION_DIRECTORY/pending" ]] ||
      die 'Current-selected restore transaction contains unexpected pending state.'
  fi
  [[ "$(< "$selected_state/deployed-sha")" == "$DEPLOYED_SHA" ]] ||
    die 'Interrupted restore state belongs to a different Git checkout.'
  cmp -s -- "$selected_state/migrations.sha256" "$CURRENT_MANIFEST_TEMP" ||
    die 'Interrupted restore state differs from this checkout migration manifest.'

  local recorded_bundle recorded_digest recorded_safety
  recorded_bundle="$(< "$RESTORE_TRANSACTION_DIRECTORY/bundle-path")"
  recorded_digest="$(< "$RESTORE_TRANSACTION_DIRECTORY/bundle-digest")"
  recorded_safety="$(< "$RESTORE_TRANSACTION_DIRECTORY/safety-backup-path")"
  [[ -n "$recorded_bundle" && "$recorded_bundle" != *$'\n'* ]] ||
    die 'Restore transaction bundle path is invalid.'
  [[ "$recorded_digest" =~ ^[0-9a-f]{64}$ ]] ||
    die 'Restore transaction bundle digest is invalid.'
  [[ -n "$recorded_safety" && "$recorded_safety" != *$'\n'* ]] ||
    die 'Restore transaction safety backup path is invalid.'
  if [[ -n "$RESTORE_BACKUP" && "$RESTORE_BACKUP" != "$recorded_bundle" ]]; then
    die 'Interrupted restore must be retried with the exact original source-bound bundle path.'
  fi
}

complete_restore_state_transaction() {
  [[ -d "$RESTORE_TRANSACTION_DIRECTORY" && ! -L "$RESTORE_TRANSACTION_DIRECTORY" ]] || return 0
  validate_restore_transaction_context
  [[ "$(< "$RESTORE_TRANSACTION_DIRECTORY/phase")" == database-restored ]] ||
    die 'An interrupted database restore must be retried with its original source-bound bundle.'

  mkdir -p -- "$GENERATIONS_DIRECTORY"
  chmod 700 -- "$GENERATIONS_DIRECTORY"
  local restored_current="$RESTORE_TRANSACTION_DIRECTORY/current"
  local restored_pending="$RESTORE_TRANSACTION_DIRECTORY/pending"
  if [[ -d "$restored_current" && ! -L "$restored_current" ]]; then
    validate_state_descriptor "$restored_current" 'Restore transaction current state'
    local generation_name generation_directory generation_staging
    generation_name="$(< "$RESTORE_TRANSACTION_DIRECTORY/generation-name")"
    [[ "$generation_name" =~ ^restore-[A-Za-z0-9._-]+$ ]] || die 'Restore transaction generation name is invalid.'
    generation_directory="$GENERATIONS_DIRECTORY/$generation_name"
    if [[ ! -d "$generation_directory" ]]; then
      generation_staging="$(mktemp -d "$GENERATIONS_DIRECTORY/.restore-generation.XXXXXX")"
      cp -- "$restored_current/deployed-sha" "$restored_current/migrations.sha256" "$generation_staging/"
      chmod 600 -- "$generation_staging/deployed-sha" "$generation_staging/migrations.sha256"
      mv -T -- "$generation_staging" "$generation_directory"
    else
      cmp -s -- "$restored_current/deployed-sha" "$generation_directory/deployed-sha" &&
        cmp -s -- "$restored_current/migrations.sha256" "$generation_directory/migrations.sha256" ||
        die 'Restore transaction generation collides with different state.'
    fi
    STATE_LINK_TEMP="$STATE_DIRECTORY/.restore-current.$$"
    ln -s -- "generations/$generation_name" "$STATE_LINK_TEMP"
    mv -Tf -- "$STATE_LINK_TEMP" "$CURRENT_STATE_LINK"
    STATE_LINK_TEMP=''
    CURRENT_STATE_DIRECTORY="$generation_directory"
    STATE_EXISTS=true
  else
    rm -f -- "$CURRENT_STATE_LINK"
    CURRENT_STATE_DIRECTORY=''
    STATE_EXISTS=false
  fi

  if [[ "${SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION-}" == after-current ]]; then
    die 'Injected restore publication interruption after current state selection.'
  fi

  local database_state_kind
  database_state_kind="$(< "$RESTORE_TRANSACTION_DIRECTORY/database-state-kind")"
  if [[ "$database_state_kind" == pending ]]; then
    REWRITE_REPLACEMENT_STAGING="$(mktemp "$STATE_DIRECTORY/.rewrite-replacement.XXXXXX")"
    printf '%s\n' "$(< "$restored_pending/deployed-sha")" > "$REWRITE_REPLACEMENT_STAGING"
    chmod 600 -- "$REWRITE_REPLACEMENT_STAGING"
    mv -T -- "$REWRITE_REPLACEMENT_STAGING" "$REWRITE_REPLACEMENT_MARKER"
    REWRITE_REPLACEMENT_STAGING=''
    REWRITE_REPLACEMENT=true
    REWRITE_REPLACEMENT_SHA="$(< "$restored_pending/deployed-sha")"
  else
    rm -f -- "$REWRITE_REPLACEMENT_MARKER"
    REWRITE_REPLACEMENT=false
    REWRITE_REPLACEMENT_SHA=''
  fi

  if [[ -e "$PENDING_STATE_DIRECTORY" || -L "$PENDING_STATE_DIRECTORY" ]]; then
    RESTORE_PENDING_PREVIOUS="$RESTORE_TRANSACTION_DIRECTORY/previous-pending"
    if [[ ! -e "$RESTORE_PENDING_PREVIOUS" && ! -L "$RESTORE_PENDING_PREVIOUS" ]]; then
      mv -T -- "$PENDING_STATE_DIRECTORY" "$RESTORE_PENDING_PREVIOUS"
    else
      rm -rf -- "$PENDING_STATE_DIRECTORY"
    fi
  fi
  if [[ "${SKY_BAR_TEST_FAIL_RESTORE_PUBLICATION-}" == after-pending-removal ]]; then
    RESTORE_PENDING_PREVIOUS=''
    die 'Injected restore publication interruption after pending state removal.'
  fi
  if [[ -d "$restored_pending" && ! -L "$restored_pending" ]]; then
    validate_state_descriptor "$restored_pending" 'Restore transaction pending state'
    PENDING_STATE_STAGING="$(mktemp -d "$STATE_DIRECTORY/.restore-pending.XXXXXX")"
    cp -- "$restored_pending/deployed-sha" "$restored_pending/migrations.sha256" "$PENDING_STATE_STAGING/"
    chmod 600 -- "$PENDING_STATE_STAGING/deployed-sha" "$PENDING_STATE_STAGING/migrations.sha256"
    mv -T -- "$PENDING_STATE_STAGING" "$PENDING_STATE_DIRECTORY"
    PENDING_STATE_STAGING=''
    PENDING_EXISTS=true
  else
    PENDING_EXISTS=false
  fi
  RESTORE_PENDING_PREVIOUS=''
  local retired_transaction="$STATE_DIRECTORY/.restore-transaction-completed.$$.$RANDOM"
  [[ ! -e "$retired_transaction" && ! -L "$retired_transaction" ]] ||
    die 'Could not retire completed restore transaction safely.'
  mv -T -- "$RESTORE_TRANSACTION_DIRECTORY" "$retired_transaction"
  rm -rf -- "$retired_transaction"
}

recover_completed_restore_transaction() {
  [[ -e "$RESTORE_TRANSACTION_DIRECTORY" || -L "$RESTORE_TRANSACTION_DIRECTORY" ]] || return 0
  [[ -d "$RESTORE_TRANSACTION_DIRECTORY" && ! -L "$RESTORE_TRANSACTION_DIRECTORY" ]] ||
    die 'Restore transaction state is invalid.'
  validate_private_file "$RESTORE_TRANSACTION_DIRECTORY/phase" 'The restore transaction phase record'
  case "$(< "$RESTORE_TRANSACTION_DIRECTORY/phase")" in
    database-restored)
      complete_restore_state_transaction
      note 'Recovered interrupted restore state publication.'
      RESTORE_RECOVERED=true
      ;;
    restoring)
      [[ -n "$RESTORE_BACKUP" ]] ||
        die 'An interrupted database restore must be retried with its exact original source-bound bundle.'
      validate_restore_transaction_context
      ;;
    *)
      die 'Restore transaction phase is invalid; use the original source-bound bundle and investigate.'
      ;;
  esac
}

deploy_persist() {
  recover_completed_restore_transaction
  if [[ "$DATABASE_EXISTS" == true && "$STATE_EXISTS" == false && "$PENDING_EXISTS" == false && "$ADOPT_EXISTING_DB" != true ]]; then
    die 'An existing unmanaged database requires --adopt-existing-db or explicitly confirmed rewrite mode.'
  fi
  if [[ "$REWRITE_REPLACEMENT" == true ]]; then
    validate_pending_state
  elif [[ "$STATE_EXISTS" == true ]]; then
    validate_recorded_state
  fi
  prepare_pending_state
  if [[ "$DATABASE_EXISTS" == true ]]; then
    start_database
    validate_database_migrations
    create_validated_backup
    if [[ "$STATE_EXISTS" == false && "$ADOPT_EXISTING_DB" == true ]]; then
      note 'Adopting current migration files as the baseline after this deployment becomes healthy.'
    fi
    compose build app caddy
    compose stop app caddy
  else
    [[ "$STATE_EXISTS" == false || "$REWRITE_REPLACEMENT" == true ]] ||
      die 'The PostgreSQL volume is missing; explicitly confirm rewrite instead of silently replacing it.'
    load_admin_password
    compose build app caddy
    start_database
    validate_database_migrations
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
  recover_completed_restore_transaction
  confirm_rewrite
  compose build app caddy
  if [[ "$DATABASE_EXISTS" == true ]]; then
    start_database
    validate_database_for_source_bound_backup
    create_validated_backup
  else
    note 'The previously recorded PostgreSQL volume is missing; no pre-rewrite backup can be created.'
  fi
  if [[ "$PENDING_EXISTS" == true ]]; then
    rm -rf -- "$PENDING_STATE_DIRECTORY"
    PENDING_EXISTS=false
  fi
  prepare_pending_state
  load_admin_password
  compose down --remove-orphans
  if [[ "$DATABASE_EXISTS" == true ]]; then
    verify_volume_ownership
    docker volume rm "$DB_VOLUME"
  fi
  REWRITE_REPLACEMENT_STAGING="$(mktemp "$STATE_DIRECTORY/.rewrite-replacement.XXXXXX")"
  printf '%s\n' "$DEPLOYED_SHA" > "$REWRITE_REPLACEMENT_STAGING"
  chmod 600 -- "$REWRITE_REPLACEMENT_STAGING"
  mv -T -- "$REWRITE_REPLACEMENT_STAGING" "$REWRITE_REPLACEMENT_MARKER"
  REWRITE_REPLACEMENT_STAGING=''
  REWRITE_REPLACEMENT=true
  REWRITE_REPLACEMENT_SHA="$DEPLOYED_SHA"
  start_database
  validate_rewritten_database_empty
  run_migrations
  create_administrator
  start_application
  publish_state
}

restore_backup_bundle() {
  recover_completed_restore_transaction
  if [[ "$RESTORE_RECOVERED" == true ]]; then
    return
  fi
  [[ "$DATABASE_EXISTS" == true ]] || die 'Guarded restore requires the existing PostgreSQL volume.'
  verify_volume_ownership
  validate_private_directory "$RESTORE_BACKUP" 'The restore backup bundle'

  local metadata_path="$RESTORE_BACKUP/metadata"
  local dump_path="$RESTORE_BACKUP/database.dump"
  local digest_path="$RESTORE_BACKUP/dump.sha256"
  local migrations_path="$RESTORE_BACKUP/database-migrations.txt"
  local bundle_state="$RESTORE_BACKUP/state"
  validate_private_file "$metadata_path" 'The restore bundle metadata'
  validate_private_file "$dump_path" 'The restore bundle database dump'
  validate_private_file "$digest_path" 'The restore bundle dump digest'
  validate_private_file "$migrations_path" 'The restore bundle database migration list'
  validate_private_directory "$bundle_state" 'The restore bundle state directory'

  local -a metadata_lines=()
  mapfile -t metadata_lines < "$metadata_path"
  ((${#metadata_lines[@]} == 3)) || die 'The restore bundle metadata is malformed.'
  [[ "${metadata_lines[0]}" == 'schemaVersion=1' ]] || die 'The restore bundle schema version is unsupported.'
  [[ "${metadata_lines[1]}" == "project=$PROJECT_NAME" ]] || die 'The restore bundle belongs to another Compose project.'
  local database_state_kind="${metadata_lines[2]#databaseState=}"
  [[ "${metadata_lines[2]}" == "databaseState=$database_state_kind" ]] ||
    die 'The restore bundle database-state selector is malformed.'
  case "$database_state_kind" in
    current|pending) ;;
    *) die 'The restore bundle database-state selector is unsupported.' ;;
  esac

  local digest_line
  digest_line="$(< "$digest_path")"
  [[ "$digest_line" =~ ^[0-9a-f]{64}'  database.dump'$ ]] || die 'The restore bundle dump digest record is malformed.'
  (cd -- "$RESTORE_BACKUP" && sha256sum -c --status dump.sha256) ||
    die 'The restore bundle database dump failed its digest check and may be tampered.'

  local -a bundle_database_migrations=()
  mapfile -t bundle_database_migrations < "$migrations_path"
  local migration_name
  for migration_name in "${bundle_database_migrations[@]}"; do
    [[ "$migration_name" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]] ||
      die 'The restore bundle database migration list is malformed.'
  done
  if ! LC_ALL=C sort -u -- "$migrations_path" | cmp -s -- "$migrations_path" -; then
    die 'The restore bundle database migration list must be sorted and unique.'
  fi

  local bundle_current=''
  local bundle_pending=''
  if [[ -e "$bundle_state/current" || -L "$bundle_state/current" ]]; then
    bundle_current="$bundle_state/current"
    validate_private_directory "$bundle_current" 'The restore bundle current state'
    validate_private_file "$bundle_current/deployed-sha" 'The restore bundle current deployed SHA'
    validate_private_file "$bundle_current/migrations.sha256" 'The restore bundle current migration manifest'
    validate_state_descriptor "$bundle_current" 'Restore bundle current state'
  fi
  if [[ -e "$bundle_state/pending" || -L "$bundle_state/pending" ]]; then
    bundle_pending="$bundle_state/pending"
    validate_private_directory "$bundle_pending" 'The restore bundle pending state'
    validate_private_file "$bundle_pending/deployed-sha" 'The restore bundle pending deployed SHA'
    validate_private_file "$bundle_pending/migrations.sha256" 'The restore bundle pending migration manifest'
    validate_state_descriptor "$bundle_pending" 'Restore bundle pending state'
  fi
  [[ -n "$bundle_current" || -n "$bundle_pending" ]] ||
    die 'The restore bundle contains no source deployment state.'

  local selected_state=''
  case "$database_state_kind" in
    current) selected_state="$bundle_current" ;;
    pending) selected_state="$bundle_pending" ;;
  esac
  [[ -n "$selected_state" ]] ||
    die "The restore bundle is missing its selected $database_state_kind deployment state."
  [[ "$(< "$selected_state/deployed-sha")" == "$DEPLOYED_SHA" ]] ||
    die 'The restore bundle requires a different Git checkout.'
  cmp -s -- "$selected_state/migrations.sha256" "$CURRENT_MANIFEST_TEMP" ||
    die 'The restore bundle migration manifest differs from this checkout.'

  declare -A candidate_migrations=()
  declare -A dumped_migrations=()
  local manifest_line manifest_path
  while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
    manifest_path="${manifest_line#*  }"
    candidate_migrations["${manifest_path##*/}"]=1
  done < "$selected_state/migrations.sha256"
  for migration_name in "${bundle_database_migrations[@]}"; do
    [[ -v "candidate_migrations[$migration_name]" ]] ||
      die "The restore bundle database contains migration $migration_name which is absent from its source checkout."
    dumped_migrations["$migration_name"]=1
  done
  if [[ "$database_state_kind" == current ]]; then
    while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
      manifest_path="${manifest_line#*  }"
      migration_name="${manifest_path##*/}"
      [[ -v "dumped_migrations[$migration_name]" ]] ||
        die "The restore bundle database is older than its current deployment state because migration $migration_name is missing."
    done < "$bundle_current/migrations.sha256"
  fi

  local dump_digest="${digest_line%%  *}"
  local resume_restoring=false
  if [[ -e "$RESTORE_TRANSACTION_DIRECTORY" || -L "$RESTORE_TRANSACTION_DIRECTORY" ]]; then
    [[ -d "$RESTORE_TRANSACTION_DIRECTORY" && ! -L "$RESTORE_TRANSACTION_DIRECTORY" ]] ||
      die 'Restore transaction state is invalid.'
    [[ "$(< "$RESTORE_TRANSACTION_DIRECTORY/phase")" == restoring ]] ||
      die 'Restore transaction is not ready for a source-bound retry.'
    [[ "$(< "$RESTORE_TRANSACTION_DIRECTORY/database-state-kind")" == "$database_state_kind" ]] ||
      die 'Restore transaction target selector differs from the original bundle.'
    [[ "$(< "$RESTORE_TRANSACTION_DIRECTORY/bundle-digest")" == "$dump_digest" ]] ||
      die 'Restore transaction dump identity differs from the original bundle.'
    cmp -s -- "$RESTORE_TRANSACTION_DIRECTORY/database-migrations.txt" "$migrations_path" ||
      die 'Restore transaction migration identity differs from the original bundle.'
    if [[ -n "$bundle_current" ]]; then
      [[ -d "$RESTORE_TRANSACTION_DIRECTORY/current" && ! -L "$RESTORE_TRANSACTION_DIRECTORY/current" ]] ||
        die 'Restore transaction is missing its original current state.'
      cmp -s -- "$RESTORE_TRANSACTION_DIRECTORY/current/deployed-sha" "$bundle_current/deployed-sha" &&
        cmp -s -- "$RESTORE_TRANSACTION_DIRECTORY/current/migrations.sha256" "$bundle_current/migrations.sha256" ||
        die 'Restore transaction current state differs from the original bundle.'
    elif [[ -e "$RESTORE_TRANSACTION_DIRECTORY/current" || -L "$RESTORE_TRANSACTION_DIRECTORY/current" ]]; then
      die 'Restore transaction contains unexpected current state.'
    fi
    if [[ "$database_state_kind" == pending ]]; then
      [[ -d "$RESTORE_TRANSACTION_DIRECTORY/pending" && ! -L "$RESTORE_TRANSACTION_DIRECTORY/pending" ]] ||
        die 'Restore transaction is missing its original pending state.'
      cmp -s -- "$RESTORE_TRANSACTION_DIRECTORY/pending/deployed-sha" "$bundle_pending/deployed-sha" &&
        cmp -s -- "$RESTORE_TRANSACTION_DIRECTORY/pending/migrations.sha256" "$bundle_pending/migrations.sha256" ||
        die 'Restore transaction pending state differs from the original bundle.'
    elif [[ -e "$RESTORE_TRANSACTION_DIRECTORY/pending" || -L "$RESTORE_TRANSACTION_DIRECTORY/pending" ]]; then
      die 'Restore transaction contains unexpected pending state.'
    fi
    local recorded_safety_backup
    recorded_safety_backup="$(< "$RESTORE_TRANSACTION_DIRECTORY/safety-backup-path")"
    validate_private_directory "$recorded_safety_backup" 'The completed pre-restore safety backup'
    resume_restoring=true
  else
    RESTORE_STATE_STAGING="$(mktemp -d "$STATE_DIRECTORY/.restore.XXXXXX")"
    chmod 700 -- "$RESTORE_STATE_STAGING"
    if [[ -n "$bundle_current" ]]; then
      mkdir -- "$RESTORE_STATE_STAGING/current"
      cp -- "$bundle_current/deployed-sha" "$bundle_current/migrations.sha256" \
        "$RESTORE_STATE_STAGING/current/"
      chmod 600 -- "$RESTORE_STATE_STAGING/current/deployed-sha" \
        "$RESTORE_STATE_STAGING/current/migrations.sha256"
    fi
    if [[ "$database_state_kind" == pending ]]; then
      mkdir -- "$RESTORE_STATE_STAGING/pending"
      cp -- "$bundle_pending/deployed-sha" "$bundle_pending/migrations.sha256" \
        "$RESTORE_STATE_STAGING/pending/"
      chmod 600 -- "$RESTORE_STATE_STAGING/pending/deployed-sha" \
        "$RESTORE_STATE_STAGING/pending/migrations.sha256"
    fi
    printf 'restore-%s-%s\n' "${DEPLOYED_SHA:0:12}" "$(date -u +%Y%m%dT%H%M%SZ)-$$" \
      > "$RESTORE_STATE_STAGING/generation-name"
  fi

  start_database
  compose exec -T db pg_restore --list < "$dump_path" >/dev/null ||
    die 'The restore bundle is not a readable PostgreSQL custom-format dump.'
  if [[ "$resume_restoring" == false ]]; then
    validate_database_for_source_bound_backup
    CREATED_BACKUP_PATH=''
    create_validated_backup
    [[ -n "$CREATED_BACKUP_PATH" ]] || die 'Pre-restore safety backup identity was not recorded.'
  fi
  compose stop app caddy

  if [[ "$resume_restoring" == false ]]; then
    printf '%s\n' "$database_state_kind" > "$RESTORE_STATE_STAGING/database-state-kind"
    printf '%s\n' "$RESTORE_BACKUP" > "$RESTORE_STATE_STAGING/bundle-path"
    printf '%s\n' "$dump_digest" > "$RESTORE_STATE_STAGING/bundle-digest"
    cp -- "$migrations_path" "$RESTORE_STATE_STAGING/database-migrations.txt"
    printf '%s\n' "$CREATED_BACKUP_PATH" > "$RESTORE_STATE_STAGING/safety-backup-path"
    printf 'restoring\n' > "$RESTORE_STATE_STAGING/phase"
    chmod 600 -- "$RESTORE_STATE_STAGING/generation-name" \
      "$RESTORE_STATE_STAGING/database-state-kind" "$RESTORE_STATE_STAGING/bundle-path" \
      "$RESTORE_STATE_STAGING/bundle-digest" "$RESTORE_STATE_STAGING/database-migrations.txt" \
      "$RESTORE_STATE_STAGING/safety-backup-path" "$RESTORE_STATE_STAGING/phase"
    mv -T -- "$RESTORE_STATE_STAGING" "$RESTORE_TRANSACTION_DIRECTORY"
    RESTORE_STATE_STAGING=''
  fi

  compose exec -T db pg_restore -U skybar -d skybar --clean --if-exists < "$dump_path"

  read_database_migrations
  RESTORED_MIGRATIONS_TEMP="$(mktemp "${TMPDIR:-/tmp}/sky-bar-restored-migrations.XXXXXX")"
  : > "$RESTORED_MIGRATIONS_TEMP"
  if ((${#DATABASE_MIGRATIONS[@]} > 0)); then
    printf '%s\n' "${DATABASE_MIGRATIONS[@]}" > "$RESTORED_MIGRATIONS_TEMP"
  fi
  cmp -s -- "$RESTORED_MIGRATIONS_TEMP" "$RESTORE_TRANSACTION_DIRECTORY/database-migrations.txt" ||
    die 'The restored database migration names differ from the source-bound backup; the application remains stopped.'

  printf 'database-restored\n' > "$RESTORE_TRANSACTION_DIRECTORY/phase.next"
  chmod 600 -- "$RESTORE_TRANSACTION_DIRECTORY/phase.next"
  mv -T -- "$RESTORE_TRANSACTION_DIRECTORY/phase.next" "$RESTORE_TRANSACTION_DIRECTORY/phase"

  complete_restore_state_transaction

  note 'The source-bound database backup and matching deployment state were restored.'
  note 'The application and Caddy remain stopped; rerun persist mode from this exact checkout.'
}

if [[ -n "$RESTORE_BACKUP" ]]; then
  restore_backup_bundle
  exit 0
fi

case "$DB_MODE" in
  persist) deploy_persist ;;
  rewrite) deploy_rewrite ;;
  *) die 'Internal error: no database mode was selected.' ;;
esac

note "Sky Bar demo deployment is healthy at https://${CONFIG[SKY_BAR_DOMAIN]}"
note "Deployed Git commit: $DEPLOYED_SHA"
