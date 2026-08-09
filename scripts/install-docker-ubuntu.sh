#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 022

readonly TRUSTED_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
readonly DOCKER_KEY_URL='https://download.docker.com/linux/ubuntu/gpg'
readonly DOCKER_REPOSITORY_URL='https://download.docker.com/linux/ubuntu'
readonly DOCKER_PRIMARY_KEY_FINGERPRINT='9DC858229FC7DD38854AE2D88D81803C0EBFCD88'
readonly STATELESS_GPG_HOME='/proc'
readonly -a DOCKER_PACKAGES=(
  docker-ce
  docker-ce-cli
  containerd.io
  docker-buildx-plugin
  docker-compose-plugin
)
readonly -a CONFLICTING_PACKAGES=(
  docker.io
  docker-compose
  docker-compose-v2
  docker-doc
  docker-buildx
  podman-docker
  containerd
  runc
)

ACTION=''
DRY_RUN=false
GRANT_DOCKER_GROUP_USER=''
TEMP_DIRECTORY=''
KEY_PUBLISH_TEMP=''
SOURCE_PUBLISH_TEMP=''
CREATED_KEY=false
CREATED_SOURCE=false
PACKAGE_TRANSACTION_STARTED=false
INSTALL_SUCCEEDED=false

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  OS_RELEASE_PATH='/etc/os-release'
  SYSTEM_ETC_DIRECTORY='/etc'
  APT_CONFIGURATION_DIRECTORY='/etc/apt'
  KEYRING_DIRECTORY='/etc/apt/keyrings'
  DOCKER_KEY_PATH='/etc/apt/keyrings/docker.asc'
  APT_SOURCES_DIRECTORY='/etc/apt/sources.list.d'
  DOCKER_SOURCE_PATH='/etc/apt/sources.list.d/docker.sources'
  APT_MAIN_SOURCE_PATH='/etc/apt/sources.list'
  DOCKER_SOCKET_PATH='/var/run/docker.sock'
  DOCKER_DATA_DIRECTORY='/var/lib/docker'
  CONTAINERD_DATA_DIRECTORY='/var/lib/containerd'
  DOCKER_CONFIG_DIRECTORY='/etc/docker'
  LOCAL_PASSWD_PATH='/etc/passwd'
  LOCAL_DOCKER_CLI_PATH='/usr/local/bin/docker'
  SNAP_DOCKER_CLI_PATH='/snap/bin/docker'
  SYSTEM_DOCKER_CLI_PATH='/usr/sbin/docker'
  PACKAGED_DOCKER_CLI_PATH='/usr/bin/docker'
  PACKAGED_COMPOSE_PLUGIN_PATH='/usr/libexec/docker/cli-plugins/docker-compose'
else
  OS_RELEASE_PATH="${OS_RELEASE_PATH:-/etc/os-release}"
  SYSTEM_ETC_DIRECTORY="${SYSTEM_ETC_DIRECTORY:-/etc}"
  APT_CONFIGURATION_DIRECTORY="${APT_CONFIGURATION_DIRECTORY:-/etc/apt}"
  KEYRING_DIRECTORY="${KEYRING_DIRECTORY:-/etc/apt/keyrings}"
  DOCKER_KEY_PATH="${DOCKER_KEY_PATH:-$KEYRING_DIRECTORY/docker.asc}"
  APT_SOURCES_DIRECTORY="${APT_SOURCES_DIRECTORY:-/etc/apt/sources.list.d}"
  DOCKER_SOURCE_PATH="${DOCKER_SOURCE_PATH:-$APT_SOURCES_DIRECTORY/docker.sources}"
  APT_MAIN_SOURCE_PATH="${APT_MAIN_SOURCE_PATH:-/etc/apt/sources.list}"
  DOCKER_SOCKET_PATH="${DOCKER_SOCKET_PATH:-/var/run/docker.sock}"
  DOCKER_DATA_DIRECTORY="${DOCKER_DATA_DIRECTORY:-/var/lib/docker}"
  CONTAINERD_DATA_DIRECTORY="${CONTAINERD_DATA_DIRECTORY:-/var/lib/containerd}"
  DOCKER_CONFIG_DIRECTORY="${DOCKER_CONFIG_DIRECTORY:-/etc/docker}"
  LOCAL_PASSWD_PATH="${LOCAL_PASSWD_PATH:-/etc/passwd}"
  LOCAL_DOCKER_CLI_PATH="${LOCAL_DOCKER_CLI_PATH:-/usr/local/bin/docker}"
  SNAP_DOCKER_CLI_PATH="${SNAP_DOCKER_CLI_PATH:-/snap/bin/docker}"
  SYSTEM_DOCKER_CLI_PATH="${SYSTEM_DOCKER_CLI_PATH:-/usr/sbin/docker}"
  PACKAGED_DOCKER_CLI_PATH="${PACKAGED_DOCKER_CLI_PATH:-/usr/bin/docker}"
  PACKAGED_COMPOSE_PLUGIN_PATH="${PACKAGED_COMPOSE_PLUGIN_PATH:-/usr/libexec/docker/cli-plugins/docker-compose}"
fi

usage() {
  cat <<'EOF'
Usage: scripts/install-docker-ubuntu.sh ACTION [options]

Actions (choose exactly one):
  --install                    Install or repair the official Docker Engine packages.
  --upgrade                    Upgrade an existing complete official installation.
  --check                      Validate the current installation without changing it.

Options:
  --dry-run                    Preview install or upgrade without network or mutation.
  --grant-docker-group USER    Add USER to the root-equivalent docker group after success.
  --help                       Show this help.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

run_uname() { command uname "$@"; }
run_id() { command id "$@"; }
run_dpkg() { command dpkg "$@"; }
run_dpkg_query() { command dpkg-query "$@"; }
run_apt_get() { command apt-get "$@"; }
run_apt_cache() { command apt-cache "$@"; }
run_curl() { command curl "$@"; }
run_gpg() { command gpg "$@"; }
run_systemctl() { command systemctl "$@"; }
run_getent() { command getent "$@"; }
run_groupadd() { command groupadd "$@"; }
run_usermod() { command usermod "$@"; }
run_install() { command install "$@"; }
run_mv() { command mv "$@"; }
run_rm() { command rm "$@"; }
run_stat() { command stat "$@"; }
run_local_docker() {
  command env -i PATH="$TRUSTED_PATH" LC_ALL=C HOME="$STATELESS_GPG_HOME" \
    "$PACKAGED_DOCKER_CLI_PATH" --config "$STATELESS_GPG_HOME" \
    --host "unix://$DOCKER_SOCKET_PATH" "$@"
}
run_local_compose() {
  command env -i PATH="$TRUSTED_PATH" LC_ALL=C HOME="$STATELESS_GPG_HOME" \
    "$PACKAGED_COMPOSE_PLUGIN_PATH" "$@"
}

cleanup() {
  local status=$?
  set +e
  if [[ -n "$TEMP_DIRECTORY" && -d "$TEMP_DIRECTORY" ]]; then
    run_rm -rf -- "$TEMP_DIRECTORY"
  fi
  if [[ -n "$KEY_PUBLISH_TEMP" ]]; then
    run_rm -f -- "$KEY_PUBLISH_TEMP"
  fi
  if [[ -n "$SOURCE_PUBLISH_TEMP" ]]; then
    run_rm -f -- "$SOURCE_PUBLISH_TEMP"
  fi
  if [[ "$INSTALL_SUCCEEDED" == false && "$PACKAGE_TRANSACTION_STARTED" == false ]]; then
    if [[ "$CREATED_SOURCE" == true ]]; then
      run_rm -f -- "$DOCKER_SOURCE_PATH"
    fi
    if [[ "$CREATED_KEY" == true ]]; then
      run_rm -f -- "$DOCKER_KEY_PATH"
    fi
  fi
  return "$status"
}

select_action() {
  local requested="$1"
  [[ -z "$ACTION" ]] || die 'Choose exactly one action.'
  ACTION="$requested"
}

need_value() {
  local option="$1"
  local value="${2-}"
  [[ -n "$value" && "$value" != --* ]] || die "$option requires a value."
}

parse_options() {
  while (($# > 0)); do
    case "$1" in
      --install)
        select_action install
        shift
        ;;
      --upgrade)
        select_action upgrade
        shift
        ;;
      --check)
        select_action check
        shift
        ;;
      --dry-run)
        [[ "$DRY_RUN" == false ]] || die '--dry-run may be supplied only once.'
        DRY_RUN=true
        shift
        ;;
      --grant-docker-group)
        need_value "$1" "${2-}"
        [[ -z "$GRANT_DOCKER_GROUP_USER" ]] || die '--grant-docker-group may be supplied only once.'
        GRANT_DOCKER_GROUP_USER="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      --*) die "Unknown option: $1" ;;
      *) die "Unexpected positional argument: $1" ;;
    esac
  done

  [[ -n "$ACTION" ]] || die 'Choose one action: --install, --upgrade, or --check.'
  if [[ "$DRY_RUN" == true && "$ACTION" == check ]]; then
    die '--dry-run is valid only with --install or --upgrade.'
  fi
  if [[ -n "$GRANT_DOCKER_GROUP_USER" && "$ACTION" == check ]]; then
    die '--grant-docker-group is valid only with --install or --upgrade.'
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

read_os_release_value() {
  local requested="$1"
  local line key value found=false
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    [[ "$key" == "$requested" ]] || continue
    [[ "$found" == false ]] || return 2
    found=true
    value="${line#*=}"
    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s\n' "$value"
  done < "$OS_RELEASE_PATH"
  [[ "$found" == true ]]
}

validate_host() {
  [[ -f "$OS_RELEASE_PATH" ]] || die "Missing OS metadata file: $OS_RELEASE_PATH"
  [[ "$(run_uname -s)" == Linux ]] || die 'This installer supports Ubuntu Linux only.'

  local os_id codename architecture read_status manager_version
  if os_id="$(read_os_release_value ID)"; then
    :
  else
    read_status=$?
    [[ "$read_status" == 1 ]] || die "Duplicate ID entry in $OS_RELEASE_PATH."
    die 'Ubuntu OS metadata is missing ID.'
  fi
  [[ "$os_id" == ubuntu ]] || die 'This installer supports Ubuntu only; derivatives and other distributions are rejected.'
  if codename="$(read_os_release_value UBUNTU_CODENAME)"; then
    :
  else
    read_status=$?
    [[ "$read_status" == 1 ]] || die "Duplicate UBUNTU_CODENAME entry in $OS_RELEASE_PATH."
    if codename="$(read_os_release_value VERSION_CODENAME)"; then
      :
    else
      read_status=$?
      [[ "$read_status" == 1 ]] || die "Duplicate VERSION_CODENAME entry in $OS_RELEASE_PATH."
      codename=''
    fi
  fi
  [[ "$codename" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die 'Ubuntu OS metadata contains a missing or unsafe release codename.'
  UBUNTU_CODENAME_VALUE="$codename"

  architecture="$(run_dpkg --print-architecture)"
  case "$architecture" in
    amd64|armhf|arm64|s390x|ppc64el) ;;
    *) die "Docker's official Ubuntu repository does not support architecture: $architecture" ;;
  esac
  UBUNTU_ARCHITECTURE="$architecture"

  manager_version="$(run_systemctl show --property=Version --value 2>/dev/null || true)"
  [[ -n "$manager_version" ]] || die 'A working systemd system manager is required.'
}

require_root() {
  [[ "$(run_id -u)" == 0 ]] || die 'Run this action as root, for example with sudo.'
}

package_is_installed() {
  local status
  status="$(run_dpkg_query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true)"
  [[ "$status" == installed ]]
}

official_packages_complete() {
  local package
  for package in "${DOCKER_PACKAGES[@]}"; do
    package_is_installed "$package" || return 1
  done
}

official_packages_present() {
  local package
  for package in "${DOCKER_PACKAGES[@]}"; do
    if package_is_installed "$package"; then
      return 0
    fi
  done
  return 1
}

reject_conflicting_packages() {
  local -a installed=()
  local package
  for package in "${CONFLICTING_PACKAGES[@]}"; do
    if package_is_installed "$package"; then
      installed+=("$package")
    fi
  done
  if ((${#installed[@]} > 0)); then
    die "Conflicting packages are installed: ${installed[*]}. Review and remove them separately before using this installer."
  fi
}

directory_has_entries() {
  local directory="$1"
  [[ -d "$directory" ]] || return 1
  local first
  first="$(command find "$directory" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [[ -n "$first" ]]
}

validate_root_controlled_file() {
  local path="$1"
  local description="$2"
  local expected_mode="$3"
  local metadata owner mode
  metadata="$(run_stat --format='%u %a' -- "$path")"
  owner="${metadata%% *}"
  mode="${metadata#* }"
  [[ "$owner" == 0 ]] || die "$description must be owned by root: $path"
  [[ "$mode" == "$expected_mode" ]] || die "$description must have mode $expected_mode: $path"
}

validate_root_controlled_directory() {
  local path="$1"
  local description="$2"
  [[ -d "$path" && ! -L "$path" ]] || die "$description must be a real directory: $path"
  local metadata owner mode mode_value
  metadata="$(run_stat --format='%u %a' -- "$path")"
  owner="${metadata%% *}"
  mode="${metadata#* }"
  [[ "$owner" == 0 ]] || die "$description must be owned by root: $path"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "Could not validate permissions for $description: $path"
  mode_value=$((8#$mode))
  (( (mode_value & 07022) == 0 && (mode_value & 00555) == 00555 )) \
    || die "$description must be readable and searchable, without special or group/world write bits: $path"
}

validate_repository_directories() {
  validate_root_controlled_directory "$SYSTEM_ETC_DIRECTORY" 'The system configuration directory'
  validate_root_controlled_directory "$APT_CONFIGURATION_DIRECTORY" 'The apt configuration directory'
  if [[ -e "$KEYRING_DIRECTORY" || -L "$KEYRING_DIRECTORY" ]]; then
    validate_root_controlled_directory "$KEYRING_DIRECTORY" 'The apt keyring directory'
  fi
  if [[ -e "$APT_SOURCES_DIRECTORY" || -L "$APT_SOURCES_DIRECTORY" ]]; then
    validate_root_controlled_directory "$APT_SOURCES_DIRECTORY" 'The apt source directory'
  fi
}

validate_packaged_executable() {
  local path="$1"
  local package="$2"
  local description="$3"
  if package_is_installed "$package"; then
    [[ -f "$path" && ! -L "$path" && -x "$path" ]] \
      || die "$description is missing, linked, or not executable: $path"
    validate_exclusive_package_owner "$path" "$package" "$description"
    validate_root_controlled_file "$path" "$description" 755
  elif [[ -e "$path" || -L "$path" ]]; then
    die "$description exists without its official package: $path"
  fi
}

validate_exclusive_package_owner() {
  local path="$1"
  local package="$2"
  local description="$3"
  local owner
  owner="$(run_dpkg_query -S "$path" 2>/dev/null || true)"
  [[ "$owner" == "$package: $path" || "$owner" == "$package:$UBUNTU_ARCHITECTURE: $path" ]] \
    || die "$description is not owned by $package or ownership is ambiguous."
}

validate_official_executables() {
  validate_packaged_executable "$PACKAGED_DOCKER_CLI_PATH" docker-ce-cli 'The packaged Docker CLI'
  validate_packaged_executable "$PACKAGED_COMPOSE_PLUGIN_PATH" docker-compose-plugin 'The packaged Docker Compose plugin'
}

systemd_unit_property() {
  local service="$1"
  local property="$2"
  local value
  value="$(run_systemctl show --property="$property" --value "$service")" \
    || die "Could not inspect systemd property $property for $service."
  printf '%s\n' "$value"
}

validate_systemd_unit() {
  local service="$1"
  local package="$2"
  local description="$3"
  local fragment drop_ins
  fragment="$(systemd_unit_property "$service" FragmentPath)"
  drop_ins="$(systemd_unit_property "$service" DropInPaths)"
  [[ -z "$drop_ins" ]] || die "$description has unmanaged systemd drop-ins: $drop_ins"

  if package_is_installed "$package"; then
    [[ -n "$fragment" && -f "$fragment" && ! -L "$fragment" ]] \
      || die "$description does not use a regular packaged systemd unit."
    validate_exclusive_package_owner "$fragment" "$package" "$description systemd unit"
    validate_root_controlled_file "$fragment" "$description systemd unit" 644
  elif [[ -n "$fragment" ]]; then
    die "$description has an unmanaged systemd unit without the official $package package: $fragment"
  fi
}

validate_official_systemd_units() {
  validate_systemd_unit docker.service docker-ce Docker
  validate_systemd_unit containerd.service containerd.io containerd
}

reject_unmanaged_installation() {
  if [[ -e "$LOCAL_DOCKER_CLI_PATH" || -L "$LOCAL_DOCKER_CLI_PATH" \
      || -e "$SNAP_DOCKER_CLI_PATH" || -L "$SNAP_DOCKER_CLI_PATH" \
      || -e "$SYSTEM_DOCKER_CLI_PATH" || -L "$SYSTEM_DOCKER_CLI_PATH" ]]; then
    die 'An unmanaged Docker CLI was found outside the official package path; remove or migrate it first.'
  fi
  validate_official_executables
  verify_installed_package_integrity
  validate_official_systemd_units

  if ! official_packages_present; then
    if [[ -S "$DOCKER_SOCKET_PATH" ]]; then
      die "An unmanaged Docker socket already exists: $DOCKER_SOCKET_PATH"
    fi
    if directory_has_entries "$DOCKER_DATA_DIRECTORY" || directory_has_entries "$CONTAINERD_DATA_DIRECTORY"; then
      die 'Existing Docker or containerd data was found without a complete official installation; investigate it before continuing.'
    fi
    if directory_has_entries "$DOCKER_CONFIG_DIRECTORY"; then
      die 'Existing Docker configuration was found without a complete official installation; investigate it before continuing.'
    fi
  fi
}

expected_source_content() {
  printf 'Types: deb\n'
  printf 'URIs: %s\n' "$DOCKER_REPOSITORY_URL"
  printf 'Suites: %s\n' "$UBUNTU_CODENAME_VALUE"
  printf 'Components: stable\n'
  printf 'Architectures: %s\n' "$UBUNTU_ARCHITECTURE"
  printf 'Signed-By: %s\n' "$DOCKER_KEY_PATH"
}

source_file_mentions_docker() {
  [[ -f "$1" ]] && command grep -Fqs "$DOCKER_REPOSITORY_URL" "$1"
}

reject_duplicate_sources() {
  local -a sources=()
  [[ -f "$APT_MAIN_SOURCE_PATH" ]] && sources+=("$APT_MAIN_SOURCE_PATH")
  if [[ -d "$APT_SOURCES_DIRECTORY" ]]; then
    local path
    shopt -s nullglob
    for path in "$APT_SOURCES_DIRECTORY"/*.list "$APT_SOURCES_DIRECTORY"/*.sources; do
      sources+=("$path")
    done
    shopt -u nullglob
  fi

  local source
  for source in "${sources[@]}"; do
    if [[ "$source" != "$DOCKER_SOURCE_PATH" ]] && source_file_mentions_docker "$source"; then
      die "A duplicate or unmanaged Docker apt source already exists: $source"
    fi
  done
}

validate_existing_repository_files() {
  validate_repository_directories
  reject_duplicate_sources
  if [[ -e "$DOCKER_SOURCE_PATH" || -L "$DOCKER_SOURCE_PATH" ]]; then
    [[ -f "$DOCKER_SOURCE_PATH" && ! -L "$DOCKER_SOURCE_PATH" ]] || die "Docker apt source must be a regular file: $DOCKER_SOURCE_PATH"
    validate_root_controlled_file "$DOCKER_SOURCE_PATH" 'The Docker apt source' 644
    local actual expected
    actual="$(< "$DOCKER_SOURCE_PATH")"
    expected="$(expected_source_content)"
    [[ "$actual" == "$expected" ]] || die "Refusing to overwrite noncanonical Docker apt source: $DOCKER_SOURCE_PATH"
  fi
  if [[ -e "$DOCKER_KEY_PATH" || -L "$DOCKER_KEY_PATH" ]]; then
    [[ -f "$DOCKER_KEY_PATH" && ! -L "$DOCKER_KEY_PATH" && -s "$DOCKER_KEY_PATH" ]] || die "Docker signing key must be a nonempty regular file: $DOCKER_KEY_PATH"
    validate_root_controlled_file "$DOCKER_KEY_PATH" 'The Docker signing key' 644
    validate_docker_key "$DOCKER_KEY_PATH"
  fi
}

canonical_repository_ready() {
  validate_existing_repository_files
  [[ -f "$DOCKER_SOURCE_PATH" && -f "$DOCKER_KEY_PATH" ]]
}

docker_primary_key_fingerprints() {
  local path="$1"
  local output status record record_type expect_primary_fingerprint=false
  local primary_count=0 old_ifs="$IFS"
  PARSED_DOCKER_PRIMARY_KEY_FINGERPRINTS=''
  if output="$(run_gpg --homedir "$STATELESS_GPG_HOME" --no-options --no-default-keyring \
      --no-keyring --trust-model always --lock-never --batch --quiet --with-colons \
      --import-options show-only --dry-run --import "$path" 2>/dev/null)"; then
    status=0
  else
    status=$?
  fi
  ((status == 0)) || return "$status"
  while IFS= read -r record; do
    local -a fields=()
    IFS=: read -r -a fields <<< "$record"
    IFS="$old_ifs"
    record_type="${fields[0]-}"
    if [[ "$record_type" == pub ]]; then
      expect_primary_fingerprint=true
    elif [[ "$record_type" == fpr && "$expect_primary_fingerprint" == true ]]; then
      if ((primary_count > 0)); then
        PARSED_DOCKER_PRIMARY_KEY_FINGERPRINTS+=$'\n'
      fi
      PARSED_DOCKER_PRIMARY_KEY_FINGERPRINTS+="${fields[9]-}"
      primary_count=$((primary_count + 1))
      expect_primary_fingerprint=false
    fi
  done <<< "$output"
  IFS="$old_ifs"
  ((primary_count > 0))
}

validate_docker_key() {
  local path="$1"
  require_command gpg
  command grep -Fqs -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$path" || die 'Docker signing key is not an armored public key.'
  command grep -Fqs -- '-----END PGP PUBLIC KEY BLOCK-----' "$path" || die 'Docker signing key is not an armored public key.'
  docker_primary_key_fingerprints "$path" || true
  [[ "$PARSED_DOCKER_PRIMARY_KEY_FINGERPRINTS" == "$DOCKER_PRIMARY_KEY_FINGERPRINT" ]] \
    || die 'Docker signing key must contain exactly the expected official release key.'
}

verify_installed_package_integrity() {
  local package verification status
  for package in "${DOCKER_PACKAGES[@]}"; do
    package_is_installed "$package" || continue
    if verification="$(run_dpkg --verify "$package" 2>&1)"; then
      status=0
    else
      status=$?
    fi
    if ((status != 0)) || [[ -n "$verification" ]]; then
      die "Installed Docker package failed dpkg integrity verification: $package"
    fi
  done
}

verify_package_candidate() {
  local package="$1"
  local policy candidate='' current_version='' line stripped old_ifs="$IFS"
  local official_origin=false foreign_origin=false
  policy="$(run_apt_cache policy "$package")"
  while IFS= read -r line; do
    stripped="${line#"${line%%[![:space:]]*}"}"
    if [[ "$stripped" == Candidate:* ]]; then
      candidate="${stripped#Candidate:}"
      candidate="${candidate# }"
      continue
    fi

    local -a fields=()
    IFS=' ' read -r -a fields <<< "$stripped"
    IFS="$old_ifs"
    if [[ "${fields[0]-}" == '***' && "${fields[2]-}" =~ ^[0-9]+$ ]]; then
      current_version="${fields[1]}"
    elif [[ ${#fields[@]} == 2 && "${fields[1]-}" =~ ^[0-9]+$ && ! "${fields[0]-}" =~ ^[0-9]+$ ]]; then
      current_version="${fields[0]}"
    elif [[ "$current_version" == "$candidate" && "${fields[0]-}" =~ ^[0-9]+$ ]]; then
      if [[ "$line" == *"$DOCKER_REPOSITORY_URL"* ]]; then
        official_origin=true
      elif [[ "$line" != *'/var/lib/dpkg/status'* ]]; then
        foreign_origin=true
      fi
    fi
  done <<< "$policy"
  IFS="$old_ifs"

  [[ -n "$candidate" && "$candidate" != '(none)' ]] || die "Docker's official repository has no $package candidate for Ubuntu $UBUNTU_CODENAME_VALUE on $UBUNTU_ARCHITECTURE."
  [[ "$official_origin" == true && "$foreign_origin" == false ]] || die "The selected $package candidate does not originate exclusively from the official Docker Ubuntu repository."
}

verify_docker_candidates() {
  local package
  for package in "${DOCKER_PACKAGES[@]}"; do
    verify_package_candidate "$package"
  done
}

verify_installed_package_origin() {
  local package="$1"
  local installed_version policy current_version='' line stripped old_ifs="$IFS"
  local official_origin=false foreign_origin=false
  installed_version="$(run_dpkg_query -W -f='${Version}' "$package")"
  [[ -n "$installed_version" && "$installed_version" != *$'\n'* ]] \
    || die "Could not determine the installed version of $package."
  policy="$(run_apt_cache policy "$package")"

  while IFS= read -r line; do
    stripped="${line#"${line%%[![:space:]]*}"}"
    local -a fields=()
    IFS=' ' read -r -a fields <<< "$stripped"
    IFS="$old_ifs"
    if [[ "${fields[0]-}" == '***' && "${fields[2]-}" =~ ^[0-9]+$ ]]; then
      current_version="${fields[1]}"
    elif [[ ${#fields[@]} == 2 && "${fields[1]-}" =~ ^[0-9]+$ && ! "${fields[0]-}" =~ ^[0-9]+$ ]]; then
      current_version="${fields[0]}"
    elif [[ "$current_version" == "$installed_version" && "${fields[0]-}" =~ ^[0-9]+$ ]]; then
      if [[ "$line" == *"$DOCKER_REPOSITORY_URL"* ]]; then
        official_origin=true
      elif [[ "$line" != *'/var/lib/dpkg/status'* ]]; then
        foreign_origin=true
      fi
    fi
  done <<< "$policy"
  IFS="$old_ifs"

  [[ "$official_origin" == true && "$foreign_origin" == false ]] \
    || die "Installed $package version $installed_version does not have exclusive cached provenance from the official Docker Ubuntu repository."
}

verify_installed_package_origins() {
  local package
  for package in "${DOCKER_PACKAGES[@]}"; do
    package_is_installed "$package" || continue
    verify_installed_package_origin "$package"
  done
}

services_healthy() {
  run_systemctl is-enabled docker.service >/dev/null 2>&1 \
    && run_systemctl is-enabled containerd.service >/dev/null 2>&1 \
    && run_systemctl is-active docker.service >/dev/null 2>&1 \
    && run_systemctl is-active containerd.service >/dev/null 2>&1 \
    && run_local_docker version >/dev/null 2>&1 \
    && run_local_compose version >/dev/null 2>&1
}

verify_installation() {
  official_packages_complete || die 'The official Docker Engine package set is incomplete.'
  verify_installed_package_integrity
  verify_installed_package_origins
  validate_official_executables
  validate_official_systemd_units
  canonical_repository_ready || die 'The canonical Docker apt repository or signing key is missing.'
  services_healthy || die 'Docker Engine, containerd, or the Docker Compose plugin is not healthy.'
}

ensure_prerequisites() {
  if package_is_installed ca-certificates && command -v curl >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1; then
    return
  fi
  note 'Installing apt HTTPS prerequisites.'
  DEBIAN_FRONTEND=noninteractive run_apt_get update
  DEBIAN_FRONTEND=noninteractive run_apt_get install -y ca-certificates curl gnupg
  require_command curl
  require_command gpg
}

ensure_repository() {
  validate_existing_repository_files
  if [[ -f "$DOCKER_SOURCE_PATH" && -f "$DOCKER_KEY_PATH" ]]; then
    return
  fi

  ensure_prerequisites
  TEMP_DIRECTORY="$(command mktemp -d /tmp/aerstello-docker-install.XXXXXX)"
  local key_temp="$TEMP_DIRECTORY/docker.asc"
  local source_temp="$TEMP_DIRECTORY/docker.sources"

  if [[ ! -f "$DOCKER_KEY_PATH" ]]; then
    run_curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --retry 3 --connect-timeout 15 --max-time 60 \
      --output "$key_temp" "$DOCKER_KEY_URL"
    [[ -s "$key_temp" ]] || die 'The downloaded Docker signing key is empty.'
    validate_docker_key "$key_temp"
    run_install -d -m 0755 -- "$KEYRING_DIRECTORY"
    validate_root_controlled_directory "$KEYRING_DIRECTORY" 'The apt keyring directory'
    KEY_PUBLISH_TEMP="$DOCKER_KEY_PATH.new.$$"
    run_install -m 0644 -- "$key_temp" "$KEY_PUBLISH_TEMP"
    CREATED_KEY=true
    run_mv -T -- "$KEY_PUBLISH_TEMP" "$DOCKER_KEY_PATH"
    KEY_PUBLISH_TEMP=''
  fi

  if [[ ! -f "$DOCKER_SOURCE_PATH" ]]; then
    expected_source_content > "$source_temp"
    run_install -d -m 0755 -- "$APT_SOURCES_DIRECTORY"
    validate_root_controlled_directory "$APT_SOURCES_DIRECTORY" 'The apt source directory'
    SOURCE_PUBLISH_TEMP="$DOCKER_SOURCE_PATH.new.$$"
    run_install -m 0644 -- "$source_temp" "$SOURCE_PUBLISH_TEMP"
    CREATED_SOURCE=true
    run_mv -T -- "$SOURCE_PUBLISH_TEMP" "$DOCKER_SOURCE_PATH"
    SOURCE_PUBLISH_TEMP=''
  fi
}

print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

print_dry_run() {
  note "Dry run for Ubuntu $UBUNTU_CODENAME_VALUE ($UBUNTU_ARCHITECTURE); no network or system changes were made."
  if [[ "$ACTION" == install ]]; then
    if official_packages_complete && canonical_repository_ready && services_healthy; then
      note 'The official installation is already healthy; package installation would be skipped.'
    else
      note 'Planned repository and installation commands:'
      print_command apt-get update
      print_command apt-get install -y ca-certificates curl gnupg
      print_command curl --fail --location --proto '=https' --output "$DOCKER_KEY_PATH" "$DOCKER_KEY_URL"
      print_command apt-get update
      print_command apt-get install -y "${DOCKER_PACKAGES[@]}"
      print_command systemctl enable --now docker.service containerd.service
    fi
  else
    official_packages_complete || die 'A complete official installation is required before --upgrade.'
    canonical_repository_ready || die 'The canonical Docker apt repository is required before --upgrade.'
    note 'Planned upgrade commands:'
    print_command apt-get update
    print_command apt-get install -y --only-upgrade "${DOCKER_PACKAGES[@]}"
    print_command systemctl enable --now docker.service containerd.service
  fi
  if [[ -n "$GRANT_DOCKER_GROUP_USER" ]]; then
    print_command usermod -aG docker "$GRANT_DOCKER_GROUP_USER"
  fi
  note 'The real run will verify official package provenance and local daemon health.'
}

ensure_services() {
  run_systemctl enable --now docker.service containerd.service
}

grant_docker_group() {
  local user="$1"
  validate_group_target "$user"
  note "Warning: membership in the docker group grants root-equivalent access to $user."
  run_getent group docker >/dev/null 2>&1 || run_groupadd --system docker
  local groups
  groups="$(run_id -nG "$user")"
  if [[ " $groups " == *' docker '* ]]; then
    note "$user is already a member of the docker group."
    return
  fi
  run_usermod -aG docker "$user"
  note "Added $user to the docker group. Log out and back in before running Docker without sudo."
}

validate_group_target() {
  local user="$1"
  [[ "$user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die 'The Docker-group account name is invalid.'
  [[ -f "$LOCAL_PASSWD_PATH" ]] || die "Local account database is missing: $LOCAL_PASSWD_PATH"
  local account_name password uid gid gecos home shell passwd_entry='' target_uid=''
  while IFS=: read -r account_name password uid gid gecos home shell; do
    if [[ "$account_name" == "$user" ]]; then
      [[ -z "$passwd_entry" ]] || die "Duplicate local account entry for Docker-group grant: $user"
      passwd_entry="$account_name:$password:$uid:$gid:$gecos:$home:$shell"
      target_uid="$uid"
    fi
  done < "$LOCAL_PASSWD_PATH"
  [[ -n "$passwd_entry" ]] || die "No local account exists for Docker-group grant: $user"
  [[ "$target_uid" =~ ^[0-9]+$ && "$target_uid" != 0 ]] || die 'Docker-group access cannot be granted to the root account.'
}

perform_install() {
  if official_packages_complete && canonical_repository_ready && services_healthy; then
    note 'The official Docker Engine installation is already healthy; no package or service changes were made.'
    if [[ -n "$GRANT_DOCKER_GROUP_USER" ]]; then
      grant_docker_group "$GRANT_DOCKER_GROUP_USER"
    fi
    INSTALL_SUCCEEDED=true
    return
  elif official_packages_complete && canonical_repository_ready; then
    note 'The complete official Docker Engine package set and repository are already installed.'
  else
    ensure_repository
    note "Refreshing apt metadata for Ubuntu $UBUNTU_CODENAME_VALUE."
    DEBIAN_FRONTEND=noninteractive run_apt_get update
    verify_docker_candidates
    if ! official_packages_complete; then
      note 'Installing the official Docker Engine packages.'
      PACKAGE_TRANSACTION_STARTED=true
      DEBIAN_FRONTEND=noninteractive run_apt_get install -y "${DOCKER_PACKAGES[@]}"
    fi
  fi

  verify_installed_package_integrity
  verify_installed_package_origins
  validate_official_executables
  validate_official_systemd_units
  ensure_services
  verify_installation
  if [[ -n "$GRANT_DOCKER_GROUP_USER" ]]; then
    grant_docker_group "$GRANT_DOCKER_GROUP_USER"
  fi
  INSTALL_SUCCEEDED=true
  note 'Docker Engine and the Docker Compose plugin are installed and healthy.'
}

perform_upgrade() {
  official_packages_complete || die 'A complete official installation is required before --upgrade; run --install first.'
  canonical_repository_ready || die 'The canonical Docker apt repository is required before --upgrade; run --install first.'
  note 'Refreshing official Docker apt metadata.'
  DEBIAN_FRONTEND=noninteractive run_apt_get update
  verify_docker_candidates
  note 'Upgrading the official Docker Engine packages.'
  PACKAGE_TRANSACTION_STARTED=true
  DEBIAN_FRONTEND=noninteractive run_apt_get install -y --only-upgrade "${DOCKER_PACKAGES[@]}"
  verify_installed_package_integrity
  verify_installed_package_origins
  validate_official_executables
  validate_official_systemd_units
  ensure_services
  verify_installation
  if [[ -n "$GRANT_DOCKER_GROUP_USER" ]]; then
    grant_docker_group "$GRANT_DOCKER_GROUP_USER"
  fi
  INSTALL_SUCCEEDED=true
  note 'Docker Engine and the Docker Compose plugin are upgraded and healthy.'
}

main() {
  PATH="$TRUSTED_PATH"
  LC_ALL=C
  export PATH LC_ALL
  parse_options "$@"
  trap cleanup EXIT

  for command_name in uname id dpkg dpkg-query apt-get apt-cache systemctl grep find install mv rm stat env getent mktemp; do
    require_command "$command_name"
  done
  require_root
  validate_host
  reject_conflicting_packages
  reject_unmanaged_installation
  validate_existing_repository_files
  verify_installed_package_origins
  if [[ -n "$GRANT_DOCKER_GROUP_USER" ]]; then
    validate_group_target "$GRANT_DOCKER_GROUP_USER"
  fi

  if [[ "$ACTION" != check ]]; then
    note 'Warning: Docker-published ports can bypass host firewall rules; review Docker firewall policy before exposing services.'
  fi

  if [[ "$DRY_RUN" == true ]]; then
    print_dry_run
    INSTALL_SUCCEEDED=true
    return
  fi

  case "$ACTION" in
    check)
      verify_installation
      INSTALL_SUCCEEDED=true
      note 'The official Docker Engine installation is healthy.'
      ;;
    install) perform_install ;;
    upgrade) perform_upgrade ;;
    *) die 'Internal error: no action selected.' ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
